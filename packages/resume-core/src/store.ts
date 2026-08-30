import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { jobsDir, logsDir } from "./paths.js";
import type { GitBaseline, Job } from "./types.js";
import { captureGitBaseline } from "./git-safety.js";
import { DEFAULT_SANDBOX } from "./constants.js";

export async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(jobsDir(stateDir), { recursive: true });
  await mkdir(logsDir(stateDir), { recursive: true });
}

export async function createJob(input: { stateDir: string; cwd: string; task: string }): Promise<Job> {
  await ensureStateDir(input.stateDir);
  const id = randomUUID();
  const now = new Date().toISOString();
  const logPath = path.join(logsDir(input.stateDir), `${id}.log`);
  const gitBaseline = await captureGitBaseline(input.cwd);
  const job: Job = {
    id,
    cwd: input.cwd,
    task: input.task,
    status: "created",
    retryCount: 0,
    resumeAttempts: 0,
    sandbox: DEFAULT_SANDBOX,
    logPath,
    createdAt: now,
    updatedAt: now,
    gitBaseline
  };
  await saveJob(input.stateDir, job);
  return job;
}

export async function saveJob(stateDir: string, job: Job): Promise<void> {
  await ensureStateDir(stateDir);
  const updated = { ...job, updatedAt: new Date().toISOString() };
  const target = jobPath(stateDir, job.id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

export async function loadJob(stateDir: string, id: string): Promise<Job | undefined> {
  try {
    const raw = await readFile(jobPath(stateDir, id), "utf8");
    return JSON.parse(raw) as Job;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function loadJobs(stateDir: string): Promise<Job[]> {
  await ensureStateDir(stateDir);
  const names = await readdir(jobsDir(stateDir));
  const jobs = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => loadJob(stateDir, name.slice(0, -5)))
  );
  return jobs.filter((job): job is Job => Boolean(job)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function jobPath(stateDir: string, id: string): string {
  return path.join(jobsDir(stateDir), `${id}.json`);
}

export function summarizeJob(job: Job): string {
  const reset = job.resetAt ? new Date(job.resetAt * 1000).toISOString() : "-";
  return `${job.id} ${job.status} thread=${job.threadId ?? "-"} reset=${reset} cwd=${job.cwd}`;
}

export type { GitBaseline };
