# 自动续跑 V2 可落地执行方案

> 依据：[AUTO_RESUME_V2_DESIGN.md](./AUTO_RESUME_V2_DESIGN.md)  
> 实施分支：`codex/auto-resume-v2`  
> 执行原则：状态机契约先行；员工只实现既定合同；不改写现有 jobs、不提交、不推送、不部署。  
> 计划状态：实施与独立复审完成；`CODE_PASS`、`UI_PASS`，真实额度恢复证据待外部窗口（`REAL_QUOTA_UNKNOWN`）

## 1. 最终交付物

本轮实施必须产生以下可验收结果：

1. 以 `threadId` 为唯一身份的持久化 `AutoResumeWatch`。
2. 每 180 秒一次、不可重入的检测循环。
3. 只识别明确的 300 分钟额度窗口；缺失或通用 usage-limit 文案统一为 `UNKNOWN`。
4. `RUNNING + POSITIVE` 严格零副作用。
5. `COMPLETED + POSITIVE` 自动取消 watch。
6. 上一可信检测为 `RUNNING + POSITIVE`，随后出现 `ZERO` 时锁存，不受当前标签先后顺序影响。
7. 额度恢复后，按 `threadId + latchId` 最多发送一次续跑。
8. 服务端 watch API、前端勾选与状态展示。
9. 旧 job 数据零迁移、零删除；V2 执行开启前有 legacy runner 冲突门禁。
10. AR-01～AR-20 自动化证据、真实浏览器证据、影子运行证据和剩余未知项。

## 2. 不在本轮范围

- 不自动删除、取消或改写 `%LOCALAPPDATA%\codex-auto-resume\jobs\`。
- 不把历史 job 自动转换为 watch。
- 不修复与 V2 无关的 taskboard 全量测试故障。
- 不使用通用错误文案猜测 5 小时额度。
- 不执行 commit、push、发布、部署、依赖升级或全局配置修改。
- 不宣称真实额度通过，除非取得真实 300 分钟窗口响应与受控归零证据。

## 3. 已知基线与归因纪律

实施前基线：

- `npm run typecheck:resume`：通过。
- `npm run build:resume`：通过。
- `npm --workspace apps/taskboard run typecheck`：通过。
- `npm run test:resume`：存在 2 个 Windows `EBUSY` 基线失败，来源是 app-server 子进程 kill 后未等待退出。
- taskboard `node --test`：存在 3 个基线失败，其中 2 个为 `EBUSY`，1 个为测试读取本机 23 个项目而非隔离状态。

验收时必须分成：

- `V2_TARGETED_PASS`：V2 定向测试通过。
- `BASELINE_KNOWN_FAILURE`：变更前已经存在且错误签名一致。
- `REGRESSION`：新增失败或既有失败签名变化。
- `REAL_QUOTA_UNKNOWN`：没有真实 5 小时额度证据。

任何员工不得通过删除测试、放宽断言、吞异常或增加无界重试把红灯改绿。

## 4. 技术合同冻结

### 4.1 状态合同

```ts
type SessionState = "RUNNING" | "COMPLETED" | "STOPPED" | "UNKNOWN";
type FiveHourQuotaState = "POSITIVE" | "ZERO" | "UNKNOWN";
type WatchPhase =
  | "MONITORING"
  | "WAITING_FOR_5H_QUOTA"
  | "RESUME_QUEUED"
  | "RESUME_CONFIRMING"
  | "NEEDS_ATTENTION"
  | "DISABLED";
```

`armedByDetection` 只由可信的 `RUNNING + POSITIVE` 建立，持久化有效期 7 分钟。`interruptionLatch` 创建后，completed/stopped 标签不得清除。

### 4.2 reducer 判定顺序

1. 用户取消 → `DISABLED`。
2. 输入不可信 → 只记 observation，不迁移。
3. 已有 latch → 走锁存分支。
4. 有效 arming + 当前 quota ZERO → 创建 latch。
5. 无 latch 的 RUNNING + POSITIVE → 只观察。
6. 无 latch 的 COMPLETED + POSITIVE → 取消 watch。
7. 其他组合 → 无动作。

### 4.3 执行合同

- 续跑只允许 `COMPLETED/STOPPED + POSITIVE + latch`。
- `resumeAttemptId = sha256(threadId + latch.id)`。
- 创建 attempt、写 `activeAttemptId`、phase 进入 queued 必须在同一 thread 锁临界区。
- 收到新 turn id 或晚于 attempt 创建时间的 RUNNING 证据才算确认成功。
- 技术失败最多 2 次；明确额度失败不计技术失败。

### 4.4 调度合同

- `AUTO_RESUME_DETECTION_INTERVAL_MS = 180_000`。
- 启动时立即一次，随后 fixed-rate 180 秒。
- 上轮未结束则记录 `SKIPPED_OVERLAP`，不并发、不补跑。
- 每轮额度只读取一次，所有 watch 使用同一个 `cycleId` 快照。
- 额度读取失败时整轮不迁移；单会话读取失败不阻塞其他会话。

## 5. 任务依赖图

```text
T0 分支与基线
  └─ T1 核心契约、额度识别、reducer
       ├─ T2 watch 存储、thread lease、attempt、monitor
       └─ T3 会话可信观测与异常时间戳
             └─ T4 服务端 API、唯一 scheduler、legacy 冲突门禁
                   └─ T5 前端勾选与状态展示
                         └─ T6 集成测试、影子模式、文档
                               └─ T7 独立审查与窄修复
```

T2 与 T3 在 T1 验收后可齐发；两者源文件不重叠、不得运行 build，只能运行各自定向测试与 noEmit typecheck。其他任务串行。

## 6. 文件所有权总表

| 任务 | 唯一写入范围 |
|---|---|
| T0 | Git 分支状态；不改文件 |
| T1 | `auto-resume-types.ts`、`auto-resume-reducer.ts`、`five-hour-quota.ts`、`constants.ts`、`types.ts`、`index.ts`、对应测试与 quota fixture |
| T2 | `auto-resume-store.ts`、`auto-resume-monitor.ts`、`resume-attempt.ts`、必要的新 `thread-lease.ts`、`paths.ts`、对应测试 |
| T3 | `desktop-sessions.ts`、对应 observation 测试/fixtures |
| T4 | `apps/taskboard/server/supervisor-api.mjs`、必要的 `app.mjs` 接线、服务端 V2 测试 |
| T5 | `apps/taskboard/web/src/api.ts`、`SupervisorView.tsx`、该组件相关样式/测试 |
| T6 | V2 集成测试、影子运行脚本/fixture、README/运行说明；不得重写生产逻辑 |
| T7 | 默认只读；修复时必须先声明精确文件并复用原任务会话 |

`AUTO_RESUME_V2_DESIGN.md`、本计划和 `tmp-probe-limits.mjs` 均为用户工作，所有员工禁止覆盖或删除。

## 7. 逐任务执行合同

### T0：分支与基线冻结

目标：从当前 HEAD 建立 `codex/auto-resume-v2`，保留所有未跟踪文件，记录基线而不修复。

允许动作：

- `git status --short --branch`
- `git switch -c codex/auto-resume-v2`
- 运行只读/noEmit/测试基线命令

禁止：commit、stash、clean、reset、checkout 文件、修改源码。

验收：

- 当前分支为 `codex/auto-resume-v2`。
- `AUTO_RESUME_V2_DESIGN.md`、`AUTO_RESUME_V2_EXECUTION_PLAN.md`、`tmp-probe-limits.mjs` 均存在且内容未变。
- 回传精确基线状态和已知失败签名。

### T1：核心状态机与 5 小时额度识别

目标：实现纯类型、纯 reducer 和明确的 300 分钟额度规范化，不接 RPC、不写盘、不接 UI。

必须实现：

- `AutoResumeWatch`、`DetectionSnapshot`、`TransitionDecision`、attempt 类型。
- reducer 纯函数，副作用以 command 列表返回。
- `windowDurationMins===300` 或明确 limit id/name 的窗口识别。
- `usedPercent>=100 => ZERO`，`<100 => POSITIVE`；窗口不明/字段缺失 => UNKNOWN。
- AR-01～AR-11 的表驱动测试。
- 新模块从 `index.ts` 导出。

禁止：读取真实 `%LOCALAPPDATA%`、spawn Codex、修改 taskboard。

验证：

```powershell
npm run typecheck:resume
npx vitest run packages/resume-core/tests/auto-resume-reducer.test.ts packages/resume-core/tests/five-hour-quota.test.ts
npm --workspace packages/resume-core run lint
```

完成门槛：running+positive 的 commands 严格为空；三种归零序列全部进入同一 latch phase；UNKNOWN 不产生 enable/disable/resume command。

### T2：持久化、thread lease、幂等 attempt 与 monitor

依赖：T1 通过。

必须实现：

- `watchesDir()` 与 schemaVersion=2 原子存储。
- 按 threadId 的 owner token + PID + leaseUntil 锁；仅 PID 不存在且 lease 过期才回收。
- attempt outbox 与幂等恢复。
- 一轮共享 quota snapshot、逐 watch 决策、每轮最多并发 2 个 resume。
- fixed-rate scheduler 逻辑与 overlap skip；scheduler 必须可注入 clock/timer/reader/sender。
- AR-12～AR-15、AR-17、AR-18、AR-20 定向测试。

禁止：修改旧 jobs；真实发送 Codex；修改 server/UI；运行 emit build。

验证：

```powershell
npm run typecheck:resume
npx vitest run packages/resume-core/tests/auto-resume-store.test.ts packages/resume-core/tests/auto-resume-monitor.test.ts packages/resume-core/tests/resume-attempt.test.ts
```

### T3：可信会话观测

依赖：T1 通过，可与 T2 齐发。

必须实现：

- 输出 `SessionObservation`，保持原 `DesktopSession` 公共结构兼容。
- 明确 inProgress => RUNNING，正常 completed => COMPLETED，可信 failed/interrupted terminal => STOPPED。
- 冲突、缺失、异常未来时间戳 => UNKNOWN/UNTRUSTED。
- 通用 usage-limit 只作为诊断，不创建 5h 证据。
- AR-16、AR-19 观测侧测试。

禁止：修改 reducer/monitor/server/UI；不读取真实用户数据库做写操作。

验证：

```powershell
npm run typecheck:resume
npx vitest run packages/resume-core/tests/desktop-session-observation.test.ts
```

### T4：服务端 API、唯一调度 owner 与冲突门禁

依赖：T2、T3 均通过。

必须实现：

- `GET/PUT/DELETE /api/auto-resume/watches`。
- `POST /api/auto-resume/detect` 只触发检测，不强制续跑。
- stateDir、quota reader、session reader、sender、clock 均可注入，测试不得访问本机真实状态。
- taskboard 启动立即 detect，之后 180 秒 fixed-rate；进程内不可重入。
- `AUTO_RESUME_V2_EXECUTE` 默认关闭；未识别 300 分钟窗口、检测到 legacy daemon owner 或配置冲突时拒绝执行发送。
- V2 execute 开启时，taskboard 旧 60 秒 auto-resume job tick 不再承担新勾选会话的执行；旧 jobs 仍只读可见且不被删除。

禁止：自动取消旧 jobs；修改前端；使用真实 `%LOCALAPPDATA%` 测试。

验证：

```powershell
npm run build:resume
node --test apps/taskboard/test/auto-resume-v2-server.test.mjs
npm --workspace apps/taskboard run typecheck
```

### T5：前端勾选与状态展示

依赖：T4 API 合同通过。

必须实现：

- 勾选调用 watch PUT，取消调用 DELETE，不再为新勾选创建 legacy job。
- 页面只展示服务端 phase，不本地推导状态迁移。
- 展示上次检测、5 小时剩余/UNKNOWN 原因、中断证据时间和 execute/shadow 能力状态。
- 15 秒刷新仍只读，不触发 detect/resume。
- 旧 jobs 作为 legacy 区域只读展示/保留原人工取消能力。

禁止：修改服务端；把 UNKNOWN 显示成 0%；前端直接调用 resume。

验证：

```powershell
npm --workspace apps/taskboard run typecheck
npx vitest run apps/taskboard/web/src/components/SupervisorView.test.tsx --environment jsdom
```

### T6：集成、影子运行与操作说明

依赖：T5 通过。

必须完成：

- fake app-server 增加 5h、周、缺失、额度恢复、重复发送计数模式。
- AR-01～AR-20 汇总回放。
- shadow 模式至少 2 个 fake-clock 检测周期，证明只记录不发送。
- 记录 full gate；将已知基线失败与回归分离。
- 补充环境变量、启动/关闭、数据目录、故障标签和回滚说明。

验证：

```powershell
npm run typecheck:resume
npm run build:resume
npm run test:resume
npm --workspace packages/resume-core run lint
npm --workspace apps/taskboard run typecheck
npm --workspace apps/taskboard run test
npm run build:taskboard
```

若 build 会刷新正在运行的 taskboard，员工不得自行执行，需报告并由领导决定安全窗口。

### T7：独立审查与窄修复

审查重点：

- running+positive 是否存在任何发送或写会话副作用。
- completed+positive 与 latched completed+positive 的优先级是否相反。
- arming、latch、attempt 是否都跨进程持久化。
- 两个 scheduler、重复 tick、发送后崩溃是否会双发。
- 周额度/UNKNOWN 是否会误判 5h ZERO。
- UI 是否仍暗中使用 legacy job 作为勾选真相。

发现问题后只允许回到对应原任务会话做最多 2 轮窄修复；跨文件边界必须先更新本计划所有权。

## 8. 派单与验收记录

| 任务 | 依赖 | 状态 | 员工 jobId | 验收 |
|---|---|---|---|---|
| T0 | 无 | 已验收 | `d5c81057-cd9e-46a7-81bd-9f726c30a9e4` | 分支/基线通过；1 个既有 EBUSY |
| T1 | T0 | 已验收 | `a7902890…` → `125313ed-da8a-468d-b05a-88617d659feb` | 30 tests；3阻断已修复 |
| T2 | T1 | 已验收 | `c21cdaa9…`；审查 `d478a494…`；修复 `86cc1945-defd-4ae7-94c5-d3b67e1b84c7` | 51 tests；confirm三态/失败封顶 |
| T3 | T1 | 已验收 | `833d793f…` → `30820da9-2a97-487b-ae3c-a14ad229a338` | 27 tests；越界已清理 |
| T4 | T2+T3 | 已验收 | `81c555ee-5739-4e62-8625-e1d856aabcda` | 21 server + 100 core tests |
| T5 | T4 | 已验收 | Luna `/root/t5_frontend` | 8 component tests |
| T6 | T5 | 已验收 | `fbd8aaca…` → `c3779b89-d3f6-4b24-a887-afda9fa080ca` | 集成、shadow、运维说明完成；生产接线缺口由 F1/F2 窄修复关闭 |
| T7 | T6 | 已验收 | Luna审查；F1/F2；F3 production app-server resolver；F4 quota 异常兜底；F5 Desktop session ESM/生产接线；两轮独立复审 | 0 blocker/major；server 34、monitor 30、desktop observation 28；typecheck/build PASS；真实 180 秒 tick PASS |

状态只允许：`待派发`、`执行中`、`待修复`、`已验收`、`阻塞`。员工返回 succeeded 不等于已验收，必须核对文件、定向命令和越界修改。

## 9. Go/No-Go 门禁

V2 execute 只能在以下全部满足后打开：

1. T1～T7 已验收。
2. AR-01～AR-20 全部 `V2_TARGETED_PASS`。
3. 真实环境能明确识别 `windowDurationMins=300` 或等价官方字段。
4. 没有 legacy daemon owner；旧 jobs 已由用户人工决定保留、取消或停止执行。
5. shadow 至少 2 个周期无误判。
6. 真实浏览器勾选、正常取消、等待 quota、手动取消状态证据齐全。

否则只能保持 `AUTO_RESUME_V2_SHADOW=1`、`AUTO_RESUME_V2_EXECUTE=0`。

## 10. 回滚

- 首选回滚：`AUTO_RESUME_V2_EXECUTE=0`，停止所有 V2 外部发送，保留观测。
- 其次：停止唯一 scheduler owner，UI 回退到只读。
- watches 与 jobs 分目录；回滚不得删除 watches，需保留用户勾选数据。
- 不以恢复旧 60 秒循环作为自动回滚动作；若确需恢复，必须由用户明确开启。
- 不使用 `git reset --hard`、`git clean` 或覆盖用户未跟踪文件。

## 11. 完成定义

代码门禁、浏览器门禁与真实额度门禁是三个独立结果：

- `CODE_PASS`：自动化、构建和独立审查通过。
- `UI_PASS`：真实浏览器操作和持久化证据通过。
- `REAL_QUOTA_PASS`：真实 300 分钟窗口及归零/恢复证据通过。

只有三者全部通过才是最终完成；其余必须准确报告为部分完成或外部证据阻塞。

## 12. 2026-09-01 最终验收结果

- `CODE_PASS`：通过。最终独立复审确认 0 个 blocker/major；服务端 V2 34/34、monitor 30/30、Desktop observation 28/28、相关 core 65/65，resume-core/taskboard typecheck、resume-core build 与 taskboard web build 均通过。`adopt.test.ts` 单跑 1/1、`cli-e2e.test.ts` 单跑 3/3；core 全量最新复跑 147/148，唯一失败是 `cli-e2e` 完成产品断言后的 Windows 临时目录清理 `EBUSY`。
- `UI_PASS`：通过。隔离状态目录、`AUTO_RESUME_V2_EXECUTE=0`、`AUTO_RESUME_V2_SHADOW=1` 下，用真实应用内浏览器完成：加载 104 个真实会话 → 勾选已完成会话 → 等待真实固定 180 秒 tick → 服务端持久化 `sessionState=COMPLETED`、`fiveHourQuota=UNKNOWN`、`lastError=null` 与实际检测时间 → 页面显示“监控中/UNKNOWN/上次检测” → 人工取消 → API 确认 watch 数量归零。整个过程未产生 resume attempt。
- `UNKNOWN` 展示与异常兜底：通过。quota reader 抛错时仍逐 watch 写入 `UNKNOWN` observation，RUNNING/COMPLETED 均保持 enabled、动作 NONE、0 发送；真实页面没有把未知误报为 `0%`。
- 生产接线修复：通过。Windows Desktop Codex 可执行入口用于 V2 `app-server --stdio`；Desktop session 默认 collector 已改为 ESM 兼容惰性加载；服务端在 adapter 边界把 `SessionObservation.state` 映射为状态机需要的字符串。真实周期得到 `COMPLETED`，不再出现 `require is not defined`。
- `REAL_QUOTA_UNKNOWN`：尚无真实 `windowDurationMins=300` 的归零与恢复时刻，因此 execute 门禁仍保持关闭；这不是代码测试失败，而是需要等待真实账户额度事件的外部证据。
- 范围外已知噪声：Taskboard AI 模型目录仍可能调用失效的全局 npm `codex.js debug models`；取证确认它不属于 V2 quota/session/sender 调用链，不影响上述自动续跑验收，留给独立任务处理。
- 当前安全结论：V2 可在 shadow/observe 模式使用；在满足第 9 节全部 Go 条件前，不得打开 `AUTO_RESUME_V2_EXECUTE=1`。
