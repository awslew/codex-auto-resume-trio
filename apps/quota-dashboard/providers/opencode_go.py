"""OpenCode Go 订阅额度数据源（最高风险模块）。

官方 API 不存在；唯一官方源 = 登录态控制台用量页
（https://app.opencode.ai/workspace/<workspaceId>/usage），需在 config.yaml 配 cookie + usage_url。

数据真实性铁律：
  - 禁止任何本地推算：不读任何本地代理/路由日志、不读任何本地代理端口数据。
  - 未配 cookie / 解析失败 / HTTP 非 200 / 页面结构变化 → 一律返回 source_status='不可用'。
  - 绝不硬编码已用金额（只硬编码官方限额常量，来自 opencode.ai 官方文档）。
"""
from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("缺少 requests 依赖，请先执行: pip install requests")

from .quota import Quota, WindowUsage, SOURCE_OK, SOURCE_UNAVAILABLE

# 窗口定义：label / 官方页字段名 / 官方限额（USD，来自 opencode.ai 官方文档 Go 页面）
_WINDOWS = [
    ("5小时", "rollingUsage", 12.0),
    ("本周", "weeklyUsage", 30.0),
    ("本月", "monthlyUsage", 60.0),
]


def _now_iso() -> str:
    """当前本地时间 ISO 字符串。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _unavailable(error: str) -> Quota:
    """统一构造"不可用"结果（不抛错、不编数字）。"""
    return Quota(provider="opencode_go", billing_type="subscription",
                 source_status=SOURCE_UNAVAILABLE, error=error)


def _parse_cookie(cookie_str: str) -> dict:
    """把 'k1=v1; k2=v2; ...' 形式的 cookie 字符串解析成 dict。"""
    cookies = {}
    for part in cookie_str.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        cookies[k.strip()] = v.strip()
    return cookies


# ---------------------------------------------------------------------------
# 官方用量页解析（SolidJS SSR 序列化，实测 2026-08-04）
#   页面内嵌形如：
#     rollingUsage:$R[35]={status:"ok",resetInSec:9387,usagePercent:12}
#     weeklyUsage:$R[36]={status:"ok",resetInSec:488751,usagePercent:17}
#     monthlyUsage:$R[37]={status:"ok",resetInSec:167713,usagePercent:92}
#   官方页只给【百分比 + 重置倒计时秒】，不给美元金额 → 按原样展示，绝不换算编造。
# ---------------------------------------------------------------------------

def _parse_windows(html: str) -> list:
    """从官方用量页解析三个窗口（5小时/本周/本月）：percent + reset_in_sec。

    任一窗口缺失 / status 非 ok / 字段缺失 → 抛 ValueError（上层统一转 '不可用'）。
    """
    windows = []
    for label, key, limit in _WINDOWS:
        m = re.search(re.escape(key) + r':\$R\[\d+\]=\{(.*?)\}', html)
        if not m:
            raise ValueError(f"用量页缺少 {key} 窗口数据，页面结构可能已变化")
        block = m.group(1)
        st = re.search(r'status:"(\w+)"', block)
        rs = re.search(r'resetInSec:(\d+)', block)
        pc = re.search(r'usagePercent:([\d.]+)', block)
        if not st or st.group(1) != "ok" or not rs or not pc:
            raise ValueError(f"{key} 窗口数据不完整或状态非 ok，页面结构可能已变化")
        windows.append(WindowUsage(
            label=label,
            used=None,                 # 官方页不给美元金额
            limit=limit,
            currency="USD",
            percent=float(pc.group(1)),
            reset_in_sec=int(rs.group(1)),
        ))
    return windows


# ---------------------------------------------------------------------------
# 对外接口
# ---------------------------------------------------------------------------

def fetch_quota(cfg: dict) -> Quota:
    """抓取 OpenCode Go 官方控制台用量页的订阅额度。

    cfg: config.yaml 的 providers.opencode_go 段
      - cookie    : 浏览器登录 app.opencode.ai 后复制的整段 Cookie（空 = 官方数据源不可用）
      - usage_url : 用量页地址，含 workspaceId，如
                    https://app.opencode.ai/workspace/<workspaceId>/usage
      - proxy     : Clash 代理，如 "http://127.0.0.1:7897"
    """
    cookie_str = (cfg.get("cookie") or "").strip()
    usage_url = (cfg.get("usage_url") or "").strip()
    proxy = cfg.get("proxy") or "http://127.0.0.1:7897"

    # ---- 未配置官方登录态 → 如实返回不可用 ----
    if not cookie_str or not usage_url:
        return _unavailable(
            "未配置官方控制台 cookie/usage_url，需在 config.yaml 填写（见 docs/数据源确认.md 第3节）")

    cookies = _parse_cookie(cookie_str)
    if not cookies:
        return _unavailable("cookie 字符串解析为空，请检查 config.yaml 的 opencode_go.cookie 格式")

    proxies = {"http": proxy, "https": proxy}
    headers = {"User-Agent": "Mozilla/5.0"}

    # ---- 请求官方控制台用量页 ----
    try:
        resp = requests.get(usage_url, cookies=cookies, proxies=proxies,
                            timeout=10, headers=headers)
    except requests.Timeout:
        return _unavailable("请求官方控制台超时（10 秒）")
    except Exception as exc:
        return _unavailable(f"请求官方控制台失败: {exc}")

    if resp.status_code != 200:
        return _unavailable(
            f"官方控制台返回 HTTP {resp.status_code}（可能 cookie 失效或需重新登录）")

    # ---- 尽力而为解析（失败即不可用） ----
    try:
        windows = _parse_windows(resp.text)
    except Exception as exc:
        return _unavailable(f"解析官方用量页失败: {exc}")

    return Quota(
        provider="opencode_go",
        billing_type="subscription",
        currency="USD",
        windows=windows,
        fetched_at=_now_iso(),
        source_status=SOURCE_OK,
    )


if __name__ == "__main__":
    # 模块独立自测：读项目根 config.yaml 的 providers.opencode_go 段
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        import yaml
    except ImportError:  # pragma: no cover
        sys.exit("缺少 PyYAML 依赖，请先执行: pip install PyYAML")
    _root = Path(__file__).resolve().parents[1]
    _cfg = (yaml.safe_load((_root / "config.yaml").read_text(encoding="utf-8"))
            or {}).get("providers", {}).get("opencode_go", {})
    _q = fetch_quota(_cfg)
    if _q.source_status == SOURCE_OK:
        _parts = "，".join(
            f"{w.label} 已用{w.percent:.0f}%（重置{int(w.reset_in_sec)}s后）" for w in _q.windows)
        print(f"OpenCode Go 官方数据源：{_parts}")
    else:
        print(f"OpenCode Go 官方数据源不可用：{_q.error}")
