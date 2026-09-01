# Auto Resume V2 — 运维与执行记录

> 本文件是 AUTO_RESUME_V2_DESIGN.md / AUTO_RESUME_V2_EXECUTION_PLAN.md 的执行状态簿，
> 记录 F1～F5（核心、服务端、生产探针与真实运行收尾）的落地状态、测试证据、
> 剩余风险与需要领导拍板的开放点。任务领导协议：设计/结论由领导亲写，本文件只记事实。

## 状态总览

- **F1 核心（已验收）**：状态机与持久化基线已验收。模块：auto-resume-reducer / auto-resume-store /
  auto-resume-monitor / resume-attempt / thread-lease / fixed-rate-scheduler / five-hour-quota /
  desktop-session-observation / auto-resume-types / app-server adapter。
- **F2 服务端阻断修复（本任务）**：见下方证据表；全部 13 项验收点落地。
- **F3～F5 生产收尾（已验收）**：修复 Desktop `app-server --stdio` 入口、quota throw 跳过整轮、
  ESM `require` 崩溃及 `SessionObservation.state` 未注入 monitor 四个真实运行缺口。
- **独立终审（已验收）**：0 blocker/major；server 34/34、monitor 30/30、Desktop observation
  28/28、相关 core 65/65，typecheck/build 通过。真实浏览器和固定 180 秒 tick 完成 V2 watch
  勾选、`COMPLETED + UNKNOWN + lastError=null` 持久化、页面展示和取消闭环；真实 5h 归零/恢复
  仍标记 `REAL_QUOTA_UNKNOWN`，execute 门禁保持关闭。
- **领导已拍板两项决策（本任务落实）**：
  - **决策A**：生产 sender 可靠等到同 thread turn/completed → `confirmed:true` 作为发送结果持久化
    （outbox 写 confirmedAt，monitor 同轮清 latch/activeAttempt/outbox，phase→MONITORING、enabled 保持 true）；
    仅"发送后进程崩溃、重启无法查询"才由 confirmer UNKNOWN → NEEDS_ATTENTION。
  - **决策B**：删除静态 `AUTO_RESUME_V2_QUOTA_WINDOW=300` 环境变量门禁；5h 窗口判定只由实际
    quotaReader 的结构化 `windowDurationMins===300` 或明确 5h id/name 判定；UNKNOWN 仍
    monitor 决策/发送前 guard fail-closed，0 发送。不得引入手工开关。
- **未做**：install / 真实发送 / commit / push。已在隔离状态目录启动真实服务并完成 shadow 验收，
  测试 watch 已取消、测试服务已停止。

## F2 证据表（任务要求 13 项）

| # | 验收点 | 落地 | 证据测试 |
|---|--------|------|----------|
| 1 | 生产默认路径完整（无 fake 注入） | auto-resume-v2.mjs 缺省构造生产 sessionReader（desktop 观测）/quotaReader/sender/confirmer；confirmer 无可靠查询路径时恒 UNKNOWN fail-closed（决策A 后正常发送不再进 NEEDS_ATTENTION，见状态总览） | 生产接线默认路径测试（production defaults） |
| 2 | effectiveSender/confirmer/outbox 活绑定 | refreshExecutionMode→rebuildMonitor 每次重建绑定；POST detect 前置 refreshCapability | 动态门禁测试 + execute 整链 |
| 3 | 生产明确 stateDir；默认 execute=0；observe 绝不 spawn | app.mjs 已用配置值/环境值（CODX 配置或 defaultStateDir），测试 mkdtemp；scheduler 仅 execute 时启动 | scheduler 测试 + 生产接线测试 |
| 4 | ownerToken 每实例唯一；启动前全局 owner lease；stop 释放；拿不到不启动（blocked） | randomUUID + owner-lease（复用 core thread-lease 原语） | 双实例并发 start 测试 |
| 5 | 每 tick/POST detect 前刷新 capability | runDetection 前置 await refreshExecutionMode() | 动态门禁测试（运行中新增 legacy job → 当轮 sender=0） |
| 6 | loadJobs/daemon 读取异常 fail-closed（LEGACY_STATE_UNREADABLE） | checkExecutionCapability catch 改 push reason；语义为"状态不可读=视为冲突" | 状态不可读 fail-closed 测试 |
| 7 | DELETE 用 clearWatchArtifacts + 同 lease；拿不到 lease 409 | DELETE handler 换 clearWatchArtifacts，false→409 | DELETE 并发测试 |
| 8 | execute 开启时旧 60s loop 不启动；observe/shadow 不改旧 runner 数据 | app.mjs listen 已按 v2Executing 分流；V2 任何模式不写 jobs | 保留（app.mjs 既有逻辑）+ 新测试覆盖 |
| 9 | API view activeAttemptId 透传；capabilityReasons/lastDetectionAt 动态刷新 | toWatchView 已含 activeAttemptId；GET 返回 capabilityReasons/lastDetectionAt 每次求值 | 既有 view 断言 + 动态刷新断言 |
| 10 | 默认生产接线测试不能只靠注入四个 fake | 新增 production-defaults 整链测试：quota/sender/confirmer 全走生产 adapter（FAKE_CODEX 伪 app-server 指认 codexBin/codexArgsPrefix），只注入受控 sessionReader；断言勾选→arming→归零锁存→恢复+会话结束→恰好 1 次 thread/resume+turn/start→CONFIRMED 收敛→下一轮 COMPLETED+POSITIVE disable；绝不 spawn 真实 Codex | production-defaults 测试（assert fake state/counts 记录） |
| 11 | 动态门禁：启动可执行→新增 legacy job/loadJobs 抛错→下一 tick sender=0 | refreshExecutionMode 前置检测 + scheduler tickNow | 动态门禁测试 |
| 12 | DELETE 并发：检测持 lease 时 DELETE 非成功；完成后 DELETE 成功且不复活 | clearWatchArtifacts 与检测同 lease 互斥 | DELETE 并发测试 |
| 13 | 双 server 共享 stateDir 并发 start 最多一个 scheduler owner | owner lease（stateDir 下全局锁文件） | 双实例测试 |

## 测试命令与计数（F2 自测基线）

```
npm run build:resume                    ✔
npm run typecheck:resume                ✔
npm --workspace apps/taskboard run typecheck  ✔
npm run lint (resume-core)              ✔
node --test apps/taskboard/test/auto-resume-v2-server.test.mjs apps/taskboard/test/auto-resume-v2-integration.test.mjs  ✔ (27+1)
npx vitest run <F1 定向 core 测试>       ✔ (98)
```

F3～F5 最终增量证据：server V2 34/34、monitor 30/30、Desktop observation 28/28、相关 core
65/65，resume-core/taskboard typecheck、resume-core build、taskboard build:web 均通过。
`adopt.test.ts` 单跑 1/1、`cli-e2e.test.ts` 单跑 3/3；core 全量最新复跑 147/148，唯一失败是
`cli-e2e` 完成产品断言后的 Windows 临时目录清理 `EBUSY`。

注意：auto-resume-v2-server.test.mjs 存在跨文件并发的 Windows 清理竞争（ENOTEMPTY/EBUSY 偶发，
如 adopt.test.ts 全量跑时 rmdir EBUSY），是测试自身清理时序问题（进程级 test runner 并行清理），
非产品缺陷；单文件运行稳定通过。

## 能力门禁语义（决策6，与 GET capability/operations 一致）

- **adapter 可用 ≠ 当前传感器已知**：capability 门禁只回答"生产 adapter 是否已接线、是否处于可
  execute 的运行态"；每次轮询/每次发送前仍以 quotaReader 的结构化结果为唯一事实来源。
- **最近 quota UNKNOWN 是运行态 fail-closed 诊断**：GET /watches 返回的 lastObservation
  （fiveHourQuota 等）与最近 detect 结果反映"当前传感器读数"；UNKNOWN 表示此刻无法结构化识别
  5h 窗口（无 300 分钟窗口、或读取失败），行为上 0 发送并保留原因，不是 adapter 未接线。
- 决策B 后无任何环境变量可绕过此 fail-closed（不再有 QUOTA_WINDOW 门禁）。

## 剩余风险（执行层视角，需领导拍板）

1. **生产 confirmer 三态**：`createAppServerConfirmer` 恒 UNKNOWN（无可靠查询路径）——
   决策A 后正常发送不再走 NEEDS_ATTENTION（sender 自带 turn/completed 证据直接 CONFIRMED 收敛）；
   仅"发送后进程崩溃、重启无法查询结果"的场景仍依赖人工确认闭环（outbox 保留 + NEEDS_ATTENTION）。
2. **owner lease 目录**：owner lease 复用 thread-lease 原语写 `stateDir/locks/owner.lease.json`，
   与 thread lease 同目录不同 key，不冲突；但两个 server 若配置不同 stateDir 则不会互斥（预期：配置一致性由部署负责）。
3. **生产 sessionReader 冷读**：shadow 真实周期已验证可读 Desktop sqlite 并得到 `COMPLETED`；
   大量 watch 下的全量采集开销与 db 锁冲突仍未做压力测试。
4. **taskboard 旧 60s loop**：app.mjs 仅在 `AUTO_RESUME_V2_EXECUTE` 开启时停旧 loop；
   shadow/observe 时旧 loop 仍会跑旧 jobs（V2 不写旧 jobs，旧 jobs 自洽），行为符合验收"旧 jobs 只阻止 V2 execute"。
5. **quotaResetAt 生产缺口（T7 审查项）**：monitor 每轮只取 quota.state，snapshot 不携带
   quotaResetAt → latch.quotaResetAt 在真实链路恒 undefined（诊断性字段，不影响状态机判定）。
6. **未覆盖**：真实发送（门禁禁止）与真实 300 分钟额度归零/恢复事件。真实服务 shadow 周期和
   taskboard 构建已覆盖。
7. **范围外噪声**：Taskboard AI 模型目录可能仍调用失效的全局 npm `codex.js debug models`；该链路
   与 V2 的 quota/session/sender 相互独立，不影响本次自动续跑验收。

## 需要领导拍板的开放点

- 生产 confirmer 是否需要接入可查询的会话库（未来工作；当前无可靠查询路径时恒 UNKNOWN 是冻结语义，
  正常发送由决策A 的 sender 自带证据收敛，不依赖它）。
- owner lease 文件位置与 TTL（当前 10 分钟 + PID 存活双条件；与 thread lease 一致）。
- quotaResetAt 透传（T7 审查项，见剩余风险 5）。
