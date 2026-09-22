# -*- coding: utf-8 -*-
"""本地 HTTP 服务：给仪表盘网页提供数据（编排者重构，替代 tkinter 窗口）。

托盘点击 → 打开浏览器访问 http://127.0.0.1:<port>/ → 页面每 15s 拉 /api/quota。
与 onWatch(692★, Go daemon+Web dashboard) 同模式：后台常驻 + 浏览器仪表盘。
纯标准库 http.server，无第三方依赖；只绑定 127.0.0.1，仅本机可访问。

路由：
  GET /               → index.html（仪表盘页面）
  GET /app.css        → 样式
  GET /app.js         → 前端脚本
  GET /api/quota      → 当前全部 Quota 的 JSON（含下次刷新时间）
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_OPENCODE_DEFAULT = "https://opencode.ai"

# 本地仪表盘统一默认端口（见 README「端口 / Port」一节）：
#   优先级  API_QUOTA_PORT 环境变量 > config.yaml 的 dashboard_port > DEFAULT_PORT(8787)
DEFAULT_PORT = 8787
PORT_ENV_VAR = "API_QUOTA_PORT"
BIND_HOST = "127.0.0.1"


def _parse_port(value):
    """把配置/环境变量里的端口解析为合法 int；空值、非法值或越界一律返回 None。"""
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return port if 0 < port < 65536 else None


def resolve_port(config=None):
    """确定监听端口；无明示配置时回落 DEFAULT_PORT（不猜、不随机）。"""
    env_port = _parse_port(os.environ.get(PORT_ENV_VAR))
    if env_port is not None:
        return env_port
    try:
        cfg_port = _parse_port((config or {}).get("dashboard_port"))
    except AttributeError:
        cfg_port = None
    return cfg_port if cfg_port is not None else DEFAULT_PORT


def _quota_to_dict(q):
    d = {
        "provider": q.provider,
        "billing_type": q.billing_type,
        "currency": q.currency,
        "value": q.value,
        "used": q.used,
        "total": q.total,
        "today_usage": getattr(q, "today_usage", None),
        "fetched_at": q.fetched_at,
        "source_status": q.source_status,
        "error": q.error,
        "refresh_failed": q.refresh_failed,
    }
    if getattr(q, "windows", None):
        d["windows"] = [
            {"label": w.label, "used": w.used, "limit": w.limit, "currency": w.currency,
             "percent": getattr(w, "percent", None),
             "reset_in_sec": getattr(w, "reset_in_sec", None)}
            for w in q.windows
        ]
    return d


def _opencode_usage_url(config):
    try:
        u = (config or {}).get("providers", {}).get("opencode_go", {}).get("usage_url", "").strip()
        return u or _OPENCODE_DEFAULT
    except Exception:
        return _OPENCODE_DEFAULT


class _Handler(BaseHTTPRequestHandler):
    store = None
    config = None

    def log_message(self, *args):  # 静默访问日志
        pass

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/":
            self._serve_file("index.html", "text/html; charset=utf-8")
        elif path == "/app.css":
            self._serve_file("app.css", "text/css; charset=utf-8")
        elif path == "/app.js":
            self._serve_file("app.js", "text/javascript; charset=utf-8")
        elif path == "/api/quota":
            self._serve_quota()
        else:
            self.send_error(404)

    def _serve_file(self, name, ctype):
        f = _HERE / name
        if not f.exists():
            self.send_error(404)
            return
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _serve_quota(self):
        quotas = [
            _quota_to_dict(q)
            for q in (getattr(self.store, "quotas", {}) or {}).values()
            if q is not None
        ]
        payload = json.dumps({
            "quotas": quotas,
            "next_refresh_at": getattr(self.store, "next_refresh_at", None),
            "refresh_interval": getattr(self.store, "refresh_interval", None),
            "opencode_usage_url": _opencode_usage_url(self.config),
        }, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)


def start_server(store, config=None):
    """在独立 daemon 线程启动本地 HTTP 服务。

    默认监听 127.0.0.1:8787；可用 config.yaml 的 dashboard_port 或环境变量
    API_QUOTA_PORT 覆盖。端口被占用时退回系统自动分配的空闲端口（仍只绑本机），
    并打印一行提示，绝不静默失败。
    返回 (httpd, url)。httpd 用于最后 shutdown；url 给托盘/窗口打开浏览器用。
    """
    _Handler.store = store
    _Handler.config = config
    port = resolve_port(config)
    try:
        httpd = ThreadingHTTPServer((BIND_HOST, port), _Handler)
    except OSError as exc:
        print(f"[dashboard_ui] 端口 {port} 无法监听（{exc}）；改用系统自动分配的空闲端口。")
        print(f"[dashboard_ui] 如需固定端口，请检查 {PORT_ENV_VAR} / dashboard_port 配置或释放 {port}。")
        httpd = ThreadingHTTPServer((BIND_HOST, 0), _Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True,
                     name="dashboard-http").start()
    return httpd, f"http://{BIND_HOST}:{port}/"
