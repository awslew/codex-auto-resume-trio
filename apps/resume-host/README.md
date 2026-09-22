# resume-host · Codex 自动续跑宿主

让「到点自动续跑」这件事在后台无人值守地跑起来，并且**随时看得见它到底有没有在跑**。

宿主本身不含调度逻辑——调度语义全部在核心包 `resume-core` 里（就在仓库根目录）。
宿主负责的是**进程与可见性**：拿到唯一 owner、按 180 秒固定节奏驱动检测、
把状态暴露成一个只读页面、提供系统托盘与开机自启。

```
apps/resume-host/
├─ bin/resume-host.mjs      # CLI 入口（run / status / watches / watch add|rm / detect / tray）
├─ src/daemon.mjs           # 常驻守护器：owner lease + 固定节奏检测 + 执行模式门禁
├─ src/http-server.mjs      # 状态页服务器（守护器路由 + 宿主只读面 + 静态资源）
├─ ui/                      # 只读状态页（原生 HTML/CSS/JS，无构建步骤）
├─ scripts/tray.py          # 系统托盘（pystray + Pillow）
├─ start.cmd                # 手动启动（execute 已开启）
├─ start-observe.cmd        # 手动启动（只观测、零发送）
├─ stop.cmd                 # 按 PID 文件精确停进程树
├─ start-host.vbs           # 开机自启入口（隐藏窗口）
├─ install-autostart.ps1    # 注册计划任务 codex-resume-host
├─ uninstall-autostart.ps1  # 注销计划任务
├─ resume-host-task.xml     # 同一计划任务的 XML 形态
├─ tests/host.test.mjs      # 宿主接线测试（Node 原生 test runner，零依赖）
└─ runtime/                 # 运行时（pid 文件、托盘日志），不进版本库
```

## 快速开始

```bash
# 仓库根目录先装好依赖并构建核心
npm install && npm run build

# 前台常驻（observe：只观测，零发送）
node apps/resume-host/bin/resume-host.mjs run

# 打开 http://127.0.0.1:5173/
# 显式开启真实发送
node apps/resume-host/bin/resume-host.mjs run --execute
```

Windows 上更省事：双击 `start.cmd`（等于 `run --execute --tray`）或 `start-observe.cmd`。

## 命令

| 命令 | 作用 |
|---|---|
| `run [--port 5173] [--tray] [--execute\|--shadow\|--observe]` | 前台常驻：守护器 + 状态页（+ 托盘） |
| `status [--json\|--pretty] [--strict]` | 打一次状态；宿主没在跑时**退回读磁盘状态**，不假装健康 |
| `watches [--json]` | 列出全部 watch |
| `watch add <threadId> --cwd <绝对路径>` | 把一个会话交给宿主托管（这就是"开启续跑"） |
| `watch rm <threadId>` | 取消托管（与检测/发送共用 lease，忙时返回 409 而不是假成功） |
| `detect` | 立即触发一次检测（不强制发送） |
| `tray` | 单独拉起托盘（调试用；正常由 `run --tray` 负责） |

根目录快捷方式：`npm run daemon` / `npm run status` / `npm run detect`。

## 执行模式（状态页最显眼的那一行）

| 模式 | 什么时候出现 | 会不会真发消息 |
|---|---|---|
| `execute` | 显式开启 execute **且**本实例持有 owner lease **且**能力门禁全过 | 会 |
| `shadow` | 开了 shadow、没开 execute | 不会（只记录决策） |
| `observe` | 两个开关都没开（**默认**） | 不会 |
| `execute-blocked` | 开了 execute 但拿不到 owner、或门禁没过 | 不会，并在页面列出原因 |

`execute-blocked` 是保护机制在正常工作，不是故障：要么另一个实例正持有 owner，
要么存在旧版 job / daemon 冲突，要么状态目录读不出来（`LEGACY_STATE_UNREADABLE`，
按"有冲突"处理）。门禁**每次 tick 前都重新评估**，冲突解除后自动恢复，不用重启。

## 安全边界

- **默认零发送**：`AUTO_RESUME_V2_EXECUTE` 不显式开启时 sender 是空实现，调用次数恒为 0
- **唯一调度者**：跨进程 owner lease（`stateDir/locks/` 下的固定 key，TTL + PID 双条件）。
  两个实例共享 stateDir 时最多一个真正发送，另一个如实报 blocked
- **fail-closed**：额度识别不出 5 小时窗口 → UNKNOWN → 不发送；状态读不出来 → 当作冲突 → 不发送
- **只读 HTTP 面**：只监听 `127.0.0.1`，页面本身不提供写操作；增删 watch 走 CLI 或 `/api/auto-resume/*`
- **不碰真实数据**：测试全部用 mkdtemp 临时目录 + 注入的 fake 适配器

## 状态页接口

| 端点 | 提供方 | 说明 |
|---|---|---|
| `GET /health` | 宿主 | 存活探测（托盘与 launcher 用它判断宿主是否还在） |
| `GET /api/host/status` | 宿主 | 执行模式、能力门禁、owner 状态、上次检测、Codex 入口 |
| `GET /api/host/watches` | 宿主 | watch 明细 |
| `GET /api/host/pgm` | 宿主 | 「项目总谱」轻量只读视图（读 `~/.codex` 转录） |
| `GET /api/auto-resume/watches` | 守护器 | watch 列表 + 执行模式（状态页轮询用） |
| `PUT/DELETE /api/auto-resume/watches/:threadId` | 守护器 | 增删 watch |
| `POST /api/auto-resume/detect` | 守护器 | 立即检测 |
| `POST /api/auto-resume/refresh` | 守护器 | 重新评估能力门禁 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RESUME_HOST_PORT` | `5173` | 状态页端口（`--port` 优先） |
| `RESUME_HOST_STATE_DIR` | 核心的 `defaultStateDir()`（Windows 为 `%LOCALAPPDATA%\codex-auto-resume`） | 状态目录：watch / lease / attempts / jobs |
| `AUTO_RESUME_V2_EXECUTE` | 未设（= 零发送） | `1`/`true`/`yes`/`on` 才允许真实发送 |
| `AUTO_RESUME_V2_SHADOW` | 未设 | 开 shadow：记录决策但不发送 |
| `CODEX_BIN` | 自动解析 | 显式指定 Codex app-server 入口 |
| `PYTHONW` / `PYTHON` | 自动查找 | 托盘用哪个解释器 |

## 开机自启（Windows）

```powershell
# 管理员 PowerShell
powershell -ExecutionPolicy Bypass -File install-autostart.ps1      # 注册任务 codex-resume-host
powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1   # 注销（不删状态数据）
```

或直接用 XML：`schtasks /Create /TN codex-resume-host /XML resume-host-task.xml /F`
（XML 里的路径按你本机实际位置改）。

链路：计划任务 → `start-host.vbs`（隐藏窗口，内部置 `AUTO_RESUME_V2_EXECUTE=1`）
→ `node bin/resume-host.mjs run --tray` → 状态页 + 托盘。

> **从旧看板任务迁移**：先停用旧任务（`schtasks /Change /TN taskboard-server-47823 /DISABLE`）
> 再注册新任务。两者同时跑不会互相破坏——owner lease 只会放行一个，另一方在状态页如实报
> `execute-blocked`——但没必要留两个。

## 测试

```bash
node --test apps/resume-host/tests/*.test.mjs    # 或根目录 npm run check:host
```

覆盖宿主自己接线的那一层：执行开关解析、observe/shadow 零发送、owner lease 互斥、
能力门禁 fail-closed、watch 全生命周期、HTTP 路由分工与 404/405。
V2 状态机本身（归零锁存、幂等续跑、发送前额度复核…）由核心的 vitest 套件覆盖，这里不重复。
