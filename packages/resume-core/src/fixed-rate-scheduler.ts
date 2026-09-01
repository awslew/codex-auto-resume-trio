import type { MonitorReport } from "./auto-resume-monitor.js";
import { AUTO_RESUME_DETECTION_INTERVAL_MS } from "./constants.js";

/**
 * fixed-rate 180 秒调度器（AUTO_RESUME_V2_DESIGN.md §7；执行计划 §4.4）。
 *
 * 语义：
 * - 启动后立即检测一次，之后按 fixed-rate 每 180 秒一个检测时点。
 * - 同一进程最多一轮在运行；到达检测时点而上一轮未结束时，本次记为
 *   SKIPPED_OVERLAP，不并发、不补跑；下一次仍在后续 180 秒边界触发。
 * - 只负责“触发”，不负责迁移决策（决策在 monitor 内完成）。
 *
 * 可注入：timer（默认 setInterval）、clock（默认真实时钟）、检测函数。
 * 默认 sender 为空实现——本模块绝不真实发送（真实发送由 T4 注入）。
 */

export type DetectionFn = () => Promise<MonitorReport>;

export interface TimerLike {
  (fn: () => void, ms: number): unknown;
}

export interface SchedulerHandle {
  /** 启动：立即一次 + 按 interval 固定节拍。 */
  start(): Promise<void>;
  /** 停止：不再触发新轮次；进行中的一轮允许跑完（不打断）。 */
  stop(): void;
  /** 立即触发一轮；与 fixed-rate 轮次共享 overlap/stop 语义。 */
  tickNow(): Promise<MonitorReport>;
  readonly running: boolean;
  /** 最近一轮结果（诊断用）。 */
  lastReport(): MonitorReport | undefined;
}

export interface FixedRateSchedulerOptions {
  detect: DetectionFn;
  intervalMs?: number;
  timer?: TimerLike;
  clock?: { now: () => number };
  /** 手动触发一轮（测试用）：不等节拍，立即执行；与节拍轮次互斥。 */
  tickNow?(): Promise<MonitorReport>;
}

export function createFixedRateScheduler(options: FixedRateSchedulerOptions): SchedulerHandle {
  const intervalMs = options.intervalMs ?? AUTO_RESUME_DETECTION_INTERVAL_MS;
  const timerImpl = options.timer ?? ((fn, ms) => setInterval(fn, ms));
  let timerHandle: unknown | undefined;
  let active = false;
  let stopped = false;
  let last: MonitorReport | undefined;
  let runningFlag = false;

  async function runOne(): Promise<void> {
    if (stopped) return;
    if (active) {
      // 上一轮未结束：记为 SKIPPED_OVERLAP，不并发、不补跑。
      last = {
        cycleId: "skipped",
        quotaOk: false,
        watchOutcomes: [],
        resumedCount: 0,
        skippedOverlapCount: 1,
      };
      return;
    }
    active = true;
    try {
      last = await options.detect();
    } catch (error) {
      last = {
        cycleId: "error",
        quotaOk: false,
        watchOutcomes: [],
        resumedCount: 0,
        skippedOverlapCount: 0,
        error: error instanceof Error ? error.message : String(error),
      } as unknown as MonitorReport;
    } finally {
      active = false;
    }
  }

  function clearTimer(handle: unknown): void {
    if (handle === undefined || handle === null) return;
    if (typeof (handle as { clear?: unknown }).clear === "function") {
      (handle as { clear: () => void }).clear();
      return;
    }
    // Native setInterval returns a Timeout object in Node and a numeric handle
    // in browsers.  Injected timers may omit a custom clear method, so use the
    // platform primitive for the native-compatible handle as a fallback.
    clearInterval(handle as ReturnType<typeof setInterval>);
  }

  return {
    get running() {
      return runningFlag;
    },
    start: async () => {
      await runOne(); // 立即一次。
      if (stopped) return;
      timerHandle = timerImpl(() => void runOne(), intervalMs);
      runningFlag = true;
    },
    stop: () => {
      stopped = true;
      runningFlag = false;
      clearTimer(timerHandle);
      timerHandle = undefined;
    },
    tickNow: async () => {
      await runOne();
      if (last === undefined) throw new Error("scheduler has not produced a report");
      return last;
    },
    lastReport: () => last,
  };
}
