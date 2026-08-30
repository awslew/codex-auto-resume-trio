/**
 * transcript.ts —— 把 pgm-board 的 Codex 转录解析能力移植为 TS 模块。
 *
 * 数据源（全部只读）：
 *  - ~/.codex/session_index.jsonl            -> id -> { thread_name, updated_at }
 *  - ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl -> 会话转录
 *
 * 能力：
 *  - findRollouts(sid)：找到某会话的全部 rollout 文件（按时间排序）
 *  - parseRollout(path)：解析单个 rollout，取助手文本汇报 + 最后一条记录
 *  - summarizeSession(sid)：汇总某会话的最近汇报（pgm 的 gather_projects 单会话版）
 *  - isSessionStalled(session)：卡住检测（最近汇报后长时间无新活动）
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export type RolloutMessage = { ts: string; text: string };

export type SessionTranscript = {
  messages: RolloutMessage[];
  lastItem: { type: string; role: string; ts: string } | null;
  lastMessageTs: string | null;
};

function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/** id -> { thread_name, updated_at }（pgm.load_index 移植） */
export function loadSessionIndex(env: NodeJS.ProcessEnv = process.env): Map<string, { threadName: string; updatedAt: string }> {
  const index = new Map<string, { threadName: string; updatedAt: string }>();
  const indexPath = path.join(codexHome(env), "session_index.jsonl");
  if (!existsSync(indexPath)) return index;
  const raw = readFileSync(indexPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { id?: string; thread_name?: string; updated_at?: string };
      if (!parsed.id) continue;
      index.set(parsed.id, {
        threadName: parsed.thread_name ?? "",
        updatedAt: parsed.updated_at ?? "",
      });
    } catch {
      // skip malformed line
    }
  }
  return index;
}

/** ~/.codex/sessions/YYYY/MM/DD/rollout-*-<sid>.jsonl，按时间排序（pgm.find_rollouts 移植） */
export function findRollouts(sid: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const base = path.join(codexHome(env), "sessions");
  const out: string[] = [];
  if (!existsSync(base)) return out;
  let years: string[];
  try {
    years = readdirSync(base);
  } catch {
    return out;
  }
  for (const year of years) {
    const yearPath = path.join(base, year);
    let months: string[];
    try {
      months = readdirSync(yearPath);
    } catch {
      continue;
    }
    for (const month of months) {
      const monthPath = path.join(yearPath, month);
      let days: string[];
      try {
        days = readdirSync(monthPath);
      } catch {
        continue;
      }
      for (const day of days) {
        const dayPath = path.join(monthPath, day);
        let files: string[];
        try {
          files = readdirSync(dayPath);
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.startsWith("rollout-") && file.endsWith(`-${sid}.jsonl`)) {
            out.push(path.join(dayPath, file));
          }
        }
      }
    }
  }
  out.sort();
  return out;
}

/** 解析单个 rollout：助手文本汇报 + 最后一条记录（pgm.parse_rollout 移植） */
export function parseRollout(filePath: string): { messages: RolloutMessage[]; lastItem: SessionTranscript["lastItem"] } {
  const messages: RolloutMessage[] = [];
  let lastItem: SessionTranscript["lastItem"] = null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { messages, lastItem };
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== "response_item") continue;
    const payload = (parsed.payload ?? {}) as Record<string, unknown>;
    const ts = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
    lastItem = {
      type: String(payload.type ?? ""),
      role: String(payload.role ?? payload.name ?? ""),
      ts,
    };
    if (payload.type === "message") {
      const content = payload.content;
      if (Array.isArray(content)) {
        const text = content
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => (item.type === "output_text" && typeof item.text === "string" ? item.text : ""))
          .join("");
        if (text.trim()) {
          messages.push({ ts, text: text.trim() });
        }
      }
    }
  }
  return { messages, lastItem };
}

/** 汇总某会话的全部转录：合并所有 rollout 的助手汇报（pgm.gather_projects 单会话版） */
export function summarizeSession(
  sid: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionTranscript {
  const rollouts = findRollouts(sid, env);
  const messages: RolloutMessage[] = [];
  let lastItem: SessionTranscript["lastItem"] = null;
  for (const rollout of rollouts) {
    const parsed = parseRollout(rollout);
    messages.push(...parsed.messages);
    if (parsed.lastItem) lastItem = parsed.lastItem;
  }
  messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return {
    messages,
    lastItem,
    lastMessageTs: messages.length > 0 ? messages[messages.length - 1].ts : null,
  };
}

/** 最近 N 条助手汇报文本（pgm 的 msgs[-limit:] 移植，用于看板展示/接力简报） */
export function recentSummaries(
  transcript: SessionTranscript,
  limit = 3,
  maxCharsPerMessage = 160,
): string[] {
  return transcript.messages.slice(-limit).map((message) => {
    const compact = message.text.replace(/\s+/g, " ").trim();
    return compact.length > maxCharsPerMessage
      ? `${compact.slice(0, maxCharsPerMessage)}…`
      : compact;
  });
}

/** 卡住检测：最近助手汇报后超过 stallMinutes 分钟没有新活动（含工具调用） */
export function isSessionStalled(
  transcript: SessionTranscript,
  stallMinutes = 30,
  now = Date.now(),
): boolean {
  const last = transcript.lastMessageTs;
  if (!last) return false;
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return false;
  return now - lastMs > stallMinutes * 60_000;
}

/** 静默时长（分钟）：最近汇报到现在过了多久；无汇报返回 null */
export function idleMinutes(
  transcript: SessionTranscript,
  now = Date.now(),
): number | null {
  const last = transcript.lastMessageTs;
  if (!last) return null;
  const lastMs = Date.parse(last);
  if (Number.isNaN(lastMs)) return null;
  return Math.max(0, Math.floor((now - lastMs) / 60_000));
}
