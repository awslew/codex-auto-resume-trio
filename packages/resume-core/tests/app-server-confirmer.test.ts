import { describe, expect, it, vi } from "vitest";

// vitest 2.1.9 不认识 node:sqlite（Node 22.5+ 内置模块）；本测试注入 collector，
// 不触碰真实会话库，mock 掉即可。
vi.mock("node:sqlite", () => ({ DatabaseSync: class {} }));

import { createAppServerConfirmer } from "../src/app-server/auto-resume-adapter.js";
import type { DesktopSessionData } from "../src/desktop-session-observation.js";
import type { ResumeAttempt } from "../src/auto-resume-types.js";

// isPlausibleTurnTs 以真实当前时间为基准做可信校验，fixture 必须用动态时间。
const NOW = Date.now();

function makeAttempt(createdAt = new Date(NOW).toISOString()): ResumeAttempt {
  return {
    id: "a1",
    threadId: "t1",
    latchId: "l1",
    cwd: "C:/work/demo",
    status: "QUEUED",
    failureCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

function collectorWith(turns: Array<{ status: string; started_at: number | null }>) {
  const data = new Map<string, DesktopSessionData>([["t1", { threadId: "t1", turns }]]);
  return (): Map<string, DesktopSessionData> => data;
}

describe("createAppServerConfirmer — 会话库三态确认（2026-09-06 长任务 fire-and-forget 回归）", () => {
  it("attempt 之后有 inProgress turn → CONFIRMED（turn 运行中即已生效）", async () => {
    const confirmer = createAppServerConfirmer({
      collector: collectorWith([{ status: "inProgress", started_at: NOW / 1000 + 30 }]),
    });
    const result = await confirmer.confirm(makeAttempt());
    expect(result.state).toBe("CONFIRMED");
  });

  it("attempt 之后有 completed turn → CONFIRMED（已完整跑完）", async () => {
    const confirmer = createAppServerConfirmer({
      collector: collectorWith([{ status: "completed", started_at: NOW / 1000 + 120 }]),
    });
    const result = await confirmer.confirm(makeAttempt());
    expect(result.state).toBe("CONFIRMED");
  });

  it("attempt 之后无任何更晚 turn → NOT_STARTED（可安全补发）", async () => {
    const confirmer = createAppServerConfirmer({
      collector: collectorWith([{ status: "completed", started_at: NOW / 1000 - 600 }]),
    });
    const result = await confirmer.confirm(makeAttempt());
    expect(result.state).toBe("NOT_STARTED");
  });

  it("attempt 之后最新 turn 为 failed → UNKNOWN（绝不冒充成功，保留 outbox 待人工）", async () => {
    const confirmer = createAppServerConfirmer({
      collector: collectorWith([{ status: "failed", started_at: NOW / 1000 + 30 }]),
    });
    const result = await confirmer.confirm(makeAttempt());
    expect(result.state).toBe("UNKNOWN");
  });

  it("attempt 之后的异常未来时间戳 turn 不参与判定（可信时间校验）", async () => {
    const confirmer = createAppServerConfirmer({
      collector: collectorWith([{ status: "inProgress", started_at: Math.floor(NOW / 1000) + 366 * 24 * 3600 }]),
    });
    const result = await confirmer.confirm(makeAttempt());
    expect(result.state).toBe("NOT_STARTED");
  });

  it("collector 抛错 → UNKNOWN（fail-closed）", async () => {
    const confirmer = createAppServerConfirmer({
      collector: () => {
        throw new Error("db locked");
      },
    });
    const result = await confirmer.confirm(makeAttempt());
    expect(result.state).toBe("UNKNOWN");
    expect(result.reason).toContain("db locked");
  });
});
