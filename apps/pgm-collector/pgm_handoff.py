#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PGM Handoff — 项目接力简报生成器
把某个 Codex 项目的最近对话转录整理成一份"接力简报"文件，
供 Claude Code 新窗口通过 --append-system-prompt-file 注入，
让新窗口一开口就掌握项目现状/卡点/待办。

用法:
    python pgm_handoff.py <sid> [--limit N] [--max-chars M]
"""
import argparse
import os
import sys
from datetime import datetime, timezone

# 自包含：本项目目录（apps/pgm-collector）加入 import 路径，复用同目录的 pgm
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
import pgm  # 复用 gather_projects 等

HANDOFF_DIR = os.path.join(BASE_DIR, "runtime", "handoffs")

# 简报文件头：接力指令 + 说明
BRIEF_HEADER = """# 项目接力简报（PGM Handoff）

你正在接手 Codex 项目经理的工作。Codex 是一个 AI 项目经理，它此前在负责下面这个项目。
你（Claude Code）现在被老板指派为该项目的新负责人，需要：
1. 先通读下方"项目对话转录"，梳理清楚：项目目标、当前进度、卡点/风险、待办事项、关键决策
2. 用 3-5 句话向老板汇报项目现状（做了什么/卡在哪/接下来该做什么），并主动提出你准备怎么继续
3. 之后听从老板派发具体任务并执行

注意：下方转录是 Codex 与用户之间的原始对话记录（含 Codex 的思考汇报与用户指示）。
最后一段为最新内容。转录可能被截断（文件头会标注截断范围）。

---BEGIN 项目对话转录---
"""

BRIEF_FOOTER = """
---END 项目对话转录---
"""


def build_brief(proj, limit=40, max_chars=30000):
    """把项目转录整理成接力简报文本"""
    msgs = proj.get("msgs", [])
    lines = []
    for ts, text in msgs[-limit:]:
        # 时间戳 HH:MM + 内容（压缩换行）
        snippet = " ".join(text.split())
        lines.append(f"[{ts[11:16]}] {snippet}")
    body = "\n".join(lines)

    # 截断到 max_chars，防止简报文件过大塞爆新窗口
    truncated = len(body) > max_chars
    if truncated:
        body = body[-max_chars:]
        note = f"（注：转录已被截断，仅保留最近 {limit} 条中的后 {max_chars} 字符）"
    else:
        note = f"（完整转录共 {len(msgs)} 条，已全部包含）"

    return BRIEF_HEADER + note + "\n\n" + body + "\n" + BRIEF_FOOTER, truncated


def write_brief(proj, limit=40, max_chars=30000):
    """生成简报文件，返回 (文件路径, 是否截断)"""
    os.makedirs(HANDOFF_DIR, exist_ok=True)
    # 文件名：项目名（sanitize）+ 时间戳，避免重名覆盖
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in proj["name"])[:40]
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    path = os.path.join(HANDOFF_DIR, f"{safe}-{ts}.md")
    text, truncated = build_brief(proj, limit=limit, max_chars=max_chars)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path, truncated


def main():
    ap = argparse.ArgumentParser(description="生成项目接力简报")
    ap.add_argument("sid", help="Codex 会话 id")
    ap.add_argument("--limit", type=int, default=40, help="最多取最近 N 条助手汇报（默认 40）")
    ap.add_argument("--max-chars", type=int, default=30000, help="简报最大字符数（默认 30000）")
    args = ap.parse_args()

    idx = pgm.load_index()
    projects = {p["sid"]: p for p in pgm.gather_projects(idx)}
    proj = projects.get(args.sid)
    if not proj:
        print(f"找不到项目 sid={args.sid}（可能没有转录）", file=sys.stderr)
        sys.exit(1)

    path, truncated = write_brief(proj, limit=args.limit, max_chars=args.max_chars)
    print(path)
    print(f"简报已生成：{path}（{len(open(path, encoding='utf-8').read())} 字符）")
    if truncated:
        print("注意：转录超出最大字符数，简报已截断")


if __name__ == "__main__":
    main()
