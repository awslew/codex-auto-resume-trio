import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { GitBaseline } from "./types.js";

export async function captureGitBaseline(cwd: string): Promise<GitBaseline> {
  const isGitRepo = (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
  if (!isGitRepo) {
    return { isGitRepo: false, status: "", diffStat: "", capturedAt: new Date().toISOString() };
  }
  const status = (await runGit(cwd, ["status", "--porcelain=v1"])).stdout;
  const diffStat = (await runGit(cwd, ["diff", "--stat"])).stdout;
  return { isGitRepo, status, diffStat, capturedAt: new Date().toISOString() };
}

export async function assertCwdSafe(cwd: string, baseline?: GitBaseline): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await access(cwd);
  } catch {
    return { ok: false, reason: `cwd does not exist: ${cwd}` };
  }
  if (!baseline?.isGitRepo) {
    return { ok: true };
  }
  const current = await captureGitBaseline(cwd);
  const currentLines = current.status.split("\n").filter(Boolean);
  const baselineLines = baseline.status.split("\n").filter(Boolean);
  const addedLines = currentLines.filter((line) => !baselineLines.includes(line));
  if (addedLines.length >= 25) {
    return { ok: false, reason: `git workspace changed significantly (${addedLines.length} new status entries)` };
  }
  return { ok: true };
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.on("error", (error) => resolve({ stdout: "", stderr: error.message, code: 1 }));
  });
}
