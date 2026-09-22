"""Codex（ChatGPT 订阅）用量数据源。

官方 API 不存在；唯一官方源 = ChatGPT 后端用量接口：
    GET https://chatgpt.com/backend-api/wham/usage
认证 = Codex CLI 登录态 ~/.codex/auth.json 里的 OAuth access_token（Bearer）+ account_id 头。
本方案复刻自 GitHub 高星项目 steipete/CodexBar(19.9k★) 的 CodexOAuthUsageFetcher（源码审计干净，仅向官方域名发 token）。

数据真实性铁律：
  - 禁止任何本地推算：不读本地会话 rollout / sqlite / 端口 / 日志。
  - 未登录(无 auth.json) / 401 / 解析失败 / HTTP 非 200 → 一律返回 source_status='不可用'。
  - 绝不硬编码已用金额/百分比；只按官方响应原样展示。
  - 只读 ~/.codex/auth.json，绝不写回、绝不改动 Codex 登录态文件。
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("缺少 requests 依赖，请先执行: pip install requests")

from .quota import Quota, WindowUsage, SOURCE_OK, SOURCE_UNAVAILABLE

# 官方用量接口（与 CodexBar CodexOAuthUsageFetcher 一致）
_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"


def _now_iso() -> str:
    """当前本地时间 ISO 字符串。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _unavailable(error: str) -> Quota:
    """统一构造"不可用"结果（不抛错、不编数字）。"""
    return Quota(provider="codex", billing_type="subscription",
                 source_status=SOURCE_UNAVAILABLE, error=error)


def _label_for_window(seconds):
    """把官方 limit_window_seconds 映射成可读窗口名（未知长度不瞎猜）。"""
    try:
        seconds = int(seconds)
    except (TypeError, ValueError):
        return "用量窗口"
    if seconds == 18000:
        return "5小时"
    if seconds == 43200:
        return "12小时"
    if seconds == 86400:
        return "今日"
    if seconds == 604800:
        return "本周"
    if seconds == 1209600:
        return "两周"
    if seconds == 2592000:
        return "本月"
    if seconds >= 3600:
        return f"{seconds // 3600}小时"
    return "用量窗口"


def _load_auth(auth_path: str) -> tuple:
    """读 Codex 登录态，返回 (access_token, account_id)；失败抛 ValueError(原因)。"""
    p = Path(auth_path)
    if not p.exists():
        raise ValueError(f"未找到 Codex 登录态 {p}，请先运行 codex 登录")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"读取 {p} 失败: {exc}")
    tokens = data.get("tokens") or {}
    access = tokens.get("access_token") or ""
    if not access:
        raise ValueError(f"{p} 中缺少 tokens.access_token（可能只有 API key 登录）")
    account_id = tokens.get("account_id") or ""
    return access, account_id


def _window(name: str, used_percent, reset_after_seconds) -> WindowUsage:
    """官方窗口 → 仪表盘 WindowUsage（只填官方给的原样字段）。"""
    return WindowUsage(
        label=_label_for_window(name),
        used=None,                 # 官方 wham/usage 只给百分比，不给美元金额
        limit=None,
        currency="USD",
        percent=float(used_percent),
        reset_in_sec=int(reset_after_seconds) if reset_after_seconds is not None else None,
    )


def _parse_windows(data: dict) -> list:
    """从官方响应解析额度窗口（主窗口 + 次窗口 + 模型专项 + 消费上限）。

    任一存在但字段缺失 → 抛 ValueError（上层统一转 '不可用'），不编数字。
    """
    windows = []
    rate_limit = data.get("rate_limit") or {}

    # 1) 主窗口（Codex 套餐的用量窗口）
    pw = rate_limit.get("primary_window")
    if pw is not None:
        used = pw.get("used_percent")
        reset = pw.get("reset_after_seconds") or pw.get("reset_at")
        if used is None:
            raise ValueError("primary_window 缺少 used_percent")
        windows.append(_window(pw.get("limit_window_seconds"), used, reset))

    # 2) 次窗口（部分套餐有）
    sw = rate_limit.get("secondary_window")
    if sw is not None:
        used = sw.get("used_percent")
        reset = sw.get("reset_after_seconds") or sw.get("reset_at")
        if used is None:
            raise ValueError("secondary_window 缺少 used_percent")
        windows.append(_window(sw.get("limit_window_seconds"), used, reset))

    # 3) 模型专项限额（additional_rate_limits，如 GPT-5.3-Codex-Spark）
    for item in data.get("additional_rate_limits") or []:
        name = item.get("limit_name") or item.get("metered_feature")
        rl = item.get("rate_limit") or {}
        pw = rl.get("primary_window")
        if pw is not None:
            used = pw.get("used_percent")
            reset = pw.get("reset_after_seconds") or pw.get("reset_at")
            if used is None:
                raise ValueError(f"{name or '专项限额'} 缺少 used_percent")
            w = _window(pw.get("limit_window_seconds"), used, reset)
            w.label = f"{name or '专项限额'}"
            windows.append(w)

    # 4) 消费上限（spend_control.individual_limit / 顶层 individual_limit）→ 一个"限额"窗口
    ind = (data.get("spend_control") or {}).get("individual_limit") or data.get("individual_limit")
    if ind is not None:
        limit = ind.get("limit")
        used = ind.get("used")
        if limit is not None and used is not None:
            used_pct = min(100.0, float(used) / float(limit) * 100.0)
        else:
            used_pct = None
        reset = ind.get("resets_at") or ind.get("reset_at")
        windows.append(WindowUsage(
            label="消费上限",
            used=float(used) if used is not None else None,
            limit=float(limit) if limit is not None else None,
            currency="USD",
            percent=used_pct,
            reset_in_sec=int(reset) if reset is not None else None,
        ))

    if not windows:
        raise ValueError("响应中没有任何额度窗口数据")
    return windows


def fetch_quota(cfg: dict) -> Quota:
    """抓取 ChatGPT 后端用量接口的 Codex 订阅额度。

    cfg: config.yaml 的 providers.codex 段
      - auth_path : Codex 登录态路径（留空 = ~/.codex/auth.json）
      - proxy     : Clash 代理，如 "http://127.0.0.1:7897"
    """
    auth_path = (cfg.get("auth_path") or "").strip() or os.path.expanduser("~/.codex/auth.json")
    proxy = cfg.get("proxy") or "http://127.0.0.1:7897"

    # ---- 读 Codex 登录态（只读，绝不写回）----
    try:
        access_token, account_id = _load_auth(auth_path)
    except ValueError as exc:
        return _unavailable(str(exc))

    proxies = {"http": proxy, "https": proxy}
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/json",
    }
    if account_id:
        headers["ChatGPT-Account-Id"] = account_id

    # ---- 请求官方用量接口（chatgpt.com 走代理易间歇超时，重试 3 次）----
    resp = None
    last_err = None
    for attempt in range(3):
        try:
            resp = requests.get(_USAGE_URL, headers=headers, proxies=proxies, timeout=15)
            break
        except requests.Timeout:
            last_err = "请求官方用量接口超时（15 秒）"
        except Exception as exc:
            last_err = f"请求官方用量接口失败: {exc}"
        if attempt < 2:
            time.sleep(2 * (attempt + 1))
    if resp is None:
        return _unavailable(last_err)

    if resp.status_code in (401, 403):
        return _unavailable("认证失败（401/403）：token 过期或已失效，请运行 codex 重新登录")
    if resp.status_code != 200:
        return _unavailable(f"官方用量接口返回 HTTP {resp.status_code}")

    # ---- 解析官方响应（失败即不可用）----
    try:
        data = resp.json()
    except Exception as exc:
        return _unavailable(f"官方响应解析失败: {exc}")
    try:
        windows = _parse_windows(data)
    except Exception as exc:
        return _unavailable(f"解析官方用量失败: {exc}")

    return Quota(
        provider="codex",
        billing_type="subscription",
        currency="USD",
        windows=windows,
        fetched_at=_now_iso(),
        source_status=SOURCE_OK,
    )


if __name__ == "__main__":
    # 模块独立自测：读项目根 config.yaml 的 providers.codex 段
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        import yaml
    except ImportError:  # pragma: no cover
        sys.exit("缺少 PyYAML 依赖，请先执行: pip install PyYAML")
    _root = Path(__file__).resolve().parents[1]
    _cfg = (yaml.safe_load((_root / "config.yaml").read_text(encoding="utf-8"))
            or {}).get("providers", {}).get("codex", {})
    _q = fetch_quota(_cfg)
    if _q.source_status == SOURCE_OK:
        _parts = "，".join(
            f"{w.label} 已用{w.percent:.0f}%"
            + (f"（重置{int(w.reset_in_sec)}s后）" if w.reset_in_sec is not None else "")
            for w in _q.windows)
        print(f"Codex 官方数据源：{_parts}")
    else:
        print(f"Codex 官方数据源不可用：{_q.error}")
