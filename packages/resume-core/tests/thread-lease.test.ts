import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { withThreadLease, takeThreadLease, defaultPidAlive, type ThreadLeaseOptions } from "../src/thread-lease.js";

/**
 * T2 thread lease 测试（AUTO_RESUME_V2_DESIGN.md §6.2；执行计划 §7 T2）。
 * 覆盖：同 thread 互斥、不同 thread 独立、ownerToken 同身份覆盖、
 * 陈旧锁只在 lease 过期且 PID 不存活时回收、崩溃后同进程重启可继续。
 */

const T0 = 1_800_000_000_000;
const TTL = 10 * 60_000;
const now = () => T0;
/** 注入测试 clock：ThreadLeaseOptions.now 是函数。 */
const opts = (o: Partial<ThreadLeaseOptions> = {}): ThreadLeaseOptions => ({ now, ...o });

let stateDirs: string[] = [];
function tempStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-lease-"));
  stateDirs.push(dir);
  return dir;
}

beforeEach(() => {
  stateDirs = [];
});

afterAll(() => {
  for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
});

describe("thread-lease — 互斥与回收", () => {
  it("同 thread：另一活进程持锁时拿不到锁（互斥）", async () => {
    const stateDir = tempStateDir();
    const other = await takeThreadLease(stateDir, "t1", "owner-a", opts({ isPidAlive: () => true }));
    expect(other).toBeDefined();

    const mine = await takeThreadLease(stateDir, "t1", "owner-b", opts({ isPidAlive: () => true }));
    expect(mine).toBeUndefined(); // 不并发。
    await other!.release();
  });

  it("不同 thread：锁相互独立，互不阻塞", async () => {
    const stateDir = tempStateDir();
    const a = await takeThreadLease(stateDir, "t1", "owner-a", opts());
    const b = await takeThreadLease(stateDir, "t2", "owner-b", opts());
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    await a!.release();
    await b!.release();
  });

  it("withThreadLease：临界区执行并自动释放；未取得锁返回 undefined", async () => {
    const stateDir = tempStateDir();
    const result = await withThreadLease(stateDir, "t1", "owner-a", async () => 42, opts());
    expect(result).toBe(42);

    // 释放后其他人可拿。
    const other = await takeThreadLease(stateDir, "t1", "owner-b", opts());
    expect(other).toBeDefined();
    await other!.release();
  });

  it("陈旧锁回收：仅当 lease 过期 且 PID 不存活时才回收", async () => {
    const stateDir = tempStateDir();

    // 场景 1：lease 未过期、PID 已死 → 不回收（租约内保护）。
    await takeThreadLease(stateDir, "t1", "dead-owner", opts({ isPidAlive: () => false }));
    let got = await takeThreadLease(stateDir, "t1", "owner-b", opts({ isPidAlive: () => false }));
    expect(got).toBeUndefined();

    // 场景 2：lease 过期、PID 仍存活 → 不回收（另一个活进程）。
    const later = { now: () => T0 + TTL + 1000 };
    got = await takeThreadLease(stateDir, "t1", "owner-c", opts({ now: later.now, isPidAlive: () => true }));
    expect(got).toBeUndefined();

    // 场景 3：lease 过期 且 PID 不存活 → 回收。
    got = await takeThreadLease(stateDir, "t1", "owner-d", opts({ now: later.now, isPidAlive: () => false }));
    expect(got).toBeDefined();
    await got!.release();
  });

  it("同 ownerToken（崩溃后同进程重启）→ 覆盖自己的锁继续持锁", async () => {
    const stateDir = tempStateDir();
    const first = await takeThreadLease(stateDir, "t1", "owner-same", opts());
    expect(first).toBeDefined();
    // 模拟进程崩溃：不 release。同一 ownerToken 重启后覆盖自己的锁。
    const second = await takeThreadLease(stateDir, "t1", "owner-same", opts());
    expect(second).toBeDefined();
    expect(second!.lease.ownerToken).toBe("owner-same");
    await second!.release();
  });

  it("defaultPidAlive：本进程 PID 存活探测正确", async () => {
    expect(defaultPidAlive(process.pid)).toBe(true);
    // 已退出子进程的 PID 探测为“不存活”（Windows 下 pid 0 是 System Idle，恒存在）。
    const child = spawn(process.execPath, ["-e", ""]);
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await exited;
    expect(defaultPidAlive(child.pid ?? -1)).toBe(false);
  });

  it("锁文件包含 ownerToken/PID/createdAt/leaseUntil，删除只删自己的锁", async () => {
    const stateDir = tempStateDir();
    const handle = await takeThreadLease(stateDir, "t1", "owner-a", opts());
    expect(handle).toBeDefined();
    const lockDir = path.join(stateDir, "locks");
    const names = (await import("node:fs")).readdirSync(lockDir);
    expect(names).toHaveLength(1);
    const raw = readFileSync(path.join(lockDir, names[0]), "utf8");
    const parsed = JSON.parse(raw) as { ownerToken: string; pid: number; createdAt: string; leaseUntil: number };
    expect(parsed.ownerToken).toBe("owner-a");
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.createdAt).toBe(new Date(T0).toISOString());
    expect(parsed.leaseUntil).toBe(T0 + TTL);

    // 锁被他人接管后，原 owner 的 release 不得删除新锁。
    const later = { now: () => T0 + TTL + 1000 };
    const next = await takeThreadLease(stateDir, "t1", "owner-b", opts({ now: later.now, isPidAlive: () => false }));
    expect(next).toBeDefined();
    await handle!.release(); // 原 owner release：不删新锁。
    expect(existsSync(path.join(lockDir, names[0]))).toBe(true);
    await next!.release();
    expect(existsSync(path.join(lockDir, names[0]))).toBe(false);
  });
});
