import { describe, expect, it } from "vitest";
import { normalizeFiveHourQuota } from "../src/five-hour-quota.js";
import type { RateLimitResponse } from "../src/types.js";

/**
 * 5 小时额度识别表驱动测试（AUTO_RESUME_V2_DESIGN.md §3.3；执行计划 §7 T1）。
 * 覆盖：300 分钟窗口、官方 5h limit id/name、周额度隔离、字段缺失、通用 usage-limit 文案。
 */

describe("normalizeFiveHourQuota — 5 小时窗口识别", () => {
  it("windowDurationMins===300 的 primary 窗口 → 按 5h 处理", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1800000000 },
        secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 1800000000 + 86400 },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("POSITIVE");
    expect(quota.windowDurationMins).toBe(300);
  });

  it("windowDurationMins===300 且 usedPercent===100 → ZERO", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300 },
      },
    };
    expect(normalizeFiveHourQuota(response).state).toBe("ZERO");
  });

  it("明确 5h limitId（rateLimitsByLimitId 内）→ 按 5h 处理", () => {
    const response: RateLimitResponse = {
      rateLimitsByLimitId: {
        codex: { limitId: "codex", primary: { usedPercent: 30, windowDurationMins: 10080 } },
        "codex-5h": { limitId: "codex-5h", primary: { usedPercent: 50 } },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("POSITIVE");
    expect(quota.windowDurationMins).toBe(300);
  });

  it("明确 5h limitName（如 “5 hours daily”）→ 按 5h 处理", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        limitName: "5 hours daily",
        primary: { usedPercent: 99 },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("POSITIVE");
    expect(quota.windowDurationMins).toBe(300);
  });

  it("反例：单独 daily limitName（无 5h 标识）→ UNKNOWN，即使 usedPercent===100", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        limitName: "daily",
        primary: { usedPercent: 100 },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("UNKNOWN");
    expect(quota.unknownReason).toBeTruthy();
  });

  it("反例：daily limitId，无 5h 标识，仅周窗口有明确时长 → UNKNOWN（daily 本身不是 5h 证据）", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        limitId: "codex-daily",
        primary: { usedPercent: 100, windowDurationMins: 10080 },
        secondary: { usedPercent: 100 },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("UNKNOWN");
  });

  it("five hour 全词 → 按 5h 处理", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        limitName: "five hour",
        primary: { usedPercent: 42 },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("POSITIVE");
    expect(quota.windowDurationMins).toBe(300);
  });

  it("AR-10 输入：周额度 ZERO 但 5h POSITIVE → 识别为 5h POSITIVE（周额度隔离）", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 10080 },
        secondary: { usedPercent: 10, windowDurationMins: 300 },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("POSITIVE");
    expect(quota.windowDurationMins).toBe(300);
  });

  it("周额度 ZERO 且无任何 5h 窗口 → UNKNOWN（不误判为 5h ZERO）", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 10080 },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("UNKNOWN");
    expect(quota.unknownReason).toBeTruthy();
  });

  it("usedPercent 缺失 → UNKNOWN，不把缺失当 0", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 10080 },
        secondary: { windowDurationMins: 300 },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("UNKNOWN");
  });

  it("非有限 usedPercent（NaN/Infinity）→ UNKNOWN", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        primary: { usedPercent: Number.NaN, windowDurationMins: 300 },
      },
    };
    expect(normalizeFiveHourQuota(response).state).toBe("UNKNOWN");
  });

  it("AR-11: 字段缺失（无 rateLimits、无 rateLimitsByLimitId）→ UNKNOWN", () => {
    const quota = normalizeFiveHourQuota({});
    expect(quota.state).toBe("UNKNOWN");
    expect(quota.unknownReason).toBeTruthy();
  });

  it("AR-11: 通用 usage-limit 文案（字符串/rateLimitReachedType）→ UNKNOWN，不猜 5h", () => {
    const quota = normalizeFiveHourQuota({ rateLimits: { rateLimitReachedType: "usage_limit_reached" } });
    expect(quota.state).toBe("UNKNOWN");
  });

  it("null/undefined 响应 → UNKNOWN", () => {
    expect(normalizeFiveHourQuota(null).state).toBe("UNKNOWN");
    expect(normalizeFiveHourQuota(undefined).state).toBe("UNKNOWN");
  });

  it("usedPercent===0 表示额度充足 → POSITIVE", () => {
    const response: RateLimitResponse = {
      rateLimits: {
        primary: { usedPercent: 0, windowDurationMins: 300 },
      },
    };
    const quota = normalizeFiveHourQuota(response);
    expect(quota.state).toBe("POSITIVE");
    expect(quota.resetAt).toBeUndefined();
  });
});
