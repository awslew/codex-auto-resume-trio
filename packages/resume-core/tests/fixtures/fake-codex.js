#!/usr/bin/env node
const mode = process.env.FAKE_CODEX_MODE || "success";
const args = process.argv.slice(2);
const fs = await import("node:fs");

if (args[0] === "-s") {
  args.splice(0, 2);
}

if (args[0] === "exec" && args[1] === "--skip-git-repo-check") {
  args.splice(1, 1);
}

if (args[0] === "exec" && args[1] === "resume" && args[2] === "--skip-git-repo-check") {
  args.splice(2, 1);
}

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (args[0] === "app-server") {
  if (
    mode !== "appserver-ok" &&
    mode !== "appserver-bad-thread" &&
    mode !== "appserver-v2-positive" &&
    mode !== "appserver-v2-zero" &&
    mode !== "appserver-v2-weekzero5hpositive" &&
    mode !== "appserver-v2-missing" &&
    mode !== "appserver-v2-file"
  ) {
    process.exit(2);
  }
  const statePath = process.env.FAKE_CODEX_STATE;
  const countsPath = process.env.FAKE_CODEX_COUNTS;
  const quotaFilePath = process.env.FAKE_CODEX_QUOTA_FILE;
  const calls = [];
  // 发送侧计数（thread/resume 与 turn/start），排除只读的 account/rateLimits/read。
  const counts = { threadResume: 0, turnStart: 0 };
  const writeCounts = () => {
    if (countsPath) {
      fs.writeFileSync(countsPath, JSON.stringify(counts));
    }
  };
  // V2 结构化 5h 额度响应（auto-resume-v2-integration 测试用）。
  function v2QuotaResult() {
    if (mode === "appserver-v2-positive") {
      return { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1893456000 }, rateLimitReachedType: null }, rateLimitsByLimitId: null };
    }
    if (mode === "appserver-v2-zero") {
      return { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1893456000 }, rateLimitReachedType: null }, rateLimitsByLimitId: null };
    }
    if (mode === "appserver-v2-weekzero5hpositive") {
      return {
        rateLimits: {
          primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null },
          secondary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1893456000 },
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
      };
    }
    if (mode === "appserver-v2-missing") {
      // 只有周窗口（10080），没有任何 300 分钟窗口：必须识别为 UNKNOWN。
      return { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null }, rateLimitReachedType: null }, rateLimitsByLimitId: null };
    }
    if (mode === "appserver-v2-file") {
      // quota 恢复动态模式：每次读取 FAKE_CODEX_QUOTA_FILE 的 { usedPercent, windowDurationMins, resetsAt }。
      // 文件缺失时按“未知额度”响应（UNKNOWN），绝不崩溃：服务端在启动 detect 时
      // 可能先于测试写入 quota 文件发起读取（生产路径为一次冷读取，失败即整轮
      // quotaOk=false 且无重试），fixture 崩溃会导致后续所有轮次失败。
      let quota;
      try {
        quota = JSON.parse(fs.readFileSync(quotaFilePath, "utf8"));
      } catch {
        return { rateLimits: null, rateLimitsByLimitId: null };
      }
      return { rateLimits: { primary: { usedPercent: quota.usedPercent, windowDurationMins: quota.windowDurationMins, resetsAt: quota.resetsAt ?? null }, rateLimitReachedType: null }, rateLimitsByLimitId: null };
    }
    return { rateLimits: { primary: { usedPercent: 0, resetsAt: null }, rateLimitReachedType: null }, rateLimitsByLimitId: null };
  }
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index === -1) {
        break;
      }
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const message = JSON.parse(line);
      calls.push(message.method);
      if (statePath) {
        fs.writeFileSync(statePath, JSON.stringify(calls));
      }
      if (message.method === "thread/resume") {
        counts.threadResume += 1;
        writeCounts();
      }
      if (message.method === "turn/start") {
        counts.turnStart += 1;
        writeCounts();
      }
      if (message.id) {
        if (mode === "appserver-bad-thread" && message.method === "thread/resume") {
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "bad thread" } })}\n`);
          continue;
        }
        const result = message.method === "account/rateLimits/read" ? v2QuotaResult() : {};
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
      if (message.method === "turn/start") {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-app" } })}\n`);
        setTimeout(() => process.exit(0), 10);
      }
    }
  });
  setTimeout(() => process.exit(1), 5000);
  await new Promise(() => {});
}

if (args[0] !== "exec") {
  console.error(`unexpected command: ${args.join(" ")}`);
  process.exit(2);
}

if (mode === "appserver-ok") {
  console.error("CLI fallback was not expected");
  process.exit(9);
}

if (mode === "quota") {
  line({ type: "thread.started", thread_id: "thread-123" });
  line({
    type: "error",
    message: "Rate limit reached. Please try again later.",
    rateLimits: { primary: { usedPercent: 100, resetsAt: 1893456000 } }
  });
  process.exit(1);
}

if (mode === "resume-ok" && args[1] === "resume") {
  line({ type: "thread.started", thread_id: args[2] });
  line({ type: "turn.completed" });
  process.exit(0);
}

line({ type: "thread.started", thread_id: "thread-123" });
line({ type: "turn.completed" });
process.exit(0);
