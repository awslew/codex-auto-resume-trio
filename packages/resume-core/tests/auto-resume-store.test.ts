import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWatchStore } from "../src/auto-resume-store.js";
import { watchesDir } from "../src/paths.js";
import type { AutoResumeWatch } from "../src/auto-resume-types.js";

/**
 * T2 watch 存储测试（AUTO_RESUME_V2_DESIGN.md §4；执行计划 §7 T2）。
 * 覆盖：schemaVersion=2 原子持久化、watches/<安全threadId>.json 布局、
 * load/list/upsert/disable、tmp+rename 原子写、损坏文件隔离、绝不动旧 jobs。
 */

const NOW = 1_800_000_000_000;

function makeWatch(overrides: Partial<AutoResumeWatch> = {}): AutoResumeWatch {
  return {
    schemaVersion: 2,
    threadId: "thread-1",
    cwd: "C:\\work\\demo",
    enabled: true,
    phase: "MONITORING",
    resumeAttemptCount: 0,
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function tempStateDir(): string {
  return mkdtempSync(path.join(tmpdir(), "ar-store-"));
}

describe("auto-resume-store — schemaVersion=2 原子 watch 存储", () => {
  it("AR-14: 同一 threadId 重复 upsert → 只有 1 个 watch（幂等 upsert 覆盖）", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const watch = makeWatch();

    await store.upsert(watch);
    await store.upsert({ ...watch, phase: "WAITING_FOR_5H_QUOTA" });
    await store.upsert({ ...watch, phase: "RESUME_QUEUED", activeAttemptId: "a1" });

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].phase).toBe("RESUME_QUEUED");
    expect(all[0].activeAttemptId).toBe("a1");
    expect(all[0].resumeAttemptCount).toBe(0);
    expect(watchesDir(stateDir)).not.toContain("jobs");
  });

  it("布局：watches/<安全threadId>.json，tmp 文件不残留", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const watch = makeWatch({ threadId: "C:\\Users\\a b/thread:1" });

    await store.upsert(watch);

    const dir = watchesDir(stateDir);
    const names = readFileNames(dir);
    expect(names.filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(names.some((n) => n.startsWith(".") && n.endsWith(".tmp"))).toBe(false);
    const loaded = await store.load("C:\\Users\\a b/thread:1");
    expect(loaded).toBeDefined();
    expect(loaded!.threadId).toBe("C:\\Users\\a b/thread:1");
    expect(loaded!.schemaVersion).toBe(2);
  });

  it("原子写：同目录 tmp + rename，JSON 完整可读", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    const watch = makeWatch({
      phase: "WAITING_FOR_5H_QUOTA",
      interruptionLatch: {
        id: "cycle-2:thread-1",
        detectedAt: new Date(NOW + 180_000).toISOString(),
        evidenceCycleId: "cycle-2",
        previousRunningCycleId: "cycle-1",
      },
      armedByDetection: { cycleId: "cycle-1", detectedAt: new Date(NOW).toISOString(), validUntil: NOW + 420_000 },
      lastObservation: {
        cycleId: "cycle-2",
        detectedAt: new Date(NOW + 180_000).toISOString(),
        sessionState: "COMPLETED",
        fiveHourQuota: "ZERO",
      },
    });

    await store.upsert(watch);
    const raw = readFileSync(path.join(watchesDir(stateDir), "thread-1.json"), "utf8");
    expect(raw).toContain('"schemaVersion": 2');
    const parsed = JSON.parse(raw) as AutoResumeWatch;
    expect(parsed.interruptionLatch!.id).toBe("cycle-2:thread-1");
    expect(parsed.armedByDetection!.validUntil).toBe(NOW + 420_000);
    expect(parsed.lastObservation!.fiveHourQuota).toBe("ZERO");
    // 单文件整体写：所有字段同一次落盘。
    const loaded = await store.load("thread-1");
    expect(loaded).toEqual(watch);
  });

  it("load/list/upsert/disable 全链路；disable 幂等", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);

    expect(await store.load("missing")).toBeUndefined();
    expect(await store.list()).toEqual([]);

    await store.upsert(makeWatch({ threadId: "t1" }));
    await store.upsert(makeWatch({ threadId: "t2" }));
    expect((await store.list()).map((w) => w.threadId).sort()).toEqual(["t1", "t2"]);

    await store.disable("t1");
    expect(await store.load("t1")).toBeUndefined();
    await store.disable("t1"); // 幂等
    expect((await store.list()).map((w) => w.threadId)).toEqual(["t2"]);
  });

  it("损坏/半写/旧版本文件 → load 返回 undefined 且不影响其他 watch", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({ threadId: "good" }));

    writeFileSync(path.join(watchesDir(stateDir), "broken.json"), "{not-json");
    writeFileSync(path.join(watchesDir(stateDir), "old-version.json"), JSON.stringify({ schemaVersion: 1, threadId: "old" }));
    writeFileSync(path.join(watchesDir(stateDir), "partial.json"), JSON.stringify({ schemaVersion: 2, threadId: "partial" }));

    expect(await store.load("broken")).toBeUndefined();
    expect(await store.load("old-version")).toBeUndefined();
    expect(await store.load("partial")).toBeUndefined();
    expect(await store.load("good")).toBeDefined();
    const stats = await store.stats();
    expect(stats.corruptedFiles).toBe(3);
    // 损坏文件不进入 list。
    expect((await store.list()).map((w) => w.threadId)).toEqual(["good"]);
  });

  it("与旧 jobs 完全隔离：只读写 watches 目录，绝不触碰 jobs 目录", async () => {
    const stateDir = tempStateDir();
    mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
    writeFileSync(path.join(stateDir, "jobs", "job-1.json"), JSON.stringify({ id: "job-1", status: "running" }));

    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({ threadId: "t1" }));
    await store.list();
    await store.disable("t1");

    expect(existsSync(path.join(stateDir, "jobs", "job-1.json"))).toBe(true);
    const jobsBefore = readFileSync(path.join(stateDir, "jobs", "job-1.json"), "utf8");
    expect(jobsBefore).toContain("job-1");
  });

  it("拒绝非 schemaVersion=2 的写入", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await expect(store.upsert({ ...makeWatch(), schemaVersion: 1 } as AutoResumeWatch)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it("文件名解码出的 threadId 与 JSON.threadId 不一致时 fail-closed，且不覆盖其他 watch", async () => {
    const stateDir = tempStateDir();
    const store = createWatchStore(stateDir);
    await store.upsert(makeWatch({ threadId: "good" }));
    writeFileSync(path.join(watchesDir(stateDir), "claimed.json"), JSON.stringify(makeWatch({ threadId: "other" })));

    expect(await store.load("claimed")).toBeUndefined();
    expect(await store.load("good")).toBeDefined();
    expect((await store.list()).map((watch) => watch.threadId)).toEqual(["good"]);
    expect((await store.stats()).corruptedFiles).toBe(1);
  });
});

function readFileNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort();
}
