import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWatchStore } from "../src/auto-resume-store.js";
import { createMonitor, newCycleId } from "../src/auto-resume-monitor.js";
import { createAttemptOutbox } from "../src/resume-attempt.js";
import { createAppServerQuotaReader, createAppServerSender, createAppServerConfirmer } from "../src/app-server/auto-resume-adapter.js";
import type { AutoResumeWatch } from "../src/auto-resume-types.js";

/**
 * T6 V2 集成测试（AUTO_RESUME_V2_EXECUTION_PLAN.md §7 T6；AUTO_RESUME_V2_DESIGN.md §9）。
 * 生产 adapter ↔ 伪 Codex app-server（fixtures/fake-codex.js）整链：
 * - 结构化 5h 额度识别：300 分钟窗口 → POSITIVE/ZERO；周窗口 → 不误判 5h；缺失 → UNKNOWN。
 * - 发送前额度复核：ZERO → quotaBlocked 不计技术失败；UNKNOWN → fail-closed 拒绝发送。
 * - 勾选 → arming → 归零锁存 → 恢复 → 恰好一次发送 → confirmation UNKNOWN → NEEDS_ATTENTION。
 * - shadow：≥2 个 fake-clock 180 秒周期，决策/状态可记录但发送恒为 0。
 *
 * 注入边界：全部走临时目录与伪进程（FAKE_CODEX_*），绝不接触真实 LOCALAPPDATA / Codex。
 */

const fixture = fileURLToPath(new URL("./fixtures/fake-codex.js", import.meta.url));

/** V2 状态机基准时间（与既有 T1/T2 测试一致）。 */
const T0 = 1_800_000_000_000;
const STEP_MS = 180_000;

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  // Windows 上伪 app-server 子进程退出后仍短暂持有 cwd 句柄 → EBUSY；
  // 小步重试（仅测试清理，避免引入基线之外的 EBUSY 失败）。
  for (const dir of dirs) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  dirs.length = 0;
});

/** 组装 AppServerClient 可注入的 fake-codex 子进程选项。 */
function fakeCodexOptions(mode: string, extra: Record<string, string> = {}) {
  return {
    codexBin: process.execPath,
    codexArgsPrefix: [fixture],
    cwd: "", // 由调用方覆盖为真实存在的临时目录（spawn cwd 必须存在）
    env: { FAKE_CODEX_MODE: mode, ...extra },
  };
}

function makeWatch(overrides: Partial<AutoResumeWatch> = {}): AutoResumeWatch {
  return {
    schemaVersion: 2,
    threadId: "thread-1",
    cwd: "C:\\work\\demo",
    enabled: true,
    phase: "MONITORING",
    resumeAttemptCount: 0,
    createdAt: new Date(T0 - 60_000).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

describe("T6 production adapter ↔ fake app-server", () => {
  it("AR-09: 300 分钟窗口 → POSITIVE/ZERO；周窗口不误判；缺失 → UNKNOWN（结构化识别）", async () => {
    const cwd = await tempDir("ar6-quota-cwd-");
    const cases: Array<{ mode: string; expectState: "POSITIVE" | "ZERO" | "UNKNOWN" }> = [
      { mode: "appserver-v2-positive", expectState: "POSITIVE" },
      { mode: "appserver-v2-zero", expectState: "ZERO" },
      // 周窗口（10080）在 primary、5h（300）在 secondary：仍识别 5h 窗口（POSITIVE）。
      { mode: "appserver-v2-weekzero5hpositive", expectState: "POSITIVE" },
      // 只有周窗口、无任何 300 分钟窗口：必须 UNKNOWN，绝不误判 5h 归零。
      { mode: "appserver-v2-missing", expectState: "UNKNOWN" },
    ];
    for (const { mode, expectState } of cases) {
      const quotaReader = createAppServerQuotaReader({ ...fakeCodexOptions(mode), cwd });
      const quota = await quotaReader();
      expect(quota.state).toBe(expectState);
    }
  });

  it("AR-11: 发送前额度复核——ZERO → quotaBlocked 不计技术失败；UNKNOWN → fail-closed 拒绝发送", async () => {
    const cwd = await tempDir("ar6-send-cwd-");
    const countsPath = path.join(cwd, "fake-counts.json");

    // ZERO：明确 5h 已耗尽 → 不发送（thread/resume 与 turn/start 均为 0），quotaBlocked。
    const zeroSender = createAppServerSender({ ...fakeCodexOptions("appserver-v2-zero", { FAKE_CODEX_COUNTS: countsPath }), cwd });
    const zeroOutcome = await zeroSender.send(
      { id: "a1", threadId: "thread-1", latchId: "latch-1", cwd, status: "QUEUED", failureCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { threadId: "thread-1", cwd }
    );
    expect(zeroOutcome.ok).toBe(false);
    expect(zeroOutcome.quotaBlocked).toBe(true);
    await expect(readFile(countsPath, "utf8").then((raw) => JSON.parse(raw))).rejects.toThrow(); // 计数文件从未写入 → 0 发送

    // UNKNOWN（只有周窗口）：无法确认 5h 可用 → 拒绝发送（fail-closed）。
    const missingSender = createAppServerSender({ ...fakeCodexOptions("appserver-v2-missing", { FAKE_CODEX_COUNTS: countsPath }), cwd });
    const missingOutcome = await missingSender.send(
      { id: "a2", threadId: "thread-2", latchId: "latch-2", cwd, status: "QUEUED", failureCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { threadId: "thread-2", cwd }
    );
    expect(missingOutcome.ok).toBe(false);
    expect(missingOutcome.quotaBlocked).toBeUndefined();
    expect(missingOutcome.error).toContain("not identifiable before send");
    await expect(readFile(countsPath, "utf8").then((raw) => JSON.parse(raw))).rejects.toThrow();
  });

  it("AR-15: 发送成功路径——POSITIVE 复核通过，thread/resume + turn/start 恰好各 1 次；turn/completed 证据 → confirmed", async () => {
    const cwd = await tempDir("ar6-send-ok-cwd-");
    const countsPath = path.join(cwd, "fake-counts.json");
    const sender = createAppServerSender({ ...fakeCodexOptions("appserver-v2-positive", { FAKE_CODEX_COUNTS: countsPath }), cwd });
    const outcome = await sender.send(
      { id: "a1", threadId: "thread-1", latchId: "latch-1", cwd, status: "QUEUED", failureCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { threadId: "thread-1", cwd }
    );
    expect(outcome.ok).toBe(true);
    // 决策A：fake 在 turn/start 后 10ms 回发 turn/completed（thread-app）→ sender 等到
    // 同 thread 完成证据 → 发送结果必须带 confirmed:true（outbox 据此写 confirmedAt、
    // monitor 同轮收敛，绝不把正常发送丢进 NEEDS_ATTENTION）。
    expect(outcome.confirmed).toBe(true);
    const counts = JSON.parse(await readFile(countsPath, "utf8"));
    expect(counts.threadResume).toBe(1);
    expect(counts.turnStart).toBe(1);
  });

  it("confirmer 恒定 UNKNOWN（fail-closed，绝不冒充 NOT_STARTED/CONFIRMED）", async () => {
    const cwd = await tempDir("ar6-conf-cwd-");
    const confirmer = createAppServerConfirmer({ cwd });
    const result = await confirmer.confirm({
      id: "a1", threadId: "thread-1", latchId: "latch-1", cwd, status: "QUEUED", failureCount: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    expect(result.state).toBe("UNKNOWN");
  });

  it("决策A: 整链 CONFIRMED 收敛——生产 sender 等到 turn/completed → outbox 写 confirmedAt → monitor 同轮清 latch+activeAttempt+outbox → MONITORING；下一轮可信 COMPLETED+POSITIVE → disable", async () => {
    const stateDir = await tempDir("ar6-confirmed-state-");
    const cwd = await tempDir("ar6-confirmed-cwd-");
    const quotaFile = path.join(stateDir, "quota.json");
    const countsPath = path.join(cwd, "fake-counts.json");
    await writeFile(quotaFile, JSON.stringify({ usedPercent: 30, windowDurationMins: 300, resetsAt: T0 + 5 * 3600_000 }));

    let now = T0;
    const clock = { now: () => now };
    const store = createWatchStore(stateDir);
    let session = "RUNNING";

    // 生产 adapter 注入（与 AR-15 同路径）：发送侧走伪 app-server（appserver-v2-file
    // 对 turn/start 回发 turn/completed），确认器与 AR-06 整链相同的 fail-closed confirmer。
    const quotaReader = createAppServerQuotaReader({ ...fakeCodexOptions("appserver-v2-file", { FAKE_CODEX_QUOTA_FILE: quotaFile }), cwd });
    const sender = createAppServerSender({ ...fakeCodexOptions("appserver-v2-file", { FAKE_CODEX_QUOTA_FILE: quotaFile, FAKE_CODEX_COUNTS: countsPath }), cwd });
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: createAppServerConfirmer({ cwd }), clock });
    const monitor = createMonitor({
      stateDir,
      quotaReader,
      sessionReader: async () => session as "RUNNING" | "STOPPED" | "COMPLETED",
      clock,
      ownerToken: "t6-confirmed",
      store,
      outbox,
    });

    // cycle1：RUNNING + POSITIVE → arming 建立，零副作用。
    await store.upsert(makeWatch({ threadId: "thread-1", cwd }));
    const cycle1 = await monitor.detect(newCycleId());
    expect(cycle1.watchOutcomes[0].nextPhase).toBe("MONITORING");

    // cycle2：额度归零 → 锁存。
    now += STEP_MS;
    await writeFile(quotaFile, JSON.stringify({ usedPercent: 100, windowDurationMins: 300, resetsAt: T0 + 5 * 3600_000 }));
    const cycle2 = await monitor.detect(newCycleId());
    expect(cycle2.watchOutcomes[0].nextPhase).toBe("WAITING_FOR_5H_QUOTA");

    // cycle3：额度恢复 + 会话结束 → 恰好一次发送；production sender 等到 turn/completed
    // → 返回 confirmed:true → outbox 写 confirmedAt → monitor 同轮收敛。
    now += STEP_MS;
    session = "STOPPED";
    await writeFile(quotaFile, JSON.stringify({ usedPercent: 40, windowDurationMins: 300, resetsAt: T0 + 5 * 3600_000 }));
    const cycle3 = await monitor.detect(newCycleId());
    expect(cycle3.watchOutcomes[0].nextPhase).toBe("RESUME_QUEUED");
    expect(cycle3.resumedCount).toBe(1);
    const counts = JSON.parse(await readFile(countsPath, "utf8"));
    expect(counts.threadResume).toBe(1);
    expect(counts.turnStart).toBe(1);

    // 收敛证据：watch 回 MONITORING、enabled 保持 true、latch/activeAttempt/lastError 全清；
    // outbox 记录已删除（绝不残留可重放/可补发的 attempt）。
    const afterCycle3 = (await store.load("thread-1"))!;
    expect(afterCycle3.phase).toBe("MONITORING");
    expect(afterCycle3.enabled).toBe(true);
    expect(afterCycle3.interruptionLatch).toBeUndefined();
    expect(afterCycle3.activeAttemptId).toBeUndefined();
    expect(afterCycle3.lastError).toBeUndefined();
    expect(await outbox.loadPending()).toHaveLength(0);

    // cycle4：可信 COMPLETED + POSITIVE → disable（正常完成路径，与决策A 收敛正交）。
    now += STEP_MS;
    session = "COMPLETED";
    const cycle4 = await monitor.detect(newCycleId());
    expect(cycle4.watchOutcomes[0].nextPhase).toBe("DISABLED");
    const afterCycle4 = (await store.load("thread-1"))!;
    expect(afterCycle4.phase).toBe("DISABLED");
    expect(afterCycle4.enabled).toBe(false);
    // 计数不增长：CONFIRMED 收敛后绝不重复发送。
    const countsAfterCycle4 = JSON.parse(await readFile(countsPath, "utf8"));
    expect(countsAfterCycle4.threadResume).toBe(1);
    expect(countsAfterCycle4.turnStart).toBe(1);
  });

  it("AR-06/09/12/15: 整链——勾选→arming→归零锁存→恢复→恰好一次发送→CONFIRMED 收敛（决策A）；不再进 NEEDS_ATTENTION", async () => {    const stateDir = await tempDir("ar6-chain-state-");
    const cwd = await tempDir("ar6-chain-cwd-");
    const quotaFile = path.join(stateDir, "quota.json");
    const countsPath = path.join(cwd, "fake-counts.json");
    await writeFile(quotaFile, JSON.stringify({ usedPercent: 30, windowDurationMins: 300, resetsAt: T0 + 5 * 3600_000 }));

    let now = T0;
    const clock = { now: () => now };
    const store = createWatchStore(stateDir);

    // 会话状态随周期推进：前两轮 RUNNING（arming/归零），cycle3 起会话已结束（STOPPED）。
    let session = "RUNNING";

    // 生产 adapter 注入：quota 走伪 app-server（动态额度文件），发送/确认走伪 app-server。
    const quotaReader = createAppServerQuotaReader({ ...fakeCodexOptions("appserver-v2-file", { FAKE_CODEX_QUOTA_FILE: quotaFile }), cwd });
    const sender = createAppServerSender({ ...fakeCodexOptions("appserver-v2-file", { FAKE_CODEX_QUOTA_FILE: quotaFile, FAKE_CODEX_COUNTS: countsPath }), cwd });
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer: createAppServerConfirmer({ cwd }), clock });
    const monitor = createMonitor({
      stateDir,
      quotaReader,
      sessionReader: async () => session as "RUNNING" | "STOPPED",
      clock,
      ownerToken: "t6-chain",
      store,
      outbox,
    });

    // cycle1：RUNNING + POSITIVE → arming 建立，零副作用。
    await store.upsert(makeWatch({ threadId: "thread-1", cwd }));
    const cycle1 = await monitor.detect(newCycleId());
    expect(cycle1.watchOutcomes[0].nextPhase).toBe("MONITORING");
    const afterCycle1 = (await store.load("thread-1"))!;
    expect(afterCycle1.armedByDetection?.validUntil).toBe(now + 420_000);
    expect(afterCycle1.interruptionLatch).toBeUndefined();
    await expect(readFile(countsPath, "utf8").then((raw) => JSON.parse(raw))).rejects.toThrow();

    // cycle2：额度归零（动态文件翻转）→ 锁存，等待额度恢复。
    now += STEP_MS;
    await writeFile(quotaFile, JSON.stringify({ usedPercent: 100, windowDurationMins: 300, resetsAt: T0 + 5 * 3600_000 }));
    const cycle2 = await monitor.detect(newCycleId());
    expect(cycle2.watchOutcomes[0].nextPhase).toBe("WAITING_FOR_5H_QUOTA");
    const afterCycle2 = (await store.load("thread-1"))!;
    expect(afterCycle2.interruptionLatch?.id).toBe(`${cycle2.cycleId}:thread-1`);
    expect(afterCycle2.interruptionLatch?.evidenceCycleId).toBe(cycle2.cycleId);
    expect(afterCycle2.interruptionLatch?.previousRunningCycleId).toBe(cycle1.cycleId);
    // T6 观测：monitor（auto-resume-monitor.ts）每轮只取 quota.state、丢弃 quota.resetAt，
    // snapshot 也不携带 quotaResetAt → latch.quotaResetAt 在真实链路恒为 undefined。
    // 该字段为诊断性证据（不影响状态机判定），已作为生产缺口列入 T7 审查项；
    // 此处不断言其值（reducer 单测已覆盖 snapshot→latch 的透传）。

    // cycle3：额度恢复 + 会话结束 → 恰好一次发送（thread/resume + turn/start 各 1）。
    // 伪 app-server 对 turn/start 回发 turn/completed → 生产 sender 自带可靠证据 →
    // outbox 写 confirmedAt → monitor 同轮 CONFIRMED 收敛（决策A）。
    now += STEP_MS;
    session = "STOPPED";
    await writeFile(quotaFile, JSON.stringify({ usedPercent: 40, windowDurationMins: 300, resetsAt: T0 + 5 * 3600_000 }));
    const cycle3 = await monitor.detect(newCycleId());
    expect(cycle3.watchOutcomes[0].nextPhase).toBe("RESUME_QUEUED");
    expect(cycle3.resumedCount).toBe(1);
    const counts = JSON.parse(await readFile(countsPath, "utf8"));
    expect(counts.threadResume).toBe(1);
    expect(counts.turnStart).toBe(1);
    // 收敛证据：watch 回 MONITORING、enabled 保持 true、latch/activeAttempt/lastError 全清。
    const afterCycle3 = (await store.load("thread-1"))!;
    expect(afterCycle3.phase).toBe("MONITORING");
    expect(afterCycle3.enabled).toBe(true);
    expect(afterCycle3.interruptionLatch).toBeUndefined();
    expect(afterCycle3.activeAttemptId).toBeUndefined();
    expect(afterCycle3.lastError).toBeUndefined();
    expect(await outbox.loadPending()).toHaveLength(0);

    // cycle4：正常完成（可信 COMPLETED + POSITIVE）→ disable；已确认 attempt 绝不重发。
    now += STEP_MS;
    session = "COMPLETED";
    const cycle4 = await monitor.detect(newCycleId());
    expect(cycle4.resumedCount).toBe(0);
    const afterCycle4 = (await store.load("thread-1"))!;
    expect(afterCycle4.phase).toBe("DISABLED");
    expect(afterCycle4.enabled).toBe(false);
    // 计数不增长：CONFIRMED 收敛后绝不重复发送。
    const countsAfterCycle4 = JSON.parse(await readFile(countsPath, "utf8"));
    expect(countsAfterCycle4.threadResume).toBe(1);
    expect(countsAfterCycle4.turnStart).toBe(1);
  });
});

describe("T6 shadow：≥2 个 fake-clock 180 秒周期，决策可记录但发送恒为 0", () => {
  it("RUNNING+POSITIVE→arming；ZERO→锁存等待；恢复+STOPPED→RESUME_QUEUED；resumedCount 恒 0、无 app-server turn", async () => {
    const stateDir = await tempDir("ar6-shadow-state-");
    const cwd = await tempDir("ar6-shadow-cwd-");
    const countsPath = path.join(cwd, "fake-counts.json"); // 预期从不创建

    let now = T0;
    const clock = { now: () => now };
    const store = createWatchStore(stateDir);

    // shadow 用与生产相同的 adapter，但 monitor 的 outbox 显式注入 nullSender（shadow/observe
    // 合同：机制可见、发送恒为 0；服务端 SHADOW=1 时同样注入空 sender——见 T4 服务端测试）。
    const quotaReader = createAppServerQuotaReader({ ...fakeCodexOptions("appserver-v2-positive"), cwd });
    const shadowSender = { async send() { return { ok: false, error: "execute disabled; shadow/observe mode never sends" }; } };
    const monitor = createMonitor({
      stateDir,
      quotaReader,
      sessionReader: async () => "RUNNING",
      clock,
      ownerToken: "t6-shadow",
      store,
      outbox: createAttemptOutbox({ stateDir, sender: shadowSender, confirmer: createAppServerConfirmer({ cwd }), clock }),
    });

    await store.upsert(makeWatch({ threadId: "thread-1", cwd }));

    // 周期 1（t=0）：RUNNING + POSITIVE → 只观察、建立 arming，零发送。
    const cycle1 = await monitor.detect(newCycleId());
    expect(cycle1.resumedCount).toBe(0);
    const w1 = (await store.load("thread-1"))!;
    expect(w1.phase).toBe("MONITORING");
    expect(w1.armedByDetection?.cycleId).toBe(cycle1.cycleId);
    expect(w1.interruptionLatch).toBeUndefined();

    // 周期 2（t=+180s）：额度归零 → 锁存，等待额度恢复，零发送。
    now += STEP_MS;
    const zeroReader = createAppServerQuotaReader({ ...fakeCodexOptions("appserver-v2-zero"), cwd });
    const zeroMonitor = createMonitor({
      stateDir, quotaReader: zeroReader, sessionReader: async () => "RUNNING", clock,
      ownerToken: "t6-shadow", store,
      outbox: createAttemptOutbox({ stateDir, sender: shadowSender, confirmer: createAppServerConfirmer({ cwd }), clock }),
    });
    const cycle2 = await zeroMonitor.detect(newCycleId());
    expect(cycle2.resumedCount).toBe(0);
    const w2 = (await store.load("thread-1"))!;
    expect(w2.phase).toBe("WAITING_FOR_5H_QUOTA");
    expect(w2.interruptionLatch?.id).toBe(`${cycle2.cycleId}:thread-1`);

    // 周期 3（t=+360s）：额度恢复 + 会话结束（STOPPED）→ 队列 RESUME_QUEUED，但发送仍为 0。
    now += STEP_MS;
    const positiveReader = createAppServerQuotaReader({ ...fakeCodexOptions("appserver-v2-positive"), cwd });
    const shadowMonitor3 = createMonitor({
      stateDir, quotaReader: positiveReader, sessionReader: async () => "STOPPED", clock,
      ownerToken: "t6-shadow", store,
      outbox: createAttemptOutbox({ stateDir, sender: shadowSender, confirmer: createAppServerConfirmer({ cwd }), clock }),
    });
    const cycle3 = await shadowMonitor3.detect(newCycleId());
    expect(cycle3.resumedCount).toBe(0);
    const w3 = (await store.load("thread-1"))!;
    expect(w3.phase).toBe("RESUME_QUEUED");
    expect(w3.activeAttemptId).toBeDefined();
    expect(w3.lastError).toContain("execute disabled; shadow/observe mode never sends");

    // 全程从未创建真实 app-server 计数 → 0 次 thread/resume、0 次 turn/start。
    await expect(readFile(countsPath, "utf8").then((raw) => JSON.parse(raw))).rejects.toThrow();
  });
});
