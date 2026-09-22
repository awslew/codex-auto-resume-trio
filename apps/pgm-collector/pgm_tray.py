#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PGM Dashboard 托盘启动器（仿 apiquota-dashboard 模式）
双击任务栏图标 → 启动看板(127.0.0.1:5101) + 自动开浏览器；托盘可退出。

- 左键单击 / “打开看板” = 打开浏览器看板页（已运行则直接打开，未运行则启动）
- 右键菜单 = 打开看板 / 退出
- 启动时弹一次气泡通知：Win11 新托盘图标默认进溢出区，提醒用户拖到通知区

用法:
    pythonw pgm_tray.py        # 无控制台窗口常驻（任务栏/自启动）
    python  pgm_tray.py        # 带控制台（调试）
"""
import os
import sys
import threading
import webbrowser

# 自包含：本项目目录（apps/pgm-collector）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
LOG_PATH = os.path.join(BASE_DIR, "runtime", "pgm_tray.log")

# pythonw 无控制台时 stdout/stderr 为 None，print 会崩 → 重定向到日志
if sys.stdout is None or sys.stderr is None:
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    _log = open(LOG_PATH, "a", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = _log
    if sys.stderr is None:
        sys.stderr = _log

import pystray
from PIL import Image, ImageDraw

PORT = 5101
URL = f"http://127.0.0.1:{PORT}"

app = None  # Flask app，延迟到 start_server 里 import（避免 pythonw 下 flask 打印问题）


import socket


def _server_running():
    """检查看板端口是否已监听（纯 socket 探测，避免 pythonw 下 spawn netstat 挂起）"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", PORT)) == 0
    finally:
        s.close()


def start_server():
    """在新线程里启动 Flask 看板（复用 pgm_dash.app）"""
    global app
    import pgm_dash
    app = pgm_dash.app
    threading.Thread(
        target=lambda: pgm_dash.app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True),
        daemon=True, name="pgm-dash-server",
    ).start()


def show_panel(icon=None, item=None):
    """打开看板浏览器页；未运行先启动"""
    def _open():
        if not _server_running():
            start_server()
        # 等服务起来再开浏览器
        for _ in range(30):
            if _server_running():
                break
            import time
            time.sleep(0.3)
        webbrowser.open(URL)
    threading.Thread(target=_open, daemon=True, name="open-pgm").start()


def quit_app(icon, item):
    icon.stop()


def _make_icon_image(size=64):
    """Pillow 现画：暖白纸底 + 墨黑 PGM 谱线，呼应看板视觉。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 纸底圆角方块
    d.rounded_rectangle([2, 2, size - 2, size - 2], radius=14, fill=(250, 249, 245, 255))
    d.rounded_rectangle([4, 4, size - 4, size - 4], radius=12,
                        outline=(32, 31, 28, 255), width=2)
    # 墨黑"PGM"三个竖条（乐谱线）
    bar_w, gap = 7, 6
    x0, y0, h = 12, 18, 28
    for i in range(3):
        x = x0 + i * (bar_w + gap)
        d.rounded_rectangle([x, y0, x + bar_w, y0 + h], radius=3, fill=(32, 31, 28, 255))
    # 底部"现在"虚线点（呼应声部时间轨）
    for i in range(4):
        x = x0 + i * (bar_w + gap)
        d.ellipse([x + 2, y0 + h + 6, x + bar_w - 2, y0 + h + 12], fill=(59, 110, 165, 255))
    return img


def main():
    menu = pystray.Menu(
        pystray.MenuItem("打开看板", show_panel, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("退出", quit_app),
    )
    icon = pystray.Icon("pgm-dashboard", _make_icon_image(), "PGM · 项目总谱", menu=menu)
    try:
        icon.notify(
            "已启动。点击图标打开项目总谱；若看不见图标，点任务栏 ⌃ 溢出箭头，把图标拖到通知区。",
            "PGM · 项目总谱")
    except Exception:
        pass
    # 启动即打开看板（双击任务栏图标的效果）
    show_panel()
    icon.run()  # 阻塞至退出
    os._exit(0)


if __name__ == "__main__":
    main()
