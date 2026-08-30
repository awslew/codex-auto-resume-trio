import type { RateLimitResponse, RateLimitSnapshot } from "./types.js";

export type RateLimitClassification = {
  isRateLimit: boolean;
  resetAt?: number;
  reason?: string;
};

const TEXT_PATTERNS = [
  /\brate\s*limit(?:ed)?\b/i,
  /\bquota\b/i,
  /\busage\s+limit\b/i,
  /\bexceeded\b.*\b(limit|quota)\b/i,
  /\btry again later\b/i,
  /额度|限额|配额|用尽/,
  /лимит|квот|исчерпан/i,
  /cuota|agotad|límite/i
];

export function classifyRateLimit(input: unknown): RateLimitClassification {
  const resetAt = extractResetAt(input);
  if (hasReachedStructuredLimit(input)) {
    return { isRateLimit: true, resetAt, reason: "structured rate limit" };
  }

  const text = typeof input === "string" ? input : collectText(input).join(" ");
  if (TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { isRateLimit: true, resetAt, reason: "quota text" };
  }

  return { isRateLimit: false, resetAt };
}

export function extractResetAt(input: unknown): number | undefined {
  const values: number[] = [];
  walk(input, (key, value) => {
    if (key === "resetsAt" && typeof value === "number" && Number.isFinite(value) && value > 0) {
      values.push(value);
    }
    if (key === "reset_at" && typeof value === "number" && Number.isFinite(value) && value > 0) {
      values.push(value);
    }
  });
  return values.length > 0 ? Math.min(...values) : undefined;
}

function hasReachedStructuredLimit(input: unknown): boolean {
  const snapshots = collectSnapshots(input);
  return snapshots.some((snapshot) => {
    if (snapshot.rateLimitReachedType) {
      return true;
    }
    return [snapshot.primary, snapshot.secondary].some((window) => {
      return Boolean(window && typeof window.usedPercent === "number" && window.usedPercent >= 100);
    });
  });
}

function collectSnapshots(input: unknown): RateLimitSnapshot[] {
  const response = input as RateLimitResponse;
  const snapshots: RateLimitSnapshot[] = [];
  if (isObject(response.rateLimits)) {
    snapshots.push(response.rateLimits as RateLimitSnapshot);
  }
  if (isObject(response.rateLimitsByLimitId)) {
    for (const value of Object.values(response.rateLimitsByLimitId)) {
      if (isObject(value)) {
        snapshots.push(value as RateLimitSnapshot);
      }
    }
  }
  if (isObject(input) && ("primary" in input || "secondary" in input || "rateLimitReachedType" in input)) {
    snapshots.push(input as RateLimitSnapshot);
  }
  return snapshots;
}

function collectText(input: unknown): string[] {
  const values: string[] = [];
  walk(input, (_key, value) => {
    if (typeof value === "string") {
      values.push(value);
    }
  });
  return values;
}

function walk(input: unknown, visitor: (key: string, value: unknown) => void): void {
  if (!isObject(input)) {
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    visitor(key, value);
    if (isObject(value)) {
      walk(value, visitor);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, visitor);
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
