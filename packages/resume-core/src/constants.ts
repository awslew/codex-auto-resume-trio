export const APP_NAME = "codex-auto-resume";
export const DEFAULT_RESUME_PROMPT =
  "继续完成此前任务。先检查当前 git status、git diff、测试结果和未完成清单，\n" +
  "不要重复已经完成的工作。完成剩余实现，运行测试，并总结结果。";
export const MAX_AUTO_RESUMES = 5;
export const RESET_BUFFER_MS = 30_000;
export const DEFAULT_DAEMON_INTERVAL_MS = 60_000;
export const DEFAULT_SANDBOX = "workspace-write" as const;
