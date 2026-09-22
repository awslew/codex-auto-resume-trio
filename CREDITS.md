# 授权与第三方归属（CREDITS）

本仓库以 **MIT** 授权发布，见 [`LICENSE`](LICENSE)。

下面列出**第三方来源与本仓库的关系**。写清楚是为了两件事：尊重上游作者，以及让使用者
不必猜哪段代码是谁的。

## 一、上游谱系

### `codex-auto-resume` 核心（`src/`、`tests/`、`scripts/`、`bin/car.js`）

最早的版本基于开源项目 **[LUCIENIN/codex-auto-resume](https://github.com/LUCIENIN/codex-auto-resume)**（MIT）。

本仓库在该项目基础上继续开发，新增了：

- `src/desktop-sessions.ts` / `src/desktop-session-observation.ts` —— 只读扫描 Codex Desktop 会话库，
  识别"因额度停止"的会话并解析官方重置时间
- `src/codex-bin.ts` —— Windows 下解析 Codex 真实可执行入口（避开已卸载模块的包装脚本残留）
- `src/transcript.ts`、`src/pgm-score.ts` —— 会话转录读取与"项目总谱"聚合
- `car desktop-sessions` / `desktop-resume` 子命令
- Auto-Resume V2 整套无人值守调度（`auto-resume-*.ts`、`resume-attempt.ts`、`thread-lease.ts`、
  `five-hour-quota.ts`、`fixed-rate-scheduler.ts`、`app-server/`）

上游代码的 MIT 授权与版权声明保留在 `LICENSE` 中。

### API 配额（`apps/quota-dashboard/`）

原作者自己的独立项目（MIT），现已并入本仓库。

其中 Codex 配额的读取方案**复刻自**开源项目
**[steipete/CodexBar](https://github.com/steipete/CodexBar)** 的 `CodexOAuthUsageFetcher`
（MIT，Copyright (c) 2026 Peter Steinberger）——该做法只向 `chatgpt.com` 官方域名发送 token，
本项目沿用同样的做法。详见 `apps/quota-dashboard/providers/codex.py` 头部注释与该组件的
`LICENSE` 末尾归属行。

### 项目总谱（`apps/pgm-collector/`）

本仓库自己的代码（Python）。Node 侧的同源只读实现 `src/pgm-score.ts` 是同一套状态语义的
TypeScript 移植，两者读同一份 `~/.codex` 转录。

## 二、明确**不包含**的第三方代码

本仓库早先曾与开源看板项目 **[chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)**
（Apache License 2.0）合在同一个工作区里。出于"三块内容独立成项目"的目的，该看板已被**整体移除**：

- 本仓库不含该项目的任何文件，也不含其衍生的修改片段
- 当时的宿主接线（HTTP 路由分发、前端视图）没有搬过来——`apps/resume-host/`
  是照着本仓库自己的需求**重新实现**的，只保留了被验证过的调度语义
- 因此本仓库**不继承** Apache-2.0 的保留声明与变更说明义务

如果你要找那个看板，请直接去它的上游仓库。

## 三、运行时依赖

本仓库不 vendor 任何第三方依赖，全部由包管理器安装：

| 组件 | 依赖 |
|---|---|
| 核心 / 宿主 | `commander`（核心 CLI）；宿主只用 Node 内置模块 |
| 项目总谱 | `flask`、`pystray`、`Pillow`（CLI 为纯标准库） |
| API 配额 | `requests`、`PyYAML`、`pystray`、`Pillow` |
