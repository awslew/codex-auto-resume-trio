import { describe, expect, it } from "vitest";
import type { AutoResumeWatch, DetectionSnapshot, TransitionDecision } from "../src/auto-resume-types.js";
import { autoResumeReducer, resumeAttemptId } from "../src/auto-resume-reducer.js";

/**
 * AR-01～AR-11 表驱动测试（AUTO_RESUME_V2_DESIGN.md §12；执行计划 §7 T1）。
 * 全部使用 fake clock：每轮间隔精确推进 180 秒。
 * 模拟 T2 的最小持久化语义：arming 只在 RUNNING+POSITIVE 后写入；latch 只来自 create-latch 命令。
 */

const T0 = 1_800_000_000_000;
const STEP_MS = 180_000;
const ARMING_MS = 7 * 60_000;

/** sha256("thread-1" + "cycle-2:thread-1") 的确定性期望值（AR-06 幂等键）。 */
const AR06_ATTEMPT_ID = "720b81e94e67f0b27a5cc750c58b8840244a009894817a8c85ceef568482ed63";

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

function snapshot(cycle: number, sessionState: DetectionSnapshot["sessionState"], quota: DetectionSnapshot["fiveHourQuota"]): DetectionSnapshot {
  return {
    cycleId: `cycle-${cycle}`,
    detectedAt: new Date(T0 + (cycle - 1) * STEP_MS).toISOString(),
    sessionState,
    fiveHourQuota: quota,
    trusted: true,
  };
}

/** 模拟 T2 的持久化提交：写 observation；arming 只在 RUNNING+POSITIVE 后写；latch 只来自命令。 */
function applyDecision(watch: AutoResumeWatch, decision: TransitionDecision, snap: DetectionSnapshot, now: number): AutoResumeWatch {
  const next: AutoResumeWatch = {
    ...watch,
    phase: decision.nextPhase ?? watch.phase,
    lastObservation: {
      cycleId: snap.cycleId,
      detectedAt: snap.detectedAt,
      sessionState: snap.sessionState,
      fiveHourQuota: snap.fiveHourQuota,
      ...(snap.quotaResetAt !== undefined ? { quotaResetAt: snap.quotaResetAt } : {}),
    },
    updatedAt: snap.detectedAt,
  };
  if (snap.sessionState === "RUNNING" && snap.fiveHourQuota === "POSITIVE") {
    next.armedByDetection = { cycleId: snap.cycleId, detectedAt: snap.detectedAt, validUntil: now + ARMING_MS };
  }
  const latchCommand = decision.commands.find((c) => c.type === "create-latch");
  if (latchCommand && latchCommand.type === "create-latch") {
    next.interruptionLatch = latchCommand.latch;
  }
  if (decision.commands.some((c) => c.type === "disable")) {
    next.enabled = false;
  }
  if (decision.commands.some((c) => c.type === "clear-latch")) {
    delete next.interruptionLatch;
    delete next.activeAttemptId;
  }
  return next;
}

describe("auto resume reducer — AR-01..AR-11", () => {
  it("AR-01: RUNNING+POSITIVE 连续 3 轮 → 0 次 resume，保持勾选", () => {
    let watch = makeWatch();
    for (let cycle = 1; cycle <= 3; cycle++) {
      const decision = autoResumeReducer(watch, snapshot(cycle, "RUNNING", "POSITIVE"), T0 + (cycle - 1) * STEP_MS);
      expect(decision.commands).toEqual([]);
      expect(watch.enabled).toBe(true);
      watch = applyDecision(watch, decision, snapshot(cycle, "RUNNING", "POSITIVE"), T0 + (cycle - 1) * STEP_MS);
    }
  });

  it("AR-02: RUNNING+POSITIVE → COMPLETED+POSITIVE → 取消勾选，0 次 resume", () => {
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);

    const done = autoResumeReducer(watch, snapshot(2, "COMPLETED", "POSITIVE"), T0 + STEP_MS);
    expect(done.nextPhase).toBe("DISABLED");
    expect(done.commands).toEqual([{ type: "disable" }]);
    expect(done.commands.some((c) => c.type === "queue-resume")).toBe(false);
    const disabled = applyDecision(watch, done, snapshot(2, "COMPLETED", "POSITIVE"), T0 + STEP_MS);
    expect(disabled.enabled).toBe(false);
    expect(disabled.phase).toBe("DISABLED");
  });

  it("AR-03: RUNNING+POSITIVE → COMPLETED+ZERO → 锁存等待，不取消", () => {
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);

    const zero = autoResumeReducer(watch, snapshot(2, "COMPLETED", "ZERO"), T0 + STEP_MS);
    expect(zero.nextPhase).toBe("WAITING_FOR_5H_QUOTA");
    expect(zero.commands).toEqual([
      {
        type: "create-latch",
        latch: {
          id: "cycle-2:thread-1",
          detectedAt: new Date(T0 + STEP_MS).toISOString(),
          evidenceCycleId: "cycle-2",
          previousRunningCycleId: "cycle-1",
        },
      },
    ]);
    const latched = applyDecision(watch, zero, snapshot(2, "COMPLETED", "ZERO"), T0 + STEP_MS);
    expect(latched.enabled).toBe(true);
    expect(latched.interruptionLatch).toBeDefined();
    expect(latched.phase).toBe("WAITING_FOR_5H_QUOTA");
  });

  it("AR-04: RUNNING+POSITIVE → RUNNING+ZERO → 锁存等待，0 次 resume", () => {
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);

    const zero = autoResumeReducer(watch, snapshot(2, "RUNNING", "ZERO"), T0 + STEP_MS);
    expect(zero.nextPhase).toBe("WAITING_FOR_5H_QUOTA");
    expect(zero.commands).toEqual([
      {
        type: "create-latch",
        latch: {
          id: "cycle-2:thread-1",
          detectedAt: new Date(T0 + STEP_MS).toISOString(),
          evidenceCycleId: "cycle-2",
          previousRunningCycleId: "cycle-1",
        },
      },
    ]);
    expect(zero.commands.some((c) => c.type === "queue-resume")).toBe(false);
  });

  it("AR-05: RUNNING+POSITIVE → RUNNING+ZERO → COMPLETED+ZERO → latch 保持不变", () => {
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);

    const zero = autoResumeReducer(watch, snapshot(2, "RUNNING", "ZERO"), T0 + STEP_MS);
    const latched = applyDecision(watch, zero, snapshot(2, "RUNNING", "ZERO"), T0 + STEP_MS);
    const latchBefore = latched.interruptionLatch;

    const again = autoResumeReducer(latched, snapshot(3, "COMPLETED", "ZERO"), T0 + 2 * STEP_MS);
    expect(again.nextPhase).toBe("WAITING_FOR_5H_QUOTA");
    expect(again.commands).toEqual([]);
    expect(again.commands.some((c) => c.type === "disable")).toBe(false);
    const after = applyDecision(latched, again, snapshot(3, "COMPLETED", "ZERO"), T0 + 2 * STEP_MS);
    expect(after.interruptionLatch).toEqual(latchBefore);
  });

  it("AR-06: AR-03 后 COMPLETED+POSITIVE → 恰好 1 次 resume，attemptId 为 sha256(threadId+latchId)", () => {
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);
    const zero = autoResumeReducer(watch, snapshot(2, "COMPLETED", "ZERO"), T0 + STEP_MS);
    const latched = applyDecision(watch, zero, snapshot(2, "COMPLETED", "ZERO"), T0 + STEP_MS);

    const recovered = autoResumeReducer(latched, snapshot(3, "COMPLETED", "POSITIVE"), T0 + 2 * STEP_MS);
    expect(recovered.nextPhase).toBe("RESUME_QUEUED");
    const resumes = recovered.commands.filter((c) => c.type === "queue-resume");
    expect(resumes).toHaveLength(1);
    const attempt = (resumes[0] as { attempt: { id: string; latchId: string; status: string } }).attempt;
    expect(attempt.id).toBe(AR06_ATTEMPT_ID);
    expect(attempt.id).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.latchId).toBe("cycle-2:thread-1");
    expect(attempt.status).toBe("QUEUED");
  });

  it("幂等键确定性：同 threadId+latchId 恒同，不同 latchId 恒异（sha256 合同）", () => {
    const first = resumeAttemptId("thread-1", "cycle-2:thread-1");
    const second = resumeAttemptId("thread-1", "cycle-2:thread-1");
    expect(first).toBe(second);
    expect(first).toBe(AR06_ATTEMPT_ID);
    expect(resumeAttemptId("thread-1", "cycle-3:thread-1")).not.toBe(first);
    expect(resumeAttemptId("thread-2", "cycle-2:thread-1")).not.toBe(first);
  });

  it("AR-07: AR-04 后 RUNNING+POSITIVE → 自行恢复：clear-latch、0 次 resume，后续 COMPLETED+POSITIVE 只 disable", () => {
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);
    const zero = autoResumeReducer(watch, snapshot(2, "RUNNING", "ZERO"), T0 + STEP_MS);
    const latched = applyDecision(watch, zero, snapshot(2, "RUNNING", "ZERO"), T0 + STEP_MS);
    expect(latched.interruptionLatch).toBeDefined();

    // 额度恢复且会话自行恢复运行：清除 latch，0 次 resume。
    const recovered = autoResumeReducer(latched, snapshot(3, "RUNNING", "POSITIVE"), T0 + 2 * STEP_MS);
    expect(recovered.nextPhase).toBe("MONITORING");
    expect(recovered.commands).toEqual([{ type: "clear-latch" }]);
    expect(recovered.commands.some((c) => c.type === "queue-resume")).toBe(false);
    const cleared = applyDecision(latched, recovered, snapshot(3, "RUNNING", "POSITIVE"), T0 + 2 * STEP_MS);
    expect(cleared.interruptionLatch).toBeUndefined();
    expect(cleared.activeAttemptId).toBeUndefined();

    // 恢复后正常完成：只 disable，绝不 queue-resume。
    const done = autoResumeReducer(cleared, snapshot(4, "COMPLETED", "POSITIVE"), T0 + 3 * STEP_MS);
    expect(done.nextPhase).toBe("DISABLED");
    expect(done.commands).toEqual([{ type: "disable" }]);
    expect(done.commands.some((c) => c.type === "queue-resume")).toBe(false);
  });

  it("防重：同一 latch 的 COMPLETED/STOPPED+POSITIVE 连续两轮 → 只 queue 一次，第二轮 0 个 queue 命令", () => {
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);
    const zero = autoResumeReducer(watch, snapshot(2, "COMPLETED", "ZERO"), T0 + STEP_MS);
    const latched = applyDecision(watch, zero, snapshot(2, "COMPLETED", "ZERO"), T0 + STEP_MS);

    // 第一轮：发出 queue-resume；T2 将写入 activeAttemptId。
    const r1 = autoResumeReducer(latched, snapshot(3, "COMPLETED", "POSITIVE"), T0 + 2 * STEP_MS);
    expect(r1.commands.filter((c) => c.type === "queue-resume")).toHaveLength(1);
    const queued = applyDecision(latched, r1, snapshot(3, "COMPLETED", "POSITIVE"), T0 + 2 * STEP_MS);
    const attemptId = (r1.commands.find((c) => c.type === "queue-resume") as { attempt: { id: string } } | undefined)?.attempt.id;
    queued.activeAttemptId = attemptId;

    // 第二轮（重复 tick/双调度器）：同一 latch → 0 个 queue 命令。
    const r2 = autoResumeReducer(queued, snapshot(4, "COMPLETED", "POSITIVE"), T0 + 3 * STEP_MS);
    expect(r2.nextPhase).toBe("RESUME_QUEUED");
    expect(r2.commands.filter((c) => c.type === "queue-resume")).toHaveLength(0);
  });

  it("AR-08: 无历史，首次 COMPLETED+ZERO → 不 resume、不取消，显示证据不足", () => {
    const watch = makeWatch();
    const decision = autoResumeReducer(watch, snapshot(1, "COMPLETED", "ZERO"), T0);
    expect(decision.nextPhase).toBeNull();
    expect(decision.commands).toEqual([]);
    expect(watch.enabled).toBe(true);
    expect(watch.phase).toBe("MONITORING");
  });

  it("AR-09: 任意状态 + quota UNKNOWN → 不 resume、不取消", () => {
    const watch = makeWatch();
    const decision = autoResumeReducer(watch, snapshot(1, "RUNNING", "UNKNOWN"), T0);
    expect(decision.nextPhase).toBeNull();
    expect(decision.commands).toEqual([]);
  });

  it("AR-10: 周额度 ZERO、5h 额度 POSITIVE → 按 5h POSITIVE 处理（5h 归零才会锁存，周归零不触发）", () => {
    // 上一轮 5h POSITIVE（周额度为 0 但被隔离，不影响 5h 判定）。
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);

    // 5h 保持 POSITIVE → 正常完成按普通取消处理，不锁存、不 resume。
    const done = autoResumeReducer(watch, snapshot(2, "COMPLETED", "POSITIVE"), T0 + STEP_MS);
    expect(done.nextPhase).toBe("DISABLED");
    expect(done.commands).toEqual([{ type: "disable" }]);
    expect(done.commands.some((c) => c.type === "queue-resume")).toBe(false);

    // 5h 才归零 → 锁存等待（周额度归零本身不产生任何迁移证据）。
    const watch2 = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);
    const zero = autoResumeReducer(watch2, snapshot(2, "RUNNING", "ZERO"), T0 + STEP_MS);
    expect(zero.nextPhase).toBe("WAITING_FOR_5H_QUOTA");
    expect(zero.commands.some((c) => c.type === "create-latch")).toBe(true);
  });

  it("AR-11: 5h 字段缺失、通用 usage-limit 文案 → quota UNKNOWN，不创建 latch", () => {
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);

    // 缺失 5h 字段（UNKNOWN）→ 不创建 latch、不取消。
    const missing = autoResumeReducer(watch, snapshot(2, "COMPLETED", "UNKNOWN"), T0 + STEP_MS);
    expect(missing.nextPhase).toBeNull();
    expect(missing.commands).toEqual([]);
    expect(missing.commands.some((c) => c.type === "create-latch")).toBe(false);

    // 通用 usage-limit 文案（映射为 UNKNOWN）→ 同样不创建 latch。
    const generic = autoResumeReducer(watch, snapshot(3, "COMPLETED", "UNKNOWN"), T0 + 2 * STEP_MS);
    expect(generic.commands).toEqual([]);
    expect(generic.commands.some((c) => c.type === "create-latch")).toBe(false);
  });

  it("AR-19: 已锁存后 STOPPED+POSITIVE → 恰好 1 次 resume（§12 补充，与 AR-06 同分支）", () => {
    const first = snapshot(1, "RUNNING", "POSITIVE");
    const watch = applyDecision(makeWatch(), autoResumeReducer(makeWatch(), first, T0), first, T0);
    const zero = autoResumeReducer(watch, snapshot(2, "STOPPED", "ZERO"), T0 + STEP_MS);
    const latched = applyDecision(watch, zero, snapshot(2, "STOPPED", "ZERO"), T0 + STEP_MS);

    const recovered = autoResumeReducer(latched, snapshot(3, "STOPPED", "POSITIVE"), T0 + 2 * STEP_MS);
    expect(recovered.nextPhase).toBe("RESUME_QUEUED");
    expect(recovered.commands.filter((c) => c.type === "queue-resume")).toHaveLength(1);
  });

  it("AR-20: RUNNING+POSITIVE 已落盘，重启后 7 分钟内 COMPLETED+ZERO → 恢复 arming 并锁存等待", () => {
    // 上一轮 RUNNING+POSITIVE 已原子提交（含 arming，validUntil = T0 + 7 分钟）。
    const armed = makeWatch({
      armedByDetection: {
        cycleId: "cycle-1",
        detectedAt: new Date(T0).toISOString(),
        validUntil: T0 + ARMING_MS,
      },
    });

    // 进程重启后 4 分钟（仍在 7 分钟有效期内）出现 COMPLETED+ZERO。
    const decision = autoResumeReducer(armed, snapshot(2, "COMPLETED", "ZERO"), T0 + 4 * 60_000);
    expect(decision.nextPhase).toBe("WAITING_FOR_5H_QUOTA");
    expect(decision.commands).toEqual([
      {
        type: "create-latch",
        latch: {
          id: "cycle-2:thread-1",
          detectedAt: new Date(T0 + STEP_MS).toISOString(),
          evidenceCycleId: "cycle-2",
          previousRunningCycleId: "cycle-1",
        },
      },
    ]);

    // 7 分钟后过期：不能再锁存。
    const expired = autoResumeReducer(armed, snapshot(3, "COMPLETED", "ZERO"), T0 + 8 * 60_000);
    expect(expired.nextPhase).toBeNull();
    expect(expired.commands).toEqual([]);
  });
});
