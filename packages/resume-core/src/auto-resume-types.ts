/**
 * 自动续跑 V2 核心契约类型。
 *
 * 设计依据：AUTO_RESUME_V2_DESIGN.md §3.1/§4/§5；执行计划 §4.1。
 * 本文件只声明类型，不承担 I/O 与业务迁移逻辑。
 */

/** 会话规范状态：由桌面会话观测（desktop-sessions）输出，本模块只消费。 */
export type SessionState = "RUNNING" | "COMPLETED" | "STOPPED" | "UNKNOWN";

/** 5 小时额度规范状态。UNKNOWN 包括：窗口身份不明、字段缺失、读取失败或数据过期。 */
export type FiveHourQuotaState = "POSITIVE" | "ZERO" | "UNKNOWN";

/**
 * 续跑确认三态（design §6.3；T2 验收修复 A）：
 *   CONFIRMED    —— 有可靠证据确定续跑已生效（新 turn id / 晚于 attempt 的 RUNNING）。
 *   NOT_STARTED  —— 有可靠证据确定未启动（未入队、无新 turn、会话仍停留在旧状态）。
 *   UNKNOWN      —— 异常、超时、无法查询（一律禁止调用 sender，只能转人工）。
 * 只有 CONFIRMED / NOT_STARTED 才允许作为下一步决策依据；UNKNOWN 保持 outbox +
 * latch + activeAttempt，等待人工处理（NEEDS_ATTENTION）。
 */
export type ConfirmationState = "CONFIRMED" | "NOT_STARTED" | "UNKNOWN";

/** watch 生命周期阶段（唯一真相来自服务端 reducer 输出，UI 只展示）。 */
export type WatchPhase =
  | "MONITORING"
  | "WAITING_FOR_5H_QUOTA"
  | "RESUME_QUEUED"
  | "RESUME_CONFIRMING"
  | "NEEDS_ATTENTION"
  | "DISABLED";

/**
 * 每轮检测生成一次不可变快照，供本轮所有已勾选会话共享决策。
 * 额度与会话采集时间差超过 FRESHNESS_TOLERANCE_MS 时，本轮视为 UNKNOWN（调用方负责置位）。
 */
export interface DetectionSnapshot {
  /** 本轮检测 id；每轮唯一，所有 watch 共享同一 cycleId。 */
  cycleId: string;
  /** 检测发起时刻（ISO 字符串）。 */
  detectedAt: string;
  /** 本轮 5 小时额度（一次检测只读取一次账户级额度）。 */
  fiveHourQuota: FiveHourQuotaState;
  /** 5 小时额度恢复时间（epoch ms）。仅用于决定何时尝试，不用于证明中断发生。 */
  quotaResetAt?: number;
  /** 本轮会话状态（按 threadId 查询并规范化）。 */
  sessionState: SessionState;
  /** 快照是否可信；不可信快照只写诊断，不迁移状态。 */
  trusted: boolean;
}

/** 持久化的可信中断证据；一旦生成，不得被 completed/stopped 标签清除。 */
export interface InterruptionLatch {
  /** 锁存 id；与 threadId 共同构成续跑幂等键（resumeAttemptId = sha256(threadId + latch.id)）。 */
  id: string;
  detectedAt: string;
  /** 触发锁存的那轮 cycleId。 */
  evidenceCycleId: string;
  /** 触发锁存前最后一次可信 RUNNING + POSITIVE 的 cycleId。 */
  previousRunningCycleId: string;
  quotaResetAt?: number;
}

/** 持久化的可信中断证据来源（设计 §4 的 armedByDetection）。 */
export interface ArmingEvidence {
  cycleId: string;
  detectedAt: string;
  /** 有效期截止（epoch ms）；过期即不可作为锁存依据。 */
  validUntil: number;
}

/** 持久化的 watch；schemaVersion=2。 */
export interface AutoResumeWatch {
  schemaVersion: 2;
  threadId: string;
  cwd: string;
  enabled: boolean;
  phase: WatchPhase;

  /** 每轮都写，用于诊断；UNKNOWN 也会记录，但不能充当迁移证据。 */
  lastObservation?: {
    cycleId: string;
    detectedAt: string;
    sessionState: SessionState;
    fiveHourQuota: FiveHourQuotaState;
    quotaResetAt?: number;
  };

  /** 只在同一可信快照同时满足 RUNNING + POSITIVE 时写入；跨进程持久化。 */
  armedByDetection?: ArmingEvidence;

  /** 一旦生成，在额度恢复并完成续跑决策前不得被 completed 标签覆盖。 */
  interruptionLatch?: InterruptionLatch;

  activeAttemptId?: string;
  resumeAttemptCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/** 单次续跑尝试（一次性、幂等执行；design §3.1）。 */
export interface ResumeAttempt {
  id: string;
  threadId: string;
  latchId: string;
  /** The watched project cwd; persisted so recovery cannot drift to a default cwd. */
  cwd: string;
  status: "QUEUED" | "SENDING" | "CONFIRMED" | "FAILED";
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

/** 额度规范化（设计 §3.3）。 */
export interface FiveHourQuota {
  state: FiveHourQuotaState;
  /** 仅当 state !== UNKNOWN 且窗口提供 reset 信息时存在。 */
  resetAt?: number;
  /** 仅当窗口身份明确时存在。 */
  windowDurationMins?: number;
  /** 窗口身份不明确的具体原因（诊断用）。 */
  unknownReason?: string;
}

/** reducer 的输出副作用；reducer 自身不执行任何命令。 */
export type AutoResumeCommand =
  | { type: "disable" }
  | { type: "create-latch"; latch: InterruptionLatch }
  | { type: "clear-latch" }
  | { type: "queue-resume"; attempt: ResumeAttempt };

/**
 * reducer 判定结果。
 * nextPhase 可能为 null：输入证据不足，保持当前 phase 且不产生命令。
 */
export interface TransitionDecision {
  nextPhase: WatchPhase | null;
  commands: AutoResumeCommand[];
  /** 本轮的不可信原因（诊断用；UNKNOWN 也会记录，但不能充当迁移证据）。 */
  staleReason?: string;
}

/** 已确认的 5 小时额度窗口（state !== UNKNOWN）在窗口身份不明时不产生；见 five-hour-quota.ts。 */
export const FIVE_HOUR_WINDOW_MINUTES = 300 as const;

/** arming 有效期：7 分钟，可容忍一轮采集失败，但不能让很久以前的 running 状态误触发。 */
export const ARMING_VALIDITY_MS = 7 * 60_000;
