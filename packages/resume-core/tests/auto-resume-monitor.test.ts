import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWatchStore } from "../src/auto-resume-store.js";
import { createMonitor, applyDecisionAtomically, clearWatchArtifacts, newCycleId } from "../src/auto-resume-monitor.js";
import { createAttemptOutbox, resumeAttemptId } from "../src/resume-attempt.js";
import { takeThreadLease } from "../src/thread-lease.js";
import type { AutoResumeWatch, DetectionSnapshot } from "../src/auto-resume-types.js";

/**
 * T2 monitor 测试（AUTO_RESUME_V2_DESIGN.md §6/§7；执行计划 §7 T2）。
 * 覆盖：一轮一次 quotaReader（cycleId 共享）、逐会话失败不阻塞、quota 失败 fail-closed
 * 不失明（本轮 UNKNOWN：不迁移、不发送，但仍记录 lastObservation）、
 * 原子迁移（observation/arming/latch/activeAttemptId 同一次保存）、clear-latch 双清、
 * 同轮最多并发 2、thread lease 互斥、AR-12/13/15/17/18/20、两调度器/重复 tick/崩溃。
 *
 * 时间一律注入 fake clock；stateDir 一律用临时目录；绝不接触真实 LOCALAPPDATA。
 */

const T0 = 1_800_000_000_000;
const STEP_MS = 180_000;

function makeWatch(overrides: Partial<AutoResumeWatch> = {}): AutoResumeWatch {
  return {
    schemaVersion: 2,
    threadId: "thread-1",
    cwd: "C:\\work\\demo",
    enabled: true,
    phase: "MONITORING",
    resumeAttemptCount: 0,
    createdAt: new Date(T0 - 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

function latchedWatch(overrides: Partial<AutoResumeWatch> = {}): AutoResumeWatch {
  return makeWatch({
    phase: "WAITING_FOR_5H_QUOTA",
    armedByDetection: { cycleId: "cycle-1", detectedAt: new Date(T0).toISOString(), validUntil: T0 + 420_000 },
    interruptionLatch: {
      id: "cycle-2:thread-1",
      detectedAt: new Date(T0 + STEP_MS).toISOString(),
      evidenceCycleId: "cycle-2",
      previousRunningCycleId: "cycle-1",
    },
    ...overrides,
  });
}

const clock = { now: () => T0 };

/**
 * latchedWatch 默认会话标签用 STOPPED（AR-19 语义：已锁存 + 额度恢复 + 会话可信结束
 * → 恰好 1 次 resume）。测试中如需 COMPLETED 可覆盖 sessionState。
 */
let stateDirs: string[] = [];
function tempStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-monitor-"));
  stateDirs.push(dir);
  return dir;
}

beforeEach(() => {
  stateDirs = [];
});

afterAll(() => {
  for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
});

describe("auto-resume-monitor — 轮次语义", () => {
  it("一轮只调用一次 quotaReader；所有 watch 共享同一 cycleId", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({ threadId: "t1" }));
    await store.upsert(makeWatch({ threadId: "t2" }));

    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });
    const sessionReader = vi.fn().mockResolvedValue("RUNNING" as const);
    const cycleId = newCycleId();

    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store });
    const report = await monitor.detect(cycleId);

    expect(quotaReader).toHaveBeenCalledTimes(1);
    expect(report.cycleId).toBe(cycleId);
    expect(report.watchOutcomes).toHaveLength(2);
    for (const o of report.watchOutcomes) {
      expect(o.decision.nextPhase).toBe("MONITORING");
      expect(o.queued).toBe(false);
    }
    // 共享快照：两个 watch 的 observation 使用同一 cycleId。
    const [w1, w2] = await store.list();
    expect(w1.lastObservation!.cycleId).toBe(cycleId);
    expect(w2.lastObservation!.cycleId).toBe(cycleId);
  });

  it("AR-18: 一个会话读取失败、另一个正常 → 正常会话完成本轮决策", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({ threadId: "t1" }));
    await store.upsert(latchedWatch({ threadId: "t2" }));

    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });
    const sessionReader = vi.fn().mockImplementation(async (threadId: string) => {
      if (threadId === "t1") throw new Error("db locked");
      return "STOPPED" as const;
    });
    const outbox = createAttemptOutbox({ stateDir, sender: { async send() { return { ok: true }; } } });
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    const report = await monitor.detect();

    const failed = report.watchOutcomes.find((o) => o.threadId === "t1")!;
    expect(failed.skipped).toBe(true);
    expect(failed.error).toContain("db locked");
    const t1 = await store.load("t1");
    expect(t1!.lastError).toContain("db locked");
    // 失败会话只记诊断 observation，不迁移。
    expect(t1!.phase).toBe("MONITORING");
    expect(t1!.interruptionLatch).toBeUndefined();

    const ok = report.watchOutcomes.find((o) => o.threadId === "t2")!;
    expect(ok.queued).toBe(true); // t2 锁存 + COMPLETED + POSITIVE → 正常入队。
    const t2 = await store.load("t2");
    expect(t2!.phase).toBe("RESUME_QUEUED");
    expect(t2!.activeAttemptId).toBe(resumeAttemptId("t2", "cycle-2:thread-1"));
  });

  it("quota 读取失败 → 本轮 UNKNOWN：不迁移、不发送，但仍记录 lastObservation（fail-closed 不失明）", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({ threadId: "t1", armedByDetection: { cycleId: "cycle-1", detectedAt: new Date(T0).toISOString(), validUntil: T0 + 420_000 } }));

    const quotaReader = vi.fn().mockRejectedValue(new Error("rate limit API down"));
    const sessionReader = vi.fn().mockResolvedValue("COMPLETED" as const);
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store });

    const report = await monitor.detect();
    expect(report.quotaOk).toBe(false);
    expect(report.quotaState).toBe("UNKNOWN");
    const outcome = report.watchOutcomes[0];
    // 本轮只观察：不 skipped（observation 已记录）、无动作。
    expect(outcome.skipped).toBe(false);
    expect(outcome.error).toContain("quota read failed");
    expect(outcome.error).toContain("rate limit API down");
    expect(outcome.nextPhase).toBe("MONITORING");
    const t1 = await store.load("t1");
    expect(t1!.interruptionLatch).toBeUndefined();
    expect(t1!.enabled).toBe(true);
    expect(t1!.phase).toBe("MONITORING");
    expect(t1!.activeAttemptId).toBeUndefined();
    // 诊断 observation 已持久化（fail-closed 但不失明）。
    expect(t1!.lastObservation).toBeDefined();
    expect(t1!.lastObservation!.fiveHourQuota).toBe("UNKNOWN");
    expect(t1!.lastObservation!.sessionState).toBe("COMPLETED");
  });

  it("F4: quota reader 抛错 + RUNNING 会话 → lastObservation 记录 UNKNOWN，0 send，enabled 保持", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({ threadId: "t1" }));

    const quotaReader = vi.fn().mockRejectedValue(new Error("rate limit API down"));
    const sessionReader = vi.fn().mockResolvedValue("RUNNING" as const);
    let sendCalls = 0;
    const outbox = createAttemptOutbox({ stateDir, sender: { async send() { sendCalls++; return { ok: true }; } }, clock });
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    const report = await monitor.detect();
    expect(report.quotaOk).toBe(false);
    expect(report.quotaState).toBe("UNKNOWN");
    expect(report.resumedCount).toBe(0);
    expect(sendCalls).toBe(0);
    const outcome = report.watchOutcomes[0];
    expect(outcome.skipped).toBe(false);
    expect(outcome.error).toContain("quota read failed");

    const t1 = await store.load("t1");
    expect(t1!.lastObservation).toBeDefined();
    expect(t1!.lastObservation!.fiveHourQuota).toBe("UNKNOWN");
    expect(t1!.lastObservation!.sessionState).toBe("RUNNING");
    expect(t1!.lastObservation!.detectedAt).toBe(new Date(T0).toISOString());
    expect(t1!.enabled).toBe(true); // enabled 不被误取消。
    expect(t1!.phase).toBe("MONITORING");
    expect(t1!.interruptionLatch).toBeUndefined();
    expect(t1!.activeAttemptId).toBeUndefined();
  });

  it("F4: quota reader 抛错 + COMPLETED 会话 → lastObservation 记录 UNKNOWN，不 disable，0 send", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({ threadId: "t1" }));

    const quotaReader = vi.fn().mockRejectedValue(new Error("rate limit API down"));
    const sessionReader = vi.fn().mockResolvedValue("COMPLETED" as const);
    let sendCalls = 0;
    const outbox = createAttemptOutbox({ stateDir, sender: { async send() { sendCalls++; return { ok: true }; } }, clock });
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    const report = await monitor.detect();
    expect(report.quotaOk).toBe(false);
    expect(report.quotaState).toBe("UNKNOWN");
    expect(report.resumedCount).toBe(0);
    expect(sendCalls).toBe(0);
    const outcome = report.watchOutcomes[0];
    expect(outcome.skipped).toBe(false);
    expect(outcome.error).toContain("quota read failed");

    const t1 = await store.load("t1");
    expect(t1!.lastObservation).toBeDefined();
    expect(t1!.lastObservation!.fiveHourQuota).toBe("UNKNOWN");
    expect(t1!.lastObservation!.sessionState).toBe("COMPLETED");
    // UNKNOWN 额度下 COMPLETED 不得 disable（无证据额度已恢复）。
    expect(t1!.enabled).toBe(true);
    expect(t1!.phase).toBe("MONITORING");
    expect(t1!.activeAttemptId).toBeUndefined();
  });
});

describe("auto-resume-monitor — 原子迁移与幂等", () => {
  it("观察+arming+latch 同一次保存：quota ZERO 且 arming 有效 → 一次 upsert 同时落 observation 与 latch", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const watch = makeWatch({ armedByDetection: { cycleId: "cycle-1", detectedAt: new Date(T0).toISOString(), validUntil: T0 + 420_000 } });
    await store.upsert(watch);

    const snapshot: DetectionSnapshot = {
      cycleId: "cycle-2",
      detectedAt: new Date(T0 + STEP_MS).toISOString(),
      sessionState: "COMPLETED",
      fiveHourQuota: "ZERO",
      trusted: true,
    };
    const decision = (await import("../src/auto-resume-reducer.js")).autoResumeReducer(watch, snapshot, T0 + STEP_MS);
    const next = applyDecisionAtomically(watch, decision, snapshot, T0 + STEP_MS);
    await store.upsert(next);

    const saved = await store.load("thread-1");
    expect(saved!.lastObservation!.cycleId).toBe("cycle-2");
    expect(saved!.lastObservation!.fiveHourQuota).toBe("ZERO");
    expect(saved!.interruptionLatch!.id).toBe("cycle-2:thread-1");
    expect(saved!.phase).toBe("WAITING_FOR_5H_QUOTA");
    expect(saved!.resumeAttemptCount).toBe(0);
  });

  it("clear-latch 同时清除 interruptionLatch 与 activeAttemptId（AR-07 语义）", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const watch = latchedWatch({ activeAttemptId: "a1", phase: "RESUME_QUEUED" });
    await store.upsert(watch);

    const snapshot: DetectionSnapshot = {
      cycleId: "cycle-3",
      detectedAt: new Date(T0 + 2 * STEP_MS).toISOString(),
      sessionState: "RUNNING",
      fiveHourQuota: "POSITIVE",
      trusted: true,
    };
    const decision = (await import("../src/auto-resume-reducer.js")).autoResumeReducer(watch, snapshot, T0 + 2 * STEP_MS);
    const next = applyDecisionAtomically(watch, decision, snapshot, T0 + 2 * STEP_MS);
    await store.upsert(next);

    const saved = await store.load("thread-1");
    expect(saved!.interruptionLatch).toBeUndefined();
    expect(saved!.activeAttemptId).toBeUndefined();
    expect(saved!.phase).toBe("MONITORING");
  });

  it("重复 tick/双调度器：同一 latch 只 queue 一次，activeAttemptId 防重（AR-13）", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const attemptIds: string[] = [];
    const sender = {
      async send(attempt: { id: string }) {
        attemptIds.push(attempt.id);
        return { ok: true };
      },
    };
    // 确认器模拟“发送已生效”：第二轮复用同一 attempt，不得重发（AR-13 防重）。
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: { async confirm() { return { state: "CONFIRMED" as const, reason: "new turn id seen" }; } } });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });

    await store.upsert(latchedWatch({ threadId: "t1" }));
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    // 两个调度器同时 tick（顺序执行，模拟双进程/双 tick）：第二轮必须复用同一 attempt。
    await monitor.detect();
    await monitor.detect();

    expect(attemptIds).toHaveLength(1);
    expect(attemptIds[0]).toBe(resumeAttemptId("t1", "cycle-2:thread-1"));
  });

  it("AR-17: 用户在等待期间取消勾选（disable）→ 永不自动续跑，latch 清除", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const outbox = createAttemptOutbox({ stateDir });
    const sessionReader = vi.fn().mockResolvedValue("COMPLETED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });

    await store.upsert(latchedWatch({ threadId: "t1" }));
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    // 用户取消：删除 watch（用户手动取消是唯一可无条件清掉 watch/latch 的操作）。
    await store.disable("t1");
    const report = await monitor.detect();

    expect(report.watchOutcomes).toHaveLength(0);
    expect(report.resumedCount).toBe(0);
    expect(await store.load("t1")).toBeUndefined();
  });

  it("技术失败计数与 NEEDS_ATTENTION：失败 2 次后停止自动发送（failureCount 唯一真相源）", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    let calls = 0;
    const sender = {
      async send() {
        calls++;
        return { ok: false, error: "app-server exited" };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: { async confirm() { return { state: "CONFIRMED" as const }; } } });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });

    await store.upsert(latchedWatch({ threadId: "t1" }));
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    const r1 = await monitor.detect();
    expect(r1.resumedCount).toBe(0);
    const t1after1 = await store.load("t1");
    expect(t1after1!.phase).toBe("RESUME_QUEUED");
    expect(t1after1!.resumeAttemptCount).toBe(1); // 与 outbox failureCount 一致（真相源）。

    await monitor.detect();
    const t1after2 = await store.load("t1");
    expect(t1after2!.phase).toBe("NEEDS_ATTENTION");
    expect(t1after2!.resumeAttemptCount).toBe(2);
    expect(t1after2!.lastError).toContain("app-server exited");
    expect(calls).toBe(2);

    // NEEDS_ATTENTION 后：不再发送（保持勾选与 latch，停止自动发送）。
    const r3 = await monitor.detect();
    expect(r3.resumedCount).toBe(0);
    expect(calls).toBe(2);
  });

  it("修复 B-3: 连续技术失败 2 次后第 3 轮 sender 0 次、NEEDS_ATTENTION 保持", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    let calls = 0;
    const sender = {
      async send() {
        calls++;
        return { ok: false, error: "app-server exited" };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: { async confirm() { return { state: "CONFIRMED" as const }; } } });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });

    await store.upsert(latchedWatch({ threadId: "t1" }));
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    await monitor.detect(); // 第 1 次技术失败
    await monitor.detect(); // 第 2 次技术失败
    const t1 = await store.load("t1");
    expect(t1!.phase).toBe("NEEDS_ATTENTION");
    expect(calls).toBe(2);

    // 第 3 轮：outbox failureCount>=2 拦截 → sender 0 次；NEEDS_ATTENTION 保持；latch 保留。
    const r3 = await monitor.detect();
    expect(r3.resumedCount).toBe(0);
    expect(calls).toBe(2);
    const t1after = await store.load("t1");
    expect(t1after!.phase).toBe("NEEDS_ATTENTION");
    expect(t1after!.interruptionLatch).toBeDefined();
    expect(t1after!.lastError).toContain("giving up");
  });

  it("明确额度失败 → 回到 WAITING_FOR_5H_QUOTA，不计技术失败、保留 latch", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const sender = {
      async send() {
        return { ok: false, quotaBlocked: true as const, error: "5h usage limit reached" };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });

    await store.upsert(latchedWatch({ threadId: "t1" }));
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    const report = await monitor.detect();
    const t1 = await store.load("t1");
    expect(t1!.phase).toBe("WAITING_FOR_5H_QUOTA");
    expect(t1!.interruptionLatch).toBeDefined();
    expect(t1!.resumeAttemptCount).toBe(1); // 不计技术失败（仍计入 attempt 历史，但相位回等待）。
    expect(report.resumedCount).toBe(0);
  });

  it("sender 抛异常由 outbox 原子计数；第 2 次后 NEEDS_ATTENTION 且第 3 轮不再发送", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    let calls = 0;
    const outbox = createAttemptOutbox({
      stateDir,
      sender: { async send() { calls++; throw new Error("sender crashed"); } },
      clock,
    });
    await store.upsert(latchedWatch({ threadId: "throwing-sender" }));
    const monitor = createMonitor({
      stateDir,
      store,
      outbox,
      quotaReader: vi.fn().mockResolvedValue({ state: "POSITIVE" as const }),
      sessionReader: vi.fn().mockResolvedValue("STOPPED" as const),
      clock,
      ownerToken: "throw-owner",
    });

    await monitor.detect("throw-1");
    await monitor.detect("throw-2");
    await monitor.detect("throw-3");
    expect(calls).toBe(2);
    const saved = await store.load("throwing-sender");
    expect(saved!.phase).toBe("NEEDS_ATTENTION");
    expect((await outbox.loadPending()).find((attempt) => attempt.threadId === "throwing-sender")!.failureCount).toBe(2);
  });
});

describe("auto-resume-monitor — 并发上限与 thread lease", () => {
  it("同轮符合条件的 attempt 最多并发 2 个；第 3 个留到下一轮", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const sentThreads: string[] = [];
    const sender = {
      async send(attempt: { threadId: string }) {
        sentThreads.push(attempt.threadId);
        return { ok: true };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: { async confirm() { return { state: "CONFIRMED" as const }; } } });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });

    for (const threadId of ["t1", "t2", "t3"]) {
      await store.upsert(latchedWatch({ threadId }));
    }
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    const r1 = await monitor.detect();
    expect(sentThreads).toHaveLength(2); // 最多并发 2
    expect(r1.skippedOverlapCount).toBe(1); // 第 3 个 defer

    const r2 = await monitor.detect();
    expect(sentThreads).toHaveLength(3); // 下一轮补上（不补跑，是新的一轮）。
    expect(r2.skippedOverlapCount).toBe(0);
    expect(new Set(sentThreads).size).toBe(3);
  });

  it("thread lease 互斥：另一持锁者存活时，同 thread 不发送（AR-13 双调度器）", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const sentThreads: string[] = [];
    const sender = {
      async send(attempt: { threadId: string }) {
        sentThreads.push(attempt.threadId);
        return { ok: true };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });

    await store.upsert(latchedWatch({ threadId: "t1" }));

    // 模拟另一个调度器进程已持有 t1 的锁（leaseUntil 未过期、PID 存活）。
    const other = await takeThreadLease(stateDir, "t1", "owner-other", { now: clock.now });
    expect(other).toBeDefined();

    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });
    const report = await monitor.detect();

    expect(sentThreads).toHaveLength(0);
    const t1 = await store.load("t1");
    expect(t1!.phase).toBe("WAITING_FOR_5H_QUOTA"); // 持锁者存在时，决策也不越过 lease。
    const outcome = report.watchOutcomes.find((o) => o.threadId === "t1")!;
    expect(outcome.skipped).toBe(true);
    await other!.release();
  });

  it("不同 thread 的锁相互独立（并行发送不互相阻塞）", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const sentThreads: string[] = [];
    const sender = {
      async send(attempt: { threadId: string }) {
        sentThreads.push(attempt.threadId);
        return { ok: true };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });

    await store.upsert(latchedWatch({ threadId: "t1" }));
    await store.upsert(latchedWatch({ threadId: "t2" }));

    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });
    const report = await monitor.detect();
    expect(sentThreads.sort()).toEqual(["t1", "t2"]);
    expect(report.resumedCount).toBe(2);
  });
});

describe("auto-resume-monitor — AR-12/15/20 崩溃恢复", () => {
  it("AR-12: latch 落盘 + 重启（新 store 实例）→ 额度恢复后恰好 1 次 resume", async () => {
    const stateDir = tempStateDir();
    // 第一次“进程”：创建 latch 并落盘。
    const store1 = createWatchStore(stateDir);
    const watch = latchedWatch({ threadId: "t1" });
    await store1.upsert(watch);
    expect(await store1.load("t1")).toBeDefined();

    // “重启”：全新 store/monitor/outbox 实例，磁盘状态唯一真相。
    const sentThreads: string[] = [];
    const sender = {
      async send(attempt: { threadId: string }) {
        sentThreads.push(attempt.threadId);
        return { ok: true };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: { async confirm() { return { state: "CONFIRMED" as const }; } } });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });
    const store2 = createWatchStore(stateDir);
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-2", store: store2, outbox });

    await monitor.detect();
    expect(sentThreads).toEqual(["t1"]);

    // 重复 tick：不再发。
    await monitor.detect();
    expect(sentThreads).toEqual(["t1"]);
  });

  it("AR-15: 发送成功但确认前崩溃 → 重启后重放确认，不盲目重发", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    // 发送成功（sender ok）但确认器不可用（nullConfirmer 恒 UNKNOWN）→ 模拟确认前崩溃。
    const outbox = createAttemptOutbox({ stateDir, sender: { async send() { return { ok: true }; } } });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });
    let confirmCalls = 0;
    const confirmer = { async confirm() { confirmCalls++; return { state: "CONFIRMED" as const, reason: "new turn id seen" }; } };

    await store.upsert(latchedWatch({ threadId: "t1" }));
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    // 第一次：发送成功（sender ok）但确认器不可用 → 模拟确认前崩溃：不确认。
    const r1 = await monitor.detect();
    expect(r1.resumedCount).toBe(1);

    // 重启：confirmer 恢复可用，发现 outbox 记录未确认 → 重放确认，不重发。
    const outbox2 = createAttemptOutbox({ stateDir, confirmer });
    const monitor2 = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-2", store, outbox: outbox2 });

    await monitor2.detect();
    expect(confirmCalls).toBe(1); // 重放确认一次
    const t1 = await store.load("t1");
    expect(t1!.phase).toBe("MONITORING"); // CONFIRMED 后立即收敛
    expect(t1!.activeAttemptId).toBeUndefined();
    expect(t1!.interruptionLatch).toBeUndefined();

    // 再一轮：确认成功后应清除 latch + activeAttemptId 并回到 MONITORING（T4 接线后）。
    // 本测试只验证“不盲目重发”：下一次 detect 不再触发第二次发送（无 sender）。
    const outbox3 = createAttemptOutbox({ stateDir, sender: { async send() { return { ok: true }; } }, confirmer });
    const monitor3 = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-3", store, outbox: outbox3 });
    const r3 = await monitor3.detect();
    expect(r3.resumedCount).toBe(0);
  });

  it("崩溃恢复点 1：发送前崩溃（有 outbox 无确认）→ 重启后 NOT_STARTED 才补发", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(latchedWatch({ threadId: "t1" }));

    // 模拟“发送前崩溃”：手动写入一条未确认的 outbox 记录（attempt 已入队但从未发送）。
    const attempt = {
      id: resumeAttemptId("t1", "cycle-2:thread-1"),
      threadId: "t1",
      latchId: "cycle-2:thread-1",
      cwd: "C:\\work\\demo",
      status: "QUEUED" as const,
      failureCount: 0,
      createdAt: new Date(T0 + STEP_MS).toISOString(),
      updatedAt: new Date(T0 + STEP_MS).toISOString(),
    };
    const outbox = createAttemptOutbox({ stateDir });
    // 直接写入（走 outbox 的内部路径：send 会先重放确认）
    // 先清掉之前可能存在的记录，用 confirm 前写入：
    await outbox.remove(attempt);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { attemptsDir } = await import("../src/paths.js");
    mkdirSync(attemptsDir(stateDir), { recursive: true });
    writeFileSync(path.join(attemptsDir(stateDir), `${attempt.id}.json`), JSON.stringify(attempt));

    // 重启：confirmer 说“没有新 turn”（NOT_STARTED，有可靠证据未启动）→ 允许补发一次。
    const sent: string[] = [];
    const outbox2 = createAttemptOutbox({
      stateDir,
      sender: { async send(a: { id: string }) { sent.push(a.id); return { ok: true }; } },
      confirmer: { async confirm() { return { state: "NOT_STARTED" as const, reason: "no new turn yet" }; } },
    });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });
    const monitor2 = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-2", store, outbox: outbox2 });

    const report = await monitor2.detect();
    expect(sent).toHaveLength(1); // NOT_STARTED → 补发一次（同一 attempt id）。
    expect(sent[0]).toBe(attempt.id);
    expect(report.resumedCount).toBe(1);
  });

  it("修复 A-3: 重启发现未确认 outbox + confirm UNKNOWN → sender 0 次、phase NEEDS_ATTENTION、保留 latch 与 outbox", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(latchedWatch({ threadId: "t1" }));

    // 模拟“发送后确认前崩溃”：落盘一条已发送成功但未确认的 outbox 记录。
    const attempt = {
      id: resumeAttemptId("t1", "cycle-2:thread-1"),
      threadId: "t1",
      latchId: "cycle-2:thread-1",
      cwd: "C:\\work\\demo",
      status: "QUEUED" as const,
      failureCount: 0,
      createdAt: new Date(T0 + STEP_MS).toISOString(),
      updatedAt: new Date(T0 + STEP_MS).toISOString(),
    };
    const outbox = createAttemptOutbox({ stateDir });
    await outbox.remove(attempt);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { attemptsDir } = await import("../src/paths.js");
    mkdirSync(attemptsDir(stateDir), { recursive: true });
    writeFileSync(path.join(attemptsDir(stateDir), `${attempt.id}.json`), JSON.stringify(attempt));

    // 重启：confirmer 抛异常（UNKNOWN）→ sender 0 次。
    let sendCalls = 0;
    const outbox2 = createAttemptOutbox({
      stateDir,
      sender: { async send() { sendCalls++; return { ok: true }; } },
      confirmer: { async confirm() { throw new Error("confirm API down"); } },
    });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });
    const monitor2 = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-2", store, outbox: outbox2 });

    const report = await monitor2.detect();
    expect(sendCalls).toBe(0); // 绝不能调用 sender。
    expect(report.resumedCount).toBe(0);
    const t1 = await store.load("t1");
    expect(t1!.phase).toBe("NEEDS_ATTENTION"); // 待人工关注。
    expect(t1!.interruptionLatch).toBeDefined(); // latch 保留。
    expect(t1!.activeAttemptId).toBeDefined(); // activeAttempt 保留。
    const pending = await outbox2.loadPending();
    expect(pending).toHaveLength(1); // outbox 保留。
    expect(pending[0].confirmedAt).toBeUndefined();

    // 再一轮（重复 tick）：仍 0 次发送（UNKNOWN 持续）。
    await monitor2.detect();
    expect(sendCalls).toBe(0);
  });

  it("AR-20: RUNNING+POSITIVE 已落盘（含 arming），重启后 7 分钟内 COMPLETED+ZERO → 恢复 arming 并锁存", async () => {
    const stateDir = tempStateDir();
    const store1 = createWatchStore(stateDir);
    await store1.upsert(makeWatch({
      threadId: "t1",
      armedByDetection: { cycleId: "cycle-1", detectedAt: new Date(T0).toISOString(), validUntil: T0 + 420_000 },
    }));

    // 重启后 4 分钟（仍在有效期）：COMPLETED+ZERO → 锁存。
    const clock2 = { now: () => T0 + 4 * 60_000 };
    const quotaReader = vi.fn().mockResolvedValue({ state: "ZERO" as const });
    const sessionReader = vi.fn().mockResolvedValue("COMPLETED" as const);
    const store2 = createWatchStore(stateDir);
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock: clock2, ownerToken: "owner-2", store: store2 });

    const report = await monitor.detect();
    const t1 = await store2.load("t1");
    expect(t1!.interruptionLatch!.id).toBe(`${report.cycleId}:t1`);
    expect(t1!.interruptionLatch!.previousRunningCycleId).toBe("cycle-1");
    expect(t1!.phase).toBe("WAITING_FOR_5H_QUOTA");
    expect(report.quotaState).toBe("ZERO");
  });

  it("arming 过期（>7 分钟）→ 不再锁存，保持 MONITORING", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({
      threadId: "t1",
      armedByDetection: { cycleId: "cycle-1", detectedAt: new Date(T0).toISOString(), validUntil: T0 + 420_000 },
    }));

    const clock2 = { now: () => T0 + 8 * 60_000 };
    const quotaReader = vi.fn().mockResolvedValue({ state: "ZERO" as const });
    const sessionReader = vi.fn().mockResolvedValue("COMPLETED" as const);
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock: clock2, ownerToken: "owner-2", store });

    await monitor.detect();
    const t1 = await store.load("t1");
    expect(t1!.interruptionLatch).toBeUndefined();
    expect(t1!.phase).toBe("MONITORING");
  });

  it("RUNNING+POSITIVE（无 latch）→ 0 发送、只刷新 observation/arming（AR-01 语义）", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({ threadId: "t1" }));

    const sender = vi.fn().mockResolvedValue({ ok: true });
    const outbox = createAttemptOutbox({ stateDir, sender });
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });
    const sessionReader = vi.fn().mockResolvedValue("RUNNING" as const);
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    const report = await monitor.detect();
    expect(report.resumedCount).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    const t1 = await store.load("t1");
    expect(t1!.phase).toBe("MONITORING");
    expect(t1!.armedByDetection).toBeDefined();
    expect(t1!.armedByDetection!.validUntil).toBe(T0 + 420_000);
  });
});

describe("auto-resume-monitor — T2 验收回归（判定 1 / 修复 A / 修复 B）", () => {
  it("修复 B-4: quotaBlocked → 恢复 → 技术失败两次 → 再 tick 0 发送、NEEDS_ATTENTION 保持", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    let calls = 0;
    let quotaOn = false; // false = sender 报 quotaBlocked；true = 额度恢复（技术失败）。
    const sender = {
      async send() {
        calls++;
        if (!quotaOn) return { ok: false, quotaBlocked: true as const, error: "5h usage limit reached" };
        return { ok: false, error: "app-server exited" };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: { async confirm() { return { state: "CONFIRMED" as const }; } } });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });

    await store.upsert(latchedWatch({ threadId: "t1" }));
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    // 第 1 轮：quotaBlocked → 回到 WAITING_FOR_5H_QUOTA，不计技术失败（failureCount 0）。
    await monitor.detect();
    const afterQuota = await store.load("t1");
    expect(afterQuota!.phase).toBe("WAITING_FOR_5H_QUOTA");
    expect(afterQuota!.interruptionLatch).toBeDefined();
    expect((await outbox.loadPending()).find((p) => p.id === afterQuota!.activeAttemptId)!.failureCount).toBe(0);

    // 第 2 轮：额度恢复 → 第一次技术失败（同一 attemptId，failureCount 1）。
    quotaOn = true;
    await monitor.detect();
    const afterFail1 = await store.load("t1");
    expect(afterFail1!.phase).toBe("RESUME_QUEUED");
    expect((await outbox.loadPending()).find((p) => p.id === afterFail1!.activeAttemptId)!.failureCount).toBe(1);

    // 第 3 轮：第二次技术失败 → NEEDS_ATTENTION（failureCount 2）。
    await monitor.detect();
    const afterFail2 = await store.load("t1");
    expect(afterFail2!.phase).toBe("NEEDS_ATTENTION");
    expect((await outbox.loadPending()).find((p) => p.id === afterFail2!.activeAttemptId)!.failureCount).toBe(2);
    expect(calls).toBe(3);

    // 第 4 轮：failureCount>=2 → sender 0 次；NEEDS_ATTENTION 保持。
    await monitor.detect();
    expect(calls).toBe(3);
    const final = await store.load("t1");
    expect(final!.phase).toBe("NEEDS_ATTENTION");
    expect(final!.lastError).toContain("giving up");
    // 全程只产生一个 attemptId（quota 不计失败、恢复后仍复用同一 id）。
    const pending = await outbox.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(resumeAttemptId("t1", "cycle-2:thread-1"));
  });

  it("判定 1: 同一 latch 重复 tick 最多 1 次有效发送；自行恢复后第二次真实中断可建新 latch，两个 latch 各最多 1 发送", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const sentIds: string[] = [];
    const sender = {
      async send(attempt: { id: string }) {
        sentIds.push(attempt.id);
        return { ok: true };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: { async confirm() { return { state: "CONFIRMED" as const, reason: "new turn id seen" }; } } });

    // —— 第一次真实中断：latch1（cycle-2），同一 latch 连续 tick 只允许 1 次有效发送。 ——
    await store.upsert(latchedWatch({ threadId: "t1" }));
    const quotaReader = vi.fn().mockResolvedValue({ state: "POSITIVE" as const });
    const sessionReader = vi.fn().mockResolvedValue("STOPPED" as const);
    const monitor = createMonitor({ stateDir, quotaReader, sessionReader, clock, ownerToken: "owner-1", store, outbox });

    await monitor.detect(); // latch1：第一次真实中断 → queue+send。
    await monitor.detect(); // 同一 latch 重复 tick：已确认 → 不再发送（防重合同）。
    expect(sentIds).toHaveLength(1);
    const latch1Id = resumeAttemptId("t1", "cycle-2:thread-1");
    expect(sentIds[0]).toBe(latch1Id);
    const afterFirst = await store.load("t1");
    expect(afterFirst!.phase).toBe("MONITORING"); // CONFIRMED 后清除 latch/activeAttempt。

    // —— 用户/Codex 自行恢复：RUNNING+POSITIVE → clear-latch（重建 arming）。 ——
    const selfHealSnapshot: DetectionSnapshot = {
      cycleId: "cycle-4",
      detectedAt: new Date(T0 + 4 * STEP_MS).toISOString(),
      sessionState: "RUNNING",
      fiveHourQuota: "POSITIVE",
      trusted: true,
    };
    const heal = await store.load("t1");
    const healNext = applyDecisionAtomically(heal!, (await import("../src/auto-resume-reducer.js")).autoResumeReducer(heal!, selfHealSnapshot, T0 + 4 * STEP_MS), selfHealSnapshot, T0 + 4 * STEP_MS);
    await store.upsert(healNext);
    const healed = await store.load("t1");
    expect(healed!.interruptionLatch).toBeUndefined(); // 旧 latch 已清除。
    expect(healed!.activeAttemptId).toBeUndefined();
    expect(healed!.armedByDetection).toBeDefined(); // 已重建 arming。

    // —— 第二次真实中断：latch2（cycle-5）→ 允许创建新 latch 并续跑一次。 ——
    const secondZeroSnapshot: DetectionSnapshot = {
      cycleId: "cycle-5",
      detectedAt: new Date(T0 + 5 * STEP_MS).toISOString(),
      sessionState: "STOPPED",
      fiveHourQuota: "ZERO",
      trusted: true,
    };
    const secondHeal = await store.load("t1");
    const secondZero = applyDecisionAtomically(secondHeal!, (await import("../src/auto-resume-reducer.js")).autoResumeReducer(secondHeal!, secondZeroSnapshot, T0 + 5 * STEP_MS), secondZeroSnapshot, T0 + 5 * STEP_MS);
    await store.upsert(secondZero);
    const latched2 = await store.load("t1");
    expect(latched2!.interruptionLatch).toBeDefined();
    expect(latched2!.interruptionLatch!.id).toBe("cycle-5:t1"); // 新 latch（不同 id）。

    // 恢复后（cycle-6）→ 发送第二个 attempt（新 latch → 新 attemptId）。
    await monitor.detect();
    expect(sentIds).toHaveLength(2); // 两个真实中断 → 各 1 次有效发送。
    const latch2Id = resumeAttemptId("t1", "cycle-5:t1");
    expect(sentIds[1]).toBe(latch2Id);
    expect(sentIds[0]).not.toBe(sentIds[1]); // 两个 latch 各自独立幂等键。

    // 同一 latch2 重复 tick：仍只有 2 次发送（latch2 最多 1 次）。
    await monitor.detect();
    expect(sentIds).toHaveLength(2);
    const final = await store.load("t1");
    expect(final!.phase).toBe("MONITORING");
    expect(final!.activeAttemptId).toBeUndefined();
    expect(final!.interruptionLatch).toBeUndefined();
  });

  it("CONFIRMED 后原子清除 latch/active/outbox；后续可信 COMPLETED+POSITIVE 才禁用 watch", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    let sessionState: "STOPPED" | "COMPLETED" = "STOPPED";
    const sender = { async send() { return { ok: true }; } };
    const confirmer = { async confirm() { return { state: "CONFIRMED" as const, reason: "new turn" }; } };
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer, clock });
    const monitor = createMonitor({
      stateDir,
      store,
      outbox,
      quotaReader: vi.fn().mockResolvedValue({ state: "POSITIVE" as const }),
      sessionReader: vi.fn().mockImplementation(async () => sessionState),
      clock,
      ownerToken: "confirm-sequence",
    });
    await store.upsert(latchedWatch({ threadId: "t1" }));

    await monitor.detect("resume-cycle");
    const resumed = await store.load("t1");
    expect(resumed!.enabled).toBe(true);
    expect(resumed!.phase).toBe("MONITORING");
    expect(resumed!.interruptionLatch).toBeUndefined();
    expect(resumed!.activeAttemptId).toBeUndefined();
    expect(await outbox.loadPending()).toHaveLength(0);

    sessionState = "COMPLETED";
    await monitor.detect("completed-cycle");
    const completed = await store.load("t1");
    expect(completed!.enabled).toBe(false);
    expect(completed!.phase).toBe("DISABLED");
  });

  it("初始 POSITIVE 但 fresh guard ZERO/UNKNOWN 时不发送，且不改写原 decision observation", async () => {
    for (const guardState of ["ZERO", "UNKNOWN"] as const) {
      const stateDir = tempStateDir();
      const store = createWatchStore(stateDir);
      let sendCalls = 0;
      const outbox = createAttemptOutbox({
        stateDir,
        sender: { async send() { sendCalls++; return { ok: true }; } },
        confirmer: { async confirm() { return { state: "CONFIRMED" as const }; } },
        clock,
      });
      const quotaReader = vi.fn()
        .mockResolvedValueOnce({ state: "POSITIVE" as const })
        .mockResolvedValueOnce({ state: guardState });
      await store.upsert(latchedWatch({ threadId: `guard-${guardState}` }));
      const monitor = createMonitor({
        stateDir,
        store,
        outbox,
        quotaReader,
        sessionReader: vi.fn().mockResolvedValue("STOPPED" as const),
        clock,
        ownerToken: `guard-${guardState}`,
      });

      await monitor.detect(`guard-cycle-${guardState}`);
      const saved = await store.load(`guard-${guardState}`);
      expect(sendCalls).toBe(0);
      expect(quotaReader).toHaveBeenCalledTimes(2);
      expect(saved!.lastObservation!.fiveHourQuota).toBe("POSITIVE");
      expect(saved!.phase).toBe(guardState === "ZERO" ? "WAITING_FOR_5H_QUOTA" : "NEEDS_ATTENTION");
    }
  });

  it("两个不同 ownerToken 并发处理同 thread+latch 时最多一次有效 sender", async () => {
    const stateDir = tempStateDir();
    const storeA = createWatchStore(stateDir);
    const storeB = createWatchStore(stateDir);
    await storeA.upsert(latchedWatch({ threadId: "concurrent" }));

    let senderCalls = 0;
    let releaseSender: () => void = () => {};
    let senderStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { senderStarted = resolve; });
    const sender = {
      async send() {
        senderCalls++;
        senderStarted();
        await new Promise<void>((resolve) => { releaseSender = resolve; });
        return { ok: true };
      },
    };
    const confirmer = { async confirm() { return { state: "CONFIRMED" as const }; } };
    const monitorA = createMonitor({
      stateDir, store: storeA, outbox: createAttemptOutbox({ stateDir, sender, confirmer, clock }),
      quotaReader: vi.fn().mockResolvedValue({ state: "POSITIVE" as const }),
      sessionReader: vi.fn().mockResolvedValue("STOPPED" as const), clock, ownerToken: "owner-a",
    });
    const monitorB = createMonitor({
      stateDir, store: storeB, outbox: createAttemptOutbox({ stateDir, sender, confirmer, clock }),
      quotaReader: vi.fn().mockResolvedValue({ state: "POSITIVE" as const }),
      sessionReader: vi.fn().mockResolvedValue("STOPPED" as const), clock, ownerToken: "owner-b",
    });

    const first = monitorA.detect("concurrent-a");
    await started;
    const second = monitorB.detect("concurrent-b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSender();
    await Promise.all([first, second]);
    expect(senderCalls).toBe(1);
    const saved = await storeA.load("concurrent");
    expect(saved!.phase).toBe("MONITORING");
    expect(saved!.activeAttemptId).toBeUndefined();
  });

  it("待发送批次实际最多并发 2 个，第三项排队到下一轮", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let firstBatchStarted: () => void = () => {};
    const firstTwoStarted = new Promise<void>((resolve) => { firstBatchStarted = resolve; });
    const sender = {
      async send() {
        calls++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (calls === 2) firstBatchStarted();
        await gate;
        active--;
        return { ok: true };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: { async confirm() { return { state: "CONFIRMED" as const }; } }, clock });
    for (const threadId of ["batch-1", "batch-2", "batch-3"]) await store.upsert(latchedWatch({ threadId }));
    const monitor = createMonitor({
      stateDir, store, outbox,
      quotaReader: vi.fn().mockResolvedValue({ state: "POSITIVE" as const }),
      sessionReader: vi.fn().mockResolvedValue("STOPPED" as const), clock, ownerToken: "batch-owner",
    });

    const firstRound = monitor.detect("batch-cycle-1");
    await firstTwoStarted;
    expect(maxActive).toBe(2);
    expect(calls).toBe(2);
    resolveGate();
    const firstReport = await firstRound;
    expect(firstReport.skippedOverlapCount).toBe(1);
    expect(calls).toBe(2);
    await monitor.detect("batch-cycle-2");
    expect(calls).toBe(3);
    expect(maxActive).toBe(2);
  });

  it("clearWatchArtifacts 只删除目标 watch 与其 outbox，保留其他 thread", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(latchedWatch({ threadId: "delete-me", activeAttemptId: "attempt-delete" }));
    await store.upsert(latchedWatch({ threadId: "keep-me", activeAttemptId: "attempt-keep" }));
    const outbox = createAttemptOutbox({ stateDir, sender: { async send() { return { ok: false, error: "not sent" }; } }, clock });
    const deleteAttempt = {
      id: "attempt-delete", threadId: "delete-me", latchId: "cycle-2:thread-1", cwd: "C:\\work\\demo",
      status: "QUEUED" as const, failureCount: 0, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
    };
    const keepAttempt = { ...deleteAttempt, id: "attempt-keep", threadId: "keep-me" };
    await outbox.recordFailure(deleteAttempt, "pending");
    await outbox.recordFailure(keepAttempt, "pending");

    expect(await clearWatchArtifacts(stateDir, "delete-me", "delete-owner", store, outbox, { now: clock.now })).toBe(true);
    expect(await store.load("delete-me")).toBeUndefined();
    expect(await store.load("keep-me")).toBeDefined();
    expect((await outbox.loadPending()).map((attempt) => attempt.id)).toEqual(["attempt-keep"]);
  });
});
