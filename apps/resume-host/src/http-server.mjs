/**
 * 只读状态页服务器（Node 原生 http，无第三方框架）
 *
 * 路由分工：
 * - `/api/auto-resume/*` 交给守护器（唯一 owner 的写操作面：PUT/DELETE watch、
 *   detect、refresh）。宿主不重复实现这些语义。
 * - 本模块自己提供只读宿主面：`/health`、`/api/host/status`、`/api/host/watches`，
 *   以及状态页静态资源（`/`、`/app.css`、`/app.js`）。
 *
 * 安全：只监听 127.0.0.1；页面与 API 都不做远程暴露，也不接受跨站写操作
 * （写操作仍需显式调用 /api/auto-resume/*）。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadScore } from "../../../dist/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(HERE, "..", "ui");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const STATIC_ROUTES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.css": "app.css",
  "/app.js": "app.js",
};

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function methodNotAllowed(response, allowed) {
  response.writeHead(405, {
    "content-type": "application/json; charset=utf-8",
    allow: allowed.join(", "),
  });
  response.end(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", allowed } }));
}

async function sendStatic(response, fileName) {
  try {
    const body = await readFile(path.join(UI_DIR, fileName));
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(fileName)] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "content-length": body.length,
    });
    response.end(body);
  } catch (error) {
    sendJson(response, 404, { error: { code: "NOT_FOUND", message: `missing asset ${fileName}: ${error?.code ?? error}` } });
  }
}

/**
 * 状态页服务器。
 *
 * @param {{ daemon: { handleRequest: Function, getStatus: Function, listWatches: Function, stateDir: string, resolvedEntry: unknown }, host?: string, port?: number }} options
 */
export function createStatusServer(options) {
  const daemon = options.daemon;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 5173;
  const startedAt = Date.now();

  async function handle(request, response, url) {
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { ok: true, service: "resume-host", uptimeMs: Date.now() - startedAt });
    }

    if (request.method === "GET" && url.pathname === "/api/host/status") {
      const status = daemon.getStatus();
      // listWatches 是异步的（读状态目录）：漏了 await 会得到 undefined.length，
      // JSON 序列化后变成 null，页面上的 watch 数量会永远显示空。
      const watches = await daemon.listWatches();
      return sendJson(response, 200, {
        ...status,
        stateDir: daemon.stateDir,
        // 解析出的 Codex 入口；null = 无可用入口（quota 恒 UNKNOWN、execute 不过门禁）。
        codexEntry: daemon.resolvedEntry ?? null,
        watchCount: watches.length,
        port,
        pid: process.pid,
        startedAt: new Date(startedAt).toISOString(),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/host/watches") {
      const all = await daemon.listWatches();
      return sendJson(response, 200, { count: all.length, watches: all });
    }

    // 「项目总谱」只读接口：聚合 ~/.codex 转录成"每个项目一个声部"的进度谱
    // （resume-core 的 pgm-score）。方案与 apps/pgm-collector（Python 版，
    // 带 AI 分析与接力简报）共用同一份数据源，这里是轻量只读视图。
    if (request.method === "GET" && url.pathname === "/api/host/pgm") {
      const queryKeys = [...url.searchParams.keys()];
      if (queryKeys.length > 0) {
        return sendJson(response, 400, {
          error: { code: "UNKNOWN_QUERY_PARAMETER", message: "GET /api/host/pgm does not accept query parameters" },
        });
      }
      try {
        const workspaces = loadScore(process.env);
        return sendJson(response, 200, { count: workspaces.length, workspaces, generatedAt: new Date().toISOString() });
      } catch (error) {
        // 转录/会话库不可读时如实报错，不返回空壳冒充"没有项目"。
        return sendJson(response, 500, {
          error: { code: "PGM_SCORE_FAILED", message: error?.message ?? String(error) },
        });
      }
    }

    // 守护器自己的写/读面：/api/auto-resume/*
    const daemonHandled = await daemon.handleRequest(request, response, url, sendJson, methodNotAllowed);
    if (daemonHandled === false || daemonHandled === undefined) {
      // 不是守护器的路由 → 继续走静态资源。
    } else {
      return daemonHandled;
    }

    if (request.method === "GET" && Object.hasOwn(STATIC_ROUTES, url.pathname)) {
      return sendStatic(response, STATIC_ROUTES[url.pathname]);
    }

    sendJson(response, 404, { error: { code: "NOT_FOUND", message: `no route for ${request.method} ${url.pathname}` } });
    return undefined;
  }

  const server = createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url ?? "/", `http://${host}:${port}`);
    } catch {
      sendJson(response, 400, { error: { code: "BAD_REQUEST", message: "malformed request url" } });
      return;
    }
    Promise.resolve(handle(request, response, url)).catch((error) => {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (!response.headersSent) {
        sendJson(response, status, {
          error: { code: error?.code ?? "INTERNAL_ERROR", message: error?.message ?? String(error) },
        });
      } else {
        response.end();
      }
    });
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  return {
    server,
    url: `http://${host}:${port}`,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    },
  };
}
