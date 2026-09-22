import os from "node:os";
import path from "node:path";
import { APP_NAME } from "./constants.js";

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), APP_NAME);
  }
  return path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), APP_NAME);
}

export function jobsDir(stateDir: string): string {
  return path.join(stateDir, "jobs");
}

export function logsDir(stateDir: string): string {
  return path.join(stateDir, "logs");
}

export function locksDir(stateDir: string): string {
  return path.join(stateDir, "locks");
}

export function daemonPidPath(stateDir: string): string {
  return path.join(stateDir, "daemon.pid");
}

/** V2 watch 存储目录（schemaVersion=2；与 jobs 完全隔离，见 auto-resume-store.ts）。 */
export function watchesDir(stateDir: string): string {
  return path.join(stateDir, "watches");
}

/** V2 续跑 attempt 的 outbox 目录（一次性、崩溃恢复，见 resume-attempt.ts）。 */
export function attemptsDir(stateDir: string): string {
  return path.join(stateDir, "attempts");
}

/** V2 thread lease 文件所在目录（locks 子目录，与 V1 job 锁分开）。 */
export function threadLeasesDir(stateDir: string): string {
  return path.join(locksDir(stateDir), "threads");
}
