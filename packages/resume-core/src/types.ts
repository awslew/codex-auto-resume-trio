export type JobStatus =
  | "created"
  | "running"
  | "waiting_rate_limit"
  | "resuming"
  | "completed"
  | "failed"
  | "canceled"
  | "paused";

export type Job = {
  id: string;
  cwd: string;
  task: string;
  status: JobStatus;
  threadId?: string;
  resetAt?: number;
  retryCount: number;
  resumeAttempts: number;
  nextRunAt?: number;
  logPath: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  gitBaseline?: GitBaseline;
};

export type GitBaseline = {
  isGitRepo: boolean;
  status: string;
  diffStat: string;
  capturedAt: string;
};

export type RunOptions = {
  stateDir: string;
  codexBin?: string;
  codexArgsPrefix?: string[];
  env?: NodeJS.ProcessEnv;
  preferAppServer?: boolean;
  notify?: boolean;
  force?: boolean;
};

export type CodexRunResult = {
  exitCode: number | null;
  threadId?: string;
  completed: boolean;
  failed: boolean;
  rateLimit: boolean;
  resetAt?: number;
  error?: string;
};

export type RateLimitWindow = {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
};

export type RateLimitSnapshot = {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  rateLimitReachedType?: string | null;
  [key: string]: unknown;
};

export type RateLimitResponse = {
  rateLimits?: RateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null;
  [key: string]: unknown;
};
