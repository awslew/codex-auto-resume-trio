# -*- coding: utf-8 -*-
"""仪表盘窗口（浏览器版）。

show_window(store, config, url)：先同步强制刷新（store.refresh_now()），再用默认浏览器
打开本地仪表盘页 url。每次点击托盘都重新打开，天然支持"关掉再开"。

页面由 dashboard_ui/server.py 提供本地 HTTP 服务（127.0.0.1），每 15 秒自动拉 /api/quota，
每秒更新"下次刷新"倒计时。打开前强制刷新保证用户看到的是最新官方数据。
"""
import threading
import webbrowser

__all__ = ["show_window"]


def show_window(store, config, url):
    def _open():
        try:
            store.refresh_now()   # 打开前先强制刷新，保证是最新数据
        except Exception:
            pass
        try:
            webbrowser.open(url)
        except Exception as exc:
            print(f"[dashboard_ui] 打开仪表盘失败: {exc}")

    threading.Thread(target=_open, daemon=True, name="open-dashboard").start()
