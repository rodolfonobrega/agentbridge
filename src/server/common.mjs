// Shared helpers for the OpenAI/Anthropic compat proxy. Two modes:
//  - API mode (default): the agents are PURE TEXT-COMPLETION backends (their own tools are disabled, read-only, throw-away cwd).
//  - agent mode (`agent/<model>` or `/agent/v1`): the agent runs with its own tools inside a sandbox copy of a project (see agent.mjs).
// Client-side tools (`tools` in the request) are served by tools/ (MCP bridge for claude, prompt emulation for the others).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { runTracked, agents, endpointNames, AgentError } from '../index.mjs';
import { globMatch } from './config.mjs';
import { callId } from './tools/emulate.mjs';

const run = (agent, opts) => runTracked(agent, opts, { origin: 'proxy' });

export class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error', code = null, retryAfter = null) { super(message); this.status = status; this.type = type; this.code = code; this.retryAfter = retryAfter; }
}
export const rid = (p) => p + randomBytes(12).toString('hex');
export const now = () => Math.floor(Date.now() / 1000);

// ---------- model routing ----------
const CLAUDE_ALIASES = new Set(['sonnet', 'haiku', 'opus', 'opusplan', 'best']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * name -> {agent, model, id, mode: 'api'|'agent', effort?}.
 * Accepts `agent/<model>` (agent mode), a `model(high)` / `model(16384)` effort suffix and config aliases.
 * ctx: {cfg: config holder, adapters: {name: adapterObject} (tests)}.
 */
export function resolveModel(name, ctx = {}, depth = 0) {
  if (typeof name !== 'string' || !name) throw new HttpError(400, 'model is required', 'invalid_request_error', 'missing_model');
  let m = name.trim();
  const alias = ctx.cfg?.get().aliases;
  if (alias && depth < 3) {
    const hit = Object.keys(alias).find((k) => k.toLowerCase() === m.toLowerCase());
    if (hit) return { ...resolveModel(alias[hit], ctx, depth + 1), id: name.trim() }; // `canonical` stays the real target (payload rules match on it)
  }
  let mode = 'api';
  if (/^agent\//i.test(m)) { mode = 'agent'; m = m.slice(6); }
  let effort;
  const sfx = /^(.*)\(([a-z0-9]+)\)$/i.exec(m);
  if (sfx) {
    const v = sfx[2].toLowerCase();
    if (EFFORTS.includes(v) || v === 'minimal' || v === 'none') effort = effortFrom(v);
    else if (/^\d+$/.test(v)) effort = effortFromBudget({ type: 'enabled', budget_tokens: Number(v) });
    else throw new HttpError(400, `Invalid effort suffix "(${sfx[2]})" in model "${name}"`, 'invalid_request_error', 'invalid_value');
    m = sfx[1];
  }
  const done = (t) => ({ ...t, id: name.trim(), canonical: name.trim(), mode, ...(effort ? { effort } : {}) });
  let mm;
  const ad = ctx.adapters;
  if (ad && (mm = /^([a-z][a-z0-9_]*)\/(.+)$/.exec(m)) && ad[mm[1]]) return done({ agent: ad[mm[1]], model: mm[2] });
  if ((mm = /^claude\/(.+)$/i.exec(m))) return done({ agent: 'claude', model: mm[1] });
  if ((mm = /^codex\/(.+)$/i.exec(m))) return done({ agent: 'codex', model: mm[1] });
  if ((mm = /^agy\/(.+)$/i.exec(m))) return done({ agent: 'agy', model: mm[1] });
  if ((mm = /^pi\/(.+)$/i.exec(m))) return done({ agent: 'pi', model: mm[1] });
  if ((mm = /^opencode\/(.+)$/i.exec(m))) return done({ agent: 'opencode', model: mm[1].includes('/') ? mm[1] : m });
  const l = m.toLowerCase();
  if ((mm = /^([a-z][a-z0-9_]*)\/(.+)$/.exec(l)) && endpointNames().includes(mm[1])) return done({ agent: mm[1], model: m.slice(mm[1].length + 1) });
  if (CLAUDE_ALIASES.has(l) || /^claude-/.test(l)) return done({ agent: 'claude', model: m });
  if (/^(gpt-|codex|o[134](-|$)|chatgpt)/.test(l)) return done({ agent: 'codex', model: l === 'codex' ? undefined : m });
  if (m.includes('/')) return done({ agent: 'opencode', model: m });
  throw new HttpError(404, `The model \`${name}\` does not exist. Use claude/<model>, codex/<model>, agy/<model>, pi/<provider>/<model>, opencode/<provider>/<model> or an alias (sonnet, haiku, opus, gpt-5-codex). Prefix with agent/ for agent mode; add (low|medium|high|max) to set the effort.`, 'invalid_request_error', 'model_not_found');
}

/** resolveModel + the /agent/v1 base path forcing agent mode. */
export function pickTarget(model, opts, req) {
  const t = resolveModel(model, opts);
  if (req?.abMode === 'agent') t.mode = 'agent';
  return t;
}

/** Config payload rules: `defaults` fill what the request left unset, `override` always wins. Fields: effort, system. */
export function applyPayloadRules(cfg, id, o) {
  const out = { ...o };
  for (const r of cfg?.get().payload || []) {
    if (!globMatch(r.match, id)) continue;
    for (const [k, v] of Object.entries(r.defaults || {})) if (out[k] == null) out[k] = v;
    for (const [k, v] of Object.entries(r.override || {})) out[k] = v;
  }
  return out;
}

let modelCache = { at: 0, list: null };
export async function listModels() {
  if (modelCache.list && Date.now() - modelCache.at < 60000) return modelCache.list;
  const out = [];
  const add = (id) => { if (!out.includes(id)) out.push(id); };
  await Promise.all(agents.names.map(async (n) => {
    try {
      const ms = await Promise.race([agents.models(n), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 20000))]);
      for (const x of ms) add(n === 'opencode' ? (x.startsWith('opencode/') ? x : 'opencode/' + x) : `${n}/${x}`);
    } catch { /* best-effort */ }
  }));
  for (const a of ['claude/haiku', 'claude/sonnet', 'claude/opus']) add(a);
  out.sort();
  modelCache = { at: Date.now(), list: out };
  return out;
}

// ---------- effort ----------
export function effortFrom(v) {
  if (v == null || v === 'none') return undefined;
  if (v === 'minimal') return 'low';
  if (typeof v === 'string' && EFFORTS.includes(v)) return v;
  throw new HttpError(400, `Invalid reasoning effort "${v}"`, 'invalid_request_error', 'invalid_value');
}
export function effortFromBudget(t) {
  if (!t || t.type === 'disabled' || !Number.isFinite(t.budget_tokens)) return undefined;
  const b = t.budget_tokens;
  return b <= 2048 ? 'low' : b <= 8192 ? 'medium' : b <= 24576 ? 'high' : 'max';
}

/** Conversation key from the x-ab-session header (scoped to the caller's credentials so clients never share a session). */
export function sessionKeyOf(req) {
  const h = req?.headers?.['x-ab-session'];
  if (typeof h !== 'string' || !h.trim()) return undefined;
  const who = createHash('sha256').update(String(req.headers.authorization || req.headers['x-api-key'] || '')).digest('hex').slice(0, 12);
  return who + ':' + h.trim().slice(0, 128);
}

// ---------- request parameters ----------
const IGNORED = ['temperature', 'top_p', 'top_k', 'seed', 'presence_penalty', 'frequency_penalty', 'logprobs', 'top_logprobs', 'logit_bias', 'metadata', 'service_tier', 'store', 'parallel_tool_calls', 'prompt_cache_key', 'safety_identifier'];
/**
 * maxTokens/stop are enforced by the proxy (the CLIs cannot); the sampling knobs the CLIs cannot honour are accepted, ignored
 * and reported in the `x-agentbridge-ignored` header so apps that always send them (GEPA, LiteLLM...) keep working.
 */
export function readParams(body) {
  const mt = body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens;
  const maxTokens = Number.isInteger(mt) && mt > 0 ? mt : undefined;
  const st = body.stop ?? body.stop_sequences;
  const stop = (Array.isArray(st) ? st : st == null ? [] : [st]).filter((s) => typeof s === 'string' && s.length > 0).slice(0, 8);
  const ignored = IGNORED.filter((k) => body[k] != null && !(k === 'parallel_tool_calls' || k === 'store') && !(k === 'logprobs' && body[k] === false));
  return { maxTokens, stop, ignored };
}
export const warnHeaders = (w) => (w ? { 'x-agentbridge-warning': String(w).replace(/[^ -~]/g, ' ').slice(0, 300) } : {});
export const ignoredHeaders = (ignored) => (ignored?.length ? { 'x-agentbridge-ignored': ignored.join(',') } : {});

/** Streaming text limiter: stops at the first stop sequence (even split across chunks) or after ~maxTokens (chars/4). */
export function createLimiter({ maxTokens, stop = [] } = {}) {
  const maxChars = maxTokens ? maxTokens * 4 : Infinity;
  const hold = stop.length ? Math.max(...stop.map((s) => s.length)) - 1 : 0;
  let emitted = 0, pending = '';
  const cap = (out, reason, stopSequence) => {
    const room = maxChars - emitted;
    if (out.length > room) { out = out.slice(0, Math.max(0, room)); emitted += out.length; return { out, done: { reason: 'length' } }; }
    emitted += out.length;
    return { out, done: reason ? { reason, stopSequence } : null };
  };
  return {
    push(d) {
      const buf = pending + d; pending = '';
      let hit = -1, hs;
      for (const s of stop) { const i = buf.indexOf(s); if (i >= 0 && (hit < 0 || i < hit)) { hit = i; hs = s; } }
      if (hit >= 0) return cap(buf.slice(0, hit), 'stop', hs);
      if (hold) { pending = buf.slice(Math.max(0, buf.length - hold)); return cap(buf.slice(0, Math.max(0, buf.length - hold))); }
      return cap(buf);
    },
    /** release the text held back for stop-sequence detection (the stream ended without a match) */
    flush() { const p = pending; pending = ''; return cap(p); },
  };
}

// ---------- prompt building ----------
const NO_TOOLS = 'You are a plain text-completion backend behind an API. Do NOT use any tools, read files, run commands or browse; answer directly from the conversation.';
/** turns: [{role:'user'|'assistant'|'tool', text}]. budgetTokens>0 drops the oldest turns that do not fit (the last turn always stays). */
export function buildPrompt(turns, budgetTokens = 0) {
  const last = turns[turns.length - 1];
  if (turns.length === 1 && last.role === 'user') return last.text;
  const lab = { user: 'User', assistant: 'Assistant', tool: 'Tool result' };
  let use = turns, dropped = 0;
  if (budgetTokens > 0) {
    let used = est(last.text), from = turns.length - 1;
    while (from > 0 && used + est(turns[from - 1].text) <= budgetTokens) { from--; used += est(turns[from].text); }
    dropped = from; use = turns.slice(from);
  }
  const head = dropped ? `Conversation so far (${dropped} earlier message${dropped > 1 ? 's' : ''} omitted):\n\n` : 'Conversation so far:\n\n';
  return head + use.map((t) => `${lab[t.role] || t.role}: ${t.text}`).join('\n\n') + "\n\nWrite the assistant's next reply.";
}
/** The turns after the last assistant turn (what a resumed session has not seen yet). */
export function incrementalPrompt(turns) {
  let i = turns.length;
  while (i > 0 && turns[i - 1].role !== 'assistant') i--;
  const tail = turns.slice(i);
  return tail.length ? buildPrompt(tail) : buildPrompt(turns.slice(-1));
}
export function joinSystem(parts, extra = [], mode = 'api') { return [mode === 'agent' ? '' : NO_TOOLS, ...parts, ...extra].filter(Boolean).join('\n\n'); }

/**
 * Shared streaming driver. Calls onStart() lazily right before the first delta (so pre-output errors can still
 * produce a proper HTTP status), onDelta(text) per chunk. Returns the run result; never swallows errors.
 */
export async function drive(o, { onStart, onDelta }) {
  const it = runAgent(o);
  let started = false;
  for (;;) {
    const x = await it.next();
    if (x.done) { if (!started) { started = true; onStart(); } return x.value; }
    if (!started) { started = true; onStart(); }
    onDelta(x.value.delta);
  }
}

// ---------- running ----------
let cwd;
const sessions = new Map(); // key -> {agent, id}
export const est = (s) => Math.ceil((s || '').length / 4);
const HOLD = Symbol('hold');
const FINISH = { end_turn: 'stop', stop_sequence: 'stop', stop: 'stop', max_tokens: 'length', length: 'length', tool_use: 'tool_calls', tool_calls: 'tool_calls', refusal: 'content_filter' };

/**
 * Stream an agent run. Yields {type:'text',delta}; returns {text, usage, sessionId, finishReason, stopSequence}.
 * o: {target, prompt, incremental, systemPrompt, effort, jsonSchema, sessionKey, signal, timeoutMs, maxTokens, stop, fallback,
 *     mode, cwd, permissions, env, holdMs, holdChars}
 * finishReason is 'stop' | 'length' | 'tool_calls' | 'content_filter'.
 */
export async function* runAgent(o) {
  const isAgent = o.mode === 'agent';
  if (!isAgent) cwd ||= mkdtempSync(path.join(tmpdir(), 'agentbridge-proxy-'));
  const { agent, model } = o.target;
  const aname = typeof agent === 'string' ? agent : agent.name;
  const t0 = Date.now();
  const tried = new Set(); // pool accounts that already failed with RATE_LIMITED for this request
  let acct = o.pool?.pick(aname, o.sessionKey, tried) ?? null;
  if (o.pool?.has(aname) && !acct) throw new AgentError('RATE_LIMITED', `every ${aname} account is cooling down`, { retryAfterMs: o.pool.retryAfterMs(aname) });
  const keyOf = () => (o.sessionKey ? `${aname}:${acct ? acct.name + ':' : ''}${o.sessionKey}` : null);
  let key = keyOf(), known = key && sessions.get(key);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (o.signal?.aborted) ac.abort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
  const base = { systemPrompt: o.systemPrompt, cwd: isAgent ? o.cwd : cwd, permissions: isAgent ? (o.permissions || 'edit') : 'read-only', signal: ac.signal, timeoutMs: o.timeoutMs || 300000 };
  if (model) base.model = model;
  if (o.mcpServers) base.mcpServers = o.mcpServers;
  if (o.images?.length) base.images = o.images;
  if (o.jsonSchema) base.jsonSchema = o.jsonSchema;
  if (aname === 'claude' && !isAgent) base.extraArgs = ['--tools', ''];
  const holdMs = o.holdMs ?? (o.fallback?.length ? 1500 : 0), holdChars = o.holdChars ?? 160;
  let effort = o.effort, emptyRetried = false;
  try {
    for (;;) {
      const more = acct ? o.pool.available(aname, new Set([...tried, acct.name])) > 0 : 0; // another account to try before leaving for a fallback agent
      const env = o.env || acct ? { ...o.env, ...acct?.env } : null;
      const opts = { ...base, prompt: known && o.incremental ? o.incremental : o.prompt, session: key ? (known ? { mode: 'continue', id: known.id } : { mode: 'new' }) : { mode: 'ephemeral' }, ...(env ? { env } : {}), ...(o.fallback?.length && !more ? { fallback: o.fallback } : {}), ...(effort ? { effort } : {}) };
      const lim = createLimiter({ maxTokens: o.maxTokens, stop: o.stop });
      const toolCalls = [];
      let raw = '', sent = '', held = '', holding = holdMs > 0, holdSince = 0, sid, r, started = false, limited = null, nextP = null;
      const out = [];
      const give = (t) => { if (t) { sent += t; out.push(t); } };
      const release = () => { if (holding) { holding = false; if (held) { started = true; give(held); held = ''; } } };
      const route = (d) => { // returns true once a limit ended the output
        const x = lim.push(d);
        if (holding) { held += x.out; if (!holdSince) holdSince = Date.now(); if (held.length >= holdChars) release(); } else { if (x.out) started = true; give(x.out); }
        if (x.done) { limited = x.done; release(); return true; }
        return false;
      };
      const it = run(agent, opts);
      try {
        for (;;) {
          let x;
          if (!nextP) nextP = it.next();
          if (holding && held && holdSince) {
            let timer; const wait = new Promise((res) => { timer = setTimeout(() => res(HOLD), Math.max(0, holdMs - (Date.now() - holdSince))); });
            const v = await Promise.race([nextP, wait]); clearTimeout(timer);
            if (v === HOLD) { release(); for (const t of out.splice(0)) yield { type: 'text', delta: t }; continue; }
            x = v;
          } else x = await nextP;
          nextP = null;
          if (x.done) { r = x.value; break; }
          const e = x.value;
          if (e.type === 'session') sid = e.id;
          else if (e.type === 'text') { raw += e.delta; const stopNow = route(e.delta); for (const t of out.splice(0)) yield { type: 'text', delta: t }; if (stopNow) break; }
          else if (e.type === 'tool' && o.toolBridge) { // claude called one of the CLIENT's tools through the MCP stub: hand it to the client, stop the CLI
            if (e.output !== undefined) { if (toolCalls.length) { limited = { reason: 'tool_calls' }; release(); for (const t of out.splice(0)) yield { type: 'text', delta: t }; break; } }
            else if (e.name?.startsWith(o.toolBridge.prefix)) { const safe = e.name.slice(o.toolBridge.prefix.length); toolCalls.push({ id: callId(), name: o.toolBridge.names.get(safe) || safe, arguments: e.input && typeof e.input === 'object' ? e.input : {} }); }
          } else if (e.type === 'fallback') {
            if (e.code === 'RATE_LIMITED' && acct && e.from === aname) o.pool.fail(aname, acct.name, e);
            if (started) throw new AgentError('RATE_LIMITED', `${e.from} failed mid-stream (${e.code}): ${e.message}`); // text already sent to the client cannot be unsent
            raw = ''; held = ''; holdSince = 0; // nothing was sent yet: the next agent starts clean
          }
        }
      } catch (err) {
        if (acct && !started && err?.code === 'RATE_LIMITED' && !o.signal?.aborted) { // this account is limited: try the next one
          o.pool.fail(aname, acct.name, err); tried.add(acct.name);
          const next = o.pool.pick(aname, o.sessionKey, tried);
          if (next) { acct = next; key = keyOf(); known = key && sessions.get(key); continue; }
        }
        if (!started && effort && err?.code === 'BAD_OPTION' && /effort|variant/i.test(err.message)) { effort = undefined; continue; }
        if (!started && !emptyRetried && err?.code === 'AGENT_FAILED' && /empty response/i.test(err.message) && !o.signal?.aborted) { emptyRetried = true; continue; }
        throw err;
      } finally {
        if (limited) ac.abort();
        if (limited || !r) it.return?.()?.catch?.(() => {});
      }
      if (!limited) { // reconcile with the adapter's final text, then release anything held back
        if (r?.text && r.text.length > raw.length) { const tail = r.text.slice(raw.length); raw = r.text; route(tail); }
        if (!limited) { const f = lim.flush(); release(); if (f.out) { started = true; give(f.out); } if (f.done) limited = f.done; }
        for (const t of out.splice(0)) yield { type: 'text', delta: t };
      }
      sid = r?.sessionId || sid;
      if (acct) o.pool.ok(aname, acct.name);
      if (key && sid) sessions.set(key, { agent: aname, id: sid });
      const u = !limited && r?.usage ? r.usage : {};
      const finishReason = toolCalls.length ? 'tool_calls' : limited ? (limited.reason === 'length' ? 'length' : 'stop') : (FINISH[r?.stopReason] || 'stop');
      const usage = { input: u.input ?? est(o.prompt), output: u.output ?? est(sent) };
      o.stats?.record({ agent: aname, model: model || null, account: acct?.name ?? null, mode: isAgent ? 'agent' : 'api', finish: finishReason, ms: Date.now() - t0, ...usage });
      return {
        text: sent,
        usage,
        sessionId: sid, model: r?.model, finishReason, ...(limited?.stopSequence ? { stopSequence: limited.stopSequence } : {}),
        ...(r?.stopReason ? { stopReason: r.stopReason } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      };
    }
  } finally {
    o.signal?.removeEventListener?.('abort', onAbort);
  }
}
export async function runToEnd(o) {
  const it = runAgent(o);
  for (;;) { const x = await it.next(); if (x.done) return x.value; }
}

export function mapError(e) {
  if (e instanceof HttpError) return e;
  const c = e?.code;
  const m = String(e?.message || e);
  if (c === 'BAD_OPTION') return new HttpError(400, m, 'invalid_request_error', 'bad_option');
  if (c === 'NOT_LOGGED_IN') return new HttpError(401, m, 'authentication_error', 'agent_not_logged_in');
  if (c === 'NOT_INSTALLED') return new HttpError(503, m, 'api_error', 'agent_not_installed');
  if (c === 'RATE_LIMITED') return new HttpError(429, m, 'rate_limit_error', 'rate_limited', e?.retryAfterMs != null ? Math.max(1, Math.ceil(e.retryAfterMs / 1000)) : null);
  if (c === 'TIMEOUT') return new HttpError(504, m, 'api_error', 'timeout');
  if (c === 'ABORTED') return new HttpError(499, m, 'api_error', 'aborted');
  return new HttpError(502, m, 'api_error', 'agent_failed');
}

// ---------- http helpers ----------
export async function readJson(req, limit = 20 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new HttpError(413, 'Request body too large'); chunks.push(c); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}
export function sendJson(res, status, body, headers = {}) {
  const b = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...headers });
  res.end(b);
}
export function sseStart(res, headers = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no', ...headers });
  res.flushHeaders?.();
}
export const sseData = (res, obj, event) => res.write((event ? `event: ${event}\n` : '') + `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
/** AbortSignal that fires when the client goes away before we finish. */
export function clientAbort(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  return ac.signal;
}
export function contentText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => typeof p === 'string' ? p : p.type === 'text' || p.type === 'input_text' || p.type === 'output_text' ? p.text : p.type === 'image_url' || p.type === 'image' || p.type === 'input_image' ? '[image]' : '').filter(Boolean).join('\n');
  return String(c.text ?? '');
}
