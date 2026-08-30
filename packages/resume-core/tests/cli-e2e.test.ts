import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createJob, loadJob, loadJobs, saveJob } from "../src/store.js";
import { runJobOnce } from "../src/supervisor.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex.js", import.meta.url));

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs.length = 0;
});

describe("supervisor fake Codex flow", () => {
  it("records quota exhaustion, survives reload, and resumes successfully", async () => {
    const stateDir = await tempDir("car-state-");
    const cwd = await tempDir("car-work-");
    await writeFile(path.join(cwd, ".git-snapshot"), "baseline");
    const fakeState = path.join(stateDir, "fake-state.json");
    const job = await createJob({ stateDir, cwd, task: "finish the tool" });

    await runJobOnce(job.id, {
      stateDir,
      codexBin: process.execPath,
      codexArgsPrefix: [fixture],
      env: { FAKE_CODEX_STATE: fakeState, FAKE_CODEX_MODE: "quota" },
      preferAppServer: false,
      notify: false
    });

    const waiting = await loadJob(stateDir, job.id);
    expect(waiting?.status).toBe("waiting_rate_limit");
    expect(waiting?.threadId).toBe("thread-123");
    expect(waiting?.resetAt).toBe(1893456000);

    await runJobOnce(job.id, {
      stateDir,
      codexBin: process.execPath,
      codexArgsPrefix: [fixture],
      env: { FAKE_CODEX_STATE: fakeState, FAKE_CODEX_MODE: "resume-ok" },
      preferAppServer: false,
      notify: false,
      force: true
    });

    const completed = await loadJob(stateDir, job.id);
    expect(completed?.status).toBe("completed");
    const log = await readFile(completed!.logPath, "utf8");
    expect(log).toContain("turn.completed");
  });

  it("does not run a canceled job or duplicate completed event", async () => {
    const stateDir = await tempDir("car-state-");
    const cwd = await tempDir("car-work-");
    const job = await createJob({ stateDir, cwd, task: "do not run" });
    await saveJob(stateDir, { ...job, status: "canceled" });

    await runJobOnce(job.id, {
      stateDir,
      codexBin: process.execPath,
      codexArgsPrefix: [fixture],
      env: { FAKE_CODEX_MODE: "resume-ok" },
      preferAppServer: false,
      notify: false,
      force: true
    });

    const jobs = await loadJobs(stateDir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("canceled");
  });

  it("prefers app-server resume when it is available", async () => {
    const stateDir = await tempDir("car-state-");
    const cwd = await tempDir("car-work-");
    const fakeState = path.join(stateDir, "fake-appserver.json");
    const job = await createJob({ stateDir, cwd, task: "resume through app server" });
    await saveJob(stateDir, {
      ...job,
      status: "waiting_rate_limit",
      threadId: "thread-app",
      resetAt: 1893456000,
      nextRunAt: 0
    });

    await runJobOnce(job.id, {
      stateDir,
      codexBin: process.execPath,
      codexArgsPrefix: [fixture],
      env: { FAKE_CODEX_STATE: fakeState, FAKE_CODEX_MODE: "appserver-ok" },
      notify: false,
      force: true
    });

    const completed = await loadJob(stateDir, job.id);
    expect(completed?.status).toBe("completed");
    const calls = JSON.parse(await readFile(fakeState, "utf8")) as string[];
    expect(calls).toEqual(["initialize", "initialized", "account/rateLimits/read", "thread/resume", "turn/start"]);
  });
});
