/* API 配额仪表盘 — 前端逻辑：拉 /api/quota 渲染三卡 + 倒计时，每 15s 自动刷新 */
'use strict';

const META = {
  deepseek:   { name: 'DeepSeek',    accent: 'deepseek' },
  openrouter: { name: 'OpenRouter',  accent: 'openrouter' },
  opencode_go:{ name: 'OpenCode Go', accent: 'opencode_go' },
  codex:      { name: 'Codex',       accent: 'codex' },
};
const CURR = { CNY: '¥', USD: '$' };

const grid = document.getElementById('grid');
const countdownEl = document.getElementById('countdown');
const state = { quotas: [], next_refresh_at: null, refresh_interval: null, opencode_usage_url: 'https://app.opencode.ai' };

function num(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money(v, cur) {
  return v == null ? '—' : (CURR[cur] || '') + num(v);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(used, total) {
  return Math.min(100, Math.max(0, (used / (total || 1)) * 100));
}

function chip(q) {
  if (q.refresh_failed) return '<span class="chip warn">刷新失败·旧数据</span>';
  if (q.source_status === '不可用') return '<span class="chip bad">数据源不可用</span>';
  return '<span class="chip ok">官方</span>';
}

function balanceBody(q) {
  const todayLine = (q.today_usage != null)
    ? `<div class="today">今日用量 ${money(q.today_usage, q.currency)}</div>`
    : `<div class="today faint">今日用量 · 官方未提供</div>`;
  if (q.used != null && q.total) {
    return `<div class="value">${money(q.value, q.currency)}</div>
      ${todayLine}
      <div class="used">已用 ${money(q.used, q.currency)} / 总量 ${money(q.total, q.currency)}</div>
      <div class="bar"><i data-w="${pct(q.used, q.total)}"></i></div>`;
  }
  return `<div class="value">${money(q.value, q.currency)}</div>
    ${todayLine}
    <div class="used">官方 API 未提供已用 / 总量</div>`;
}

function subReset(sec) {
  if (sec == null) return '';
  sec = Math.max(0, sec);
  if (sec >= 86400) { const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); return `${d}天${h}小时`; }
  if (sec >= 3600) { const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); return `${h}小时${m}分`; }
  const m = Math.floor(sec / 60); const s = sec % 60;
  return m ? `${m}分${s}秒` : `${s}秒`;
}

function subscriptionBody(q) {
  const wins = (q.windows || []).map(w => {
    const p = (w.percent != null) ? w.percent : (w.limit ? (w.used / w.limit * 100) : 0);
    const pval = Math.min(100, Math.max(0, p));
    const limitTxt = (w.limit != null) ? ` · 限${money(w.limit, w.currency)}` : '';
    const resetTxt = (w.reset_in_sec != null) ? `<div class="win-reset">${subReset(w.reset_in_sec)} 后重置</div>` : '';
    return `<div class="win-block">
      <div class="win-row"><span>${esc(w.label)}</span><b>已用 ${pval.toFixed(0)}%${limitTxt}</b></div>
      ${resetTxt}
      <div class="bar"><i data-w="${pval}"></i></div>
    </div>`;
  }).join('');
  return wins ? `<div class="win">${wins}</div>` : '<div class="note">暂无窗口额度数据</div>';
}

function unavailableBody(q) {
  const isGo = q.provider === 'opencode_go';
  const err = esc((q.error || '').slice(0, 100));
  const btn = isGo
    ? `<a class="btn-open" href="${esc(state.opencode_usage_url)}" target="_blank" rel="noopener">打开官网看用量<span class="arr">↗</span></a>`
    : '';
  return `<div class="note" style="color:var(--bad)">官方数据源不可用</div>
    ${err ? `<div class="note">${err}</div>` : ''}${btn}`;
}

function card(q) {
  const meta = META[q.provider] || { name: q.provider, accent: 'deepseek' };
  let body;
  if (q.source_status === '不可用') body = unavailableBody(q);
  else if (q.billing_type === 'subscription') body = subscriptionBody(q);
  else body = balanceBody(q);
  const t = q.fetched_at ? q.fetched_at.replace('T', ' ').slice(5, 19) : '—';
  return `<div class="shell"><div class="card" data-accent="${meta.accent}">
    <div class="card-head"><span class="provider">${esc(meta.name)}</span>${chip(q)}</div>
    ${body}
    <div class="card-foot"><span>数据 ${esc(t)}</span></div>
  </div></div>`;
}

function gridClass(n) {
  if (n === 4) return 'grid-4';
  if (n === 2) return 'grid-2';
  if (n >= 5) return 'grid-3';
  return '';
}

function render() {
  grid.className = 'grid' + (gridClass(state.quotas.length) ? ' ' + gridClass(state.quotas.length) : '');
  grid.innerHTML = state.quotas.length
    ? state.quotas.map(card).join('')
    : '<div class="note">暂无数据</div>';
  requestAnimationFrame(() => {
    document.querySelectorAll('.bar i').forEach(el => { el.style.width = el.dataset.w + '%'; });
  });
}

function tick() {
  const t = state.next_refresh_at;
  if (t) {
    const remain = Math.max(0, t - Date.now() / 1000);
    const m = String(Math.floor(remain / 60)).padStart(2, '0');
    const s = String(Math.floor(remain % 60)).padStart(2, '0');
    countdownEl.textContent = `${m}:${s}`;
  } else {
    countdownEl.textContent = '--:--';
  }
}

async function load() {
  try {
    const r = await fetch('/api/quota', { cache: 'no-store' });
    Object.assign(state, await r.json());
    render();
    tick();
  } catch (e) {
    /* 本地服务未就绪，稍后重试 */
  }
}

document.getElementById('loading').classList.add('hide');
load();
setInterval(load, 15000);
setInterval(tick, 1000);
