# -*- coding: utf-8 -*-
"""开机自启注册/注销脚本（API 配额仪表盘 补充工具）

用法（在项目根目录下）：
  python install_autostart.py register    # 注册开机自启（写 HKCU Run，用 pythonw 静默启动）
  python install_autostart.py unregister  # 取消开机自启
  python install_autostart.py status      # 查看当前状态

实现：写入注册表 HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
值为 "pythonw.exe" 指向本脚本同级 main.py。开机登录即常驻托盘，无控制台窗口。
"""
import os
import sys
import winreg

# 自启项注册名。改名到 codex-resume-trio 体系后统一用新名字；旧的
# LEGACY_APP_NAMES 会在 register/status 时被识别并提示/顺带清理，避免同一个
# 程序被注册两遍（开机双开托盘）。
APP_NAME = "CodexResumeTrioQuotaDashboard"
LEGACY_APP_NAMES = ("APIQuotaDashboard",)
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
MAIN_PY = os.path.join(PROJECT_ROOT, "main.py")


def _pythonw_path():
    """优先 pythonw.exe（无控制台）；找不到则退回 python.exe（会带一个控制台窗口）。"""
    exe = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if os.path.isfile(exe):
        return exe
    return sys.executable


def _cmd():
    return f'"{_pythonw_path()}" "{MAIN_PY}"'


def _legacy_installed():
    """返回仍存在的旧自启项名字列表（换名前的注册残留）。"""
    found = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_QUERY_VALUE) as k:
            for name in LEGACY_APP_NAMES:
                try:
                    winreg.QueryValueEx(k, name)
                except FileNotFoundError:
                    continue
                found.append(name)
    except FileNotFoundError:
        pass
    return found


def register():
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, APP_NAME, 0, winreg.REG_SZ, _cmd())
        # 顺带清掉旧名字，否则开机两个托盘抢同一个端口。
        for name in LEGACY_APP_NAMES:
            try:
                winreg.DeleteValue(k, name)
                print(f"[autostart] 已清理旧自启项：{name}")
            except FileNotFoundError:
                pass
    print(f"[autostart] 已注册开机自启：{_cmd()}")


def unregister():
    removed = False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            for name in (APP_NAME, *LEGACY_APP_NAMES):
                try:
                    winreg.DeleteValue(k, name)
                    removed = True
                    if name != APP_NAME:
                        print(f"[autostart] 已清理旧自启项：{name}")
                except FileNotFoundError:
                    continue
    except FileNotFoundError:
        pass
    print("[autostart] 已取消开机自启" if removed else "[autostart] 当前未注册开机自启")


def status():
    legacy = _legacy_installed()
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_QUERY_VALUE) as k:
            val, _ = winreg.QueryValueEx(k, APP_NAME)
        print(f"[autostart] 已注册：{val}")
    except FileNotFoundError:
        print("[autostart] 未注册")
    for name in legacy:
        print(f"[autostart] ⚠ 发现旧自启项残留：{name} —— 跑一次 register 会自动清理（避免开机双开）")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    {"register": register, "unregister": unregister, "status": status}.get(action, status)()
