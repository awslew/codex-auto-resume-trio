# codex-auto-resume

**Codex 无人值守续跑 + 项目总谱 + API 配额** —— 三块互补的本地工具，合在一个仓库里。

Codex 的 5 小时 / 每周额度跑满时，长任务会停在半路。这个仓库做的事就是：**认出被额度打断的会话，到重置时间自动接着跑同一个会话，并且让你随时看得见它到底有没有在跑。**

- **自动续跑**（仓库根目录，Node/TypeScript）—— 扫 Codex Desktop 会话库，认出因额度停止的会话，到期用官方 `codex exec resume` / app-server 接着跑同一个会话
- **续跑宿主**（`apps/resume-host/`，Node）—— 让续跑在后台无人值守地跑起来：常驻调度 + 只读状态页 + 系统托盘 + 开机自启
- **项目总谱**（`apps/pgm-collector/`，Python）—— 把多个 Codex 项目的进展汇成"一张乐谱"，每个项目一个声部；带 AI 现状分析与「接力」简报
- **API 配额**（`apps/quota-dashboard/`，Python）—— 托盘常驻的配额仪表盘：DeepSeek / OpenRouter / OpenCode Go / Codex 四家官方数据源

> 本仓库是「三合一」形态：早先这三块曾和另一个开源看板项目（dashi-taskboard，Apache-2.0）
> 合在一个工作区里，现已剥离——本仓库只含这三块自己的代码，不含该看板的任何文件。
> 授权与第三方归属见 [`CREDITS.md`](CREDITS.md)。

---

## 目录结构

```
codex-auto-resume/
├─ src/                      # 自动续跑核心（TypeScript，包名 resume-core，CLI: car）
├─ tests/                    # 核心测试（vitest，168 个用例）
├─ scripts/                  # 核心的 systemd / launchd / Windows 计划任务安装脚本
├─ apps/
│  ├─ resume-host/           # 续跑宿主：常驻调度 + 只读状态页 + 托盘（Node，零第三方依赖）
│  ├─ pgm-collector/         # 项目总谱：CLI + Web 看板 + 接力简报（Python + flask）
│  └─ quota-dashboard/       # API 配额仪表盘：托盘 + 本地仪表盘（Python + pystray）
├─ docs/                     # 自动续跑 V2 设计 / 执行计划 / 运维手册
```

## 快速开始

需要 **Node.js ≥ 22.5**（核心用内置 `node:sqlite`，不需要额外装 sqlite 库）与 **Python 3.11+**（两个 Python 组件）。

```bash
npm install          # 装依赖；prepare 会自动构建一次（宿主直接引用 dist/ 产物）
npm run check        # lint + 类型检查 + 构建 + 核心测试 + 宿主测试
```

> 若你跳过 `npm install`（或用了 `npm ci --ignore-scripts`），先手动跑一次 `npm run build`：
> `apps/resume-host/` 以相对路径引入仓库根的 `dist/index.js`，没有构建产物它起不来。

### 1）先看有哪些会话被额度打断了

```bash
npm run build
node bin/car.js desktop-sessions          # 扫描（只读 ~/.codex/*.sqlite）
node bin/car.js desktop-resume            # 交互式勾选要接续的会话
```

### 2）让它在后台无人值守地跑

**默认是安全模式**：不显式开启就永远只观测、零发送。确认无误后再开真实发送。

```bash
npm run status                            # 看当前状态（宿主没在跑时会退回读磁盘状态）
npm run daemon                            # 前台常驻（observe，零发送）
node apps/resume-host/bin/resume-host.mjs run --execute   # 显式开启真实发送
```

状态页：<http://127.0.0.1:5173/>（只读；显示执行模式、能力门禁、上次检测、watch 明细、项目总谱）

Windows 上可以直接双击 `apps/resume-host/start.cmd`（带 execute）或 `start-observe.cmd`（只观测），
开机自启用 `apps/resume-host/install-autostart.ps1` 注册计划任务 `resume-host`。

### 3）项目总谱 / API 配额

```bash
cd apps/pgm-collector    && pip install -r requirements.txt && pgm_dash.cmd     # 看板（默认 5100）
cd apps/quota-dashboard  && pip install -r requirements.txt
copy config.example.yaml config.yaml     # 填入自己的 key（该文件已在 .gitignore 里）
python main.py                            # 托盘 + 仪表盘（默认 8787）
```

## 它凭什么安全

续跑这件事最怕两样：**乱发消息**和**编造额度**。这个仓库的设计对这两点都是 fail-closed。

| 约束 | 行为 |
|---|---|
| 默认零发送 | `AUTO_RESUME_V2_EXECUTE` 不显式开启时，sender 是空实现，调用次数恒为 0（`observe` / `shadow` 模式） |
| 唯一调度者 | 跨进程 owner lease（TTL + PID 双条件）；两个实例同时跑时只有一个真正发送，另一个如实报 blocked |
| 额度只认结构化数据 | 5 小时窗口只由官方 app-server 的结构化响应识别（`windowDurationMins=300` 或明确的 5h id），识别不出就 UNKNOWN 且**不发送**——绝不按文案猜 |
| 冲突不回退 | 旧版 job / daemon 状态**读不到**时按"有冲突"处理（`LEGACY_STATE_UNREADABLE`），宁可阻塞也不双写 |
| 只读扫描 | 扫 `~/.codex/*.sqlite` 一律 readOnly；续跑只走官方 CLI / app-server 接口，不注入键盘、不点桌面 |
| 配额不编数字 | 配额仪表盘所有数值直接来自官方响应；解析失败 / 未配置 / 非 200 → 如实显示「官方数据源不可用」 |

## 文档

- 自动续跑 V2：[设计](docs/AUTO_RESUME_V2_DESIGN.md) · [执行计划](docs/AUTO_RESUME_V2_EXECUTION_PLAN.md) · [**运维与故障排查**](docs/AUTO_RESUME_V2_OPERATIONS.md)
- 续跑宿主：[README](apps/resume-host/README.md)
- 项目总谱：[README](apps/pgm-collector/README.md)
- API 配额：[README](apps/quota-dashboard/README.md)
- 授权与第三方归属：[CREDITS.md](CREDITS.md)

## 常见问题

**`npm run status` 说宿主没在跑？** 那说明常驻进程没起来。直接 `npm run daemon`（前台）或跑 `apps/resume-host/start.cmd`；`status` 在宿主离线时会退回读磁盘状态，不会假装健康。

**状态页显示 `blocked`，是不是坏了？** 不是。`execute-blocked` 表示门禁挡住了发送，页面右侧会逐条列出原因（旧 job 冲突、状态不可读、无可用 Codex 入口…）。这是保护机制在正常工作。

**额度一直显示 UNKNOWN？** 说明当前读不到结构化的 5 小时窗口——常见原因是 Codex 入口没解析到（状态页的「Codex 入口」会显示），或该账号当前没有 5h 窗口数据。此时不会发送任何东西。

**托盘图标看不见？** Win11 默认把新图标收进溢出区：点任务栏的 `⌃`，把图标拖到通知区。

## License

MIT —— 见 [`LICENSE`](LICENSE)。第三方组件的授权与归属见 [`CREDITS.md`](CREDITS.md)。
