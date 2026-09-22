import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { locksDir } from "./paths.js";

/**
 * threadId 级互斥租约（AUTO_RESUME_V2_DESIGN.md §6.2；执行计划 §7 T2）。
 *
 * 语义：
 * - 锁按 threadId 互斥，不同 threadId 完全独立；绝不使用全局锁。
 * - 锁内容含 ownerToken（进程级随机标识，跨重启保持同身份）、PID、createdAt。
 * - 持锁操作（创建 attempt / 写 activeAttemptId / 写 outbox / 发送）必须整体在
 *   withThreadLease 临界区内完成；临界区外的任何发送都违反合同。
 * - 回收陈旧锁：仅当 leaseUntil 已过期 且 锁内 PID 不再存活（进程不存在）时才回收；
 *   PID 仍存活时即使过期也绝不回收——那是另一个活进程正在持锁。
 * - 进程崩溃不主动释放锁（无法保证 finally 执行）；同一 ownerToken 重启后视为
 *   同一持锁者，可自行覆盖自己的锁（见 takeThreadLease）。
 * - 探测 PID 存活使用 pid 不存在即进程不存在的判定（Windows 下 pid 重用窗口极小，
 *   且锁同时要求 leaseUntil 过期，双重条件才回收）。
 */

/** 陈旧锁回收的持有上限：必须同时满足“leaseUntil 已过期”与“PID 不存活”。 */
export const THREAD_LEASE_TTL_MS = 10 * 60_000;

/** 持锁者身份：ownerToken 在进程生命周期内固定，重启后重新生成。 */
export interface ThreadLease {
  threadId: string;
  ownerToken: string;
  pid: number;
  createdAt: string;
  leaseUntil: number;
}

export interface ThreadLeaseHandle {
  lease: ThreadLease;
  release(): Promise<void>;
}

export interface PidAliveCheck {
  (pid: number): boolean;
}

/** 默认 PID 存活探测：进程不存在即认为不存活（不尝试信号，避免误伤其他进程）。 */
export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ThreadLeaseOptions {
  /** 锁有效期；默认 10 分钟。 */
  ttlMs?: number;
  /** 当前时间（epoch ms）；可注入 fake clock。 */
  now?: () => number;
  /** 覆盖 pid 存活探测（测试用）。 */
  isPidAlive?: PidAliveCheck;
}

/**
 * 在 threadId 临界区内执行 fn。
 * - 无锁或锁已过期且 PID 不存活 → 写入新锁（原子 create），返回 fn 结果。
 * - 锁被其他活进程持有 → 返回 undefined，绝不并发执行。
 * - 调用方是同一 ownerToken → 覆盖自己的锁并执行（崩溃后同进程重启路径）。
 * - 返回 undefined 一律表示“本轮未取得锁”，调用方不得发送。
 */
export async function withThreadLease<T>(
  stateDir: string,
  threadId: string,
  ownerToken: string,
  fn: () => Promise<T>,
  options: ThreadLeaseOptions = {}
): Promise<T | undefined> {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? THREAD_LEASE_TTL_MS;
  const isPidAlive = options.isPidAlive ?? defaultPidAlive;

  const lease: ThreadLease = {
    threadId,
    ownerToken,
    pid: process.pid,
    createdAt: new Date(now()).toISOString(),
    leaseUntil: now() + ttlMs,
  };
  const lockDir = locksDir(stateDir);
  await mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${safeLockName(threadId)}.lease.json`);

  const created = await createLeaseFile(lockPath, lease);
  if (!created) {
    const existing = await readLeaseFile(lockPath);
    if (existing !== undefined) {
      if (existing.ownerToken === ownerToken) {
        // 同身份（崩溃重启）：覆盖自己的锁，继续持锁。
        await writeLeaseFile(lockPath, lease);
      } else if (existing.leaseUntil <= now() && !isPidAlive(existing.pid)) {
        // 陈旧锁：PID 不存活且租约过期才回收。
        const takenOver = await replaceStaleLease(lockPath, lease, now, isPidAlive);
        if (!takenOver) return undefined;
      } else {
        return undefined; // 其他活进程持锁：本轮不执行。
      }
    } else {
      // 锁文件消失（写一半/外部清理）：原子重试一次。
      const retried = await createLeaseFile(lockPath, lease);
      if (!retried) return undefined;
    }
  }

  try {
    return await fn();
  } finally {
    await releaseLeaseFile(lockPath, ownerToken);
  }
}

/**
 * 直接取得 threadId 锁（返回句柄；仅用于测试与诊断）。
 * 语义与 withThreadLease 一致；调用方必须自行 release()。
 */
export async function takeThreadLease(
  stateDir: string,
  threadId: string,
  ownerToken: string,
  options: ThreadLeaseOptions = {}
): Promise<ThreadLeaseHandle | undefined> {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? THREAD_LEASE_TTL_MS;
  const isPidAlive = options.isPidAlive ?? defaultPidAlive;

  const lease: ThreadLease = {
    threadId,
    ownerToken,
    pid: process.pid,
    createdAt: new Date(now()).toISOString(),
    leaseUntil: now() + ttlMs,
  };
  const lockDir = locksDir(stateDir);
  await mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, `${safeLockName(threadId)}.lease.json`);

  const created = await createLeaseFile(lockPath, lease);
  if (!created) {
    const existing = await readLeaseFile(lockPath);
    if (existing !== undefined) {
      if (existing.ownerToken === ownerToken) {
        await writeLeaseFile(lockPath, lease);
      } else if (existing.leaseUntil <= now() && !isPidAlive(existing.pid)) {
        const takenOver = await replaceStaleLease(lockPath, lease, now, isPidAlive);
        if (!takenOver) return undefined;
      } else {
        return undefined;
      }
    } else {
      const retried = await createLeaseFile(lockPath, lease);
      if (!retried) return undefined;
    }
  }

  return {
    lease,
    release: () => releaseLeaseFile(lockPath, ownerToken),
  };
}

/** 安全文件名：仅保留 [A-Za-z0-9._-]，其余字符按 UTF-8 百分号编码（watches 与 locks 共用）。 */
export function safeLockName(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, (ch) => {
    return [...Buffer.from(ch, "utf8")].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
  });
}

async function createLeaseFile(lockPath: string, lease: ThreadLease): Promise<boolean> {
  try {
    await writeFile(lockPath, JSON.stringify(lease, null, 2), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function writeLeaseFile(lockPath: string, lease: ThreadLease): Promise<void> {
  await writeFile(lockPath, JSON.stringify(lease, null, 2), { mode: 0o600 });
}

/**
 * Serialize stale-lock takeover.  The normal acquisition path is protected by
 * the atomic wx create; only the read-then-replace stale path needs a second
 * claim file to prevent two different owner tokens from both entering.
 */
async function replaceStaleLease(
  lockPath: string,
  lease: ThreadLease,
  now: () => number,
  isPidAlive: PidAliveCheck
): Promise<boolean> {
  const claimPath = `${lockPath}.takeover`;
  const claimed = await acquireTakeoverClaim(claimPath, now, isPidAlive);
  if (!claimed) return false;
  try {
    const current = await readLeaseFile(lockPath);
    if (current === undefined) return false;
    if (current.ownerToken === lease.ownerToken) {
      await writeLeaseFile(lockPath, lease);
      return true;
    }
    if (current.leaseUntil > now() || isPidAlive(current.pid)) return false;
    await writeLeaseFile(lockPath, lease);
    return true;
  } finally {
    if (claimed) await rm(claimPath, { force: true });
  }
}

async function acquireTakeoverClaim(claimPath: string, now: () => number, isPidAlive: PidAliveCheck): Promise<boolean> {
  try {
    await writeFile(claimPath, JSON.stringify({ pid: process.pid, createdAt: now() }), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  // A crashed stale-lock reaper may leave the short-lived claim behind. It is
  // reclaimable only after the claim TTL and only when its PID is gone, matching
  // the lease's fail-closed PID rule.
  try {
    const parsed = JSON.parse(await readFile(claimPath, "utf8")) as { pid?: unknown; createdAt?: unknown };
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "number") return false;
    if (parsed.createdAt + THREAD_LEASE_TTL_MS > now() || isPidAlive(parsed.pid)) return false;
    await rm(claimPath, { force: true });
    await writeFile(claimPath, JSON.stringify({ pid: process.pid, createdAt: now() }), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    return false;
  }
}

async function readLeaseFile(lockPath: string): Promise<ThreadLease | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ThreadLease>;
    if (
      typeof parsed.threadId !== "string" ||
      typeof parsed.ownerToken !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.leaseUntil !== "number"
    ) {
      return undefined;
    }
    return parsed as ThreadLease;
  } catch {
    return undefined;
  }
}

/** 只删除属于自己的锁；其他持锁者接管期间绝不误删。 */
async function releaseLeaseFile(lockPath: string, ownerToken: string): Promise<void> {
  try {
    const existing = await readLeaseFile(lockPath);
    if (existing === undefined) return;
    if (existing.ownerToken !== ownerToken) return;
    await rm(lockPath, { force: true });
  } catch {
    // 删除失败不阻塞临界区返回。
  }
}
