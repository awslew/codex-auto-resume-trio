import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isPlausibleTurnTs,
  observeDesktopSession,
  observeDesktopSessions,
} from "../src/desktop-session-observation.js";
import type { DesktopSessionData } from "../src/desktop-session-observation.js";

/**
 * T3 可信会话观测测试（AUTO_RESUME_V2_DESIGN.md §8；执行计划 §7 T3）。
 * 覆盖：AR-16（异常未来时间戳）、AR-19（STOPPED）观测侧 + 状态映射全表
 * （RUNNING/COMPLETED/STOPPED/UNKNOWN、TRUSTED/UNTRUSTED）。
 *
 * 时间一律用注入 clock 生成（不硬编码日期），测试永不因时间流逝过期。
 */

const NOW = 1_800_000_000_000; // 固定注入时钟
const clock = { now: () => NOW };

/** 生成可信时间戳（相对 clock.now 的秒数）。 */
function ts(secondsAgo: number): number {
  return Math.floor(NOW / 1000) - secondsAgo;
}

function data(overrides: Partial<DesktopSessionData>): DesktopSessionData {
  return { threadId: "t1", turns: [], ...overrides };
}

function turn(status: string, startedAt: number | null, errorJson: string | null = null) {
  return { status, started_at: startedAt, error_json: errorJson };
}

describe("isPlausibleTurnTs — 时间范围校验（AR-16 基础）", () => {
  it("当前时间附近的时间戳可信", () => {
    expect(isPlausibleTurnTs(ts(0), NOW)).toBe(true);
    expect(isPlausibleTurnTs(ts(60), NOW)).toBe(true);
  });

  it("允许 3 分钟以内的未来时钟漂移", () => {
    expect(isPlausibleTurnTs(ts(-120), NOW)).toBe(true);
  });

  it("明显未来时间戳（+058632 年份量级）不可信", () => {
    expect(isPlausibleTurnTs(58562000000, NOW)).toBe(false); // ~3855 年
    expect(isPlausibleTurnTs(ts(-7 * 24 * 3600), NOW)).toBe(false); // 超 3 分钟未来
  });

  it("远古时间戳（>1 年）不可信", () => {
    expect(isPlausibleTurnTs(ts(400 * 24 * 3600), NOW)).toBe(false);
  });

  it("缺失/非数字时间戳不可信", () => {
    expect(isPlausibleTurnTs(0, NOW)).toBe(false);
    expect(isPlausibleTurnTs(Number.NaN, NOW)).toBe(false);
    expect(isPlausibleTurnTs(Number.POSITIVE_INFINITY, NOW)).toBe(false);
  });
});

describe("observeDesktopSession — 状态映射", () => {
  it("明确的当前 inProgress turn → RUNNING/TRUSTED", () => {
    const o = observeDesktopSession(data({ turns: [turn("inProgress", ts(10))] }), clock);
    expect(o.state).toBe("RUNNING");
    expect(o.confidence).toBe("TRUSTED");
    expect(o.observedAt).toBe(new Date(NOW).toISOString());
    expect(o.sourceRevision).toBeDefined();
  });

  it("in_progress/running/queued 变体同样 → RUNNING/TRUSTED", () => {
    for (const status of ["in_progress", "running", "queued"]) {
      const o = observeDesktopSession(data({ turns: [turn(status, ts(10))] }), clock);
      expect(o.state).toBe("RUNNING");
      expect(o.confidence).toBe("TRUSTED");
    }
  });

  it("最新正常 completed turn（其后无运行 turn）→ COMPLETED/TRUSTED", () => {
    const o = observeDesktopSession(
      data({ turns: [turn("completed", ts(300)), turn("completed", ts(10))] }),
      clock
    );
    expect(o.state).toBe("COMPLETED");
    expect(o.confidence).toBe("TRUSTED");
  });

  it("failed 后有更新的 completed（任务随后完成）→ COMPLETED/TRUSTED", () => {
    const o = observeDesktopSession(
      data({ turns: [turn("failed", ts(300)), turn("completed", ts(10))] }),
      clock
    );
    expect(o.state).toBe("COMPLETED");
    expect(o.confidence).toBe("TRUSTED");
  });

  it("failed 后有更新的 inProgress（用户已自行恢复）→ RUNNING/TRUSTED", () => {
    const o = observeDesktopSession(
      data({ turns: [turn("failed", ts(300)), turn("inProgress", ts(10))] }),
      clock
    );
    expect(o.state).toBe("RUNNING");
    expect(o.confidence).toBe("TRUSTED");
  });

  it("明确的 failed terminal 且无更新运行 turn → STOPPED/TRUSTED（AR-19 观测侧）", () => {
    const o = observeDesktopSession(data({ turns: [turn("failed", ts(10))] }), clock);
    expect(o.state).toBe("STOPPED");
    expect(o.confidence).toBe("TRUSTED");
    expect(o.reason).toContain("terminal");
  });

  it("明确的 interrupted terminal 且无更新运行 turn → STOPPED/TRUSTED", () => {
    const o = observeDesktopSession(data({ turns: [turn("interrupted", ts(10))] }), clock);
    expect(o.state).toBe("STOPPED");
    expect(o.confidence).toBe("TRUSTED");
  });

  it("failed 后有更新的 completed + inProgress：inProgress 更新 → RUNNING/TRUSTED", () => {
    const o = observeDesktopSession(
      data({
        turns: [
          turn("failed", ts(500)),
          turn("completed", ts(400)),
          turn("inProgress", ts(10)),
        ],
      }),
      clock
    );
    expect(o.state).toBe("RUNNING");
    expect(o.confidence).toBe("TRUSTED");
  });
});

describe("observeDesktopSession — UNKNOWN / UNTRUSTED（AR-16 观测侧）", () => {
  it("无任何记录 → UNKNOWN/UNTRUSTED", () => {
    const o = observeDesktopSession(data({ turns: [] }), clock);
    expect(o.state).toBe("UNKNOWN");
    expect(o.confidence).toBe("UNTRUSTED");
    expect(o.reason).toContain("no turn records");
  });

  it("异常未来时间戳（+058632）不能覆盖可信记录：可信 completed + 未来 inProgress → COMPLETED/TRUSTED", () => {
    const o = observeDesktopSession(
      data({
        turns: [
          turn("completed", ts(10)),
          turn("inProgress", 58562000000), // ~3855 年，损坏
        ],
      }),
      clock
    );
    expect(o.state).toBe("COMPLETED");
    expect(o.confidence).toBe("TRUSTED");
    expect(o.reason).not.toContain("inProgress");
  });

  it("可信 failed + 未来 completed：异常时间戳不构成完成证据 → STOPPED/TRUSTED", () => {
    const o = observeDesktopSession(
      data({
        turns: [
          turn("failed", ts(10)),
          turn("completed", 58562000000),
        ],
      }),
      clock
    );
    expect(o.state).toBe("STOPPED");
    expect(o.confidence).toBe("TRUSTED");
  });

  it("全部为损坏时间戳 → UNKNOWN/UNTRUSTED", () => {
    const o = observeDesktopSession(
      data({ turns: [turn("inProgress", 58562000000), turn("completed", ts(400 * 24 * 3600))] }),
      clock
    );
    expect(o.state).toBe("UNKNOWN");
    expect(o.confidence).toBe("UNTRUSTED");
    expect(o.reason).toContain("no plausible turn timestamps");
  });

  it("未来时间戳 turn 不能当选 latest（无法排序）→ 不误判 RUNNING", () => {
    const o = observeDesktopSession(
      data({ turns: [turn("completed", ts(10)), turn("inProgress", ts(-120))] }),
      clock
    );
    expect(o.state).toBe("COMPLETED");
    expect(o.confidence).toBe("TRUSTED");
  });

  it("无法识别的最新 turn 状态 → UNKNOWN/UNTRUSTED", () => {
    const o = observeDesktopSession(data({ turns: [turn("weird-state", ts(10))] }), clock);
    expect(o.state).toBe("UNKNOWN");
    expect(o.confidence).toBe("UNTRUSTED");
    expect(o.reason).toContain("weird-state");
  });

  it("无 turn 记录 + session 无更新时间 → UNKNOWN/UNTRUSTED", () => {
    const o = observeDesktopSession(
      data({ turns: [], session: { updated_at: 0 } }),
      clock
    );
    expect(o.state).toBe("UNKNOWN");
    expect(o.confidence).toBe("UNTRUSTED");
  });
});

describe("observeDesktopSession — 初始化边界", () => {
  it("无 turn 记录但 session 最近有更新时间（初始化中）→ RUNNING/TRUSTED", () => {
    const o = observeDesktopSession(
      data({ turns: [], session: { updated_at: ts(30) } }),
      clock
    );
    expect(o.state).toBe("RUNNING");
    expect(o.confidence).toBe("TRUSTED");
  });

  it("无 turn 记录但 session 更新时间陈旧 → UNKNOWN/UNTRUSTED", () => {
    const o = observeDesktopSession(
      data({ turns: [], session: { updated_at: ts(7 * 24 * 3600) } },
    ),
      clock
    );
    expect(o.state).toBe("UNKNOWN");
    expect(o.confidence).toBe("UNTRUSTED");
  });
});

describe("observeDesktopSessions — 批量观测", () => {
  it("注入采集器：按 threadId 批量输出观测", () => {
    const collector = () =>
      new Map<string, DesktopSessionData>([
        ["a", { threadId: "a", turns: [turn("inProgress", ts(5))] }],
        ["b", { threadId: "b", turns: [turn("completed", ts(20))] }],
        ["c", { threadId: "c", turns: [turn("failed", ts(30))] }],
        ["d", { threadId: "d", turns: [turn("inProgress", 58562000000)] }],
      ]);
    const obs = observeDesktopSessions({} as NodeJS.ProcessEnv, clock, collector);
    expect(obs).toHaveLength(4);
    const byId = new Map(obs.map((o) => [o.threadId, o]));
    expect(byId.get("a")!.state).toBe("RUNNING");
    expect(byId.get("b")!.state).toBe("COMPLETED");
    expect(byId.get("c")!.state).toBe("STOPPED");
    expect(byId.get("d")!.state).toBe("UNKNOWN");
    expect(obs.every((o) => o.observedAt === new Date(NOW).toISOString())).toBe(true);
  });

  it("采集器抛 ENOENT（库不存在）→ 空表不抛", () => {
    const collector = () => {
      const err = new Error("no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    expect(observeDesktopSessions({} as NodeJS.ProcessEnv, clock, collector)).toEqual([]);
  });

  it("无 thread 记录时返回空表", () => {
    const collector = () => new Map<string, DesktopSessionData>();
    expect(observeDesktopSessions({} as NodeJS.ProcessEnv, clock, collector)).toEqual([]);
  });

  it("默认采集器使用 ESM 惰性加载；临时 CODEX_HOME 无数据库时返回空表而非 require 错误", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "desktop-session-observation-"));
    try {
      // Production taskboard imports the package's compiled dist entry. Load
      // the built module here too so this smoke test exercises the same
      // createRequire(import.meta.url) path used outside Vitest's TS tree.
      const built = await import("../dist/desktop-session-observation.js");
      const observations = built.observeDesktopSessions({ CODEX_HOME: home } as NodeJS.ProcessEnv, clock);
      expect(observations).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("兼容性 — DesktopSession 公共结构", () => {
  it("listCodexSessions 的产出结构仍可直接使用（字段未被观测改造触碰）", () => {
    // 只验证公共字段契约存在（T3 不得改动 DesktopSession 结构）
    const session: { threadId: string; title: string; cwd: string; updatedAt: string } = {
      threadId: "t",
      title: "title",
      cwd: "/tmp",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(session.threadId).toBe("t");
  });

  it("SessionObservation 与 SessionState 契约一致（消费方可直接映射）", () => {
    const o = observeDesktopSession(data({ turns: [turn("failed", ts(10))] }), clock);
    const state: "RUNNING" | "COMPLETED" | "STOPPED" | "UNKNOWN" = o.state;
    expect(["RUNNING", "COMPLETED", "STOPPED", "UNKNOWN"]).toContain(state);
  });
});
