import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { watchesDir } from "./paths.js";
import type { AutoResumeWatch } from "./auto-resume-types.js";
import { safeLockName } from "./thread-lease.js";

/**
 * schemaVersion=2 watch 原子存储（AUTO_RESUME_V2_DESIGN.md §4；执行计划 §7 T2）。
 *
 * 布局：<stateDir>/watches/<安全threadId>.json，与旧 jobs 目录完全隔离；
 * 本模块绝不读写 jobs 目录，也绝不删除或迁移任何旧 job 数据。
 *
 * 原子性：同一 watch 的所有字段（phase/observation/arming/latch/activeAttemptId/
 * resumeAttemptCount）在一次写入中完整落盘；先写同目录临时文件再 rename。
 * 读取严格校验 schemaVersion===2，任何缺失/损坏文件按“不存在”处理并报错计数。
 */
export const WATCH_SCHEMA_VERSION = 2 as const;

export interface WatchStoreStats {
  corruptedFiles: number;
}

export interface WatchStore {
  load(threadId: string): Promise<AutoResumeWatch | undefined>;
  list(): Promise<AutoResumeWatch[]>;
  upsert(watch: AutoResumeWatch): Promise<void>;
  /** 用户手动取消：删除 watch 文件；幂等（不存在不报错）。 */
  disable(threadId: string): Promise<void>;
  stats(): Promise<WatchStoreStats>;
}

export function createWatchStore(stateDir: string): WatchStore {
  return new FileWatchStore(stateDir);
}

class FileWatchStore implements WatchStore {
  private readonly corrupted: Set<string> = new Set();

  constructor(private readonly stateDir: string) {}

  private watchPath(threadId: string): string {
    return path.join(watchesDir(this.stateDir), `${safeLockName(threadId)}.json`);
  }

  async load(threadId: string): Promise<AutoResumeWatch | undefined> {
    const file = this.watchPath(threadId);
    try {
      const raw = await readFile(file, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isWatchV2(parsed) || parsed.threadId !== threadId) {
        this.corrupted.add(threadId);
        return undefined;
      }
      return parsed as AutoResumeWatch;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      this.corrupted.add(threadId);
      return undefined;
    }
  }

  async list(): Promise<AutoResumeWatch[]> {
    const dir = watchesDir(this.stateDir);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const watches: AutoResumeWatch[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const encodedThreadId = name.slice(0, -".json".length);
      const threadId = safeUnlockName(encodedThreadId);
      if (safeLockName(threadId) !== encodedThreadId) {
        this.corrupted.add(encodedThreadId);
        continue;
      }
      const watch = await this.load(threadId);
      if (watch !== undefined) watches.push(watch);
    }
    return watches;
  }

  async upsert(watch: AutoResumeWatch): Promise<void> {
    if (!isWatchV2(watch)) {
      throw new Error(`watch schemaVersion must be ${WATCH_SCHEMA_VERSION}`);
    }
    const dir = watchesDir(this.stateDir);
    await mkdir(dir, { recursive: true });
    const file = this.watchPath(watch.threadId);
    const tmp = path.join(dir, `.${safeLockName(watch.threadId)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, `${JSON.stringify(watch, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    this.corrupted.delete(watch.threadId);
  }

  async disable(threadId: string): Promise<void> {
    await rm(this.watchPath(threadId), { force: true });
    this.corrupted.delete(threadId);
  }

  async stats(): Promise<WatchStoreStats> {
    return { corruptedFiles: this.corrupted.size };
  }
}

/** schemaVersion===2 的完整校验；字段缺失即视为损坏（防半写/旧版本文件）。 */
function isWatchV2(value: unknown): value is AutoResumeWatch {
  if (typeof value !== "object" || value === null) return false;
  const watch = value as Partial<AutoResumeWatch>;
  if (watch.schemaVersion !== WATCH_SCHEMA_VERSION) return false;
  if (
    typeof watch.threadId !== "string" || watch.threadId.length === 0 ||
    typeof watch.cwd !== "string" || watch.cwd.trim().length === 0 ||
    typeof watch.enabled !== "boolean" ||
    !isWatchPhase(watch.phase) ||
    typeof watch.resumeAttemptCount !== "number" || !Number.isInteger(watch.resumeAttemptCount) || watch.resumeAttemptCount < 0 ||
    typeof watch.createdAt !== "string" || watch.createdAt.length === 0 ||
    typeof watch.updatedAt !== "string" || watch.updatedAt.length === 0 ||
    (watch.activeAttemptId !== undefined && (typeof watch.activeAttemptId !== "string" || watch.activeAttemptId.length === 0)) ||
    (watch.lastError !== undefined && typeof watch.lastError !== "string")
  ) return false;

  if (watch.lastObservation !== undefined && !isObservation(watch.lastObservation)) return false;
  if (watch.armedByDetection !== undefined && !isArming(watch.armedByDetection)) return false;
  if (watch.interruptionLatch !== undefined && !isLatch(watch.interruptionLatch)) return false;
  return true;
}

function isWatchPhase(value: unknown): value is AutoResumeWatch["phase"] {
  return value === "MONITORING" || value === "WAITING_FOR_5H_QUOTA" || value === "RESUME_QUEUED" || value === "RESUME_CONFIRMING" || value === "NEEDS_ATTENTION" || value === "DISABLED";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isQuotaState(value: unknown): value is NonNullable<AutoResumeWatch["lastObservation"]>["fiveHourQuota"] {
  return value === "POSITIVE" || value === "ZERO" || value === "UNKNOWN";
}

function isSessionState(value: unknown): value is NonNullable<AutoResumeWatch["lastObservation"]>["sessionState"] {
  return value === "RUNNING" || value === "COMPLETED" || value === "STOPPED" || value === "UNKNOWN";
}

function isOptionalResetAt(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isObservation(value: NonNullable<AutoResumeWatch["lastObservation"]>): boolean {
  return isNonEmptyString(value.cycleId) && isNonEmptyString(value.detectedAt) && isSessionState(value.sessionState) && isQuotaState(value.fiveHourQuota) && isOptionalResetAt(value.quotaResetAt);
}

function isArming(value: NonNullable<AutoResumeWatch["armedByDetection"]>): boolean {
  return isNonEmptyString(value.cycleId) && isNonEmptyString(value.detectedAt) && typeof value.validUntil === "number" && Number.isFinite(value.validUntil);
}

function isLatch(value: NonNullable<AutoResumeWatch["interruptionLatch"]>): boolean {
  return isNonEmptyString(value.id) && isNonEmptyString(value.detectedAt) && isNonEmptyString(value.evidenceCycleId) && isNonEmptyString(value.previousRunningCycleId) && isOptionalResetAt(value.quotaResetAt);
}

/** 文件名 → threadId（percent 解码；与 safeLockName 互逆）。 */
export function safeUnlockName(name: string): string {
  if (!name.includes("%")) return name;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
