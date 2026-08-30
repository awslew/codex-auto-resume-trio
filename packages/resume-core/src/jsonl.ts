export type JsonlParseResult =
  | { ok: true; value: unknown; line: string }
  | { ok: false; error: Error; line: string };

export class JsonlParser {
  private buffer = "";

  push(chunk: string | Buffer): JsonlParseResult[] {
    this.buffer += chunk.toString();
    const results: JsonlParseResult[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return results;
      }
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const parsed = this.parseLine(raw);
      if (parsed) {
        results.push(parsed);
      }
    }
  }

  flush(): JsonlParseResult[] {
    if (this.buffer.length === 0) {
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    const parsed = this.parseLine(line);
    return parsed ? [parsed] : [];
  }

  private parseLine(raw: string): JsonlParseResult | undefined {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      return undefined;
    }
    try {
      return { ok: true, value: JSON.parse(line) as unknown, line };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)), line };
    }
  }
}
