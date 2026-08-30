/**
 * Resolve the real Codex executable on this platform.
 *
 * `codex` on PATH is often a Windows wrapper (.cmd / .ps1) that Node's
 * `child_process.spawn` cannot execute directly.  We resolve it to either:
 *
 *  - the npm-global @openai/codex/bin/codex.js (run via `node`), or
 *  - an actual executable found on PATH (Unix, or a .exe on Windows).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type CodexBin = {
  /** argv[0] to pass to spawn (node.exe on Windows, codex on Unix). */
  command: string;
  /** extra args that must precede the actual codex args. */
  prefix: string[];
  /** resolved absolute path to the real codex entry, for diagnostics. */
  resolved: string;
};

const NPM_GLOBAL_REL = path.join("node_modules", "@openai", "codex", "bin", "codex.js");

function npmGlobalCandidates(): string[] {
  const roots: string[] = [];
  const npmRoot = process.env.npm_config_prefix ?? process.env.APPDATA;
  if (npmRoot) {
    roots.push(path.join(npmRoot, NPM_GLOBAL_REL));
  }
  // Common fallback locations
  roots.push(
    path.join(os.homedir(), "AppData", "Roaming", "npm", NPM_GLOBAL_REL),
    path.join(os.homedir(), ".local", "bin", "..", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"),
    "/usr/local/lib/node_modules/@openai/codex/bin/codex.js"
  );
  // Resolve via `npm root -g` if available
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" });
    if (r.status === 0 && r.stdout.trim()) {
      roots.push(path.join(r.stdout.trim(), "@openai", "codex", "bin", "codex.js"));
    }
  } catch {
    // ignore
  }
  return roots;
}

function findNpmGlobalCodexJs(): string | undefined {
  for (const candidate of npmGlobalCandidates()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findOnPath(): string | undefined {
  const r = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["codex"],
    { encoding: "utf8", shell: process.platform === "win32" }
  );
  if (r.status !== 0) {
    return undefined;
  }
  const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!first) {
    return undefined;
  }
  // If it's a real executable (not .cmd/.ps1), use it directly.
  const ext = path.extname(first).toLowerCase();
  if (process.platform === "win32" && [".cmd", ".bat", ".ps1"].includes(ext)) {
    return undefined; // wrapper; handled by npm-global path instead
  }
  return first;
}

export function resolveCodexBin(): CodexBin {
  const npmJs = findNpmGlobalCodexJs();
  if (npmJs) {
    return {
      command: process.execPath, // node
      prefix: [npmJs],
      resolved: npmJs
    };
  }
  const onPath = findOnPath();
  if (onPath) {
    return {
      command: onPath,
      prefix: [],
      resolved: onPath
    };
  }
  // Last resort: let spawn fail with a clear error.
  return { command: "codex", prefix: [], resolved: "codex" };
}
