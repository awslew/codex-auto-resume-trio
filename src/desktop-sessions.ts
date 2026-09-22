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
import type { DesktopSessionData, DesktopTurnRow } from "./desktop-session-observation.js";
import type { RateLimitClassification } from "./rate-limit.js";
import {
  summarizeSession,
  recentSummaries,
  isSessionStalled,
  idleMinutes,
} from "./transcript.js";

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
  /** 最近助手汇报摘要（转录解析，仅活跃会话） */
  lastSummary?: string | null;
  /** 最近助手汇报时间（ISO） */
  lastActivityAt?: string | null;
  /** 卡住标记：最近汇报后超过 30 分钟无新活动 */
  stalled?: boolean;
  /** 静默分钟数 */
  idleMinutes?: number | null;
  /** Codex threads.source 原始值（vscode=用户桌面会话 / subagent=子代理 / exec=工具） */
  source?: string | null;
};

/** 会话运行状态（看板用，四类标签）：
 * running=进行中 / waiting=额度已耗尽 / paused=已中止 / done=已完成
 * idle 已并入 done（用户要求四类标签，空闲与已完成不重复显示）。
 */
export type SessionActivity = "running" | "waiting" | "paused" | "done" | "unknown";

/**
 * 可信会话观测的纯映射/类型/时间校验已移入 desktop-session-observation.ts
 * （零 node:sqlite 依赖，测试可直连）。本模块仅以类型形式重导出并负责 sqlite
 * 查询（collectDesktopSessionData）。消费方（T4 服务端 API / T2 monitor）只读
 * 消费，不写数据库。
 */
export type {
  SessionObservationState,
  SessionObservationConfidence,
  SessionObservation,
  DesktopTurnRow,
  DesktopSessionRow,
  DesktopSessionData,
} from "./desktop-session-observation.js";
export { observeDesktopSession, observeDesktopSessions } from "./desktop-session-observation.js";
export { isPlausibleTurnTs, isOrderableTurnTs, SESSION_FRESH_WINDOW_MS } from "./desktop-session-observation.js";
export { SESSION_OBSERVATION_REVISION } from "./desktop-session-observation.js";

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
 * 注意：Codex 桌面"附件模板头"（# Files mentioned by the user）不在此列——
 * 首条消息带附件的真实任务标题也是这个头（2026-09-06 demo 交接会话误杀），
 * 由 isAttachmentTemplateSkeleton 只过滤无实质内容的空壳。
 */
const INTERNAL_SESSION_TITLE_PATTERNS = [
  /^the following is the codex agent history/i,
  /^codex agent history/i,
  /^agent history/i,
  /^系统提示/i,
  /^system prompt/i,
  /^internal/i,
];

/** Codex 桌面附件模板头：首条消息带附件时，桌面用消息原文作会话标题。 */
const ATTACHMENT_TEMPLATE_HEADER_RE = /^#\s*files mentioned by the user/i;

/**
 * 判断是否为"附件模板空壳"标题（非用户任务）：模板头之后既没有文件清单段
 * （## 文件名: 路径）也没有用户请求正文（## My request: 内容）。
 * 真实任务标题截断到 120 字符时仍落在文件清单段内，"## My request:" 可能
 * 已被截掉，所以两条证据任一存在即视为真实任务。
 */
export function isAttachmentTemplateSkeleton(title: string): boolean {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return false; // 空标题由 isNoiseSession 处理
  if (!ATTACHMENT_TEMPLATE_HEADER_RE.test(trimmed)) return false;
  // 文件清单段 = "## 标题" 行且不是 "## My request:" 标记行（空请求段的
  // "## My request:" 本身也匹配 "##\s+\S"，必须排除，否则空壳漏判为真实任务）。
  const hasFileListSection = /(^|\n)##(?!\s*my request\s*:)\s+\S/i.test(trimmed);
  const hasRequestContent = /##\s*my request:\s*\S/i.test(trimmed);
  return !hasFileListSection && !hasRequestContent;
}

/** 判断是否为内部代理会话（非用户任务） */
export function isInternalSession(title: string): boolean {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return true; // 无标题视为内部
  return INTERNAL_SESSION_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** 内部/子代理会话 source 特征（threads.source 字段）。
 * Codex 子代理（guardian 审批代理、thread_spawn worker）与 exec 工具会话
 * 都不是用户发起的任务，一律过滤。
 * 真实值示例：
 *  - "vscode"（用户桌面会话，保留）
 *  - "{\"subagent\":{\"other\":\"guardian\"}}"（审批/守护子代理，过滤）
 *  - "{\"subagent\":{\"thread_spawn\":{...}}}"（子代理 worker，过滤）
 *  - "exec"（工具执行的会话，过滤）
 */
const INTERNAL_SOURCE_PATTERNS = [
  /subagent/i,
  /guardian/i,
  /thread_spawn/i,
  /^exec$/i,
];

/** 判断 source 是否为内部/子代理会话（非用户任务） */
export function isInternalSource(source: string | null | undefined): boolean {
  const raw = (source ?? "").trim();
  if (!raw) return false;
  return INTERNAL_SOURCE_PATTERNS.some((pattern) => pattern.test(raw));
}

/** 内部/工具目录特征（cwd）：codex-auto-resume、deepseek-project、deepseek-harness、dsh 等自用工具目录。
 * 这些目录里的会话是开发/测试本工具产生的，不属于用户任务，不出现在任务列表。
 */
const INTERNAL_CWD_PATTERNS = [
  /codex-auto-resume/i,
  /deepseek-project/i,
  /deepseek-harness/i,
  /[\\/]dsh[\\/]/i,
  /\\dsh$/i,
  /\.dsh$/i,
  /taskboard/i,
];

/** 判断 cwd 是否为内部/工具目录（非用户项目） */
export function isInternalCwd(cwd: string): boolean {
  return INTERNAL_CWD_PATTERNS.some((pattern) => pattern.test(cwd ?? ""));
}

/**
 * 无意义/自动续跑产物会话标题（不是用户发起的真实任务）：
 *  - 空标题（Codex 桌面有时会留下无标题会话，显示为 "(untitled)"）
 *  - 纯 "resume"（自动续跑 CLI/守护生成的续跑会话）
 * 这些不应出现在任务列表里。
 */
const NOISE_SESSION_TITLE_PATTERNS = [
  /^resume\b/i,
  /^\(?untitled\)?$/i,
];

/** 判断是否为无意义/自动续跑产物会话（非用户任务） */
export function isNoiseSession(title: string): boolean {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return true; // 空标题视为无意义
  return NOISE_SESSION_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
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
        `SELECT id, title, cwd, updated_at, tokens_used, source
           FROM threads
          ORDER BY updated_at DESC`
      )
      .all() as Array<{
      id: string;
      title: string | null;
      cwd: string | null;
      updated_at: number | null;
      tokens_used: number | null;
      source: string | null;
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
        source: t.source ?? null,
      };

      let activity: SessionActivity = "unknown";
      const nowSec = Math.floor(Date.now() / 1000);
      // threads.updated_at 很新只能作为"会话有活动"的弱信号；真正判定"进行中"
      // 以 thread_turns 里存在 inProgress 行为准（思考/执行/输出结论阶段都会落
      // inProgress turn）。completed/interrupted 的会话即使 updated_at 还在被桌面
      // touch（Codex 进程心跳），也已完成/已中止，不再翻成"进行中"。
      const freshUpdated = updatedMs > 0 && nowSec - updatedMs <= 180;
      if (!turn) {
        // 无任何 turn 但 updated_at 很新：刚创建还在初始化（未落 turn）
        activity = freshUpdated ? "running" : "done";
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
          activity = "done";
          base.lastError = message.slice(0, 300);
        }
      } else if (turn.status === "completed") {
        // 最后一次 turn 已 completed：会话已完成，不因 updated_at 心跳翻"进行中"
        activity = "done";
      } else if (
        turn.status === "inProgress"
        || turn.status === "in_progress"
        || turn.status === "running"
        || turn.status === "queued"
      ) {
        activity = "running";
      } else if (turn.status === "interrupted") {
        // 被手动暂停/中止（思考或执行过程中，没有结论输出）
        // 用户重新播放后 Codex 会新建 inProgress turn，届时自然翻"进行中"
        activity = "paused";
      } else {
        activity = "done";
      }

      results.push({ ...base, activity });
    }

    // 过滤内部代理会话（agent history 等）、子代理会话（guardian/thread_spawn/exec source）、
    // 内部/工具目录（codex-auto-resume 等）与无意义/自动续跑产物（空标题、纯 resume），
    // 以及"附件模板空壳"（只有模板头、无文件清单无请求正文），只留用户发起的任务会话
    const userSessions = results.filter(
      (session) =>
        !isInternalSession(session.title)
        && !isAttachmentTemplateSkeleton(session.title)
        && !isInternalCwd(session.cwd)
        && !isNoiseSession(session.title)
        && !isInternalSource(session.source)
    );

    userSessions.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0));

    // 附加转录摘要（最近助手汇报 + 卡住标记）。只对非 done 的会话做，
    // 且最多处理 MAX_TRANSCRIPT_SESSIONS 个（性能保护）。
    const activeSessions = userSessions.filter((session) => session.activity !== "done");
    const MAX_TRANSCRIPT_SESSIONS = 60;
    for (const session of activeSessions.slice(0, MAX_TRANSCRIPT_SESSIONS)) {
      try {
        const transcript = summarizeSession(session.threadId, env);
        if (transcript.lastMessageTs) {
          session.lastSummary = recentSummaries(transcript, 1, 200)[0] ?? null;
          session.lastActivityAt = transcript.lastMessageTs;
          session.stalled = isSessionStalled(transcript, 30);
          session.idleMinutes = idleMinutes(transcript);
        }
      } catch {
        // transcript read failure is non-fatal for the list
      }
    }

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

/**
 * 默认批量采集器：从 Codex 桌面库读取 threads + thread_turns（只读）。
 * 已与 listCodexSessions 共享的打开方式一致：mode=ro，绝不写用户数据库。
 */
export function collectDesktopSessionData(env: NodeJS.ProcessEnv): Map<string, DesktopSessionData> {
  const { threads: threadsDb, turns: turnsDb } = dbPath(env);
  const threadsCon = openRo(threadsDb);
  const turnsCon = openRo(turnsDb);
  try {
    const threadRows = threadsCon
      .prepare(`SELECT id, updated_at FROM threads`)
      .all() as Array<{ id: string; updated_at: number | null }>;
    const turnRows = turnsCon
      .prepare(`SELECT thread_id, status, error_json, started_at FROM thread_turns`)
      .all() as Array<DesktopTurnRow & { thread_id: string }>;

    const byThread = new Map<string, DesktopSessionData>();
    for (const t of threadRows) {
      byThread.set(t.id, { threadId: t.id, session: { updated_at: t.updated_at }, turns: [] });
    }
    for (const r of turnRows) {
      const entry = byThread.get(r.thread_id);
      if (!entry) continue; // 孤儿 turn：所属 thread 不在 threads 表，跳过
      entry.turns.push({ status: r.status, started_at: r.started_at, error_json: r.error_json });
    }
    return byThread;
  } finally {
    threadsCon.close();
    turnsCon.close();
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
