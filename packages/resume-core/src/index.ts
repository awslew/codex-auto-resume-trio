/**
 * resume-core 编程入口 —— 供宿主应用（如 taskboard server）内嵌调度。
 * 导出与 CLI（bin/car.js）等价的能力，但以库形式调用。
 */
export { createJob, loadJob, loadJobs, saveJob, summarizeJob } from "./store.js";
export { runJobOnce } from "./supervisor.js";
export { runDaemon } from "./daemon.js";
export { scanDesktopSessions, pickSessions, listCodexSessions, isInternalSession, isInternalSource, isNoiseSession } from "./desktop-sessions.js";
export {
  observeDesktopSessions,
  observeDesktopSession,
  collectDesktopSessionData,
  isPlausibleTurnTs,
  SESSION_OBSERVATION_REVISION,
  type SessionObservation,
  type SessionObservationState,
  type SessionObservationConfidence,
  type DesktopSessionData,
  type DesktopTurnRow,
  type DesktopSessionRow,
} from "./desktop-sessions.js";
export {
  loadSessionIndex,
  findRollouts,
  parseRollout,
  summarizeSession,
  recentSummaries,
  isSessionStalled,
  idleMinutes,
} from "./transcript.js";
export {
  loadScore,
  statusOf,
  buildBeats,
  shortName,
  type PgmSession,
  type PgmWorkspace,
  type PgmState,
  type PgmBeat,
} from "./pgm-score.js";
export { validateThreadResume, resumeWithAppServer } from "./app-server/supervisor.js";
export { runCodexCli, buildCodexArgs } from "./codex-cli.js";
export { withJobLock } from "./lock.js";
export { classifyRateLimit } from "./rate-limit.js";
export { nextRunAtFromReset, nextBackoffMs } from "./reset-time.js";
export { normalizeFiveHourQuota, isFiveHourQuotaState } from "./five-hour-quota.js";
export { autoResumeReducer, resumeAttemptId, armingValidUntil } from "./auto-resume-reducer.js";
export { createWatchStore, WATCH_SCHEMA_VERSION, safeUnlockName, type WatchStore, type WatchStoreStats } from "./auto-resume-store.js";
export { createMonitor, applyDecisionAtomically, newCycleId, clearWatchArtifacts, MAX_CONCURRENT_RESUMES_PER_CYCLE, type MonitorOptions, type MonitorReport, type WatchOutcome, type SessionReader, type QuotaReader } from "./auto-resume-monitor.js";
export { createAttemptOutbox, nullSender, nullConfirmer, MAX_ATTEMPT_FAILURES, type AttemptOutbox, type Sender, type Confirmer, type SendOutcome, type ConfirmationResult } from "./resume-attempt.js";
export { withThreadLease, takeThreadLease, safeLockName, defaultPidAlive, THREAD_LEASE_TTL_MS, type ThreadLease, type ThreadLeaseHandle, type ThreadLeaseOptions, type PidAliveCheck } from "./thread-lease.js";
export { createFixedRateScheduler, type FixedRateSchedulerOptions, type SchedulerHandle, type DetectionFn, type TimerLike } from "./fixed-rate-scheduler.js";
export { createAppServerQuotaReader, createAppServerSender, createAppServerConfirmer, createAppServerSessionReader } from "./app-server/auto-resume-adapter.js";
export { APP_NAME, DEFAULT_RESUME_PROMPT, MAX_AUTO_RESUMES, RESET_BUFFER_MS, DEFAULT_DAEMON_INTERVAL_MS, DEFAULT_SANDBOX, AUTO_RESUME_DETECTION_INTERVAL_MS } from "./constants.js";
export { defaultStateDir, jobsDir, watchesDir, attemptsDir, threadLeasesDir, daemonPidPath } from "./paths.js";
export type { Job, JobStatus, GitBaseline, RunOptions, CodexRunResult } from "./types.js";
export type {
  AutoResumeWatch,
  DetectionSnapshot,
  TransitionDecision,
  AutoResumeCommand,
  ResumeAttempt,
  InterruptionLatch,
  ArmingEvidence,
  SessionState,
  FiveHourQuotaState,
  FiveHourQuota,
  WatchPhase,
} from "./auto-resume-types.js";
