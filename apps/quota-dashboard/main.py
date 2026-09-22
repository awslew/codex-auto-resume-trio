# -*- coding: utf-8 -*-
"""API 配额仪表盘 入口（开发C）

装配 config → QuotaStore → 后台调度 → 系统托盘。
支持无界面验证：python main.py --selftest（跑一轮刷新打印结果后退出）。
"""
import os
import sys


def _ensure_stdio():
    """pythonw.exe（无控制台）运行时 stdout/stderr 为 None，print 会崩；重定向到日志文件。"""
    if sys.stdout is None or sys.stderr is None:
        log = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.log"),
                   "a", encoding="utf-8")
        if sys.stdout is None:
            sys.stdout = log
        if sys.stderr is None:
            sys.stderr = log


_ensure_stdio()


def _selftest_value(q):
    """把 Quota 渲染成一行可读数值文本（供无界面验证打印）。"""
    if q.source_status == "不可用":
        return q.error or "不可用"
    try:
        if q.billing_type == "subscription":
            parts = []
            for w in (q.windows or []):
                if getattr(w, "percent", None) is not None:
                    txt = f"{w.label} 已用{float(w.percent):.0f}%"
                    if getattr(w, "reset_in_sec", None) is not None:
                        txt += f"(重置{int(w.reset_in_sec)}s)"
                    parts.append(txt)
                elif w.used is not None:
                    parts.append(f"{w.label} {float(w.used):.2f}/{float(w.limit):.2f}{w.currency}")
                else:
                    parts.append(f"{w.label} —")
            if parts:
                return " · ".join(parts)
            if q.total is not None:
                return f"总量 {float(q.total):.2f}{q.currency}"
            return "—"
        parts = []
        if q.value is not None:
            parts.append(f"余额 {float(q.value):.2f}{q.currency}")
        if q.today_usage is not None:
            parts.append(f"今日 {float(q.today_usage):.2f}{q.currency}")
        if q.used is not None:
            parts.append(f"已用 {float(q.used):.2f}")
        if q.total is not None:
            parts.append(f"总量 {float(q.total):.2f}")
        return " ".join(parts) or "—"
    except (TypeError, ValueError):
        return str(q.value)


def _print_selftest(store):
    print()
    print("================ API 配额自检结果 ================")
    print(f"{'供应商':<16}{'状态':<8}{'数值':<56}{'时间':<26}")
    print("-" * 110)
    for name in store._providers:
        q = store.quotas.get(name)
        if q is None:
            print(f"{name:<16}{'未刷新':<8}")
            continue
        status = q.source_status
        if q.refresh_failed:
            status += "(旧数据)"
        print(f"{name:<16}{status:<8}{_selftest_value(q):<56}{(q.fetched_at or ''):<26}")
    print("-" * 110)
    print(f"下次后台刷新: {store.next_refresh_at} (epoch秒) / 每 {store.refresh_interval} 秒")
    print("==================================================")
    print()


def main(argv=None):
    import argparse

    parser = argparse.ArgumentParser(description="API 配额仪表盘")
    parser.add_argument("--selftest", action="store_true",
                        help="跑一轮刷新打印三个供应商结果后退出（无托盘，供无界面验证）")
    args = parser.parse_args(argv)

    # 1) 配置
    from config import load_config
    config = load_config()
    if config is None:
        # load_config 已打印中文引导（含复制 config.example.yaml 的命令）；
        # 这里只补一句退出说明：不伪造数据、不带着空配置继续跑。
        print("[main] 配置不可用，已退出（未展示任何数据）。")
        return 1

    # 2) 数据 + 调度
    from scheduler import QuotaStore
    store = QuotaStore(config)

    # 3) 无界面自检模式
    if args.selftest:
        print("[selftest] 正在执行一轮全量刷新……")
        store.refresh_all()
        _print_selftest(store)
        print("[selftest] 完成。")
        return 0

    # 4) 正常模式：立即刷新一轮 → 启动后台定时刷新 → 托盘
    store.start()

    try:
        from dashboard_ui.server import start_server
        from dashboard_ui.tray import run_tray
    except ImportError:
        print("界面模块未就绪：dashboard_ui/ 尚未完成。")
        print("可先运行  python main.py --selftest  验证数据层与调度，集成完成后即可启动托盘。")
        store.stop()
        return 1

    httpd, url = start_server(store, config)
    print(f"[main] 本地仪表盘地址：{url}（托盘点击打开）")

    try:
        run_tray(store, config, url)   # 阻塞至托盘“退出”触发
    finally:
        store.stop()                   # 干净退出
        try:
            httpd.shutdown()
        except Exception:
            pass

    # 本会话若打开过浏览器仪表盘，Python 默认终结化也可能有残留清理问题；
    # 统一跳过终结化直接退出（见 dashboard_ui/ 说明）。
    os._exit(0)


if __name__ == "__main__":
    sys.exit(main())
