// Shared helpers for the OpenAI/Anthropic compat proxy. The agents are modelled as PURE TEXT-COMPLETION
// backends: their own tools are disabled unless the request carries `tools` (then tool use is emulated via JSON).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runTracked, agents, endpointNames, AgentError } from '../index.mjs';

const run = (agent, opts) => runTracked(agent, opts, { origin: 'proxy' });

export class HttpError extends Error {
  constructor(status, message, type = 'invalid_request_error', code = null, retryAfter = null) { super(message); this.status = status; this.type = type; this.code = code; this.retryAfter = retryAfter; }
}
export const rid = (p) => p + randomBytes(12).toString('hex');
export const now = () => Math.floor(Date.now() / 1000);

// ---------- model routing ----------
const CLAUDE_ALIASES = new Set(['sonnet', 'haiku', 'opus', 'opusplan', 'best']);
export function resolveModel(name) {
  if (typeof name !== 'string' || !name) throw new HttpError(400, 'model is required', 'invalid_request_error', 'missing_model');
  const m = name.trim();
  let mm;
  if ((mm = /^claude\/(.+)$/i.exec(m))) return { agent: 'claude', model: mm[1], id: m };
  if ((mm = /^codex\/(.+)$/i.exec(m))) return { agent: 'codex', model: mm[1], id: m };
  if ((mm = /^agy\/(.+)$/i.exec(m))) return { agent: 'agy', model: mm[1], id: m };
  if ((mm = /^pi\/(.+)$/i.exec(m))) return { agent: 'pi', model: mm[1], id: m };
  if ((mm = /^opencode\/(.+)$/i.exec(m))) return { agent: 'opencode', model: mm[1].includes('/') ? mm[1] : m, id: m };
  const l = m.toLowerCase();
  if ((mm = /^([a-z][a-z0-9_]*)\/(.+)$/.exec(l)) && endpointNames().includes(mm[1])) return { agent: mm[1], model: m.slice(mm[1].length + 1), id: m };
  if (CLAUDE_ALIASES.has(l) || /^claude-/.test(l)) return { agent: 'claude', model: m, id: m };
  if (/^(gpt-|codex|o[134](-|$)|chatgpt)/.test(l)) return { agent: 'codex', model: l === 'codex' ? undefined : m, id: m };
  if (m.includes('/')) return { agent: 'opencode', model: m, id: m };
  throw new HttpError(404, `The model \`${name}\` does not exist. Use claude/<model>, codex/<model>, agy/<model>, pi/<provider>/<model>, opencode/<provider>/<model> or an alias (sonnet, haiku, opus, gpt-5-codex).`, 'invalid_request_error', 'model_not_found');
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
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
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

// ---------- prompt building ----------
const NO_TOOLS = 'You are a plain text-completion backend behind an API. Do NOT use any tools, read files, run commands or browse; answer directly from the conversation.';
export function rejectTools(body) {
  const has = (v) => Array.isArray(v) ? v.length > 0 : v != null;
  if (has(body.tools) || has(body.functions) || (body.tool_choice && body.tool_choice !== 'none' && body.tool_choice.type !== 'none')) {
    throw new HttpError(400, 'Client-side tool/function calling is not supported by the agentbridge proxy (the agents run their own tools). Remove `tools`/`functions`/`tool_choice`. See docs/PROXY.md.', 'invalid_request_error', 'tools_not_supported');
  }
}
/** turns: [{role:'user'|'assistant'|'tool', text}] */
export function buildPrompt(turns) {
  const last = turns[turns.length - 1];
  if (turns.length === 1 && last.role === 'user') return last.text;
  const lab = { user: 'User', assistant: 'Assistant', tool: 'Tool result' };
  return 'Conversation so far:\n\n' + turns.map((t) => `${lab[t.role] || t.role}: ${t.text}`).join('\n\n') + "\n\nWrite the assistant's next reply.";
}
export function joinSystem(parts, extra = []) { return [NO_TOOLS, ...parts, ...extra].filter(Boolean).join('\n\n'); }

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

/**
 * Stream an agent run. Yields {type:'text',delta}; returns {text, usage, sessionId}.
 * o: {target, prompt, systemPrompt, effort, jsonSchema, sessionKey, signal, timeoutMs}
 */
export async function* runAgent(o) {
  cwd ||= mkdtempSync(path.join(tmpdir(), 'agentbridge-proxy-'));
  const { agent, model } = o.target;
  const key = o.sessionKey ? `${agent}:${o.sessionKey}` : null;
  const known = key && sessions.get(key);
  const base = { prompt: o.prompt, systemPrompt: o.systemPrompt, cwd, permissions: 'read-only', signal: o.signal, timeoutMs: o.timeoutMs || 300000 };
  if (model) base.model = model;
  if (o.fallback?.length) base.fallback = o.fallback;
  if (o.jsonSchema) base.jsonSchema = o.jsonSchema;
  if (agent === 'claude') base.extraArgs = ['--tools', ''];
  base.session = key ? (known ? { mode: 'continue', id: known.id } : { mode: 'new' }) : { mode: 'ephemeral' };
  let effort = o.effort, emptyRetried = false;
  for (;;) {
    const opts = { ...base, ...(effort ? { effort } : {}) };
    let text = '', sid, r, started = false;
    const it = run(agent, opts);
    try {
      for (;;) {
        const x = await it.next();
        if (x.done) { r = x.value; break; }
        const e = x.value;
        if (e.type === 'session') sid = e.id;
        else if (e.type === 'text') { started = true; text += e.delta; yield e; }
        else if (e.type === 'fallback' && started) throw new AgentError('RATE_LIMITED', `${e.from} failed mid-stream (${e.code}): ${e.message}`); // text already sent to the client cannot be unsent
      }
    } catch (err) {
      if (!started && effort && err?.code === 'BAD_OPTION' && /effort|variant/i.test(err.message)) { effort = undefined; continue; }
      if (!started && !emptyRetried && err?.code === 'AGENT_FAILED' && /empty response/i.test(err.message) && !o.signal?.aborted) { emptyRetried = true; continue; }
      throw err;
    }
    sid = r?.sessionId || sid;
    if (key && sid) sessions.set(key, { agent, id: sid });
    const full = r?.text && r.text.length >= text.length ? r.text : text;
    if (full.length > text.length) yield { type: 'text', delta: full.slice(text.length) };
    const u = r?.usage || {};
    return { text: full, usage: { input: u.input ?? est(o.prompt), output: u.output ?? est(full) }, sessionId: sid, model: r?.model };
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
  if (Array.isArray(c)) return c.map((p) => typeof p === 'string' ? p : p.type === 'text' || p.type === 'input_text' || p.type === 'output_text' ? p.text : p.type === 'image_url' || p.type === 'image' || p.type === 'input_image' ? '[image omitted]' : '').filter(Boolean).join('\n');
  return String(c.text ?? '');
}
