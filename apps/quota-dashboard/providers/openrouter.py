"""OpenRouter credits 数据源。

官方 API: GET {base_url}/v1/credits（路径含 /v1）。
海外接口必须走 Clash 代理（config.yaml 的 openrouter.proxy）。
余额 = total_credits - total_usage，全部来自官方响应，绝不编数字。
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:  # pragma: no cover
    sys.exit("缺少 requests 依赖，请先执行: pip install requests")

from .quota import Quota, SOURCE_OK, SOURCE_UNAVAILABLE


def _now_iso() -> str:
    """当前本地时间 ISO 字符串。"""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _unavailable(error: str) -> Quota:
    """统一构造"不可用"结果（不抛错、不编数字）。"""
    return Quota(provider="openrouter", billing_type="balance",
                 source_status=SOURCE_UNAVAILABLE, error=error)


def fetch_quota(cfg: dict) -> Quota:
    """拉取 OpenRouter credits。

    cfg: config.yaml 的 providers.openrouter 段
      - base_url: 例如 "https://openrouter.ai/api"
      - api_key : OpenRouter key
      - proxy   : 必须走 Clash 代理，如 "http://127.0.0.1:7897"
    """
    base_url = (cfg.get("base_url") or "https://openrouter.ai/api").rstrip("/")
    api_key = cfg.get("api_key") or ""
    proxy = cfg.get("proxy") or "http://127.0.0.1:7897"

    if not api_key:
        return _unavailable("config.yaml 中未配置 openrouter.api_key")
    if not api_key.isascii():
        # 同上：真实 key 恒为 ASCII，中文 = 占位符未替换。
        return _unavailable(
            "openrouter.api_key 含非 ASCII 字符（很可能仍是 config.example.yaml 里的中文占位符）；"
            "请到 https://openrouter.ai/settings/keys 创建真实 key 填入")

    url = f"{base_url}/v1/credits"
    headers = {"Authorization": f"Bearer {api_key}"}
    proxies = {"http": proxy, "https": proxy}

    # ---- 请求官方源（必须走代理） ----
    try:
        resp = requests.get(url, headers=headers, proxies=proxies, timeout=10)
        if resp.status_code == 401:
            return _unavailable("401 认证失败：api_key 无效或已失效")
        resp.raise_for_status()
        data = resp.json()
    except requests.Timeout:
        return _unavailable("请求超时（10 秒）")
    except Exception as exc:
        return _unavailable(f"请求失败: {exc}")

    # ---- 解析官方响应 ----
    d = data.get("data") or {}
    try:
        total_credits = float(d["total_credits"])   # 总量 USD
        total_usage = float(d["total_usage"])       # 已用 USD
    except (KeyError, TypeError, ValueError) as exc:
        return _unavailable(f"解析 total_credits/total_usage 失败: {exc}")

    # ---- 今日用量：/auth/key 的 usage_daily（拿不到不影响余额）----
    today_usage = None
    try:
        r2 = requests.get(f"{base_url}/v1/auth/key", headers=headers,
                          proxies=proxies, timeout=10)
        if r2.status_code == 200:
            d2 = (r2.json().get("data") or {})
            if d2.get("usage_daily") is not None:
                today_usage = float(d2["usage_daily"])
    except Exception:
        today_usage = None

    return Quota(
        provider="openrouter",
        billing_type="balance",
        currency="USD",
        value=round(total_credits - total_usage, 6),  # 余额 = 总量 - 已用
        used=total_usage,
        total=total_credits,
        today_usage=today_usage,
        fetched_at=_now_iso(),
        source_status=SOURCE_OK,
    )


if __name__ == "__main__":
    # 模块独立自测：读项目根 config.yaml 的 providers.openrouter 段
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        import yaml
    except ImportError:  # pragma: no cover
        sys.exit("缺少 PyYAML 依赖，请先执行: pip install PyYAML")
    _root = Path(__file__).resolve().parents[1]
    _cfg = (yaml.safe_load((_root / "config.yaml").read_text(encoding="utf-8"))
            or {}).get("providers", {}).get("openrouter", {})
    _q = fetch_quota(_cfg)
    if _q.source_status == SOURCE_OK:
        print(f"OpenRouter 余额：${_q.value:.2f} / 已用 ${_q.used:.2f} / 总量 ${_q.total:.2f}（官方数据源）")
    else:
        print(f"OpenRouter 官方数据源不可用：{_q.error}")
