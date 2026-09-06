export const APP_NAME = "codex-auto-resume";
export const DEFAULT_RESUME_PROMPT = "继续完成此前任务";
export const MAX_AUTO_RESUMES = 5;
export const RESET_BUFFER_MS = 30_000;
export const DEFAULT_DAEMON_INTERVAL_MS = 60_000;
export const DEFAULT_SANDBOX = "workspace-write" as const;

/** V2 自动续跑检测周期：fixed-rate 180 秒（design §7；执行计划 §4.4）。 */
export const AUTO_RESUME_DETECTION_INTERVAL_MS = 180_000;
