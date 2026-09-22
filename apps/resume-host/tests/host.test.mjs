/**
 * resume-host 守卫测试（Node 原生 test runner，零依赖）
 *
 * 覆盖面刻意收窄到**本宿主自己接线的那一层**：
 *   1. 执行开关解析（真实发送必须显式开启）
 *   2. observe 模式零发送（V2 语义的硬保证在宿主边界上仍然成立）
 *   3. 状态页服务器的路由分工（守护器路由 / 宿主只读路由 / 静态资源 / 404 / 405）
 *   4. watch 生命周期经 HTTP 面走通（add → list → rm），以及非法入参被拒
 *
 * V2 状态机本身（归零锁存、幂等续跑、lease、门禁语义…）由 resume-core 的
 * vitest 套件覆盖，这里不重复造轮子；此处只验证"宿主没有把它接错"。
 *
 * 注入边界：全部走 mkdtemp 临时目录 + 注入的 fake 适配器，
 * 绝不读写真实 %LOCALAPPDATA% / ~/.codex。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  autoResumeV2ExecuteEnabled,
  autoResumeV2ShadowEnabled,
  checkExecutionCapability,
  createResumeDaemon,
  ResumeHostApiError,
} from "../src/daemon.mjs";
import { createStatusServer } from "../src/http-server.mjs";

const tempDirs = [];

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tempDirs) {
    try {
      rm(dir, { recursive: true, force: true });
    } catch {
      // 进程退出阶段的清理尽力而为；Windows 上子进程句柄可能还没释放。
    }
  }
});

/** 记录发送次数的 fake sender：observe 模式下必须恒为 0。 */
function fakeSender(sendCalls) {
  return {
    async send() {
      sendCalls.push(Date.now());
      return { ok: true, confirmation: "UNKNOWN" };
    },
  };
}

function makeDaemon({ executeEnabled = false, shadowEnabled = false, sendCalls = [], extra = {} } = {}) {
  return createResumeDaemon({
    stateDir: extra.stateDir,
    executeEnabled,
    shadowEnabled,
    // 全部适配器注入 fake：绝不 spawn 真实 Codex、绝不读真实会话库。
    quotaReader: async () => ({ state: "UNKNOWN", raw: null }),
    sessionReader: async () => "IDLE",
    sender: fakeSender(sendCalls),
    confirmer: { async confirm() { return { state: "UNKNOWN", reason: "test" }; } },
    store: extra.store,
    clock: extra.clock,
    ...extra.options,
  });
}

/** 造一个能捕获 sendJson 结果的假请求/响应。 */
function fakeExchange({ method = "GET", url = "/", body } = {}) {
  const captured = { status: undefined, payload: undefined, headers: undefined, ended: false };
  const request = {
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, "utf8");
    },
  };
  const response = {
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(payload) {
      captured.ended = true;
      if (payload !== undefined) captured.payload = JSON.parse(String(payload));
    },
  };
  const parsed = new URL(url, "http://127.0.0.1:5173");
  return { request, response, captured, parsed };
}

const sendJson = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
  return true;
};
const methodNotAllowed = (response, allowed) => {
  response.writeHead(405, { allow: allowed.join(", ") });
  response.end(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED" } }));
  return true;
};

async function callDaemon(daemon, exchange) {
  return daemon.handleRequest(exchange.request, exchange.response, exchange.parsed, sendJson, methodNotAllowed);
}

test("执行开关：只有显式真值才开启真实发送", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", " On "]) {
    assert.equal(autoResumeV2ExecuteEnabled({ AUTO_RESUME_V2_EXECUTE: value }), true, `${value} 应视为开启`);
  }
  for (const value of ["", "0", "false", "no", "off", "2", "yes please"]) {
    assert.equal(autoResumeV2ExecuteEnabled({ AUTO_RESUME_V2_EXECUTE: value }), false, `${JSON.stringify(value)} 应视为关闭`);
  }
  assert.equal(autoResumeV2ExecuteEnabled({}), false, "未设置必须默认关闭（零发送）");
  assert.equal(autoResumeV2ShadowEnabled({ AUTO_RESUME_V2_SHADOW: "1" }), true);
  assert.equal(autoResumeV2ShadowEnabled({}), false);
});

test("createResumeDaemon 必须拿到显式 stateDir（绝不默认落到 LOCALAPPDATA）", () => {
  assert.throws(() => createResumeDaemon({}), /explicit stateDir/);
  assert.throws(() => createResumeDaemon({ stateDir: "" }), /explicit stateDir/);
});

test("observe 模式：启动与检测都不发送，模式如实为 observe", async () => {
  const stateDir = await tempDir("resume-host-observe-");
  const sendCalls = [];
  const daemon = makeDaemon({ executeEnabled: false, sendCalls, extra: { stateDir } });

  await daemon.start();
  try {
    assert.equal(daemon.getExecutionMode(), "observe");
    const report = await daemon.detectOnce();
    assert.ok(report, "检测应返回报告而不是 null");
    assert.equal(report.resumedCount, 0);
    assert.equal(sendCalls.length, 0, "observe 模式 sender 调用次数必须为 0");
  } finally {
    await daemon.stop();
  }
});

test("shadow 模式：决策可记录但发送恒为 0", async () => {
  const stateDir = await tempDir("resume-host-shadow-");
  const sendCalls = [];
  const daemon = makeDaemon({ executeEnabled: false, shadowEnabled: true, sendCalls, extra: { stateDir } });

  await daemon.start();
  try {
    assert.equal(daemon.getExecutionMode(), "shadow");
    await daemon.detectOnce();
    assert.equal(sendCalls.length, 0);
  } finally {
    await daemon.stop();
  }
});

test("owner lease：同一 stateDir 上第二个实例拿不到 owner（不启动调度器）", async () => {
  const stateDir = await tempDir("resume-host-owner-");
  const first = makeDaemon({ extra: { stateDir } });
  const second = makeDaemon({ executeEnabled: true, extra: { stateDir } });

  await first.start();
  try {
    await second.start();
    const status = second.getStatus();
    assert.equal(status.ownerLeaseHeld, false, "第二个实例不得持有 owner lease");
    // 拿不到 owner 时即使 execute 开启也必须阻塞在发送侧（这里是安全默认）。
    assert.equal(second.getExecutionMode(), "execute-blocked");
  } finally {
    await second.stop();
    await first.stop();
  }
});

test("handleRequest：非 auto-resume 路由交还给宿主（返回 false）", async () => {
  const stateDir = await tempDir("resume-host-route-");
  const daemon = makeDaemon({ extra: { stateDir } });
  const exchange = fakeExchange({ url: "/api/host/status" });
  const handled = await callDaemon(daemon, exchange);
  assert.equal(handled, false, "宿主的只读路由必须留给自己处理");
});

test("handleRequest：watch 全生命周期（PUT → GET → DELETE）经 HTTP 面成立", async () => {
  const stateDir = await tempDir("resume-host-watch-");
  const daemon = makeDaemon({ extra: { stateDir } });
  const threadId = "thread-abc";
  const cwd = stateDir;

  const put = fakeExchange({
    method: "PUT",
    url: `/api/auto-resume/watches/${threadId}`,
    body: JSON.stringify({ enabled: true, cwd }),
  });
  await callDaemon(daemon, put);
  assert.equal(put.captured.status, 200);
  assert.equal(put.captured.payload.watch.threadId, threadId);
  assert.equal(put.captured.payload.watch.phase, "MONITORING");

  const list = fakeExchange({ url: "/api/auto-resume/watches" });
  await callDaemon(daemon, list);
  assert.equal(list.captured.status, 200);
  assert.equal(list.captured.payload.watches.length, 1);
  assert.equal(list.captured.payload.watches[0].threadId, threadId);
  assert.equal(list.captured.payload.executionMode, "observe");

  const del = fakeExchange({ method: "DELETE", url: `/api/auto-resume/watches/${threadId}` });
  await callDaemon(daemon, del);
  assert.equal(del.captured.status, 200);
  assert.equal(del.captured.payload.ok, true);

  const after = fakeExchange({ url: "/api/auto-resume/watches" });
  await callDaemon(daemon, after);
  assert.equal(after.captured.payload.watches.length, 0, "删除后不得复活");
});

test("handleRequest：非法入参被拒（query 参数 / 非 JSON / 相对 cwd / 缺 enabled）", async () => {
  const stateDir = await tempDir("resume-host-invalid-");
  const daemon = makeDaemon({ extra: { stateDir } });

  await assert.rejects(
    () => callDaemon(daemon, fakeExchange({ url: "/api/auto-resume/watches?x=1" })),
    (error) => error instanceof ResumeHostApiError && error.status === 400 && error.code === "UNKNOWN_QUERY_PARAMETER",
  );

  await assert.rejects(
    () => callDaemon(daemon, fakeExchange({ method: "PUT", url: "/api/auto-resume/watches/t1", body: "not json" })),
    (error) => error.status === 400 && error.code === "INVALID_BODY",
  );

  await assert.rejects(
    () => callDaemon(daemon, fakeExchange({ method: "PUT", url: "/api/auto-resume/watches/t1", body: JSON.stringify({ enabled: true, cwd: "relative/path" }) })),
    (error) => error.status === 400 && error.code === "INVALID_FIELD",
  );

  await assert.rejects(
    () => callDaemon(daemon, fakeExchange({ method: "PUT", url: "/api/auto-resume/watches/t1", body: JSON.stringify({ cwd: stateDir }) })),
    (error) => error.status === 400 && error.code === "INVALID_BODY",
  );

  await assert.rejects(
    () => callDaemon(daemon, fakeExchange({ method: "GET", url: "/api/auto-resume/nope" })),
    (error) => error.status === 404 && error.code === "NOT_FOUND",
  );
});

test("handleRequest：方法不匹配走 methodNotAllowed（405 + allow 头）", async () => {
  const stateDir = await tempDir("resume-host-405-");
  const daemon = makeDaemon({ extra: { stateDir } });
  const exchange = fakeExchange({ method: "GET", url: "/api/auto-resume/detect" });
  await callDaemon(daemon, exchange);
  assert.equal(exchange.captured.status, 405);
  assert.equal(exchange.captured.headers.allow, "POST");
});

test("能力门禁：legacy jobs 状态不可读时 fail-closed（宁可阻塞不可双写）", async () => {
  const stateDir = await tempDir("resume-host-capability-");
  // 把 jobs 造成一个「读不了」的形态：用同名文件顶掉 jobs 目录，
  // 于是读取必然失败且错误码不是 ENOENT —— 正是双调度器双写的最坏情况。
  await writeFile(path.join(stateDir, "jobs"), "not a directory", "utf8");

  const result = await checkExecutionCapability({ stateDir });
  assert.equal(result.ok, false, "状态不可读必须视为冲突");
  assert.ok(
    result.reasons.some((reason) => reason.includes("LEGACY_STATE_UNREADABLE")),
    `原因里应明确指出状态不可读，实际：${JSON.stringify(result.reasons)}`,
  );
});

test("能力门禁：活跃 legacy job 阻止 execute（且只读不改写旧 job）", async () => {
  const stateDir = await tempDir("resume-host-legacyjob-");
  await mkdir(path.join(stateDir, "jobs"), { recursive: true });
  await writeFile(
    path.join(stateDir, "jobs", "legacy-1.json"),
    JSON.stringify({
      id: "legacy-1",
      threadId: "thread-legacy",
      cwd: stateDir,
      status: "waiting_rate_limit",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      attempts: 0,
    }),
    "utf8",
  );

  const result = await checkExecutionCapability({ stateDir });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes("legacy auto-resume jobs conflict")));

  const untouched = JSON.parse(await readFile(path.join(stateDir, "jobs", "legacy-1.json"), "utf8"));
  assert.equal(untouched.status, "waiting_rate_limit", "门禁只能读，绝不能改写旧 job");
});

test("能力门禁：干净的 stateDir 放行", async () => {
  const stateDir = await tempDir("resume-host-clean-");
  const result = await checkExecutionCapability({ stateDir });
  assert.equal(result.ok, true, `干净状态应放行，实际原因：${JSON.stringify(result.reasons)}`);
  assert.deepEqual(result.reasons, []);
});

test("状态页服务器：只读路由、静态资源、404 与 405 的分工", async () => {
  const stateDir = await tempDir("resume-host-http-");
  const daemon = makeDaemon({ extra: { stateDir } });
  const server = createStatusServer({ daemon, port: 0 });
  await server.listen();
  const base = `http://127.0.0.1:${server.server.address().port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "resume-host");

    const status = await fetch(`${base}/api/host/status`);
    assert.equal(status.status, 200);
    const payload = await status.json();
    assert.equal(payload.executionMode, "observe");
    assert.equal(payload.watchCount, 0);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /Codex 自动续跑/);

    const css = await fetch(`${base}/app.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);

    const notFound = await fetch(`${base}/does-not-exist`);
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).error.code, "NOT_FOUND");

    const wrongMethod = await fetch(`${base}/api/auto-resume/detect`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);

    // detect 需要守护器已经起来（否则没有 monitor 可跑），先 start 再打。
    await daemon.start();
    const post = await fetch(`${base}/api/auto-resume/detect`, { method: "POST" });
    assert.equal(post.status, 200);
    const detect = await post.json();
    // 启动首轮检测可能仍在飞行中：此时守护器按不可重入语义如实返回
    // cycleId "skipped"（这是契约内的正确行为，不是失败）。
    if (detect.cycleId === "skipped") {
      assert.equal(detect.skippedOverlapCount, 1);
    } else {
      assert.equal(detect.resumedCount, 0, "observe 模式下手动检测同样不得发送");
      assert.equal(detect.quotaState, "UNKNOWN");
    }

    // 经宿主只读面确认：检测状态已落盘可见，且仍然是 observe。
    const after = await (await fetch(`${base}/api/host/status`)).json();
    assert.ok(after.lastDetectionAt, "首轮检测必须已经落一个时间戳");
    assert.equal(after.executionMode, "observe");
    assert.equal(after.lastReport.resumedCount, 0);
  } finally {
    await server.close();
    await daemon.stop();
  }
});
