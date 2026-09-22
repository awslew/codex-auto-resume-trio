import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateThreadResume } from "../src/app-server/supervisor.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex.js", import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

describe("adopt validation", () => {
  it("rejects threads app-server cannot resume", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "car-adopt-"));
    dirs.push(cwd);

    await expect(
      validateThreadResume(
        { cwd, threadId: "bad-thread", sandbox: "workspace-write" },
        {
          codexBin: process.execPath,
          codexArgsPrefix: [fixture],
          env: { FAKE_CODEX_MODE: "appserver-bad-thread" }
        }
      )
    ).rejects.toThrow("bad thread");
  });
});
