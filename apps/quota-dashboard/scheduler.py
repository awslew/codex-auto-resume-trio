# -*- coding: utf-8 -*-
"""刷新调度核心：QuotaStore（开发C）

职责：
- 从归一化 config 中取出 enabled 的 provider，逐个调用 providers.<name>.fetch_quota(cfg)
- 后台 daemon 线程按 refresh_interval 定时刷新；refresh_now() 同步强制刷新（与后台互斥）
- 失败时保留该 provider 最近一次官方数据，副本标 refresh_failed=True 并更新 fetched_at；
  若从未有过官方数据则存一个 source_status='不可用' 的 Quota
- 单供应商挂掉不影响其他供应商

与开发A并行开发：providers/quota.py 可能尚未就绪，此处做了 ImportError 防御，
本地内置一个同构最小 Quota 副本保证调度器可独立运行；数据层就绪后自动使用真类。
"""
import importlib
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Optional

try:
    from providers.quota import Quota, SOURCE_OK, SOURCE_UNAVAILABLE
except ImportError:
    # 数据层未就绪：本地最小可运行副本（字段与 数据源确认.md 第4节契约一致）
    SOURCE_OK = "官方"
    SOURCE_UNAVAILABLE = "不可用"

    @dataclass
    class Quota:
        provider: str
        billing_type: str = "balance"
        currency: str = "USD"
        value: Optional[float] = None
        used: Optional[float] = None
        total: Optional[float] = None
        windows: list = field(default_factory=list)
        fetched_at: Optional[str] = None
        source_status: str = SOURCE_OK
        error: Optional[str] = None
        refresh_failed: bool = False


def _now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


# 各供应商计费类型（官方不可用时也正确标注；与 providers 契约一致）
_BILLING = {"deepseek": "balance", "openrouter": "balance", "opencode_go": "subscription", "codex": "subscription"}


class QuotaStore:
    def __init__(self, config: dict):
        self._providers = {}
        for name, cfg in (config.get("providers") or {}).items():
            if isinstance(cfg, dict) and cfg.get("enabled", False):
                self._providers[name] = cfg

        self.quotas = {}                       # provider -> Quota
        self._lock = threading.Lock()          # 串行化后台刷新 与 refresh_now()
        self._stop_event = threading.Event()
        self._thread = None

        try:
            minutes = max(int(config.get("refresh_interval_minutes", 3)), 1)
        except (TypeError, ValueError):
            minutes = 3
        self.refresh_interval = minutes * 60   # 秒
        self.next_refresh_at = 0.0             # epoch 秒

    # ---------- 单供应商抓取 ----------
    def _make_unavailable(self, name, error):
        return Quota(
            provider=name,
            billing_type=_BILLING.get(name, "balance"),
            source_status=SOURCE_UNAVAILABLE,
            error=error,
            fetched_at=_now_iso(),
        )

    def _fetch_one(self, name, cfg):
        """调用 providers.<name>.fetch_quota(cfg)。ImportError → 返回不可用 Quota。"""
        try:
            mod = importlib.import_module(f"providers.{name}")
            fetch_quota = getattr(mod, "fetch_quota", None)
            if fetch_quota is None:
                raise AttributeError(f"providers.{name} 缺少 fetch_quota()")
            return fetch_quota(cfg)
        except ImportError:
            return self._make_unavailable(name, f"数据层模块未就绪: providers.{name}")

    # ---------- 结果落库 ----------
    def _apply_result(self, name, q):
        old = self.quotas.get(name)
        if q.source_status == SOURCE_OK and not q.refresh_failed:
            # 成功：正常存入（含 fetched_at）
            if not q.fetched_at:
                q.fetched_at = _now_iso()
            self.quotas[name] = q
        else:
            # 失败：若之前有官方数据 → 保留副本并标 refresh_failed；
            # 否则存一个不可用 Quota。
            if old is not None and old.source_status == SOURCE_OK:
                stale = replace(old)
                stale.refresh_failed = True
                stale.fetched_at = _now_iso()
                stale.error = q.error or stale.error
                self.quotas[name] = stale
            else:
                if not q.fetched_at:
                    q.fetched_at = _now_iso()
                if not q.error:
                    q.error = "刷新失败"
                self.quotas[name] = q

    # ---------- 刷新 ----------
    def refresh_all(self):
        """刷新全部 enabled provider（后台异步调用方）。单供应商失败不阻断其他。"""
        for name, cfg in self._providers.items():
            try:
                q = self._fetch_one(name, cfg)
                self._apply_result(name, q)
            except Exception as e:  # fetch_quota/落库 任一异常 → 按失败处理，不阻断后续
                q = self._make_unavailable(name, f"刷新异常: {e}")
                try:
                    self._apply_result(name, q)
                except Exception:
                    continue
        self.next_refresh_at = time.time() + self.refresh_interval

    def refresh_now(self):
        """同步强制刷新。带锁，与后台循环互斥；若后台刷新正进行则等待其完成。"""
        with self._lock:
            self.refresh_all()

    # ---------- 后台线程 ----------
    def _loop(self):
        while not self._stop_event.wait(self.refresh_interval):
            try:
                with self._lock:
                    self.refresh_all()
            except Exception:
                # 循环不能因单次异常退出
                continue

    def start(self):
        """先立即同步刷新一轮，再启动后台 daemon 线程定时刷新。"""
        self._stop_event.clear()
        self.refresh_all()
        self._thread = threading.Thread(target=self._loop, name="quota-refresh-loop", daemon=True)
        self._thread.start()

    def stop(self):
        """置事件停止后台循环；短暂等待线程收尾。"""
        self._stop_event.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2)
