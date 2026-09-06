/**
 * V2 自动续跑的生产适配器（AUTO_RESUME_V2_EXECUTION_PLAN.md §7 T4；AUTO_RESUME_V2_DESIGN.md §6.3/§9）。
 *
 * 本模块是唯一允许由服务端复用的生产适配层：
 * - quotaReader：调用 `account/rateLimits/read`，结果只交给 `normalizeFiveHourQuota`
 *   做结构化窗口识别（windowDurationMins===300 或明确 5h limitId/limitName）；
 *   绝不用通用 usage-limit 文案猜测 5 小时窗口（design §3.3 铁律）。
 * - sender：复用 app-server supervisor 的 thread/resume + turn/start 路径
 *   （resumeWithAppServer），返回明确额度失败（quotaBlocked）以区分技术失败；
 *   turn 在常驻宿主进程内运行（fire-and-forget，2026-09-06 起不再等
 *   turn/completed——真实任务数小时，旧 120 秒等待+stop 会杀掉运行中的 turn）。
 * - confirmer：三态确认（design §6.3；T2 验收修复 A）。查询异常 => UNKNOWN，
 *   绝不冒充 NOT_STARTED；本模块无法可靠确认时会明确返回 UNKNOWN（fail-closed）。
 *
 * 本模块不做任何业务迁移，也不写任何持久化文件；quota 归一化与状态机
 * 分别在 five-hour-quota.ts / auto-resume-reducer.ts。
 */
import { spawn } from "node:child_process";
import { classifyRateLimit } from "../rate-limit.js";
import { normalizeFiveHourQuota } from "../five-hour-quota.js";
import type { RateLimitResponse } from "../types.js";
import type { ConfirmationResult, SendOutcome, Sender } from "../resume-attempt.js";
import { AppServerClient } from "./client.js";
import { DEFAULT_SANDBOX } from "../constants.js";
import { DEFAULT_RESUME_PROMPT } from "../constants.js";
import { collectDesktopSessionData } from "../desktop-sessions.js";
import { isPlausibleTurnTs, observeDesktopSessions, SESSION_OBSERVATION_REVISION } from "../desktop-session-observation.js";
import type { SessionObservation } from "../desktop-session-observation.js";
import type { ResumeAttempt } from "../auto-resume-types.js";

/** 生产 app-server 配额读取器：账户级 rateLimits，只走结构化窗口识别。 */
export function createAppServerQuotaReader(options: { cwd: string; codexBin?: string; codexArgsPrefix?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = { cwd: process.cwd() }) {
  return async (): Promise<{ state: "POSITIVE" | "ZERO" | "UNKNOWN"; resetAt?: number; raw?: unknown }> => {
    const client = new AppServerClient({
      codexBin: options.codexBin,
      codexArgsPrefix: options.codexArgsPrefix,
      cwd: options.cwd,
      env: options.env,
    });
    try {
      await client.start();
      const limits = (await client.request("account/rateLimits/read", undefined, options.timeoutMs ?? 15_000)) as RateLimitResponse | null | undefined;
      const quota = normalizeFiveHourQuota(limits);
      if (quota.state === "UNKNOWN") {
        return { state: "UNKNOWN" as const, ...(quota.resetAt !== undefined ? { resetAt: quota.resetAt } : {}), raw: limits };
      }
      return { state: quota.state, ...(quota.resetAt !== undefined ? { resetAt: quota.resetAt } : {}), raw: limits };
    } finally {
      await client.stop();
    }
  };
}

/**
 * 续跑 turn 常驻宿主（threadId -> 存活 app-server 客户端）。
 *
 * turn/start 之后真实任务可能运行数小时：宿主进程必须与 turn 同寿命。
 * 发送即返回（fire-and-forget），不再等待 turn/completed（旧实现 120 秒超时后
 * stop() 会把还在运行的 turn 一并杀掉——真实任务全军覆没）。
 * 运行/完成证据由 confirmer 经宿主存活状态 + 会话库（thread_turns）确认。
 */
const turnHosts = new Map<string, AppServerClient>();

function isInProgressTurnStatus(status: string): boolean {
  return status === "inProgress" || status === "in_progress" || status === "running" || status === "queued";
}

async function execFileText(command: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 无人值守桌面端接管（writer 锁释放的唯一程序化途径）：
 * 找到 MSIX 桌面主进程（ExecutablePath 含 WindowsApps\OpenAI.Codex 的 codex.exe，
 * 绝不匹配我们自建的 LOCALAPPDATA bin 入口），先优雅关闭（taskkill /T），3 秒后
 * 仍存活才强杀。桌面端退出后其 thread writer 锁变陈旧，核心自动清理。
 * 仅 win32；best-effort，任何失败都吞掉（下轮 writerBusy 重试再试）。
 */
export async function killDesktopCodex(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const psFilter = "Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | Where-Object { $_.ExecutablePath -like '*WindowsApps*OpenAI.Codex*' } | ForEach-Object { $_.ProcessId }";
  const desktopPids = async (): Promise<string[]> => {
    try {
      return (await execFileText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psFilter]))
        .split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
    } catch {
      return [];
    }
  };
  const pids = await desktopPids();
  if (pids.length === 0) return false;
  for (const pid of pids) {
    try { await execFileText("taskkill.exe", ["/PID", pid, "/T"], 15_000); } catch { /* 可能已退出 */ }
  }
  await sleep(3_000);
  for (const pid of await desktopPids()) {
    try { await execFileText("taskkill.exe", ["/PID", pid, "/T", "/F"], 15_000); } catch { /* 已退出 */ }
  }
  return true;
}

/** 生产发送器：thread/resume + turn/start（复用 resume-core 的 app-server 路径）。
 * - 发送前先读一次账户额度并做结构化识别；明确 5h 额度失败 → quotaBlocked（不计技术失败）。
 * - turn 在常驻宿主进程内运行（fire-and-forget），发送返回即视为已下发；
 *   运行/完成证据由 confirmer 确认（宿主存活状态 + 会话库）。
 * - 目标会话被桌面端占用（thread 单写者锁）→ writerBusy：先经 onWriterBusy 无人值守
 *   接管（默认 killDesktopCodex），attempt 不计失败、下轮重试。
 */
export function createAppServerSender(options: {
  cwd: string;
  codexBin?: string;
  codexArgsPrefix?: string[];
  env?: NodeJS.ProcessEnv;
  /** writerBusy 时的接管钩子（默认：全会话库静止时优雅关闭桌面端）；测试注入 spy/no-op。 */
  onWriterBusy?: (threadId: string) => Promise<unknown>;
} = { cwd: process.cwd() }): Sender {
  const onWriterBusy = options.onWriterBusy ?? (async () => {
    // 安全护栏：会话库中只要还有任何运行中 turn（用户手动续跑的其他会话、
    // 我们其他 watch 的宿主 turn），绝不关桌面端——本轮留队重试，等全部静止。
    // 会话库不可读时同样保守不接管（fail-closed）。
    try {
      const data = collectDesktopSessionData(options.env ?? process.env);
      for (const entry of data.values()) {
        if ((entry.turns ?? []).some(
          (turn) => isPlausibleTurnTs(turn.started_at ?? 0) && isInProgressTurnStatus(turn.status),
        )) {
          return false;
        }
      }
    } catch {
      return false;
    }
    await killDesktopCodex();
  });
  return {
    async send(attempt: ResumeAttempt, watch: { threadId: string; cwd: string }): Promise<SendOutcome> {
      const cwd = watch.cwd || options.cwd;

      // 发送前额度复核（design §6.3）：只认结构化 5h 窗口。一次性探针客户端，
      // 不承载 turn（turn 由常驻宿主承载）。
      const probe = new AppServerClient({
        codexBin: options.codexBin,
        codexArgsPrefix: options.codexArgsPrefix,
        cwd,
        env: options.env,
      });
      try {
        await probe.start();
        const limits = (await probe.request("account/rateLimits/read", undefined, 15_000)) as RateLimitResponse | null | undefined;
        const quota = normalizeFiveHourQuota(limits);
        if (quota.state === "ZERO") {
          return { ok: false, quotaBlocked: true, error: "five-hour quota is still exhausted before send" };
        }
        if (quota.state === "UNKNOWN") {
          // 无法确认 5h 窗口可用 → 不发送（能力门禁 fail-closed）。
          return { ok: false, error: "five-hour quota window not identifiable before send; blocked" };
        }
      } finally {
        await probe.stop();
      }

      // 常驻宿主：复用同 thread 存活客户端（重试路径），否则新建。
      let host = turnHosts.get(attempt.threadId);
      if (!host || !host.running) {
        host = new AppServerClient({
          codexBin: options.codexBin,
          codexArgsPrefix: options.codexArgsPrefix,
          cwd,
          env: options.env,
        });
        await host.start();
        turnHosts.set(attempt.threadId, host);
      }
      try {
        await host.request(
          "thread/resume",
          { threadId: attempt.threadId, cwd, sandbox: DEFAULT_SANDBOX },
          20_000
        );
        await host.request(
          "turn/start",
          {
            threadId: attempt.threadId,
            cwd,
            input: [{ type: "text", text: DEFAULT_RESUME_PROMPT, text_elements: [] }],
          },
          20_000
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/already has an active writer/i.test(message)) {
          // Codex thread 单写者锁：目标会话正被桌面端等其它写者占用。暂时性
          // busy——触发无人值守接管钩子（默认优雅关闭桌面端），返回 writerBusy
          // （不计技术失败，monitor 留队下轮重试）。
          try { await onWriterBusy(attempt.threadId); } catch { /* 接管失败不影响重试 */ }
          return { ok: false, writerBusy: true, error: message };
        }
        // 宿主异常：丢弃（下轮重建），按技术失败上抛。
        turnHosts.delete(attempt.threadId);
        void host.stop().catch(() => {});
        throw error;
      }
      // 发送已下发，立即返回；turn 可能运行数小时，绝不等待、绝不杀宿主。
      return { ok: true, detail: { fireAndForget: true } };
    },
  };
}

/** 生产会话读取器：桌面会话观测（已验收 SessionObservation，可信时间戳映射）。 */
export function createAppServerSessionReader(options: { env?: NodeJS.ProcessEnv; clock?: { now: () => number } } = {}): {
  (threadId: string): Promise<SessionObservation>;
  collect: (env?: NodeJS.ProcessEnv) => SessionObservation[];
} {
  const env = options.env ?? process.env;
  const clock = options.clock ?? { now: () => Date.now() };
  const collect = (collectEnv: NodeJS.ProcessEnv = env) => observeDesktopSessions(collectEnv, clock);
  return Object.assign(
    async (threadId: string): Promise<SessionObservation> => {
      const target = threadId;
      const found = collect().find((observation) => observation.threadId === target);
      if (found !== undefined) return found;
      // 会话库中没有该 threadId 的记录：无法证明中断，也不能证明运行（UNKNOWN，
      // 与 observeDesktopSession 的"无记录"语义一致）——绝不猜测状态。
      return {
        threadId: target,
        state: "UNKNOWN",
        observedAt: new Date(clock.now()).toISOString(),
        sourceRevision: SESSION_OBSERVATION_REVISION,
        confidence: "UNTRUSTED",
        reason: "no desktop session records for thread",
      };
    },
    { collect }
  );
}

/** 生产确认器（2026-09-06 接入可查询的会话库，替换恒 UNKNOWN 占位）：
 * - 进程内证据优先：该 thread 的常驻 turn 宿主仍存活 → turn 必然已启动 → CONFIRMED。
 * - 会话库证据：thread_turns 中存在晚于 attempt 创建时间的 turn →
 *   inProgress/completed => CONFIRMED；无记录 => NOT_STARTED（可安全补发）；
 *   failed/interrupted => UNKNOWN（绝不冒充成功，保留 outbox 待人工）。
 * - 查询异常 => UNKNOWN（fail-closed）。 */
export function createAppServerConfirmer(options: {
  env?: NodeJS.ProcessEnv;
  clock?: { now: () => number };
  collector?: (env: NodeJS.ProcessEnv) => Map<string, import("../desktop-session-observation.js").DesktopSessionData>;
} = {}): {
  confirm(attempt: ResumeAttempt): Promise<ConfirmationResult>;
} {
  const env = options.env ?? process.env;
  const collector = options.collector ?? ((e: NodeJS.ProcessEnv) => collectDesktopSessionData(e));
  return {
    async confirm(attempt: ResumeAttempt): Promise<ConfirmationResult> {
      const host = turnHosts.get(attempt.threadId);
      if (host && host.running) {
        return { state: "CONFIRMED", reason: "resident turn host alive for thread" };
      }
      try {
        const createdMs = Date.parse(attempt.createdAt);
        if (!Number.isFinite(createdMs)) {
          return { state: "UNKNOWN", reason: "attempt.createdAt not parseable" };
        }
        const entry = collector(env).get(attempt.threadId);
        const postAttemptTurns = (entry?.turns ?? [])
          .filter((turn) => isPlausibleTurnTs(turn.started_at ?? 0) && (turn.started_at ?? 0) * 1000 >= createdMs - 5_000)
          .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
        if (postAttemptTurns.length === 0) {
          return { state: "NOT_STARTED", reason: "no turn newer than attempt" };
        }
        const latest = postAttemptTurns[0];
        if (isInProgressTurnStatus(latest.status)) {
          return { state: "CONFIRMED", reason: "post-attempt turn is in progress" };
        }
        if (latest.status === "completed") {
          return { state: "CONFIRMED", reason: "post-attempt turn completed" };
        }
        return { state: "UNKNOWN", reason: `post-attempt turn status: ${latest.status}` };
      } catch (error) {
        return { state: "UNKNOWN", reason: `session store query failed: ${String((error as Error).message ?? error)}` };
      }
    },
  };
}

export { classifyRateLimit };
