# codex-desktop-auto-resume

自动续跑被 **Codex 使用额度（5 小时 / 每周）** 打断的桌面版会话的守护器。

基于 [LUCIENIN/codex-auto-resume](https://github.com/LUCIENIN/codex-auto-resume) 改装，新增了「扫描 Codex Desktop 会话库 → 识别因额度停止的会话 → 交互式选择 → 到期自动 resume 同一会话」的能力。

## 它解决什么问题

Codex Desktop 跑长任务时，5 小时额度或周额度耗尽，会话停在半路。人不在电脑前，任务就白等了。这个工具：

1. **扫描桌面版会话库**（只读 `~/.codex/*.sqlite`），找出**因额度停止**的会话（`thread_turns.status='failed'` + `error_json` 含 "usage limit"）
2. **区分 5 小时 / 周额度**，解析官方重置时间（`try again at 4:03 PM` / `in 4 days 20 hours`）
3. **只 resume 真停了的**：额度失败后已经成功续跑过的会话自动排除；正常结束的会话不碰
4. **交互式选择**：列出候选会话，让你勾选 resume 哪几个（或 `--all` / `--select <ids>`）
5. **到期自动 resume 同一会话**：到重置时间 + 30 秒缓冲，daemon 自动 `codex exec resume <thread-id>` 恢复**同一个会话文件**——回到桌面版 UI，点开就是完整上下文和续跑过程

## 安装

```bash
cd D:\codex-auto-resume
npm install
npm run build        # 编译 TypeScript
npm link             # 暴露 car 命令（可选）
```

依赖：Node.js ≥ 20（扫描用内置 `node:sqlite`，无需额外安装 sqlite 库）。

## 使用

```bash
# 1. 扫描桌面版被额度停止的会话
car desktop-sessions

# 2. 选择要 resume 的会话（交互式，或 --all / --select <id1,id2>）
car desktop-resume

# 3. 启动守护器（后台常驻，每分钟轮询）
car daemon start

# 4. 查看状态
car status
car jobs
car logs <job-id>
```

### 交互式选择示例

```
Found 2 session(s) stopped by a usage limit:

  [1] 对于现如今的codex领导调用claude code workers员工的任务链...
      cwd:    C:\Users\user\Documents\Codex\2026-08-29\new-chat
      limit:  usage limit | reset: 2026/8/31 16:03:00 | tokens: 165.2M
      id:     01a04e46-a694-7d61-ada7-2198fe458227

  [2] resume
      cwd:    C:\projects\demo
      limit:  usage limit | reset: 2026/8/30 23:23:00 | tokens: 23.1M
      id:     01a0474a-5a21-7612-b919-6dd3d00965c6

Which sessions should be resumed after their limit resets?
  - numbers like "1,3" or "1-3" to pick specific ones
  - "all" to pick every one
  - empty to skip all (cancel)
> 1,2
```

### 常用选项

| 命令 | 说明 |
|---|---|
| `car desktop-sessions --json` | 原始 JSON 输出（脚本用） |
| `car desktop-resume --all` | 全部额度停止的会话都调度，不问 |
| `car desktop-resume --select <id1,id2>` | 只调度指定会话 |
| `car desktop-resume --dry-run` | 只打印将调度什么，不创建 job |
| `car daemon foreground` | 前台跑 daemon（调试用） |
| `car cancel <job-id>` | 取消已调度的 job |

### 开机自启（Windows）

用任务计划程序（Task Scheduler）注册 daemon：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
```

## 工作原理

```
┌─────────────────┐   只读扫描    ┌──────────────────────────┐
│ Codex Desktop   │ ────────────▶ │ thread_turns(error_json) │
│ ~/.codex/*.sqlite │              │ threads(title,cwd,etc)  │
└─────────────────┘              └───────────┬──────────────┘
                                             │ 找出 failed + usage limit
                                             ▼
                                    ┌─────────────────┐
                                    │ 交互式选择会话   │
                                    └─────────┬───────┘
                                              │ 创建 job（waiting_rate_limit）
                                              ▼
                                    ┌─────────────────┐   每分钟轮询
                                    │ daemon          │ ──▶ 到 resetAt+30s
                                    └─────────┬───────┘
                                              │ codex exec resume <thread-id>
                                              ▼
                                    ┌─────────────────┐
                                    │ 同一会话续跑     │ ◀── 桌面版 UI 可见
                                    └─────────────────┘
```

- **额度检测**：`thread_turns.error_json` 里的 `"You've hit your usage limit ... try again at X"`（官方结构化错误，最可靠）
- **重置时间解析**：支持 `try again at 4:03 PM`（本地时间）、`in 4 days 20 hours`（相对时间，周额度）等
- **安全**：daemon 每次 resume 前检查 git 基线（`git-safety.ts`），工作区有大量未预期改动时暂停（`paused`），不盲目继续
- **失败重试**：resume 失败退避重试（30s/1m/2m/5m/15m），最多 5 次
- **只读不写**：扫描全部 `readOnly` 打开 Codex 数据库，绝不修改；resume 只通过官方 `codex exec resume` 接口

## 安全说明

- 扫描只读 Codex 数据库，不读取 `auth.json`、token、密钥
- resume 通过官方 CLI 接口，不注入键盘、不点桌面
- daemon 与 job 状态存 `%LOCALAPPDATA%\codex-auto-resume\`（权限 0600）

## 已知限制

- **桌面版正打开会话时**：该会话有 active writer 锁，resume 会失败（daemon 会退避重试；若一直失败 5 次后标记 failed）。建议人离开前**关闭桌面版或至少关掉该会话窗口**
- `codex app-server daemon` 在 Windows 不可用（Unix only），本工具走 CLI resume，不受影响
- Windows 下 codex 是 npm 包装脚本，工具会自动解析真实路径（`@openai/codex/bin/codex.js`）

## 与上游差异

- 新增 `src/desktop-sessions.ts`：扫描桌面会话库、识别额度停止、解析重置时间
- 新增 `car desktop-sessions` / `car desktop-resume` 子命令
- 新增 `src/codex-bin.ts`：Windows 下自动解析 codex 真实可执行路径
- 其余沿用上游：job 持久化、daemon 轮询、git 安全、退避重试、通知

## License

MIT（上游 codex-auto-resume 也是 MIT）
