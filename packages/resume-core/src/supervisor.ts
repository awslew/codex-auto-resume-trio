import { appendFile } from "node:fs/promises";
import { DEFAULT_RESUME_PROMPT, MAX_AUTO_RESUMES } from "./constants.js";
import { runCodexCli } from "./codex-cli.js";
import { assertCwdSafe } from "./git-safety.js";
import { withJobLock } from "./lock.js";
import { notify as sendNotification } from "./notifier.js";
import { nextBackoffMs, nextRunAtFromReset } from "./reset-time.js";
import { loadJob, saveJob } from "./store.js";
import type { CodexRunResult, Job, RunOptions } from "./types.js";
import { resumeWithAppServer } from "./app-server/supervisor.js";

export async function runJobOnce(jobId: string, options: RunOptions): Promise<Job | undefined> {
  return withJobLock(options.stateDir, jobId, async () => {
    const job = await loadJob(options.stateDir, jobId);
    if (!job || ["completed", "failed", "canceled", "paused"].includes(job.status)) {
      return job;
    }
    const now = Date.now();
    if (!options.force && job.nextRunAt && job.nextRunAt > now) {
      return job;
    }

    const safe = await assertCwdSafe(job.cwd, job.gitBaseline);
    if (!safe.ok) {
      const paused = { ...job, status: "paused" as const, lastError: safe.reason };
      await saveJob(options.stateDir, paused);
      await maybeNotify(options, "Codex Auto Resume paused", safe.reason);
      return paused;
    }

    const isResume = Boolean(job.threadId && job.status === "waiting_rate_limit");
    const running: Job = {
      ...job,
      status: isResume ? "resuming" : "running",
      resumeAttempts: isResume ? job.resumeAttempts + 1 : job.resumeAttempts
    };
    await saveJob(options.stateDir, running);
    await appendFile(running.logPath, `[car] ${running.status} ${new Date().toISOString()}\n`);
    if (isResume) {
      await maybeNotify(options, "Codex resume started", running.id);
    }

    let result: CodexRunResult;
    if (isResume && options.preferAppServer !== false) {
      try {
        result = await resumeWithAppServer(running, {
          codexBin: options.codexBin,
          codexArgsPrefix: options.codexArgsPrefix,
          env: options.env,
          prompt: DEFAULT_RESUME_PROMPT
        });
      } catch (error) {
        await appendFile(running.logPath, `[car] app-server fallback: ${(error as Error).message}\n`);
        result = await runCodexCli(running, {
          resume: true,
          prompt: DEFAULT_RESUME_PROMPT,
          codexBin: options.codexBin,
          codexArgsPrefix: options.codexArgsPrefix,
          env: options.env
        });
      }
    } else {
      result = await runCodexCli(running, {
        resume: isResume,
        prompt: isResume ? DEFAULT_RESUME_PROMPT : running.task,
        codexBin: options.codexBin,
        codexArgsPrefix: options.codexArgsPrefix,
        env: options.env
      });
    }

    const updated = await applyResult(running, result, options);
    await saveJob(options.stateDir, updated);
    return updated;
  });
}

async function applyResult(job: Job, result: CodexRunResult, options: RunOptions): Promise<Job> {
  const threadId = result.threadId ?? job.threadId;
  if (result.completed && result.exitCode === 0) {
    await maybeNotify(options, "Codex task completed", job.id);
    return { ...job, status: "completed", threadId, lastError: undefined };
  }
  if (result.rateLimit) {
    const resetAt = result.resetAt ?? job.resetAt;
    const nextRunAt = resetAt ? nextRunAtFromReset(resetAt) : Date.now() + nextBackoffMs(job.retryCount);
    await maybeNotify(
      options,
      "Codex quota exhausted",
      resetAt ? `Resume planned at ${new Date(resetAt * 1000).toISOString()}` : "Resume planned with retry backoff"
    );
    return {
      ...job,
      status: "waiting_rate_limit",
      threadId,
      resetAt,
      nextRunAt,
      retryCount: job.retryCount + 1,
      lastError: result.error
    };
  }
  if (job.resumeAttempts >= MAX_AUTO_RESUMES) {
    await maybeNotify(options, "Codex auto resume failed", `${job.id} exceeded ${MAX_AUTO_RESUMES} resumes`);
    return { ...job, status: "failed", threadId, lastError: result.error ?? `exit ${result.exitCode}` };
  }
  return {
    ...job,
    status: "waiting_rate_limit",
    threadId,
    nextRunAt: Date.now() + nextBackoffMs(job.retryCount),
    retryCount: job.retryCount + 1,
    lastError: result.error ?? `exit ${result.exitCode}`
  };
}

async function maybeNotify(options: RunOptions, title: string, message: string): Promise<void> {
  if (options.notify === false) {
    return;
  }
  await sendNotification(title, message);
}
