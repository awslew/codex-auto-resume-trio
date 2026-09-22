import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { autoResumeReducer, armingValidUntil } from "./auto-resume-reducer.js";
import type { AutoResumeWatch, DetectionSnapshot, ResumeAttempt, SessionState, TransitionDecision } from "./auto-resume-types.js";
import { createWatchStore, type WatchStore } from "./auto-resume-store.js";
import { createAttemptOutbox, MAX_ATTEMPT_FAILURES, type AttemptOutbox, type Confirmer, type Sender, type SendOutcome } from "./resume-attempt.js";
import { withThreadLease, type ThreadLeaseOptions } from "./thread-lease.js";

/**
 * 自动续跑 monitor：一轮检测 = 一次共享 quota 快照 + 逐 watch 决策 +
 * thread lease 临界区内的队列执行（AUTO_RESUME_V2_DESIGN.md §6/§7；执行计划 §7 T2）。
 *
 * 轮次语义：
 * - 一轮只调用一次 quotaReader，所有 watch 共享同一 cycleId 快照（design §7）。
 * - quota 读取失败 → 本轮 quota 规范化为 UNKNOWN；仍逐 watch 读取 session、运行
 *   reducer 并持久化 lastObservation/updatedAt（fail-closed 但不失明），动作恒 NONE。
 * - 逐会话读取失败 → 该 watch 记 lastError、记录诊断 observation，不阻塞其他会话。
 * - 先完成所有 watch 的状态迁移，再执行续跑队列（design §6.4）。
 * - 同轮符合条件的 attempt 最多并发 2 个；超出按 interruptionLatch.detectedAt
 *   FIFO 留到下一轮（本轮不发送）。
 *
 * 迁移原子性：observation / arming / latch / clear-latch / disable / activeAttemptId
 * 在同一次 store.upsert 中落盘（单文件整体写入），命令执行前先写盘。
 *
 * 防重：reducer 只在无 activeAttemptId 时输出 queue-resume；临界区内先写
 * activeAttemptId（经 upsert 持久化）再发送；outbox 记录发送前落盘且 attemptId
 * 由 threadId+latchId 确定性推导——两个调度器/重复 tick/进程重启都收敛到同一条。
 *
 * 确认三态（验收修复 A）：确认 CONFIRMED → 标确认；NOT_STARTED → 才允许补发；
 * UNKNOWN（异常/超时/无法查询）→ 绝不调用 sender，保留 outbox+latch+activeAttempt，
 * 本 watch 进入 NEEDS_ATTENTION 待人工。
 *
 * 技术失败（验收修复 B）：唯一真相源是 outbox record.failureCount（上限 2）；
 * sender 技术失败只增 1；failureCount >= 2 后任何 tick 不得再调用 sender；
 * quotaBlocked 不计技术失败，额度恢复后仍复用同一 attemptId。
 *
 * 本模块绝不真实发送：默认 sender 为空实现，真实 app-server 发送由 T4 注入。
 */

export const MAX_CONCURRENT_RESUMES_PER_CYCLE = 2;

/** 每轮配额观测的原始追踪落盘（诊断专用；任何写失败都吞掉，绝不影响检测）。 */
async function appendQuotaTrace(stateDir: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = path.join(stateDir, "logs");
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "quota-observations.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // 诊断写失败不影响检测主流程。
  }
}

export type SessionReader = (threadId: string) => Promise<SessionState>;
export type QuotaReader = () => Promise<{ state: "POSITIVE" | "ZERO" | "UNKNOWN"; resetAt?: number; raw?: unknown }>;
export type TimeProvider = { now: () => number };

export interface MonitorOptions {
  stateDir: string;
  quotaReader: QuotaReader;
  sessionReader: SessionReader;
  clock: TimeProvider;
  /** 调用方提供的 ownerToken；不同 monitor owner 必须传入不同值。 */
  ownerToken: string;
  store?: WatchStore;
  outbox?: AttemptOutbox;
  sender?: Sender;
  confirmer?: Confirmer;
  /** 覆盖 thread lease 的 TTL 与 PID 探测（测试注入）。 */
  lease?: ThreadLeaseOptions;
  /** 覆盖并发上限（测试注入；生产默认 2）。 */
  maxConcurrent?: number;
}

export interface WatchOutcome {
  threadId: string;
  decision: TransitionDecision;
  /** 决策后即将/已写入的新 phase；null = 无迁移。 */
  nextPhase: AutoResumeWatch["phase"] | null;
  /** 本轮是否完成一次可复用的发送尝试。 */
  queued: boolean;
  skipped: boolean;
  error?: string;
}

export interface MonitorReport {
  cycleId: string;
  /** quota 本轮是否可用；false = 整轮只观察。 */
  quotaOk: boolean;
  quotaState?: "POSITIVE" | "ZERO" | "UNKNOWN";
  watchOutcomes: WatchOutcome[];
  resumedCount: number;
  skippedOverlapCount: number;
}

export interface PendingQueueEntry {
  watch: AutoResumeWatch;
  attemptId: string;
  detectedAt: number;
}

interface LeasedWatchResult {
  watch?: AutoResumeWatch;
  decision?: TransitionDecision;
  queue?: PendingQueueEntry;
  skipped?: boolean;
  error?: string;
}

interface LeasedSendResult {
  sent?: SendOutcome;
  skipped?: boolean;
  error?: string;
}

/** 每一轮生成唯一的 cycleId（UUID v4）。 */
export function newCycleId(): string {
  return randomUUID();
}

export function createMonitor(options: MonitorOptions): { detect: (cycleId?: string) => Promise<MonitorReport> } {
  const store = options.store ?? createWatchStore(options.stateDir);
  const outbox = options.outbox ?? createAttemptOutbox({ stateDir: options.stateDir, sender: options.sender, confirmer: options.confirmer, clock: options.clock });
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_RESUMES_PER_CYCLE;

  return {
    async detect(cycleId: string = newCycleId()): Promise<MonitorReport> {
      // The first read is the shared decision snapshot for this cycle.
      let quotaState: "POSITIVE" | "ZERO" | "UNKNOWN" = "UNKNOWN";
      let quotaResetAt: number | undefined;
      let quotaOk = true;
      let quotaReadError: string | undefined;
      try {
        const quota = await options.quotaReader();
        quotaState = quota.state;
        quotaResetAt = quota.resetAt;
        // 原始响应逐轮落盘（诊断专用，best-effort）：2026-09-06 线上质疑
        // “官方 2:25 恢复但 02:09 已发送”需要 ground truth 判定
        // usedPercent 与真实封禁状态的关系，下轮耗尽周期即可对证。
        void appendQuotaTrace(options.stateDir, {
          detectedAt: new Date(options.clock.now()).toISOString(),
          cycleId,
          state: quotaState,
          ...(quotaResetAt !== undefined ? { resetAt: quotaResetAt } : {}),
          ...(quota.raw !== undefined ? { raw: quota.raw } : {}),
        });
      } catch (error) {
        quotaOk = false;
        const message = error instanceof Error ? error.message : String(error);
        quotaReadError = `quota read failed: ${message}`;
      }

      const watches = await store.list();
      const report: MonitorReport = { cycleId, quotaOk, quotaState, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 0 };
      const queue: PendingQueueEntry[] = [];

      for (const listedWatch of watches) {
        const outcome: WatchOutcome = {
          threadId: listedWatch.threadId,
          decision: { nextPhase: null, commands: [] },
          nextPhase: null,
          queued: false,
          skipped: false,
        };
        // quota 读取失败时，本轮 quota 规范化为 UNKNOWN（quotaState 已留在初值），
        // 但必须继续逐 watch 读取 session、拿 thread lease、运行 reducer 并持久化
        // lastObservation/updatedAt（fail-closed 但不失明）。UNKNOWN 下 reducer
        // 不产生任何命令（不建 latch、不 disable、不 queue-resume）→ 天然 0 发送；
        // 本轮动作恒为 NONE。诊断保留在 report.quotaOk=false + quotaState + error。

        // Re-read the watch and keep session read, decision, cleanup and the
        // atomic watch upsert in one thread lease. listedWatch is only an index.
        const result = await withThreadLease(options.stateDir, listedWatch.threadId, options.ownerToken, async (): Promise<LeasedWatchResult> => {
          const watch = await store.load(listedWatch.threadId);
          if (watch === undefined) return { skipped: true, error: "watch disappeared before decision" };

          let sessionState: SessionState;
          try {
            sessionState = await options.sessionReader(watch.threadId);
          } catch (error) {
            const message = `session read failed: ${String((error as Error).message ?? error)}`;
            const failed: AutoResumeWatch = {
              ...watch,
              lastObservation: {
                cycleId,
                detectedAt: new Date(options.clock.now()).toISOString(),
                sessionState: "UNKNOWN" as const,
                fiveHourQuota: quotaState,
                ...(quotaResetAt !== undefined ? { quotaResetAt } : {}),
              },
              lastError: message,
              updatedAt: new Date(options.clock.now()).toISOString(),
            };
            try {
              await store.upsert(failed);
              return { watch: failed, skipped: true, error: message };
            } catch (persistError) {
              return { watch, skipped: true, error: `${message}; persist failed: ${String((persistError as Error).message ?? persistError)}` };
            }
          }

          const snapshot: DetectionSnapshot = {
            cycleId,
            detectedAt: new Date(options.clock.now()).toISOString(),
            sessionState,
            fiveHourQuota: quotaState,
            ...(quotaResetAt !== undefined ? { quotaResetAt } : {}),
            trusted: true,
          };

          // Persisted in-flight phases are not re-decided. The send stage below
          // re-reads the watch under the same per-thread lease before sending.
          const inFlight = watch.phase === "RESUME_QUEUED" || watch.phase === "RESUME_CONFIRMING" || watch.phase === "NEEDS_ATTENTION";
          const decision: TransitionDecision = inFlight
            ? { nextPhase: watch.phase, commands: [] }
            : autoResumeReducer(watch, snapshot, options.clock.now());
          const next = applyDecisionAtomically(watch, decision, snapshot, options.clock.now());

          // A self-healed or normally completed watch must not retain orphaned
          // attempts. Remove only this thread's records before committing the
          // corresponding watch state.
          if (decision.commands.some((command) => command.type === "clear-latch")) {
            const oldAttempt = attemptForWatch(watch, options.clock.now());
            if (oldAttempt !== undefined) {
              try {
                await outbox.remove(oldAttempt);
              } catch (error) {
                return { watch, decision, skipped: true, error: `clear-latch outbox cleanup failed: ${String((error as Error).message ?? error)}` };
              }
            }
          } else if (decision.commands.some((command) => command.type === "disable")) {
            try {
              const attempts = (await outbox.loadPending()).filter((attempt) => attempt.threadId === watch.threadId);
              for (const attempt of attempts) await outbox.remove(attempt);
            } catch (error) {
              return { watch, decision, skipped: true, error: `disable outbox cleanup failed: ${String((error as Error).message ?? error)}` };
            }
          }

          try {
            await store.upsert(next);
          } catch (error) {
            return { watch, decision, skipped: true, error: `persist failed: ${String((error as Error).message ?? error)}` };
          }

          let pending: PendingQueueEntry | undefined;
          if ((next.phase === "RESUME_QUEUED" || next.phase === "RESUME_CONFIRMING") && next.activeAttemptId !== undefined && next.interruptionLatch !== undefined) {
            const detectedAtMs = Date.parse(next.interruptionLatch.detectedAt);
            pending = { watch: next, attemptId: next.activeAttemptId, detectedAt: Number.isFinite(detectedAtMs) ? detectedAtMs : 0 };
          }
          return { watch: next, decision, queue: pending };
        }, options.lease);

        if (result === undefined) {
          outcome.skipped = true;
          outcome.error = "thread lease unavailable; deferred to a later cycle";
          report.watchOutcomes.push(outcome);
          continue;
        }
        outcome.skipped = result.skipped === true;
        if (result.error !== undefined) outcome.error = result.error;
        if (!quotaOk && outcome.error === undefined) {
          // quota 读取失败：保留诊断（watch 级错误优先，不覆盖），本轮仅观察。
          outcome.error = `${quotaReadError ?? "quota read failed"}; cycle observed only`;
        }
        if (result.decision !== undefined) {
          outcome.decision = result.decision;
          outcome.nextPhase = result.decision.nextPhase ?? result.watch?.phase ?? listedWatch.phase;
        }
        if (result.queue !== undefined) queue.push(result.queue);
        report.watchOutcomes.push(outcome);
      }

      queue.sort((a, b) => a.detectedAt - b.detectedAt);
      const toSend = queue.slice(0, maxConcurrent);
      const deferred = queue.slice(maxConcurrent);

      // This is deliberately a second, independent guard read. It is only
      // performed when this cycle has work in its send batch; it never becomes
      // a new decision snapshot or rewrites lastObservation.
      let guardState: "POSITIVE" | "ZERO" | "UNKNOWN" = "POSITIVE";
      if (toSend.length > 0) {
        try {
          const guard = await options.quotaReader();
          guardState = guard.state;
        } catch {
          guardState = "UNKNOWN";
        }
      }

      const sendOne = async (entry: PendingQueueEntry): Promise<void> => {
        const outcome = report.watchOutcomes.find((item) => item.threadId === entry.watch.threadId)!;
        const result = await withThreadLease(options.stateDir, entry.watch.threadId, options.ownerToken, async (): Promise<LeasedSendResult> => {
          const current = await store.load(entry.watch.threadId);
          if (current === undefined || current.activeAttemptId !== entry.attemptId || current.interruptionLatch === undefined) {
            return { skipped: true, error: "attempt no longer active" };
          }

          if (guardState !== "POSITIVE") {
            const phase = guardState === "ZERO" ? "WAITING_FOR_5H_QUOTA" : "NEEDS_ATTENTION";
            const message = guardState === "ZERO" ? "fresh quota guard is ZERO; send deferred" : "fresh quota guard is UNKNOWN; send blocked";
            await store.upsert({ ...current, phase, lastError: message, updatedAt: new Date(options.clock.now()).toISOString() });
            return { error: message };
          }

          // 发送前 resetAt 兜底守卫（2026-09-06 线上：官方 2:25 恢复但 02:09 已发送）：
          // 中断时官方给出的窗口 reset 时间未到 → 本轮不发、留在 RESUME_QUEUED 下轮再试。
          // 防止 usedPercent 滞后于真实封禁（<100% 但已被限额）的读取过早烧掉重试机会；
          // resetAt 一过守卫自动放行，无需任何人工开关。
          const latchResetAt = current.interruptionLatch?.quotaResetAt;
          if (typeof latchResetAt === "number" && Number.isFinite(latchResetAt) && options.clock.now() < latchResetAt) {
            const message = `official quota reset not reached (${new Date(latchResetAt).toISOString()}); send deferred`;
            await store.upsert({ ...current, phase: "RESUME_QUEUED", lastError: message, updatedAt: new Date(options.clock.now()).toISOString() });
            return { error: message };
          }

          // Prefer the durable attempt (and its cwd) on recovery. Only a
          // missing record is materialized from the leased watch.
          const persisted = (await outbox.loadPending()).find((attempt) => attempt.id === entry.attemptId);
          const attempt = persisted ?? attemptForWatch(current, options.clock.now());
          if (attempt === undefined) return { skipped: true, error: "active attempt metadata missing" };
          if (attempt.threadId !== current.threadId || attempt.latchId !== current.interruptionLatch.id) {
            return { skipped: true, error: "attempt metadata does not match active latch" };
          }

          let sent: SendOutcome;
          try {
            sent = await outbox.send(attempt);
          } catch (error) {
            // FileAttemptOutbox converts sender throws into one recordFailure;
            // this branch is reserved for an outbox/storage failure itself.
            const message = `outbox send failed: ${String((error as Error).message ?? error)}`;
            await store.upsert({ ...current, phase: "NEEDS_ATTENTION", lastError: message, updatedAt: new Date(options.clock.now()).toISOString() });
            return { error: message };
          }

          if (sent.ok && sent.confirmed === true) {
            // Clear the watch before removing the confirmed outbox: a crash in
            // cleanup cannot make a confirmed attempt eligible for a new send.
            const cleared: AutoResumeWatch = { ...current, phase: "MONITORING", enabled: true, updatedAt: new Date(options.clock.now()).toISOString() };
            delete cleared.interruptionLatch;
            delete cleared.activeAttemptId;
            delete cleared.lastError;
            await store.upsert(cleared);
            try {
              await outbox.remove(attempt);
            } catch (error) {
              return { sent, error: `confirmed outbox cleanup failed: ${String((error as Error).message ?? error)}` };
            }
            return { sent };
          }

          if (sent.ok) {
            // Sender success without reliable confirmation remains queued. A
            // later tick may replay confirmation; UNKNOWN never blind-resends.
            return { sent };
          }

          const message = sent.error ?? "send failed";
          if (sent.quotaBlocked === true) {
            await store.upsert({ ...current, phase: "WAITING_FOR_5H_QUOTA", lastError: message, updatedAt: new Date(options.clock.now()).toISOString() });
            return { error: `quota blocked; attempt returned to waiting: ${message}` };
          }
          if (sent.writerBusy === true) {
            // 目标会话被桌面端等写者占用（Codex thread 单写者锁）：暂时性 busy，
            // 不计技术失败、保持在 RESUME_QUEUED，下一轮自动重试（写者释放即成功）。
            await store.upsert({ ...current, phase: "RESUME_QUEUED", lastError: message, updatedAt: new Date(options.clock.now()).toISOString() });
            return { error: `writer busy; attempt kept queued: ${message}` };
          }
          if (sent.detail !== undefined && (sent.detail as { givingUp?: boolean }).givingUp === true) {
            await store.upsert({ ...current, phase: "NEEDS_ATTENTION", lastError: message, updatedAt: new Date(options.clock.now()).toISOString() });
            return { error: message };
          }
          if (sent.detail !== undefined && (sent.detail as { confirmationUnknown?: boolean }).confirmationUnknown === true) {
            await store.upsert({ ...current, phase: "NEEDS_ATTENTION", lastError: message, updatedAt: new Date(options.clock.now()).toISOString() });
            return { error: message };
          }

          // Technical failure count has already been incremented exactly once
          // by outbox.send; this only reads it and chooses the next phase.
          const failureCount = (await outbox.loadPending()).find((item) => item.id === entry.attemptId)?.failureCount ?? 0;
          const givingUp = failureCount >= MAX_ATTEMPT_FAILURES;
          const finalError = givingUp ? `attempt failed ${failureCount} times; giving up: ${message}` : message;
          await store.upsert({
            ...current,
            phase: givingUp ? "NEEDS_ATTENTION" : "RESUME_QUEUED",
            resumeAttemptCount: Math.max(current.resumeAttemptCount, failureCount),
            lastError: finalError,
            updatedAt: new Date(options.clock.now()).toISOString(),
          });
          return { error: finalError };
        }, options.lease);

        if (result === undefined || result.skipped === true) outcome.skipped = true;
        if (result?.error !== undefined) outcome.error = result.error;
        if (result?.sent?.ok === true) {
          outcome.queued = true;
          report.resumedCount++;
        }
      };

      // Different threads are independent and therefore run in one bounded
      // batch. The per-thread lease still serializes each individual sender.
      await Promise.all(toSend.map((entry) => sendOne(entry)));

      if (deferred.length > 0) report.skippedOverlapCount += deferred.length;
      return report;
    },
  };
}

/**
 * 把 reducer 决策与快照原子合成新 watch（observation/arming/latch/clear-latch/
 * disable/activeAttemptId 同一次保存）：
 * - observation 每轮都写（UNKNOWN 也记录，但不充当迁移证据）。
 * - arming 只在 RUNNING + POSITIVE（无 latch）时刷新，有效期 7 分钟。
 * - create-latch / clear-latch / queue-resume 的字段改动全部在本函数内完成，
 *   调用方随后一次 store.upsert 落盘。
 */
export function applyDecisionAtomically(
  watch: AutoResumeWatch,
  decision: TransitionDecision,
  snapshot: DetectionSnapshot,
  now: number
): AutoResumeWatch {
  const next: AutoResumeWatch = {
    ...watch,
    phase: decision.nextPhase ?? watch.phase,
    lastObservation: {
      cycleId: snapshot.cycleId,
      detectedAt: snapshot.detectedAt,
      sessionState: snapshot.sessionState,
      fiveHourQuota: snapshot.fiveHourQuota,
      ...(snapshot.quotaResetAt !== undefined ? { quotaResetAt: snapshot.quotaResetAt } : {}),
    },
    updatedAt: snapshot.detectedAt,
  };

  for (const command of decision.commands) {
    switch (command.type) {
      case "disable":
        next.enabled = false;
        break;
      case "create-latch":
        next.interruptionLatch = command.latch;
        break;
      case "clear-latch":
        // 同时清除 interruptionLatch 与 activeAttemptId（AR-07 语义）。
        delete next.interruptionLatch;
        delete next.activeAttemptId;
        break;
      case "queue-resume": {
        next.activeAttemptId = command.attempt.id;
        next.resumeAttemptCount += 1;
        break;
      }
    }
  }

  // arming 只在可信 RUNNING + POSITIVE（且无 latch）时刷新；有 latch 或不可信快照不写。
  if (decision.nextPhase === "MONITORING" && snapshot.trusted && snapshot.sessionState === "RUNNING" && snapshot.fiveHourQuota === "POSITIVE" && next.interruptionLatch === undefined) {
    next.armedByDetection = { cycleId: snapshot.cycleId, detectedAt: snapshot.detectedAt, validUntil: armingValidUntil(now) };
  }

  return next;
}

/**
 * Safe DELETE companion for callers outside the core monitor. It serializes the
 * deletion with the same thread lease, removes only outbox attempts belonging
 * to the requested thread, then removes that thread's watch file.
 */
export async function clearWatchArtifacts(
  stateDir: string,
  threadId: string,
  ownerToken: string,
  store: WatchStore = createWatchStore(stateDir),
  outbox: AttemptOutbox = createAttemptOutbox({ stateDir }),
  lease?: ThreadLeaseOptions,
): Promise<boolean> {
  const result = await withThreadLease(stateDir, threadId, ownerToken, async () => {
    const watch = await store.load(threadId);
    const attempts = (await outbox.loadPending()).filter((attempt) => attempt.threadId === threadId);
    for (const attempt of attempts) await outbox.remove(attempt);
    if (watch !== undefined) await store.disable(threadId);
    return watch !== undefined || attempts.length > 0;
  }, lease);
  return result ?? false;
}

function attemptForWatch(watch: AutoResumeWatch, now: number): ResumeAttempt | undefined {
  if (watch.activeAttemptId === undefined || watch.interruptionLatch === undefined) return undefined;
  return {
    id: watch.activeAttemptId,
    threadId: watch.threadId,
    latchId: watch.interruptionLatch.id,
    cwd: watch.cwd,
    status: "QUEUED",
    failureCount: 0,
    createdAt: watch.interruptionLatch.detectedAt || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

export { MAX_ATTEMPT_FAILURES };
