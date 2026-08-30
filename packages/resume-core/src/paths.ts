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
