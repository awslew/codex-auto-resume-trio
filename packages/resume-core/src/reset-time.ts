import { RESET_BUFFER_MS } from "./constants.js";

export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const;
export const MAX_BACKOFF_MS = 900_000;

export function computeDelayUntilReset(resetsAtUnixSeconds: number, nowMs = Date.now()): number {
  return Math.max(RESET_BUFFER_MS, resetsAtUnixSeconds * 1000 - nowMs + RESET_BUFFER_MS);
}

export function nextRunAtFromReset(resetsAtUnixSeconds: number, nowMs = Date.now()): number {
  return nowMs + computeDelayUntilReset(resetsAtUnixSeconds, nowMs);
}

export function nextBackoffMs(retryCount: number): number {
  return BACKOFF_MS[retryCount] ?? MAX_BACKOFF_MS;
}
