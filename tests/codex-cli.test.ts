import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "../src/codex-cli.js";

describe("buildCodexArgs", () => {
  it("uses workspace-write by default", () => {
    expect(buildCodexArgs({}, { resume: false, prompt: "start" })).toEqual([
      "-s",
      "workspace-write",
      "exec",
      "--skip-git-repo-check",
      "--json",
      "start"
    ]);
  });

  it("puts sandbox before exec for resume fallback", () => {
    expect(
      buildCodexArgs(
        { threadId: "thread-1", sandbox: "workspace-write" },
        { resume: true, prompt: "continue" }
      )
    ).toEqual([
      "-s",
      "workspace-write",
      "exec",
      "resume",
      "--skip-git-repo-check",
      "thread-1",
      "--json",
      "continue"
    ]);
  });

  it("keeps test executable prefixes before codex flags", () => {
    expect(
      buildCodexArgs(
        { sandbox: "workspace-write" },
        { resume: false, prompt: "start", codexArgsPrefix: ["/tmp/fake-codex.js"] }
      )
    ).toEqual([
      "/tmp/fake-codex.js",
      "-s",
      "workspace-write",
      "exec",
      "--skip-git-repo-check",
      "--json",
      "start"
    ]);
  });
});
