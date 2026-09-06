import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { attemptsDir } from "./paths.js";
import type { ConfirmationState, ResumeAttempt } from "./auto-resume-types.js";
import { resumeAttemptId } from "./auto-resume-reducer.js";
import { safeLockName } from "./thread-lease.js";

/**
 * 续跑 attempt outbox 与幂等发送（AUTO_RESUME_V2_DESIGN.md §6.2/§6.3；执行计划 §7 T2）。
 *
 * 一次续跑请求 = 一条 outbox 记录（<attemptId>.json）。记录在发送前落盘；
 * 发送后追加 confirmedAt（同文件原子重写）。崩溃恢复规则（三态确认，验收修复 A）：
 *   - 有记录、无 confirmedAt → 上一次发送可能已生效（发送后、确认前崩溃）：
 *     先重放确认：CONFIRMED → 标确认、绝不重发；NOT_STARTED → 允许补发；
 *     UNKNOWN（异常/超时/无法查询）→ 绝不调用 sender，保留记录待人工。
 *   - 有记录、有 confirmedAt → 已确认成功，绝不重发。
 *   - 无记录 → 从未入队（发送前崩溃），允许创建并发送。
 * 同一 threadId+latchId 恒复用同一个 attemptId（sha256），从根上防双发。
 *
 * 技术失败（修复 B）：唯一真相源是 outbox record.failureCount，上限 MAX_ATTEMPT_FAILURES
 * = 2；sender 技术失败只增 1；failureCount >= 2 后任何 tick 不得再调用 sender。
 * quotaBlocked 不计技术失败，额度恢复后仍复用同一 attemptId。
 *
 * 注入边界：sender 负责实际发送（默认实现空转，绝不真实发送）；confirmer 负责
 * 确认新 turn / 晚于 attempt 创建时间的 RUNNING 证据；clock 可注入 fake clock。
 */

export const MAX_ATTEMPT_FAILURES = 2;

/** 发送返回“明确 5 小时额度失败”时不计技术失败、回到等待态（design §6.3）。 */
export type SendFailureKind = "quota" | "technical";

export interface SendOutcome {
  ok: boolean;
  /** The confirmer produced reliable evidence that this attempt is active. */
  confirmed?: boolean;
  /** 明确额度失败（不计技术失败、不重试计数）；undefined 表示未知/非额度失败。 */
  quotaBlocked?: boolean;
  /** 目标会话被其它写者占用（Codex thread 单写者锁，如桌面端开着该会话）。
   * 暂时性 busy：不计技术失败、保留 attempt，下一轮自动重试。 */
  writerBusy?: boolean;
  error?: string;
  /** 发送结果详情（诊断用）。 */
  detail?: unknown;
}

export interface ConfirmationResult {
  /** CONFIRMED：有可靠证据已生效；NOT_STARTED：有可靠证据未启动；UNKNOWN：异常/超时/无法查询。 */
  state: ConfirmationState;
  reason?: string;
}

export interface Sender {
  /** 发送一次续跑（thread/resume + turn/start）。实现方负责真实 app-server 调用。 */
  send(attempt: ResumeAttempt, watch: { threadId: string; cwd: string }): Promise<SendOutcome>;
}

export interface Confirmer {
  /**
   * 确认续跑是否已生效（design §6.3；验收修复 A 三态）：
   *   收到该 threadId 的新 turn id；或
   *   会话进入 RUNNING 且更新时间晚于 attempt 创建时间。
   * 查询抛错/超时/结果不确定时返回 { state: "UNKNOWN" }——调用方绝不据此重发。
   */
  confirm(attempt: ResumeAttempt): Promise<ConfirmationResult>;
}

export interface AttemptStoreOptions {
  stateDir: string;
  sender?: Sender;
  confirmer?: Confirmer;
  clock?: { now: () => number };
}

export interface AttemptOutbox {
  /** 目录扫描出的孤儿发送结果（崩溃恢复专用诊断；含 confirmedAt 以区分已确认）。 */
  loadPending(): Promise<Array<ResumeAttempt & { confirmedAt?: number; quotaBlockedAt?: number }>>;
  /** 发送（幂等）：已确认的 attempt 永不重发；未确认的先重放三态确认再决定。 */
  send(attempt: ResumeAttempt): Promise<SendOutcome>;
  /** 确认成功：落盘 confirmedAt；返回是否完成过确认（false=已确认过）。 */
  confirm(attempt: ResumeAttempt): Promise<{ alreadyConfirmed: boolean }>;
  /** 明确额度失败：记录 quotaBlockedAt，不计技术失败。 */
  markQuotaBlocked(attempt: ResumeAttempt): Promise<void>;
  /** 技术失败计数 +1（同一 attempt id 复用，最多 MAX_ATTEMPT_FAILURES 次）。 */
  recordFailure(attempt: ResumeAttempt, error: string): Promise<void>;
  /** 移除 outbox 记录（清除 latch 时使用；不影响 watch 数据）。 */
  remove(attempt: ResumeAttempt): Promise<void>;
}

/** 默认发送器：不发送任何东西（T2 只建立可注入契约；真实发送由 T4 接入）。 */
export function nullSender(): Sender {
  return { async send() { return { ok: false, error: "sender not configured" }; } };
}

/** 默认确认器：无法查询 → 恒 UNKNOWN（保守：绝不据此重发；T2 只建立可注入契约）。 */
export function nullConfirmer(): Confirmer {
  return { async confirm() { return { state: "UNKNOWN", reason: "confirmer not configured" }; } };
}

export function createAttemptOutbox(options: AttemptStoreOptions): AttemptOutbox {
  const sender = options.sender ?? nullSender();
  const confirmer = options.confirmer ?? nullConfirmer();
  const clock = options.clock ?? { now: () => Date.now() };
  return new FileAttemptOutbox(options.stateDir, sender, confirmer, clock);
}

class FileAttemptOutbox implements AttemptOutbox {
  constructor(
    private readonly stateDir: string,
    private readonly sender: Sender,
    private readonly confirmer: Confirmer,
    private readonly clock: { now: () => number }
  ) {}

  private dir(): string {
    return attemptsDir(this.stateDir);
  }

  private pathFor(attemptId: string): string {
    return path.join(this.dir(), `${safeLockName(attemptId)}.json`);
  }

  private async read(attemptId: string): Promise<StoredAttempt | undefined> {
    try {
      const raw = await readFile(this.pathFor(attemptId), "utf8");
      const parsed: unknown = JSON.parse(raw);
      return isStoredAttempt(parsed) ? parsed : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async recordExists(attemptId: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(attemptId), "utf8");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async write(stored: StoredAttempt): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    const file = this.pathFor(stored.id);
    const tmp = path.join(this.dir(), `.${safeLockName(stored.id)}.${process.pid}.${this.clock.now()}.tmp`);
    try {
      await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async loadPending(): Promise<Array<ResumeAttempt & { confirmedAt?: number; quotaBlockedAt?: number }>> {
    const dir = this.dir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const attempts: Array<ResumeAttempt & { confirmedAt?: number; quotaBlockedAt?: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      try {
        const raw = await readFile(path.join(dir, name), "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!isStoredAttempt(parsed)) continue;
        const stored = parsed;
        attempts.push({
          ...toResumeAttempt(stored),
          ...(stored.confirmedAt !== undefined ? { confirmedAt: stored.confirmedAt } : {}),
          ...(stored.quotaBlockedAt !== undefined ? { quotaBlockedAt: stored.quotaBlockedAt } : {}),
        });
      } catch {
        // 损坏的 outbox 记录跳过（诊断由调用方负责）；不抛出阻塞整轮。
      }
    }
    return attempts;
  }

  /**
   * 幂等发送。崩溃恢复语义（三态确认，验收修复 A）：
   *   已确认 → 绝不重发（返回已确认结果）。
   *   未确认 → 先重放确认：CONFIRMED → 标确认、不重发；NOT_STARTED → 允许发送；
   *     UNKNOWN → 绝不调用 sender，返回 ok:false + confirmationUnknown（保留 outbox）。
   * 写 outbox 与发送之间的任何崩溃点，重启后都收敛到同一条记录。
   *
   * 技术失败（验收修复 B）：唯一真相源是 outbox record.failureCount；本方法在
   *   sender 技术失败时 +1（重复 tick 幂等：失败已落盘 → 直接返回，不再调用 sender）；
   *   failureCount >= MAX_ATTEMPT_FAILURES 时绝不调用 sender；quotaBlocked 不计。
   */
  async send(attempt: ResumeAttempt): Promise<SendOutcome> {
    // A recovered attempt must carry the original project cwd.  Never silently
    // substitute process.cwd() or an empty cwd because that can send to another
    // project after restart.
    if (typeof attempt.cwd !== "string" || attempt.cwd.trim().length === 0) {
      return { ok: false, error: "attempt cwd missing; not sending", detail: { cwdMissing: true } };
    }
    const existing = await this.read(attempt.id);
    if (existing === undefined && await this.recordExists(attempt.id)) {
      // A pre-cwd/corrupt persisted record is not evidence that the previous
      // send did not happen. Preserve it and fail closed rather than replacing
      // it with a guessed cwd and sending a duplicate to another project.
      return {
        ok: false,
        error: "attempt record invalid; confirmation unknown; not sending",
        detail: { confirmationUnknown: true, invalidRecord: true },
      };
    }
    if (existing !== undefined) {
      if (existing.confirmedAt !== undefined) {
        return { ok: true, confirmed: true, detail: { reused: true, confirmedAt: existing.confirmedAt } };
      }
      // 上一次发送可能已生效，且结果未知（崩溃恢复点 2：发送后、确认前崩溃）：
      // 记录特征 = 从未记录失败（fc=0）且从未被额度拒绝（无 quotaBlockedAt）。
      // 只有这种记录才重放三态确认——CONFIRMED → 标确认、绝不重发；NOT_STARTED → 补发；
      // UNKNOWN（异常/超时/无法查询）→ 绝不调用 sender，保留 outbox 待人工。
      // 已记录失败（fc>0）或额度拒绝过的记录不重放：其结果已知，直接按各自路径重试
      // （否则 confirmer 误报 CONFIRMED 会把真实的技术失败掩盖成“已生效”，违反修复 B）。
      if (existing.failureCount === 0 && existing.quotaBlockedAt === undefined) {
        const replay = await this.safeConfirm(toResumeAttempt(existing));
        if (replay.confirmed === true) {
          await this.confirm(attempt);
          return { ok: true, confirmed: true, detail: { reused: true, replayed: replay.reason } };
        }
        if (replay.state === "NOT_STARTED") {
          // 有可靠证据未生效 → 允许补发，仍复用同一 attempt id（落到下方发送路径）。
        } else {
          // UNKNOWN（异常/超时/无法查询）：绝不能调用 sender；保留 outbox+latch 待人工。
          return {
            ok: false,
            error: "confirmation unknown; not sending",
            detail: { confirmationUnknown: true, reason: replay.reason },
          };
        }
      }
      // 已达失败上限：绝不再调用 sender（修复 B 铁律）。
      if (existing.failureCount >= MAX_ATTEMPT_FAILURES) {
        return {
          ok: false,
          error: `attempt failed ${existing.failureCount} times; giving up: ${existing.lastError ?? "unknown error"}`,
          detail: { givingUp: true, failureCount: existing.failureCount },
        };
      }
    }

    // 发送前落盘（崩溃恢复点 1：发送前崩溃 → 无 confirmedAt，可重发）。
    // 磁盘记录是 failureCount 的唯一真相源（修复 B）：调用方传入的 attempt（重试
    // 时通常 failureCount=0）不得覆盖已累计的技术失败计数 / lastError / quotaBlockedAt，
    // 否则失败计数每轮都被重置为 0、永远到不了上限。新记录才用调用方初值。
    const stored: StoredAttempt =
      existing !== undefined
        ? { ...existing, createdAt: existing.createdAt }
        : toStoredAttempt(attempt);
    await this.write(stored);

    // On retry/recovery the durable attempt is authoritative, including cwd;
    // do not let a stale caller object redirect the sender.
    const sendAttempt = existing !== undefined ? toResumeAttempt(existing) : attempt;
    let outcome: SendOutcome;
    try {
      outcome = await this.sender.send(sendAttempt, { threadId: sendAttempt.threadId, cwd: sendAttempt.cwd });
    } catch (error) {
      // The sender may throw before returning a SendOutcome.  Convert that
      // single throw into exactly one durable failure increment; callers must
      // not call recordFailure again for this result.
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure(sendAttempt, message || "send failed");
      return { ok: false, error: message || "send failed", detail: { senderThrew: true } };
    }
    if (outcome.ok) {
      // 发送后、确认前崩溃（崩溃恢复点 2）：record 无 confirmedAt，重启后重放确认，不盲目重发。
      // 决策A：sender 自带可靠确认（生产 sender 等到同 thread 的 turn/completed 才置
      // confirmed:true）时，该证据即为确认本身——直接落盘 confirmedAt，
      // 绝不再用 fail-closed confirmer（恒 UNKNOWN）覆盖成“未确认”。
      const confirmed = outcome.confirmed === true ? { confirmed: true as const, state: "CONFIRMED" as const, reason: "sender turn/completed evidence" }
        : await this.safeConfirm(sendAttempt);
      if (confirmed.confirmed) {
        await this.confirm(sendAttempt);
        return { ...outcome, confirmed: true };
      }
      return { ...outcome, confirmed: false };
    }

    if (outcome.quotaBlocked === true) {
      await this.markQuotaBlocked(sendAttempt);
      return outcome;
    }
    if (outcome.writerBusy === true) {
      // 桌面端等写者占用（2026-09-06 线上）：暂时性 busy 与 quotaBlocked 同类，
      // 不计技术失败、不落失败标记；monitor 保持 RESUME_QUEUED 下轮重试。
      return outcome;
    }
    // sender 技术失败：只增 1（修复 B：failureCount 唯一真相源）。
    await this.recordFailure(sendAttempt, outcome.error ?? "send failed");
    return outcome;
  }

  /**
   * 确认器异常不冒泡：按 UNKNOWN 处理（保守：保留 outbox、绝不据此重发）。
   * 确认器抛错与返回 UNKNOWN 等价——重启恢复后仍会重放确认。
   * 返回值同时携带 state（三态原样）与 confirmed 布尔（仅区分 CONFIRMED 与否）。
   */
  private async safeConfirm(attempt: ResumeAttempt): Promise<{ state: ConfirmationState; confirmed: boolean; reason?: string }> {
    try {
      const result = await this.confirmer.confirm(attempt);
      return { state: result.state, confirmed: result.state === "CONFIRMED", reason: result.reason };
    } catch {
      return { state: "UNKNOWN", confirmed: false, reason: "confirmer threw; confirmation unknown" };
    }
  }

  async confirm(attempt: ResumeAttempt): Promise<{ alreadyConfirmed: boolean }> {
    const existing = await this.read(attempt.id);
    if (existing === undefined) {
      // 记录不存在（可能已被清除）：只落确认标记，幂等。
      await this.write({ ...toStoredAttempt(attempt), confirmedAt: this.clock.now() });
      return { alreadyConfirmed: false };
    }
    if (existing.confirmedAt !== undefined) {
      return { alreadyConfirmed: true };
    }
    await this.write({ ...existing, confirmedAt: this.clock.now() });
    return { alreadyConfirmed: false };
  }

  async markQuotaBlocked(attempt: ResumeAttempt): Promise<void> {
    const existing = await this.read(attempt.id);
    if (existing === undefined) {
      await this.write({ ...toStoredAttempt(attempt), quotaBlockedAt: this.clock.now() });
      return;
    }
    if (existing.quotaBlockedAt !== undefined) return;
    await this.write({ ...existing, quotaBlockedAt: this.clock.now() });
  }

  async recordFailure(attempt: ResumeAttempt, error: string): Promise<void> {
    const existing = await this.read(attempt.id);
    if (existing !== undefined && existing.confirmedAt !== undefined) {
      // 已确认的 attempt 绝不回滚成失败（崩溃点 3：确认后不得再计数）。
      return;
    }
    // 唯一真相源：existing.failureCount（磁盘上已累计的次数）。
    // sender 技术失败只增 1（修复 B）：任何 tick 传进来的 attempt.failureCount
    // 都可能是过时的（monitor 用 watch.resumeAttemptCount 构造），不得据此覆盖。
    const base = existing?.failureCount ?? attempt.failureCount;
    const stored: StoredAttempt = {
      ...(existing !== undefined ? existing : toStoredAttempt(attempt)),
      failureCount: base + 1,
      lastError: error,
      updatedAt: new Date(this.clock.now()).toISOString(),
    };
    await this.write(stored);
  }

  async remove(attempt: ResumeAttempt): Promise<void> {
    await rm(this.pathFor(attempt.id), { force: true });
  }
}

interface StoredAttempt {
  id: string;
  threadId: string;
  latchId: string;
  cwd: string;
  status: ResumeAttempt["status"];
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  confirmedAt?: number;
  quotaBlockedAt?: number;
}

function toStoredAttempt(attempt: ResumeAttempt): StoredAttempt {
  return {
    id: attempt.id,
    threadId: attempt.threadId,
    latchId: attempt.latchId,
    cwd: attempt.cwd,
    status: attempt.status,
    failureCount: attempt.failureCount,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    ...(attempt.lastError !== undefined ? { lastError: attempt.lastError } : {}),
  };
}

function toResumeAttempt(stored: StoredAttempt): ResumeAttempt {
  return {
    id: stored.id,
    threadId: stored.threadId,
    latchId: stored.latchId,
    cwd: stored.cwd,
    status: stored.status,
    failureCount: stored.failureCount,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...(stored.lastError !== undefined ? { lastError: stored.lastError } : {}),
  };
}

function isStoredAttempt(value: unknown): value is StoredAttempt {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredAttempt>;
  return (
    typeof candidate.id === "string" && candidate.id.length > 0 &&
    typeof candidate.threadId === "string" && candidate.threadId.length > 0 &&
    typeof candidate.latchId === "string" && candidate.latchId.length > 0 &&
    typeof candidate.cwd === "string" && candidate.cwd.trim().length > 0 &&
    (candidate.status === "QUEUED" || candidate.status === "SENDING" || candidate.status === "CONFIRMED" || candidate.status === "FAILED") &&
    typeof candidate.failureCount === "number" && Number.isInteger(candidate.failureCount) && candidate.failureCount >= 0 &&
    typeof candidate.createdAt === "string" && candidate.createdAt.length > 0 &&
    typeof candidate.updatedAt === "string" && candidate.updatedAt.length > 0 &&
    (candidate.lastError === undefined || typeof candidate.lastError === "string") &&
    (candidate.confirmedAt === undefined || typeof candidate.confirmedAt === "number") &&
    (candidate.quotaBlockedAt === undefined || typeof candidate.quotaBlockedAt === "number")
  );
}

export { resumeAttemptId };
