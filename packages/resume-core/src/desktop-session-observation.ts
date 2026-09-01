/**
 * 可信会话观测（纯映射模块，零 node:sqlite 依赖）。
 *
 * 背景（AUTO_RESUME_V2_DESIGN.md §8；执行计划 §7 T3）：真实 Codex 桌面库已发现
 * 年份 +058632 的异常未来时间戳。可信观测必须先做时间范围校验
 * （isPlausibleTurnTs），异常时间戳不得参与"最新 turn"排序、不得覆盖可信记录。
 *
 * 本模块只做纯映射与查询边界，不写数据库、不读文件系统；sqlite 读取在
 * desktop-sessions.ts 的 collectDesktopSessionData 中完成，再调用本模块映射。
 * 测试直接导入本模块，无需任何 sqlite/测试运行器配置。
 *
 * 状态映射总则：
 *  - 明确的当前 in-progress turn  => RUNNING（TRUSTED）
 *  - 明确的最新正常 completed turn => COMPLETED（TRUSTED）
 *  - 明确的 failed/interrupted terminal turn 且能证明当前没有更新的 in-progress
 *    turn => STOPPED（TRUSTED）；只证明"当前没有 turn 在运行"，不证明任务正常完成。
 *  - 记录缺失、turn 冲突、无法排序、异常未来/远古时间戳 => UNKNOWN（UNTRUSTED）。
 *  - 通用 usage-limit 文本只作为 reason 诊断，不构成 5 小时额度证据。
 */
import { createRequire } from "node:module";

export type SessionObservationState = "RUNNING" | "COMPLETED" | "STOPPED" | "UNKNOWN";

/** 观测可信度：TRUSTED 可作为迁移证据；UNTRUSTED 只写诊断，不迁移状态。 */
export type SessionObservationConfidence = "TRUSTED" | "UNTRUSTED";

export interface SessionObservation {
  threadId: string;
  state: SessionObservationState;
  observedAt: string;
  sourceRevision?: string;
  confidence: SessionObservationConfidence;
  reason?: string;
}

/** 本模块会话观测快照的版本标记（消费方记录数据来源用）。 */
export const SESSION_OBSERVATION_REVISION = "v2-t3" as const;

/**
 * 时间范围校验（AUTO_RESUME_V2_DESIGN.md §8）：真实 Codex 库已发现年份 +058632
 * 的异常未来时间戳。明显超出合理范围的记录不可参与"最新 turn"排序，否则会
 * 覆盖可信记录、误判 RUNNING/COMPLETED。时间可信范围以调用方注入的 clock 判定
 * （默认真实当前时间），不硬编码任何日期，测试不会过期。
 *
 * 容忍度：允许 3 分钟以内的未来时钟漂移；超过一年的旧记录视为损坏/不完整迁移。
 */
export function isPlausibleTurnTs(sec: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(sec)) return false;
  const ms = sec * 1000;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return false;
  return ms <= now + 3 * 60_000 && ms >= now - 366 * 24 * 3600 * 1000;
}

/**
 * 会话新鲜窗口：无 turn 记录时用于判定"最近被触碰"的 updated_at 有效窗口
 * （AUTO_RESUME_V2_DESIGN.md §8）。与 isPlausibleTurnTs 的一年容忍不同，
 * 这里要求真实的新鲜度（≤30 分钟），否则陈旧的 updated_at 会被误判为初始化中。
 */
export const SESSION_FRESH_WINDOW_MS = 30 * 60_000;

/**
 * 可排序校验（isOrderableTurnTs）：时间戳须可信（isPlausibleTurnTs）且不晚于
 * 当前时刻。容忍未来时钟漂移（3 分钟内）是为了不把正常漂移判为损坏，但这类
 * 未来时间戳没有已发生的时间顺序，不能参与"最新 turn"选举与恢复证据排序。
 */
export function isOrderableTurnTs(sec: number, nowMs: number = Date.now()): boolean {
  return isPlausibleTurnTs(sec, nowMs) && sec * 1000 <= Number(nowMs);
}

/**
 * 一轮观测的原始数据（T4 查询边界可注入的采集结果；desktop-sessions.ts 默认从
 * Codex 桌面库读取，见 collectDesktopSessionData）。
 */
export interface DesktopTurnRow {
  status: string;
  /** Unix 秒；可能为 null、0 或异常未来值（如 +058632）。 */
  started_at: number | null;
  error_json: string | null;
}

export interface DesktopSessionRow {
  /** Unix 秒；为 0 时表示缺省，不参与排序。 */
  updated_at: number | null;
}

export interface DesktopSessionData {
  threadId: string;
  session?: DesktopSessionRow;
  turns: DesktopTurnRow[];
}

/**
 * 单会话 → SessionObservation 纯映射（T4/T2 消费）。
 * - 不写数据库、不读文件系统；异常时间戳不参与排序。
 * - 通用 usage-limit 文本只进 reason 诊断，不产生任何额度证据。
 * - session/turns 均可缺省；时钟默认真实当前时间，可注入固定时间测试。
 *
 * 语义（含 AR-16/AR-19 观测侧）：
 *  - 记录全部缺失 => UNKNOWN（UNTRUSTED）；仅当 thread 存在且最近被触碰
 *    （updated_at 可信）时判 RUNNING（TRUSTED，初始化中推断，见 reason）。
 *  - 全部 turn 时间戳损坏（异常未来/远古）=> UNKNOWN（UNTRUSTED），
 *    异常未来时间戳不得当选 latest、不得覆盖可信记录。
 *  - 时间戳在时钟漂移容忍内但晚于当前时刻（未来时间戳）的 turn 同样不可排序
 *    （isOrderableTurnTs）：不得当选 latest、不得作为恢复证据。
 *  - 最新可信 turn 为 failed/interrupted 且其后（时间可排序）没有更新的
 *    inProgress/queued/completed turn => STOPPED（TRUSTED）；有更新的
 *    inProgress 类 turn => RUNNING；有更新的 completed => COMPLETED。
 */
export function observeDesktopSession(
  data: DesktopSessionData,
  clock: { now: () => number } = { now: () => Date.now() }
): SessionObservation {
  const observedAt = new Date(clock.now()).toISOString();

  const invalidTurns: string[] = [];
  let latest: DesktopTurnRow | null = null;
  let latestTs = -Infinity;
  let totalTurns = 0;
  for (const turn of data.turns ?? []) {
    totalTurns++;
    const ts = turn.started_at ?? 0;
    if (!isPlausibleTurnTs(ts, clock.now())) {
      invalidTurns.push(`${turn.status}@${String(turn.started_at)}`);
      continue; // 损坏时间戳不参与排序，不覆盖可信记录
    }
    if (!isOrderableTurnTs(ts, clock.now())) {
      // 未来时间戳（时钟漂移容忍内）：不损坏但也没有已发生的顺序，
      // 不得当选 latest、不得覆盖可信记录（AR-16 同源语义）。
      invalidTurns.push(`${turn.status}@future`);
      continue;
    }
    if (ts > latestTs) {
      latestTs = ts;
      latest = turn;
    }
  }

  const status = latest?.status ?? "";
  const isInProgressStatus = (st: string): boolean =>
    st === "inProgress" || st === "in_progress" || st === "running" || st === "queued";

  const base = {
    threadId: data.threadId,
    observedAt,
    sourceRevision: SESSION_OBSERVATION_REVISION,
  };

  if (totalTurns === 0) {
    // 无任何 turn 记录：无法证明中断，也不能证明运行。仅当 thread 存在且
    // 最近被触碰（updated_at 落在 SESSION_FRESH_WINDOW_MS 新鲜窗口内）时推断
    // RUNNING（初始化中，reason 明示推断）；updated_at 为 0/缺失/陈旧（超过
    // 30 分钟）一律 UNKNOWN，不硬编码具体日期，测试不会过期。
    const sessionUpdatedAtMs = data.session?.updated_at ? data.session.updated_at * 1000 : 0;
    if (
      data.session &&
      Number.isFinite(data.session.updated_at ?? 0) &&
      sessionUpdatedAtMs > 0 &&
      sessionUpdatedAtMs <= clock.now() &&
      clock.now() - sessionUpdatedAtMs <= SESSION_FRESH_WINDOW_MS
    ) {
      return {
        ...base,
        state: "RUNNING",
        confidence: "TRUSTED",
        reason: "thread exists and was recently touched, but no turn records yet (initializing)",
      };
    }
    return {
      ...base,
      state: "UNKNOWN",
      confidence: "UNTRUSTED",
      reason: "no turn records for thread",
    };
  }

  if (latest) {
    if (isInProgressStatus(status)) {
      return {
        ...base,
        state: "RUNNING",
        confidence: "TRUSTED",
        reason: "latest orderable turn is inProgress",
      };
    }
    if (status === "completed") {
      // completed 之后若有更新的 inProgress 类 turn（用户恢复），说明仍在运行；
      // 但该更新的 inProgress 时间戳可信、不晚于当前时刻、可排序，必然已当选
      // latest，因此走到这里的 latest 就是最新的可排序 turn。
      return {
        ...base,
        state: "COMPLETED",
        confidence: "TRUSTED",
        reason: "latest orderable turn completed",
      };
    }
    if (status === "failed" || status === "interrupted") {
      // terminal turn 之后的恢复证据必须满足：(a) 时间戳可信（isPlausibleTurnTs），
      // (b) 时间不晚于当前时刻（isOrderableTurnTs，未来时间戳无法证明"已发生"），
      // (c) 时间严格晚于该 terminal turn（> latestTs，可排序）。异常未来时间戳
      // 不满足 (a)，未来漂移时间戳不满足 (b)，都不会被当成"更新的 turn"。
      const hasNewer = (st: string): boolean =>
        (data.turns ?? []).some(
          (turn) =>
            turn.status === st &&
            isOrderableTurnTs(turn.started_at ?? 0, clock.now()) &&
            (turn.started_at ?? 0) > latestTs
        );
      const completedAfterTerminal = hasNewer("completed");
      const inProgressAfterTerminal = hasNewer("inProgress") ||
        hasNewer("in_progress") || hasNewer("running") || hasNewer("queued");
      if (inProgressAfterTerminal) {
        return {
          ...base,
          state: "RUNNING",
          confidence: "TRUSTED",
          reason: "terminal turn followed by a newer orderable inProgress turn (user resumed)",
        };
      }
      if (completedAfterTerminal) {
        return {
          ...base,
          state: "COMPLETED",
          confidence: "TRUSTED",
          reason: "terminal turn followed by a completed turn (finished later)",
        };
      }
      return {
        ...base,
        state: "STOPPED",
        confidence: "TRUSTED",
        reason: "latest orderable turn is a terminal failure/interruption with no newer orderable inProgress turn",
      };
    }
    return {
      ...base,
      state: "UNKNOWN",
      confidence: "UNTRUSTED",
      reason: `unrecognized latest turn status: ${status}`,
    };
  }

  // 存在 turn 记录但没有可排序的最新 turn（全部损坏或全部为未来时间戳）：
  // 任何状态排序都不可信，保守 UNKNOWN，不能让异常/未来时间覆盖可信记录。
  // usage-limit 文本仅诊断，不构成证据。
  return {
    ...base,
    state: "UNKNOWN",
    confidence: "UNTRUSTED",
    reason: `no plausible turn timestamps (${invalidTurns.join(", ")})`,
  };
}

/**
 * 批量观测：按 threadId 读取单会话/批量观测（纯映射查询边界，供 T4/T2 消费；
 * 不写数据库）。采集器可注入（默认 desktop-sessions 的 collectDesktopSessionData，
 * 读 Codex 桌面库，与 listCodexSessions 同源同序）；采集失败（库不存在等）返回
 * 空表，不抛出。本模块保持零 sqlite 依赖：默认采集器经惰性注入解析
 * （DEFAULT_COLLECTOR），测试直接传注入采集器，无需任何 sqlite/测试运行器配置。
 */
export function observeDesktopSessions(
  env: NodeJS.ProcessEnv = process.env,
  clock: { now: () => number } = { now: () => Date.now() },
  collector: (env: NodeJS.ProcessEnv) => Map<string, DesktopSessionData> = DEFAULT_COLLECTOR
): SessionObservation[] {
  let data: Map<string, DesktopSessionData>;
  try {
    data = collector(env);
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    // node:sqlite wraps a missing read-only database path as
    // ERR_SQLITE_ERROR/"unable to open database file" instead of preserving
    // ENOENT. Treat only this exact missing-store signal as the documented
    // empty-desktop-store case; all require/import, schema, and other I/O
    // failures still propagate for diagnosis.
    if (
      candidate.code === "ENOENT" ||
      (candidate.code === "ERR_SQLITE_ERROR" && candidate.message === "unable to open database file")
    ) return [];
    throw error;
  }
  const observations: SessionObservation[] = [];
  for (const [threadId, d] of data) {
    observations.push(observeDesktopSession({ ...d, threadId }, clock));
  }
  return observations;
}

/**
 * 默认采集器占位：惰性解析 desktop-sessions 的 collectDesktopSessionData，
 * 保持本模块顶层零 sqlite 依赖（测试直连本模块不触碰该路径）。
 */
function DEFAULT_COLLECTOR(env: NodeJS.ProcessEnv): Map<string, DesktopSessionData> {
  // `createRequire(import.meta.url)` is ESM-compatible while keeping this
  // dependency lazy: importing the pure mapping module never loads sqlite or
  // the desktop store, and tests may continue to inject a collector.
  const requireFromHere = createRequire(import.meta.url);
  const mod = requireFromHere("./desktop-sessions.js") as {
    collectDesktopSessionData: (env: NodeJS.ProcessEnv) => Map<string, DesktopSessionData>;
  };
  return mod.collectDesktopSessionData(env);
}
