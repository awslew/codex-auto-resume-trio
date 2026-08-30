import { DEFAULT_RESUME_PROMPT } from "../constants.js";
import { DEFAULT_SANDBOX } from "../constants.js";
import { classifyRateLimit } from "../rate-limit.js";
import type { CodexRunResult, Job } from "../types.js";
import { AppServerClient } from "./client.js";

export async function validateThreadResume(
  job: Pick<Job, "cwd" | "threadId" | "sandbox">,
  options: { codexBin?: string; codexArgsPrefix?: string[]; env?: NodeJS.ProcessEnv } = {}
): Promise<void> {
  const client = new AppServerClient({
    codexBin: options.codexBin,
    codexArgsPrefix: options.codexArgsPrefix,
    cwd: job.cwd,
    env: options.env
  });
  try {
    await client.start();
    await client.request(
      "thread/resume",
      { threadId: job.threadId, cwd: job.cwd, sandbox: job.sandbox ?? DEFAULT_SANDBOX },
      20_000
    );
  } finally {
    client.stop();
  }
}

export async function resumeWithAppServer(
  job: Job,
  options: { codexBin?: string; codexArgsPrefix?: string[]; env?: NodeJS.ProcessEnv; prompt?: string }
): Promise<CodexRunResult> {
  const client = new AppServerClient({
    codexBin: options.codexBin,
    codexArgsPrefix: options.codexArgsPrefix,
    cwd: job.cwd,
    env: options.env
  });
  try {
    await client.start();
    const limits = await client.request("account/rateLimits/read", undefined, 15_000);
    const classification = classifyRateLimit(limits);
    if (classification.isRateLimit) {
      return {
        exitCode: 1,
        completed: false,
        failed: true,
        rateLimit: true,
        resetAt: classification.resetAt,
        error: "rate limit still active"
      };
    }
    await client.request(
      "thread/resume",
      { threadId: job.threadId, cwd: job.cwd, sandbox: job.sandbox ?? DEFAULT_SANDBOX },
      20_000
    );
    const completed = client.waitForNotification("turn/completed", 120_000);
    await client.request(
      "turn/start",
      {
        threadId: job.threadId,
        cwd: job.cwd,
        input: [{ type: "text", text: options.prompt ?? DEFAULT_RESUME_PROMPT, text_elements: [] }]
      },
      20_000
    );
    await completed;
    return { exitCode: 0, threadId: job.threadId, completed: true, failed: false, rateLimit: false };
  } finally {
    client.stop();
  }
}
