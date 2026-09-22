import { describe, expect, it } from "vitest";
import { classifyRateLimit, extractResetAt } from "../src/rate-limit.js";

describe("rate limit classifier", () => {
  it("recognizes structured app-server rate limit states", () => {
    const result = classifyRateLimit({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, resetsAt: 1800000000 },
        rateLimitReachedType: "rate_limit_reached"
      }
    });

    expect(result.isRateLimit).toBe(true);
    expect(result.resetAt).toBe(1800000000);
  });

  it("recognizes usage quota errors without depending on one exact string", () => {
    const samples = [
      "Rate limit reached. Please try again later.",
      "You have exceeded your usage limit",
      "quota agotada; vuelve a intentarlo más tarde",
      "额度已用尽，请稍后再试",
      "лимит использования исчерпан"
    ];

    for (const sample of samples) {
      expect(classifyRateLimit(sample).isRateLimit).toBe(true);
    }
  });

  it("does not classify normal failures as quota failures", () => {
    expect(classifyRateLimit("TypeScript compilation failed").isRateLimit).toBe(false);
  });
});

describe("extractResetAt", () => {
  it("extracts the earliest reset timestamp from all windows", () => {
    expect(
      extractResetAt({
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: 2000 },
          secondary: { usedPercent: 95, resetsAt: 1500 }
        },
        rateLimitsByLimitId: {
          codex: { primary: { usedPercent: 100, resetsAt: 1700 } }
        }
      })
    ).toBe(1500);
  });
});
