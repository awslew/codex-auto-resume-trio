/**
 * resume-core 编程入口 —— 供宿主应用（如 taskboard server）内嵌调度。
 * 导出与 CLI（bin/car.js）等价的能力，但以库形式调用。
 */
export { createJob, loadJob, loadJobs, saveJob, summarizeJob } from "./store.js";
export { runJobOnce } from "./supervisor.js";
export { runDaemon } from "./daemon.js";
export { scanDesktopSessions, pickSessions, listCodexSessions, isInternalSession } from "./desktop-sessions.js";
export { validateThreadResume, resumeWithAppServer } from "./app-server/supervisor.js";
export { runCodexCli, buildCodexArgs } from "./codex-cli.js";
export { defaultStateDir } from "./paths.js";
export { withJobLock } from "./lock.js";
export { classifyRateLimit } from "./rate-limit.js";
export { nextRunAtFromReset, nextBackoffMs } from "./reset-time.js";
export {
  APP_NAME,
  DEFAULT_RESUME_PROMPT,
  MAX_AUTO_RESUMES,
  RESET_BUFFER_MS,
  DEFAULT_DAEMON_INTERVAL_MS,
  DEFAULT_SANDBOX,
} from "./constants.js";
export type { Job, JobStatus, GitBaseline, RunOptions, CodexRunResult } from "./types.js";
