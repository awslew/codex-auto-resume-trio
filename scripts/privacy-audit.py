#!/usr/bin/env python3
"""公开发布前的隐私与凭据审计（可复现）。

扫描四层，任何一层命中即视为不可发布：
  (1) 当前工作树
  (2) 全部可达 git 历史 blob（含已被删除的文件）
  (3) 全部提交信息
  (4) 提交者/作者身份

用法：  python scripts/privacy-audit.py     （在仓库根目录执行）
退出码：0 = 通过；1 = 有命中（附文件名与行号）
"""
import os
import re
import subprocess
import sys

# 视为"必须为零"的敏感模式
PATTERNS = [
    ("本机用户名", re.compile(rb"hemou", re.I)),
    ("个人项目名", re.compile("WeChat|WaterSort|quick_install|沪上|闲鱼|刷题宝|ruankao|shuati"
                              "|hardware_circuit|hardlab".encode("utf-8"), re.I)),
    ("个人账户邮箱", re.compile(rb"[A-Za-z0-9._%+-]+@(gmail|qq|163|126|outlook|hotmail|foxmail|icloud|yahoo)\.", re.I)),
    ("OpenAI 风格 key", re.compile(rb"sk-[A-Za-z0-9_-]{20,}")),
    ("OpenRouter key", re.compile(rb"sk-or-v1-[A-Za-z0-9]{10,}")),
    ("Google key", re.compile(rb"AIza[0-9A-Za-z_-]{20,}")),
    ("GitHub token", re.compile(rb"ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}")),
    ("JWT", re.compile(rb"eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}")),
    ("Bearer 长串", re.compile(rb"Bearer\s+[A-Za-z0-9._-]{20,}")),
    ("真实会话 cookie", re.compile(rb"Fe26\.2\*\*\.\*[A-Za-z0-9*]{20,}|__Secure-[a-z]")),
    ("真实余额长小数", re.compile(rb"(?<![\d.])\d{1,3}\.\d{5,}(?![\d.])")),
    ("内网/私网 IP", re.compile(rb"\b(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b")),
    # 凭证字段后面跟了 16 位以上非占位符的实值
    ("凭证字段真实赋值", re.compile(
        rb"(api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[\"'][^\"'\s]{16,}[\"']", re.I)),
]

# 允许的例外（公开信息 / 占位符 / 测试夹具）
ALLOW = [
    re.compile(rb"codex-auto-resume@example\.local"),
    re.compile(rb"noreply@github\.com"),
    re.compile(rb"example\.(com|org|local)"),
    re.compile(rb"@openai/|@types/|@eslint/|@deepseek"),
    # 占位符标记（本地化提示语等）
    re.compile("你的|请填写|替换为|placeholder".encode("utf-8")),
    re.compile(rb"your[_-]?(key|token)|YOUR_|xxx+|\*\*\*+", re.I),
]

# 审计脚本自身含有这些模式串，跳过以免自指误报
SKIP_FILES = {"privacy-audit.py"}

SKIP_DIRS = {".git", "node_modules", "dist", "__pycache__", ".venv", "venv", "coverage"}
TEXT_EXT = {".md", ".txt", ".json", ".jsonl", ".yml", ".yaml", ".toml", ".js", ".mjs", ".cjs",
            ".ts", ".tsx", ".py", ".cmd", ".bat", ".ps1", ".vbs", ".xml", ".html", ".css",
            ".cfg", ".ini", ".sh", ".gitignore", ".gitattributes", ""}

MAX_SHOW = 40


def allowed(fragment):
    return any(a.search(fragment) for a in ALLOW)


def is_version_line(blob, start):
    """语义化版本号（1.20260730.1 / 5.20260828.0-alpha）不是余额，排除。"""
    line = blob[blob.rfind(b"\n", 0, start) + 1:blob.find(b"\n", start) if blob.find(b"\n", start) != -1 else len(blob)]
    return b'"' in line and (b":" in line or b"^" in line or b"~" in line)


def scan(label, items):
    hits = 0
    for name, blob in items:
        for pname, pat in PATTERNS:
            for m in pat.finditer(blob):
                if allowed(m.group(0)) or allowed(blob[max(0, m.start() - 60):m.end() + 60]):
                    continue
                if pname in ("真实余额长小数", "内网/私网 IP") and is_version_line(blob, m.start()):
                    continue
                hits += 1
                if hits <= MAX_SHOW:
                    line_no = blob[:m.start()].count(b"\n") + 1
                    ctx = blob.split(b"\n")[line_no - 1][:110].decode("utf-8", "replace").strip()
                    print("  [%s] %s:%d  %s" % (pname, name, line_no, ctx))
    print("  %s 命中: %d" % (label, hits))
    return hits


def git(*args):
    return subprocess.run(["git"] + list(args), capture_output=True).stdout


def main():
    total = 0

    print("=== (1) 当前工作树 ===")
    items = []
    for root, dirs, files in os.walk("."):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for n in files:
            if n in SKIP_FILES:
                continue
            ext = os.path.splitext(n)[1].lower()
            if n not in (".gitignore", ".gitattributes") and ext not in TEXT_EXT:
                continue
            p = os.path.join(root, n)
            try:
                items.append((p, open(p, "rb").read()))
            except OSError:
                pass
    total += scan("工作树", items)

    print("=== (2) 全部可达历史 blob ===")
    items, seen = [], set()
    for line in git("rev-list", "--objects", "--all").split(b"\n"):
        if not line.strip():
            continue
        h, _, path = line.partition(b" ")
        if not path or h in seen:
            continue
        seen.add(h)
        name = path.decode("utf-8", "replace")
        if os.path.basename(name) in SKIP_FILES:
            continue
        items.append((name,
                      subprocess.run(["git", "cat-file", "-p", h.decode()], capture_output=True).stdout))
    total += scan("历史 blob", items)

    print("=== (3) 提交信息 ===")
    total += scan("提交信息", [("all-commits", git("log", "--all", "--format=%H%n%B%n---"))])

    print("=== (4) 作者/提交者身份（仅供人工确认）===")
    print(git("log", "--all", "--format=%an <%ae>").decode("utf-8", "replace").strip())

    print()
    print("审计结论: %d 处命中" % total)
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
