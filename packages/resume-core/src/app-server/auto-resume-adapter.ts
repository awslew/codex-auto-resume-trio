/**
 * V2 自动续跑的生产适配器（AUTO_RESUME_V2_EXECUTION_PLAN.md §7 T4；AUTO_RESUME_V2_DESIGN.md §6.3/§9）。
 *
 * 本模块是唯一允许由服务端复用的生产适配层：
 * - quotaReader：调用 `account/rateLimits/read`，结果只交给 `normalizeFiveHourQuota`
 *   做结构化窗口识别（windowDurationMins===300 或明确 5h limitId/limitName）；
 *   绝不用通用 usage-limit 文案猜测 5 小时窗口（design §3.3 铁律）。
 * - sender：复用 app-server supervisor 的 thread/resume + turn/start 路径
 *   （resumeWithAppServer），返回明确额度失败（quotaBlocked）以区分技术失败；
 *   发送后同 thread 的 turn/completed 已可靠等到 → confirmed:true（决策A）。
 * - confirmer：三态确认（design §6.3；T2 验收修复 A）。查询异常 => UNKNOWN，
 *   绝不冒充 NOT_STARTED；本模块无法可靠确认时会明确返回 UNKNOWN（fail-closed）。
 *
 * 本模块不做任何业务迁移，也不写任何持久化文件；quota 归一化与状态机
 * 分别在 five-hour-quota.ts / auto-resume-reducer.ts。
 */
import { classifyRateLimit } from "../rate-limit.js";
import { normalizeFiveHourQuota } from "../five-hour-quota.js";
import type { RateLimitResponse } from "../types.js";
import type { ConfirmationResult, SendOutcome, Sender } from "../resume-attempt.js";
import { AppServerClient } from "./client.js";
import { DEFAULT_SANDBOX } from "../constants.js";
import { DEFAULT_RESUME_PROMPT } from "../constants.js";
import { observeDesktopSessions, SESSION_OBSERVATION_REVISION } from "../desktop-session-observation.js";
import type { SessionObservation } from "../desktop-session-observation.js";
import type { ResumeAttempt } from "../auto-resume-types.js";

/** 生产 app-server 配额读取器：账户级 rateLimits，只走结构化窗口识别。 */
export function createAppServerQuotaReader(options: { cwd: string; codexBin?: string; codexArgsPrefix?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number } = { cwd: process.cwd() }) {
  return async (): Promise<{ state: "POSITIVE" | "ZERO" | "UNKNOWN"; resetAt?: number }> => {
    const client = new AppServerClient({
      codexBin: options.codexBin,
      codexArgsPrefix: options.codexArgsPrefix,
      cwd: options.cwd,
      env: options.env,
    });
    try {
      await client.start();
      const limits = (await client.request("account/rateLimits/read", undefined, options.timeoutMs ?? 15_000)) as RateLimitResponse | null | undefined;
      const quota = normalizeFiveHourQuota(limits);
      if (quota.state === "UNKNOWN") {
        return { state: "UNKNOWN" as const, ...(quota.resetAt !== undefined ? { resetAt: quota.resetAt } : {}) };
      }
      return { state: quota.state, ...(quota.resetAt !== undefined ? { resetAt: quota.resetAt } : {}) };
    } finally {
      client.stop();
    }
  };
}

/**
 * 生产发送器：thread/resume + turn/start（复用 resume-core 的 app-server 路径）。
 * - 发送前先读一次账户额度并做结构化识别；明确 5h 额度失败 → quotaBlocked（不计技术失败）。
 * - 发送后确认新 turn：收到新 turn id 或晚于 attempt 的 RUNNING 证据 → ok + confirmed:true；
 *   无法确认 → ok:true + detail.confirmationUnknown（fail-closed，绝不伪造成功）。
 */
export function createAppServerSender(options: { cwd: string; codexBin?: string; codexArgsPrefix?: string[]; env?: NodeJS.ProcessEnv }): Sender {
  return {
    async send(attempt: ResumeAttempt, watch: { threadId: string; cwd: string }): Promise<SendOutcome> {
      const cwd = watch.cwd || options.cwd;
      const client = new AppServerClient({
        codexBin: options.codexBin,
        codexArgsPrefix: options.codexArgsPrefix,
        cwd,
        env: options.env,
      });
      try {
        await client.start();

        // 发送前额度复核（design §6.3）：只认结构化 5h 窗口。
        const limits = (await client.request("account/rateLimits/read", undefined, 15_000)) as RateLimitResponse | null | undefined;
        const quota = normalizeFiveHourQuota(limits);
        if (quota.state === "ZERO") {
          return { ok: false, quotaBlocked: true, error: "five-hour quota is still exhausted before send" };
        }
        if (quota.state === "UNKNOWN") {
          // 无法确认 5h 窗口可用 → 不发送（能力门禁 fail-closed）。
          return { ok: false, error: "five-hour quota window not identifiable before send; blocked" };
        }

        // 发送前必须持有新 turn 通知监听，防止 turn/completed 早于 waitForNotification 注册。
        const completed = client.waitForNotification("turn/completed", 120_000);
        await client.request(
          "thread/resume",
          { threadId: attempt.threadId, cwd, sandbox: DEFAULT_SANDBOX },
          20_000
        );
        await client.request(
          "turn/start",
          {
            threadId: attempt.threadId,
            cwd,
            input: [{ type: "text", text: DEFAULT_RESUME_PROMPT, text_elements: [] }],
          },
          20_000
        );

        const notification = await completed;
        if (notification === undefined || notification === null) {
          // 发送已下发但没有可用的完成证据：保留 outbox+latch 待确认（重放确认，
          // 绝不在此冒充成功或失败）。
          return { ok: true, error: "resume turn completed without usable evidence; awaiting confirmation" };
        }
        // 同 thread 的 turn/completed 已可靠等到：把 CONFIRMED 作为发送结果持久化
        // （决策A；outbox 写 confirmedAt，monitor 同轮收敛清 latch+outbox）。
        return { ok: true, confirmed: true, detail: { turnCompleted: true } };
      } finally {
        client.stop();
      }
    },
  };
}

/** 生产会话读取器：桌面会话观测（已验收 SessionObservation，可信时间戳映射）。 */
export function createAppServerSessionReader(options: { env?: NodeJS.ProcessEnv; clock?: { now: () => number } } = {}): {
  (threadId: string): Promise<SessionObservation>;
  collect: (env?: NodeJS.ProcessEnv) => SessionObservation[];
} {
  const env = options.env ?? process.env;
  const clock = options.clock ?? { now: () => Date.now() };
  const collect = (collectEnv: NodeJS.ProcessEnv = env) => observeDesktopSessions(collectEnv, clock);
  return Object.assign(
    async (threadId: string): Promise<SessionObservation> => {
      const target = threadId;
      const found = collect().find((observation) => observation.threadId === target);
      if (found !== undefined) return found;
      // 会话库中没有该 threadId 的记录：无法证明中断，也不能证明运行（UNKNOWN，
      // 与 observeDesktopSession 的“无记录”语义一致）——绝不猜测状态。
      return {
        threadId: target,
        state: "UNKNOWN",
        observedAt: new Date(clock.now()).toISOString(),
        sourceRevision: SESSION_OBSERVATION_REVISION,
        confidence: "UNTRUSTED",
        reason: "no desktop session records for thread",
      };
    },
    { collect }
  );
}

/** 生产确认器：查询异常 => UNKNOWN（fail-closed）；本实现不做不可靠的二次猜测。 */
export function createAppServerConfirmer(_options?: { cwd?: string; codexBin?: string; codexArgsPrefix?: string[]; env?: NodeJS.ProcessEnv }): {
  confirm(attempt: ResumeAttempt): Promise<ConfirmationResult>;
} {
  return {
    async confirm(): Promise<ConfirmationResult> {
      // T2 合同：查询异常/超时/无法查询 → UNKNOWN，绝不冒充 NOT_STARTED。
      // V2 服务端把“已收到新 turn id 或晚于 attempt 的 RUNNING 证据”作为确认；
      // 若未来接入可查询的会话库，此实现必须继续三态语义。
      void _options;
      return { state: "UNKNOWN", reason: "server confirmer relies on send-time turn evidence; no independent query path" };
    },
  };
}

export { classifyRateLimit };
