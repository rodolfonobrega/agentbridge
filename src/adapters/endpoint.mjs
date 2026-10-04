// HTTP "endpoint" agents: any OpenAI-compatible (chat/completions) or Anthropic-compatible (messages) base URL, e.g. Ollama,
// vLLM, LM Studio, LiteLLM, OpenRouter, a remote gateway. Configured in <AGENTBRIDGE_HOME>/endpoints.json; `ollama` exists by default.
// These are plain chat models: no tools, no MCP, no filesystem access, so `permissions` cannot widen anything and is accepted as-is.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentError, retryAfterMs, retryHeaderMs } from '../core/errors.mjs';
import { ev } from '../core/events.mjs';
import { validateOptions } from '../index.mjs';
import { home } from '../bridge/runs.mjs';

export const BUILTIN = ['claude', 'codex', 'opencode', 'agy', 'pi'];
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENAI_EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
const busy = new Set();

export const endpointsFile = (env = process.env) => path.join(home(env), 'endpoints.json');

function ollamaBase(env) {
  const h = env.OLLAMA_HOST;
  if (!h) return 'http://127.0.0.1:11434/v1';
  const u = /^https?:\/\//i.test(h) ? h : `http://${h}`;
  return `${u.replace(/\/+$/, '')}/v1`;
}

function normalize(name, c) {
  const bad = (m) => new AgentError('BAD_OPTION', `endpoints.json "${name}": ${m}`);
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('must be an object');
  const type = c.type ?? 'openai';
  if (!['openai', 'anthropic'].includes(type)) throw bad('type must be "openai" or "anthropic"');
  if (typeof c.baseUrl !== 'string' || !/^https?:\/\//i.test(c.baseUrl)) throw bad('baseUrl must be an http(s) URL');
  if (c.headers != null && (typeof c.headers !== 'object' || Array.isArray(c.headers))) throw bad('headers must be an object');
  for (const k of ['apiKey', 'apiKeyEnv', 'defaultModel']) if (c[k] != null && typeof c[k] !== 'string') throw bad(`${k} must be a string`);
  return { name, type, baseUrl: c.baseUrl.replace(/\/+$/, ''), apiKey: c.apiKey, apiKeyEnv: c.apiKeyEnv, headers: c.headers || {}, defaultModel: c.defaultModel };
}

/** {name: cfg}. `ollama` is always present (OLLAMA_HOST honored) unless endpoints.json overrides it. A broken file throws BAD_OPTION. */
export function loadEndpoints(env = process.env) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(endpointsFile(env), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new AgentError('BAD_OPTION', `Cannot read ${endpointsFile(env)}: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentError('BAD_OPTION', `${endpointsFile(env)} must be a JSON object {name: {baseUrl,...}}`);
  const out = {};
  if (!raw.ollama) out.ollama = normalize('ollama', { baseUrl: ollamaBase(env) });
  for (const [n, c] of Object.entries(raw)) {
    if (!NAME_RE.test(n)) throw new AgentError('BAD_OPTION', `Invalid endpoint name "${n}": use lowercase letters, digits and underscore, starting with a letter`);
    if (BUILTIN.includes(n)) throw new AgentError('BAD_OPTION', `Endpoint name "${n}" is reserved for a built-in agent`);
    out[n] = normalize(n, c);
  }
  return out;
}

/** Names only; never throws (a broken file just yields the built-in `ollama`). */
export function endpointNames(env = process.env) {
  try { return Object.keys(loadEndpoints(env)); } catch { return ['ollama']; }
}

/** Add/replace an endpoint in endpoints.json. */
export function saveEndpoint(name, cfg, env = process.env) {
  if (!NAME_RE.test(name) || BUILTIN.includes(name)) throw new AgentError('BAD_OPTION', `Invalid or reserved endpoint name "${name}"`);
  normalize(name, cfg);
  let raw = {}; try { raw = JSON.parse(readFileSync(endpointsFile(env), 'utf8')); } catch { /* new file */ }
  raw[name] = cfg;
  const f = endpointsFile(env); mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(raw, null, 2)); renameSync(tmp, f);
  return raw;
}

const sessDir = (env) => path.join(home(env), 'endpoint-sessions');
function readSession(id, env) { try { return JSON.parse(readFileSync(path.join(sessDir(env), `${id}.json`), 'utf8')); } catch { return null; } }
function writeSession(rec, env) {
  mkdirSync(sessDir(env), { recursive: true });
  const f = path.join(sessDir(env), `${rec.id}.json`), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec)); renameSync(tmp, f);
}
function latestSession(endpoint, cwd, env) {
  let best;
  try {
    for (const f of readdirSync(sessDir(env))) {
      if (!f.endsWith('.json') || !UUID.test(f.slice(0, -5))) continue;
      const r = readSession(f.slice(0, -5), env);
      if (r && r.endpoint === endpoint && r.cwd === cwd && !busy.has(r.id) && (!best || r.updatedAt > best.updatedAt)) best = r;
    }
  } catch { /* none */ }
  return best;
}

const headersFor = (cfg, env) => {
  const key = cfg.apiKey || (cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined);
  const h = { 'content-type': 'application/json', ...cfg.headers };
  if (key) { if (cfg.type === 'anthropic') h['x-api-key'] = key; else h.authorization = `Bearer ${key}`; }
  if (cfg.type === 'anthropic') h['anthropic-version'] = '2023-06-01';
  return h;
};

async function* sse(res) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

export function makeEndpointAdapter(cfg) {
  const A = cfg.name;
  const bad = (m) => new AgentError('BAD_OPTION', m, { agent: A });
  const adapter = {
    name: A,
    efforts: cfg.type === 'openai' ? Object.keys(OPENAI_EFFORT) : [],
    config: cfg,
    async models(env = process.env) {
      try {
        const r = await fetch(`${cfg.baseUrl}/models`, { headers: headersFor(cfg, env), signal: AbortSignal.timeout(8000) });
        if (!r.ok) return cfg.defaultModel ? [cfg.defaultModel] : [];
        const j = await r.json();
        const l = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
        return l.length ? l : (cfg.defaultModel ? [cfg.defaultModel] : []);
      } catch { return cfg.defaultModel ? [cfg.defaultModel] : []; }
    },
    async *run(opts) {
      const o = validateOptions(opts);
      if (o.mcpServers && Object.keys(o.mcpServers).length) throw bad(`${A} is a plain chat endpoint: mcpServers is not supported`);
      if (o.extraArgs?.length) throw bad(`${A} is an HTTP endpoint: extraArgs is not supported`);
      if (o.effort != null && cfg.type !== 'openai') throw bad(`${A} (anthropic-type endpoint) does not support effort`);
      if (o.jsonSchema && cfg.type !== 'openai') throw bad(`${A} (anthropic-type endpoint) does not support jsonSchema`);
      const env = { ...process.env, ...(o.env || {}) };
      const model = o.model || cfg.defaultModel || (await adapter.models(env))[0];
      if (!model) throw bad(`${A}: no model given, no defaultModel configured and the endpoint lists none (set "model", or "defaultModel" in ${endpointsFile()})`);
      const cwd = path.resolve(o.cwd || process.cwd());
      const sess = o.session || { mode: 'new' };

      // ---- session resolution (history is stored locally; the endpoint itself is stateless)
      let prior = [], sid, srcId, claimed = null;
      if (sess.mode === 'continue' || sess.mode === 'fork') {
        if (sess.id && !UUID.test(sess.id)) throw bad('session.id must be a UUID');
        const rec = sess.id ? readSession(sess.id, env) : latestSession(A, cwd, env);
        if (!rec || rec.endpoint !== A) throw bad(sess.id ? `Unknown ${A} session "${sess.id}"` : `session mode "${sess.mode}" without id: no ${A} session for cwd ${cwd}`);
        prior = rec.messages; srcId = rec.id;
        if (sess.mode === 'continue') { if (busy.has(rec.id)) throw bad('session busy (in use by another continue)'); sid = rec.id; claimed = rec.id; busy.add(rec.id); }
        else sid = randomUUID();
      } else if (sess.mode === 'new') sid = randomUUID();

      const t0 = Date.now(), ac = new AbortController();
      let timedOut = false, userAbort = false;
      const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; ac.abort(); }, o.timeoutMs) : null;
      const onAbort = () => { userAbort = true; ac.abort(); };
      o.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (sid) yield ev.session(sid);
        const userMsg = { role: 'user', content: o.prompt };
        const msgs = [...prior, userMsg];
        const body = cfg.type === 'openai'
          ? { model, stream: true, stream_options: { include_usage: true }, messages: [...(o.systemPrompt ? [{ role: 'system', content: o.systemPrompt }] : []), ...msgs],
              ...(o.effort ? { reasoning_effort: OPENAI_EFFORT[o.effort] } : {}),
              ...(o.jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'output', schema: o.jsonSchema } } } : {}) }
          : { model, stream: true, max_tokens: 8192, messages: msgs, ...(o.systemPrompt ? { system: o.systemPrompt } : {}) };
        const url = cfg.type === 'openai' ? `${cfg.baseUrl}/chat/completions` : `${cfg.baseUrl}/v1/messages`;
        let res;
        try { res = await fetch(url, { method: 'POST', headers: headersFor(cfg, env), body: JSON.stringify(body), signal: ac.signal }); }
        catch (e) {
          if (timedOut) throw new AgentError('TIMEOUT', `${A} timed out after ${o.timeoutMs}ms`, { agent: A });
          if (userAbort || o.signal?.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: A });
          throw new AgentError('AGENT_FAILED', `Cannot reach ${A} at ${cfg.baseUrl}: ${e.cause?.code || e.message}${A === 'ollama' ? ' (is `ollama serve` running?)' : ''}`, { agent: A });
        }
        if (!res.ok) {
          const t = (await res.text().catch(() => '')).slice(0, 500);
          const msg = `${A} HTTP ${res.status}: ${t}`;
          yield ev.error(msg);
          const code = res.status === 429 || res.status === 529 ? 'RATE_LIMITED' : res.status === 401 || res.status === 403 ? 'NOT_LOGGED_IN' : (res.status === 404 || res.status === 400) && /model/i.test(t) ? 'BAD_OPTION' : 'AGENT_FAILED';
          throw new AgentError(code, msg, { agent: A, status: res.status, ...(code === 'RATE_LIMITED' ? { retryAfterMs: retryHeaderMs(res.headers.get('retry-after')) ?? retryAfterMs(t) } : {}) });
        }
        let text = '', usedModel = model, usage = null, inTok = 0, outTok = 0;
        try {
          for await (const data of sse(res)) {
            if (data === '[DONE]') break;
            let j; try { j = JSON.parse(data); } catch { continue; }
            if (j.error) { const m = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error); yield ev.error(m); throw new AgentError('AGENT_FAILED', `${A}: ${m}`, { agent: A }); }
            if (cfg.type === 'openai') {
              if (j.model) usedModel = j.model;
              const d = j.choices?.[0]?.delta;
              const th = d?.reasoning_content ?? d?.reasoning;
              if (th) yield ev.thinking(th);
              if (d?.content) { text += d.content; yield ev.text(d.content); }
              if (j.usage) usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
            } else {
              if (j.type === 'message_start') { usedModel = j.message?.model || usedModel; inTok = j.message?.usage?.input_tokens || 0; }
              else if (j.type === 'content_block_delta') {
                if (j.delta?.type === 'text_delta' && j.delta.text) { text += j.delta.text; yield ev.text(j.delta.text); }
                else if (j.delta?.type === 'thinking_delta' && j.delta.thinking) yield ev.thinking(j.delta.thinking);
              } else if (j.type === 'message_delta') outTok = j.usage?.output_tokens ?? outTok;
              else if (j.type === 'error') { const m = j.error?.message || 'stream error'; yield ev.error(m); throw new AgentError('AGENT_FAILED', `${A}: ${m}`, { agent: A }); }
            }
          }
        } catch (e) {
          if (e instanceof AgentError) throw e;
          if (timedOut) throw new AgentError('TIMEOUT', `${A} timed out after ${o.timeoutMs}ms`, { agent: A });
          if (userAbort || o.signal?.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: A });
          throw new AgentError('AGENT_FAILED', `${A} stream failed: ${e.message}`, { agent: A });
        }
        if (cfg.type === 'anthropic') usage = { input: inTok, output: outTok };
        if (!usage) usage = { input: Math.ceil((o.prompt.length + prior.reduce((n, m) => n + m.content.length, 0)) / 4), output: Math.ceil(text.length / 4), estimated: true };
        yield ev.usage(usage.input, usage.output);
        if (sid && sess.mode !== 'ephemeral') {
          writeSession({ id: sid, endpoint: A, model: usedModel, cwd, updatedAt: Date.now(), messages: [...msgs, { role: 'assistant', content: text }], ...(srcId && sess.mode === 'fork' ? { forkedFrom: srcId } : {}) }, env);
        }
        let structured;
        if (o.jsonSchema) { try { structured = JSON.parse(text); } catch { /* leave undefined: caller validates */ } }
        return { text, sessionId: sess.mode === 'ephemeral' ? undefined : sid, usage, exitCode: 0, model: usedModel, durationMs: Date.now() - t0, timedOut: false, ...(structured !== undefined ? { structured } : {}) };
      } finally {
        if (timer) clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        ac.abort();
        if (claimed) busy.delete(claimed);
      }
    },
  };
  return adapter;
}

export default makeEndpointAdapter;
