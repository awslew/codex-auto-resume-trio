import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { JsonlParser } from "../jsonl.js";
import { resolveCodexBin } from "../codex-bin.js";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./protocol.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class AppServerClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private parser = new JsonlParser();

  constructor(
    private readonly options: {
      codexBin?: string | ReturnType<typeof resolveCodexBin>;
      codexArgsPrefix?: string[];
      cwd: string;
      env?: NodeJS.ProcessEnv;
    }
  ) {
    super();
  }

  async start(): Promise<void> {
    const raw = this.options.codexBin ?? resolveCodexBin();
    const bin =
      typeof raw === "string"
        ? { command: raw, prefix: [] as string[], resolved: raw }
        : raw;
    const args = [...bin.prefix, ...(this.options.codexArgsPrefix ?? []), "app-server", "--stdio"];
    this.child = spawn(bin.command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => this.emit("stderr", chunk.toString()));
    this.child.on("close", () => this.rejectAll(new Error("app-server exited")));
    this.child.on("error", (error) => this.rejectAll(error));

    await this.request("initialize", {
      clientInfo: { name: "codex-auto-resume", title: "Codex Auto Resume", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.notify("initialized");
  }

  /** kill 并等待子进程真正退出：Windows 上 cwd/文件句柄要等进程死透才释放，
   * 立即返回会让调用方（测试清理临时目录等）与进程终止竞态。 */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    // SIGTERM 无响应时 2s 强杀，总体 3s 封顶，保证 stop 不悬挂调用方。
    const escalation = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, 2_000);
    escalation.unref?.();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 3_000).unref?.()),
    ]);
    clearTimeout(escalation);
  }

  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error("app-server is not running"));
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      message.params = params;
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    if (!this.child?.stdin.writable) {
      return;
    }
    const message: JsonRpcNotification = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      message.params = params;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitForNotification(method: string, timeoutMs = 60_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(method, onNotification);
        reject(new Error(`app-server notification timed out: ${method}`));
      }, timeoutMs);
      const onNotification = (params: unknown): void => {
        clearTimeout(timer);
        resolve(params);
      };
      this.once(method, onNotification);
    });
  }

  private onData(chunk: Buffer): void {
    for (const parsed of this.parser.push(chunk)) {
      if (!parsed.ok) {
        this.emit("invalidJson", parsed.line);
        continue;
      }
      const message = parsed.value as Partial<JsonRpcResponse & JsonRpcNotification>;
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) {
          continue;
        }
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      } else if (typeof message.method === "string") {
        this.emit("notification", message);
        this.emit(message.method, message.params);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
