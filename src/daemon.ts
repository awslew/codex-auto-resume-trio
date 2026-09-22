import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { DEFAULT_DAEMON_INTERVAL_MS } from "./constants.js";
import { daemonPidPath } from "./paths.js";
import { loadJobs } from "./store.js";
import { runJobOnce } from "./supervisor.js";
import type { RunOptions } from "./types.js";

export async function runDaemon(options: RunOptions & { intervalMs?: number; once?: boolean }): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_DAEMON_INTERVAL_MS;
  for (;;) {
    const jobs = await loadJobs(options.stateDir);
    for (const job of jobs) {
      if (["created", "waiting_rate_limit", "running", "resuming"].includes(job.status)) {
        await runJobOnce(job.id, options);
      }
    }
    if (options.once) {
      return;
    }
    await sleep(intervalMs);
  }
}

export async function startDaemon(stateDir: string): Promise<number> {
  await mkdir(stateDir, { recursive: true });
  const existing = await readPid(stateDir);
  if (existing && isAlive(existing)) {
    return existing;
  }
  const child = spawn(process.execPath, [process.argv[1]!, "daemon", "foreground"], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  await writeFile(daemonPidPath(stateDir), `${child.pid}\n`, { mode: 0o600 });
  return child.pid ?? 0;
}

export async function stopDaemon(stateDir: string): Promise<boolean> {
  const pid = await readPid(stateDir);
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already stopped.
  }
  await rm(daemonPidPath(stateDir), { force: true });
  return true;
}

async function readPid(stateDir: string): Promise<number | undefined> {
  try {
    const raw = await readFile(daemonPidPath(stateDir), "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
