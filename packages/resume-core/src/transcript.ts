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
 *
 * 性能（2026-09 修复）：~/.codex 转录可达 GB 级（本机 491 个 rollout / 1.2GB），
 * 看板「项目总谱」「自动续跑」每次请求都全量重扫重解析导致 20-30s 等待。
 * 这里加两层内存缓存（模块级，进程常驻）：
 *  - findRollouts 缓存：sid -> 文件列表。首次全树扫描建索引，之后 O(1)；
 *    目录 mtime 变化（新 rollout 落盘）时自动重建。
 *  - parseRollout 缓存：path -> 解析结果，按 (size, mtime) 失效；
 *    文件未变化时跳过整文件 JSON 解析。
 * 提取后的消息文本很小（本机 6601 条 ≈ 2MB），内存占用可忽略。
 * 测试用 mkdtemp 临时目录（env 注入 CODX_HOME），缓存 key 含 codexHome，
 * 隔离测试互不污染。
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
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

/**
 * findRollouts 目录索引缓存：全部 rollout 路径列表 + 目录 mtime 签名。
 * 查询时 filter endsWith(`-${sid}.jsonl`)（与旧 findRollouts 语义完全一致；
 * sid 内部含连字符，无法按最后一段 O(1) 分组，但 491 个文件 × filter 仅毫秒级）。
 * key 用 codexHome 隔离（测试注入临时 CODX_HOME 时不污染真实索引）。
 */
const rolloutIndexCache = new Map<
  string,
  { signature: string; files: string[] }
>();

/** 目录树的 mtime 签名：扫描时记录每个存在目录的 mtimeMs，变化即索引过期。 */
function directorySignature(root: string): string {
  let signature = "";
  try {
    for (const year of readdirSync(root)) {
      const yearPath = path.join(root, year);
      signature += `${year}:${statSync(yearPath).mtimeMs};`;
      for (const month of readdirSync(yearPath)) {
        const monthPath = path.join(yearPath, month);
        signature += `${month}:${statSync(monthPath).mtimeMs};`;
        for (const day of readdirSync(monthPath)) {
          const dayPath = path.join(monthPath, day);
          signature += `${day}:${statSync(dayPath).mtimeMs};`;
        }
      }
    }
  } catch {
    // 树不存在或不可读时签名固定为空串：与"空树"一致，代价是每次重扫（安全）。
  }
  return signature;
}

/**
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*-<sid>.jsonl，按时间排序（pgm.find_rollouts 移植）。
 * 带目录索引缓存：首次全树扫描一次，之后按 sid filter 命中；目录 mtime 变化自动重建。
 */
export function findRollouts(sid: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const base = path.join(codexHome(env), "sessions");
  if (!existsSync(base)) return [];

  const signature = directorySignature(base);
  const cached = rolloutIndexCache.get(base);
  const files = cached && cached.signature === signature
    ? cached.files
    : rebuildRolloutIndex(base, signature);

  return files
    .filter((file) => file.endsWith(`-${sid}.jsonl`))
    .sort();
}

function rebuildRolloutIndex(base: string, signature: string): string[] {
  const files: string[] = [];
  for (const year of readdirSync(base)) {
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
        let entries: string[];
        try {
          entries = readdirSync(dayPath);
        } catch {
          continue;
        }
        for (const file of entries) {
          if (file.startsWith("rollout-") && file.endsWith(".jsonl")) {
            files.push(path.join(dayPath, file));
          }
        }
      }
    }
  }
  rolloutIndexCache.set(base, { signature, files });
  return files;
}

/**
 * parseRollout 结果缓存：按 (size, mtime) 失效。
 * key 用绝对路径；文件未变化时跳过整文件读取与逐行 JSON 解析。
 */
const parseCache = new Map<string, { size: number; mtimeMs: number; result: { messages: RolloutMessage[]; lastItem: SessionTranscript["lastItem"] } }>();

/** 解析单个 rollout：助手文本汇报 + 最后一条记录（pgm.parse_rollout 移植）。带文件级缓存。 */
export function parseRollout(filePath: string): { messages: RolloutMessage[]; lastItem: SessionTranscript["lastItem"] } {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return { messages: [], lastItem: null };
  }
  const cached = parseCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.result;
  }

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
  const result = { messages, lastItem };
  parseCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, result });
  return result;
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
