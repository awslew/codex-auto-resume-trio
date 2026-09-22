/**
 * 常驻续跑守护器（原 taskboard server 内置 V2 模块，剥离后独立成宿主）
 *
 * 契约来源：`docs/AUTO_RESUME_V2_DESIGN.md` / `docs/AUTO_RESUME_V2_OPERATIONS.md`。
 * 本模块承载「无人值守续跑」的全部调度语义，宿主只负责进程与状态页：
 *
 * - 进程内唯一 scheduler：启动立即 detect，随后 fixed-rate 180 秒；不可重入、
 *   overlap skip（复用 core 已验收的 createFixedRateScheduler）。
 * - 跨进程唯一 owner：start() 前必须先取得 stateDir 下的全局 owner lease
 *   （复用 core thread-lease 原语；ownerToken 每实例 randomUUID 唯一）；拿不到
 *   owner 时不启动 scheduler，execute 保持 blocked（双实例互斥）。stop()
 *   释放 owner lease；实例崩溃由 lease 的 TTL+PID 双条件自动失效。
 * - 默认不执行发送：AUTO_RESUME_V2_EXECUTE 未显式开启（或非 "1"/"true"）时，
 *   sender 一律为空实现，任何轮次 sender 调用数恒为 0。
 * - SHADOW（AUTO_RESUME_V2_SHADOW=1）：只记录 monitor 的决策/迁移，不发送。
 * - execute 能力门禁（checkExecutionCapability）：
 *     1. 生产适配器可用（quota/sender/confirmer/sessionReader 生产缺省恒有）；
 *     2. 无 legacy daemon owner（daemon.pid 不存在或对应进程不存活）；
 *     3. 无活动 legacy auto-resume jobs 冲突（jobs 中不存在 created/waiting_rate_limit/
 *        running/resuming 状态的 job）。
 *   门禁失败时 execute 拒绝发送并给出原因；绝不取消/改写旧 jobs。
 *   5h 窗口识别不在此门禁：由 quotaReader 的结构化识别（windowDurationMins===300 或
 *   明确 5h id/name）决定，UNKNOWN 在 monitor decision 与发送前 guard 处 fail-closed
 *   0 发送（无任何环境变量手工开关）。
 *   jobs/daemon 状态**不可读**时 fail-closed（LEGACY_STATE_UNREADABLE）：视为冲突，
 *   绝不当“无冲突”放行——这是双调度器双写的最坏情况，宁可阻塞不可并发。
 * - 门禁为动态能力：每个自动 tick 与 POST /detect 之前都重新刷新 capability
 *   （运行中新增 legacy job / legacy daemon 启动 → 当轮立即 sender=0）。
 *
 * 注入边界：stateDir、quotaReader、sessionReader、sender、confirmer、clock、timer
 * 全部可注入；测试一律用 mkdtemp 临时目录，绝不读本机 LOCALAPPDATA/~/.codex。
 * 未注入时生产缺省构造（桌面 SessionObservation 观测 / app-server 配额 / 发送），
 * 任何模式都不写旧 jobs。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import {
  createMonitor,
  createFixedRateScheduler,
  createWatchStore,
  createAttemptOutbox,
  takeThreadLease,
  safeLockName,
  defaultPidAlive,
  daemonPidPath,
  loadJobs,
  clearWatchArtifacts,
  createAppServerQuotaReader,
  createAppServerSender,
  createAppServerConfirmer,
  createAppServerSessionReader,
  nullSender,
  nullConfirmer,
} from "../../../dist/index.js";

const AUTO_RESUME_V2_EXECUTE_ENV = "AUTO_RESUME_V2_EXECUTE";
const AUTO_RESUME_V2_SHADOW_ENV = "AUTO_RESUME_V2_SHADOW";

/** owner lease 的固定 threadId 命名空间：与 thread 级 lease 同目录、不同 key。 */
const OWNER_LEASE_THREAD_ID = "resume-host-scheduler-owner";

/** 默认执行开关：关闭（设计 §11 Wave 5 的 Go/No-Go 门禁语义）。 */
export function autoResumeV2ExecuteEnabled(env = process.env) {
  const raw = env[AUTO_RESUME_V2_EXECUTE_ENV] ?? "";
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function autoResumeV2ShadowEnabled(env = process.env) {
  const raw = env[AUTO_RESUME_V2_SHADOW_ENV] ?? "";
  const value = String(raw).trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * HTTP 层错误：带 status/code，供宿主状态页服务器转换成响应。
 * 语义与 core 的领域错误区分开（这里只描述传输层问题）。
 */
export class ResumeHostApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ResumeHostApiError";
    this.status = status;
    this.code = code;
  }
}

const NPM_GLOBAL_REL = path.join("node_modules", "@openai", "codex", "bin", "codex.js");
const DESKTOP_REL = path.join("OpenAI", "Codex", "bin");
const CANDIDATE_SUBDIRS = ["resource", "resources", "app", "bin"];

/**
 * 当前用户家目录；优先取 env 显式值（USERPROFILE/HOME），无则回退 os.homedir()。
 * 用 env 派生而不是 os.homedir()：os.homedir() 读真实系统用户，隔离测试注入
 * 假 APPDATA/LOCALAPPDATA 时会把真实机器上的全局模块/桌面安装混进候选。
 */
export function homeDirOf(env = process.env) {
  if (process.platform === "win32") {
    if (typeof env.USERPROFILE === "string" && env.USERPROFILE.trim() !== "") return env.USERPROFILE;
    if (typeof env.HOME === "string" && env.HOME.trim() !== "") return env.HOME;
  } else if (typeof env.HOME === "string" && env.HOME.trim() !== "") {
    return env.HOME;
  }
  return os.homedir();
}

/**
 * 生产 Codex app-server 可执行入口的确定性候选解析。
 *
 * 复现事实：旧全局 npm 模块 @openai/codex 卸载后，npm 前缀下的 codex.cmd
 * 包装脚本会残留（其指向的 codex.js 已不存在）。core 的 resolveCodexBin()
 * 只做 existsSync 存在性检查，未探测“可运行”，于是选中指向不存在文件的入口，
 * quota reader 周期性 MODULE_NOT_FOUND，真实 5h 额度永远 UNKNOWN。
 *
 * 候选顺序（显式注入优先；随后只选当前实际存在且可运行的入口）：
 *   1. 显式注入：options.codexBin（字符串）或 options.codexBin 对象。
 *   2. 环境变量：CODEX_BIN 为文件 → node 运行；为目录 → 目录内可执行文件。
 *   3. npm 全局：@openai/codex/bin/codex.js 存在且其代码可解析（语法检查通过）
 *      ——“存在但已损坏/指向已卸载模块”的旧全局路径不会被选中。
 *   4. Codex 桌面 app：%LOCALAPPDATA%/OpenAI/Codex/bin/<build>/codex.exe
 *      （多 build 时取时间上最新）。
 *   5. PATH 上的 codex 可执行文件（Windows 上排除 .cmd/.ps1 包装脚本）。
 *
 * 一个候选都不可用 → 返回 null；调用方 fail-closed 为 UNKNOWN，绝不伪造额度。
 */
export function resolveAppServerEntry(
  options = {},
  env = process.env,
  probeCode = isProbeable,
) {
  if (options.codexBin !== undefined && options.codexBin !== null) {
    return normalizeEntry(options.codexBin, env, probeCode);
  }
  const fromEnv = env.CODEX_BIN;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    const entry = normalizeEntry(fromEnv, env, probeCode);
    if (entry !== null) return entry;
  }
  const npmJs = findNpmGlobalCodexJs(env);
  if (npmJs !== undefined && probeCode(npmJs)) {
    return { command: process.execPath, prefix: [npmJs], resolved: npmJs, source: "npm-global" };
  }
  const desktopExe = findDesktopCodexExe(env);
  if (desktopExe !== undefined) {
    return { command: desktopExe, prefix: [], resolved: desktopExe, source: "codex-desktop" };
  }
  const onPath = findCodexOnPath(env);
  if (onPath !== undefined) {
    return { command: onPath, prefix: [], resolved: onPath, source: "path" };
  }
  return null;
}

/** 同步语法探测：node --check 真实解析候选入口（支持 shebang/ESM），退出码 0 才可运行。 */
export function isProbeable(filePath) {
  if (!existsSync(filePath)) return false;
  const r = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8", timeout: 10_000 });
  return r.status === 0;
}

const JS_LIKE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

function normalizeEntry(value, env, probeCode) {
  if (typeof value === "string" && value.trim() !== "") {
    const p = value.trim();
    if (!existsSync(p)) return null;
    const ext = path.extname(p).toLowerCase();
    if (process.platform === "win32" && [".cmd", ".bat", ".ps1"].includes(ext)) {
      // 包装脚本本身不可 spawn（非 node 入口），但可交给 node 运行其正文。
      return { command: process.execPath, prefix: [p], resolved: p, source: "explicit" };
    }
    if (path.extname(p) === "" && statSafe(p)?.isDirectory()) {
      const exe = findExecutableInDir(p);
      if (exe !== undefined) {
        return { command: exe, prefix: [], resolved: exe, source: "explicit" };
      }
      return null;
    }
    if (JS_LIKE_EXTENSIONS.has(ext) && !probeCode(p)) {
      // 显式注入且扩展名是 JS：语法探测失败 → 拒绝（避免把损坏的 JS 当入口）。
      return null;
    }
    // 显式注入的二进制/其他扩展名：信任调用方（node.exe、编译产物等探测必失败，
    // 探测只会误伤）；不探测直接接受。
    return { command: p, prefix: [], resolved: p, source: "explicit" };
  }
  if (value && typeof value === "object" && typeof value.command === "string" && value.command !== "") {
    const prefix = Array.isArray(value.prefix) ? value.prefix : [];
    const resolved = typeof value.resolved === "string" ? value.resolved : value.command;
    if (JS_LIKE_EXTENSIONS.has(path.extname(resolved).toLowerCase()) && !probeCode(resolved)) {
      return null;
    }
    return { command: value.command, prefix, resolved, source: "explicit-object" };
  }
  return null;
}

function npmGlobalCandidates(env) {
  const roots = [];
  // npm_config_prefix 已是 npm 前缀本体（…/npm）；APPDATA 需要补 "npm" 段：
  // 真实布局是 %APPDATA%\npm\node_modules\@openai\codex\bin\codex.js。
  const npmRoot =
    env.npm_config_prefix ?? (env.APPDATA ? path.join(env.APPDATA, "npm") : undefined);
  if (npmRoot) {
    roots.push(path.join(npmRoot, NPM_GLOBAL_REL));
  }
  const home = homeDirOf(env);
  roots.push(
    path.join(home, "AppData", "Roaming", "npm", NPM_GLOBAL_REL),
    path.join(home, ".local", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
    "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
  );
  // 仅当 env 未显式注入 npm_config_prefix/APPDATA 时才查询 `npm root -g`
  // （该查询经真实 PATH 的 shell 解析，会泄漏本机全局路径——测试注入隔离
  // 环境时必须避免混入真实机器候选）。
  if (env.npm_config_prefix === undefined && env.APPDATA === undefined) {
    try {
      const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32", env });
      if (r.status === 0 && r.stdout.trim()) {
        roots.push(path.join(r.stdout.trim(), "@openai", "codex", "bin", "codex.js"));
      }
    } catch {
      // 忽略：npm 不可用只是少一个候选来源，不阻塞解析。
    }
  }
  return roots;
}

function findNpmGlobalCodexJs(env) {
  for (const candidate of npmGlobalCandidates(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findDesktopCodexExe(env) {
  const root = env.LOCALAPPDATA ?? path.join(homeDirOf(env), "AppData", "Local");
  const base = path.join(root, DESKTOP_REL);
  if (!existsSync(base)) return undefined;
  const dirs = [];
  for (const name of readdirSafe(base)) {
    if (name === "." || name === "..") continue;
    const dir = path.join(base, name);
    const stat = statSafe(dir);
    if (!stat || !stat.isDirectory()) continue;
    dirs.push(dir);
  }
  if (dirs.length === 0) return undefined;
  const fallback = [...dirs].sort((a, b) => a.localeCompare(b, "en")).pop();
  const newest = [...dirs].sort((a, b) => (statSafe(b)?.mtimeMs ?? 0) - (statSafe(a)?.mtimeMs ?? 0));
  for (const sub of CANDIDATE_SUBDIRS) {
    for (const dir of newest) {
      const exe = path.join(dir, sub, "codex.exe");
      if (existsSync(exe)) return exe;
    }
  }
  return fallback !== undefined ? path.join(fallback, "codex.exe") : undefined;
}

function findExecutableInDir(dir) {
  if (process.platform !== "win32") return undefined;
  const names = ["codex.exe", "codex.cmd", "codex.bat", "codex"];
  for (const name of names) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findCodexOnPath(env) {
  // shell:false —— where.exe/which 都是 PATH 上的真实可执行文件，无需经 shell
  // 解析（shell:true 还会触发 Node 24 的传参注入告警）。
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], {
    encoding: "utf8",
    env,
  });
  if (r.status !== 0) return undefined;
  for (const line of r.stdout.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (process.platform === "win32") {
      const ext = path.extname(candidate).toLowerCase();
      if (ext === "" || [".cmd", ".bat", ".ps1"].includes(ext)) continue;
      // 无扩展名 = npm 的 MSYS shim（POSIX 脚本，Windows 不可直接 spawn）；
      // .cmd/.bat/.ps1 = 指向已卸载全局模块的包装脚本残留。均跳过，取下一行。
    }
    return candidate;
  }
  return undefined;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statSafe(file) {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

const ACTIVE_LEGACY_JOB_STATUSES = new Set(["created", "waiting_rate_limit", "running", "resuming"]);

/**
 * 检查执行能力（execute 开启前的门禁）。
 * 冲突时返回 capability blocked 与原因；绝不取消/改写旧 jobs。
 * jobs / daemon.pid 读取异常 → fail-closed（LEGACY_STATE_UNREADABLE）：
 * “状态不可读 = 视为冲突”，宁可阻塞也不双调度器双写。
 */
export async function checkExecutionCapability({
  stateDir,
  pidAlive = defaultPidAlive,
  hasProductionAdapters = true,
}) {
  const reasons = [];

  if (!hasProductionAdapters) {
    reasons.push("production quota/sender/confirmer adapters not available");
  }

  let daemonPid;
  try {
    const raw = await readFile(daemonPidPath(stateDir), "utf8");
    daemonPid = Number(raw.trim());
    if (!Number.isInteger(daemonPid)) daemonPid = undefined;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      reasons.push(`legacy daemon state unreadable (${error?.code ?? error?.message ?? error}); execute blocked fail-closed`);
    }
    daemonPid = undefined;
  }
  if (daemonPid !== undefined && pidAlive(daemonPid)) {
    reasons.push(`legacy daemon owner active (pid ${daemonPid}); execute blocked to avoid dual owner`);
  }

  let jobs = [];
  try {
    jobs = await loadJobs(stateDir);
  } catch (error) {
    // jobs 目录不存在或不可读 → fail-closed：视为存在未知 legacy 状态，阻塞 execute。
    // 绝不吞掉读异常冒充“无活动旧 job”（双写事故的根因）。
    reasons.push(`legacy jobs state unreadable (LEGACY_STATE_UNREADABLE: ${error?.code ?? error?.message ?? error}); execute blocked fail-closed`);
    return { ok: false, reasons };
  }
  const activeJobs = jobs.filter((job) => ACTIVE_LEGACY_JOB_STATUSES.has(job.status));
  if (activeJobs.length > 0) {
    const ids = activeJobs.map((job) => job.id).slice(0, 5);
    reasons.push(`active legacy auto-resume jobs conflict (${ids.join(", ")}${activeJobs.length > 5 ? ", ..." : ""}); execute blocked, legacy jobs untouched`);
  }

  return { ok: reasons.length === 0, reasons };
}

function isObj(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 1024 * 1024) {
      throw new ResumeHostApiError(413, "BODY_TOO_LARGE", "Request body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 状态页/API 的 watch 视图（design §9.1 第 8 条字段）。 */
function toWatchView(watch, executionMode, capabilityReasons) {
  return {
    threadId: watch.threadId,
    cwd: watch.cwd,
    enabled: watch.enabled,
    phase: watch.phase,
    lastObservation: watch.lastObservation ?? null,
    // activeAttemptId 是“已发出过续跑尝试”的幂等证据（reducer decideWithLatch 判定
    // 依据）与崩溃恢复锚点（outbox 记录）；对外视图必须输出，否则 RESUME_QUEUED/
    // RESUME_CONFIRMING/NEEDS_ATTENTION 相位对前端不可区分是否已尝试过。
    activeAttemptId: watch.activeAttemptId ?? null,
    latchEvidence: watch.interruptionLatch
      ? {
          id: watch.interruptionLatch.id,
          detectedAt: watch.interruptionLatch.detectedAt,
          evidenceCycleId: watch.interruptionLatch.evidenceCycleId,
          previousRunningCycleId: watch.interruptionLatch.previousRunningCycleId,
          quotaResetAt: watch.interruptionLatch.quotaResetAt ?? null,
        }
      : null,
    lastError: watch.lastError ?? null,
    resumeAttemptCount: watch.resumeAttemptCount,
    createdAt: watch.createdAt,
    updatedAt: watch.updatedAt,
    executionMode,
    capabilityReasons,
  };
}

export function createResumeDaemon(options = {}) {
  const resolvedStateDir = options.stateDir;
  if (!resolvedStateDir || typeof resolvedStateDir !== "string") {
    throw new Error("resume-host requires an explicit stateDir (never default to LOCALAPPDATA)");
  }

  const env = options.env ?? process.env;
  const executeEnabled = options.executeEnabled ?? autoResumeV2ExecuteEnabled(env);
  const shadowEnabled = options.shadowEnabled ?? autoResumeV2ShadowEnabled(env);

  const clock = options.clock ?? { now: () => Date.now() };

  // 生产缺省构造：未注入任何 fake 时也有完整生产路径——
  // 桌面 SessionObservation 观测（可信时间戳映射）/ app-server 结构化 5h 配额 /
  // thread/resume+turn/start 发送 / 三态 fail-closed 确认。
  // 注入边界：全部可注入，缺省才走生产实现（测试注入 mkdtemp 与 fake）。
  // codexBin/codexArgsPrefix 同 core adapter 的注入形状：测试用伪 app-server
  // （tests/fixtures/fake-codex.js）指认，绝不 spawn 真实 Codex；缺省按上面的
  // 合同解析真实入口（resolveAppServerEntry），仅选择实际存在且可运行的入口。
  const appServerCwd = options.senderCwd ?? process.cwd();
  const resolvedEntry = options.codexBin ?? resolveAppServerEntry({}, env);
  // 解析产物（{command,prefix,resolved,source} 对象）直接交给 core adapter，
  // client 会把它展开为 [command, ...prefix, ...args] —— 绝不回退 core 的旧
  // resolveCodexBin()（那是“存在即选”的旧全局路径来源）。
  // 只有显式注入且是普通字符串时，才按 core 的兼容形状（字符串 → command）传递。
  const codexBinOption =
    resolvedEntry !== null && resolvedEntry !== undefined
      ? typeof resolvedEntry === "string"
        ? resolvedEntry
        : { command: resolvedEntry.command, prefix: resolvedEntry.prefix, resolved: resolvedEntry.resolved }
      : undefined;
  const appServerOptions = {
    cwd: appServerCwd,
    env,
    ...(codexBinOption !== undefined ? { codexBin: codexBinOption } : {}),
    ...(options.codexArgsPrefix !== undefined ? { codexArgsPrefix: options.codexArgsPrefix } : {}),
  };
  const quotaReader =
    options.quotaReader ??
    (() => {
      const production = createAppServerQuotaReader(appServerOptions);
      return () => production();
    })();
  // `createAppServerSessionReader` 有意暴露更丰富的 `SessionObservation`（时间戳、
  // 置信度、原因），而 core monitor 的 `SessionReader` 契约更窄、只消费 state 字符串。
  // 在生产边界做这个映射：需要完整观测的调用方不被迫降级，缺省 monitor 也绝不会
  // 误收到观测对象。
  const desktopSessionReader = createAppServerSessionReader({ env, clock });
  const sessionReader =
    options.sessionReader ??
    (async (threadId) => (await desktopSessionReader(threadId)).state);
  const productionSender = options.sender ?? createAppServerSender(appServerOptions);
  const productionConfirmer = options.confirmer ?? createAppServerConfirmer(appServerOptions);

  // 生产适配器判定：缺省即生产（恒 true）。
  const hasProductionAdapters = true;

  const store = options.store ?? createWatchStore(resolvedStateDir);

  const capability = {
    ok: false,
    reasons: [],

    async refresh() {
      const result = await checkExecutionCapability({
        stateDir: resolvedStateDir,
        hasProductionAdapters,
      });
      this.ok = result.ok;
      this.reasons = result.reasons;
      return this;
    },
  };

  // 执行模式判定：execute 开启 + 门禁全过 → "execute"；否则 shadow 或 "observe"。
  // 门禁检查结果决定 sender 是否生效——门禁失败时无论 execute 是否开启都不发送。
  let mode = executeEnabled ? "execute" : shadowEnabled ? "shadow" : "observe";
  let effectiveSender = nullSender(); // 默认：绝不真实发送。

  // 跨进程全局 owner lease：start() 前获取，stop() 释放。
  // 复用 core thread-lease 原语（stateDir/locks 下固定 key），与 thread 级
  // lease 同目录不同 key，不冲突；ownerToken 每实例 randomUUID 唯一——
  // 两个宿主实例共享 stateDir 并发 start 时最多一个 scheduler owner。
  const ownerToken = options.ownerToken ?? randomUUID();
  let ownerLease = null;

  // outbox 的 sender 绑定是执行模式的**活引用**：execute 门禁在 start() 才刷新，
  // 而能力（daemon pid / legacy jobs）运行期可变，手动刷新（refreshCapability）
  // 后必须让后续发送走新 sender。因此这里只注入未绑定的 outbox（缺省构造），
  // 具体 sender/confirmer 绑定由 rebuildMonitor() 每次重建时注入——
  // 绝不在构造期捕获 effectiveSender 的初值（那是 nullSender，会造成 execute
  // 模式真实 sender 永不生效的绑定缺陷）。
  let outbox = null;
  let monitor = null;
  let detectInFlight = false;

  function rebuildMonitor() {
    // 每次刷新执行模式都重建 monitor 与 outbox，使发送侧绑定跟随最新 mode：
    // - observe/shadow/execute-blocked → outbox 绑定 nullSender（发送恒 0）；
    // - execute → outbox 绑定生产 sender + 三态 confirmer（或注入的假件）。
    const liveSender = effectiveSender;
    outbox = options.outbox ?? createAttemptOutbox({ stateDir: resolvedStateDir, sender: liveSender, confirmer: productionConfirmer, clock });
    monitor = createMonitor({
      stateDir: resolvedStateDir,
      quotaReader,
      sessionReader,
      clock,
      ownerToken,
      store,
      outbox,
      sender: liveSender,
      confirmer: liveSender === productionSender ? productionConfirmer : nullConfirmer(),
    });
  }

  let lastDetectedAt = null;
  let lastReport = null;
  let lastError = null;

  async function runDetection() {
    if (detectInFlight) {
      // 不可重入：上一轮未结束，本轮只记 SKIPPED_OVERLAP（与 scheduler 的
      // SKIPPED_OVERLAP 报告同形：cycleId "skipped"，skippedOverlapCount 1）。
      // API 如实返回“本轮被跳过”，绝不并发执行。
      return { cycleId: "skipped", quotaOk: false, quotaState: undefined, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 1 };
    }
    detectInFlight = true;
    try {
      // 动态门禁：每个自动 tick 与 detect 前都重新刷新 capability——
      // 运行中新增 legacy job / legacy daemon 启动 → 当轮立即 sender=0；
      // 冲突解除后下一 tick 自动重评估。
      await refreshExecutionMode();
      rebuildMonitor();
      const report = await monitor.detect();
      lastDetectedAt = new Date(clock.now()).toISOString();
      lastReport = report;
      lastError = null;
      return report;
    } catch (error) {
      lastError = error?.message ?? String(error);
      return null;
    } finally {
      detectInFlight = false;
    }
  }

  let scheduler = null;
  let deferredStartTimer = null;

  function startScheduler() {
    if (scheduler) return;
    scheduler = createFixedRateScheduler({
      detect: runDetection,
      timer: options.timer,
      clock,
    });
    // 启动即 await 首次立即 detect 完成（start() 返回前已产生 first report；
    // 否则状态页的 lastDetectionAt 可能仍为 null）。
    return scheduler.start();
  }

  /**
   * 启动时 owner lease 被未过期的陈旧租约挡住（重启间隔 < 10 分钟时，旧进程
   * 的 leaseUntil 未到但 PID 已死）：此刻 acquire 必失败，若直接放弃则调度器
   * 永不启动（线上事故：状态页“上次检测”停在十几分钟前）。
   * 修复：计算 lease 剩余 TTL，安排一次延迟补位——TTL 过后重新 acquire 并
   * 启动 scheduler；若期间另一实例已接管则放弃（幂等）。最多延迟 10 分钟。
   */
  async function scheduleDeferredStart() {
    clearDeferredStart();
    const stateDir = resolvedStateDir;
    try {
      const leasePath = path.join(stateDir, "locks", `${safeLockName(OWNER_LEASE_THREAD_ID)}.lease.json`);
      const raw = await readFile(leasePath, "utf8");
      const parsed = JSON.parse(raw);
      const remaining = typeof parsed?.leaseUntil === "number" ? Math.max(0, parsed.leaseUntil - clock.now()) : 0;
      if (remaining <= 0) {
        // 租约已过期：立即补位（start 调用时刻与此刻之间的空窗）。
        deferredStartTimer = setImmediate(() => void retryStart());
        return;
      }
      // 等租约过期后再补位；上限 10 分钟，避免无限延迟。
      const delayMs = Math.min(remaining + 1_000, 10 * 60_000);
      deferredStartTimer = setTimeout(() => void retryStart(), delayMs);
      deferredStartTimer.unref?.();
    } catch {
      // lease 文件不可读（不存在/损坏）：当作无租约，立即补位。
      deferredStartTimer = setImmediate(() => void retryStart());
    }
  }

  function clearDeferredStart() {
    if (deferredStartTimer) {
      clearTimeout(deferredStartTimer);
      clearImmediate(deferredStartTimer);
      deferredStartTimer = null;
    }
  }

  async function retryStart() {
    deferredStartTimer = null;
    if (scheduler) return; // 已有调度器在跑。
    const acquired = await acquireOwnerLease();
    if (!acquired) return; // 另一实例已接管；不重复补位（它会负责调度）。
    await refreshExecutionMode();
    rebuildMonitor();
    await startScheduler();
  }

  function stopScheduler() {
    if (scheduler) {
      scheduler.stop();
      scheduler = null;
    }
  }

  async function acquireOwnerLease() {
    if (ownerLease) return true;
    const handle = await takeThreadLease(resolvedStateDir, OWNER_LEASE_THREAD_ID, ownerToken, {
      now: () => clock.now(),
      isPidAlive: defaultPidAlive,
    });
    if (handle === undefined) {
      // 另一个实例已持有 owner：不启动 scheduler，execute 保持 blocked。
      mode = "execute-blocked";
      effectiveSender = nullSender();
      return false;
    }
    ownerLease = handle;
    return true;
  }

  async function releaseOwnerLease() {
    const handle = ownerLease;
    ownerLease = null;
    if (handle) await handle.release();
  }

  async function refreshOwnerLease() {
    // 运行期续租：被抢占（另一实例 restart 后 TTL+PID 失效重取）→ 本轮不再发送。
    if (!ownerLease) return false;
    const handle = await takeThreadLease(resolvedStateDir, OWNER_LEASE_THREAD_ID, ownerToken, {
      now: () => clock.now(),
      isPidAlive: defaultPidAlive,
    });
    if (handle === undefined) {
      ownerLease = null;
      return false;
    }
    ownerLease = handle;
    return true;
  }

  /** owner lease 是否仍由本实例持有（execute 发送的硬前提；未取得 → 当轮发送侧强制为空）。 */
  async function ensureOwnerHeld() {
    if (ownerLease === null) return false;
    return refreshOwnerLease();
  }

  // 执行模式判定 + owner 门禁合一：execute 只有“本实例持有 owner lease 且能力全过”
  // 才生效；未持有 owner 时即使 executeEnabled 也视为 blocked（绝不绕过 owner 双写）。
  async function refreshExecutionMode() {
    const ownerHeld = await ensureOwnerHeld();
    await capability.refresh();
    const gateOk = capability.ok;
    if (!executeEnabled) {
      mode = shadowEnabled ? "shadow" : "observe";
      effectiveSender = nullSender();
      return;
    }
    if (ownerHeld && gateOk && productionSender) {
      mode = "execute";
      effectiveSender = productionSender;
      return;
    }
    mode = ownerHeld ? (gateOk ? "blocked-no-sender" : "execute-blocked") : "execute-blocked";
    effectiveSender = nullSender();
    return;
  }

  function watchesView() {
    return { watches: [], executionMode: mode, capabilityReasons: capability.reasons, lastDetectionAt: lastDetectedAt };
  }

  function activeOutbox() {
    // DELETE 时当前 outbox 一定存在（start()/runDetection 已 rebuild）；双保险兜底。
    return outbox ?? createAttemptOutbox({ stateDir: resolvedStateDir, sender: nullSender(), confirmer: nullConfirmer(), clock });
  }

  async function handleRequest(request, response, url, sendJson, methodNotAllowed) {
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/auto-resume")) {
      return false;
    }
    if (request.method === "GET" && pathname === "/api/auto-resume/watches") {
      if ([...url.searchParams.keys()].length > 0) {
        throw new ResumeHostApiError(400, "UNKNOWN_QUERY_PARAMETER", "GET /api/auto-resume/watches does not accept query parameters");
      }
      const all = await store.list();
      const views = all.map((watch) => toWatchView(watch, mode, capability.reasons));
      return sendJson(response, 200, {
        watches: views,
        executionMode: mode,
        capabilityReasons: capability.reasons,
        lastDetectionAt: lastDetectedAt,
      });
    }

    const putRoute = pathname.match(/^\/api\/auto-resume\/watches\/([^/]+)$/);
    if (putRoute && request.method === "PUT") {
      if ([...url.searchParams.keys()].length > 0) {
        throw new ResumeHostApiError(400, "UNKNOWN_QUERY_PARAMETER", "PUT /api/auto-resume/watches/:threadId does not accept query parameters");
      }
      let body;
      try {
        body = JSON.parse(await readRequestBody(request));
      } catch {
        throw new ResumeHostApiError(400, "INVALID_BODY", "Request body must be JSON");
      }
      if (!isObj(body)) {
        throw new ResumeHostApiError(400, "INVALID_BODY", "Request body must be an object");
      }
      if (body.enabled !== true) {
        throw new ResumeHostApiError(400, "INVALID_BODY", "'enabled' must be true to create a watch");
      }
      let threadId;
      try {
        threadId = decodeURIComponent(putRoute[1]);
      } catch {
        throw new ResumeHostApiError(400, "INVALID_PATH", "Thread id contains invalid encoding");
      }
      if (!threadId || typeof threadId !== "string" || threadId.length > 1000) {
        throw new ResumeHostApiError(400, "INVALID_FIELD", "'threadId' must be a non-empty string");
      }
      const cwd = body.cwd;
      if (!cwd || typeof cwd !== "string" || !path.isAbsolute(cwd)) {
        throw new ResumeHostApiError(400, "INVALID_FIELD", "'cwd' must be an absolute path");
      }
      const now = new Date(clock.now()).toISOString();
      const existing = await store.load(threadId);
      const watch = {
        schemaVersion: 2,
        threadId,
        cwd,
        enabled: true,
        phase: "MONITORING",
        resumeAttemptCount: existing?.resumeAttemptCount ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(existing?.lastObservation ? { lastObservation: existing.lastObservation } : {}),
        ...(existing?.armedByDetection ? { armedByDetection: existing.armedByDetection } : {}),
        ...(existing?.interruptionLatch ? { interruptionLatch: existing.interruptionLatch } : {}),
        ...(existing?.activeAttemptId ? { activeAttemptId: existing.activeAttemptId } : {}),
        ...(existing?.lastError ? { lastError: existing.lastError } : {}),
      };
      await store.upsert(watch);
      return sendJson(response, 200, { watch: toWatchView(watch, mode, capability.reasons) });
    }

    if (putRoute && request.method === "DELETE") {
      if ([...url.searchParams.keys()].length > 0) {
        throw new ResumeHostApiError(400, "UNKNOWN_QUERY_PARAMETER", "DELETE /api/auto-resume/watches/:threadId does not accept query parameters");
      }
      let threadId;
      try {
        threadId = decodeURIComponent(putRoute[1]);
      } catch {
        throw new ResumeHostApiError(400, "INVALID_PATH", "Thread id contains invalid encoding");
      }
      if (!threadId || typeof threadId !== "string") {
        throw new ResumeHostApiError(400, "INVALID_FIELD", "'threadId' must be a non-empty string");
      }
      // 使用已验收的 clearWatchArtifacts：与检测/发送共用同一 thread lease
      // （withThreadLease 临界区），拿不到 lease（检测或发送进行中）→ 409，
      // 绝不先返回 200 后 watch 复活。只删目标 thread 的 watch/outbox，不改旧 jobs。
      const cleared = await clearWatchArtifacts(resolvedStateDir, threadId, ownerToken, store, activeOutbox());
      if (!cleared) {
        throw new ResumeHostApiError(409, "WATCH_BUSY", "thread lease unavailable; deletion deferred (detection or send in progress)");
      }
      return sendJson(response, 200, { ok: true, threadId });
    }

    if (request.method === "POST" && pathname === "/api/auto-resume/detect") {
      if ([...url.searchParams.keys()].length > 0) {
        throw new ResumeHostApiError(400, "UNKNOWN_QUERY_PARAMETER", "POST /api/auto-resume/detect does not accept query parameters");
      }
      const report = await runDetection();
      return sendJson(response, 200, {
        detectedAt: lastDetectedAt,
        cycleId: report?.cycleId ?? null,
        quotaOk: report?.quotaOk ?? null,
        quotaState: report?.quotaState ?? null,
        resumedCount: report?.resumedCount ?? 0,
        skippedOverlapCount: report?.skippedOverlapCount ?? 0,
        // 只触发检测，绝不强制 resume；返回本轮观察到的 watch 决策，不发送任何消息。
        watchOutcomes: (report?.watchOutcomes ?? []).map((o) => ({
          threadId: o.threadId,
          nextPhase: o.nextPhase,
          queued: o.queued,
          skipped: o.skipped,
          error: o.error ?? null,
        })),
      });
    }

    if (request.method === "POST" && pathname === "/api/auto-resume/refresh") {
      // 显式重评估 capability（冲突解除后无需等下一 tick；设计 §9 运维面）。
      if ([...url.searchParams.keys()].length > 0) {
        throw new ResumeHostApiError(400, "UNKNOWN_QUERY_PARAMETER", "POST /api/auto-resume/refresh does not accept query parameters");
      }
      await refreshExecutionMode();
      rebuildMonitor();
      return sendJson(response, 200, { executionMode: mode, capability: { ok: capability.ok, reasons: capability.reasons } });
    }

    if (pathname === "/api/auto-resume/watches" && request.method !== "GET") {
      return methodNotAllowed(response, ["GET"]);
    }
    if (putRoute && !["PUT", "DELETE"].includes(request.method)) {
      return methodNotAllowed(response, ["PUT", "DELETE"]);
    }
    if (pathname === "/api/auto-resume/detect" && request.method !== "POST") {
      return methodNotAllowed(response, ["POST"]);
    }
    if (pathname === "/api/auto-resume/refresh" && request.method !== "POST") {
      return methodNotAllowed(response, ["POST"]);
    }
    throw new ResumeHostApiError(404, "NOT_FOUND", "Auto-resume route not found");
  }

  return {
    stateDir: resolvedStateDir,
    resolveAppServerEntry,
    // 解析出的生产入口；null = 无可用入口，quota 保持 UNKNOWN、execute 门禁不过。
    resolvedEntry,
    handleRequest,
    async start() {
      // 先取跨进程全局 owner lease：拿不到（另一实例持有）→ 不启动 scheduler，
      // execute 保持 blocked；拿到才刷新门禁并启动唯一 scheduler（启动即立即 detect）。
      // 拿不到的原因若是"未过期的陈旧租约"（PID 已死但 TTL 未到），安排延迟补位，
      // 租约过期后自动重新 acquire——避免调度器永不启动。
      const acquired = await acquireOwnerLease();
      if (!acquired) {
        await refreshExecutionMode();
        rebuildMonitor();
        await scheduleDeferredStart();
        return;
      }
      clearDeferredStart(); // 本实例已持有 owner：取消可能存在的延迟补位。
      await refreshExecutionMode();
      rebuildMonitor();
      await startScheduler();
    },
    async stop() {
      clearDeferredStart();
      stopScheduler();
      await releaseOwnerLease();
    },
    detectOnce: runDetection,
    async tickNow() {
      if (scheduler) return scheduler.tickNow?.();
      return runDetection();
    },
    async refreshCapability() {
      await refreshExecutionMode();
      rebuildMonitor();
      return { mode, capability: { ok: capability.ok, reasons: capability.reasons } };
    },
    getExecutionMode() {
      return mode;
    },
    getCapability() {
      return { ok: capability.ok, reasons: capability.reasons };
    },
    getStatus() {
      return {
        executionMode: mode,
        capability: { ok: capability.ok, reasons: capability.reasons },
        ownerLeaseHeld: ownerLease !== null,
        lastDetectionAt: lastDetectedAt,
        lastReport,
        lastError,
      };
    },
    listWatches() {
      return store.list();
    },
    watchesView,
  };
}
