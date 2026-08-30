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
  if (mode !== "appserver-ok" && mode !== "appserver-bad-thread") {
    process.exit(2);
  }
  const statePath = process.env.FAKE_CODEX_STATE;
  const calls = [];
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
      if (message.id) {
        if (mode === "appserver-bad-thread" && message.method === "thread/resume") {
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "bad thread" } })}\n`);
          continue;
        }
        const result = message.method === "account/rateLimits/read"
          ? { rateLimits: { primary: { usedPercent: 0, resetsAt: null }, rateLimitReachedType: null }, rateLimitsByLimitId: null }
          : {};
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
