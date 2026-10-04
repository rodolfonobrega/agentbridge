// Hooks: agents report back when done. Events: start | finish | error | timeout | context-threshold ('*' = all).
// Hook kinds: {command,args?,timeoutMs?} | {file:dir} | {http:'http://127.0.0.1:PORT/path'} (loopback only) | {fn} or a bare function.
// Guarantees: fire() never throws and never outlives its per-hook timeout (command is killed, http destroyed, fn abandoned);
// a failing hook never affects the run. Global config: <home>/hooks.json  {"finish":[{"command":"...","args":[]}], ...}
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { home } from '../bridge/runs.mjs';
import { runCollect } from '../core/spawn.mjs';
import { loadTrackedRun, listTrackedRuns, runStatus } from './stats.mjs';

export const HOOK_EVENTS = ['start', 'finish', 'error', 'timeout', 'context-threshold'];
export const bus = new EventEmitter(); bus.setMaxListeners(0);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Pure: build the run summary handed to every hook / waiter. */
export function summaryOf(rec, event, extra = {}) {
  return {
    event, runId: rec.id, agent: rec.agent, model: rec.model || null, sessionId: rec.sessionId || null, status: runStatus(rec),
    state: rec.state, startedAt: rec.startedAt, endedAt: rec.endedAt || null, elapsedMs: (rec.endedAt || Date.now()) - rec.startedAt,
    toolCalls: rec.tools?.total ?? 0, usage: rec.usage || null, cost: rec.cost ?? null, error: rec.error || null,
    resultPreview: String(rec.textTail || '').slice(-1000), files: rec.files || [], ...extra,
  };
}

/** Pure: normalize a hooks config ({event: spec|spec[]}) into {event: [spec...]}. Invalid specs are dropped with a note. */
export function normalizeHooks(cfg) {
  const out = {}; const problems = [];
  for (const [ev, v] of Object.entries(cfg || {})) {
    if (ev !== '*' && !HOOK_EVENTS.includes(ev)) { problems.push(`unknown event ${ev}`); continue; }
    out[ev] = [];
    for (const s of Array.isArray(v) ? v : [v]) {
      if (typeof s === 'function') out[ev].push({ fn: s });
      else if (s && typeof s === 'object' && (typeof s.command === 'string' || typeof s.file === 'string' || typeof s.http === 'string' || typeof s.fn === 'function')) out[ev].push(s);
      else problems.push(`invalid hook for ${ev}`);
    }
  }
  return { hooks: out, problems };
}
export function loadGlobalHooks(env = process.env) {
  try { return JSON.parse(readFileSync(path.join(home(env), 'hooks.json'), 'utf8')); } catch { return {}; }
}
export function mergeHooks(...cfgs) {
  const out = {};
  for (const c of cfgs) for (const [k, v] of Object.entries(normalizeHooks(c).hooks)) out[k] = [...(out[k] || []), ...v];
  return out;
}

const withTimeout = (p, ms, label) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ ok: false, error: `${label} timed out after ${ms}ms`, timedOut: true }), ms);
  p.then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); resolve({ ok: false, error: String(e?.message || e) }); });
});

function httpPost(url, body, ms) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ ok: false, error: 'bad url' }); }
    if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) return resolve({ ok: false, error: 'webhook must be http to loopback (127.0.0.1/localhost/::1)' });
    const req = http.request({ hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port, path: u.pathname + u.search, method: 'POST', agent: false, timeout: ms, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' } }, (res) => {
      res.resume(); res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode })); res.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: `http timed out after ${ms}ms`, timedOut: true }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
}

async function runOne(spec, event, summary, ms) {
  const t0 = Date.now(); let r;
  try {
    const fn = spec.fn;
    if (fn) r = await withTimeout(Promise.resolve().then(() => fn(summary, event)).then(() => ({ ok: true })), ms, 'callback');
    else if (spec.command) {
      const body = JSON.stringify(summary);
      r = await withTimeout(runCollect(spec.command, spec.args || [], { input: body, timeoutMs: spec.timeoutMs || ms, env: { ...process.env, AB_EVENT: event, AB_RUN_ID: summary.runId, AB_AGENT: summary.agent, AB_STATUS: summary.status, AB_SESSION_ID: summary.sessionId || '', ...(spec.env || {}) } })
        .then((c) => ({ ok: c.exitCode === 0 && !c.timedOut, exitCode: c.exitCode, timedOut: !!c.timedOut, ...(c.exitCode ? { error: `exit ${c.exitCode}: ${String(c.stderr || '').slice(0, 300)}` } : {}) })), (spec.timeoutMs || ms) + 2000, 'command');
    } else if (spec.file) {
      const d = path.resolve(spec.file); mkdirSync(d, { recursive: true });
      const f = path.join(d, `${summary.runId}.${event}.json`), tmp = `${f}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(summary, null, 1)); renameSync(tmp, f); r = { ok: true, file: f };
    } else if (spec.http) r = await httpPost(spec.http, JSON.stringify(summary), spec.timeoutMs || ms);
    else r = { ok: false, error: 'empty hook' };
  } catch (e) { r = { ok: false, error: String(e?.message || e) }; }
  return { kind: spec.fn ? 'fn' : spec.command ? 'command' : spec.file ? 'file' : 'http', event, ms: Date.now() - t0, ...r };
}

/** Fire all hooks for an event concurrently. Never rejects. Resolves with per-hook results. Also emits on `bus`. */
export async function fire(event, summary, hooks, { timeoutMs = 10_000 } = {}) {
  try { bus.emit(event, summary); bus.emit('*', summary); } catch { /* listener errors must not propagate */ }
  const h = normalizeHooks(hooks).hooks;
  const specs = [...(h[event] || []), ...(h['*'] || [])];
  return Promise.all(specs.map((s) => runOne(s, event, summary, timeoutMs)));
}

const TERMINAL = new Set(['finished', 'error', 'timeout', 'cancelled', 'lost']);
/**
 * wait(idOrSessionId, {timeoutMs, pollMs}): resolves when the run (or the newest in-flight run of that session) reaches a
 * terminal state. Works in-process (bus) and across processes (polls the persisted record). Always resolves within timeoutMs:
 * on expiry -> {waitTimedOut:true, ...currentSummary}. Unknown id -> {notFound:true}.
 */
export function wait(id, { timeoutMs = 600_000, pollMs = 200, env = process.env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let timer, fin = false;
    const done = (v) => { if (fin) return; fin = true; clearTimeout(timer); resolve(v); };
    const find = () => {
      const byId = loadTrackedRun(id, env); if (byId) return byId;
      return listTrackedRuns(env).filter((r) => r.sessionId === id).sort((a, b) => b.startedAt - a.startedAt)[0] || null;
    };
    const tick = () => {
      const r = find();
      if (!r) { if (Date.now() - t0 > Math.min(timeoutMs, 3000)) return done({ notFound: true, id }); }
      else {
        const st = runStatus(r);
        if (TERMINAL.has(st)) return done(summaryOf(r, st === 'finished' ? 'finish' : st === 'timeout' ? 'timeout' : 'error'));
        if (Date.now() - t0 >= timeoutMs) return done({ ...summaryOf(r, 'wait'), waitTimedOut: true });
      }
      if (Date.now() - t0 >= timeoutMs) return done({ waitTimedOut: true, id });
      timer = setTimeout(tick, pollMs);
    };
    tick();
  });
}
export const waitAll = (ids, o) => Promise.all(ids.map((i) => wait(i, o)));
