#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PGM Dashboard v2 — Codex 项目总经理 · 乐谱式总谱
读 Codex 转录汇总多项目，用 Claude Code（claude -p，走你现有套餐）做 AI 分析，
渲染成"项目总谱"：每个项目 = 一个声部，左列时间色块(上为现在) + 右侧排练笔记(现状/卡点/建议决策)。

用法:
    python pgm_dash.py [端口]     # 默认 5100，自动开浏览器

成本控制:
    - 每项目只有在"最新汇报变了"才重新调用 claude 分析（缓存结果）
    - 页面顶部"重新分析"按钮可手动强制重跑
    - 每 30s 自动刷新页面（只刷新数据，不触发分析）
"""
import json
import os
import re
import sys
import time
import threading
import subprocess
import webbrowser
from datetime import datetime, timezone

# 自包含：本项目目录（apps/pgm-collector）加入 import 路径，复用同目录的 pgm / pgm_handoff
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
import pgm  # 复用 pgm.py 的采集逻辑
import pgm_handoff  # 项目接力简报

from flask import Flask, request

app = Flask(__name__)

CACHE = {}           # sid -> {"key": str, "result": dict, "ts": float}
CACHE_LOCK = threading.Lock()

HANDOFF_DIR = os.path.join(BASE_DIR, "runtime", "handoffs")

PROMPT = """你是多个 Codex 项目经理之上的"项目总经理"。
以下是项目「{name}」的 Codex 项目经理最近汇报（按时间先后，最新在后）：
---BEGIN---
{summaries}
---END---
请分析并只输出一个严格 JSON（禁止输出任何其他文字、代码块标记）：
{{"summary":"项目现状，2-3句，直接说人话","blockers":["卡点/风险，1-4条，没有就空数组"],"decision":"你建议老板做出的决策，直接可执行、可复制回该 Codex 窗口的一句话"}}
不要解释，不要客套。"""


def claude_analyze(name, summaries):
    """调 claude -p 分析单个项目。Windows 上 claude 是 npm shim(claude.cmd)，
    用 cmd /c 调；提示词走 stdin 避开引号问题；输出强制 UTF-8。"""
    prompt = PROMPT.format(name=name, summaries=summaries)
    try:
        r = subprocess.run(
            ["cmd", "/c", "claude.cmd", "-p", "--output-format", "text"],
            input=prompt, text=True, encoding="utf-8", errors="replace",
            capture_output=True, timeout=300,
            cwd=os.path.expanduser("~"),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        out = (r.stdout or "").strip()
        return extract_json(out) or {"summary": out[:300], "blockers": [], "decision": ""}
    except Exception as e:
        return {"summary": f"分析失败: {e}", "blockers": [], "decision": ""}


def extract_json(text):
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        if text.lower().startswith("json"):
            text = text[4:]
    try:
        return json.loads(text)
    except Exception:
        pass
    s, e = text.find("{"), text.rfind("}")
    if 0 <= s < e:
        try:
            return json.loads(text[s:e + 1])
        except Exception:
            return None
    return None


def analysis_for(proj):
    """带缓存的 AI 分析：key=最新汇报时间，变了才重跑"""
    msgs = proj["msgs"]
    key = msgs[-1][0] if msgs else proj.get("updated_at", "")
    force = request.args.get("force") == "1" if request else False
    with CACHE_LOCK:
        cached = CACHE.get(proj["sid"])
        if cached and cached["key"] == key and not force:
            return cached["result"]
    summaries = "\n".join(f"[{t[11:16]}] {txt}" for t, txt in msgs[-3:])
    result = claude_analyze(proj["name"][:40], summaries)
    with CACHE_LOCK:
        CACHE[proj["sid"]] = {"key": key, "result": result, "ts": time.time()}
    return result


def status_of(proj):
    last_ts = proj["msgs"][-1][0] if proj["msgs"] else proj.get("updated_at", "")
    label, age_min = pgm.status_of(proj["last"], last_ts, datetime.now(timezone.utc))
    age_str = f"{age_min}分钟前" if age_min is not None else "—"
    return label, age_str, last_ts[:16]


def build_beats(msgs, top=4):
    """把最近汇报的时间戳转成乐谱色块：高度 ∝ 此汇报前静默时长（分）。
    返回 oldest→newest 顺序（渲染用 column-reverse 让最新在最上方）。"""
    def parse(ts):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except Exception:
            return None
    times = [parse(t) for t, _ in msgs]
    beats = []
    for i, t in enumerate(times):
        if t is None:
            continue
        gap = 4.0 if i == 0 else (t - times[i - 1]).total_seconds() / 60
        h = max(12, min(60, int(12 + gap * 0.5)))
        beats.append({"ts": msgs[i][0][11:16], "h": h, "newest": i == len(times) - 1})
    return beats[-top:]


def short_name(name):
    """把长项目名压成干净短标题：去"项目："前缀、取标题主体、硬截断"""
    n = name
    if n.startswith("项目："):
        n = n[3:]
    n = n.strip('"\'“”')
    for sep in "（，,。":
        i = n.find(sep)
        if 0 < i <= 26:
            n = n[:i]
            break
    n = n.strip()
    if len(n) > 22:
        n = n[:22] + "…"
    return n


# 状态 → 语义色
STATUS = {
    "思考中": ("think", "琥珀 · 思考"),
    "运行中(调工具)": ("run", "蓝 · 运行"),
    "运行中(工具已返回)": ("run", "蓝 · 运行"),
    "运行中(自定义工具)": ("run", "蓝 · 运行"),
    "运行中(自定义工具已返回)": ("run", "蓝 · 运行"),
    "已汇报·待下一步": ("rep", "绿 · 待下一步"),
}

# 筛选/排序优先级：运行 > 思考 > 待下一步 > 其他
STATE_ORDER = {"run": 0, "think": 1, "rep": 2}

TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PGM · 项目总谱</title>
<style>
:root{
  --paper:#faf9f5; --paper2:#f1efe8; --ink:#201f1c; --ink2:#57534e; --ink3:#78756c;
  --hair:#e4e0d6; --hair2:#d4cfc2;
  --blue:#3b6ea5; --amber:#a97f16; --green:#3d7a57; --rust:#b0502f;
  --blue-bg:#e8eef5; --amber-bg:#f5eeda; --green-bg:#e9f0eb; --rust-bg:#f5eae4;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--paper);color:var(--ink);
  font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.page{max-width:1180px;margin:0 auto;padding:54px 44px 70px}
a{color:inherit}

/* 谱首 */
.masthead{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;
  border-bottom:1px solid var(--ink);padding-bottom:20px;margin-bottom:40px}
.brand{display:flex;align-items:baseline;gap:14px}
.pgm-mark{font:700 12px/1 "Segoe UI",sans-serif;letter-spacing:.28em;color:var(--ink3);
  border:1px solid var(--ink);border-radius:4px;padding:5px 7px 4px;transform:translateY(-2px)}
.brand h1{margin:0;font-size:25px;font-weight:680;letter-spacing:.03em}
.mast-meta{display:flex;align-items:center;gap:18px;font-size:12.5px;color:var(--ink3);font-variant-numeric:tabular-nums}
.btn{font:600 12.5px/1 inherit;color:var(--ink);background:transparent;border:1px solid var(--ink);
  border-radius:999px;padding:9px 18px;cursor:pointer;letter-spacing:.02em;transition:background .15s,color .15s}
.btn:hover{background:var(--ink);color:var(--paper)}
.btn:active{transform:translateY(1px)}

/* 筛选条 */
.filters{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:34px}
.filters .f-lab{font:600 11px/1 "Segoe UI",sans-serif;letter-spacing:.18em;color:var(--ink3);margin-right:4px}
.filters .f-sep{width:1px;height:16px;background:var(--hair);margin:0 6px}
.fchip{font:600 12px/1 inherit;color:var(--ink2);background:transparent;border:1px solid var(--hair2);
  border-radius:999px;padding:6px 13px;cursor:pointer;letter-spacing:.02em;transition:color .15s,border-color .15s,background .15s}
.fchip:hover{color:var(--ink);border-color:var(--ink)}
.fchip.on{color:var(--paper);background:var(--ink);border-color:var(--ink)}
.fchip .n{opacity:.62;margin-left:5px;font-variant-numeric:tabular-nums;font-size:11px}
.fsearch{margin-left:auto;display:flex;align-items:center;gap:8px;border:1px solid var(--hair2);border-radius:999px;
  padding:5px 14px;width:218px;transition:border-color .15s}
.fsearch:focus-within{border-color:var(--ink)}
.fsearch .s-ico{font-size:11px;color:var(--ink3)}
.fsearch input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--ink);
  font:13px/1.5 inherit;letter-spacing:.01em}
.fsearch input::placeholder{color:var(--ink3);opacity:.7}

/* 声部 */
.system{padding:34px 0 38px;border-bottom:1px solid var(--hair)}
.system-head{display:flex;align-items:baseline;gap:14px;margin-bottom:20px;cursor:pointer;
  -webkit-user-select:none;user-select:none}
.sys-no{font:500 11px/1 var(--mono);letter-spacing:.16em;color:var(--ink3);font-variant-numeric:tabular-nums}
.sys-name{font-size:19px;font-weight:660;letter-spacing:.01em}
.chip{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;letter-spacing:.02em;
  padding:4px 11px;border-radius:999px}
.chip .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.run{color:var(--blue);background:var(--blue-bg)}
.chip.think{color:var(--amber);background:var(--amber-bg)}
.chip.rep{color:var(--green);background:var(--green-bg)}
.chip.run .dot{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.sys-meta{margin-left:auto;font-size:12px;color:var(--ink3);font-variant-numeric:tabular-nums}
.chev{flex:none;font-size:11px;color:var(--ink3);transform:rotate(0);transition:transform .18s}
.system.collapsed .chev{transform:rotate(-90deg)}
.system.collapsed .sys-body{display:none}

/* 声部主体：左=时间色块 右=排练笔记 */
.sys-body{display:grid;grid-template-columns:112px 1fr;gap:42px;align-items:start}
.beat-rail{position:relative;display:flex;flex-direction:column-reverse;gap:7px;padding-top:30px;min-height:210px}
.rail-cap{position:absolute;top:4px;left:0;font:700 10.5px/1 "Segoe UI",sans-serif;letter-spacing:.2em;color:var(--ink3)}
.now{position:absolute;left:-8px;right:-8px;top:0;border-top:1px dashed var(--ink);height:0}
.now::after{content:"现在";position:absolute;right:0;top:-9px;font:600 10px/1 "Segoe UI",sans-serif;
  letter-spacing:.14em;color:var(--ink3);background:var(--paper);padding-left:6px}
.beat{display:flex;flex-direction:column;gap:3px}
.beat .bar{width:100%;border-radius:2px;background:var(--ink3);opacity:.5}
.beat.newest .bar{background:var(--blue);opacity:1}
.beat .bt{font-size:10.5px;color:var(--ink3);font-variant-numeric:tabular-nums;letter-spacing:.04em}

.notes{min-width:0;display:flex;flex-direction:column;gap:13px}
.nrow{display:grid;grid-template-columns:46px 1fr;gap:14px}
.nrow .lab{font:600 11px/1.4 "Segoe UI",sans-serif;letter-spacing:.18em;color:var(--ink3);padding-top:5px}
.nrow .val{font-size:14.5px;line-height:1.75;color:var(--ink2);min-width:0}
.blk{margin:0;padding:0;list-style:none}
.blk li{position:relative;padding-left:15px;margin-bottom:5px;color:var(--ink2)}
.blk li:last-child{margin-bottom:0}
.blk li::before{content:"";position:absolute;left:0;top:.74em;width:5px;height:5px;border-radius:50%;background:var(--rust)}
.decision{margin-top:4px;padding:15px 18px;background:var(--paper2);border:1px solid var(--hair);
  border-radius:10px;display:flex;gap:14px;align-items:flex-start}
.decision .lab{padding-top:3px;flex:none}
.decision .dtext{flex:1;color:var(--ink);font-weight:540;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.dbtns{flex:none;display:flex;flex-direction:column;gap:8px}
.dbtns button{font:600 11px/1 inherit;color:var(--ink2);background:transparent;border:1px solid var(--hair2);
  border-radius:6px;padding:8px 10px;cursor:pointer;letter-spacing:.02em;min-width:52px;text-align:center;
  transition:border-color .15s,color .15s}
.dbtns button:hover{color:var(--ink);border-color:var(--ink)}
.dbtns button:disabled{opacity:.5;cursor:default}
.latest{margin-top:2px;font-size:12px;color:var(--ink3);line-height:1.6;overflow:hidden;text-overflow:ellipsis;
  display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}
.latest b{font-weight:600;font-variant-numeric:tabular-nums}

/* 页脚 */
.foot{margin-top:46px;padding-top:16px;border-top:1px solid var(--hair);
  display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--ink3);flex-wrap:wrap}

.empty{padding:130px 0;text-align:center;color:var(--ink3)}
.f-empty{padding:60px 0 90px;text-align:center;color:var(--ink3);display:none}
@media (max-width:840px){
  .page{padding:32px 20px 54px}
  .masthead{flex-direction:column;align-items:flex-start;gap:14px}
  .mast-meta{flex-wrap:wrap}
  .sys-body{grid-template-columns:1fr;gap:18px}
  .beat-rail{flex-direction:row;align-items:flex-end;gap:8px;padding-top:22px;min-height:0}
  .now{top:auto;bottom:0;border-top:none;border-bottom:1px dashed var(--ink);left:-4px;right:-4px}
  .now::after{top:auto;bottom:-9px;right:0}
  .beat{flex-direction:row;align-items:flex-end;gap:4px}
  .beat .bar{height:var(--h);width:14px;min-height:8px}
  .rail-cap{top:0}
}
</style></head>
<body>
<!--
THESIS: 一份"项目总谱"——把多个 Codex 项目经理的进展当作一支乐队的不同声部：白纸墨线、时间自下而上、扫一眼节奏即可判断谁在跑谁卡住，排练笔记里抄走决策；拒绝暗色卡片堆叠的仪表盘默认。
OWN-WORLD: 暖白纸底 + 墨黑文字 + 发丝细线；状态只活在极小的色标/色块里（蓝=运行、琥珀=思考、绿=待下一步、锈=卡点）；边角小号数字标注时刻。
STORY: 来访者一眼看懂每个项目此刻在干什么、卡在哪、该拍什么板，把"建议决策"抄回 Codex 窗口就走。
FIRST VIEWPORT: 窄字标谱首压一条墨线；四个"声部"纵向排开，每声部=左侧一列时间色块(上为"现在")+右侧排练笔记(现状/卡点/建议决策)。
FORM: 乐谱式记谱(Labanotation)方向的克制演绎，Operate 模式，impeccable concept-seed 分配方向。
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->
<div class="page">
  <header class="masthead">
    <div class="brand">
      <span class="pgm-mark">PGM</span>
      <h1>项目总谱</h1>
    </div>
    <div class="mast-meta">
      <span>{{count}} 个声部</span>
      <span>30s 自动刷新</span>
      <span>渲染 {{ts}}</span>
      <button class="btn" onclick="location.href='/?force=1'">⟳ 重新分析</button>
    </div>
  </header>

  {% if not projects %}
  <div class="empty">尚无进行中的 Codex 项目声部。</div>
  {% endif %}

  <div class="filters" id="filters">
    <span class="f-lab">状态</span>
    <button class="fchip on" data-f="all">全部<span class="n">{{count}}</span></button>
    {% for cls, lab in [("run", "运行中"), ("think", "思考中"), ("rep", "待下一步")] %}
    <button class="fchip" data-f="{{cls}}">{{lab}}<span class="n">{{fcounts.get(cls, 0)}}</span></button>
    {% endfor %}
    <span class="f-sep"></span>
    <button class="fchip" data-f="open">未折叠<span class="n">{{open_count}}</span></button>
    <button class="fchip" data-f="done">已折叠<span class="n">{{closed_count}}</span></button>
    <span class="fsearch" id="fsearch"><span class="s-ico">⌕</span>
      <input id="fq" type="text" placeholder="按名称检索" autocomplete="off"></span>
  </div>

  {% for p in projects %}
  <section class="system {{'collapsed' if p.sid in closed_sids}}" data-sys-id="{{p.sid}}" data-f-state="{{p.state_cls}}">
    <div class="system-head" data-toggle>
      <span class="sys-no">{{loop.index}}</span>
      <span class="sys-name" title="{{p.fullname}}">{{p.name}}</span>
      <span class="chip {{p.state_cls}}"><span class="dot"></span>{{p.status}}</span>
      <span class="sys-meta">{{p.age}} · {{p.last_ts}}</span>
      <span class="chev">▾</span>
    </div>
    <div class="sys-body">
      <div class="beat-rail">
        <span class="rail-cap">RECENT</span>
        <div class="now"></div>
        {% for b in p.beats %}
        <div class="beat {{'newest' if b.newest}}"><span class="bar" style="height:{{b.h}}px{% if b.newest %};background:var({{p.beat_color}}){% endif %}"></span><span class="bt">{{b.ts}}</span></div>
        {% endfor %}
      </div>
      <div class="notes">
        <div class="nrow"><span class="lab">现状</span><div class="val">{{p.ai.summary}}</div></div>
        <div class="nrow"><span class="lab">卡点</span>
          <ul class="blk">{% for b in p.ai.blockers %}<li>{{b}}</li>{% else %}<div class="val">暂无阻塞</div>{% endfor %}</ul>
        </div>
        <div class="decision">
          <span class="lab">建议</span>
          <span class="dtext" id="d-{{p.sid}}">{{p.ai.decision}}</span>
          <div class="dbtns">
            <button class="copy" onclick="navigator.clipboard.writeText(document.getElementById('d-{{p.sid}}').innerText)">复制</button>
            <button class="handoff" data-sid="{{p.sid}}">⚡ 接力</button>
          </div>
        </div>
        <div class="latest"><b>{{p.raw_ts}}</b>&ensp;{{p.raw_latest}}</div>      </div>
    </div>
  </section>
  {% endfor %}

  <div class="f-empty" id="f-empty">没有符合条件的声部。</div>

  <footer class="foot">
    <span>数据取自 Codex 本地转录 · AI 分析走 Claude Code 通道 · ⚡接力 = 开新窗口接手项目 · 点击声部头可折叠</span>
    <span>提示：想深入某项目日志，见会话原文 ~/.codex/sessions</span>
  </footer>
</div>
<script>
// 接力：点击按钮 → 生成简报 → 新窗口启动交互式 Claude 会话
document.querySelectorAll('.handoff').forEach(function(btn){
  btn.addEventListener('click', function(){
    var sid = btn.dataset.sid;
    btn.disabled = true;
    btn.textContent = '启动中…';
    fetch('/handoff', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:'sid='+encodeURIComponent(sid)})
      .then(function(r){ return r.text(); })
      .then(function(msg){
        btn.textContent = '已启动 ✓';
        setTimeout(function(){ btn.textContent = '⚡ 接力'; btn.disabled = false; }, 2500);
      })
      .catch(function(){
        btn.textContent = '失败';
        setTimeout(function(){ btn.textContent = '⚡ 接力'; btn.disabled = false; }, 2500);
      });
  });
});

// 折叠/展开：点击声部头切换；当前折叠状态存 sessionStorage
var sysSections = Array.prototype.slice.call(document.querySelectorAll('.system'));
sysSections.forEach(function(sec){
  var h = sec.querySelector('[data-toggle]');
  h.addEventListener('click', function(){
    sec.classList.toggle('collapsed');
    persistOpen();
    syncChips();
  });
});

// 筛选：全部 / 状态 / 折叠态 组合，隐藏不匹配；全部状态 chip 计数
var fchips = Array.prototype.slice.call(document.querySelectorAll('.fchip'));
var curF = 'all';   // 状态筛选
var curO = 'all';   // 折叠态筛选
fchips.forEach(function(ch){
  ch.addEventListener('click', function(){
    var f = ch.dataset.f;
    if (f === 'run' || f === 'think' || f === 'rep' || f === 'all') {
      curF = f;
      fchips.forEach(function(c){ if (['run','think','rep','all'].indexOf(c.dataset.f) >= 0) c.classList.toggle('on', c === ch); });
    } else {
      curO = f;
      fchips.forEach(function(c){ if (['open','done','all'].indexOf(c.dataset.f) >= 0) c.classList.toggle('on', c === ch); });
    }
    applyFilters();
  });
});

function persistOpen(){
  // 折叠的 sid 写进 cookie（30s 刷新后 Python 端据此恢复初始折叠态）
  var closed = sysSections.filter(function(s){ return s.classList.contains('collapsed'); })
    .map(function(s){ return s.dataset.sysId; });
  document.cookie = 'pgm_closed=' + encodeURIComponent(closed.join(',')) + '; path=/';
}
function applyFilters(){
  var q = (document.getElementById('fq').value || '').trim().toLowerCase();
  var visible = 0;
  sysSections.forEach(function(s){
    var show = true;
    if (curF !== 'all' && s.dataset.fState !== curF) show = false;
    if (show && curO !== 'all') {
      var isOpen = !s.classList.contains('collapsed');
      if ((curO === 'open' && !isOpen) || (curO === 'done' && isOpen)) show = false;
    }
    if (show && q && (s.querySelector('.sys-name').textContent.toLowerCase().indexOf(q) < 0)) show = false;
    s.style.display = show ? '' : 'none';
    if (show) visible++;
  });
  var msg = document.getElementById('f-empty');
  if (msg) msg.style.display = visible ? 'none' : '';
}
function syncChips(){
  ['open','done'].forEach(function(f){
    var ch = document.querySelector('.fchip[data-f="'+f+'"]');
    if (!ch) return;
    var n = sysSections.filter(function(s){
      var isOpen = !s.classList.contains('collapsed');
      return f === 'open' ? isOpen : !isOpen;
    }).length;
    ch.querySelector('.n').textContent = n;
  });
}
document.getElementById('fq').addEventListener('input', applyFilters);
syncChips();
</script>
</body></html>
"""


def launch_interactive(path, name="项目"):
    """在新窗口启动一个交互式 Claude Code 会话，注入接力简报文件。
    用 start 让窗口独立运行，不阻塞看板；窗口关闭不影响看板。
    启动即传初始消息：让 Claude 一开口就汇报，而不是空白等待。"""
    # 解析出目录 + 文件路径（去掉引号，避免嵌套引号问题）
    clean = path.strip('"')
    env = os.environ.copy()
    # 看板若由 Codex 链拉起会继承 CLAUDE_CODE_CHILD_SESSION（子会话标记），
    # 新 claude 窗口会因此关闭转录保存 → 清除标记并强制持久化
    env.pop("CLAUDE_CODE_CHILD_SESSION", None)
    env["CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"] = "1"
    # 初始消息：让 Claude 主动开口汇报
    greeting = f"请通读下方注入的项目接力简报（项目「{name}」），先不要执行任何操作，用 3-5 句话向我汇报这个项目的现状、卡点、待办，然后等待我的下一步指令。"
    return subprocess.Popen(
        ["cmd", "/c", "start", "", "cmd", "/k", "claude", "--append-system-prompt-file", clean, greeting],
        cwd=BASE_DIR,
        env=env,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


@app.route("/handoff", methods=["POST"])
def handoff():
    """项目接力：生成简报文件，在新窗口启动交互式 Claude 会话"""
    sid = request.form.get("sid", "")
    idx = pgm.load_index()
    projects = {p["sid"]: p for p in pgm.gather_projects(idx)}
    proj = projects.get(sid)
    if not proj:
        return "找不到项目", 404
    try:
        path, _ = pgm_handoff.write_brief(proj)
        launch_interactive(path, proj["name"][:40])
        return "已在窗口启动接力会话（简报注入完成）", 200
    except Exception as e:
        return f"接力失败: {e}", 500


def _sort_ts(p):
    """排序用时间键：最新汇报时间（ISO 字符串可直接比较），无则用索引时间"""
    msgs = p.get("msgs") or []
    return msgs[-1][0] if msgs else p.get("updated_at", "")


@app.route("/")
def index():
    idx = pgm.load_index()
    projects = pgm.gather_projects(idx)
    projects = [p for p in projects if p["name"].startswith("项目")]

    # 排序：活跃（运行 > 思考 > 待下一步）优先，其次最近更新（靠 reverse 实现最新在前）
    def sort_key(p):
        label, age, last_ts = status_of(p)
        state_cls, _ = STATUS.get(label, ("", label))
        return (STATE_ORDER.get(state_cls, 99), _sort_ts(p))
    projects.sort(key=sort_key, reverse=True)

    cards = []
    fcounts = {}
    for i, p in enumerate(projects):
        ai = analysis_for(p)
        label, age, last_ts = status_of(p)
        state_cls, state_label = STATUS.get(label, ("", label))
        beat_color = {"run": "--blue", "think": "--amber", "rep": "--green"}.get(state_cls, "--ink3")
        msgs = p["msgs"]
        cards.append({
            "sid": p["sid"],
            "fullname": p["name"],
            "name": short_name(p["name"]),
            "status": state_label,
            "state_cls": state_cls,
            "beat_color": beat_color,
            "age": age,
            "last_ts": last_ts[11:16],
            "ai": ai,
            "beats": build_beats(msgs),
            "raw_ts": msgs[-1][0][11:16] if msgs else "",
            "raw_latest": (msgs[-1][1].replace("\n", " ") if msgs else "")[:110],
        })
        fcounts[state_cls] = fcounts.get(state_cls, 0) + 1

    # 折叠态：cookie 里记录被折叠的 sid（刷新后恢复）
    from flask import request
    closed_sids = set()
    try:
        cookie = request.cookies.get("pgm_closed", "")
        if cookie:
            closed_sids = set(s for s in cookie.split(",") if s)
    except Exception:
        pass

    open_count = sum(1 for p in projects if p["sid"] not in closed_sids)
    closed_count = len(cards) - open_count

    from flask import render_template_string
    return render_template_string(
        TEMPLATE, projects=cards, count=len(cards),
        fcounts=fcounts, open_count=open_count, closed_count=closed_count,
        closed_sids=closed_sids,
        ts=datetime.now().strftime("%H:%M"),
    )


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5100
    threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
