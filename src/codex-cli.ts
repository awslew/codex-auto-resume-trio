import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { DEFAULT_SANDBOX } from "./constants.js";
import { resolveCodexBin } from "./codex-bin.js";
import { JsonlParser } from "./jsonl.js";
import { classifyRateLimit } from "./rate-limit.js";
import type { CodexRunResult, Job } from "./types.js";

export async function runCodexCli(
  job: Job,
  input: { resume: boolean; prompt: string; codexBin?: string; codexArgsPrefix?: string[]; env?: NodeJS.ProcessEnv }
): Promise<CodexRunResult> {
  const resolved = input.codexBin ? { command: input.codexBin, prefix: [] as string[], resolved: input.codexBin } : resolveCodexBin();
  const binArgs = resolved.prefix;
  const args = [...binArgs, ...buildCodexArgs(job, input)];

  const log = createWriteStream(job.logPath, { flags: "a", mode: 0o600 });
  log.write(`\n[${new Date().toISOString()}] $ ${[resolved.command, ...args].join(" ")}\n`);

  return new Promise((resolve) => {
    const child = spawn(resolved.command, args, {
      cwd: job.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const parser = new JsonlParser();
    const result: CodexRunResult = { exitCode: null, completed: false, failed: false, rateLimit: false };

    const handleValue = (value: unknown): void => {
      log.write(`${JSON.stringify(value)}\n`);
      const event = value as Record<string, unknown>;
      const type = String(event.type ?? event.method ?? "");
      const params = isObject(event.params) ? event.params : event;
      if (type === "thread.started" || type === "thread/started") {
        const threadId = event.thread_id ?? event.threadId ?? params.thread_id ?? params.threadId;
        if (typeof threadId === "string") {
          result.threadId = threadId;
        }
      }
      if (type === "turn.completed" || type === "turn/completed") {
        result.completed = true;
      }
      if (type === "turn.failed" || type === "turn/failed" || type === "error") {
        result.failed = true;
        result.error = collectMessage(event);
      }
      const rateLimit = classifyRateLimit(event);
      if (rateLimit.isRateLimit) {
        result.rateLimit = true;
        result.resetAt = rateLimit.resetAt;
        result.error = result.error ?? rateLimit.reason;
      }
    };

    const handleChunk = (chunk: Buffer | string): void => {
      for (const parsed of parser.push(chunk)) {
        if (parsed.ok) {
          handleValue(parsed.value);
        } else {
          log.write(`[invalid-json] ${parsed.line}\n`);
        }
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", (chunk: Buffer) => {
      log.write(chunk);
      const text = chunk.toString();
      const rateLimit = classifyRateLimit(text);
      if (rateLimit.isRateLimit) {
        result.rateLimit = true;
        result.resetAt = result.resetAt ?? rateLimit.resetAt;
        result.error = result.error ?? text.trim();
      }
    });
    child.on("error", (error) => {
      result.failed = true;
      result.error = error.message;
    });
    child.on("close", (code) => {
      for (const parsed of parser.flush()) {
        if (parsed.ok) {
          handleValue(parsed.value);
        }
      }
      result.exitCode = code;
      if (code !== 0 && !result.rateLimit) {
        result.failed = true;
      }
      log.end(`[exit ${code}]\n`, () => resolve(result));
    });
  });
}

export function buildCodexArgs(
  job: Pick<Job, "threadId" | "sandbox">,
  input: { resume: boolean; prompt: string; codexArgsPrefix?: string[] }
): string[] {
  const sandboxArgs = ["-s", job.sandbox ?? DEFAULT_SANDBOX];
  const prefix = input.codexArgsPrefix ?? [];
  return input.resume
    ? [...prefix, ...sandboxArgs, "exec", "resume", "--skip-git-repo-check", job.threadId ?? "", "--json", input.prompt]
    : [...prefix, ...sandboxArgs, "exec", "--skip-git-repo-check", "--json", input.prompt];
}

function collectMessage(event: Record<string, unknown>): string | undefined {
  for (const key of ["message", "error", "detail"]) {
    const value = event[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
