// 只读状态页：每 5 秒拉一次宿主状态与 watch 列表并重绘。
//
// 数据源（同一个宿主的两个只读端点）：
//   GET /api/host/status   执行模式 / 能力门禁 / 上次检测 / Codex 入口
//   GET /api/auto-resume/watches  watch 明细（守护器提供，含相位与观测）
const POLL_MS = 5000;

const el = (id) => document.getElementById(id);

const MODE_LABEL = {
  execute: "execute · 真实发送",
  shadow: "shadow · 只记录不发送",
  observe: "observe · 零发送",
  "execute-blocked": "blocked · 发不出去",
  "blocked-no-sender": "blocked · 无可用发送器",
};

const MODE_NOTE = {
  execute: "门禁通过且本实例持有 owner，到点会真的续跑。",
  shadow: "已记录决策，但不会发送任何消息。",
  observe: "只观测，不发送。要真实续跑请用 --execute 或 AUTO_RESUME_V2_EXECUTE=1 启动。",
  "execute-blocked": "执行被门禁挡住（见右侧原因）；这是 fail-closed，不是故障。",
  "blocked-no-sender": "能力已就绪但没有可用发送器，保持零发送。",
};

const PHASE_CLASS = {
  MONITORING: "phase-running",
  ARMED: "phase-warn",
  RESUME_QUEUED: "phase-warn",
  RESUME_CONFIRMING: "phase-warn",
  COMPLETED: "phase-done",
  NEEDS_ATTENTION: "phase-bad",
  DISABLED: "",
};

function modeClass(mode) {
  if (mode === "execute") return "execute";
  if (mode === "shadow") return "shadow";
  if (mode === "observe") return "observe";
  return "blocked";
}

function text(node, value) {
  node.textContent = value ?? "—";
}

function renderStatus(status) {
  const mode = status.executionMode ?? "unknown";
  const modeTag = el("mode-tag");
  modeTag.textContent = MODE_LABEL[mode] ?? mode;
  modeTag.className = `tag ${modeClass(mode)}`;

  const dot = el("dot");
  dot.className = `dot ${status.pid ? "on" : "off"}`;

  text(el("mode"), MODE_LABEL[mode] ?? mode);
  text(el("mode-note"), MODE_NOTE[mode] ?? "");

  const gateOk = status.capability?.ok === true;
  text(el("gate"), gateOk ? "通过" : "未通过");
  const reasons = el("reasons");
  reasons.replaceChildren(
    ...(status.capability?.reasons ?? []).map((reason) => {
      const li = document.createElement("li");
      li.textContent = reason;
      return li;
    }),
  );

  text(el("last-detect"), status.lastDetectionAt ? new Date(status.lastDetectionAt).toLocaleString() : "尚未检测");
  const report = status.lastReport;
  text(
    el("last-report"),
    report
      ? `cycle ${report.cycleId ?? "-"} · quota ${report.quotaState ?? "-"} · 续跑 ${report.resumedCount ?? 0} · 跳过并发 ${report.skippedOverlapCount ?? 0}`
      : "",
  );

  const entry = status.codexEntry;
  text(
    el("entry"),
    entry ? `${entry.command} ${(entry.prefix ?? []).join(" ")}`.trim() : "未解析到可用入口（额度恒 UNKNOWN）",
  );
  text(el("state-dir"), `状态目录 ${status.stateDir} · pid ${status.pid} · 端口 ${status.port}`);

  const lede = el("lede");
  if (mode === "execute") {
    lede.textContent = "宿主正在无人值守续跑：额度归零后到重置时间会自动 resume 同一会话。";
  } else if (mode === "observe" || mode === "shadow") {
    lede.textContent = "宿主在观测模式：能看到决策，但不会真实发送。";
  } else {
    lede.textContent = `宿主已启动但发不出去：${(status.capability?.reasons ?? []).join("；") || "门禁未通过"}`;
  }

  text(el("updated"), `更新于 ${new Date().toLocaleTimeString()}`);
}

function renderWatches(payload) {
  const watches = payload.watches ?? [];
  text(el("watch-count"), String(watches.length));
  const tbody = el("watches");

  if (watches.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "empty";
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = "暂无 watch";
    tr.append(td);
    tbody.replaceChildren(tr);
    return;
  }

  const rows = watches.map((watch) => {
    const tr = document.createElement("tr");

    const id = document.createElement("td");
    id.className = "mono";
    id.textContent = watch.threadId;

    const cwd = document.createElement("td");
    cwd.className = "mono";
    cwd.textContent = watch.cwd;

    const phase = document.createElement("td");
    const span = document.createElement("span");
    span.className = `phase ${PHASE_CLASS[watch.phase] ?? ""}`.trim();
    span.textContent = watch.phase;
    phase.append(span);

    const count = document.createElement("td");
    count.textContent = String(watch.resumeAttemptCount ?? 0);

    const observed = document.createElement("td");
    const state = watch.lastObservation?.state;
    observed.textContent = state ? `${state}${watch.lastObservation?.reason ? `（${watch.lastObservation.reason}）` : ""}` : "—";

    const error = document.createElement("td");
    if (watch.lastError) {
      error.className = "err";
      error.textContent = watch.lastError;
    } else {
      error.textContent = "—";
    }

    tr.append(id, cwd, phase, count, observed, error);
    return tr;
  });

  tbody.replaceChildren(...rows);
}

/**
 * 拉取并重绘。
 *
 * 失败策略：**一次失败不算失败**。宿主重启、托盘杀进程、短暂卡顿都会让某次
 * fetch 失败，如果立刻把页面刷成一片错误，用户看到的是"坏了"，而实际上数据
 * 一秒前还是好的。所以：
 *   - 保留上一次成功渲染的内容不动；
 *   - 连续失败 COUNT 次（约 15 秒）才把状态点变红并给出人话原因；
 *   - 期间只在右上角显示一个"重连中"提示。
 */
const FAILURES_BEFORE_ALARM = 3;
let failures = 0;

async function refresh() {
  try {
    const [status, watches] = await Promise.all([
      fetch("/api/host/status", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/auto-resume/watches", { cache: "no-store" }).then((r) => r.json()),
    ]);
    if (status?.error || watches?.error) {
      throw new Error(status?.error?.message ?? watches?.error?.message ?? "宿主返回错误");
    }
    failures = 0;
    renderStatus(status);
    renderWatches(watches);
  } catch (error) {
    failures += 1;
    if (failures < FAILURES_BEFORE_ALARM) {
      text(el("updated"), `重连中…（第 ${failures} 次）`);
      return;
    }
    el("dot").className = "dot off";
    text(el("updated"), `宿主不可达：${error?.message ?? error}`);
  }
}

async function detectNow() {
  const button = el("detect");
  button.disabled = true;
  button.textContent = "检测中…";
  try {
    await fetch("/api/auto-resume/detect", { method: "POST" });
  } finally {
    button.disabled = false;
    button.textContent = "立即检测";
    await refresh();
  }
}

function baseName(p) {
  if (!p) return "";
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? String(p);
}

function renderPgm(workspaces) {
  const body = el("pgm-body");
  text(el("pgm-count"), String(workspaces.length));

  if (workspaces.length === 0) {
    const p = document.createElement("p");
    p.className = "foot";
    p.textContent = "没有读到带转录的 Codex 会话。";
    body.replaceChildren(p);
    return;
  }

  const nodes = workspaces.map((workspace) => {
    const wrap = document.createElement("div");
    wrap.className = "voice";

    const head = document.createElement("div");
    head.className = "voice-head";
    const name = document.createElement("span");
    name.className = "voice-name";
    name.textContent = baseName(workspace.cwd) || workspace.cwd;
    name.title = workspace.cwd ?? "";
    const sessions = workspace.sessions ?? [];
    const stalled = sessions.filter((session) => session.stalled).length;
    const meta = document.createElement("span");
    meta.className = "voice-meta";
    meta.textContent = `${sessions.length} 个会话${stalled > 0 ? ` · ${stalled} 个卡住` : ""}`;
    head.append(name, meta);

    const rows = sessions.map((session) => {
      const row = document.createElement("div");
      row.className = "session";

      const label = document.createElement("span");
      label.className = "session-name";
      label.textContent = session.name || session.sid;
      label.title = `${session.lastSummary ?? ""}\n${session.lastTs ?? ""}`;

      const state = document.createElement("span");
      state.className = `phase phase-${stateClass(session.state)}`;
      state.textContent = session.stateLabel ?? session.state ?? "—";

      const beats = document.createElement("span");
      beats.className = "beats";
      for (const beat of session.beats ?? []) {
        const bar = document.createElement("i");
        bar.className = `beat${beat.newest ? " beat-newest" : ""}`;
        bar.style.height = `${beat.h}px`;
        bar.title = beat.ts;
        beats.append(bar);
      }

      const idle = document.createElement("span");
      idle.className = "session-idle";
      idle.textContent = session.idleMinutes != null ? `${session.idleMinutes} 分钟前` : "—";

      row.append(label, state, beats, idle);
      return row;
    });

    wrap.append(head, ...rows);
    return wrap;
  });

  body.replaceChildren(...nodes);
}

/** 项目总谱状态 -> 复用相位的配色类 */
function stateClass(state) {
  if (state === "run") return "running";
  if (state === "think") return "warn";
  if (state === "rep") return "done";
  return "";
}

async function loadPgm() {
  const button = el("pgm-load");
  button.disabled = true;
  button.textContent = "读取中…";
  try {
    const payload = await fetch("/api/host/pgm", { cache: "no-store" }).then((r) => r.json());
    if (payload.error) {
      text(el("pgm-count"), "失败");
      const p = document.createElement("p");
      p.className = "foot err";
      p.textContent = payload.error.message;
      el("pgm-body").replaceChildren(p);
      return;
    }
    renderPgm(payload.workspaces ?? []);
  } catch (error) {
    text(el("pgm-count"), "失败");
  } finally {
    button.disabled = false;
    button.textContent = "读取总谱";
  }
}

el("detect").addEventListener("click", () => void detectNow());
el("refresh").addEventListener("click", () => void refresh());
el("pgm-load").addEventListener("click", () => void loadPgm());

void refresh();
setInterval(() => void refresh(), POLL_MS);
