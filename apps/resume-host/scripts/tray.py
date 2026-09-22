#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Codex 自动续跑 · 系统托盘（pystray + Pillow）

与 `apps/pgm-collector/pgm_tray.py` 同一模式：pystray 常驻，左键打开状态页，
右键退出。由 `resume-host run --tray` 以 pythonw 拉起（无控制台窗口），也可以
手动 `python scripts/tray.py` 启动用于调试。

生命周期：托盘是宿主的子进程，不是守护者。
- 用户点「退出」→ taskkill 整个进程树（宿主 + 托盘，按精确 PID）
- 宿主先挂了 → 健康检查超时后托盘自动退出，不留孤儿图标

环境变量：
    RESUME_HOST_URL   状态页地址（默认 http://127.0.0.1:5173）
    RESUME_HOST_PID   宿主 PID（有则「退出」用它杀整棵树；没有只关自己）
"""
import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

URL = os.environ.get("RESUME_HOST_URL", "http://127.0.0.1:5173")
HEALTH_URL = f"{URL}/health"
HOST_PID = os.environ.get("RESUME_HOST_PID", "").strip()
TOOLTIP = "Codex 自动续跑"

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME_DIR = os.path.join(BASE_DIR, "runtime")
LOG_PATH = os.path.join(RUNTIME_DIR, "tray.log")

# pythonw 下 stdout/stderr 是 None，print 会直接崩；重定向到日志。
if sys.stdout is None or sys.stderr is None:
    os.makedirs(RUNTIME_DIR, exist_ok=True)
    _log = open(LOG_PATH, "a", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = _log
    if sys.stderr is None:
        sys.stderr = _log

try:
    import pystray
    from PIL import Image, ImageDraw
except Exception as exc:  # pragma: no cover - 只在缺依赖时走到
    sys.stderr.write(f"[tray] 需要 pystray + Pillow：{exc}\n")
    raise SystemExit(1)


def host_alive():
    """健康检查：宿主状态页还活着吗。"""
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def make_icon_image(size=64):
    """自绘图标：深底圆角 + 环形箭头（续跑）与额度刻度。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, size - 2, size - 2], radius=14, fill=(11, 15, 23, 255))
    d.rounded_rectangle([4, 4, size - 4, size - 4], radius=12, outline=(77, 141, 255, 255), width=2)
    # 环形箭头：缺口朝右上，表示"到点自动接上"
    d.arc([16, 16, 48, 48], start=300, end=210, fill=(53, 201, 138, 255), width=5)
    d.polygon([(46, 14), (50, 24), (39, 21)], fill=(53, 201, 138, 255))
    # 中心额度刻度
    for i, h in enumerate((10, 16, 22)):
        x = 26 + i * 5
        d.rounded_rectangle([x, 38 - h // 2, x + 3, 38 + h // 2], radius=1, fill=(230, 237, 247, 255))
    return img


def status_label(icon=None, item=None):
    return "宿主运行中" if host_alive() else "宿主未响应"


def open_status_page(icon=None, item=None):
    try:
        webbrowser.open(URL)
    except Exception:
        pass


def quit_app(icon, item=None):
    """退出：按精确 PID 杀掉宿主整棵树（宿主会连带收掉本托盘）。"""
    if HOST_PID.isdigit():
        try:
            subprocess.Popen(
                ["taskkill", "/PID", HOST_PID, "/T", "/F"],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            pass
    icon.stop()


def watch_host(icon):
    """宿主消失后自动退出，避免留下孤儿托盘图标。"""
    misses = 0
    while True:
        time.sleep(15)
        if host_alive():
            misses = 0
            continue
        misses += 1
        if misses >= 4:  # 连续 1 分钟不可达
            icon.stop()
            return


def main():
    menu = pystray.Menu(
        pystray.MenuItem("打开状态页", open_status_page, default=True),
        pystray.MenuItem(status_label, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("退出", quit_app),
    )
    icon = pystray.Icon("resume-host", make_icon_image(), TOOLTIP, menu=menu)
    try:
        icon.notify(
            "已在后台运行。点击图标打开状态页；若看不见图标，点任务栏溢出箭头拖到通知区。",
            TOOLTIP,
        )
    except Exception:
        pass
    threading.Thread(target=watch_host, args=(icon,), daemon=True, name="host-watch").start()
    icon.run()


if __name__ == "__main__":
    main()
