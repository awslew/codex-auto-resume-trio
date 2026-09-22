# -*- coding: utf-8 -*-
"""配置加载与归一化（开发C）

读取项目根 config.yaml，归一化为统一结构：
    {
        'refresh_interval_minutes': int,
        'dashboard_port': int,          # 可选，本地仪表盘端口（默认 8787）
        'providers': {
            name: {'enabled': bool, 'api_key': str, 'base_url': str,
                   'proxy': str, ['cookie': str, 'usage_url': str]},
        },
    }
任何缺失/解析失败 → 返回 None 并打印中文引导提示（不抛异常）。
界面/调度层一律使用归一化结果，缺字段已在本地补齐默认值。

配置定位：默认读本项目目录下的 config.yaml（基于 __file__ 解析，与当前工作目录 /
盘符 / 目录改名无关），可用环境变量 API_QUOTA_CONFIG 指向别处的配置文件。
"""
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = PROJECT_ROOT / "config.yaml"
CONFIG_ENV_VAR = "API_QUOTA_CONFIG"
EXAMPLE_CONFIG_NAME = "config.example.yaml"

_GUIDE = (
    f"首次运行：请复制 {EXAMPLE_CONFIG_NAME} 为 config.yaml 并填入各供应商 key。\n"
    f"[config]   PowerShell :  copy {EXAMPLE_CONFIG_NAME} config.yaml\n"
    f"[config]   cmd/bash   :  cp {EXAMPLE_CONFIG_NAME} config.yaml\n"
    f"[config] 也可以用环境变量 {CONFIG_ENV_VAR} 指向放在其它位置的配置文件。"
)


def mask_key(key):
    """脱敏打印：只显示前 6 位 + '***'。"""
    key = str(key or "")
    if not key:
        return "(空)"
    if len(key) <= 6:
        return key + "***"
    return key[:6] + "***"


def _normalize(raw):
    """把原始 yaml dict 归一化为调度层/界面层用的统一结构。"""
    try:
        interval = int(raw.get("refresh_interval_minutes", 3))
    except (TypeError, ValueError):
        interval = 3
    interval = max(interval, 1)  # 至少 1 分钟，防误配 0/负数导致死循环

    providers = {}
    raw_providers = raw.get("providers") or {}
    if not isinstance(raw_providers, dict):
        raw_providers = {}
    for name, cfg in raw_providers.items():
        if not isinstance(cfg, dict):
            continue
        p = {
            "enabled": bool(cfg.get("enabled", True)),
            "api_key": str(cfg.get("api_key", "")),
            "base_url": str(cfg.get("base_url", "")),
            "proxy": str(cfg.get("proxy", "")),
        }
        # opencode_go 特有字段：官方用量页 cookie / usage_url，仅在配置里出现时透传
        if "cookie" in cfg:
            p["cookie"] = str(cfg.get("cookie", ""))
        if "usage_url" in cfg:
            p["usage_url"] = str(cfg.get("usage_url", ""))
        # codex 特有字段：Codex 登录态路径（留空=~/.codex/auth.json）
        if "auth_path" in cfg:
            p["auth_path"] = str(cfg.get("auth_path", ""))
        providers[name] = p

    result = {"refresh_interval_minutes": interval, "providers": providers}
    # 本地仪表盘监听端口：原样透传，合法性由 dashboard_ui/server.py 兜底（默认 8787）
    if raw.get("dashboard_port") is not None:
        result["dashboard_port"] = raw.get("dashboard_port")
    return result


def load_config(path=None):
    """加载并归一化配置。

    path 为 None 时依次取环境变量 API_QUOTA_CONFIG、项目目录 config.yaml。
    缺失/解析失败/结构错误 → 返回 None（只打印中文引导，绝不抛异常、绝不伪造数据）。
    成功 → 返回归一化 dict（已脱敏打印各 provider 加载摘要）。
    """
    if path:
        p = Path(path)
    elif os.environ.get(CONFIG_ENV_VAR, "").strip():
        p = Path(os.environ[CONFIG_ENV_VAR].strip())
        print(f"[config] 使用环境变量 {CONFIG_ENV_VAR} 指定的配置文件：{p}")
    else:
        p = DEFAULT_CONFIG_PATH

    if not p.exists():
        print(f"[config] 未找到配置文件：{p}")
        print(f"[config] 本项目目录：{PROJECT_ROOT}")
        print(f"[config] {_GUIDE}")
        return None

    try:
        import yaml
        raw = yaml.safe_load(p.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[config] 配置解析失败：{e}")
        print(f"[config] {_GUIDE}")
        return None

    if not isinstance(raw, dict):
        print("[config] 配置格式错误：顶层应为字典（key: value 结构）。")
        print(f"[config] {_GUIDE}")
        return None

    cfg = _normalize(raw)
    for name, p in cfg["providers"].items():
        print(f"[config] 已加载供应商 {name}: enabled={p['enabled']}, "
              f"key={mask_key(p['api_key'])}, proxy={p['proxy'] or '直连'}")
    return cfg


if __name__ == "__main__":
    c = load_config()
    if c:
        print("providers:", list(c["providers"].keys()))
        print("refresh_interval_minutes:", c["refresh_interval_minutes"])
