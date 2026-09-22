/**
 * pgm-score.ts —— 把 pgm-board 的"项目总谱"感知能力移植为 TS 模块。
 *
 * 数据源（全部只读）：
 *  - ~/.codex/session_index.jsonl -> id -> { thread_name, updated_at }
 *  - ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl -> 会话转录
 *  - ~/.codex/state_5.sqlite (threads 表) -> id -> cwd（用于按工作区分组）
 *
 * 能力：
 *  - loadScore(env)：聚合全部 Codex 会话的转录，产出"项目总谱"——
 *    每个会话 = 一个声部，包含状态（思考/运行/待下一步）、最近汇报、
 *    时间色块（节奏）、卡住标记、静默时长；按工作区（cwd）分组。
 *  - statusOf / buildBeats / shortName：pgm_dash 的状态推断/色块/短名移植。
 */
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  loadSessionIndex,
  findRollouts,
  parseRollout,
  type RolloutMessage,
} from "./transcript.js";

/** 会话状态（pgm_dash 的 STATUS 表语义化） */
export type PgmState = "run" | "think" | "rep" | "idle" | "unknown";

/** 时间色块：高度 ∝ 此汇报前静默时长 */
export type PgmBeat = { ts: string; h: number; newest: boolean };

export type PgmSession = {
  sid: string;
  name: string;
  cwd: string;
  updatedAt: string;
  state: PgmState;
  stateLabel: string;
  ageMinutes: number | null;
  lastTs: string;
  lastSummary: string;
  beats: PgmBeat[];
  stalled: boolean;
  idleMinutes: number | null;
};

export type PgmWorkspace = {
  cwd: string;
  sessions: PgmSession[];
};

/** 最后一条记录类型 -> 语义状态（pgm.STATUS 表移植） */
const STATE_BY_ITEM_TYPE: Record<string, PgmState> = {
  reasoning: "think",
  function_call: "run",
  function_call_output: "run",
  custom_tool_call: "run",
  custom_tool_call_output: "run",
  message: "rep",
  session_meta: "idle",
};

const STATE_LABELS: Record<PgmState, { zh: string; en: string }> = {
  run: { zh: "运行中", en: "Running" },
  think: { zh: "思考中", en: "Thinking" },
  rep: { zh: "待下一步", en: "Waiting" },
  idle: { zh: "空闲", en: "Idle" },
  unknown: { zh: "未知", en: "Unknown" },
};

/** 状态排序优先级：运行 > 思考 > 待下一步 > 其他 */
const STATE_ORDER: Record<PgmState, number> = {
  run: 0,
  think: 1,
  rep: 2,
  idle: 3,
  unknown: 99,
};

function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? path.join(homedir(), ".codex");
}

/** 根据最后一条记录类型 + 时间推断状态与静默时长（pgm.status_of 移植） */
export function statusOf(
  lastItem: { type: string } | null,
  lastTs: string | null,
  now = Date.now(),
): { state: PgmState; ageMinutes: number | null } {
  const state = lastItem ? (STATE_BY_ITEM_TYPE[lastItem.type] ?? "unknown") : "unknown";
  let ageMinutes: number | null = null;
  if (lastTs) {
    const ms = Date.parse(lastTs);
    if (!Number.isNaN(ms)) {
      ageMinutes = Math.max(0, Math.floor((now - ms) / 60_000));
    }
  }
  return { state, ageMinutes };
}

/** 把最近汇报时间戳转成乐谱色块（pgm_dash.build_beats 移植）。时间戳为 UTC ISO，
 * 色块标签转本地时区显示（HH:mm），与前端 timeLabel 一致。 */
export function buildBeats(messages: RolloutMessage[], top = 4): PgmBeat[] {
  const times = messages.map((message) => Date.parse(message.ts));
  const beats: PgmBeat[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const ts = times[i];
    if (Number.isNaN(ts)) continue;
    const gap = i === 0 ? 4 : (ts - times[i - 1]) / 60_000;
    const h = Math.max(12, Math.min(60, 12 + gap * 0.5));
    beats.push({
      ts: localTimeLabel(messages[i].ts),
      h: Math.round(h),
      newest: i === times.length - 1,
    });
  }
  return beats.slice(-top);
}

/** UTC ISO -> 本地时区 HH:mm（与时区无关的纯计算，避免环境 locale 差异）。 */
function localTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把长项目名压成干净短标题（pgm_dash.short_name 移植） */
export function shortName(name: string): string {
  let n = name;
  if (n.startsWith("项目：")) n = n.slice(3);
  n = n.trim().replace(/^["'“”]+|["'“”]+$/g, "");
  for (const sep of "（，,。") {
    const i = n.indexOf(sep);
    if (i > 0 && i <= 26) {
      n = n.slice(0, i);
      break;
    }
  }
  n = n.trim();
  if (n.length > 22) n = `${n.slice(0, 22)}…`;
  return n;
}

/** 静默时长（分钟）：最近助手汇报到现在；无汇报返回 null */
function idleOf(messages: RolloutMessage[], now = Date.now()): number | null {
  if (messages.length === 0) return null;
  const lastMs = Date.parse(messages[messages.length - 1].ts);
  if (Number.isNaN(lastMs)) return null;
  return Math.max(0, Math.floor((now - lastMs) / 60_000));
}

/** 卡住：最近助手汇报后超过 stallMinutes 分钟无新活动 */
function stalledOf(messages: RolloutMessage[], stallMinutes = 30, now = Date.now()): boolean {
  const idle = idleOf(messages, now);
  return idle !== null && idle > stallMinutes;
}

/** 最近助手汇报（压成一行，截断） */
function latestSummary(messages: RolloutMessage[], maxChars = 200): string {
  if (messages.length === 0) return "";
  const compact = messages[messages.length - 1].text.replace(/\s+/g, " ").trim();
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
}

/** 打开 Codex threads 库（只读）取 id -> cwd */
function loadThreadCwd(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const map = new Map<string, string>();
  const db = path.join(codexHome(env), "state_5.sqlite");
  let con: DatabaseSync | null = null;
  try {
    con = new DatabaseSync(db, { readOnly: true });
    const rows = con.prepare("SELECT id, cwd FROM threads").all() as Array<{
      id: string;
      cwd: string | null;
    }>;
    for (const row of rows) {
      if (row.id && row.cwd) map.set(row.id, row.cwd.replace(/^\\\\\?\\/, ""));
    }
  } catch {
    // DB may not exist yet (fresh Codex install) — empty map is fine.
  } finally {
    con?.close();
  }
  return map;
}

/**
 * 聚合全部 Codex 会话转录，产出"项目总谱"。
 * 按工作区（cwd）分组；组内按最近活动排序，组间按最新活动排序。
 * 只包含有转录且有标题的会话。
 */
export function loadScore(
  env: NodeJS.ProcessEnv = process.env,
  options: { stallMinutes?: number; maxSessions?: number } = {},
): PgmWorkspace[] {
  const stallMinutes = options.stallMinutes ?? 30;
  const maxSessions = options.maxSessions ?? 200;
  const now = Date.now();
  const index = loadSessionIndex(env);
  const cwdByThread = loadThreadCwd(env);
  const sessions: PgmSession[] = [];

  for (const [sid, meta] of index) {
    const name = meta.threadName.trim();
    if (!name) continue;
    const rollouts = findRollouts(sid, env);
    if (rollouts.length === 0) continue;

    const messages: RolloutMessage[] = [];
    let lastItem: { type: string; ts: string } | null = null;
    for (const rollout of rollouts) {
      const parsed = parseRollout(rollout);
      messages.push(...parsed.messages);
      if (parsed.lastItem) lastItem = parsed.lastItem;
    }
    if (messages.length === 0 && lastItem === null) continue;
    messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    // 最后一条记录的 ts（可能是工具调用，也可能就是汇报）
    const lastRecordTs = lastItem?.ts ?? (messages.length > 0 ? messages[messages.length - 1].ts : meta.updatedAt);
    const { state, ageMinutes } = statusOf(lastItem, lastRecordTs, now);

    sessions.push({
      sid,
      name,
      cwd: cwdByThread.get(sid) ?? "",
      updatedAt: meta.updatedAt,
      state,
      stateLabel: STATE_LABELS[state][env.PGM_LANGUAGE === "en" ? "en" : "zh"],
      ageMinutes,
      lastTs: lastRecordTs,
      lastSummary: latestSummary(messages),
      beats: buildBeats(messages),
      stalled: stalledOf(messages, stallMinutes, now),
      idleMinutes: idleOf(messages, now),
    });
  }

  // 排序：状态优先级（运行 > 思考 > 待下一步）优先，其次最近更新
  sessions.sort((a, b) => (
    STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || (b.lastTs < a.lastTs ? -1 : b.lastTs > a.lastTs ? 1 : 0)
  ));

  // 性能保护：最多保留 maxSessions 个
  const kept = sessions.slice(0, maxSessions);

  // 按 cwd 分组（无 cwd 的归入 "(unknown)"）
  const groups = new Map<string, PgmSession[]>();
  for (const session of kept) {
    const key = session.cwd || "(unknown)";
    const list = groups.get(key);
    if (list) list.push(session);
    else groups.set(key, [session]);
  }
  const workspaces = [...groups.entries()].map(([cwd, list]) => ({ cwd, sessions: list }));
  workspaces.sort((a, b) => (
    (b.sessions[0]?.lastTs < a.sessions[0]?.lastTs ? -1 : b.sessions[0]?.lastTs > a.sessions[0]?.lastTs ? 1 : 0)
  ));
  return workspaces;
}
