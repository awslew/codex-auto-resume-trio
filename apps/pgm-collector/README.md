# PGM 项目总谱（Codex 项目总谱）

把多个 Codex 项目窗口的进展汇总成"一张乐谱"：每个项目 = 一个声部，扫一眼就知道谁在跑、谁卡住、该拍什么板。

**所属项目**：本组件是三合一开源仓库 `codex-auto-resume` 的「项目总谱」组件，位于 `apps/pgm-collector/`。
另外两块是「Codex 自动续跑」（仓库根目录，Node/TypeScript）与「API 配额」（`apps/quota-dashboard/`，Python）。

**自包含目录**：本项目所有代码 + 运行时数据（接力简报、托盘日志）都在本目录内，可整体移动/备份/拷贝，不依赖 `~/bin` 或 `~/.pgm`。

## 启动

| 方式 | 命令 |
|---|---|
| CLI 总览 | `pgm.cmd`（或 `./pgm`，git-bash / Linux / macOS） |
| Web 看板 | `pgm_dash.cmd [端口]`（默认 5100，自动开浏览器） |
| 托盘常驻 | `start_tray.cmd`（默认端口 5101） |
| 双击启动 | 直接跑 `pgm_dash.cmd`（已运行则只开浏览器） |

- CLI：`pgm.cmd --all` 看全部会话，`pgm.cmd --limit 3` 每项目多摘几条汇报
- 看板：30s 自动刷新；顶部"重新分析"按钮强制重跑 AI 分析；每项目"⚡接力"按钮生成简报并新开 Claude 窗口接手项目
- AI 分析走 `claude -p`（走你现有 Claude Code 通道，零新增账单），仅当某项目最新汇报变化时才重新调用（缓存控成本）

## 结构

```
apps/pgm-collector/
├─ pgm.py            # CLI：读 Codex 转录汇总项目（纯标准库，无依赖）
├─ pgm_dash.py       # Web 看板：乐谱式 UI + AI 分析 + 接力按钮（依赖 flask）
├─ pgm_tray.py       # 托盘常驻启动器（依赖 pystray + Pillow）
├─ pgm_handoff.py    # 接力简报生成器（给 Claude 新窗口注入）
├─ pgm / pgm.cmd     # CLI 入口（sh / cmd）
├─ pgm_dash / pgm_dash.cmd  # 看板入口（sh / cmd）
├─ start_tray.cmd    # 托盘启动器（Windows）
├─ stop.cmd          # 按端口精确停进程
├─ runtime/          # 运行时生成（接力简报、托盘日志），不进版本库
└─ README.md
```

## 数据来源

- 会话索引：`~/.codex/session_index.jsonl`（id → thread_name）
- 转录：`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sid>.jsonl`
- 看板只展示名字以"项目"开头的会话；`pgm --all` 看全部

> Node 侧还有一个**轻量只读**的同源接口：续跑宿主状态页的 `GET /api/host/pgm`
> （`apps/resume-host`，读同一份 `~/.codex` 转录，只出状态色块，不做 AI 分析）。
> 需要 AI 现状分析与「接力」简报时用本组件。

## 依赖

- Python 3.11+（启动脚本按 `PGM_PYTHON` → `py -3` → `python` 顺序自动解析，不写死路径）
- 看板/托盘需要：`flask`、`pystray`、`Pillow`（`pip install -r requirements.txt`；CLI 无依赖）
- Claude Code 命令（`claude.cmd`，AI 分析与接力用；没装也不影响看板其它功能）

## 维护

- 停止：看板进程 Ctrl+C；托盘右键"退出"
- 端口占用：先 `netstat -ano | findstr 5100` 查 PID，再 `taskkill /PID <pid> /F`
  （**只按精确 PID 杀，严禁按进程名批量清杀**）
- 备份：整个 `apps/pgm-collector/` 目录拷走即可（含 runtime 数据）
