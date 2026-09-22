import type { FiveHourQuota, FiveHourQuotaState } from "./auto-resume-types.js";
import { FIVE_HOUR_WINDOW_MINUTES } from "./auto-resume-types.js";
import type { RateLimitResponse } from "./types.js";

/**
 * 5 小时额度识别与规范化（AUTO_RESUME_V2_DESIGN.md §3.3）。
 *
 * 铁律：只有 `windowDurationMins === 300` 或 limitId/limitName 明确含
 * 5h / 5 hour / five hour 等 5 小时标识才可识别；单独 daily 必须 UNKNOWN；
 * 不得用通用 usage-limit 文案猜测 5 小时窗口。
 */

/** 明确 5 小时窗口的 limit id/name 模式（不区分大小写、容忍空白；双侧词边界，如 codex-5h 匹配、x5h 不匹配）。 */
const FIVE_HOUR_ID_PATTERN = /\b5\s*h(?:ours?)?\b/i;
/** 明确的 “five hour(s)” 文案（日常语言写法）。 */
const FIVE_HOUR_TEXT_PATTERN = /\bfive\s*hours?\b/i;

function windowNameHasFiveHour(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  return FIVE_HOUR_ID_PATTERN.test(normalized) || FIVE_HOUR_TEXT_PATTERN.test(normalized);
}

function snapshotHasExplicitFiveHourWindow(snapshot: { limitId?: string | null; limitName?: string | null }): boolean {
  return windowNameHasFiveHour(snapshot.limitId) || windowNameHasFiveHour(snapshot.limitName);
}

function collectSnapshots(response: RateLimitResponse): RateLimitSnapshotLike[] {
  const snapshots: RateLimitSnapshotLike[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "object" && value !== null) {
      snapshots.push(value as RateLimitSnapshotLike);
    }
  };
  push(response.rateLimits);
  if (typeof response.rateLimitsByLimitId === "object" && response.rateLimitsByLimitId !== null) {
    for (const value of Object.values(response.rateLimitsByLimitId)) {
      push(value);
    }
  }
  return snapshots;
}

interface RateLimitWindowLike {
  usedPercent?: number;
  windowDurationMins?: number | null;
}

interface RateLimitSnapshotLike extends RateLimitWindowLike {
  limitId?: string | null;
  limitName?: string | null;
}

/**
 * 从一轮账户级 rateLimits 响应中识别 5 小时窗口并规范化。
 *
 * 窗口识别优先级：
 *   1. `windowDurationMins === 300`（任一 snapshot 的 primary/secondary 窗口）；
 *   2. 官方结构化字段中明确标识 5 小时窗口的 limitId/limitName（不依赖通用文案）；
 *   3. 两者都没有时 UNKNOWN（不创建 latch、不取消 watch）。单独 daily 窗口在此列。
 *
 * usedPercent 规范化：finite(usedPercent) && >= 100 => ZERO；finite && < 100 => POSITIVE。
 */
export function normalizeFiveHourQuota(response: RateLimitResponse | null | undefined): FiveHourQuota {
  if (!response) {
    return { state: "UNKNOWN", unknownReason: "missing response" };
  }

  const snapshots = collectSnapshots(response);

  // 优先：任意窗口 windowDurationMins === 300（5 小时窗口最明确的结构证据）。
  const exactDuration = snapshots
    .flatMap((snapshot) => [snapshot, (snapshot as { primary?: unknown }).primary, (snapshot as { secondary?: unknown }).secondary] as const)
    .find(isExactDurationWindow);
  if (exactDuration) {
    return quotaFromWindow(exactDuration);
  }

  // 其次：limitId/limitName 明确标识 5 小时窗口的 snapshot。
  const fiveHourSnapshot = snapshots.find(snapshotHasExplicitFiveHourWindow);
  if (fiveHourSnapshot) {
    const window = pickPrimary(fiveHourSnapshot);
    return quotaFromWindow(window ?? fiveHourSnapshot);
  }

  return { state: "UNKNOWN", unknownReason: "no explicit five-hour window" };
}

function isExactDurationWindow(value: unknown): value is RateLimitWindowLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const window = value as RateLimitWindowLike;
  return window.windowDurationMins === FIVE_HOUR_WINDOW_MINUTES;
}

function pickPrimary(snapshot: RateLimitSnapshotLike): RateLimitWindowLike | null | undefined {
  if (typeof snapshot !== "object" || snapshot === null) {
    return undefined;
  }
  return (snapshot as { primary?: unknown }).primary as RateLimitWindowLike | null | undefined;
}

function quotaFromWindow(window: RateLimitWindowLike): FiveHourQuota {
  const usedPercent = window?.usedPercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return { state: "UNKNOWN", unknownReason: "usedPercent missing or non-finite" };
  }
  const resetAt = extractResetAt(window);
  if (usedPercent >= 100) {
    return { state: "ZERO", resetAt, windowDurationMins: FIVE_HOUR_WINDOW_MINUTES };
  }
  return { state: "POSITIVE", resetAt, windowDurationMins: FIVE_HOUR_WINDOW_MINUTES };
}

function extractResetAt(window: RateLimitWindowLike): number | undefined {
  const value = (window as { resetsAt?: unknown }).resetsAt;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  return undefined;
}

/** 仅用于测试与诊断的类型收窄辅助。 */
export function isFiveHourQuotaState(value: unknown): value is FiveHourQuotaState {
  return value === "POSITIVE" || value === "ZERO" || value === "UNKNOWN";
}
