/**
 * Scan the Codex Desktop session store (read-only) to find sessions that were
 * stopped by a usage/rate limit and need resuming.
 *
 * Data sources (all read-only, opened with mode=ro so we never mutate Codex's
 * own databases):
 *
 *  - ~/.codex/state_5.sqlite            -> threads table: id, title, cwd, updated_at, tokens_used
 *  - ~/.codex/thread_history_1.sqlite   -> thread_turns table: status ('failed' with
 *                                          error_json containing "usage limit"), started_at
 *
 * A session "needs resume" iff its latest turn status is 'failed' and the
 * error_json contains a usage-limit / rate-limit message.  Sessions whose last
 * turn is 'completed' (or never failed) do NOT need resume — exactly the
 * "resume only what actually stopped" requirement.
 */

import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { RateLimitClassification } from "./rate-limit.js";

export type DesktopSession = {
  threadId: string;
  title: string;
  cwd: string;
  updatedAt: string; // ISO string
  tokensUsed: number;
  /** Unix seconds when the usage limit resets, if the error message carried one. */
  resetAt?: number;
  /** Short human reason (e.g. "5-hour usage limit", "weekly usage limit"). */
  limitKind?: string;
  /** The raw last error message (trimmed, length-capped). */
  lastError?: string;
};

/** 会话运行状态（看板用）：running=正在跑 / waiting=已停等额度 / idle=空闲 / done=已完成 */
export type SessionActivity = "running" | "waiting" | "idle" | "done" | "unknown";

function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? path.join(homedir(), ".codex");
}

function dbPath(env: NodeJS.ProcessEnv): { threads: string; turns: string } {
  const home = codexHome(env);
  return {
    threads: path.join(home, "state_5.sqlite"),
    turns: path.join(home, "thread_history_1.sqlite")
  };
}

/** Open a SQLite DB read-only using the built-in node:sqlite (Node >= 22.5). */
function openRo(file: string): {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
} {
  return new DatabaseSync(file, { readOnly: true }) as never;
}

/** Parse "try again at 4:03 PM" / "in 4 days 20 hours" into a unix-seconds reset time. */
export function parseTryAgainAt(message: string, nowMs: number = Date.now()): number | undefined {
  if (!message) return undefined;

  // Absolute local clock time: "try again at 4:03 PM", "try again at 11:23 PM"
  let m = message.match(/try again at (\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (m) {
    let hour = Number(m[1]);
    const minute = Number(m[2] ?? 0);
    const ampm = (m[3] ?? "").toUpperCase();
    if (ampm) {
      if (hour < 1 || hour > 12) return undefined;
      if (ampm === "PM" && hour !== 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;
    } else if (hour > 23) {
      return undefined;
    }
    if (minute > 59) return undefined;

    const now = new Date(nowMs);
    const local = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0,
      0
    );
    let ts = Math.floor(local.getTime() / 1000);
    // If that time already passed today, assume tomorrow.
    if (ts * 1000 <= nowMs) {
      ts += 24 * 3600;
    }
    return ts;
  }

  // Relative duration: "try again in 4 days 20 hours", "in 2h 15m", "in about 3h"
  m = message.match(/try again in\s+(?:about\s+)?(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (m) {
    const days = Number(m[1] ?? 0);
    const hours = Number(m[2] ?? 0);
    const minutes = Number(m[3] ?? 0);
    if (!(days || hours || minutes)) return undefined;
    return Math.floor(nowMs / 1000) + days * 86400 + hours * 3600 + minutes * 60;
  }

  return undefined;
}

/** Classify the limit kind from the error message (5-hour vs weekly vs other). */
export function classifyLimitKind(message: string): string | undefined {
  if (!message) return undefined;
  if (/week|weekly|7\s*days?|6\s*days?/i.test(message)) return "weekly limit";
  if (/5\s*hour|five\s*hour|hourly/i.test(message)) return "5-hour limit";
  if (/usage\s*limit|quota|rate\s*limit|limit\s*reached/i.test(message)) return "usage limit";
  return undefined;
}

/** Does this error message indicate a usage/rate limit stop (vs a normal error)? */
export function isUsageLimitError(message: string): boolean {
  return /usage\s*limit|rate\s*limit|quota|limit\s*reached|exceeded.*(limit|quota)/i.test(message);
}

/**
 * Scan the desktop session store and return sessions whose latest turn failed
 * with a usage-limit error.  Sorted by most recently updated first.
 */
export function scanDesktopSessions(env: NodeJS.ProcessEnv = process.env): DesktopSession[] {
  const { threads: threadsDb, turns: turnsDb } = dbPath(env);

  const threadsCon = openRo(threadsDb);
  const turnsCon = openRo(turnsDb);
  try {
    const rows = turnsCon
      .prepare(
        `SELECT thread_id, status, error_json, started_at
           FROM thread_turns`
      )
      .all() as Array<{
      thread_id: string;
      status: string;
      error_json: string | null;
      started_at: number | null;
    }>;

    // For each thread: find the latest turn that failed with a usage limit,
    // and check whether any completed turn exists AFTER it (if so, the task
    // actually finished later and does not need resume).
    const latestLimitFail = new Map<
      string,
      { started_at: number; error_json: string }
    >();
    const completedAt = new Map<string, number>();

    for (const row of rows) {
      const tid = row.thread_id;
      const at = row.started_at ?? 0;
      if (row.status === "completed") {
        completedAt.set(tid, Math.max(completedAt.get(tid) ?? 0, at));
        continue;
      }
      if (row.status !== "failed" || !row.error_json) continue;

      let message = "";
      try {
        const parsed = JSON.parse(row.error_json) as { message?: string };
        message = parsed.message ?? "";
      } catch {
        message = row.error_json;
      }
      if (!isUsageLimitError(message)) continue;

      const prev = latestLimitFail.get(tid);
      if (!prev || at > prev.started_at) {
        latestLimitFail.set(tid, { started_at: at, error_json: row.error_json });
      }
    }

    const threadRows = threadsCon
      .prepare(
        `SELECT id, title, cwd, updated_at, tokens_used
           FROM threads
          ORDER BY updated_at DESC`
      )
      .all() as Array<{
      id: string;
      title: string | null;
      cwd: string | null;
      updated_at: number | null;
      tokens_used: number | null;
    }>;

    const results: DesktopSession[] = [];
    for (const t of threadRows) {
      const fail = latestLimitFail.get(t.id);
      if (!fail) continue;

      // If a completed turn exists after the limit failure, the task was
      // finished later — no resume needed.
      const completedAfter = completedAt.get(t.id) ?? 0;
      if (completedAfter > fail.started_at) continue;

      let errorMessage = "";
      try {
        const parsed = JSON.parse(fail.error_json) as { message?: string };
        errorMessage = parsed.message ?? "";
      } catch {
        errorMessage = fail.error_json;
      }

      const resetAt = parseTryAgainAt(errorMessage);
      const kind = classifyLimitKind(errorMessage);
      const updatedMs = t.updated_at ? Number(t.updated_at) : 0;

      results.push({
        threadId: t.id,
        title: (t.title ?? "").trim().slice(0, 120) || "(untitled)",
        cwd: (t.cwd ?? "").replace(/^\\\\\?\\/, ""),
        updatedAt: updatedMs ? new Date(updatedMs * 1000).toISOString() : "",
        tokensUsed: t.tokens_used ?? 0,
        resetAt,
        limitKind: kind,
        lastError: errorMessage.slice(0, 300)
      });
    }

    results.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0));
    return results;
  } finally {
    threadsCon.close();
    turnsCon.close();
  }
}

/**
 * 内部代理会话标题特征（Codex 子代理/工具注入的会话，不是用户任务）。
 * 这些会话不应出现在"任务列表"里让用户勾选续跑。
 */
const INTERNAL_SESSION_TITLE_PATTERNS = [
  /^the following is the codex agent history/i,
  /^codex agent history/i,
  /^agent history/i,
  /^系统提示/i,
  /^system prompt/i,
  /^internal/i,
];

/** 判断是否为内部代理会话（非用户任务） */
export function isInternalSession(title: string): boolean {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return true; // 无标题视为内部
  return INTERNAL_SESSION_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * List ALL Codex desktop sessions (not just quota-stopped ones), annotated
 * with their current activity state.  Used by the taskboard "session list"
 * view so the user can pick which sessions to auto-resume.
 */
export function listCodexSessions(env: NodeJS.ProcessEnv = process.env): Array<
  DesktopSession & { activity: SessionActivity }
> {
  const { threads: threadsDb, turns: turnsDb } = dbPath(env);
  let threadsCon;
  let turnsCon;
  try {
    threadsCon = openRo(threadsDb);
    turnsCon = openRo(turnsDb);
    const threadRows = threadsCon
      .prepare(
        `SELECT id, title, cwd, updated_at, tokens_used
           FROM threads
          ORDER BY updated_at DESC`
      )
      .all() as Array<{
      id: string;
      title: string | null;
      cwd: string | null;
      updated_at: number | null;
      tokens_used: number | null;
    }>;

    // For each thread, find the latest turn and its status/error.
    const turnRows = turnsCon
      .prepare(
        `SELECT thread_id, status, error_json, started_at
           FROM thread_turns`
      )
      .all() as Array<{
      thread_id: string;
      status: string;
      error_json: string | null;
      started_at: number | null;
    }>;

    const latestTurn = new Map<string, { status: string; error_json: string | null; started_at: number }>();
    const completedAt = new Map<string, number>();
    for (const row of turnRows) {
      const tid = row.thread_id;
      const at = row.started_at ?? 0;
      if (row.status === "completed") {
        completedAt.set(tid, Math.max(completedAt.get(tid) ?? 0, at));
      }
      const prev = latestTurn.get(tid);
      if (!prev || at > prev.started_at) {
        latestTurn.set(tid, { status: row.status, error_json: row.error_json, started_at: at });
      }
    }

    const results: Array<DesktopSession & { activity: SessionActivity }> = [];
    for (const t of threadRows) {
      const turn = latestTurn.get(t.id);
      const updatedMs = t.updated_at ? Number(t.updated_at) : 0;
      const base: DesktopSession = {
        threadId: t.id,
        title: (t.title ?? "").trim().slice(0, 120) || "(untitled)",
        cwd: (t.cwd ?? "").replace(/^\\\\\?\\/, ""),
        updatedAt: updatedMs ? new Date(updatedMs * 1000).toISOString() : "",
        tokensUsed: t.tokens_used ?? 0,
      };

      let activity: SessionActivity = "unknown";
      if (!turn) {
        activity = "idle";
      } else if (turn.status === "failed" && turn.error_json) {
        let message = "";
        try {
          const parsed = JSON.parse(turn.error_json) as { message?: string };
          message = parsed.message ?? "";
        } catch {
          message = turn.error_json;
        }
        if (isUsageLimitError(message)) {
          activity = "waiting";
          base.resetAt = parseTryAgainAt(message);
          base.limitKind = classifyLimitKind(message);
          base.lastError = message.slice(0, 300);
          // If a completed turn exists after the failure, the session actually finished.
          if ((completedAt.get(t.id) ?? 0) > turn.started_at) {
            activity = "done";
          }
        } else {
          activity = "idle";
          base.lastError = message.slice(0, 300);
        }
      } else if (turn.status === "completed") {
        activity = "done";
      } else if (turn.status === "in_progress" || turn.status === "running" || turn.status === "queued") {
        activity = "running";
      } else {
        activity = "idle";
      }

      results.push({ ...base, activity });
    }

    // 过滤内部代理会话（agent history 等），只留用户任务会话
    const userSessions = results.filter((session) => !isInternalSession(session.title));

    userSessions.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0));
    return userSessions;
  } catch (error) {
    // DB may not exist yet (fresh Codex install) — return empty.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally {
    threadsCon?.close();
    turnsCon?.close();
  }
}

/** Pick which sessions to resume, interactively or via --select ids. */
export function pickSessions(
  sessions: DesktopSession[],
  options: { select?: string[]; all?: boolean; yes?: boolean } = {}
): Promise<DesktopSession[]> | DesktopSession[] {
  if (sessions.length === 0) return [];

  if (options.all) return sessions;

  if (options.select && options.select.length > 0) {
    const wanted = new Set(options.select);
    const picked = sessions.filter((s) => wanted.has(s.threadId));
    if (picked.length === 0) {
      throw new Error(`no sessions matched the requested ids: ${options.select.join(", ")}`);
    }
    return picked;
  }

  // Interactive picker.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const fmtReset = (s: DesktopSession): string =>
    s.resetAt ? new Date(s.resetAt * 1000).toLocaleString() : "unknown";
  const fmtTok = (s: DesktopSession): string =>
    s.tokensUsed > 0 ? `${(s.tokensUsed / 1_000_000).toFixed(1)}M` : "-";

  console.log(`\nFound ${sessions.length} session(s) stopped by a usage limit:\n`);
  sessions.forEach((s, i) => {
    console.log(
      `  [${i + 1}] ${s.title}\n` +
        `      cwd:    ${s.cwd}\n` +
        `      limit:  ${s.limitKind ?? "usage limit"} | reset: ${fmtReset(s)} | tokens: ${fmtTok(s)}\n` +
        `      id:     ${s.threadId}`
    );
  });

  return new Promise<DesktopSession[]>((resolve) => {
    rl.question(
      `\nWhich sessions should be resumed after their limit resets?\n` +
        `  - numbers like "1,3" or "1-3" to pick specific ones\n` +
        `  - "all" to pick every one\n` +
        `  - empty to skip all (cancel)\n> `,
      (answer) => {
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        if (!trimmed) {
          resolve([]);
          return;
        }
        if (trimmed === "all") {
          resolve([...sessions]);
          return;
        }
        const wanted = new Set<number>();
        for (const part of trimmed.split(",")) {
          const p = part.trim();
          if (!p) continue;
          const range = p.match(/^(\d+)-(\d+)$/);
          if (range) {
            const lo = Number(range[1]);
            const hi = Number(range[2]);
            for (let n = lo; n <= hi; n++) wanted.add(n);
          } else if (/^\d+$/.test(p)) {
            wanted.add(Number(p));
          }
        }
        const picked = [...wanted]
          .filter((n) => n >= 1 && n <= sessions.length)
          .sort((a, b) => a - b)
          .map((n) => sessions[n - 1]);
        resolve(picked);
      }
    );
  });
}

export type { RateLimitClassification };
