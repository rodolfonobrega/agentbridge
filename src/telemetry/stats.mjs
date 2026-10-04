// Telemetry: per-run / per-session / global context accounting. Persists to <AGENTBRIDGE_HOME>/telemetry/.
// Honesty rule: every token figure carries {exact:boolean, source}. "exact" = a provider-reported prompt size of the
// LAST model call (session file or per-step usage event). Anything derived from aggregated run usage or chars/4 is an estimate.
import { spawnSync } from 'node:child_process';
import { unlinkSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, openSync, readSync, closeSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home, listRuns } from '../bridge/runs.mjs';
import { resolveBinary } from '../core/spawn.mjs';

export const telemetryDir = (env = process.env) => path.join(home(env), 'telemetry');
const sub = (env, n) => path.join(telemetryDir(env), n);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------- context windows ----------
// [agent, model regex, tokens]. First match wins. Session files can override (codex reports model_context_window).
export const DEFAULT_WINDOWS = [
  ['claude', /\[1m\]|1m/i, 1_000_000],
  ['claude', /.*/, 200_000],
  ['codex', /gpt-5|codex|o[34]/i, 258_400],
  ['codex', /.*/, 200_000],
  ['opencode', /gemini/i, 1_000_000],
  ['opencode', /claude|sonnet|opus|haiku/i, 200_000],
  ['opencode', /gpt-5/i, 272_000],
  ['opencode', /gpt-4\.1/i, 1_000_000],
  ['opencode', /.*/, 128_000],
  ['agy', /gemini/i, 1_000_000],
  ['agy', /claude/i, 200_000],
  ['agy', /.*/, 128_000],
  ['pi', /gemini/i, 1_000_000],
  ['pi', /claude|sonnet|opus|haiku/i, 200_000],
  ['pi', /gpt-5/i, 272_000],
  ['pi', /.*/, 128_000],
];

export function loadConfig(env = process.env) {
  try { return JSON.parse(readFileSync(path.join(telemetryDir(env), 'config.json'), 'utf8')); } catch { return {}; }
}
/** Persist a user override: setContextWindow('claude','opus',500000) or ('claude','*',...). Model key is a substring match. */
export function setContextWindow(agent, model, tokens, env = process.env) {
  if (!Number.isFinite(tokens) || tokens <= 0) throw new TypeError('tokens must be a positive number');
  const c = loadConfig(env); c.windows ||= {}; (c.windows[agent] ||= {})[model || '*'] = tokens;
  writeJson(path.join(telemetryDir(env), 'config.json'), c); return c.windows;
}
/** Pure: resolve window. overrides = {agent:{substr|'*':tokens}} (call-level beats persisted beats table). */
export function windowFor(agent, model, overrides = {}) {
  const o = overrides?.[agent];
  if (o) {
    const m = String(model || '').toLowerCase();
    const k = Object.keys(o).find((x) => x !== '*' && m.includes(x.toLowerCase()));
    if (k) return { tokens: o[k], source: 'override' };
    if (o['*']) return { tokens: o['*'], source: 'override' };
  }
  for (const [a, re, t] of DEFAULT_WINDOWS) if (a === agent && re.test(String(model || ''))) return { tokens: t, source: 'table' };
  return { tokens: 128_000, source: 'table' };
}
export const estimateTokens = (s) => Math.ceil(String(s ?? '').length / 4);

// ---------- io ----------
function writeJson(f, obj) {
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1));
  for (let i = 0; ; i++) { try { renameSync(tmp, f); return; } catch (e) { if (i > 20) throw e; } }
}
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const safe = (s) => String(s).replace(/[^\w.-]/g, '_');
const sessionFile = (env, agent, sid) => path.join(sub(env, 'sessions'), `${safe(agent)}__${safe(sid)}.json`);
const runFile = (env, id) => path.join(sub(env, 'runs'), `${safe(id)}.json`);

function tailLines(file, bytes = 400_000) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size, start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n'); if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally { closeSync(fd); }
}
function tailHead(file, bytes = 65_536) {
  const fd = openSync(file, 'r');
  try { const buf = Buffer.alloc(Math.min(bytes, statSync(file).size)); readSync(fd, buf, 0, buf.length, 0); return buf.toString('utf8').split('\n'); } finally { closeSync(fd); }
}
function findFile(root, pred, depth = 5) {
  let names; try { names = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const d of names) {
    const p = path.join(root, d.name);
    if (d.isDirectory()) { if (depth > 0) { const r = findFile(p, pred, depth - 1); if (r) return r; } } else if (pred(d.name)) return p;
  }
  return null;
}

// ---------- reading real session files ----------
/** Exact last-call context from the agent's own session file. Returns null if unavailable. homeDir overridable for tests. */
export function readSessionContext(agent, sessionId, { homeDir = homedir(), cwd } = {}) {
  if (!sessionId) return null;
  try {
    if (agent === 'claude') {
      const root = path.join(homeDir, '.claude', 'projects');
      let f = null;
      for (const d of readdirSync(root)) { const c = path.join(root, d, `${sessionId}.jsonl`); if (existsSync(c)) { f = c; break; } }
      if (!f) return null;
      const lines = tailLines(f);
      for (let i = lines.length - 1; i >= 0; i--) {
        let j; try { j = JSON.parse(lines[i]); } catch { continue; }
        if (j.type === 'user' && j.isCompactSummary) { // a /compact happened after the last model call: only the summary remains (estimate)
          const c = j.message?.content; const txt = typeof c === 'string' ? c : JSON.stringify(c || '');
          return { tokens: estimateTokens(txt), exact: false, source: 'claude-compact-summary-estimate', file: f };
        }
        const u = j.type === 'assistant' && j.message?.usage;
        if (u && j.message?.model !== '<synthetic>') {
          const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
          return { tokens, exact: true, source: 'claude-session-file', model: j.message.model, file: f };
        }
      }
    } else if (agent === 'opencode') {
      // `opencode export <sid>` -> JSON; context = last assistant message tokens (input + cache read/write + output). Exact (provider-reported).
      const bin = resolveBinary('opencode');
      if (!bin) return null;
      const r = spawnSync(bin, ['export', sessionId], { cwd: cwd || undefined, encoding: 'utf8', timeout: 25_000, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
      const i = (r.stdout || '').indexOf('{'); if (r.status !== 0 || i < 0) return null;
      const j = JSON.parse(r.stdout.slice(i)); const msgs = (j.messages || []).filter((m) => m.info?.role === 'assistant' && m.info.tokens);
      const last = msgs[msgs.length - 1]; if (!last) return null;
      const t = last.info.tokens;
      return { tokens: (t.input || 0) + (t.output || 0) + (t.cache?.read || 0) + (t.cache?.write || 0), exact: true, source: 'opencode-export', model: last.info.modelID ? `${last.info.providerID ? last.info.providerID + '/' : ''}${last.info.modelID}` : undefined };
    } else if (agent === 'codex') {
      const f = findFile(path.join(homeDir, '.codex', 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith(`${sessionId}.jsonl`));
      if (!f) return null;
      const lines = tailLines(f, 800_000);
      let model; // real model name from the last turn_context (adapter reports 'default')
      for (let i = lines.length - 1; i >= 0 && !model; i--) if (lines[i].includes('"turn_context"')) { try { model = JSON.parse(lines[i]).payload?.model; } catch { /* */ } }
      if (!model) { for (const ln of tailHead(f)) if (ln.includes('"turn_context"')) { try { model = JSON.parse(ln).payload?.model; } catch { /* */ } if (model) break; } }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('token_count')) continue;
        let j; try { j = JSON.parse(lines[i]); } catch { continue; }
        const info = j.payload?.info || j.info;
        const l = info?.last_token_usage;
        if (l) return { tokens: (l.input_tokens || 0) + (l.output_tokens || 0), exact: true, source: 'codex-session-file', window: info.model_context_window || null, model, file: f };
      }
    }
  } catch { /* fall through */ }
  return null;
}

// ---------- pure status ----------
/** run status: active (running, recent events) | idle (running but quiet > idleMs) | finished | error | timeout | cancelled | lost */
export function runStatus(rec, { now = Date.now(), idleMs = 30_000, isAlive = alive } = {}) {
  const st = rec.state;
  if (st === 'running') {
    if (rec.pid && !isAlive(rec.pid)) return 'lost';
    return now - rec.lastEventAt > idleMs ? 'idle' : 'active';
  }
  if (st === 'done') return 'finished';
  return st; // error | timeout | cancelled | lost
}
/** session status: active if any run active; idle if a run is in flight but quiet; finished if nothing in flight. */
export function sessionStatus(runStatuses) {
  if (runStatuses.includes('active')) return 'active';
  if (runStatuses.includes('idle')) return 'idle';
  return 'finished';
}

// ---------- tracker (one per run) ----------
const FILE_KEYS = ['file_path', 'filePath', 'path', 'notebook_path'];
export function createTracker({ agent, opts, env = process.env, origin = 'tracker' }) {
  const now = Date.now();
  const rec = {
    id: randomUUID().slice(0, 12), origin, agent, model: opts.model || null, cwd: opts.cwd || process.cwd(), pid: process.pid,
    sessionMode: opts.session?.mode || 'new', sessionId: opts.session?.id || null, state: 'running', startedAt: now, lastEventAt: now, endedAt: null,
    tools: { total: 0, byName: {} }, usage: null, lastUsage: null, usageEvents: 0, cost: null, promptChars: opts.prompt.length, outChars: 0,
    files: [], error: null, timedOut: false, promptHead: opts.prompt.slice(0, 400), textTail: '',
  };
  const pending = {}; let lastSave = 0, dirty = false;
  const save = (force) => { if (!force && Date.now() - lastSave < 300) { dirty = true; return; } lastSave = Date.now(); dirty = false; try { writeJson(runFile(env, rec.id), rec); } catch { /* telemetry must never break a run */ } };
  save(true);
  return {
    rec,
    onEvent(e) {
      rec.lastEventAt = Date.now();
      if (e.type === 'session') rec.sessionId = e.id;
      else if (e.type === 'text') { rec.outChars += String(e.delta).length; rec.textTail = (rec.textTail + e.delta).slice(-3000); }
      else if (e.type === 'usage') {
        rec.usageEvents++; rec.lastUsage = { input: e.input || 0, output: e.output || 0 };
        rec.usage = { input: (rec.usage?.input || 0) + (e.input || 0), output: (rec.usage?.output || 0) + (e.output || 0) };
        if (typeof e.cost === 'number') rec.cost = (rec.cost || 0) + e.cost;
      } else if (e.type === 'tool') {
        if (e.output === undefined || !pending[e.name]) { rec.tools.total++; rec.tools.byName[e.name] = (rec.tools.byName[e.name] || 0) + 1; if (e.output === undefined) pending[e.name] = (pending[e.name] || 0) + 1; }
        else pending[e.name]--;
        if (e.input && typeof e.input === 'object') for (const k of FILE_KEYS) { const v = e.input[k]; if (typeof v === 'string' && v && !rec.files.includes(v) && rec.files.length < 40) rec.files.push(v); }
      }
      save(e.type === 'session' || e.type === 'usage');
    },
    /** finish({result?, error?}) -> final run record (also folds into the session record). */
    finish({ result, error } = {}) {
      rec.endedAt = Date.now();
      if (result) {
        rec.state = result.timedOut ? 'timeout' : 'done'; rec.timedOut = !!result.timedOut;
        rec.sessionId = result.sessionId ?? rec.sessionId; rec.model = result.model ?? rec.model;
        if (result.usage) { rec.usage = { input: result.usage.input ?? rec.usage?.input ?? 0, output: result.usage.output ?? rec.usage?.output ?? 0 }; if (typeof result.usage.cost === 'number') rec.cost = result.usage.cost; }
        if (result.text && !rec.textTail) rec.textTail = String(result.text).slice(-3000);
        if (result.fallback?.used) rec.fallback = { used: result.fallback.used, attempts: (result.fallback.attempts || []).map((a) => ({ agent: a.agent, code: a.code })) };
      } else {
        rec.state = error?.code === 'TIMEOUT' ? 'timeout' : error?.code === 'ABORTED' ? 'cancelled' : 'error';
        rec.timedOut = rec.state === 'timeout'; rec.error = `${error?.code ? error.code + ': ' : ''}${error?.message || error}`;
      }
      save(true);
      if (rec.sessionId && rec.sessionMode !== 'ephemeral') { try { foldIntoSession(rec, env); } catch { /* ignore */ } }
      return rec;
    },
    flush() { if (dirty) save(true); },
  };
}

/** Cross-process mutex: O_EXCL lock file, stale after 15s. Read-modify-write of a session record happens inside it. */
function withLock(lockPath, fn) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const t0 = Date.now(); let fd = null;
  for (;;) {
    try { fd = openSync(lockPath, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try { if (Date.now() - statSync(lockPath).mtimeMs > 15_000) unlinkSync(lockPath); } catch { /* raced */ }
      if (Date.now() - t0 > 20_000) throw new Error('session lock timeout');
      sleep(10 + Math.random() * 30);
    }
  }
  try { return fn(); } finally { try { closeSync(fd); } catch { /* */ } try { unlinkSync(lockPath); } catch { /* */ } }
}

function foldIntoSession(run, env) {
  const f = sessionFile(env, run.agent, run.sessionId);
  return withLock(`${f}.lock`, () => foldLocked(run, env, f));
}
function foldLocked(run, env, f) {
  const s = readJson(f) || { agent: run.agent, sessionId: run.sessionId, firstAt: run.startedAt, runIds: [], runCount: 0, toolCalls: 0, toolsByName: {}, cost: null, runningMs: 0, files: [], firstPrompt: run.promptHead };
  s.model = run.model || s.model; s.cwd = run.cwd; s.lastAt = run.endedAt || Date.now();
  if (!s.runIds.includes(run.id)) {
    s.runIds = [...s.runIds, run.id].slice(-30); s.runCount++; s.toolCalls += run.tools.total; s.runningMs += (run.endedAt || Date.now()) - run.startedAt;
    for (const [k, v] of Object.entries(run.tools.byName)) s.toolsByName[k] = (s.toolsByName[k] || 0) + v;
    if (run.cost != null) s.cost = (s.cost || 0) + run.cost;
    for (const x of run.files) if (!s.files.includes(x) && s.files.length < 60) s.files.push(x);
    s.lastText = run.textTail; s.lastPrompt = run.promptHead;
  }
  s.lastRun = { id: run.id, state: run.state };
  // context: prefer the agent's own session file (exact); else provider per-step usage (opencode: exact last step); else aggregated estimate.
  s.ctx = computeCtx(run.agent, run.sessionId, run, s, env);
  writeJson(f, s);
}

function computeCtx(agent, sessionId, run, s, env, homeDir) {
  const file = readSessionContext(agent, sessionId, { homeDir });
  if (file) return { tokens: file.tokens, exact: file.exact, source: file.source, window: file.window || null, at: Date.now() };
  if (run?.lastUsage) {
    const u = run.lastUsage, t = u.input + u.output;
    if ((agent === 'opencode' || agent === 'agy' || agent === 'pi') && run.usageEvents > 0) return { tokens: t, exact: true, source: 'usage-event-last-step', at: Date.now() };
    // claude/codex adapters emit usage aggregated over the whole invocation: an upper bound of the true context, not exact.
    return { tokens: t, exact: false, source: 'usage-aggregate', at: Date.now() };
  }
  const chars = (run?.promptChars || 0) + (run?.outChars || 0);
  return { tokens: Math.max(estimateTokens('x'.repeat(chars)), s?.ctx?.tokens || 0), exact: false, source: 'chars/4', at: Date.now() };
}

// ---------- queries ----------
export function listSessions(env = process.env) {
  let names = []; try { names = readdirSync(sub(env, 'sessions')).filter((n) => n.endsWith('.json')); } catch { /* none */ }
  return names.map((n) => readJson(path.join(sub(env, 'sessions'), n))).filter(Boolean);
}
export function listTrackedRuns(env = process.env) {
  let names = []; try { names = readdirSync(sub(env, 'runs')).filter((n) => n.endsWith('.json')); } catch { /* none */ }
  return names.map((n) => readJson(path.join(sub(env, 'runs'), n))).filter(Boolean);
}
export function loadTrackedRun(id, env = process.env) { return readJson(runFile(env, id)); }

function ctxView(s, { env, homeDir, windows, refresh = true }) {
  let ctx = s.ctx;
  let realModel = null;
  if (refresh) { const f = readSessionContext(s.agent, s.sessionId, { homeDir, cwd: s.cwd }); if (f) { realModel = f.model || null; ctx = { tokens: f.tokens, exact: f.exact, source: f.source, window: f.window || null, at: Date.now() }; } }
  if (!s.model || s.model === 'default') s = { ...s, model: realModel || s.model };
  const w = ctx?.window && !windows?.[s.agent] ? { tokens: ctx.window, source: 'session-file' } : windowFor(s.agent, s.model, windows);
  let win = w.tokens, wsrc = w.source;
  if (ctx && ctx.tokens > win && wsrc !== 'override') { win = Math.max(win, 1_000_000); wsrc += '+observed>window'; }
  const tokens = ctx?.tokens ?? 0;
  return { sessionId: s.sessionId, agent: s.agent, model: s.model || null, tokens, exact: !!ctx?.exact, source: ctx?.source || 'none', window: win, windowSource: wsrc, pct: win ? +(tokens / win).toFixed(4) : null, measuredAt: ctx?.at || null };
}

/** Context of one session. contextOf(sessionId, {agent?}) -> {tokens, exact, source, window, pct, ...} or null if unknown. */
export function contextOf(sessionId, { agent, env = process.env, homeDir, windows } = {}) {
  const cfg = { ...(loadConfig(env).windows || {}), ...(windows || {}) };
  let s = listSessions(env).find((x) => x.sessionId === sessionId && (!agent || x.agent === agent));
  if (!s) { // maybe a session made outside agentbridge: read files directly
    const cands = agent ? [agent] : ['claude', 'codex'];
    for (const a of cands) { const f = readSessionContext(a, sessionId, { homeDir }); if (f) s = { agent: a, sessionId, model: f.model || null, ctx: { tokens: f.tokens, exact: f.exact, source: f.source, window: f.window, at: Date.now() } }; if (s) break; }
    if (!s) { const b = listRuns(env).find((r) => r.sessionId === sessionId && (!agent || r.agent === agent)); if (b) s = { agent: b.agent, sessionId, model: b.model, ctx: b.usage ? { tokens: (b.usage.input || 0) + (b.usage.output || 0), exact: false, source: 'usage-aggregate', at: b.endedAt || Date.now() } : null }; }
  }
  return s ? ctxView(s, { env, homeDir, windows: cfg }) : null;
}

/**
 * Global on-demand stats. Persists <home>/telemetry/stats.json.
 * opts: {sinceMs (only sessions touched within, default 24h), idleMs, windows, homeDir, env}
 */
export function stats({ env = process.env, homeDir, idleMs = 30_000, sinceMs = 24 * 3600_000, windows, persist = true, now = Date.now(), runLimit = 200 } = {}) {
  const cfg = { ...(loadConfig(env).windows || {}), ...(windows || {}) };
  const tracked = listTrackedRuns(env);
  const seen = new Set(tracked.map((r) => r.id));
  // also fold in bridge (async) runs from ~/.agentbridge/runs that were not launched through the tracker
  const bridge = listRuns(env).filter((r) => !seen.has(r.id)).map((r) => ({ id: r.id, agent: r.agent, model: r.model, cwd: r.cwd, pid: r.pid, sessionId: r.sessionId, state: r.state === 'done' ? 'done' : r.state, startedAt: r.startedAt, lastEventAt: r.lastEventAt, endedAt: r.endedAt, tools: { total: (r.events || []).filter((e) => e.type === 'tool').length, byName: {}, partial: true }, usage: r.usage, cost: r.usage?.cost ?? null, error: r.error, origin: 'bridge' }));
  const runs = [...tracked, ...bridge].map((r) => {
    const status = runStatus(r, { now, idleMs });
    return { id: r.id, agent: r.agent, model: r.model, sessionId: r.sessionId, status, origin: r.origin || 'tracker', startedAt: r.startedAt, elapsedMs: (r.endedAt || now) - r.startedAt, lastEventAgoMs: r.endedAt ? null : now - r.lastEventAt, toolCalls: r.tools?.total ?? 0, toolCallsPartial: !!r.tools?.partial, toolsByName: r.tools?.byName || {}, usage: r.usage || null, cost: r.cost ?? null, error: r.error || null, endedAt: r.endedAt || null, cwd: r.cwd || null, fallback: r.fallback || null };
  }).sort((a, b) => b.startedAt - a.startedAt);

  const bySession = new Map();
  for (const s of listSessions(env)) bySession.set(`${s.agent}/${s.sessionId}`, s);
  for (const r of runs) if (r.sessionId && r.origin === 'bridge' && !bySession.has(`${r.agent}/${r.sessionId}`)) bySession.set(`${r.agent}/${r.sessionId}`, { agent: r.agent, sessionId: r.sessionId, model: r.model, lastAt: r.startedAt + r.elapsedMs, runCount: 1, toolCalls: r.toolCalls, cost: r.cost, runningMs: r.elapsedMs, ctx: r.usage ? { tokens: (r.usage.input || 0) + (r.usage.output || 0), exact: false, source: 'usage-aggregate' } : null });
  // in-flight runs also need a session row even before the first fold
  for (const r of runs) if (r.sessionId && !bySession.has(`${r.agent}/${r.sessionId}`) && (r.status === 'active' || r.status === 'idle')) bySession.set(`${r.agent}/${r.sessionId}`, { agent: r.agent, sessionId: r.sessionId, model: r.model, lastAt: now, runCount: 0, toolCalls: 0, runningMs: 0, ctx: null });

  const sessions = [...bySession.values()].filter((s) => now - (s.lastAt || 0) <= sinceMs || runs.some((r) => r.sessionId === s.sessionId && (r.status === 'active' || r.status === 'idle'))).map((s) => {
    const c = ctxView(s, { env, homeDir, windows: cfg });
    const mine = runs.filter((r) => r.sessionId === s.sessionId && r.agent === s.agent);
    const status = sessionStatus(mine.map((r) => r.status));
    return { ...c, status, runs: s.runCount || mine.length, toolCalls: s.toolCalls || 0, runningMs: s.runningMs || 0, cost: s.cost ?? null, lastAt: s.lastAt || null, cwd: s.cwd || null, files: (s.files || []).length };
  }).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  const agentsAgg = {};
  for (const s of sessions) {
    const a = (agentsAgg[s.agent] ||= { sessions: 0, contextTokens: 0, exactTokens: 0, estimatedTokens: 0, windowTokens: 0, active: 0, toolCalls: 0, cost: null, runs: 0 });
    a.sessions++; a.contextTokens += s.tokens; s.exact ? (a.exactTokens += s.tokens) : (a.estimatedTokens += s.tokens); a.windowTokens += s.window || 0; if (s.status === 'active') a.active++;
    a.toolCalls += s.toolCalls; a.runs += s.runs; if (s.cost != null) a.cost = (a.cost || 0) + s.cost;
  }
  for (const a of Object.values(agentsAgg)) a.pct = a.windowTokens ? +(a.contextTokens / a.windowTokens).toFixed(4) : null;
  const total = sessions.reduce((t, s) => ({ tokens: t.tokens + s.tokens, exact: t.exact + (s.exact ? s.tokens : 0), est: t.est + (s.exact ? 0 : s.tokens), win: t.win + (s.window || 0) }), { tokens: 0, exact: 0, est: 0, win: 0 });
  const hot = sessions.filter((s) => s.pct != null && s.pct >= 0.7).sort((a, b) => b.pct - a.pct);
  const hot0 = [...sessions].filter((s) => s.pct != null).sort((a, b) => b.pct - a.pct)[0];
  const global = {
    contextTokens: total.tokens, exactTokens: total.exact, estimatedTokens: total.est, allExact: total.est === 0, windowTokens: total.win,
    // No summed-window percentage (independent windows do not add up). Use per-agent pct, and the most-loaded session:
    maxPct: hot0 ? hot0.pct : 0, maxPctSession: hot0 ? { agent: hot0.agent, sessionId: hot0.sessionId } : null, sessions: sessions.length,
    activeRuns: runs.filter((r) => r.status === 'active').length, idleRuns: runs.filter((r) => r.status === 'idle').length,
    cost: sessions.some((s) => s.cost != null) ? sessions.reduce((c, s) => c + (s.cost || 0), 0) : null,
    advice: hot.map((s) => `${s.agent}/${s.sessionId} at ${(s.pct * 100).toFixed(0)}% of window: compact or handoff to an agent with more headroom`),
  };
  const out = { generatedAt: now, sinceMs, global, agents: agentsAgg, sessions, runs: runs.slice(0, runLimit) };
  if (persist) { try { writeJson(path.join(telemetryDir(env), 'stats.json'), out); } catch { /* ignore */ } }
  return out;
}
