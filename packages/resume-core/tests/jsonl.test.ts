import { describe, expect, it } from "vitest";
import { JsonlParser } from "../src/jsonl.js";

describe("JsonlParser", () => {
  it("parses split chunks, half lines, and multiple lines", () => {
    const parser = new JsonlParser();
    const first = parser.push('{"type":"thread.started","thread_id":"abc"}\n{"type"');
    const second = parser.push(':"turn.completed"}\n{"type":"error","message":"x"}\n');
    const flushed = parser.flush();

    expect([...first, ...second, ...flushed]).toEqual([
      { ok: true, value: { type: "thread.started", thread_id: "abc" }, line: '{"type":"thread.started","thread_id":"abc"}' },
      { ok: true, value: { type: "turn.completed" }, line: '{"type":"turn.completed"}' },
      { ok: true, value: { type: "error", message: "x" }, line: '{"type":"error","message":"x"}' }
    ]);
  });

  it("reports invalid JSON without dropping following valid lines", () => {
    const parser = new JsonlParser();
    const events = parser.push('not json\n{"type":"turn.failed"}\n');

    expect(events[0]?.ok).toBe(false);
    expect(events[0]?.line).toBe("not json");
    expect(events[1]).toEqual({ ok: true, value: { type: "turn.failed" }, line: '{"type":"turn.failed"}' });
  });

  it("flushes a final unterminated line", () => {
    const parser = new JsonlParser();
    expect(parser.push('{"type":"thread.started"}')).toEqual([]);
    expect(parser.flush()).toEqual([
      { ok: true, value: { type: "thread.started" }, line: '{"type":"thread.started"}' }
    ]);
  });
});
