# -*- coding: utf-8 -*-
"""系统托盘（pystray）。

- 左键单击 / “显示仪表盘” = 先刷新，再打开浏览器本地仪表盘页。
- 右键菜单 = 显示仪表盘 / 退出（无“立即刷新”，打开即刷新）。
- 启动时弹一次气泡通知：Win11 新托盘图标默认进溢出区，提醒用户拖到通知区。

实现要点：pystray 0.19.5 没有 on_activate；Windows 上左键单击触发的是 Menu 的
default=True 项，因此把“显示仪表盘”设为 default=True。
退出流程：main.py 在 run_tray 返回后 stop store + os._exit(0)。
"""
import pystray
from PIL import Image, ImageDraw

from dashboard_ui.window import show_window

__all__ = ["run_tray"]

TOOLTIP = "API 配额仪表盘"


def _make_icon_image(size=64):
    """Pillow 现画：深色圆角方块 + 蓝紫色柱状图 + 亮描边，深色任务栏上更醒目。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, size - 2, size - 2], radius=14, fill=(18, 22, 34, 255))
    d.rounded_rectangle([4, 4, size - 4, size - 4], radius=12,
                        outline=(120, 140, 255, 255), width=2)
    bar_w = 9
    x0, base = 13, size - 13
    for i, h in enumerate((12, 18, 25)):
        x = x0 + i * (bar_w + 4)
        d.rounded_rectangle([x, base - h, x + bar_w, base], radius=3,
                            fill=(104, 138, 255, 255))
    return img


def run_tray(store, config, url):
    def _show(icon, item):
        show_window(store, config, url)

    def _quit(icon, item):
        stop = getattr(store, "stop", None)
        if callable(stop):
            try:
                stop()
            except Exception:
                pass
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("显示仪表盘", _show, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("退出", _quit),
    )

    # 图标 id 只用于系统托盘内部区分（不是路径、不影响搬迁），随项目改名统一。
    icon = pystray.Icon("codex-trio-quota-dashboard", _make_icon_image(), TOOLTIP, menu=menu)
    try:
        icon.notify(
            "已启动。点击图标打开配额仪表盘；若看不见图标，点任务栏 ⌃ 溢出箭头，把图标拖到通知区。",
            TOOLTIP)
    except Exception:
        pass
    icon.run()
