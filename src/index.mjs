import { AgentError, asRateLimited } from './core/errors.mjs';
import { ev } from './core/events.mjs';

export { AgentError, asRateLimited, retryAfterMs, looksRateLimited } from './core/errors.mjs';
export { ev } from './core/events.mjs';
import { loadEndpoints, endpointNames, makeEndpointAdapter } from './adapters/endpoint.mjs';
export { loadEndpoints, endpointNames, saveEndpoint, endpointsFile } from './adapters/endpoint.mjs';

const NAMES = ['claude', 'codex', 'opencode', 'agy', 'pi'];
const cache = new Map();

async function loadEndpoint(name) {
  const cfg = loadEndpoints()[name];
  if (!cfg) throw new AgentError('BAD_OPTION', `Unknown agent "${name}". Expected one of: ${[...NAMES, ...endpointNames()].join(', ')}`);
  return makeEndpointAdapter(cfg);
}

async function load(name) {
  if (!NAMES.includes(name)) return loadEndpoint(name);
  if (!cache.has(name)) {
    cache.set(name, import(`./adapters/${name}.mjs`).then((m) => m.default, (e) => {
      cache.delete(name);
      throw new AgentError('AGENT_FAILED', `Cannot load adapter "${name}": ${e.message}`);
    }));
  }
  return cache.get(name);
}

/** Lazy registry: agents.claude / agents.codex / agents.opencode are async getters; agents.get(name) too. */
export const agents = {
  builtin: NAMES,
  /** Built-in agents + HTTP endpoints from <AGENTBRIDGE_HOME>/endpoints.json (`ollama` always present). Read from disk on each access. */
  get names() { return [...NAMES, ...endpointNames()]; },
  get: load,
  get claude() { return load('claude'); },
  get codex() { return load('codex'); },
  get opencode() { return load('opencode'); },
  get agy() { return load('agy'); },
  get pi() { return load('pi'); },
  async models(name) { return (await load(name)).models(); },
};

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMS = ['read-only', 'edit', 'full', 'plan'];
const SESSION_MODES = ['new', 'ephemeral', 'continue', 'fork'];
const KNOWN = new Set(['prompt', 'model', 'effort', 'permissions', 'cwd', 'timeoutMs', 'signal', 'session', 'systemPrompt', 'mcpServers', 'env', 'jsonSchema', 'extraArgs', 'isolated', 'fallback', 'fallbackOn']);
const FALLBACK_ON = ['RATE_LIMITED', 'NOT_LOGGED_IN', 'NOT_INSTALLED', 'TIMEOUT', 'AGENT_FAILED'];
const bad = (m) => new AgentError('BAD_OPTION', m);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate + normalize RunOptions. Throws BAD_OPTION. Returns a new object with defaults applied. */
export function validateOptions(opts) {
  if (!isObj(opts)) throw bad('opts must be an object');
  for (const k of Object.keys(opts)) if (!KNOWN.has(k)) throw bad(`Unknown option "${k}"`);
  const o = { ...opts };
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) throw bad('prompt must be a non-empty string');
  for (const k of ['model', 'cwd', 'systemPrompt']) if (o[k] != null && typeof o[k] !== 'string') throw bad(`${k} must be a string`);
  if (o.effort != null && !EFFORT.includes(o.effort)) throw bad(`effort must be one of ${EFFORT.join('|')}`);
  if (o.permissions == null) o.permissions = 'read-only';
  else if (!PERMS.includes(o.permissions)) throw bad(`permissions must be one of ${PERMS.join('|')}`);
  if (o.timeoutMs != null && !(Number.isFinite(o.timeoutMs) && o.timeoutMs > 0)) throw bad('timeoutMs must be a positive number');
  if (o.signal != null && !(typeof o.signal === 'object' && typeof o.signal.aborted === 'boolean' && typeof o.signal.addEventListener === 'function')) throw bad('signal must be an AbortSignal');
  if (o.session != null) {
    if (!isObj(o.session) || !SESSION_MODES.includes(o.session.mode)) throw bad(`session.mode must be one of ${SESSION_MODES.join('|')}`);
    if (o.session.id != null && (typeof o.session.id !== 'string' || !o.session.id)) throw bad('session.id must be a non-empty string');
    if (o.session.id != null && (o.session.mode === 'new' || o.session.mode === 'ephemeral')) throw bad(`session.id is not allowed with mode "${o.session.mode}"`);
  }
  if (o.mcpServers != null) {
    if (!isObj(o.mcpServers)) throw bad('mcpServers must be an object');
    for (const [n, s] of Object.entries(o.mcpServers)) {
      if (!isObj(s) || typeof s.command !== 'string' || !s.command) throw bad(`mcpServers.${n}.command must be a string`);
      if (s.args != null && !(Array.isArray(s.args) && s.args.every((a) => typeof a === 'string'))) throw bad(`mcpServers.${n}.args must be string[]`);
      if (s.env != null && !isObj(s.env)) throw bad(`mcpServers.${n}.env must be an object`);
    }
  }
  if (o.env != null && !isObj(o.env)) throw bad('env must be an object');
  if (o.jsonSchema != null && !isObj(o.jsonSchema)) throw bad('jsonSchema must be an object');
  if (o.isolated != null && typeof o.isolated !== 'boolean') throw bad('isolated must be boolean');
  if (o.extraArgs != null && !(Array.isArray(o.extraArgs) && o.extraArgs.every((a) => typeof a === 'string'))) throw bad('extraArgs must be string[]');
  if (o.fallback != null) {
    if (!Array.isArray(o.fallback) || o.fallback.length > 5) throw bad('fallback must be an array of at most 5 agents');
    o.fallback = o.fallback.map(parseFallbackTarget);
  }
  if (o.fallbackOn != null) {
    if (!Array.isArray(o.fallbackOn) || !o.fallbackOn.length || o.fallbackOn.some((c) => !FALLBACK_ON.includes(c))) throw bad(`fallbackOn must be a non-empty subset of ${FALLBACK_ON.join('|')}`);
  }
  return o;
}

/** "codex", "ollama:glm-5.3-flash:cloud" (agent is everything before the FIRST colon) or {agent, model?} -> {agent, model?}. */
export function parseFallbackTarget(t) {
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    if (typeof t.agent !== 'string' || !t.agent || (t.model != null && typeof t.model !== 'string')) throw bad('fallback entries need a string "agent" (and optional string "model")');
    return { agent: t.agent, ...(t.model ? { model: t.model } : {}) };
  }
  if (typeof t !== 'string' || !t.trim()) throw bad('fallback entries must be "agent", "agent:model" or {agent, model}');
  const s = t.trim(), i = s.indexOf(':');
  return i < 0 ? { agent: s } : { agent: s.slice(0, i), ...(s.slice(i + 1) ? { model: s.slice(i + 1) } : {}) };
}

/** Stream normalized events; the generator's return value is the Result.
 *  options.fallback: agents to try, in order, when an attempt fails with a code in options.fallbackOn (default ['RATE_LIMITED']).
 *  A fallback attempt starts a NEW session on the next agent (conversation history is not transferable; result.fallback.contextLost
 *  says so), uses that entry's own model (never the failed agent's) and drops effort/extraArgs (agent-specific). If the failed
 *  attempt already ran tools under edit/full permissions the task is NOT repeated elsewhere: the original error is thrown with
 *  .fallbackSkipped set. */
export async function* run(agent, opts) {
  const o = validateOptions(opts);
  const { fallback = [], fallbackOn = ['RATE_LIMITED'], ...base } = o;
  const attempts = [];
  let cur = { agent, opts: base };
  for (let i = 0; ; i++) {
    let sideEffects = false;
    try {
      const it = attempt(cur.agent, cur.opts);
      for (;;) {
        const x = await it.next();
        if (x.done) return attempts.length ? { ...x.value, fallback: { used: cur.agent, attempts, contextLost: base.session?.mode === 'continue' || base.session?.mode === 'fork' } } : x.value;
        if (x.value.type === 'tool') sideEffects = true;
        yield x.value;
      }
    } catch (e) {
      const next = fallback[i];
      const eligible = e instanceof AgentError && fallbackOn.includes(e.code) && next && !base.signal?.aborted;
      if (!eligible) {
        if (attempts.length && e instanceof AgentError) e.fallback = { attempts: [...attempts, { agent: cur.agent, code: e.code, message: e.message }] };
        throw e;
      }
      if (sideEffects && base.permissions !== 'read-only' && base.permissions !== 'plan') {
        e.fallbackSkipped = `${cur.agent} already ran tools under "${base.permissions}" permissions; repeating the task on ${next.agent} could duplicate side effects`;
        throw e;
      }
      attempts.push({ agent: cur.agent, ...(cur.opts.model ? { model: cur.opts.model } : {}), code: e.code, message: e.message, ...(e.retryAfterMs != null ? { retryAfterMs: e.retryAfterMs } : {}) });
      yield ev.fallback(cur.agent, next.agent, e.code, e.message);
      const { extraArgs, effort, session, model, ...keep } = base;
      cur = { agent: next.agent, opts: { ...keep, ...(next.model ? { model: next.model } : {}), ...(session?.mode === 'ephemeral' ? { session } : {}) } };
    }
  }
}

async function* attempt(agent, o) {
  const adapter = typeof agent === 'string' ? await load(agent) : agent;
  if (!adapter || typeof adapter.run !== 'function') throw bad('agent must be a name or adapter object');
  if (o.signal?.aborted) throw new AgentError('ABORTED', 'Aborted before start');
  try { return yield* adapter.run(validateOptions(o)); } catch (e) { throw asRateLimited(e); }
}

/** Run to completion and return the Result. */
export async function ask(agent, opts) {
  const it = run(agent, opts);
  for (;;) {
    const { value, done } = await it.next();
    if (done) return value;
  }
}

// Telemetry / context policy / hooks (src/telemetry/*). Additive: run() and ask() are untouched.
export { runWithTelemetry, runTracked, askWithTelemetry, stats, contextOf, setContextWindow, setPolicy, getPolicy, handoff, compact, wait, waitAll } from './telemetry/index.mjs';

// Extras (src/extras/*): parallel (fanout/race), schema, worktree, budget, doctor.
export { fanout, race, parseTarget, execOne } from './extras/parallel.mjs';
export { validate as validateSchema, extractJson, askWithSchema } from './extras/schema.mjs';
export { withWorktree, runInWorktree, createSandbox } from './extras/worktree.mjs';
export { Budget, runBudgeted } from './extras/budget.mjs';
export { doctor } from './extras/doctor.mjs';

export default { agents, run, ask, AgentError };
