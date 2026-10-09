import { AgentError, asRateLimited } from './core/errors.js';
import { ev } from './core/events.js';
import { loadEndpoints, endpointNames, makeEndpointAdapter } from './adapters/endpoint.js';
import { AgentAdapter, AgentEvent, FallbackTarget, RunOptions, RunResult } from './types/index.js';
import { installIde } from './cli/install-ide.js';
import { SubagentRoster } from './bridge/subagent-roster.js';
import { resolvePermissionLevel } from './core/config.js';

export { AgentError, asRateLimited, retryAfterMs, looksRateLimited, rateLimitKind } from './core/errors.js';
export { ev } from './core/events.js';
export { loadEndpoints, endpointNames, saveEndpoint, endpointsFile } from './adapters/endpoint.js';
export {
  loadConfig,
  saveConfig,
  setConfigValue,
  getConfigValue,
  resetConfigValue,
  getDefaultPermissions,
  getPermissionsCeiling,
  resolvePermissionLevel,
  PERMISSION_RANK,
  PERMISSION_LEVELS,
} from './core/config.js';

const NAMES = ['claude', 'codex', 'opencode', 'agy', 'pi', 'cursor', 'grok', 'gemini', 'devin', 'acp'];
const cache = new Map<string, Promise<AgentAdapter>>();

async function loadEndpoint(name: string): Promise<AgentAdapter> {
  const cfg = loadEndpoints()[name];
  if (!cfg) {
    throw new AgentError('BAD_OPTION', `Unknown agent "${name}". Expected one of: ${[...NAMES, ...endpointNames()].join(', ')}`);
  }
  return makeEndpointAdapter(cfg);
}

async function load(name: string): Promise<AgentAdapter> {
  if (!NAMES.includes(name)) return loadEndpoint(name);
  if (!cache.has(name)) {
    cache.set(
      name,
      import(`./adapters/${name}.js`).then(
        (m) => m.default,
        (e) => {
          cache.delete(name);
          throw new AgentError('AGENT_FAILED', `Cannot load adapter "${name}": ${e.message}`);
        }
      )
    );
  }
  return cache.get(name)!;
}

/** Lazy registry */
export const agents = {
  builtin: NAMES,
  get names(): string[] {
    return [...NAMES, ...endpointNames()];
  },
  get: load,
  get claude(): Promise<AgentAdapter> {
    return load('claude');
  },
  get codex(): Promise<AgentAdapter> {
    return load('codex');
  },
  get opencode(): Promise<AgentAdapter> {
    return load('opencode');
  },
  get agy(): Promise<AgentAdapter> {
    return load('agy');
  },
  get pi(): Promise<AgentAdapter> {
    return load('pi');
  },
  get cursor(): Promise<AgentAdapter> {
    return load('cursor');
  },
  get grok(): Promise<AgentAdapter> {
    return load('grok');
  },
  get gemini(): Promise<AgentAdapter> {
    return load('gemini');
  },
  get devin(): Promise<AgentAdapter> {
    return load('devin');
  },
  get acp(): Promise<AgentAdapter> {
    return load('acp');
  },
  async models(name: string): Promise<string[]> {
    const a = await load(name);
    return a.models ? a.models() : [];
  },
};

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMS = ['read-only', 'edit', 'full', 'plan'];
const SESSION_MODES = ['new', 'ephemeral', 'continue', 'fork'];
const KNOWN = new Set([
  'prompt',
  'model',
  'effort',
  'permissions',
  'cwd',
  'timeoutMs',
  'signal',
  'session',
  'systemPrompt',
  'mcpServers',
  'env',
  'jsonSchema',
  'extraArgs',
  'isolated',
  'fallback',
  'fallbackOn',
  'images',
  'harness',
  'offline',
  'defaultPermissions',
  'transport',
  'appServer',
  'skills',
  'mcpPassthrough',
]);
const HARNESS_MODES = ['auto', 'claude', 'pi', 'none'];
const TRANSPORTS = ['cli', 'app-server', 'stdio', 'auto'];
const FALLBACK_ON = ['RATE_LIMITED', 'NOT_LOGGED_IN', 'NOT_INSTALLED', 'TIMEOUT', 'AGENT_FAILED'];
const bad = (m: string) => new AgentError('BAD_OPTION', m);
const isObj = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate + normalize RunOptions. Throws BAD_OPTION. Returns a new object with defaults applied. */
export function validateOptions(opts: RunOptions): RunOptions {
  if (!isObj(opts)) throw bad('opts must be an object');
  for (const k of Object.keys(opts)) {
    if (!KNOWN.has(k)) throw bad(`Unknown option "${k}"`);
  }
  const o: RunOptions = { ...opts };
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) throw bad('prompt must be a non-empty string');
  for (const k of ['model', 'cwd', 'systemPrompt'] as const) {
    if (o[k] != null && typeof o[k] !== 'string') throw bad(`${k} must be a string`);
  }
  if (o.effort != null && !EFFORT.includes(o.effort)) throw bad(`effort must be one of ${EFFORT.join('|')}`);
  const effectiveEnv = o.env ? { ...process.env, ...o.env } : process.env;
  const resolved = resolvePermissionLevel(o.permissions, {
    env: effectiveEnv,
    cwd: o.cwd || process.cwd(),
  });
  o.permissions = resolved.permissions;
  if (resolved.isDefault) {
    (o as any).defaultPermissions = true;
  }
  if (o.harness != null && !HARNESS_MODES.includes(o.harness)) {
    throw bad(`harness must be one of ${HARNESS_MODES.join('|')}`);
  }
  if (o.transport != null && !TRANSPORTS.includes(o.transport)) {
    throw bad(`transport must be one of ${TRANSPORTS.join('|')}`);
  }
  if (o.appServer != null && typeof o.appServer !== 'boolean') {
    throw bad('appServer must be a boolean');
  }
  if (o.offline != null && typeof o.offline !== 'boolean') {
    throw bad('offline must be a boolean');
  }
  if (o.timeoutMs != null && !(Number.isFinite(o.timeoutMs) && o.timeoutMs > 0)) {
    throw bad('timeoutMs must be a positive number');
  }
  if (
    o.signal != null &&
    !(
      typeof o.signal === 'object' &&
      typeof (o.signal as any).aborted === 'boolean' &&
      typeof o.signal.addEventListener === 'function'
    )
  ) {
    throw bad('signal must be an AbortSignal');
  }
  if (o.session != null) {
    if (!isObj(o.session) || !SESSION_MODES.includes(o.session.mode)) {
      throw bad(`session.mode must be one of ${SESSION_MODES.join('|')}`);
    }
    if (o.session.id != null && (typeof o.session.id !== 'string' || !o.session.id)) {
      throw bad('session.id must be a non-empty string');
    }
    if (o.session.id != null && (o.session.mode === 'new' || o.session.mode === 'ephemeral')) {
      throw bad(`session.id is not allowed with mode "${o.session.mode}"`);
    }
  }
  if (o.mcpServers != null) {
    if (!isObj(o.mcpServers)) throw bad('mcpServers must be an object');
    for (const [n, s] of Object.entries(o.mcpServers)) {
      if (!isObj(s) || typeof s.command !== 'string' || !s.command) {
        throw bad(`mcpServers.${n}.command must be a string`);
      }
      if (s.args != null && !(Array.isArray(s.args) && s.args.every((a) => typeof a === 'string'))) {
        throw bad(`mcpServers.${n}.args must be string[]`);
      }
      if (s.env != null && !isObj(s.env)) throw bad(`mcpServers.${n}.env must be an object`);
    }
  }
  if (o.env != null && !isObj(o.env)) throw bad('env must be an object');
  if (o.jsonSchema != null && !isObj(o.jsonSchema)) throw bad('jsonSchema must be an object');
  if (o.isolated != null && typeof o.isolated !== 'boolean') throw bad('isolated must be boolean');
  if (o.extraArgs != null && !(Array.isArray(o.extraArgs) && o.extraArgs.every((a) => typeof a === 'string'))) {
    throw bad('extraArgs must be string[]');
  }
  if (o.images != null) {
    if (
      !Array.isArray(o.images) ||
      o.images.length > 8 ||
      o.images.some(
        (i) =>
          !isObj(i) ||
          !/^image\/(png|jpe?g|gif|webp)$/i.test(i.mediaType || '') ||
          typeof i.data !== 'string' ||
          !i.data
      )
    ) {
      throw bad('images must be at most 8 items of {mediaType: image/png|jpeg|gif|webp, data: base64}');
    }
  }
  if (o.fallback != null) {
    if (!Array.isArray(o.fallback) || o.fallback.length > 5) throw bad('fallback must be an array of at most 5 agents');
    o.fallback = o.fallback.map(parseFallbackTarget as any);
  }
  if (o.fallbackOn != null) {
    if (
      !Array.isArray(o.fallbackOn) ||
      !o.fallbackOn.length ||
      o.fallbackOn.some((c) => !FALLBACK_ON.includes(c))
    ) {
      throw bad(`fallbackOn must be a non-empty subset of ${FALLBACK_ON.join('|')}`);
    }
  }
  return o;
}

/** "codex", "ollama:glm-5.3-flash:cloud" or {agent, model?} -> {agent, model?}. */
export function parseFallbackTarget(t: any): FallbackTarget {
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    if (typeof t.agent !== 'string' || !t.agent || (t.model != null && typeof t.model !== 'string')) {
      throw bad('fallback entries need a string "agent" (and optional string "model")');
    }
    return { agent: t.agent, ...(t.model ? { model: t.model } : {}) };
  }
  if (typeof t !== 'string' || !t.trim()) throw bad('fallback entries must be "agent", "agent:model" or {agent, model}');
  const s = t.trim(),
    i = s.indexOf(':');
  return i < 0 ? { agent: s } : { agent: s.slice(0, i), ...(s.slice(i + 1) ? { model: s.slice(i + 1) } : {}) };
}

/** Stream normalized events; the generator's return value is the Result. */
export async function* run(agent: string | AgentAdapter, opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
  const o = validateOptions(opts);
  const { fallback = [], fallbackOn = ['RATE_LIMITED'], ...base } = o;
  const attempts: any[] = [];
  let cur: { agent: string | AgentAdapter; opts: RunOptions } = { agent, opts: base };
  for (let i = 0; ; i++) {
    let sideEffects = false;
    try {
      const it = attempt(cur.agent, cur.opts);
      for (;;) {
        const x = await it.next();
        if (x.done) {
          return attempts.length
            ? {
                ...x.value,
                fallback: {
                  used: typeof cur.agent === 'string' ? cur.agent : cur.agent.name || 'agent',
                  attempts,
                  contextLost: base.session?.mode === 'continue' || base.session?.mode === 'fork',
                },
              }
            : x.value;
        }
        if (x.value.type === 'tool') sideEffects = true;
        yield x.value;
      }
    } catch (e: any) {
      const next = fallback[i] as any;
      const eligible = e instanceof AgentError && (fallbackOn as string[]).includes(e.code) && next && !base.signal?.aborted;
      if (!eligible) {
        if (attempts.length && e instanceof AgentError) {
          (e as any).fallback = {
            attempts: [
              ...attempts,
              { agent: typeof cur.agent === 'string' ? cur.agent : cur.agent.name || 'agent', code: e.code, message: e.message },
            ],
          };
        }
        throw e;
      }
      if (sideEffects && base.permissions !== 'read-only' && base.permissions !== 'plan') {
        const agentName = typeof cur.agent === 'string' ? cur.agent : cur.agent.name || 'agent';
        (e as any).fallbackSkipped = `${agentName} already ran tools under "${base.permissions}" permissions; repeating the task on ${next.agent || next} could duplicate side effects`;
        throw e;
      }
      const curAgentName = typeof cur.agent === 'string' ? cur.agent : cur.agent.name || 'agent';
      attempts.push({
        agent: curAgentName,
        ...(cur.opts.model ? { model: cur.opts.model } : {}),
        code: e.code,
        message: e.message,
        ...(e.retryAfterMs != null ? { retryAfterMs: e.retryAfterMs } : {}),
      });
      yield ev.fallback(curAgentName, next.agent || next, e.code, e.message);
      const { extraArgs, effort, session, model, ...keep } = base;
      void extraArgs;
      void effort;
      void session;
      void model;
      cur = {
        agent: next.agent,
        opts: {
          ...keep,
          ...(next.model ? { model: next.model } : {}),
          ...(session?.mode === 'ephemeral' ? { session } : {}),
        },
      };
    }
  }
}

async function* attempt(agent: string | AgentAdapter, o: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
  const adapter = typeof agent === 'string' ? await load(agent) : agent;
  if (!adapter || typeof adapter.run !== 'function') throw bad('agent must be a name or adapter object');
  if (o.signal?.aborted) throw new AgentError('ABORTED', 'Aborted before start');
  try {
    return yield* adapter.run(validateOptions(o));
  } catch (e) {
    throw asRateLimited(e);
  }
}

/** Run to completion and return the Result. */
export async function ask(agent: string | AgentAdapter, opts: RunOptions): Promise<RunResult> {
  const it = run(agent, opts);
  for (;;) {
    const { value, done } = await it.next();
    if (done) return value;
  }
}

// Telemetry
export {
  runWithTelemetry,
  runTracked,
  askWithTelemetry,
  stats,
  contextOf,
  setContextWindow,
  setPolicy,
  getPolicy,
  handoff,
  compact,
  wait,
  waitAll,
} from './telemetry/index.js';

// Extras
export { fanout, race, parseTarget, execOne } from './extras/parallel.js';
export { validate as validateSchema, extractJson, askWithSchema } from './extras/schema.js';
export { withWorktree, runInWorktree, createSandbox } from './extras/worktree.js';
export {
  createCheckpoint,
  listCheckpoints,
  rollbackCheckpoint,
  diffCheckpoint,
  deleteCheckpoint,
  type CheckpointInfo,
  type CheckpointOptions,
} from './extras/checkpoint.js';
export { Budget, runBudgeted } from './extras/budget.js';
export { doctor } from './extras/doctor.js';
export {
  autoRepair,
  type RepairOptions,
  type RepairResult,
  type RepairAttempt,
} from './extras/repair.js';
export {
  runReviewLoop,
  runEnsemble,
  parseReviewVerdict,
  type ReviewLoopOptions,
  type ReviewLoopResult,
  type ReviewVerdict,
  type TurnRecord,
  type EnsembleOptions,
  type EnsembleResult,
  type EnsembleAgentConfig,
  type AgentEnsembleOutput,
} from './extras/consensus.js';

// IDE MCP Installer
export {
  installIde,
  getIdeConfigPath,
  type InstallIdeOptions,
  type InstallIdeResult,
  type IdeTarget,
  type IdeScope,
} from './cli/install-ide.js';

// CommonMark boundary-aware streaming
export {
  splitBufferedAssistantText,
  createMarkdownStreamFilter,
  type MarkdownStreamFilter,
  type MarkdownStreamFilterOptions,
  type SplitResult,
} from './core/markdown-stream.js';

// Subagent Native Roster
export {
  SubagentRoster,
  type SubagentNode,
  type SubagentStatus,
  type TokenUsage,
  type RegisterSubagentOptions,
  type UpdateStatusOptions,
} from './bridge/subagent-roster.js';

// Project Memory
export {
  loadMemory,
  saveMemory,
  addRule,
  addDecision,
  setVariable,
  clearMemory,
  formatMemoryForPrompt,
  type ProjectMemory,
  type MemoryDecision,
} from './telemetry/memory.js';

// Proactive Quota Checking
export {
  fetchAnthropicUsage,
  fetchCodexUsage,
  getProactiveQuotaStatus,
  parseAnthropicUsage,
  parseCodexUsage,
  formatQuotaStatus,
  formatQuotaForPrompt,
  setQuotaFixture,
  clearQuotaFixtures,
  type ProactiveQuotaHealth,
  type AnthropicUsage,
  type CodexUsage,
} from './quota/proactive.js';

// Multiple Accounts Management
export {
  listAccounts,
  addAccount,
  removeAccount,
  setActiveAccount,
  getActiveAccount,
  getAccountEnv,
  getAccountsAsPool,
  loadAccountsManifest,
  saveAccountsManifest,
  type AccountRecord,
  type AccountsManifest,
} from './core/accounts.js';

// Types
export * from './types/index.js';

export default { agents, run, ask, AgentError, installIde, SubagentRoster };
