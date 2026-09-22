import { describe, expect, it } from "vitest";
import { BACKOFF_MS, computeDelayUntilReset, nextBackoffMs } from "../src/reset-time.js";

describe("reset-time", () => {
  it("adds a 30 second buffer to resetsAt unix seconds", () => {
    expect(computeDelayUntilReset(1100, 1000_000)).toBe(130_000);
  });

  it("never returns a negative reset delay", () => {
    expect(computeDelayUntilReset(900, 1000_000)).toBe(30_000);
  });

  it("uses bounded exponential retry backoff", () => {
    expect(BACKOFF_MS).toEqual([30_000, 60_000, 120_000, 300_000]);
    expect(nextBackoffMs(0)).toBe(30_000);
    expect(nextBackoffMs(1)).toBe(60_000);
    expect(nextBackoffMs(2)).toBe(120_000);
    expect(nextBackoffMs(3)).toBe(300_000);
    expect(nextBackoffMs(99)).toBe(900_000);
  });
});
