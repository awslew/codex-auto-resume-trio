#!/usr/bin/env node
/**
 * Codex 自动续跑宿主 CLI
 *
 * 子命令：
 *   run        前台常驻：守护器（无人值守续跑）+ 只读状态页（+ 可选托盘）
 *   status     打印一次执行模式 / 能力门禁 / 上次检测结果（默认 JSON，可 --pretty）
 *   watches    列出全部 watch
 *   watch      增删 watch：watch add <threadId> --cwd <绝对路径> | watch rm <threadId>
 *   detect     立即触发一次检测（不强制发送；发送与否仍由状态机与门禁决定）
 *   tray       单独拉起系统托盘（通常由 run --tray 负责，不需要手敲）
 *
 * 退出码：0 正常；1 参数/运行错误；2 状态不健康（仅 status --strict）
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultStateDir } from "../../../dist/index.js";

import { createResumeDaemon, autoResumeV2ExecuteEnabled, autoResumeV2ShadowEnabled } from "../src/daemon.mjs";
import { createStatusServer } from "../src/http-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = join(HERE, "..");
const RUNTIME_DIR = join(HOST_ROOT, "runtime");
const PID_FILE = join(RUNTIME_DIR, "host.pid");

const DEFAULT_PORT = 5173;

function usage() {
  return `Codex 自动续跑宿主

用法:
  node bin/resume-host.mjs run [--port 5173] [--tray] [--execute|--shadow|--observe]
  node bin/resume-host.mjs status [--json|--pretty] [--strict]
  node bin/resume-host.mjs watches [--json]
  node bin/resume-host.mjs watch add <threadId> --cwd <绝对路径>
  node bin/resume-host.mjs watch rm <threadId>
  node bin/resume-host.mjs detect
  node bin/resume-host.mjs tray [--port 5173]

环境变量:
  RESUME_HOST_PORT        状态页端口（默认 ${DEFAULT_PORT}）
  RESUME_HOST_STATE_DIR   状态目录（默认 resume-core 的 ${defaultStateDir()}）
  AUTO_RESUME_V2_EXECUTE  1 = 允许真实发送；不设则恒 observe（零发送）
  AUTO_RESUME_V2_SHADOW   1 = shadow（记录决策但不发送）
  CODEX_BIN               显式指定 Codex app-server 入口（可选）

注意：真实发送必须显式开启（--execute 或 AUTO_RESUME_V2_EXECUTE=1），
      且仍受“唯一 owner + 能力门禁 + 5h 额度结构化识别”三重约束。
`;
}

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();
  const booleanFlags = new Set(["tray", "execute", "shadow", "observe", "json", "pretty", "strict", "help", "no-tray"]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
      if (eq !== -1) {
        flags.set(name, token.slice(eq + 1));
      } else if (booleanFlags.has(name)) {
        flags.set(name, true);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags.set(name, true);
        } else {
          flags.set(name, next);
          i += 1;
        }
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

function resolvePort(flags) {
  const raw = flags.get("port") ?? process.env.RESUME_HOST_PORT ?? DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --port: ${raw}`);
  }
  return port;
}

function resolveStateDir(flags) {
  const explicit = flags.get("state-dir") ?? process.env.RESUME_HOST_STATE_DIR;
  return typeof explicit === "string" && explicit.trim() !== "" ? explicit.trim() : defaultStateDir();
}

/** 按 --execute/--shadow/--observe 覆盖守护器的执行开关。 */
function resolveModeOverride(flags) {
  if (flags.get("execute") === true) return { execute: true, shadow: false };
  if (flags.get("shadow") === true) return { execute: false, shadow: true };
  if (flags.get("observe") === true) return { execute: false, shadow: false };
  return {};
}

function buildDaemon(flags, options = {}) {
  const stateDir = resolveStateDir(flags);
  const mode = resolveModeOverride(flags);
  return createResumeDaemon({
    stateDir,
    executeEnabled: mode.execute ?? autoResumeV2ExecuteEnabled(),
    shadowEnabled: mode.shadow ?? autoResumeV2ShadowEnabled(),
    ...options,
  });
}

function resolvePythonw() {
  const candidates = [process.env.PYTHONW, process.env.PYTHON, "pythonw.exe", "pythonw", "python3", "python"];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes("\\") || candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  return undefined;
}

function writePidFile(port) {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }, null, 2));
}

function clearPidFile() {
  try {
    rmSync(PID_FILE, { force: true });
  } catch {
    // 退出清理尽力而为，不掩盖真正的退出原因。
  }
}

export function readPidFile() {
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf8"));
  } catch {
    return undefined;
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload;
  try {
    payload = text === "" ? undefined : JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.raw ?? response.statusText;
    throw new Error(`HTTP ${response.status} ${url}: ${detail}`);
  }
  return payload;
}

function printStatus(status, port) {
  const lines = [];
  const executeOn = status.executionMode === "execute";
  lines.push(`执行模式     : ${status.executionMode}${executeOn ? "  ← 真实发送已开启" : "  ← 零发送"}`);
  lines.push(`能力门禁     : ${status.capability?.ok ? "通过" : "未通过"}`);
  for (const reason of status.capability?.reasons ?? []) {
    lines.push(`               · ${reason}`);
  }
  lines.push(`owner lease  : ${status.ownerLeaseHeld ? "本实例持有" : "未持有（另一实例在跑或尚未启动）"}`);
  lines.push(`状态目录     : ${status.stateDir}`);
  lines.push(`Codex 入口   : ${status.codexEntry ? `${status.codexEntry.command} ${(status.codexEntry.prefix ?? []).join(" ")} [${status.codexEntry.source}]` : "未解析到可用入口（额度恒 UNKNOWN）"}`);
  lines.push(`上次检测     : ${status.lastDetectionAt ?? "尚未检测"}`);
  lines.push(`watch 数量   : ${status.watchCount}`);
  if (status.lastError) lines.push(`上次错误     : ${status.lastError}`);
  if (status.lastReport) {
    lines.push(`上轮 cycle   : ${status.lastReport.cycleId ?? "-"}  quota=${status.lastReport.quotaState ?? "-"}  续跑=${status.lastReport.resumedCount ?? 0}`);
  }
  lines.push(`状态页       : http://127.0.0.1:${port}`);
  return lines.join("\n");
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // 打开浏览器失败不影响宿主运行。
  }
}

async function commandRun(flags) {
  const port = resolvePort(flags);
  const daemon = buildDaemon(flags);
  const server = createStatusServer({ daemon, port });
  const wantTray = flags.get("tray") === true && flags.get("no-tray") !== true;

  let stopping = false;
  let trayChild;
  const shutdownChain = [];

  async function shutdown(reason, exitCode = 0) {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n[resume-host] 退出中（${reason}）…\n`);
    for (const step of shutdownChain.reverse()) {
      try {
        await step();
      } catch {
        // 逐个清理，单个失败不阻塞其余步骤。
      }
    }
    clearPidFile();
    process.exit(exitCode);
  }

  await daemon.start();
  await server.listen();
  writePidFile(port);

  const status = daemon.getStatus();
  process.stdout.write(
    `[resume-host] 已启动 pid=${process.pid} 状态目录=${daemon.stateDir}\n` +
      `[resume-host] 执行模式=${status.executionMode} 能力门禁=${status.capability.ok ? "通过" : `未通过（${status.capability.reasons.join("; ")}）`}\n` +
      `[resume-host] 状态页 http://127.0.0.1:${port}/  （Ctrl+C 退出）\n`,
  );

  shutdownChain.push(() => daemon.stop());
  shutdownChain.push(() => server.close());

  if (wantTray) {
    const pythonw = resolvePythonw();
    const trayScript = join(HOST_ROOT, "scripts", "tray.py");
    if (!pythonw || !existsSync(trayScript)) {
      process.stdout.write(`[resume-host] 跳过托盘（python=${pythonw ?? "未找到"}，脚本=${existsSync(trayScript)}）\n`);
    } else {
      trayChild = spawn(pythonw, [trayScript], {
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, RESUME_HOST_URL: `http://127.0.0.1:${port}`, RESUME_HOST_PID: String(process.pid) },
      });
      trayChild.once("exit", () => {
        trayChild = undefined;
      });
      shutdownChain.push(() => {
        trayChild?.kill();
      });
    }
  }

  if (flags.get("open") === true) openBrowser(`http://127.0.0.1:${port}/`);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (error) => {
    process.stderr.write(`[resume-host] unhandledRejection: ${error?.stack ?? error}\n`);
  });
}

async function commandStatus(flags) {
  const pid = readPidFile();
  const port = resolvePort(flags);
  const daemon = buildDaemon(flags);
  try {
    const payload = await fetchJson(`http://127.0.0.1:${port}/api/host/status`);
    if (flags.get("json") === true) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`${printStatus(payload, port)}\n`);
    }
    const healthy = payload.executionMode === "execute" || payload.executionMode === "observe" || payload.executionMode === "shadow";
    if (flags.get("strict") === true && !healthy) process.exitCode = 2;
    return;
  } catch (error) {
    // 宿主没在跑：退回到"离线只读"——直接读磁盘上的 watch/lease 状态，不启动调度器。
    const watches = await daemon.listWatches();
    const offline = {
      running: false,
      reason: error?.message ?? String(error),
      stateDir: daemon.stateDir,
      pidFile: pid ?? null,
      watchCount: watches.length,
      watches,
    };
    if (flags.get("json") === true) {
      process.stdout.write(`${JSON.stringify(offline, null, 2)}\n`);
    } else {
      process.stdout.write(
        `宿主未在运行（${offline.reason}）\n` +
          `状态目录 : ${offline.stateDir}\n` +
          `watch 数 : ${offline.watchCount}\n` +
          `提示     : 用 \`npm run daemon\` 或 start.cmd 启动常驻宿主\n`,
      );
    }
    if (flags.get("strict") === true) process.exitCode = 2;
  }
}

async function commandWatches(flags) {
  const port = resolvePort(flags);
  try {
    const payload = await fetchJson(`http://127.0.0.1:${port}/api/auto-resume/watches`);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    const daemon = buildDaemon(flags);
    const watches = await daemon.listWatches();
    process.stdout.write(`${JSON.stringify({ offline: true, reason: error?.message ?? String(error), count: watches.length, watches }, null, 2)}\n`);
  }
}

async function commandWatch(flags, positional) {
  const [, action, threadId] = positional;
  if (!action || !["add", "rm"].includes(action) || !threadId) {
    throw new Error("用法: watch add <threadId> --cwd <绝对路径> | watch rm <threadId>");
  }
  const port = resolvePort(flags);
  const encoded = encodeURIComponent(threadId);
  if (action === "add") {
    const cwd = flags.get("cwd");
    if (typeof cwd !== "string" || cwd.trim() === "") {
      throw new Error("watch add 需要 --cwd <绝对路径>（Codex 会话的工作目录）");
    }
    const payload = await fetchJson(`http://127.0.0.1:${port}/api/auto-resume/watches/${encoded}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, cwd: cwd.trim() }),
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const payload = await fetchJson(`http://127.0.0.1:${port}/api/auto-resume/watches/${encoded}`, { method: "DELETE" });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function commandDetect(flags) {
  const port = resolvePort(flags);
  const payload = await fetchJson(`http://127.0.0.1:${port}/api/auto-resume/detect`, { method: "POST" });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function commandTray(flags) {
  const port = resolvePort(flags);
  const pythonw = resolvePythonw();
  if (!pythonw) throw new Error("未找到 pythonw/python，无法启动托盘");
  const trayScript = join(HOST_ROOT, "scripts", "tray.py");
  if (!existsSync(trayScript)) throw new Error(`托盘脚本不存在：${trayScript}`);
  const child = spawn(pythonw, [trayScript], {
    stdio: "inherit",
    env: { ...process.env, RESUME_HOST_URL: `http://127.0.0.1:${port}` },
  });
  child.once("exit", (code) => process.exit(code ?? 0));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? "help";

  if (flags.get("help") === true || command === "help" || command === "--help") {
    process.stdout.write(usage());
    return;
  }

  switch (command) {
    case "run":
      await commandRun(flags);
      return;
    case "status":
      await commandStatus(flags);
      return;
    case "watches":
      await commandWatches(flags);
      return;
    case "watch":
      await commandWatch(flags, positional);
      return;
    case "detect":
      await commandDetect(flags);
      return;
    case "tray":
      await commandTray(flags);
      return;
    default:
      process.stderr.write(`未知子命令：${command}\n\n${usage()}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});
