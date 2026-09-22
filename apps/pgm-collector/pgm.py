#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PGM v1 — Codex 项目总经理（轻量版）
读 Codex 本地会话转录（~/.codex/sessions/），汇总每个项目的进展摘要，产出简报。

用法:
    python pgm.py            # 只看"项目："前缀的会话（总经理简报）
    python pgm.py --all      # 所有 Codex 会话
    python pgm.py --limit 3  # 每项目最多摘取最近 N 条助手汇报（默认 2）

依赖: 无，纯标准库。Codex 会话 id 在 ~/.codex/session_index.jsonl。
"""
import json
import os
import sys
import glob
from datetime import datetime, timezone

CODEX = os.path.expanduser("~/.codex")
INDEX = os.path.join(CODEX, "session_index.jsonl")


def load_index():
    """id -> {thread_name, updated_at}"""
    idx = {}
    if not os.path.exists(INDEX):
        return idx
    with open(INDEX, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                idx[d["id"]] = {
                    "thread_name": d.get("thread_name", ""),
                    "updated_at": d.get("updated_at", ""),
                }
            except json.JSONDecodeError:
                continue
    return idx


def find_rollouts(sid):
    """~/.codex/sessions/YYYY/MM/DD/rollout-*-<sid>.jsonl，按时间排序"""
    base = os.path.join(CODEX, "sessions")
    out = []
    if not os.path.isdir(base):
        return out
    for y in os.listdir(base):
        for m in os.listdir(os.path.join(base, y)):
            for dd in os.listdir(os.path.join(base, y, m)):
                pat = os.path.join(base, y, m, dd, f"rollout-*-{sid}.jsonl")
                out.extend(glob.glob(pat))
    out.sort()
    return out


def parse_rollout(path):
    """返回 (assistant_msgs, last_item, last_ts)
    assistant_msgs: [(ts, text), ...] 助手纯文本汇报
    last_item:      (type, role_or_name, ts) 最后一条记录，用于状态判断
    """
    msgs = []
    last = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("type") != "response_item":
                continue
            p = d.get("payload", {})
            ts = d.get("timestamp", "")
            last = (p.get("type"), p.get("role") or p.get("name") or "", ts)
            if p.get("type") == "message":
                text = "".join(
                    c.get("text", "")
                    for c in p.get("content", [])
                    if isinstance(c, dict) and c.get("type") == "output_text"
                )
                if text.strip():
                    msgs.append((ts, text.strip()))
    return msgs, last


def status_of(last_item, last_ts, now):
    """根据最后一条记录类型 + 距今时长，推断项目状态"""
    typ = last_item[0] if last_item else "?"
    label = {
        "reasoning": "思考中",
        "function_call": "运行中(调工具)",
        "function_call_output": "运行中(工具已返回)",
        "custom_tool_call": "运行中(自定义工具)",
        "custom_tool_call_output": "运行中(自定义工具已返回)",
        "message": "已汇报·待下一步",
        "session_meta": "会话元数据",
    }.get(typ, typ)
    age_min = None
    if last_ts:
        try:
            dt = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
            age_min = max(0, int((now - dt).total_seconds() // 60))
        except ValueError:
            pass
    return label, age_min


def gather_projects(idx, limit=2):
    """为每个会话id收集: 名字/最新转录/助手汇报"""
    projects = []
    for sid, meta in idx.items():
        name = meta.get("thread_name", "")
        if not name:
            continue
        rollouts = find_rollouts(sid)
        if not rollouts:
            continue
        all_msgs, last = [], None
        for rp in rollouts:
            msgs, last = parse_rollout(rp)
            all_msgs.extend(msgs)
        if not all_msgs and last is None:
            continue
        projects.append({
            "sid": sid,
            "name": name,
            "updated_at": meta.get("updated_at", ""),
            "msgs": all_msgs,
            "last": last,
            "rollout": rollouts[-1],
        })
    # 按最近一次助手汇报时间倒序
    projects.sort(key=lambda p: (p["msgs"][-1][0] if p["msgs"] else p["updated_at"]), reverse=True)
    return projects


def main():
    args = [a for a in sys.argv[1:]]
    show_all = "--all" in args
    limit = 2
    for a in args:
        if a.startswith("--limit"):
            try:
                limit = int(args[args.index(a) + 1])
            except (ValueError, IndexError):
                pass

    idx = load_index()
    if not idx:
        print("未找到 Codex 会话索引:", INDEX)
        sys.exit(1)

    projects = gather_projects(idx, limit)
    if not show_all:
        projects = [p for p in projects if p["name"].startswith("项目")]
    if not projects:
        print("没有匹配的项目会话（试试 --all）")
        sys.exit(0)

    now = datetime.now(timezone.utc)
    print("=" * 68)
    print("  PGM · Codex 项目总览   (%d 个项目)   %s" % (len(projects), now.strftime("%Y-%m-%d %H:%M")))
    print("=" * 68)

    for i, p in enumerate(projects, 1):
        msgs = p["msgs"]
        last_ts = msgs[-1][0] if msgs else p["updated_at"]
        label, age = status_of(p["last"], last_ts, now)
        age_str = f"{age}min" if age is not None else "?"
        print(f"\n[{i}] {p['name'][:50]}")
        print(f"    状态: {label}  |  最近活动: {age_str}  |  {last_ts[:16]}")
        # 最近 limit 条汇报
        for ts, text in msgs[-limit:]:
            snippet = text.replace("\n", " ")[:220]
            print(f"    · ({ts[11:16]}) {snippet}")

    print("\n" + "=" * 68)
    print("  提示: 想深入某项目日志，直接打开对应 rollout 文件看原文")
    print("=" * 68)


if __name__ == "__main__":
    main()
