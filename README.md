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

## 各组件文档

- Taskboard：`apps/taskboard/README.md`
- Resume Core：`packages/resume-core/README.md`
- PGM Collector：`extensions/pgm-collector/README.md`

## 融合路线

P0（本提交）：目录合并 + 历史保留（subtree / git mv）。后续阶段将把
resume-core 的调度嵌入 Taskboard 服务、把 pgm-collector 的采集接入看板，
形成"任务定义 → 执行 → 感知"闭环。详见方案文档。
