import { describe, expect, it, vi } from "vitest";
import { createFixedRateScheduler } from "../src/fixed-rate-scheduler.js";
import { AUTO_RESUME_DETECTION_INTERVAL_MS } from "../src/constants.js";

/**
 * T2 fixed-rate 调度器测试（AUTO_RESUME_V2_DESIGN.md §7；执行计划 §4.4）。
 * 覆盖：启动立即检测一次、fixed-rate 180 秒节拍、重叠轮次 SKIPPED_OVERLAP
 * （不并发、不补跑）、detect 抛错不影响后续节拍。
 */

type Report = { cycleId: string; quotaOk: boolean; watchOutcomes: never[]; resumedCount: number; skippedOverlapCount: number };

/** 手动驱动节拍：记录回调由测试触发；返回 { clearCalled } 句柄。 */
function makeTimer(fired: (() => void)[]) {
  return {
    impl(fn: () => void) {
      fired.push(fn);
      return { clear: () => {} };
    },
  };
}

/** 等待调度器内部 runOne 结束（本轮事件循环内的微任务/宏任务收敛）。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("fixed-rate-scheduler — 立即首跑、180s 节拍与 overlap skip", () => {
  it("启动后立即检测一次；之后每次 tick 间隔恰好 180_000ms（fixed-rate）", async () => {
    let calls = 0;
    const detect = (): Promise<Report> => {
      calls++;
      return Promise.resolve({ cycleId: `c${calls}`, quotaOk: true, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 0 });
    };
    const ticks: number[] = [];
    let clearCalled = false;
    const timer = {
      impl(fn: () => void, ms: number) {
        ticks.push(ms);
        return { clear: () => { clearCalled = true; } };
      },
    };

    const sched = createFixedRateScheduler({ detect, timer: timer.impl });
    await sched.start();
    expect(calls).toBe(1); // 立即一次。
    expect(ticks).toEqual([AUTO_RESUME_DETECTION_INTERVAL_MS]); // 精确 180_000ms。
    expect(sched.running).toBe(true);
    sched.stop();
    expect(clearCalled).toBe(true);
    expect(sched.running).toBe(false);
  });

  it("上一轮未结束 → 到达节拍时记为 SKIPPED_OVERLAP，不并发、不补跑", async () => {
    let release: () => void = () => {};
    let slowCalls = 0;
    const slowDetect = (): Promise<Report> =>
      new Promise((resolve) => {
        slowCalls++;
        if (slowCalls !== 2) {
          resolve({ cycleId: `c${slowCalls}`, quotaOk: true, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 0 }); // 第 1、3 轮立即完成。
          return;
        }
        release = () => resolve({ cycleId: "c2", quotaOk: true, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 0 }); // 第 2 轮卡住。
      });
    const fired: (() => void)[] = [];
    const timer = makeTimer(fired);

    const sched = createFixedRateScheduler({ detect: slowDetect, timer: timer.impl });
    await sched.start(); // 首轮完成。
    expect(slowCalls).toBe(1);
    const tick = fired[0]!; // setInterval 只注册一次；同一回调反复触发。

    // 节拍 1：启动第二轮并卡住（active）。
    tick();
    expect(slowCalls).toBe(2);

    // 节拍 2 到达：上一轮仍在运行 → SKIPPED_OVERLAP，不启动第三轮。
    tick();
    expect(sched.lastReport()!.cycleId).toBe("skipped");
    expect(sched.lastReport()!.skippedOverlapCount).toBe(1);
    expect(slowCalls).toBe(2); // 不并发。

    // 释放第二轮 → 不补跑；下一节拍才正常触发。
    release();
    await flush();
    expect(slowCalls).toBe(2);
    tick();
    await flush(); // runOne 是异步的：等其完成（c3 resolve）。
    expect(slowCalls).toBe(3);
    expect(sched.lastReport()!.cycleId).toBe("c3");
    sched.stop();
  });

  it("重叠后恢复：下一节拍继续正常检测（SKIPPED_OVERLAP 只记一次）", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const detect = (): Promise<Report> =>
      new Promise((resolve) => {
        calls++;
        if (calls === 1) {
          resolve({ cycleId: "c1", quotaOk: true, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 0 });
          return;
        }
        if (calls === 2) {
          release = () => resolve({ cycleId: "c2", quotaOk: true, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 0 });
          return;
        }
        resolve({ cycleId: `c${calls}`, quotaOk: true, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 0 });
      });
    const fired: (() => void)[] = [];
    const timer = makeTimer(fired);

    const sched = createFixedRateScheduler({ detect, timer: timer.impl });
    await sched.start();
    expect(calls).toBe(1);
    const tick = fired[0]!;

    // 节拍 1：第二轮卡住（active）。
    tick();
    expect(calls).toBe(2);
    // 节拍 2 到达时上一轮仍卡住 → skipped。
    tick();
    expect(sched.lastReport()!.cycleId).toBe("skipped");
    release();
    await flush();
    expect(calls).toBe(2); // 不补跑。

    // 节拍 3：上一轮已结束 → 正常触发一轮。
    tick();
    await flush(); // runOne 是异步的：等其完成。
    expect(calls).toBe(3);
    expect(sched.lastReport()!.cycleId).toBe("c3");
    sched.stop();
  });

  it("detect 抛错 → lastReport 记录 error，不影响后续节拍", async () => {
    let calls = 0;
    const detect = async (): Promise<Report> => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return { cycleId: "c2", quotaOk: true, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 0 };
    };
    const fired: (() => void)[] = [];
    const timer = makeTimer(fired);

    const sched = createFixedRateScheduler({ detect, timer: timer.impl });
    await sched.start();
    expect((sched.lastReport() as { error?: string }).error).toBe("boom");

    fired.shift()!(); // 下一节拍。
    await flush();
    expect(calls).toBe(2);
    expect(sched.lastReport()!.cycleId).toBe("c2");
    sched.stop();
  });

  it("公开 tickNow 遵守 overlap/stop；无 custom clear 时回退到原生 clearInterval", async () => {
    let calls = 0;
    const detect = async (): Promise<Report> => ({ cycleId: `c${++calls}`, quotaOk: true, watchOutcomes: [], resumedCount: 0, skippedOverlapCount: 0 });
    const fired: (() => void)[] = [];
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const sched = createFixedRateScheduler({
        detect,
        timer: (fn) => {
          fired.push(fn);
          return 17;
        },
      });
      await sched.start();
      expect((await sched.tickNow()).cycleId).toBe("c2");
      sched.stop();
      expect(clearSpy).toHaveBeenCalled();
      fired[0]!();
      await flush();
      expect(calls).toBe(2); // stop 后手动触发已注册 callback 也不再检测。
    } finally {
      clearSpy.mockRestore();
    }
  });
});
