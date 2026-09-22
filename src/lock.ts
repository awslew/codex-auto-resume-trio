import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { locksDir } from "./paths.js";

export async function withJobLock<T>(stateDir: string, jobId: string, fn: () => Promise<T>): Promise<T | undefined> {
  await mkdir(locksDir(stateDir), { recursive: true });
  const lockPath = path.join(locksDir(stateDir), `${jobId}.lock`);
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return undefined;
    }
    throw error;
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}
