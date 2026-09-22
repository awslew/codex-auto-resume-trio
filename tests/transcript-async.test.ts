import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRollout, parseRolloutAsync } from "../src/transcript.js";

/**
 * parseRolloutAsync（2026-09-06 预热异步化）合同：
 * - 结果与同步 parseRollout 完全一致；
 * - 共享同一 (size, mtime) 结果缓存——先到先填，另一方直接命中；
 * - 读取走异步 I/O、逐行解析按 25ms 预算分片让出事件循环（时序难在本进程内
 *   断言，由 taskboard server 预热路径的在线请求延迟回归保障）。
 */
describe("parseRolloutAsync", () => {
  it("结果与 parseRollout 一致，且共享同一结果缓存", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "transcript-async-"));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 2000; i += 1) {
        lines.push(JSON.stringify({
          type: "response_item",
          timestamp: `2026-09-06T0${i % 10}:00:00Z`,
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `汇报 ${i}` }] },
        }));
        lines.push("   "); // 空白行：跳过
        lines.push("not-json"); // 坏行：跳过
        lines.push(JSON.stringify({ type: "event_msg", payload: {} })); // 非 response_item：跳过
      }
      const filePath = path.join(dir, "rollout-1-thread-1.jsonl");
      await writeFile(filePath, lines.join("\n"), "utf8");

      const asyncResult = await parseRolloutAsync(filePath);
      expect(asyncResult.messages).toHaveLength(2000);
      expect(asyncResult.messages[0]).toEqual({ ts: "2026-09-06T00:00:00Z", text: "汇报 0" });
      expect(asyncResult.lastItem?.role).toBe("assistant");

      // 缓存共享：同 (size, mtime) 下同步版直接命中异步版填入的同一对象。
      const syncResult = parseRollout(filePath);
      expect(syncResult).toBe(asyncResult);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("文件不存在 / 不可读时返回空结果（与同步版一致）", async () => {
    const missing = path.join(tmpdir(), `no-such-rollout-${Date.now()}-${Math.random()}.jsonl`);
    expect(await parseRolloutAsync(missing)).toEqual({ messages: [], lastItem: null });
    expect(parseRollout(missing)).toEqual({ messages: [], lastItem: null });
  });
});
