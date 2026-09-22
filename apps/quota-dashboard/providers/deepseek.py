"""DeepSeek 官网余额数据源。

官方 API: GET {base_url}/user/balance（直连，无需代理）。
数据真实性铁律：余额必须来自官方响应；任何异常都返回 source_status='不可用'，绝不编数字、绝不抛错。
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

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
    return Quota(provider="deepseek", billing_type="balance",
                 source_status=SOURCE_UNAVAILABLE, error=error)


def fetch_quota(cfg: dict) -> Quota:
    """拉取 DeepSeek 官网余额。

    cfg: config.yaml 的 providers.deepseek 段
      - base_url: 例如 "https://api.deepseek.com"
      - api_key : 官网 API key
      - proxy   : "" 留空 = 直连（DeepSeek 域内无需代理）
    """
    base_url = (cfg.get("base_url") or "https://api.deepseek.com").rstrip("/")
    api_key = cfg.get("api_key") or ""
    proxy = cfg.get("proxy") or None  # 空串/None → 直连，不传 proxies

    if not api_key:
        return _unavailable("config.yaml 中未配置 deepseek.api_key")
    if not api_key.isascii():
        # 真实 key 恒为 ASCII；带中文几乎必然是没替换 config.example.yaml 里的占位符。
        # 直接给出可读原因，避免 requests 抛 'latin-1' codec 这类看不懂的报错。
        return _unavailable(
            "deepseek.api_key 含非 ASCII 字符（很可能仍是 config.example.yaml 里的中文占位符）；"
            "请到 https://platform.deepseek.com 创建真实 key 填入")

    url = f"{base_url}/user/balance"
    headers = {"Authorization": f"Bearer {api_key}"}
    proxies = {"http": proxy, "https": proxy} if proxy else None

    # ---- 请求官方源 ----
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
    if not data.get("is_available"):
        return _unavailable("官方返回 is_available=false，账户不可用")
    infos = data.get("balance_infos") or []
    if not infos:
        return _unavailable("响应缺少 balance_infos 字段")
    info = infos[0]
    try:
        total_balance = float(info["total_balance"])   # 字符串 → float
        currency = info.get("currency") or "CNY"
    except (KeyError, TypeError, ValueError) as exc:
        return _unavailable(f"解析 total_balance 失败: {exc}")

    return Quota(
        provider="deepseek",
        billing_type="balance",
        currency=currency,
        value=total_balance,          # 剩余余额
        used=None,                    # API 不提供已用量
        total=total_balance,          # balance 型：总量即当前余额
        fetched_at=_now_iso(),
        source_status=SOURCE_OK,
    )


if __name__ == "__main__":
    # 模块独立自测：读项目根 config.yaml 的 providers.deepseek 段（完整配置系统由开发C负责）
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        import yaml
    except ImportError:  # pragma: no cover
        sys.exit("缺少 PyYAML 依赖，请先执行: pip install PyYAML")
    _root = Path(__file__).resolve().parents[1]
    _cfg = (yaml.safe_load((_root / "config.yaml").read_text(encoding="utf-8"))
            or {}).get("providers", {}).get("deepseek", {})
    _q = fetch_quota(_cfg)
    if _q.source_status == SOURCE_OK:
        print(f"DeepSeek 余额：¥{_q.value:.2f}（{_q.currency}，官方数据源）")
    else:
        print(f"DeepSeek 官方数据源不可用：{_q.error}")
