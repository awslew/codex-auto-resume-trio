# 自动续跑 V2 设计方案

> 状态：待实现  
> 目标：把“自动续跑”改造成一个**每 3 分钟只观察、仅在确认由 5 小时额度耗尽导致中断后才续跑**的会话守护器。  
> 本文只定义设计、边界、实施顺序和验收门禁，不修改现有实现。

## 1. 用户意图的不可变规则

“自动续跑”勾选的是具体 Codex 会话，唯一身份使用 `threadId`；项目路径 `cwd` 只用于展示和安全检查，不能代替会话身份。

对每个已勾选会话，每 3 分钟执行一次检测：

1. 当前会话为“进行中”，5 小时额度大于 0：正常运行，程序不发送消息、不重启、不取消、不改会话状态。
2. 当前会话为“已完成”，5 小时额度大于 0：任务是正常完成，程序取消该会话的自动续跑标记。
3. 上一次可信检测为“进行中 + 5 小时额度大于 0”，本次检测发现 5 小时额度为 0：无论此刻会话标签是“进行中”还是“已完成”，都锁存为“等待额度恢复后续跑”。
4. “进行中 + 0”之后又变成“已完成 + 0”时，已经锁存的待续跑标记不得被清除。
5. 额度恢复后，只有已锁存“待续跑”的会话才允许启动续跑；普通“已完成”会话不得复活。
6. 任何信息缺失、过期或无法确定是否属于 5 小时窗口时，程序不得擅自续跑，也不得取消勾选。

这六条是实现与验收的最高优先级。现有 job 重试语义、页面标签或数据库时间戳与其冲突时，以这六条为准。

## 2. 当前实现为什么会曲解意图

当前代码把“被守护会话”和“待执行 job”混成了同一个对象：调度器看到 `running` job 会进入执行路径，而不是纯观察；只有 `waiting_rate_limit` 才会先读取额度。这个模型与“运行中不干涉”相反。

已取证的关键事实：

- `packages/resume-core/src/constants.ts` 当前默认调度周期是 60 秒，不是 3 分钟。
- `packages/resume-core/src/supervisor.ts:12-76` 会处理 `running` 状态，并可能重新发起执行。
- `packages/resume-core/src/supervisor.ts:31` 只有 `waiting_rate_limit` 才被识别为 resume 路径。
- `packages/resume-core/src/types.ts:11-27` 没有“上一轮进行中 + 额度可用”的持久化快照。
- `packages/resume-core/src/app-server/supervisor.ts:41` 只在实际执行前读取一次额度；CLI 路径不主动读取额度。
- `packages/resume-core/src/desktop-sessions.ts:131-137` 无法把真实的通用 usage-limit 文案可靠区分为 5 小时额度或周额度。
- `packages/resume-core/src/lock.ts` 只按 job 加锁；同一 `threadId` 的两个 job 可以分别获得锁并重复续跑。
- `apps/taskboard/web/src/components/SupervisorView.tsx` 的 15 秒刷新只能负责展示，不能成为状态机的采样来源。

因此 V2 不在旧条件上继续打补丁，而是拆开“监控状态”和“执行尝试”。

## 3. 架构决策

### 3.1 两层模型

新增独立的 `AutoResumeWatch`，表示“用户勾选了这个会话，程序应持续观察”。旧 `Job` 只表示一次实际执行，不再代表勾选关系。

```text
AutoResumeWatch（长期、每 3 分钟观察）
        |
        | 仅在确认 quota 中断且额度恢复后
        v
ResumeAttempt（一次性、幂等执行）
```

这保证正常运行的会话只经过读取路径，不会进入 `thread/resume` 或 `codex exec resume`。

### 3.2 数据源

每一轮检测生成一个不可变的 `DetectionSnapshot`：

- 5 小时额度：每轮只从 `account/rateLimits/read` 读取一次账户级快照，供本轮所有已勾选会话共享。
- 会话状态：按 `threadId` 从桌面会话数据读取并规范化。
- 决策只使用同一轮快照；前端 15 秒刷新、旧 job 日志和数据库异常未来时间戳都不能直接推动状态迁移。
- 额度快照和会话快照的采集时间差超过 30 秒时，本轮视为 `UNKNOWN`，不做破坏性决策。

### 3.3 5 小时额度必须被明确识别

内部不使用含糊的 `rateLimitReachedType` 或通用 “usage limit” 文案直接代表 5 小时额度。

窗口识别优先级：

1. `windowDurationMins === 300`；
2. 官方结构化字段中明确标识 5-hour 的 `limitId`/`limitName`；
3. 两者都没有时为 `UNKNOWN`。

额度规范化：

```ts
type FiveHourQuotaState = "POSITIVE" | "ZERO" | "UNKNOWN";

// 仅针对已确认的 300 分钟窗口
ZERO     := finite(usedPercent) && usedPercent >= 100
POSITIVE := finite(usedPercent) && usedPercent < 100
UNKNOWN  := 窗口身份不明、字段缺失、读取失败或数据过期
```

`usedPercent = 0` 表示额度充足，不等于“剩余额度为 0”；用户界面展示的剩余百分比为 `100 - usedPercent`。`resetAt` 只用于决定何时尝试，不用于证明发生了额度中断。

## 4. 持久化状态

建议新增 `packages/resume-core/src/auto-resume-types.ts`：

```ts
type WatchPhase =
  | "MONITORING"
  | "WAITING_FOR_5H_QUOTA"
  | "RESUME_QUEUED"
  | "RESUME_CONFIRMING"
  | "NEEDS_ATTENTION"
  | "DISABLED";

interface AutoResumeWatch {
  schemaVersion: 2;
  threadId: string;
  cwd: string;
  enabled: boolean;
  phase: WatchPhase;

  // 每轮都写，用于诊断；UNKNOWN 也会记录，但不能充当迁移证据。
  lastObservation?: {
    cycleId: string;
    detectedAt: string;
    sessionState: "RUNNING" | "COMPLETED" | "STOPPED" | "UNKNOWN";
    fiveHourQuota: "POSITIVE" | "ZERO" | "UNKNOWN";
    quotaResetAt?: number;
  };

  // 只在同一可信快照同时满足 RUNNING + POSITIVE 时写入；跨进程持久化。
  armedByDetection?: {
    cycleId: string;
    detectedAt: string;
    validUntil: string;
  };

  // 一旦生成，在额度恢复并完成续跑决策前不得被 completed 标签覆盖。
  interruptionLatch?: {
    id: string;
    detectedAt: string;
    evidenceCycleId: string;
    previousRunningCycleId: string;
    quotaResetAt?: number;
  };

  activeAttemptId?: string;
  resumeAttemptCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
```

存储建议使用 `%LOCALAPPDATA%\codex-auto-resume\watches\<threadId>.json`，继续采用临时文件加 rename 的原子写方式。文件名需对 `threadId` 做安全编码。

关键约束：

- “上一轮状态”只指**上一次 3 分钟检测已原子提交的可信快照**，不是 UI 最近刷新结果。
- `lastObservation` 与 `armedByDetection` 分开：不可信观察可写诊断，但不能覆盖可信迁移证据。
- `armedByDetection` 的有效期为 7 分钟，可容忍一轮采集失败，但不能让很久以前的 running 状态误触发今天的续跑；进程重启后仍从磁盘恢复。
- 本轮 quota 为 `ZERO` 且 arming 仍有效时创建 latch；创建 latch 与写本轮 observation 必须原子提交。
- `interruptionLatch` 是锁存证据；标签从 running 变 completed 不能清掉它。
- 用户手动取消勾选是唯一可以无条件清掉 watch 和 latch 的操作。

## 5. 状态机与判定顺序

### 5.1 判定优先级

每个会话必须严格按以下顺序处理，禁止把“completed 自动取消”放在额度中断识别之前：

1. 若用户已取消勾选：进入 `DISABLED`，结束。
2. 校验本轮额度与会话快照的新鲜度、窗口身份；无效则只记录诊断，不迁移。
3. 若已有 `interruptionLatch`：进入“已锁存分支”，禁止按普通 completed 处理。
4. 若持久化的 `armedByDetection` 仍在 7 分钟有效期内，且本轮 5 小时额度为 `ZERO`：创建 latch，进入 `WAITING_FOR_5H_QUOTA`。本轮会话标签不参与否决。
5. 无 latch 且本轮为 `RUNNING + POSITIVE`：只更新可信快照，不做其他动作。
6. 无 latch 且本轮为 `COMPLETED + POSITIVE`：置 `enabled=false`，进入 `DISABLED`。
7. 其余组合均为不充分证据：保持勾选和当前 phase，不续跑、不取消。

### 5.2 无 latch 时的真值表

| 上一可信状态 | 本轮会话 | 本轮 5h 额度 | 结果 | 外部动作 |
|---|---|---:|---|---|
| 任意 | RUNNING | POSITIVE | `MONITORING` | 无 |
| 任意 | COMPLETED | POSITIVE | `DISABLED` | 取消自动续跑标记 |
| RUNNING + POSITIVE | RUNNING | ZERO | `WAITING_FOR_5H_QUOTA` | 只打标，不续跑 |
| RUNNING + POSITIVE | COMPLETED | ZERO | `WAITING_FOR_5H_QUOTA` | 只打标，不取消 |
| RUNNING + POSITIVE | STOPPED | ZERO | `WAITING_FOR_5H_QUOTA` | 只打标，不取消 |
| RUNNING + POSITIVE | UNKNOWN | ZERO | `WAITING_FOR_5H_QUOTA` | 只打标，等待下轮确认 |
| 非 RUNNING + POSITIVE | 任意 | ZERO | 保持原 phase | 标为“额度为 0，但无中断证据” |
| 任意 | 任意 | UNKNOWN | 保持原 phase | 无 |
| 任意 | UNKNOWN | POSITIVE | 保持原 phase | 无 |

表中“任意”不覆盖更高优先级的已锁存分支。

### 5.3 已锁存分支

| 当前会话 | 当前 5h 额度 | 结果 | 外部动作 |
|---|---:|---|---|
| RUNNING | ZERO | 继续等待 | 无 |
| COMPLETED/STOPPED/UNKNOWN | ZERO | 继续等待 | 无 |
| UNKNOWN | POSITIVE | 继续等待会话状态可信 | 无 |
| RUNNING | POSITIVE | 回到 `MONITORING` | 认为用户或 Codex 已自行恢复；不重复启动 |
| COMPLETED/STOPPED | POSITIVE | `RESUME_QUEUED` | 创建一次幂等续跑尝试 |

`STOPPED` 只表示有可信证据证明当前没有 turn 在运行，例如明确的 failed/interrupted turn；它不证明任务正常完成。它在已锁存分支中可续跑，在无 latch 分支中既不能续跑也不能自动取消。

### 5.4 用户描述的三种归零顺序

```text
A. RUNNING+POSITIVE -> COMPLETED+ZERO
   第一轮 ZERO 直接锁存，completed 不能取消勾选。

B. RUNNING+POSITIVE -> RUNNING+ZERO
   第一轮 ZERO 直接锁存，等待额度恢复。

C. RUNNING+POSITIVE -> RUNNING+ZERO -> COMPLETED+ZERO
   第一次 ZERO 已锁存；后续 completed 只更新展示，不改变待续跑状态。
```

这三条最终都收敛到 `WAITING_FOR_5H_QUOTA`，不会依赖 Codex 先写状态还是先写额度。

## 6. 额度恢复后的续跑

### 6.1 启动条件

必须同时满足：

- watch 仍为 `enabled=true`；
- 存在 `interruptionLatch`；
- 本轮 5 小时额度为 `POSITIVE`；
- 会话为可信的 `COMPLETED` 或 `STOPPED`；
- 同一 `threadId` 没有 active attempt；
- 同一个 latch 尚未成功提交过续跑请求。

### 6.2 幂等键与锁

幂等键定义为：

```text
resumeAttemptId = sha256(threadId + interruptionLatch.id)
```

新增按 `threadId` 加锁，不再按 jobId 加锁。创建 attempt、写入 `activeAttemptId`、进入 `RESUME_QUEUED` 必须在同一临界区完成。

两个调度器、进程重启或重复 tick 看到同一 latch 时，只能复用同一个 attempt，不能再次发送续跑消息。锁需包含 PID、创建时间和 owner token；仅在 PID 已不存在且租约超时后回收陈旧锁。

### 6.3 发送与确认

续跑继续使用 app-server：`thread/resume` 后 `turn/start`。成功不能只看进程退出码，至少确认以下任一证据：

- 收到该 `threadId` 的新 turn id；或
- 会话进入 `RUNNING`，且更新时间晚于 attempt 创建时间。

确认成功后：清除 latch 与 `activeAttemptId`，phase 回到 `MONITORING`，自动续跑仍保持勾选；等任务之后在额度充足时真正完成，再按规则 2 自动取消。

若发送前额度再次归零，或返回明确的 5 小时额度限制：回到 `WAITING_FOR_5H_QUOTA`，保留同一 latch，不计作技术失败。

非额度技术失败最多自动重试 2 次，每次都复用同一 attempt id；仍失败则进入 `NEEDS_ATTENTION`，保留勾选与 latch，但停止自动发送，避免无限重复。

### 6.4 多会话恢复

一次检测要先完成所有会话的状态迁移，再处理续跑队列，避免前一个续跑改变账户额度而污染同轮其他会话的判断。

所有满足条件的会话都入队；默认最多并发启动 2 个，其余按 `interruptionLatch.detectedAt` 先进先出。队列调度前重新读取一次 5 小时额度；若已经归零，未发送的 attempt 回到等待态。

## 7. 三分钟调度器

新增常量：

```ts
AUTO_RESUME_DETECTION_INTERVAL_MS = 180_000
```

调度语义：

- taskboard server 启动后立即检测一次，此后按 fixed-rate 每 180 秒产生一个检测时点。
- 同一进程最多一轮在运行；到达检测时点而上一轮未结束时，本次记为 `SKIPPED_OVERLAP`，不叠加补跑，下一次仍在后续 180 秒边界触发。
- taskboard 内嵌调度器是唯一默认 owner；独立 daemon 启动时必须通过全局 lease 竞争 owner，不能与 taskboard 同时调度。
- V2 execute 开启时，旧 CLI daemon 和 taskboard 中 60 秒的 job 执行循环必须退出自动续跑职责；CLI 若要提供 V2 守护入口，也必须竞争同一全局 owner lease。
- UI 的 15 秒刷新只读服务端状态，不触发检测。
- 单个会话读取失败不能阻塞其他会话；额度读取失败则整轮只观察、不迁移。

## 8. 状态采集约束

`desktop-sessions.ts` 需要输出规范状态和可信度，不直接输出业务决策：

```ts
interface SessionObservation {
  threadId: string;
  state: "RUNNING" | "COMPLETED" | "STOPPED" | "UNKNOWN";
  observedAt: string;
  sourceRevision?: string;
  confidence: "TRUSTED" | "UNTRUSTED";
  reason?: string;
}
```

- 明确的当前 in-progress turn 可映射为 `RUNNING`。
- 明确的最新正常完成 turn 可映射为 `COMPLETED`。
- 明确的 failed/interrupted terminal turn 且能证明当前没有更新的 in-progress turn 时映射为 `STOPPED`。
- 记录缺失、互相冲突或未来异常时间戳映射为 `UNKNOWN`，除非另有不依赖损坏时间戳的序列证据。
- 当前库已发现年份 `+058632` 的异常时间戳；状态排序必须先校验时间范围，不能让异常未来时间覆盖可信记录。
- 通用 usage-limit 错误只能作为诊断信息；在无法确认它属于 5 小时窗口时，不可单独创建 latch。

## 9. API 与 UI 契约

### 9.1 服务端 API

新增或替换为会话级接口：

- `GET /api/auto-resume/watches`：返回所有 watch、phase、最近检测、latch 和诊断。
- `PUT /api/auto-resume/watches/:threadId`：`{ enabled: true, cwd }`，幂等勾选。
- `DELETE /api/auto-resume/watches/:threadId`：用户主动取消，幂等。
- `POST /api/auto-resume/detect`：只供人工诊断触发一次完整检测，不直接强制续跑。

旧的 create/cancel job 接口保留兼容期，但 UI 的自动续跑勾选不再调用它们。

### 9.2 页面标签

页面只展示服务端 phase，不自行推导：

- `MONITORING`：自动续跑已开启
- `WAITING_FOR_5H_QUOTA`：已确认额度中断，等待 5 小时额度恢复
- `RESUME_QUEUED`：额度已恢复，等待续跑
- `RESUME_CONFIRMING`：续跑已发送，等待新 turn
- `NEEDS_ATTENTION`：续跑失败，需要人工处理
- `DISABLED`：已关闭

必须额外展示“上次检测时间”“本轮 5 小时剩余比例/未知原因”“中断证据时间”。不能把“额度未知”显示成 0%。

## 10. 文件职责与实施边界

| 文件/模块 | 变更职责 | 禁止事项 |
|---|---|---|
| `packages/resume-core/src/auto-resume-types.ts`（新） | watch、snapshot、attempt 类型 | 不读取 UI 状态 |
| `packages/resume-core/src/auto-resume-reducer.ts`（新） | 纯函数状态机 | 不发 RPC、不写盘 |
| `packages/resume-core/src/five-hour-quota.ts`（新） | 300 分钟窗口识别与规范化 | 不用通用文案猜 5h |
| `packages/resume-core/src/auto-resume-store.ts`（新） | watch 原子持久化、schema 迁移 | 不覆盖旧 jobs |
| `packages/resume-core/src/auto-resume-monitor.ts`（新） | 3 分钟检测、批量决策、队列 | running 时禁止调用 resume |
| `packages/resume-core/src/resume-attempt.ts`（新） | thread 锁、幂等发送、确认 | 不按 jobId 去重 |
| `packages/resume-core/src/desktop-sessions.ts` | 输出可信规范状态 | 不承担业务迁移 |
| `apps/taskboard/server/supervisor-api.mjs` | 新 API、唯一 scheduler owner | 不保留 60 秒自动续跑 tick |
| `apps/taskboard/web/src/components/SupervisorView.tsx` | 勾选与 phase 展示 | 15 秒刷新不得触发状态迁移 |

不要在同一实现 wave 中让多个员工同时修改 `supervisor-api.mjs` 或 `SupervisorView.tsx`。先落纯状态机和存储契约，再接服务端，最后接 UI。

## 11. 实施步骤与门禁

### Wave 0：冻结事实与回归样本

- 保存现有 4 个 job 的脱敏 fixture，不修改用户运行态文件。
- 为真实 `account/rateLimits/read` 响应建立脱敏 fixture，至少包含 300 分钟窗口、周窗口、字段缺失和通用 usage-limit 文案。
- 固化当前 SQLite 异常未来时间戳样本。

门禁：fixtures 不含 token、完整 prompt、个人路径之外的敏感内容；旧 job 文件零改动。

### Wave 1：纯状态机与存储

- 新增类型、reducer、watch store 和 schemaVersion=2。
- reducer 使用表驱动测试，不能依赖 wall clock。
- 原子写与崩溃恢复测试通过。

门禁：第 12 节 P0 用例全部通过；对 `RUNNING + POSITIVE` 的副作用计数严格为 0。

### Wave 2：额度与会话观测

- 实现 300 分钟窗口识别、快照新鲜度和 UNKNOWN 语义。
- 修复异常时间戳对规范状态的污染。
- 一轮只生成一个共享 quota snapshot。

门禁：周额度为 0 但 5 小时额度大于 0 时，不创建 5h latch；字段缺失不等于 0。

能力门禁：若真实 `account/rateLimits/read` 无法明确识别 300 分钟窗口，V2 只能进入观察模式，`AUTO_RESUME_V2_EXECUTE` 必须拒绝开启并在 UI 显示“5 小时额度传感器不可用”。不能用通用 usage-limit 文案猜测后放行执行。

### Wave 3：调度、幂等与执行

- 实现 fixed-rate 180 秒 scheduler、全局 owner lease、thread 锁和 attempt outbox。
- 接入 app-server 发送及新 turn 确认。
- 进程在“写 attempt 后、发送前”和“发送后、确认前”两处崩溃的恢复测试通过。

门禁：双调度器、重复 tick、进程重启三种情况下，同一 latch 最多产生一次有效 `turn/start`。

### Wave 4：API 与 UI

- 自动续跑勾选切换到 watch API。
- 展示服务端 phase、证据和未知原因。
- 保留旧 jobs 的只读查看与人工取消入口，不把它们自动迁移为 watch。

门禁：真实浏览器验证勾选持久化、正常完成自动取消、等待额度标签、手动取消；仅组件测试不能算 UI 通过。

### Wave 5：影子运行与切换

- 先以 `AUTO_RESUME_V2_SHADOW=1` 运行至少 2 个检测周期：只记录“本应发生的迁移”，绝不发送续跑。
- 对比人工观察后再打开 `AUTO_RESUME_V2_EXECUTE=1`。
- 首次执行期保留旧 60 秒执行循环关闭，避免双 owner。

门禁：影子日志能解释每个会话为何无动作、取消、等待或入队；存在 UNKNOWN 时必须保守无动作。

## 12. P0 验收用例

以下均使用 fake clock，每轮间隔精确推进 180 秒：

| ID | 输入序列 | 必须结果 |
|---|---|---|
| AR-01 | `RUNNING+POSITIVE` 连续 3 轮 | 0 次 resume，保持勾选 |
| AR-02 | `RUNNING+POSITIVE -> COMPLETED+POSITIVE` | 取消勾选，0 次 resume |
| AR-03 | `RUNNING+POSITIVE -> COMPLETED+ZERO` | 锁存等待，不取消 |
| AR-04 | `RUNNING+POSITIVE -> RUNNING+ZERO` | 锁存等待，0 次 resume |
| AR-05 | `RUNNING+POSITIVE -> RUNNING+ZERO -> COMPLETED+ZERO` | latch 保持不变 |
| AR-06 | AR-03 后 `COMPLETED+POSITIVE` | 恰好 1 次 resume |
| AR-07 | AR-04 后 `RUNNING+POSITIVE` | 认为已自行恢复，0 次 resume |
| AR-08 | 无历史，首次 `COMPLETED+ZERO` | 不 resume、不取消，显示证据不足 |
| AR-09 | 任意状态 + quota UNKNOWN | 不 resume、不取消 |
| AR-10 | 周额度 ZERO、5h 额度 POSITIVE | 按 5h POSITIVE 处理 |
| AR-11 | 5h 字段缺失、通用 usage-limit 文案 | quota UNKNOWN，不创建 latch |
| AR-12 | AR-03 后重启进程，再额度恢复 | latch 不丢，恰好 1 次 resume |
| AR-13 | 两个 scheduler 同时 tick 同一 thread | 恰好 1 次有效发送 |
| AR-14 | 同一 thread 重复勾选 | 只有 1 个 watch |
| AR-15 | 发送成功但确认前崩溃 | 重启后查询/确认，不盲目重复发送 |
| AR-16 | 异常未来时间戳记录 | 状态为 UNKNOWN 或使用其他可信序列，不误判完成/运行 |
| AR-17 | 用户在等待期间取消勾选 | 永不自动续跑，latch 清除 |
| AR-18 | 一个会话读取失败、另一个正常 | 正常会话仍完成本轮决策 |
| AR-19 | 已锁存后状态为 `STOPPED+POSITIVE` | 恰好 1 次 resume |
| AR-20 | `RUNNING+POSITIVE` 已落盘，进程重启，7 分钟内出现 `COMPLETED+ZERO` | 恢复 arming 并锁存等待 |

## 13. 发布验收证据

实施完成后必须交付：

- 变更文件清单和脏工作树审计；
- reducer 真值表测试结果；
- fake app-server 的幂等、崩溃恢复、双调度器测试结果；
- 精确 180 秒 fixed-rate 且重叠轮次跳过的 fake-clock 证据；
- 真实浏览器勾选/取消/状态标签截图；
- 至少 2 个影子检测周期日志；
- 一次受控的额度归零序列可回放证据；若无法制造真实归零，只能标为 `REAL_QUOTA_UNKNOWN`，不能用单元测试冒充真实额度通过。

## 14. 回滚方案

- V2 上线前不删除或改写 `%LOCALAPPDATA%\codex-auto-resume\jobs\`。
- watch 使用独立目录和 `schemaVersion=2`，关闭 `AUTO_RESUME_V2_EXECUTE` 即可立即停止所有自动发送，保留只读监控。
- 回滚服务端时先停止 scheduler owner，再切回旧版本；不得让 V1 与 V2 同时执行。
- 回滚不自动恢复旧 60 秒调度。若确需恢复，必须由用户明确开启，因为旧路径会对 `running` job 重新发起执行。
- 删除 V2 watch 数据前先导出清单；用户勾选状态属于用户数据，不能静默丢弃。

## 15. 完成定义

只有同时满足以下条件，才可宣布“自动续跑 V2 完成”：

1. 检测间隔为 3 分钟且没有并发重入。
2. AR-01 至 AR-20 全部通过。
3. 正常运行时没有任何写会话或发送续跑的副作用。
4. 三种额度归零先后顺序都锁存到同一个等待态。
5. 正常完成会自动取消；额度中断导致的 completed 不会取消。
6. 同一中断证据最多续跑一次。
7. UNKNOWN 全部保守处理，不把缺失误当 0。
8. 影子运行证据与真实浏览器证据齐全。

未取得真实 5 小时额度窗口响应或真实 UI 证据时，只能报告“代码门禁通过，真实环境待验”，不能报告最终通过。
