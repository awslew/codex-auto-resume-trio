import { createHash } from "node:crypto";
import type {
  AutoResumeWatch,
  DetectionSnapshot,
  InterruptionLatch,
  ResumeAttempt,
  TransitionDecision,
} from "./auto-resume-types.js";
import { ARMING_VALIDITY_MS } from "./auto-resume-types.js";

/**
 * 自动续跑 V2 纯状态机（AUTO_RESUME_V2_DESIGN.md §5；执行计划 §4.2）。
 *
 * 判定优先级（严格按序，禁止把“completed 自动取消”放在额度中断识别之前）：
 *   1. 用户已取消勾选 → DISABLED，结束。
 *   2. 快照不可信 → 只记 observation，不迁移。
 *   3. 已有 interruptionLatch → 已锁存分支。
 *   4. 有效 arming + 本轮额度 ZERO → 创建 latch（本轮会话标签不参与否决）。
 *   5. 无 latch 的 RUNNING + POSITIVE → 只更新可信快照，无命令。
 *   6. 无 latch 的 COMPLETED + POSITIVE → DISABLED（disable 命令）。
 *   7. 其余组合 → 证据不足，保持 phase，不续跑、不取消。
 *
 * reducer 为纯函数：无 I/O、无副作用，外部动作全部以 command 列表返回；
 * 对 RUNNING + POSITIVE（无 latch）的副作用计数必须严格为 0。
 *
 * 幂等：同一个 interruptionLatch 最多输出一次 queue-resume。reducer 的
 * `resumeAttemptCount` 只表示历史上发出过的 attempt 数量，不充当幂等证据。
 */
export function autoResumeReducer(watch: AutoResumeWatch, snapshot: DetectionSnapshot, now: number): TransitionDecision {
  if (!watch.enabled) {
    return { nextPhase: "DISABLED", commands: [] };
  }

  if (!snapshot.trusted) {
    return { nextPhase: null, commands: [], staleReason: "untrusted snapshot" };
  }

  // 已锁存分支（design §5.3）：latch 存在时，completed/stopped 标签不得清除它。
  if (watch.interruptionLatch) {
    return decideWithLatch(watch, snapshot, now);
  }

  const arming = watch.armedByDetection;
  const armingValid = arming !== undefined && now <= arming.validUntil;

  // 有效 arming + 本轮额度 ZERO：创建 latch，进入 WAITING_FOR_5H_QUOTA。
  // 本轮会话标签（RUNNING/COMPLETED/STOPPED/UNKNOWN）不参与否决。
  if (armingValid && snapshot.fiveHourQuota === "ZERO") {
    const latch: InterruptionLatch = {
      id: `${snapshot.cycleId}:${watch.threadId}`,
      detectedAt: snapshot.detectedAt,
      evidenceCycleId: snapshot.cycleId,
      previousRunningCycleId: arming.cycleId,
      quotaResetAt: snapshot.quotaResetAt,
    };
    return {
      nextPhase: "WAITING_FOR_5H_QUOTA",
      commands: [{ type: "create-latch", latch }],
    };
  }

  if (snapshot.fiveHourQuota === "POSITIVE") {
    if (snapshot.sessionState === "RUNNING") {
      // 只观察、刷新 arming（可信 RUNNING + POSITIVE 建立/续期 7 分钟）。
      return { nextPhase: "MONITORING", commands: [] };
    }
    if (snapshot.sessionState === "COMPLETED") {
      // 正常完成：取消勾选，进入 DISABLED。
      return { nextPhase: "DISABLED", commands: [{ type: "disable" }] };
    }
  }

  // 其余组合均证据不足：不续跑、不取消、不迁移。
  return { nextPhase: null, commands: [] };
}

/**
 * 已锁存分支（design §5.3 真值表）。
 *
 * | 当前会话    | 当前 5h 额度 | 结果             | 外部动作                            |
 * |-------------|-------------|------------------|-------------------------------------|
 * | RUNNING     | ZERO        | 继续等待         | 无                                  |
 * | COMPLETED/STOPPED/UNKNOWN | ZERO | 继续等待    | 无                                  |
 * | UNKNOWN     | POSITIVE    | 继续等待会话状态 | 无                                  |
 * | RUNNING     | POSITIVE    | 回到 MONITORING  | clear-latch：清除锁存证据，不重复启动 |
 * | COMPLETED/STOPPED | POSITIVE | RESUME_QUEUED  | queue-resume：创建一次幂等续跑尝试   |
 */
function decideWithLatch(watch: AutoResumeWatch, snapshot: DetectionSnapshot, now: number): TransitionDecision {
  const latch = watch.interruptionLatch!;

  if (snapshot.fiveHourQuota !== "POSITIVE") {
    // ZERO 或 UNKNOWN：继续等待额度恢复；UNKNOWN 也不推进续跑。
    return { nextPhase: "WAITING_FOR_5H_QUOTA", commands: [] };
  }

  switch (snapshot.sessionState) {
    case "RUNNING":
      // 用户或 Codex 已自行恢复：视为恢复，不重复启动；清除锁存证据（含 activeAttemptId）。
      return { nextPhase: "MONITORING", commands: [{ type: "clear-latch" }] };
    case "COMPLETED":
    case "STOPPED": {
      // 同一个 latch 尚未发出过续跑时，额度恢复且会话可信结束 → 创建一次幂等续跑尝试；
      // 已发出过（watch 记录了 activeAttemptId）→ 不再重复 queue，防 T2 双调度器/重复 tick。
      if (watch.activeAttemptId !== undefined) {
        return { nextPhase: "RESUME_QUEUED", commands: [] };
      }
      const attempt: ResumeAttempt = {
        id: resumeAttemptId(watch.threadId, latch.id),
        threadId: watch.threadId,
        latchId: latch.id,
        cwd: watch.cwd,
        status: "QUEUED",
        failureCount: 0,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      return {
        nextPhase: "RESUME_QUEUED",
        commands: [{ type: "queue-resume", attempt }],
      };
    }
    default:
      // UNKNOWN：等待会话状态可信，不推进续跑。
      return { nextPhase: "WAITING_FOR_5H_QUOTA", commands: [] };
  }
}

/** 幂等键：resumeAttemptId = sha256(threadId + latch.id)，小写 64 位 hex（design §6.2）。 */
export function resumeAttemptId(threadId: string, latchId: string): string {
  return createHash("sha256").update(`${threadId}${latchId}`).digest("hex");
}

/** arming 有效期计算：可信 RUNNING + POSITIVE 建立，7 分钟内有效（design §4）。 */
export function armingValidUntil(detectedAtMs: number): number {
  return detectedAtMs + ARMING_VALIDITY_MS;
}
