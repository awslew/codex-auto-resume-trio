"""统一数据模型（契约第4节，开发A 编写）。所有 provider 模块复用本文件。"""
from dataclasses import dataclass, field
from typing import Optional

SOURCE_OK = "官方"
SOURCE_UNAVAILABLE = "不可用"


@dataclass
class WindowUsage:
    label: str                 # "5小时" / "本周" / "本月"
    used: Optional[float] = None    # 已用金额（官方给金额时才有）
    limit: Optional[float] = None   # 窗口限额（官方文档常量）
    currency: str = "USD"
    percent: Optional[float] = None   # 已用百分比（OpenCode Go 官方页只给百分比）
    reset_in_sec: Optional[int] = None  # 距重置剩余秒数（OpenCode Go 官方页提供）


@dataclass
class Quota:
    provider: str                    # deepseek|openrouter|opencode_go
    billing_type: str                # balance|subscription
    currency: str = "USD"
    value: Optional[float] = None    # balance: 剩余余额
    used: Optional[float] = None     # balance: 已用
    total: Optional[float] = None    # balance: 总量
    today_usage: Optional[float] = None  # 今日累积用量（官方源提供才有；None=官方未提供）
    windows: list = field(default_factory=list)   # subscription: [WindowUsage,...]
    fetched_at: Optional[str] = None # ISO 时间戳
    source_status: str = SOURCE_OK   # SOURCE_OK | SOURCE_UNAVAILABLE
    error: Optional[str] = None      # 失败原因/不可用原因
    refresh_failed: bool = False     # 本次刷新失败但沿用上次官方数据
