# Codex Ops — Codex 任务运营中心

把三个互补的 Codex 项目融合成一个 monorepo：

| 目录 | 原项目 | 角色 |
|---|---|---|
| `apps/taskboard` | [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) | 任务管理看板（React UI + HTTP API + SQLite + `taskctl` CLI + Codex Skill + 注入器 + Tauri 壳） |
| `packages/resume-core` | codex-auto-resume | 额度检测 + 到点自动 `codex exec resume` 的调度核心 |
| `extensions/pgm-collector` | pgm-board | Codex 会话转录采集 + AI 摘要 + 接力简报（项目总谱） |

## 布局

```
codex-ops/
├─ apps/taskboard/          # 完整 Taskboard 产品（原 dashi-taskboard 全部代码）
├─ packages/resume-core/    # 自动续跑核心（原 codex-auto-resume，含 CLI `car`）
├─ extensions/pgm-collector/# 项目总谱（原 pgm-board，Python）
├─ package.json             # npm workspaces 聚合
└─ README.md
```

## 快速开始

```bash
npm install            # 安装全部 workspace 依赖
npm run check          # 类型检查 + 构建 + 测试（全部 workspace）
npm run build:taskboard
npm run start:taskboard   # 打开 http://127.0.0.1:47823
```

## 开机自启 + 系统托盘（Windows）

Taskboard 服务器以**计划任务 + 系统托盘**方式在后台常驻：

- **计划任务** `taskboard-server-47823`：开机（登录）自动启动，失败自动重启（3 次/1 分钟）。
  入口为 `apps/taskboard/scripts/taskboard-launcher.vbs`（wscript 隐藏窗口启动，
  不再弹黑控制台窗口）。
- **系统托盘**：`scripts/taskboard-tray.py`（pythonw + pystray）显示托盘图标，
  **左键/双击打开看板**（http://127.0.0.1:47823），右键菜单可查看服务器状态、
  **「退出」= 停止服务器并移除托盘**（taskkill 整棵进程树）。
- 链路：计划任务 → `taskboard-launcher.vbs`（隐藏窗口）→ `taskboard-launcher.mjs`
  （拉起 server + 托盘，server 崩溃自动重启）→ `server/index.mjs`（47823 端口）。

重新注册计划任务（需管理员权限）：

```powershell
schtasks /Create /TN taskboard-server-47823 /XML taskboard-task.xml /F
```

旧版独立 API 配额仪表盘（`D:\apiquota-dashboard`，注册表 `APIQuotaDashboard` 自启）
已被移除——看板自带配额 API（`/api/quota` 等），无需重复常驻。

## 各组件文档

- Taskboard：`apps/taskboard/README.md`
- Resume Core：`packages/resume-core/README.md`
- PGM Collector：`extensions/pgm-collector/README.md`
- Auto-Resume V2（taskboard 内置自动续跑调度器）：设计 `AUTO_RESUME_V2_DESIGN.md`、
  执行计划 `AUTO_RESUME_V2_EXECUTION_PLAN.md`、**运维与故障排查 `AUTO_RESUME_V2_OPERATIONS.md`
  （开关/模式/状态目录/相位语义/上线流程/已知缺口）**

## 融合路线

P0（本提交）：目录合并 + 历史保留（subtree / git mv）。后续阶段将把
resume-core 的调度嵌入 Taskboard 服务、把 pgm-collector 的采集接入看板，
形成"任务定义 → 执行 → 感知"闭环。详见方案文档。
