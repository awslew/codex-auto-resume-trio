import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { runDaemon, startDaemon, stopDaemon } from "./daemon.js";
import { defaultStateDir } from "./paths.js";
import { createJob, loadJob, loadJobs, saveJob, summarizeJob } from "./store.js";
import { runJobOnce } from "./supervisor.js";
import { validateThreadResume } from "./app-server/supervisor.js";
import {
  pickSessions,
  scanDesktopSessions,
  type DesktopSession
} from "./desktop-sessions.js";

const program = new Command();
const stateDir = defaultStateDir();

program.name("car").description("Codex Auto Resume, an unofficial local Codex CLI supervisor").version("0.1.0");

program
  .command("run")
  .argument("<task>")
  .description("Run a Codex task and automatically resume it after quota reset")
  .action(async (task: string) => {
    const job = await createJob({ stateDir, cwd: process.cwd(), task });
    console.log(`job ${job.id} created`);
    const result = await runJobOnce(job.id, { stateDir });
    console.log(result ? summarizeJob(result) : `job ${job.id} is already locked`);
  });

program
  .command("adopt")
  .argument("<thread-id>")
  .argument("<task>")
  .option("--cwd <dir>", "Working directory for the adopted thread", process.cwd())
  .description("Adopt an existing Codex thread after validating it can be resumed")
  .action(async (threadId: string, task: string, options: { cwd: string }) => {
    const cwd = path.resolve(options.cwd);
    await validateThreadResume({ cwd, threadId });
    const job = await createJob({ stateDir, cwd, task });
    const adopted = { ...job, status: "waiting_rate_limit" as const, threadId, nextRunAt: Date.now() };
    await saveJob(stateDir, adopted);
    console.log(summarizeJob(adopted));
  });

program
  .command("status")
  .description("Show daemon and job summary")
  .action(async () => {
    const jobs = await loadJobs(stateDir);
    const active = jobs.filter((job) => !["completed", "failed", "canceled"].includes(job.status));
    console.log(`state: ${stateDir}`);
    console.log(`jobs: ${jobs.length}, active: ${active.length}`);
    for (const job of active) {
      console.log(summarizeJob(job));
    }
  });

program
  .command("desktop-sessions")
  .description("Scan Codex Desktop sessions stopped by a usage limit")
  .option("--json", "Print raw JSON (no interactive picker)")
  .action(async (options: { json?: boolean }) => {
    const sessions = scanDesktopSessions();
    if (options.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log("No desktop sessions are currently stopped by a usage limit.");
      return;
    }
    console.log(`Found ${sessions.length} session(s) stopped by a usage limit:\n`);
    for (const s of sessions) {
      const reset = s.resetAt ? new Date(s.resetAt * 1000).toLocaleString() : "unknown";
      const tokens = s.tokensUsed > 0 ? `${(s.tokensUsed / 1_000_000).toFixed(1)}M` : "-";
      console.log(`  ${s.title}`);
      console.log(`    id: ${s.threadId}`);
      console.log(`    cwd: ${s.cwd}`);
      console.log(`    limit: ${s.limitKind ?? "usage limit"} | reset: ${reset} | tokens: ${tokens}`);
    }
  });

program
  .command("desktop-resume")
  .description("Scan desktop sessions, pick which to resume, and schedule auto-resume jobs")
  .option("--all", "Pick every limit-stopped session without asking")
  .option("--select <ids>", "Comma-separated thread ids to resume (no prompt)", (v) => v.split(",").map((s) => s.trim()))
  .option("--dry-run", "Scan and print what would be scheduled, but create no jobs")
  .action(async (options: { all?: boolean; select?: string[]; dryRun?: boolean }) => {
    const sessions = scanDesktopSessions();
    if (sessions.length === 0) {
      console.log("No desktop sessions are currently stopped by a usage limit.");
      return;
    }

    const picked = await pickSessions(sessions, {
      select: options.select,
      all: options.all
    });

    if (picked.length === 0) {
      console.log("No sessions selected; nothing scheduled.");
      return;
    }

    console.log(`\nScheduling auto-resume for ${picked.length} session(s):\n`);
    for (const s of picked) {
      const reset = s.resetAt ? new Date(s.resetAt * 1000).toLocaleString() : "unknown (backoff)";
      console.log(`  - ${s.title}`);
      console.log(`    id: ${s.threadId} | reset: ${reset}`);
      if (options.dryRun) {
        continue;
      }
      try {
        const job = await createJob({
          stateDir,
          cwd: s.cwd || process.cwd(),
          task: s.title || "resume desktop session"
        });
        const scheduled = {
          ...job,
          status: "waiting_rate_limit" as const,
          threadId: s.threadId,
          resetAt: s.resetAt,
          nextRunAt: s.resetAt ? s.resetAt * 1000 + 30_000 : Date.now() + 30_000
        };
        await saveJob(stateDir, scheduled);
        console.log(`    scheduled job ${job.id}`);
      } catch (error) {
        console.log(
          `    SKIPPED (cannot create job): ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (!options.dryRun) {
      console.log(
        `\nScheduled. Start the daemon with: car daemon start\n` +
          `Watch with: car status`
      );
    }
  });

program
  .command("jobs")
  .description("List all jobs")
  .action(async () => {
    for (const job of await loadJobs(stateDir)) {
      console.log(summarizeJob(job));
    }
  });

program
  .command("logs")
  .argument("[job-id]")
  .description("Print job logs")
  .action(async (jobId?: string) => {
    const jobs = await loadJobs(stateDir);
    const selected = jobId ? await loadJob(stateDir, jobId) : jobs.at(-1);
    if (!selected) {
      throw new Error("job not found");
    }
    console.log(await readFile(selected.logPath, "utf8"));
  });

program
  .command("cancel")
  .argument("<job-id>")
  .description("Cancel a waiting job")
  .action(async (jobId: string) => {
    const job = await loadJob(stateDir, jobId);
    if (!job) {
      throw new Error(`job not found: ${jobId}`);
    }
    await saveJob(stateDir, { ...job, status: "canceled" });
    console.log(`canceled ${jobId}`);
  });

const daemon = program.command("daemon").description("Manage the background daemon");

daemon
  .command("start")
  .description("Start daemon in the background")
  .action(async () => {
    const pid = await startDaemon(stateDir);
    console.log(`daemon pid ${pid}`);
  });

daemon
  .command("stop")
  .description("Stop daemon")
  .action(async () => {
    const stopped = await stopDaemon(stateDir);
    console.log(stopped ? "daemon stopped" : "daemon was not running");
  });

daemon
  .command("foreground")
  .description("Run daemon in the foreground")
  .action(async () => {
    console.log(`daemon foreground state=${stateDir}`);
    await runDaemon({ stateDir });
  });

program
  .command("doctor")
  .description("Show resolved paths")
  .action(() => {
    console.log(`state: ${stateDir}`);
    console.log(`cwd: ${path.resolve(process.cwd())}`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
