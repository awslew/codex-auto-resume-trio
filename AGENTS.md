# AGENTS.md

面向在此仓库工作的 coding agent。**只写"看代码不容易知道"的约束**。
项目介绍与快速开始见 [README.md](./README.md)，运维细节见
[docs/AUTO_RESUME_V2_OPERATIONS.md](./docs/AUTO_RESUME_V2_OPERATIONS.md)。

## 这是什么

**三合一**的本地工具仓库：Codex 无人值守续跑（根目录 Node/TS，CLI `car`）+
续跑宿主（`apps/resume-host/`）+ 项目总谱（`apps/pgm-collector/`，Python）
+ API 配额仪表盘（`apps/quota-dashboard/`，Python）。

**改代码前必须理解的机制**：

1. **宿主不自带调度语义**。调度全部在仓库根的 `resume-core`（`src/`）里；`apps/resume-host/`
   只负责进程与可见性（唯一 owner、180 秒固定节奏驱动检测、只读状态页、托盘、开机自启）。
2. **宿主以相对路径 `import` 仓库根的 `dist/index.js`**（见
   `apps/resume-host/bin/resume-host.mjs`）。**没有构建产物宿主起不来**——改完核心必须先
   `npm run build`。`npm install` 的 `prepare` 会自动构建一次；用 `npm ci --ignore-scripts` 就要手动补。
3. **执行模式是四态，不是布尔**：`execute` / `shadow` / `observe` / `execute-blocked`
   （另有内部值 `blocked-no-sender`）。`execute` 需要三件事同时成立：显式开启 execute
   **且**本实例持有 owner lease **且**能力门禁全过。门禁**每个 tick 前重新评估**，
   不要改成"启动时评估一次"。
4. **owner lease 是 TTL + PID 双条件**（`stateDir/locks/resume-host-scheduler-owner.lease.json`，
   复用核心的 thread-lease 原语）。只改 TTL 或只判 PID 都会破坏互斥语义。
5. **fail-closed 贯穿全仓**：额度识别不出 5h 窗口 → UNKNOWN → 不发送；legacy job/daemon
   状态**读不出来** → 按"有冲突"处理（`LEGACY_STATE_UNREADABLE`）→ 不发送。宁可阻塞也不双写。
6. **续跑只走官方接口**：`codex exec resume` / app-server。扫 `~/.codex/*.sqlite` 一律 readOnly，
   不注入键盘、不点桌面、不改会话库。
7. **配额仪表盘的数值必须直接来自官方响应**：解析失败 / 未配置 / 非 200 → 显示
   「官方数据源不可用」。**绝不硬编码、绝不编数字、绝不用本地端口或代理日志推算**。
   `~/.codex/auth.json` 只读，绝不写回。

## 常用命令

全部核实自 `package.json` 的 `scripts`、`src/cli.ts` 与
`apps/resume-host/bin/resume-host.mjs`（Node ≥ 22.5，Python 3.11+）：

```bash
npm run build            # tsc -p tsconfig.json（宿主依赖它的产物）
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npm test                 # vitest run（核心套件）
npm run check            # lint + typecheck + build + vitest + check:host
npm run check:host       # node --test apps/resume-host/tests/*.test.mjs
npm run check:python     # python -m compileall apps/pgm-collector apps/quota-dashboard
npm run check:all        # check + check:python

npm run status           # 宿主状态（离线时退回读磁盘状态，退出码 2 仅 --strict）
npm run daemon           # 前台常驻（observe，零发送）
npm run detect           # 立即触发一次检测

node bin/car.js desktop-sessions [--json]
node bin/car.js desktop-resume [--all|--select <ids>|--dry-run]
node bin/car.js run | adopt --cwd <dir> | jobs | logs | cancel
node bin/car.js daemon start|stop|foreground|doctor
```

`npm run check:python` 走 PATH 上的 `python`；若本机 `python` 不可用，等价命令是
`py -3.11 -m compileall apps/pgm-collector apps/quota-dashboard`。

## 改动纪律

**高风险区（改前先想清楚并补测试）**

- 状态机与 reducer 的判定优先级（`src/auto-resume-reducer.ts`、`src/five-hour-quota.ts`）：
  「归零锁存」「幂等续跑」「发送前额度复核」全靠它；顺序被改会静默改变发送行为。
- **额度识别只认结构化数据**：`windowDurationMins=300` 或明确的 5h id 才算 5 小时窗口。
  不要加"按文案 / 时间戳猜测"的兜底——猜错就是真的乱发消息。
- **默认零发送不可回退**：不设 `AUTO_RESUME_V2_EXECUTE` 时 sender 必须是空实现，调用次数恒为 0。
  别为了"方便调试"把它改成默认 execute。
- **`LEGACY_STATE_UNREADABLE` 走阻塞分支**：读不到旧状态时**不能**当作"没有旧状态"继续。
- **owner lease**：拿不到就**不启动** scheduler（不是降级运行）。启动时被未过期陈旧租约挡住时，
  现有实现在租约 TTL 过后自动补位重取（最多 10 分钟）——别把这段"延迟补位"当成多余的复杂度删掉。
- **只读 HTTP 面**：状态页没有写操作入口；写操作只有守护器的 `/api/auto-resume/*`
  （GET/PUT/DELETE watches、detect、refresh）。别把删 watch 之类的动作加进页面。
- **测试只用临时目录 + 注入的假适配器**（mkdtemp + fake adapter），不碰真实状态目录与真实会话库。
- **Python 两个组件都保持"目录自包含、零绝对路径"**：整个目录拷走就能跑，
  `apps/quota-dashboard/` 的配置默认基于 `__file__` 解析。
- **端口约定**：宿主 `5173`、项目总谱看板 `5100` / 托盘 `5101`、配额仪表盘 `8787`。
  改默认端口要同步 README 与本文件。
- **Windows 上停进程只按 PID**：`apps/resume-host/stop.cmd` 读 `runtime/host.pid` 后
  `taskkill /PID <pid> /T /F`；pgm-collector 的 `stop.cmd` 按端口查 PID 精确停。
  **绝不允许按镜像名批量清杀**——本机同时跑着其它关键进程。

**已知取舍：不要"修"**

- `execute-blocked` / `blocked-no-sender` **是保护机制在正常工作**，不是故障。
- 两个实例配置**不同的** stateDir 时不会互斥——这是"配置一致性由部署负责"的有意边界。
- 生产 confirmer 恒 UNKNOWN（没有可靠的查询路径）；「发送后崩溃、重启查不到结果」的场景
  故意保留人工确认闭环（outbox + `NEEDS_ATTENTION`）。
- 核心 vitest 套件在 Windows 上有临时目录清理竞争（`EBUSY` / `ENOTEMPTY` 偶发），
  是测试自身清理时序问题（进程级 runner 并行清理），**不是产品缺陷**；
  单文件运行稳定通过。不要为了"让全量绿"去放宽产品断言。
- 托盘图标"看不见"通常只是 Win11 把新图标收进溢出区，不是 bug。
- 本项目是 **unofficial**，不隶属 OpenAI；别在文档里写成官方工具。

**历史边界（重要）**

本仓库早先曾与开源看板项目 `dashi-taskboard`（Apache-2.0）合在同一工作区，该看板已被
**整体移除**，`apps/resume-host/` 是按本仓库自己的需求**重新实现**的。
因此：**不要把看板代码、旧 workspace（如 `apps/taskboard/`）、旧任务名
`taskboard-server-47823`、旧端口 `47823` 搬回来**，也不要重新引入 Apache-2.0 的保留声明义务。
`docs/AUTO_RESUME_V2_OPERATIONS.md` 里 F1～F5 的历史计数是剥离前的记录，**不要"顺手修正"**。

## 目录 / 模块速览

| 路径 | 职责 |
|---|---|
| `src/cli.ts` | `car` CLI 的命令定义（run/adopt/status/desktop-*/jobs/logs/cancel/daemon） |
| `src/auto-resume-reducer.ts` · `src/auto-resume-store.ts` · `src/auto-resume-types.ts` | 续跑 V2 状态机 / 持久化 / 类型契约 |
| `src/auto-resume-monitor.ts` | 周期检测：读额度 + 读会话 → 产出决策 |
| `src/five-hour-quota.ts` · `src/rate-limit.ts` · `src/reset-time.ts` | 5 小时额度结构化识别与重置时间 |
| `src/app-server/` | Codex app-server 客户端、协议、适配器、supervisor |
| `src/desktop-sessions.ts` · `src/desktop-session-observation.ts` | 只读扫描 Desktop 会话库、识别被额度打断的会话 |
| `src/thread-lease.ts` · `src/lock.ts` | 跨进程 lease / 锁原语（owner lease 复用它） |
| `src/resume-attempt.ts` · `src/supervisor.ts` · `src/fixed-rate-scheduler.ts` | 幂等续跑尝试、守护器、固定节奏调度 |
| `src/codex-bin.ts` · `src/codex-cli.ts` | 解析 Codex 真实入口（避开已卸载模块的包装脚本残留） |
| `src/transcript.ts` · `src/pgm-score.ts` | 会话转录读取与「项目总谱」聚合（Node 侧同源只读实现） |
| `src/notifier.ts` · `src/jsonl.ts` · `src/paths.ts` · `src/store.ts` | 通知、JSONL 读写、路径解析、通用存储 |
| `apps/resume-host/src/daemon.mjs` | 常驻守护器：owner lease + 固定节奏检测 + 执行模式门禁 |
| `apps/resume-host/src/http-server.mjs` · `ui/` | 只读状态页服务器与原生前端（无构建步骤） |
| `apps/resume-host/scripts/tray.py` | 宿主托盘（pystray） |
| `apps/pgm-collector/` | `pgm.py`（CLI，纯标准库）、`pgm_dash.py`（flask 看板）、`pgm_tray.py`、`pgm_handoff.py`（接力简报） |
| `apps/quota-dashboard/` | `main.py` 入口、`config.py`、`scheduler.py`、`providers/`（四家数据源）、`dashboard_ui/`（本地 HTTP + 托盘） |
| `docs/` | V2 设计 / 执行计划 / **运维手册** |
| `scripts/` | systemd / launchd / Windows 计划任务安装脚本、`privacy-audit.py` |
| `tests/` | 核心 vitest 套件；`apps/resume-host/tests/` 是宿主接线测试（node:test，零依赖） |

## 不要做的事

- **不要按镜像名批量杀进程**（`taskkill /IM node.exe` / `/IM python.exe` 会一锅端掉宿主机、
  Codex、路由器、其它 agent 进程）。只按精确 PID，且先确认 PID 身份。
- 不要提交 `config.yaml` / `config.yaml.bak` / `apps/quota-dashboard/config.yaml` /
  cookie / key / 日志（`*.log`、`*.err`、`run.log`、`dashboard.log` 已在 `.gitignore`）。
- 不要删除 `CREDITS.md`、`LICENSE`、`apps/quota-dashboard/LICENSE` 里的第三方归属行
  （上游 `LUCIENIN/codex-auto-resume` 与 `steipete/CodexBar` 的 MIT 声明必须保留）。
- 不要把 Python 组件"顺手"重写成 Node，或把 Node 组件改成 Python：两者的可独立运行是设计要求。
- 不要为了"让状态好看"而伪造额度、伪造执行模式或让 `status` 在宿主离线时假装健康。
- 不要往 README / `llms.txt` / `AGENTS.md` 里写没在代码或 `package.json` 里核实过的命令、端口或路径。
- 不要执行 `git` 历史改写/强推类操作（归属与许可声明都在历史里）。
