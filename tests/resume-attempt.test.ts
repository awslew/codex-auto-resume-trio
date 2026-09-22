import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAttemptOutbox, resumeAttemptId } from "../src/resume-attempt.js";
import { attemptsDir } from "../src/paths.js";
import type { ResumeAttempt } from "../src/auto-resume-types.js";

/**
 * T2 幂等 attempt outbox 测试（AUTO_RESUME_V2_DESIGN.md §6.2/§6.3；执行计划 §7 T2）。
 * 覆盖：同 threadId+latchId 复用 sha256 id、发送前落盘、发送后确认前崩溃不盲目双发、
 * 可注入 sender/confirmer/clock、技术失败 ≤2 次、额度失败不计技术失败、outbox 移除、
 * 三态确认（CONFIRMED / NOT_STARTED / UNKNOWN，验收修复 A）与 failureCount 唯一真相源（修复 B）。
 */

const T0 = 1_800_000_000_000;
const clock = { now: () => T0 };

function makeAttempt(overrides: Partial<ResumeAttempt> = {}): ResumeAttempt {
  return {
    id: resumeAttemptId("thread-1", "cycle-2:thread-1"),
    threadId: "thread-1",
    latchId: "cycle-2:thread-1",
    cwd: "C:\\work\\demo",
    status: "QUEUED",
    failureCount: 0,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

let stateDirs: string[] = [];
function tempStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ar-attempt-"));
  stateDirs.push(dir);
  return dir;
}

beforeEach(() => {
  stateDirs = [];
});

afterAll(() => {
  for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
});

describe("resume-attempt — 幂等 id 与 outbox", () => {
  it("同 threadId+latchId → 恒同 sha256 id；不同 latch → 恒异", () => {
    const a1 = resumeAttemptId("thread-1", "cycle-2:thread-1");
    const a2 = resumeAttemptId("thread-1", "cycle-2:thread-1");
    expect(a1).toBe(a2);
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
    expect(resumeAttemptId("thread-1", "cycle-3:thread-1")).not.toBe(a1);
    expect(resumeAttemptId("thread-2", "cycle-2:thread-1")).not.toBe(a1);
  });

  it("发送前落盘：outbox 记录在 sender 调用前已存在（崩溃恢复点 1）", async () => {
    const stateDir = tempStateDir();
    let fileSeenDuringSend = false;
    const sender = {
      async send(attempt: { id: string }) {
        fileSeenDuringSend = existsSync(path.join(attemptsDir(stateDir), `${attempt.id}.json`));
        return { ok: true };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender, clock });
    const outcome = await outbox.send(makeAttempt());

    expect(outcome.ok).toBe(true);
    expect(fileSeenDuringSend).toBe(true); // 发送前记录已落盘。
    const stored = JSON.parse(readFileSync(path.join(attemptsDir(stateDir), `${makeAttempt().id}.json`), "utf8"));
    expect(stored.confirmedAt).toBeUndefined();
  });

  it("发送成功并确认 → confirmedAt 落盘；再次 send 绝不重发", async () => {
    const stateDir = tempStateDir();
    let sendCalls = 0;
    const sender = {
      async send() {
        sendCalls++;
        return { ok: true };
      },
    };
    const confirmer = {
      async confirm() {
        return { state: "CONFIRMED" as const, reason: "new turn id" };
      },
    };
    const outbox = createAttemptOutbox({ stateDir, sender, confirmer, clock });

    const r1 = await outbox.send(makeAttempt());
    expect(r1.ok).toBe(true);
    expect(sendCalls).toBe(1);

    const r2 = await outbox.send(makeAttempt()); // 重复 tick / 双调度器
    expect(r2.ok).toBe(true);
    expect(sendCalls).toBe(1); // 已确认 → 不重发。

    const stored = JSON.parse(readFileSync(path.join(attemptsDir(stateDir), `${makeAttempt().id}.json`), "utf8"));
    expect(stored.confirmedAt).toBeDefined();
  });

  it("AR-15: 发送成功但确认前崩溃 → 重启后重放确认（不盲目重发），NOT_STARTED 才补发", async () => {
    const stateDir = tempStateDir();

    // 第一次：发送成功，确认器抛错/未调用（模拟确认前崩溃）。
    const sender1 = {
      async send() {
        return { ok: true };
      },
    };
    const confirmer1 = {
      async confirm() {
        throw new Error("crash before confirm"); // 模拟崩溃：confirm 未完成。
      },
    };
    const outbox1 = createAttemptOutbox({ stateDir, sender: sender1, confirmer: confirmer1, clock });
    await outbox1.send(makeAttempt());

    // 重启：confirmer 恢复可用 → 重放确认成功 → 不再发送。
    let sendCalls2 = 0;
    let confirmCalls2 = 0;
    const outbox2 = createAttemptOutbox({
      stateDir,
      sender: { async send() { sendCalls2++; return { ok: true }; } },
      confirmer: {
        async confirm() {
          confirmCalls2++;
          return { state: "CONFIRMED" as const, reason: "new turn id seen after restart" };
        },
      },
      clock,
    });
    const r2 = await outbox2.send(makeAttempt());
    expect(r2.ok).toBe(true);
    expect(sendCalls2).toBe(0); // 不盲目重发。
    expect(confirmCalls2).toBe(1); // 重放确认一次。

    // 反向场景：从未发送（无 outbox 记录）+ 重放确认 NOT_STARTED（发送确未生效）→ 补发一次，仍复用同一 id。
    const orphan = { ...makeAttempt(), id: resumeAttemptId("thread-1", "cycle-9:thread-1"), latchId: "cycle-9:thread-1" };
    await outbox1.remove(orphan); // 确保无残留。
    const outbox3 = createAttemptOutbox({
      stateDir,
      sender: { async send() { sendCalls2++; return { ok: true }; } },
      confirmer: { async confirm() { return { state: "NOT_STARTED" as const, reason: "no new turn yet" }; } },
      clock,
    });
    const r3 = await outbox3.send(orphan);
    expect(r3.ok).toBe(true);
    expect(sendCalls2).toBe(1);
  });

  it("confirmer 注入：确认成功后才把已发送标记固化；NOT_STARTED 补发不产生第二个 outbox 文件", async () => {
    const stateDir = tempStateDir();
    const outbox = createAttemptOutbox({
      stateDir,
      sender: { async send() { return { ok: true }; } },
      confirmer: { async confirm() { return { state: "NOT_STARTED" as const, reason: "still queued" }; } },
      clock,
    });
    await outbox.send(makeAttempt());
    const pending = await outbox.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(makeAttempt().id);
  });

  it("技术失败最多 2 次：recordFailure 递增，复用同一 id", async () => {
    const stateDir = tempStateDir();
    const outbox = createAttemptOutbox({ stateDir, clock });
    const attempt = makeAttempt();

    await outbox.recordFailure(attempt, "first");
    await outbox.recordFailure({ ...attempt, failureCount: 1 }, "second");

    const pending = await outbox.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(attempt.id);
    expect(pending[0].failureCount).toBe(2);
    expect(pending[0].lastError).toBe("second");
  });

  it("明确额度失败：markQuotaBlocked 不计技术失败；send 返回 quotaBlocked 时写入标记", async () => {
    const stateDir = tempStateDir();
    const outbox = createAttemptOutbox({
      stateDir,
      sender: { async send() { return { ok: false, quotaBlocked: true, error: "5h limit" }; } },
      clock,
    });
    const outcome = await outbox.send(makeAttempt());
    expect(outcome.quotaBlocked).toBe(true);
    const pending = await outbox.loadPending();
    expect(pending[0].failureCount).toBe(0); // 不计技术失败。
    const stored = JSON.parse(readFileSync(path.join(attemptsDir(stateDir), `${makeAttempt().id}.json`), "utf8"));
    expect(stored.quotaBlockedAt).toBeDefined();
  });

  it("writerBusy（桌面端占用）：不计技术失败、不落失败标记，下轮仍可重试", async () => {
    const stateDir = tempStateDir();
    const outbox = createAttemptOutbox({
      stateDir,
      sender: { async send() { return { ok: false, writerBusy: true, error: "thread already has an active writer" }; } },
      confirmer: { async confirm() { return { state: "NOT_STARTED" as const }; } },
      clock,
    });
    const outcome = await outbox.send(makeAttempt());
    expect(outcome.writerBusy).toBe(true);
    const pending = await outbox.loadPending();
    expect(pending[0].failureCount).toBe(0); // 不计技术失败。
    const stored = JSON.parse(readFileSync(path.join(attemptsDir(stateDir), `${makeAttempt().id}.json`), "utf8"));
    expect(stored.quotaBlockedAt).toBeUndefined();
    // 第二轮重试仍会真正调用 sender（不因 writerBusy 进入 giving up）。
    const second = await outbox.send(makeAttempt());
    expect(second.writerBusy).toBe(true);
    expect((await outbox.loadPending())[0].failureCount).toBe(0);
  });

  it("remove 移除 outbox 记录（清除 latch 时使用）；幂等", async () => {
    const stateDir = tempStateDir();
    const outbox = createAttemptOutbox({ stateDir, clock });
    const attempt = makeAttempt();
    await outbox.send(attempt);
    expect(await outbox.loadPending()).toHaveLength(1);

    await outbox.remove(attempt);
    expect(await outbox.loadPending()).toHaveLength(0);
    await outbox.remove(attempt); // 幂等
  });

  it("confirm 幂等：重复 confirm 不覆盖已确认标记", async () => {
    const stateDir = tempStateDir();
    const outbox = createAttemptOutbox({ stateDir, clock });
    const attempt = makeAttempt();
    const first = await outbox.confirm(attempt);
    expect(first.alreadyConfirmed).toBe(false);
    const second = await outbox.confirm(attempt);
    expect(second.alreadyConfirmed).toBe(true);
  });

  it("默认不真实发送：nullSender 返回未配置错误，不产生网络调用", async () => {
    const stateDir = tempStateDir();
    const outbox = createAttemptOutbox({ stateDir, clock });
    const outcome = await outbox.send(makeAttempt());
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("sender not configured");
    expect(outcome.quotaBlocked).toBeUndefined();
  });

  it("修复 A-1: confirm 抛异常 / 返回 UNKNOWN → sender 调用 0 次，保留 outbox，绝不重发", async () => {
    const stateDir = tempStateDir();

    // 场景 1：重启发现未确认 outbox（发送后确认前崩溃），confirm 抛异常 → 不发送。
    let sendCalls = 0;
    const outbox1 = createAttemptOutbox({
      stateDir,
      sender: { async send() { sendCalls++; return { ok: true }; } },
      confirmer: { async confirm() { throw new Error("confirm API down"); } },
      clock,
    });
    // 先制造“已落盘未确认”的记录：发送成功但确认器不可用。
    await outbox1.send(makeAttempt());
    expect(sendCalls).toBe(1);

    // 重启：confirm 抛异常（UNKNOWN）→ sender 0 次；outbox 保留未确认。
    const outcome1 = await outbox1.send(makeAttempt());
    expect(sendCalls).toBe(1); // 绝不调用 sender。
    expect(outcome1.ok).toBe(false);
    expect(outcome1.detail).toMatchObject({ confirmationUnknown: true });
    const pending1 = await outbox1.loadPending();
    expect(pending1).toHaveLength(1);
    expect(pending1[0].confirmedAt).toBeUndefined(); // 未标确认（保留待人工）。

    // 场景 2：confirm 明确返回 UNKNOWN（不是抛异常）→ 同样 0 次发送。
    const outcome2 = await outbox1.send(makeAttempt());
    expect(sendCalls).toBe(1);
    expect(outcome2.detail).toMatchObject({ confirmationUnknown: true });
  });

  it("修复 A-2: confirm 明确 NOT_STARTED（有可靠证据未启动）才允许补发，复用同一 attemptId", async () => {
    const stateDir = tempStateDir();
    const attempt = makeAttempt();
    let sendCalls = 0;
    const outbox = createAttemptOutbox({
      stateDir,
      sender: { async send() { sendCalls++; return { ok: true }; } },
      confirmer: { async confirm() { return { state: "NOT_STARTED" as const, reason: "no new turn, session not started" }; } },
      clock,
    });

    // 制造“已落盘未确认”记录（上次发送后确认前崩溃）。
    await outbox.send(attempt);
    expect(sendCalls).toBe(1);

    // 重启：confirm NOT_STARTED → 补发一次；仍复用同一 attempt id（不产生第二文件）。
    const outcome = await outbox.send(attempt);
    expect(outcome.ok).toBe(true);
    expect(sendCalls).toBe(2);
    const pending = await outbox.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(attempt.id);
  });

  it("修复 B-1: sender 技术失败只增 1；failureCount>=2 后任何 tick 不再调用 sender", async () => {
    const stateDir = tempStateDir();
    const attempt = makeAttempt();
    let sendCalls = 0;
    const outbox = createAttemptOutbox({
      stateDir,
      sender: {
        async send() {
          sendCalls++;
          return { ok: false, error: "app-server exited" };
        },
      },
      confirmer: { async confirm() { return { state: "CONFIRMED" as const }; } },
      clock,
    });

    // 第 1 次：技术失败 → failureCount 1。
    const r1 = await outbox.send(attempt);
    expect(r1.ok).toBe(false);
    expect(sendCalls).toBe(1);
    expect((await outbox.loadPending())[0].failureCount).toBe(1);

    // 第 2 次（重试 tick）：技术失败 → failureCount 2。
    const r2 = await outbox.send(attempt);
    expect(r2.ok).toBe(false);
    expect(sendCalls).toBe(2);
    expect((await outbox.loadPending())[0].failureCount).toBe(2);

    // 第 3 次（后续任何 tick）：绝不调用 sender；给出明确失败原因。
    const r3 = await outbox.send(attempt);
    expect(sendCalls).toBe(2);
    expect(r3.ok).toBe(false);
    expect(r3.detail).toMatchObject({ givingUp: true, failureCount: 2 });
    expect(r3.error).toContain("giving up");
  });

  it("修复 B-2: quotaBlocked 不计技术失败；恢复后同 attemptId 再试；随后连续 2 次技术失败后第 3 轮 0 发送", async () => {
    const stateDir = tempStateDir();
    const attempt = makeAttempt();
    let sendCalls = 0;
    let failMode: "quota" | "technical" = "quota";
    const outbox = createAttemptOutbox({
      stateDir,
      sender: {
        async send() {
          sendCalls++;
          if (failMode === "quota") return { ok: false, quotaBlocked: true, error: "5h limit" };
          return { ok: false, error: "app-server exited" };
        },
      },
      confirmer: { async confirm() { return { state: "CONFIRMED" as const }; } },
      clock,
    });

    // 第 1 轮：quotaBlocked → 不计技术失败，仍复用同一 attemptId。
    const r1 = await outbox.send(attempt);
    expect(r1.quotaBlocked).toBe(true);
    expect((await outbox.loadPending())[0].failureCount).toBe(0);

    // 第 2 轮：额度恢复（技术模式），第一次技术失败 → failureCount 1。
    failMode = "technical";
    const r2 = await outbox.send(attempt);
    expect(r2.ok).toBe(false);
    expect((await outbox.loadPending())[0].failureCount).toBe(1);

    // 第 3 轮：第二次技术失败 → failureCount 2。
    const r3 = await outbox.send(attempt);
    expect(r3.ok).toBe(false);
    expect((await outbox.loadPending())[0].failureCount).toBe(2);

    // 第 4 轮：失败已达上限 → sender 0 次。
    const r4 = await outbox.send(attempt);
    expect(sendCalls).toBe(3);
    expect(r4.detail).toMatchObject({ givingUp: true, failureCount: 2 });
  });

  it("持久化 cwd 且恢复发送沿用原 cwd；sender 抛异常只 recordFailure 一次并在第 2 次封顶", async () => {
    const stateDir = tempStateDir();
    const attempt = makeAttempt({ cwd: "C:\\projects\\original" });
    const seenCwds: string[] = [];
    let sendCalls = 0;
    const outbox = createAttemptOutbox({
      stateDir,
      sender: {
        async send(a, watch) {
          sendCalls++;
          seenCwds.push(`${a.cwd}|${watch.cwd}`);
          throw new Error("sender exploded");
        },
      },
      clock,
    });

    const first = await outbox.send(attempt);
    expect(first.detail).toMatchObject({ senderThrew: true });
    expect((await outbox.loadPending())[0]).toMatchObject({ cwd: "C:\\projects\\original", failureCount: 1 });
    const second = await outbox.send({ ...attempt, cwd: "C:\\projects\\wrong" });
    expect(second.detail).toMatchObject({ senderThrew: true });
    expect((await outbox.loadPending())[0]).toMatchObject({ cwd: "C:\\projects\\original", failureCount: 2 });
    const third = await outbox.send(attempt);
    expect(third.detail).toMatchObject({ givingUp: true, failureCount: 2 });
    expect(sendCalls).toBe(2);
    expect(seenCwds).toEqual(["C:\\projects\\original|C:\\projects\\original", "C:\\projects\\original|C:\\projects\\original"]);
  });

  it("已存在但缺失 cwd 的旧 outbox 记录 fail-closed，不以默认 cwd 替换或发送", async () => {
    const stateDir = tempStateDir();
    const attempt = makeAttempt();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(attemptsDir(stateDir), { recursive: true });
    writeFileSync(path.join(attemptsDir(stateDir), `${attempt.id}.json`), JSON.stringify({
      id: attempt.id,
      threadId: attempt.threadId,
      latchId: attempt.latchId,
      status: attempt.status,
      failureCount: 0,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
    }));
    let sendCalls = 0;
    const outbox = createAttemptOutbox({ stateDir, sender: { async send() { sendCalls++; return { ok: true }; } }, clock });
    const result = await outbox.send(attempt);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatchObject({ confirmationUnknown: true, invalidRecord: true });
    expect(sendCalls).toBe(0);
  });
});
