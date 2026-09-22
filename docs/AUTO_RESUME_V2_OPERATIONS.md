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
| 1 | 生产默认路径完整（无 fake 注入） | `apps/resume-host/src/daemon.mjs`（模块名 `createResumeDaemon`，剥离前的 auto-resume-v2.mjs）缺省构造生产 sessionReader（desktop 观测）/quotaReader/sender/confirmer；confirmer 无可靠查询路径时恒 UNKNOWN fail-closed（决策A 后正常发送不再进 NEEDS_ATTENTION，见状态总览） | 生产接线默认路径测试（production defaults） |
| 2 | effectiveSender/confirmer/outbox 活绑定 | refreshExecutionMode→rebuildMonitor 每次重建绑定；POST detect 前置 refreshCapability | 动态门禁测试 + execute 整链 |
| 3 | 生产明确 stateDir；默认 execute=0；observe 绝不 spawn | 剥离前由 taskboard app.mjs 用配置值/环境值（CODX 配置或 defaultStateDir）；宿主侧由 `apps/resume-host/bin/resume-host.mjs` 解析 `--state-dir`/`RESUME_HOST_STATE_DIR`（缺省 `defaultStateDir()`），`createResumeDaemon` 必须显式拿到 stateDir，测试 mkdtemp；宿主恒以 180 秒运行调度器、非 execute 时段只保证 sender 恒为空（"scheduler 仅 execute 时启动"是剥离前行为） | scheduler 测试 + 生产接线测试 |
| 4 | ownerToken 每实例唯一；启动前全局 owner lease；stop 释放；拿不到不启动（blocked） | randomUUID + owner-lease（复用 core thread-lease 原语） | 双实例并发 start 测试 |
| 5 | 每 tick/POST detect 前刷新 capability | runDetection 前置 await refreshExecutionMode() | 动态门禁测试（运行中新增 legacy job → 当轮 sender=0） |
| 6 | loadJobs/daemon 读取异常 fail-closed（LEGACY_STATE_UNREADABLE） | checkExecutionCapability catch 改 push reason；语义为"状态不可读=视为冲突" | 状态不可读 fail-closed 测试 |
| 7 | DELETE 用 clearWatchArtifacts + 同 lease；拿不到 lease 409 | DELETE handler 换 clearWatchArtifacts，false→409 | DELETE 并发测试 |
| 8 | execute 开启时旧 60s loop 不启动；observe/shadow 不改旧 runner 数据 | 剥离前在 taskboard app.mjs：listen 按 v2Executing 分流；该 60s loop 已随 taskboard 移除，宿主侧不存在 job tick，V2 任何模式都不写 jobs | 保留（剥离前 app.mjs 既有逻辑）+ 新测试覆盖（宿主侧见 `apps/resume-host/tests/host.test.mjs`） |
| 9 | API view activeAttemptId 透传；capabilityReasons/lastDetectionAt 动态刷新 | toWatchView 已含 activeAttemptId；GET 返回 capabilityReasons/lastDetectionAt 每次求值 | 既有 view 断言 + 动态刷新断言 |
| 10 | 默认生产接线测试不能只靠注入四个 fake | 新增 production-defaults 整链测试：quota/sender/confirmer 全走生产 adapter（FAKE_CODEX 伪 app-server 指认 codexBin/codexArgsPrefix），只注入受控 sessionReader；断言勾选→arming→归零锁存→恢复+会话结束→恰好 1 次 thread/resume+turn/start→CONFIRMED 收敛→下一轮 COMPLETED+POSITIVE disable；绝不 spawn 真实 Codex | production-defaults 测试（assert fake state/counts 记录） |
| 11 | 动态门禁：启动可执行→新增 legacy job/loadJobs 抛错→下一 tick sender=0 | refreshExecutionMode 前置检测 + scheduler tickNow | 动态门禁测试 |
| 12 | DELETE 并发：检测持 lease 时 DELETE 非成功；完成后 DELETE 成功且不复活 | clearWatchArtifacts 与检测同 lease 互斥 | DELETE 并发测试 |
| 13 | 双 server 共享 stateDir 并发 start 最多一个 scheduler owner | owner lease（stateDir 下全局锁文件） | 双实例测试 |

## 测试命令与计数（F2 自测基线）

```
npm run build                           ✔
npm run typecheck                       ✔
npm --workspace apps/taskboard run typecheck  ✔（taskboard workspace 随剥离已移除；宿主侧等价自检为 npm run check:host）
npm run lint                            ✔
node --test apps/taskboard/test/auto-resume-v2-server.test.mjs apps/taskboard/test/auto-resume-v2-integration.test.mjs  ✔ (27+1)（该用例随 taskboard 剥离已移除，宿主侧等价覆盖见 apps/resume-host/tests/host.test.mjs）
npx vitest run <F1 定向 core 测试>       ✔ (98)
```

F3～F5 最终增量证据：server V2 34/34、monitor 30/30、Desktop observation 28/28、相关 core
65/65，resume-core/taskboard typecheck、resume-core build、taskboard build:web 均通过
（taskboard 相关项随剥离移除，计数为剥离前历史记录）。
`adopt.test.ts` 单跑 1/1、`cli-e2e.test.ts` 单跑 3/3；core 全量最新复跑 147/148，唯一失败是
`cli-e2e` 完成产品断言后的 Windows 临时目录清理 `EBUSY`。

注意：auto-resume-v2-server.test.mjs 存在跨文件并发的 Windows 清理竞争（ENOTEMPTY/EBUSY 偶发，
如 adopt.test.ts 全量跑时 rmdir EBUSY），是测试自身清理时序问题（进程级 test runner 并行清理），
非产品缺陷；单文件运行稳定通过。（该用例随 taskboard 剥离已移除，宿主侧等价覆盖见 apps/resume-host/tests/host.test.mjs）

## 能力门禁语义（决策6，与 GET capability/operations 一致）

- **adapter 可用 ≠ 当前传感器已知**：capability 门禁只回答"生产 adapter 是否已接线、是否处于可
  execute 的运行态"；每次轮询/每次发送前仍以 quotaReader 的结构化结果为唯一事实来源。
- **最近 quota UNKNOWN 是运行态 fail-closed 诊断**：GET /watches 返回的 lastObservation
  （fiveHourQuota 等）与最近 detect 结果反映"当前传感器读数"；UNKNOWN 表示此刻无法结构化识别
  5h 窗口（无 300 分钟窗口、或读取失败），行为上 0 发送并保留原因，不是 adapter 未接线。
- 决策B 后无任何环境变量可绕过此 fail-closed（不再有 QUOTA_WINDOW 门禁）。

## 在 resume-host 上怎么运维

> 本节记录 taskboard 剥离后的事实（宿主 = `apps/resume-host/`，resume-core 已提到仓库根目录）。
> 上文 F1～F5 的状态、证据表与计数是剥离前的历史记录，未改动。

### 启动与停止

- 前台常驻：`node apps/resume-host/bin/resume-host.mjs run`，等价于根目录 `npm run daemon`。
- 真实发送：`apps/resume-host/start.cmd`（脚本内 `set "AUTO_RESUME_V2_EXECUTE=1"`，再调用 `node bin\resume-host.mjs run --port %RESUME_HOST_PORT% --tray`）。
- 只观测：`apps/resume-host/start-observe.cmd`（清空 `AUTO_RESUME_V2_SHADOW` 与 `AUTO_RESUME_V2_EXECUTE`，以 `run --observe` 启动，零发送）。
- 开机自启入口：`apps/resume-host/start-host.vbs`（隐藏窗口拉起 `node bin\resume-host.mjs run --tray`，并在进程环境里设 `AUTO_RESUME_V2_EXECUTE=1`，与 `start.cmd` 一致）。
- 停止：`apps/resume-host/stop.cmd` 按 `runtime/host.pid` 精确执行 `taskkill /PID <pid> /T /F`（不按镜像名批量清杀）。
- 命令行开关优先于环境变量：`--execute` / `--shadow` / `--observe`、`--port <n>`、`--state-dir <dir>`、`--tray`、`--open`。
- 宿主默认恒 observe：不设 `AUTO_RESUME_V2_EXECUTE` 时 sender 是空实现，任何轮次的发送数恒为 0。

### 查状态

- `npm run status`（= `node apps/resume-host/bin/resume-host.mjs status`；workspace 也暴露了 bin 名 `resume-host`，即 `npx resume-host status`）。
- 在线时它请求 `http://127.0.0.1:<port>/api/host/status`，打印执行模式、能力门禁与原因、owner lease 是否由本实例持有、状态目录、解析到的 Codex 入口、上次检测时间、watch 数量、上次错误、上轮 cycle 与状态页地址。
- 宿主没在跑时退回**离线只读**：直接读磁盘上的 watch 与 lease 状态，打印「宿主未在运行 + 状态目录 + watch 数」，不启动调度器、不写任何数据。
- `--json` 输出原始 JSON；默认（或 `--pretty`）是人读文本；`--strict` 在执行模式为 blocked 类或宿主离线时以退出码 2 结束。
- `npm run detect` 手动触发一次检测；`node apps/resume-host/bin/resume-host.mjs watches` 列出全部 watch。

### 状态页与只读面

- 状态页地址：`http://127.0.0.1:5173/`（端口由 `--port` 或 `RESUME_HOST_PORT` 决定，默认 5173），只监听 127.0.0.1，不做远程暴露。
- 页面每 5 秒轮询 `/api/host/status` 与 `/api/auto-resume/watches`，只做展示：没有增删 watch 的入口，唯一的「立即检测」按钮只触发一次检测（`POST /api/auto-resume/detect`），不强制发送。
- 增删 watch 走 CLI 或直接调 API：`node apps/resume-host/bin/resume-host.mjs watch add <threadId> --cwd <绝对路径>`、`watch rm <threadId>`。
- 宿主只读面：`/health`、`/api/host/status`、`/api/host/watches`、`/api/host/pgm`（项目总谱的 Node 侧只读接口，完整版含 AI 分析与接力简报在 Python 组件 `apps/pgm-collector/`）。写操作面只有守护器的 `/api/auto-resume/*`（GET/PUT/DELETE watches、detect、refresh）。
- 配额视图已不在 Node 侧：由 Python 组件 `apps/quota-dashboard/`（独立托盘程序）承担；原 `apps/taskboard/server/quota-api.mjs` 随 taskboard 移除。

### 四种执行模式

| 模式 | 出现条件 | 发送行为 |
|---|---|---|
| `execute` | `AUTO_RESUME_V2_EXECUTE` 显式开启（或 `--execute`），且本实例持有 owner lease、能力门禁全过 | 绑定生产 sender，到点会真的续跑 |
| `shadow` | `AUTO_RESUME_V2_SHADOW=1`（或 `--shadow`）且 execute 未开启 | 只记录 monitor 的决策与迁移，发送恒 0 |
| `observe` | 两个开关都不设（或 `--observe`） | 只观测，发送恒 0；宿主默认状态 |
| `execute-blocked` | execute 已开启，但未持有 owner lease 或门禁未过 | fail-closed，发送恒 0，`status` 与状态页逐条列出原因 |

- 另有一个内部取值 `blocked-no-sender`（持有 owner、能力已就绪，但没有可用发送器），同样零发送，状态页显示为「blocked · 无可用发送器」。
- `blocked` **不是故障**：门禁是动态的——每个自动 tick 与每次 `POST /api/auto-resume/detect` 之前都重新评估，冲突解除后自动回到 execute；启动时若被未过期的陈旧租约挡住（旧进程 PID 已死、租约 TTL 未到），宿主会在租约过期后自动补位重取 owner，最多等 10 分钟。
- 门禁内容：生产适配器可用；无 legacy daemon owner（`stateDir/daemon.pid` 不存在或对应进程不存活）；`stateDir/jobs` 中不存在活跃 legacy job（`created` / `waiting_rate_limit` / `running` / `resuming`）。门禁读取失败时同样 fail-closed（`LEGACY_STATE_UNREADABLE`），视为冲突，宁可阻塞也不双写。

### 开机自启的注册与卸载

- 注册（管理员 PowerShell）：`powershell -ExecutionPolicy Bypass -File apps\resume-host\install-autostart.ps1`；任务名默认 `codex-resume-host`（`-TaskName` 可改），动作是 `wscript.exe "…\start-host.vbs"`，触发器为登录时，失败重启 3 次 / 间隔 1 分钟，`MultipleInstances IgnoreNew`，执行时间不限。
- 卸载：`powershell -ExecutionPolicy Bypass -File apps\resume-host\uninstall-autostart.ps1`；只注销计划任务，不删除任何状态数据（watch / lease / jobs 都留在状态目录里）。
- 等价的 XML 注册方式：`apps/resume-host/resume-host-task.xml`（`schtasks /Create /TN codex-resume-host /XML resume-host-task.xml /F`，XML 里的 VBS 路径按本机实际位置改）。
- 验证注册结果：`Start-ScheduledTask -TaskName codex-resume-host`、`Get-ScheduledTaskInfo -TaskName codex-resume-host`。

### 从旧 taskboard 任务迁移

1. 先停用旧任务：`schtasks /Change /TN taskboard-server-47823 /DISABLE`（旧任务名与旧端口 47823 都随 taskboard 作废）。
2. 再注册新任务：`install-autostart.ps1`（任务名 `codex-resume-host`）。
3. 两个任务同时跑也不会双发：owner lease 只会放行一个实例，另一方拿不到 lease 就停在 `execute-blocked` 并如实报出原因。
4. 旧 jobs 不被新宿主删除或改写，只在能力门禁里被只读检查；存在活跃 legacy job 时 execute 被阻断。

### 怎么确认「真的在发送」

- `npm run status` 的 `执行模式` 一行显示 `execute` 并标注 `← 真实发送已开启`。
- `observe` / `shadow` / `execute-blocked` / `blocked-no-sender` 都是零发送，`status` 会把它们标成 `← 零发送`。
- 同时核对 `owner lease`（是否本实例持有）、`能力门禁`（未通过时逐条列出原因）、`上次检测`、`watch 数量` 与 `上轮 cycle … 续跑=`。
- 单个 watch 的 `resumeAttemptCount` 与相位（`RESUME_QUEUED` / `RESUME_CONFIRMING` / `NEEDS_ATTENTION`）是「已经尝试过续跑」的证据，状态页 watch 表可见。

### 环境变量与状态目录

| 变量 | 作用 |
|---|---|
| `RESUME_HOST_PORT` | 状态页端口（默认 5173） |
| `RESUME_HOST_STATE_DIR` | 状态目录（缺省 resume-core 的 `defaultStateDir()`，Windows 为 `%LOCALAPPDATA%\codex-auto-resume`）；旧名 `CODEX_TASKBOARD_SUPERVISOR_STATE_DIR` 已不存在 |
| `AUTO_RESUME_V2_EXECUTE` | 显式真值（`1`/`true`/`yes`/`on`）= 允许真实发送；不设则恒 observe（零发送） |
| `AUTO_RESUME_V2_SHADOW` | `1` = shadow（记录决策但不发送） |
| `CODEX_BIN` | 显式指定 Codex app-server 入口（可选） |
| `PYTHONW` / `PYTHON` | 托盘用的 Python 解释器（可选） |

- 宿主进程 PID 写在 `apps/resume-host/runtime/host.pid`（含 pid、port、startedAt）。
- owner lease 写在状态目录 `locks/resume-host-scheduler-owner.lease.json`，TTL 10 分钟 + PID 存活双条件；`stop.cmd` 与正常退出都会释放。

## 剩余风险（执行层视角，需领导拍板）

1. **生产 confirmer 三态**：`createAppServerConfirmer` 恒 UNKNOWN（无可靠查询路径）——
   决策A 后正常发送不再走 NEEDS_ATTENTION（sender 自带 turn/completed 证据直接 CONFIRMED 收敛）；
   仅"发送后进程崩溃、重启无法查询结果"的场景仍依赖人工确认闭环（outbox 保留 + NEEDS_ATTENTION）。
2. **owner lease 目录**：owner lease 复用 thread-lease 原语写 `stateDir/locks/resume-host-scheduler-owner.lease.json`
   （剥离前 taskboard 侧的文件名是 `owner.lease.json`），与 thread lease 同目录不同 key，不冲突；
   但两个 server 若配置不同 stateDir 则不会互斥（预期：配置一致性由部署负责）。
3. **生产 sessionReader 冷读**：shadow 真实周期已验证可读 Desktop sqlite 并得到 `COMPLETED`；
   大量 watch 下的全量采集开销与 db 锁冲突仍未做压力测试。
4. **旧 60s loop（已消解）**：原 taskboard app.mjs 的 60 秒 auto-resume job tick 随剥离移除，
   宿主侧不存在 60 秒执行循环；V2 任何模式都不写旧 jobs，旧 jobs 只在 execute 能力门禁里被只读检查
   （存在活跃 legacy job 即阻断 execute），行为符合验收"旧 jobs 只阻止 V2 execute"。
5. **quotaResetAt 生产缺口（T7 审查项）**：monitor 每轮只取 quota.state，snapshot 不携带
   quotaResetAt → latch.quotaResetAt 在真实链路恒 undefined（诊断性字段，不影响状态机判定）。
6. **未覆盖**：真实发送（门禁禁止）与真实 300 分钟额度归零/恢复事件。真实服务 shadow 周期已覆盖；
   taskboard 构建已随剥离移除。
7. **范围外噪声**：Taskboard AI 模型目录（已随 taskboard 剥离移除）可能仍调用失效的全局 npm `codex.js debug models`；该链路
   与 V2 的 quota/session/sender 相互独立，不影响本次自动续跑验收。

## 需要领导拍板的开放点

- 生产 confirmer 是否需要接入可查询的会话库（未来工作；当前无可靠查询路径时恒 UNKNOWN 是冻结语义，
  正常发送由决策A 的 sender 自带证据收敛，不依赖它）。
- owner lease 文件位置与 TTL（当前 10 分钟 + PID 存活双条件；与 thread lease 一致）。
- quotaResetAt 透传（T7 审查项，见剩余风险 5）。
