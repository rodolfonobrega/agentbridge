'use strict';
// agentbridge dashboard. All dynamic text goes through textContent (never innerHTML), so prompts/outputs cannot inject markup.
const $ = (s, r = document) => r.querySelector(s);
const TOKEN = new URLSearchParams(location.search).get('token');
const api = (u) => fetch(u, { cache: 'no-store', headers: TOKEN ? { authorization: 'Bearer ' + TOKEN } : {} });
const SVG = 'http://www.w3.org/2000/svg';
const state = { since: 86400000, agent: '', status: '', metric: 'runs', paused: false, data: null, openRun: null, timer: null, fails: 0 };
try { const s = JSON.parse(localStorage.getItem('ab-ui') || '{}'); if (s.since) state.since = s.since; if (s.theme) document.documentElement.dataset.theme = s.theme; } catch { /* storage may be unavailable */ }
const save = () => { try { localStorage.setItem('ab-ui', JSON.stringify({ since: state.since, theme: document.documentElement.dataset.theme || '' })); } catch { /* ignore */ } };

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const sv = (tag, attrs, ...kids) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); for (const c of kids.flat()) if (c) e.append(c); return e; };
const clear = (e) => { while (e.firstChild) e.removeChild(e.firstChild); return e; };

const fmtN = (n) => (n == null ? '–' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(0) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const fmtMs = (ms) => { if (ms == null) return '–'; if (ms < 1000) return Math.round(ms) + ' ms'; const s = ms / 1000; if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + ' s'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + String(Math.round(s % 60)).padStart(2, '0') + 's'; return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
const fmtPct = (x) => (x == null ? '–' : (x * 100).toFixed(x === 1 || x === 0 ? 0 : 1) + '%');
const fmtCost = (c) => (c == null ? '–' : '$' + (c < 1 ? c.toFixed(4) : c.toFixed(2)));
const fmtTime = (t) => { const d = new Date(t), now = new Date(); const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); return d.toDateString() === now.toDateString() ? hm : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + hm; };
const ago = (ms) => (ms == null ? '' : ms < 2000 ? 'just now' : fmtMs(ms) + ' ago');
const AC = { claude: 'var(--c-claude)', codex: 'var(--c-codex)', opencode: 'var(--c-opencode)', agy: 'var(--c-agy)', pi: 'var(--c-pi)', ollama: 'var(--c-ollama)' };
const hue = (n) => { let x = 0; for (const c of n) x = (x * 31 + c.charCodeAt(0)) % 360; return `hsl(${x} 60% 52%)`; };
const color = (a) => AC[a] || hue(String(a));
const agentTag = (a) => h('span', { class: 'agent-tag', style: `--ac:${color(a)}`, text: a });
const statusLabel = { finished: 'succeeded', error: 'failed', timeout: 'timed out', lost: 'lost', active: 'running', idle: 'quiet', cancelled: 'cancelled' };
const badge = (s) => h('span', { class: `badge s-${s}`, text: statusLabel[s] || s });
const isFailed = (r) => r.status === 'error' || r.status === 'timeout' || r.status === 'lost';
const runTokens = (r) => (r.usage ? (r.usage.input || 0) + (r.usage.output || 0) : null);

function kpi(label, value, sub, cls) { return h('div', { class: `kpi ${cls || ''}` }, h('div', { class: 'l', text: label }), h('div', { class: 'v', text: value }), h('div', { class: 's', text: sub || '' })); }

function render() {
  const d = state.data; if (!d) return;
  const sum = d.summary, tot = sum.total;
  // agent filter options
  const agents = Object.keys(sum.byAgent).sort(), sel = $('#agent');
  if ([...sel.options].slice(1).map((o) => o.value).join() !== agents.join()) { const cur = state.agent; clear(sel).append(h('option', { value: '', text: 'All agents' }), ...agents.map((a) => h('option', { value: a, text: a }))); sel.value = agents.includes(cur) ? cur : ''; state.agent = sel.value; }
  const A = state.agent, T = A ? sum.byAgent[A] || null : tot;
  const runs = d.runs.filter((r) => (!A || r.agent === A) && r.startedAt >= sum.since);

  // banner: context advice
  const b = $('#banner'); if (d.global.advice?.length) { b.hidden = false; b.textContent = d.global.advice.join(' · '); } else b.hidden = true;

  // KPIs
  const k = clear($('#kpis'));
  if (!T) { k.append(kpi('Runs', '0', 'no runs for this agent in the window')); } else {
    const tokens = T.tokensIn + T.tokensOut;
    k.append(
      kpi('Running now', String(T.running), T.running ? 'in flight' : 'idle', T.running ? 'accent' : ''),
      kpi('Runs', fmtN(T.runs), `${T.finished} ok · ${T.failed} failed${T.cancelled ? ' · ' + T.cancelled + ' cancelled' : ''}`),
      kpi('Success rate', fmtPct(T.successRate), T.successRate == null ? 'no finished runs yet' : 'of finished runs', T.successRate == null ? '' : T.successRate >= 0.9 ? 'ok' : T.successRate < 0.6 ? 'bad' : ''),
      kpi('Tokens', fmtN(tokens), `${fmtN(T.tokensIn)} in · ${fmtN(T.tokensOut)} out`),
      kpi('Cost reported', fmtCost(T.cost), T.cost == null ? 'agents here do not report cost' : 'only agents that report it'),
      kpi('Rescued by fallback', String(T.rescued), T.rateLimited ? `${T.rateLimited} hit a rate limit` : 'runs saved from a limit/outage', T.rescued ? 'ok' : ''),
      kpi('Median duration', fmtMs(T.medianMs), T.p95Ms != null ? `p95 ${fmtMs(T.p95Ms)}` : ''),
      kpi('Tool calls', fmtN(T.toolCalls), T.runs ? `${(T.toolCalls / T.runs).toFixed(1)} per run` : ''),
    );
  }

  // live runs
  const live = runs.filter((r) => r.status === 'active' || r.status === 'idle'), lr = clear($('#live-runs'));
  $('#live-count').textContent = live.length ? `${live.length} in flight` : '';
  if (!live.length) lr.append(h('div', { class: 'empty', text: 'Nothing is running right now.' }));
  for (const r of live) lr.append(h('button', { class: 'run-card', type: 'button', onclick: () => openRun(r.id) },
    h('span', { class: `dot ${r.status}` }), h('span', null, agentTag(r.agent), ' ', h('span', { class: 'muted', text: r.model || '' })), h('span', { class: 't', 'data-start': r.startedAt, text: fmtMs(Date.now() - r.startedAt) }),
    h('span', { class: 'sub', text: `${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'} · last event ${ago(r.lastEventAgoMs)} · ${r.origin}${r.cwd ? ' · ' + r.cwd : ''}` })));

  renderTimeline(sum);
  renderAgents(sum, A);
  renderContext(d, A);
  renderRuns(runs);
  renderList($('#tools'), sum.topTools.map((t) => [t.name, t.count]), 'No tool calls recorded.');
  renderList($('#origins'), Object.entries(sum.byOrigin).sort((a, b) => b[1] - a[1]), 'No runs yet.', { cli: 'ab CLI', proxy: 'OpenAI/Anthropic proxy', 'bridge-sync': 'MCP bridge (ask_*)', bridge: 'MCP bridge (dispatch_*)', tracker: 'library' });
}

function renderList(el, rows, empty, names = {}) {
  clear(el); if (!rows.length) return el.append(h('div', { class: 'empty', text: empty }));
  const max = Math.max(...rows.map((r) => r[1]));
  const box = h('div', { class: 'bars' });
  for (const [n, c] of rows) box.append(h('div', { class: 'bar-row' }, h('span', { class: 'name', title: n, text: names[n] || n }), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${(c / max) * 100}%` })), h('span', { class: 'val', text: fmtN(c) })));
  el.append(box);
}

function renderAgents(sum, A) {
  const el = clear($('#agents')), rows = Object.entries(sum.byAgent).filter(([a]) => !A || a === A);
  if (!rows.length) return el.append(h('div', { class: 'empty' }, 'No runs yet. Try ', h('code', { text: 'ab ask claude "hello"' })));
  const max = Math.max(1, ...rows.map(([, v]) => v.tokensIn + v.tokensOut));
  for (const [a, v] of rows.sort((x, y) => y[1].tokensIn + y[1].tokensOut - (x[1].tokensIn + x[1].tokensOut))) {
    const tk = v.tokensIn + v.tokensOut;
    el.append(h('div', { class: 'agent-row' },
      h('div', { class: 'bar-row' }, agentTag(a), h('div', { class: 'track' }, h('div', { class: 'fill', style: `--ac:${color(a)};width:${(tk / max) * 100}%` })), h('span', { class: 'val', text: fmtN(tk) + ' tok' })),
      h('div', { class: 'meta' }, ...[`${v.runs} run${v.runs === 1 ? '' : 's'}`, `success ${fmtPct(v.successRate)}`, `median ${fmtMs(v.medianMs)}`, `${v.toolCalls} tools`, v.cost != null ? `cost ${fmtCost(v.cost)}` : null, v.rescued ? `${v.rescued} rescued` : null, v.rateLimited ? `${v.rateLimited} rate-limited` : null].filter(Boolean).map((t) => h('span', { text: t })))));
  }
}

function renderContext(d, A) {
  const el = clear($('#context')), ss = d.sessions.filter((s) => s.pct != null && s.tokens > 0 && (!A || s.agent === A)).sort((a, b) => b.pct - a.pct).slice(0, 8);
  if (!ss.length) return el.append(h('div', { class: 'empty', text: 'No sessions with a known context size yet.' }));
  const box = h('div', { class: 'bars' });
  for (const s of ss) {
    const cls = s.pct >= 0.9 ? 'bad' : s.pct >= 0.7 ? 'warn' : '';
    box.append(h('div', { class: 'bar-row', title: `${s.agent} ${s.sessionId}` },
      h('span', { class: 'name' }, agentTag(s.agent)),
      h('div', { class: 'track' }, h('div', { class: `fill ${cls}`, style: `--ac:${color(s.agent)};width:${Math.max(1, Math.min(100, s.pct * 100))}%` }), h('i', { class: 'mark', style: 'left:70%' }), h('i', { class: 'mark', style: 'left:90%' })),
      h('span', { class: 'val' }, `${fmtN(s.tokens)} / ${fmtN(s.window)} `, s.exact ? null : h('span', { class: 'est', text: 'est.' }), ` ${fmtPct(s.pct)}`)));
  }
  el.append(box, h('div', { class: 'muted', style: 'margin-top:8px;font-size:12px', text: 'Marks at 70% (compact soon) and 90%.' }));
}

function renderTimeline(sum) {
  const el = clear($('#timeline')), tl = sum.timeline, W = 600, H = 190, P = { l: 34, r: 6, t: 8, b: 20 }, iw = W - P.l - P.r, ih = H - P.t - P.b;
  const tokens = state.metric === 'tokens';
  const val = (b) => (tokens ? [b.tokens, 0] : [b.ok, b.failed]);
  const max = Math.max(1, ...tl.map((b) => val(b)[0] + val(b)[1]));
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': tokens ? 'Tokens over time' : 'Runs over time' });
  for (let i = 0; i <= 3; i++) { const y = P.t + ih - (ih * i) / 3; svg.append(sv('line', { class: 'grid', x1: P.l, x2: W - P.r, y1: y, y2: y })); const t = sv('text', { class: 'ax', x: P.l - 4, y: y + 3, 'text-anchor': 'end' }); t.textContent = fmtN((max * i) / 3); svg.append(t); }
  const bw = iw / tl.length;
  tl.forEach((b, i) => {
    const [a, f] = val(b), x = P.l + i * bw + 1, w = Math.max(1, bw - 2), ha = (a / max) * ih, hf = (f / max) * ih;
    const title = sv('title'); title.textContent = `${fmtTime(b.t)} · ${tokens ? fmtN(b.tokens) + ' tokens' : `${b.ok} ok, ${b.failed} failed`}`;
    const g = sv('g'); g.append(title);
    if (a) g.append(sv('rect', { x, y: P.t + ih - ha - hf, width: w, height: ha, rx: 1.5, fill: tokens ? 'var(--accent)' : 'var(--ok)' }));
    if (f) g.append(sv('rect', { x, y: P.t + ih - hf, width: w, height: hf, rx: 1.5, fill: 'var(--bad)' }));
    svg.append(g);
  });
  [0, 0.5, 1].forEach((p) => { const t = sv('text', { class: 'ax', x: P.l + p * (iw - 1), y: H - 5, 'text-anchor': p === 0 ? 'start' : p === 1 ? 'end' : 'middle' }); t.textContent = fmtTime(sum.since + p * (sum.now - sum.since)); svg.append(t); });
  el.append(svg);
  const lg = clear($('#timeline-legend'));
  lg.append(...(tokens ? [h('span', null, h('i', { style: 'background:var(--accent)' }), 'tokens (in + out)')] : [h('span', null, h('i', { style: 'background:var(--ok)' }), 'succeeded'), h('span', null, h('i', { style: 'background:var(--bad)' }), 'failed')]));
}

function renderRuns(runs) {
  const f = state.status;
  const rows = runs.filter((r) => (f === 'ok' ? r.status === 'finished' : f === 'failed' ? isFailed(r) : f === 'rescued' ? !!r.fallback : true)).slice(0, 150);
  const tb = clear($('#runs tbody'));
  const empty = $('#empty'); empty.hidden = rows.length > 0;
  if (!rows.length) { clear(empty).append(runs.length ? 'No runs match this filter.' : h('div', null, 'No runs recorded in this window yet.', h('br'), 'Run something such as ', h('code', { text: 'ab ask claude "hello"' }), ' and it will show up here.')); }
  for (const r of rows) {
    const tk = runTokens(r), tr = h('tr', { tabindex: '0', onclick: () => openRun(r.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRun(r.id); } } },
      h('td', { text: fmtTime(r.startedAt) }),
      h('td', null, agentTag(r.agent), r.fallback ? [' ', h('span', { class: 'chip rescue', title: 'the primary hit a limit or failed; another agent answered', text: '→ ' + r.fallback.used })] : null),
      h('td', { class: 'muted', title: r.model || '', text: r.model || '–' }), h('td', null, h('span', { class: 'chip', text: r.origin })), h('td', null, badge(r.status)),
      h('td', { class: 'num', text: fmtMs(r.elapsedMs) }), h('td', { class: 'num', text: tk == null ? '–' : fmtN(tk) }), h('td', { class: 'num', text: String(r.toolCalls) + (r.toolCallsPartial ? '+' : '') }));
    tb.append(tr);
  }
}

async function openRun(id) {
  state.openRun = id; $('#drawer').hidden = false; $('#scrim').hidden = false;
  const body = clear($('#d-body')); body.append(h('div', { class: 'muted', text: 'Loading…' }));
  try {
    const r = await (await api('/api/run/' + encodeURIComponent(id))).json();
    if (r.error && !r.id) throw new Error(r.error);
    $('#d-title').textContent = `${r.agent}${r.model ? ' · ' + r.model : ''}`;
    clear(body);
    const dur = (r.endedAt || Date.now()) - r.startedAt;
    body.append(h('dl', { class: 'kv' },
      h('dt', { text: 'State' }), h('dd', null, badge(r.state === 'done' ? 'finished' : r.state === 'running' ? 'active' : r.state)),
      h('dt', { text: 'Started' }), h('dd', { text: fmtTime(r.startedAt) }), h('dt', { text: 'Duration' }), h('dd', { text: fmtMs(dur) }),
      h('dt', { text: 'Source' }), h('dd', { text: r.origin || 'bridge' }), h('dt', { text: 'Directory' }), h('dd', { class: 'mono', text: r.cwd || '–' }),
      h('dt', { text: 'Session' }), h('dd', { class: 'mono', text: r.sessionId || '–' }),
      h('dt', { text: 'Tokens' }), h('dd', { text: r.usage ? `${fmtN(r.usage.input)} in · ${fmtN(r.usage.output)} out` : '–' }),
      h('dt', { text: 'Cost' }), h('dd', { text: fmtCost(r.cost) }),
      r.fallback ? [h('dt', { text: 'Fallback' }), h('dd', { text: `answered by ${r.fallback.used} after ${r.fallback.attempts.map((a) => `${a.agent} ${a.code}`).join(', ')}` })] : null));
    if (r.error) body.append(h('div', { class: 'sec-t', text: 'Error' }), h('pre', { class: 'blk', text: r.error }));
    if (r.promptHead) body.append(h('div', { class: 'sec-t', text: 'Prompt (first 400 chars)' }), h('pre', { class: 'blk', text: r.promptHead }));
    if (r.textTail) body.append(h('div', { class: 'sec-t', text: 'Output (last chars)' }), h('pre', { class: 'blk', text: r.textTail }));
    const tools = Object.entries(r.tools?.byName || {});
    if (tools.length) body.append(h('div', { class: 'sec-t', text: `Tool calls (${r.tools.total})` }), h('div', null, tools.map(([n, c]) => h('span', { class: 'chip', style: 'margin-right:6px', text: `${n} × ${c}` }))));
    if (r.subagents?.length) {
      body.append(
        h('div', { class: 'sec-t', text: `Subagents (${r.subagents.length})` }),
        h('div', { class: 'bars' }, r.subagents.map((s) => h('div', { class: 'bar-row' },
          h('span', { class: 'name', text: `${s.name} [${s.state}]` }),
          h('span', { class: 'val muted', text: s.task ? (s.task.slice(0, 50) + (s.task.length > 50 ? '…' : '')) : s.id })
        )))
      );
    }
    if (r.files?.length) body.append(h('div', { class: 'sec-t', text: 'Files touched' }), h('pre', { class: 'blk', text: r.files.join('\n') }));
  } catch (e) { clear(body).append(h('div', { class: 'empty', text: 'Could not load this run: ' + e.message })); }
}
function closeRun() { state.openRun = null; $('#drawer').hidden = true; $('#scrim').hidden = true; }

async function tick() {
  if (state.paused || document.hidden) return schedule();
  try {
    const r = await api('/api/stats?since=' + state.since);
    if (r.status === 401) throw new Error('unauthorized (open the URL with ?token=…)');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.data = await r.json(); state.fails = 0;
    const l = $('#live'); l.className = 'live on'; l.lastChild.textContent = 'live · ' + new Date().toLocaleTimeString();
    render();
  } catch (e) { state.fails++; const l = $('#live'); l.className = 'live err'; l.lastChild.textContent = state.fails > 1 ? 'disconnected: ' + e.message : 'retrying…'; }
  schedule();
}
function schedule() { clearTimeout(state.timer); state.timer = setTimeout(tick, state.data && state.data.global.activeRuns ? 1500 : 3000); }

$('#since').value = String(state.since); if ($('#since').value !== String(state.since)) $('#since').value = '86400000';
$('#since').addEventListener('change', (e) => { state.since = +e.target.value; save(); tick(); });
$('#agent').addEventListener('change', (e) => { state.agent = e.target.value; render(); });
$('#pause').addEventListener('click', (e) => { state.paused = !state.paused; e.currentTarget.setAttribute('aria-pressed', String(state.paused)); e.currentTarget.textContent = state.paused ? 'Resume' : 'Pause'; const l = $('#live'); l.className = state.paused ? 'live' : 'live on'; if (state.paused) l.lastChild.textContent = 'paused'; else tick(); });
$('#theme').addEventListener('click', () => { const r = document.documentElement, cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); r.dataset.theme = cur === 'dark' ? 'light' : 'dark'; save(); });
document.querySelectorAll('[data-metric]').forEach((b) => b.addEventListener('click', () => { state.metric = b.dataset.metric; document.querySelectorAll('[data-metric]').forEach((x) => x.setAttribute('aria-selected', String(x === b))); if (state.data) renderTimeline(state.data.summary); }));
document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.status; document.querySelectorAll('[data-status]').forEach((x) => x.setAttribute('aria-selected', String(x === b))); render(); }));
$('#d-close').addEventListener('click', closeRun); $('#scrim').addEventListener('click', closeRun);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRun(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
setInterval(() => { document.querySelectorAll('.run-card .t[data-start]').forEach((e) => { e.textContent = fmtMs(Date.now() - +e.dataset.start); }); }, 1000);
tick();
