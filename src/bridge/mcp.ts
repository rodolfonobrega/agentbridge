#!/usr/bin/env node
// Dependency-free stdio MCP server (newline-delimited JSON-RPC 2.0) exposing ask_*/dispatch_* agent tools + run management.
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { run, parseFallbackTarget } from '../index.js';
import { createTracker } from '../telemetry/stats.js';
import { ev } from '../core/events.js';
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { endpointNames, loadEndpoints } from '../adapters/endpoint.js';
import {
  dispatch,
  waitRun,
  cancelRun,
  loadRun,
  listRuns,
  summarize,
  sweep,
  abortAll,
  setKeep,
  sendMessage,
  checkMessages,
} from './runs.js';
import { resolvePermissionLevel, PERMISSION_RANK } from '../core/config.js';
import { VERSION } from '../core/version.js';

const BUILTIN_AGENTS = ['claude', 'codex', 'opencode', 'agy', 'pi', 'cursor', 'grok', 'gemini', 'devin', 'acp'];
const agentList = (env: NodeJS.ProcessEnv = process.env) => [...BUILTIN_AGENTS, ...endpointNames(env)];
const isEndpoint = (a: string) => !BUILTIN_AGENTS.includes(a);

const RANK: Record<string, number> = { 'read-only': 0, plan: 1, edit: 2, full: 3 };
export const DEFAULT_MODEL: Record<string, string> = {
  claude: 'haiku',
  codex: 'gpt-5.6-luna',
  opencode: 'opencode-go/glm-5.3-flash',
  agy: 'gemini-3.8-flash-low',
  cursor: 'claude-3-5-sonnet',
  grok: 'grok-2',
  gemini: 'gemini-2.0-flash',
  devin: 'default',
  acp: 'default',
};
const DEFAULT_TIMEOUT_S = 300;
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const META = '[agentbridge] ';
const sha = (t: any) => createHash('sha256').update(String(t ?? '')).digest('hex');

export interface Attestation {
  agent: string;
  sessionId: string | null;
  depth: number;
  model: string | null;
  textSha: string;
  promptSha: string | null;
  bind: string | null;
  callId: string;
  hmac: string;
}

export function attestKey(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTBRIDGE_ATTEST_KEY) return env.AGENTBRIDGE_ATTEST_KEY;
  return ((attestKey as any).fallback ||= randomBytes(32).toString('hex'));
}

const ATT_FIELDS: (keyof Attestation)[] = [
  'agent',
  'sessionId',
  'depth',
  'model',
  'textSha',
  'promptSha',
  'bind',
  'callId',
];
const mac = (key: string, a: any) =>
  createHmac('sha256', key)
    .update(JSON.stringify(ATT_FIELDS.map((k) => a[k] ?? null)))
    .digest('hex');

/** Server-side attestation */
export function attest(st: any, env: NodeJS.ProcessEnv = process.env): Attestation {
  const a = {
    agent: st.agent,
    sessionId: st.sessionId ?? null,
    depth: st.depth,
    model: st.model ?? null,
    textSha: sha(st.text),
    promptSha: st.promptSha ?? null,
    bind: env.AGENTBRIDGE_ATTEST_BIND ?? null,
    callId: randomUUID(),
  };
  return { ...a, hmac: mac(attestKey(env), a) };
}

export function verifyAttestation(a: any, key: string, text?: string): boolean {
  if (!a || typeof a.hmac !== 'string' || !key) return false;
  if (a.hmac !== mac(key, a)) return false;
  return text === undefined || a.textSha === sha(text);
}

export const maxDepth = (env: NodeJS.ProcessEnv = process.env): number => {
  const s = env.AGENTBRIDGE_MAX_DEPTH;
  const n = Number(s);
  return s !== undefined && s !== '' && Number.isFinite(n) && n >= 0 ? n : 2;
};

export const curDepth = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.AGENTBRIDGE_DEPTH);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function askSchema(agent: string) {
  return {
    name: `ask_${agent}`,
    description: isEndpoint(agent)
      ? `Send a prompt to the "${agent}" chat-model endpoint (HTTP, OpenAI/Anthropic-compatible; plain chat, no tools or file access) and return its answer, session id and token usage. Omit model to use the endpoint default.`
      : `Delegate a prompt to the ${agent} coding agent (a separate process) and return its final answer, session id and token usage.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt for the agent' },
        model: { type: 'string', description: 'Default: cheapest model for the agent' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        permissions: {
          type: 'string',
          enum: ['read-only', 'plan', 'edit', 'full'],
          description: 'Default: read-only (safe). Pass edit or full if modifying files or running tools. Never exceeds the ceiling.',
        },
        harness: {
          type: 'string',
          enum: ['auto', 'claude', 'pi', 'none'],
          description: 'Execution harness for endpoint models (default: auto for edit/tools, direct API for read-only)',
        },
        cwd: { type: 'string' },
        timeout: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Timeout in seconds (or ms if >= 1000). Alias for timeoutSeconds.',
        },
        timeoutSeconds: { type: 'number', exclusiveMinimum: 0, description: 'Default 300' },
        session: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['new', 'ephemeral', 'continue', 'fork'] },
            id: { type: 'string' },
          },
          required: ['mode'],
        },
        systemPrompt: { type: 'string' },
        fallback: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string' },
          description:
            'Agents to try, in order, if this one fails with fallbackOn (default RATE_LIMITED): "codex" or "ollama:glm-5.3-flash:cloud". Each starts a new session with its own model; not used if this agent already ran tools with edit/full permissions.',
        },
        fallbackOn: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['RATE_LIMITED', 'NOT_LOGGED_IN', 'NOT_INSTALLED', 'TIMEOUT', 'AGENT_FAILED'],
          },
        },
        offline: {
          type: 'boolean',
          description: 'Disable web search, web fetch, and external network tools (strict offline / air-gapped mode)',
        },
        mcpPassthrough: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of host MCP servers to pass through to child agent (e.g. ["rea"]). Blocked if offline is true or in read-only/plan mode.',
        },
        skills: {
          type: 'boolean',
          description: 'Enable discovery of shared skills from ~/.agents/skills/ (default false for strict isolation)',
        },
        transport: {
          type: 'string',
          enum: ['cli', 'app-server', 'stdio', 'auto'],
          description:
            'Execution transport mode. "app-server" runs a persistent JSON-RPC 2.0 daemon (fast zero cold-start, live interactive approvals for Codex); "cli" uses standard batch process spawn.',
        },
      },
      required: ['prompt'],
    },
  };
}

export function toolSchema(agent: string, kind = 'ask'): any {
  const s: any = askSchema(agent);
  if (kind === 'dispatch') {
    s.name = `dispatch_${agent}`;
    s.description = `Start ${agent} asynchronously; returns a run id immediately. Use wait_run/check_run/cancel_run.`;
    s.inputSchema.properties.idempotencyKey = {
      type: 'string',
      description: 'Repeating a dispatch with the same key returns the existing run',
    };
  }
  return s;
}

export const RUN_TOOLS = [
  {
    name: 'wait_run',
    description: 'Wait for an async run to finish (or time out) and return its state/result.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, timeoutSeconds: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'check_run',
    description: 'Status, elapsed time, last events and tokens of an async run.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'cancel_run',
    description: 'Cancel a running async run (kills the child agent).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'retain_run',
    description: 'Retain a run record (exempt from registry GC) - worker lifecycle.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'release_run',
    description: 'Release a retained run record (eligible for GC).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'send_message',
    description: 'Append a message to the inbox of a run id or agent name (no live injection into a running agent).',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, from: { type: 'string' }, text: { type: 'string' } },
      required: ['to', 'text'],
    },
  },
  {
    name: 'check_messages',
    description: 'Read (and mark read) unread inbox messages for a run id or agent name.',
    inputSchema: {
      type: 'object',
      properties: { for: { type: 'string' }, markRead: { type: 'boolean' } },
      required: ['for'],
    },
  },
  {
    name: 'list_runs',
    description: 'List async runs from the registry (~/.agentbridge/runs).',
    inputSchema: { type: 'object', properties: { state: { type: 'string' }, limit: { type: 'number' } } },
  },
];

export const CHECKPOINT_TOOLS = [
  {
    name: 'checkpoint_create',
    description: 'Create an instant snapshot of the repository in hidden refs (refs/agentbridge/checkpoints/...) without altering branches or staging index.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Brief description of the checkpoint' },
        sessionId: { type: 'string', description: 'Optional session identifier' },
        cwd: { type: 'string', description: 'Repository directory path' },
      },
    },
  },
  {
    name: 'checkpoint_rollback',
    description: 'Rollback working tree files to a previously saved checkpoint snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Checkpoint ID to restore' },
        cwd: { type: 'string', description: 'Repository directory path' },
      },
      required: ['id'],
    },
  },
  {
    name: 'checkpoint_list',
    description: 'List saved checkpoints in the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session identifier filter' },
        cwd: { type: 'string', description: 'Repository directory path' },
      },
    },
  },
  {
    name: 'checkpoint_diff',
    description: 'Show unified diff between current workspace and a saved checkpoint snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Checkpoint ID to compare against' },
        cwd: { type: 'string', description: 'Repository directory path' },
      },
      required: ['id'],
    },
  },
];

export const QUOTA_TOOLS = [
  {
    name: 'check_quota',
    description: 'Query proactive quota and rate limit status for an agent (codex, claude, etc.). Returns used percentage, remaining percentage, window duration, reset time, and whether it is ok to proceed.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name (e.g. "codex", "claude")' },
        thresholdPercent: { type: 'number', description: 'Maximum acceptable used percent before throttling (default 95)' },
      },
      required: ['agent'],
    },
  },
];

export const allTools = (env: NodeJS.ProcessEnv = process.env): any[] => {
  const L = agentList(env);
  let ceiling = 'full';
  try {
    ceiling = resolvePermissionLevel(undefined, { env }).ceiling;
  } catch {
    /* ignore */
  }
  const cpTools =
    ceiling === 'read-only' || ceiling === 'plan'
      ? CHECKPOINT_TOOLS.filter((t) => t.name !== 'checkpoint_rollback')
      : CHECKPOINT_TOOLS;
  return [
    ...L.map((a) => toolSchema(a)),
    ...L.map((a) => toolSchema(a, 'dispatch')),
    ...RUN_TOOLS,
    ...cpTools,
    ...QUOTA_TOOLS,
  ];
};

export function resolvePerms(requested?: string, env: NodeJS.ProcessEnv = process.env, cwd?: string): string {
  try {
    const { permissions } = resolvePermissionLevel(requested as any, { env, cwd });
    return permissions;
  } catch (err: any) {
    throw new Error(err.message);
  }
}

function safeEndpointModel(agent: string, env: NodeJS.ProcessEnv) {
  try {
    return loadEndpoints(env)[agent]?.defaultModel;
  } catch {
    return undefined;
  }
}

function prepare(agent: string, args: any, env: NodeJS.ProcessEnv) {
  const depth = curDepth(env),
    max = maxDepth(env);
  if (depth >= max) {
    throw new Error(
      `Recursion guard: AGENTBRIDGE_DEPTH=${depth} has reached max ${max}; refusing to spawn another agent`
    );
  }
  if (!args || typeof args !== 'object') throw new Error('arguments must be an object');
  const perms = resolvePerms(args.permissions, env);
  const mk = (a: string) => `AGENTBRIDGE_MODEL_${a.toUpperCase()}`;
  const model = args.model ?? env[mk(agent)] ?? (isEndpoint(agent) ? safeEndpointModel(agent, env) : DEFAULT_MODEL[agent]);
  const opts: any = { prompt: args.prompt, permissions: perms, model };
  for (const k of ['effort', 'cwd', 'session', 'systemPrompt', 'harness', 'offline']) {
    if (args[k] != null) opts[k] = args[k];
  }
  if (env.AGENTBRIDGE_CHILD_CWD) opts.cwd = env.AGENTBRIDGE_CHILD_CWD;
  const rawTimeout = args.timeoutSeconds ?? args.timeout;
  let ts = Number(env.AGENTBRIDGE_DEFAULT_TIMEOUT_S) || DEFAULT_TIMEOUT_S;
  if (rawTimeout != null) {
    const num = Number(rawTimeout);
    if (!isNaN(num) && num > 0) {
      ts = num >= 1000 ? Math.round(num / 1000) : num;
    }
  }
  opts.timeoutMs = Math.round(ts * 1000);
  const childDepth = depth + 1;
  const models = Object.fromEntries(agentList(env).filter((a) => env[mk(a)]).map((a) => [mk(a), env[mk(a)]]));
  opts.env = {
    AGENTBRIDGE_DEPTH: String(childDepth),
    AGENTBRIDGE_MAX_DEPTH: String(max),
    AGENTBRIDGE_PERMS: perms,
    ...models,
  };
  return { opts, perms, childDepth, max, model };
}

async function execute(agent: string, args: any, ctx: any): Promise<any> {
  const { env } = ctx;
  const chain = (args.fallback ?? []).map(parseFallbackTarget);
  const on = args.fallbackOn ?? ['RATE_LIMITED'];
  if (args.fallback != null && (!Array.isArray(args.fallback) || args.fallback.length > 5)) {
    throw new Error('fallback must be an array of at most 5 agents');
  }
  if (
    !Array.isArray(on) ||
    on.some((c) => !['RATE_LIMITED', 'NOT_LOGGED_IN', 'NOT_INSTALLED', 'TIMEOUT', 'AGENT_FAILED'].includes(c))
  ) {
    throw new Error('fallbackOn has an unsupported code');
  }
  for (const t of chain) {
    if (!agentList(env).includes(t.agent)) {
      throw new Error(`fallback agent "${t.agent}" is not one of: ${agentList(env).join(', ')}`);
    }
  }
  const { fallback, fallbackOn, ...base } = args;
  void fallback;
  void fallbackOn;
  const perms = resolvePerms(base.permissions, env);
  const attempts: any[] = [];
  let cur = { agent, args: base };
  for (let i = 0; ; i++) {
    let tools = 0;
    try {
      const st = await executeOne(cur.agent, cur.args, {
        ...ctx,
        onEvent: (e: any) => {
          if (e.type === 'tool') tools++;
          ctx.onEvent?.(e);
        },
      });
      return attempts.length
        ? {
            ...st,
            fallback: {
              used: cur.agent,
              attempts,
              contextLost: base.session?.mode === 'continue' || base.session?.mode === 'fork',
            },
          }
        : st;
    } catch (e: any) {
      const next = chain[i];
      if (!(next && on.includes(e?.code) && !ctx.signal?.aborted)) throw e;
      if (tools && perms !== 'read-only' && perms !== 'plan') {
        throw Object.assign(e, {
          fallbackSkipped: `${cur.agent} already ran tools under "${perms}" permissions; not repeating the task on ${next.agent}`,
        });
      }
      attempts.push({
        agent: cur.agent,
        code: e.code,
        message: String(e.message).slice(0, 300),
        ...(e.retryAfterMs != null ? { retryAfterMs: e.retryAfterMs } : {}),
      });
      ctx.onEvent?.(ev.fallback(cur.agent, next.agent, e.code, e.message));
      const { effort, session, model, ...keep } = base;
      void effort;
      void model;
      cur = {
        agent: next.agent,
        args: {
          ...keep,
          ...(next.model ? { model: next.model } : {}),
          ...(session?.mode === 'ephemeral' ? { session } : {}),
        },
      };
    }
  }
}

async function executeOne(agent: string, args: any, { env, onEvent, signal }: any): Promise<any> {
  const { opts, perms, childDepth, max } = prepare(agent, args, env);
  opts.signal = signal;
  const passthroughAsked = Array.isArray(args?.mcpPassthrough) && args.mcpPassthrough.length > 0;
  if (isEndpoint(agent)) {
    const it = run(agent, opts);
    let r: any, sid: string | undefined;
    for (;;) {
      const x = await it.next();
      if (x.done) {
        r = x.value;
        break;
      }
      if (x.value.type === 'session') sid = x.value.id;
      onEvent?.(x.value);
    }
    return {
      agent,
      text: r.text,
      sessionId: r.sessionId ?? sid ?? null,
      promptSha: sha(args.prompt),
      usage: r.usage,
      model: r.model,
      durationMs: r.durationMs,
      permissions: perms,
      depth: childDepth,
      toolCalls: [],
      ...(passthroughAsked ? { warnings: ['mcpPassthrough: not supported for endpoint/chat agents; ignored'] } : {}),
    };
  }
  const { mcpConfigFor, resolvePassthrough } = await import('./attach.js');
  const models = Object.fromEntries(
    agentList(env).filter((a) => env[`AGENTBRIDGE_MODEL_${a.toUpperCase()}`]).map((a) => [a, env[`AGENTBRIDGE_MODEL_${a.toUpperCase()}`]])
  );
  opts.env.AGENTBRIDGE_ATTEST_KEY = attestKey(env);
  const grandchildEnv: Record<string, string> = {
    AGENTBRIDGE_DEPTH: String(childDepth),
    AGENTBRIDGE_MAX_DEPTH: String(max),
    AGENTBRIDGE_PERMS: perms,
    AGENTBRIDGE_ATTEST_KEY: attestKey(env),
    ...models,
  };
  if (env.AGENTBRIDGE_HOME) grandchildEnv.AGENTBRIDGE_HOME = env.AGENTBRIDGE_HOME;
  if (env.AGENTBRIDGE_ATTEST_BIND) grandchildEnv.AGENTBRIDGE_ATTEST_BIND = env.AGENTBRIDGE_ATTEST_BIND;
  if (env.AGENTBRIDGE_ROOT) grandchildEnv.AGENTBRIDGE_ROOT = env.AGENTBRIDGE_ROOT;
  if (env.AGENTBRIDGE_DEFAULT_TIMEOUT_S) grandchildEnv.AGENTBRIDGE_DEFAULT_TIMEOUT_S = env.AGENTBRIDGE_DEFAULT_TIMEOUT_S;
  if (args.skills != null) {
    if (typeof args.skills !== 'boolean') throw new Error('skills must be a boolean');
    opts.skills = args.skills;
  }
  if (args.transport != null) {
    opts.transport = args.transport;
  }
  if (args.mcpPassthrough != null && !(Array.isArray(args.mcpPassthrough) && args.mcpPassthrough.every((x: any) => typeof x === 'string'))) {
    throw new Error('mcpPassthrough must be an array of server names');
  }
  const { servers: passthroughServers, drops } = resolvePassthrough({
    passthrough: args.mcpPassthrough,
    cwd: opts.cwd || process.cwd(),
    offline: !!opts.offline,
    permissions: perms,
    env: { ...env, ...grandchildEnv },
  });
  const warnings = passthroughAsked ? drops.map((d) => `mcpPassthrough: "${d.name}" dropped (${d.reason})`) : [];
  let httpBridge: any = null;
  if (agent === 'codex') {
    const serverName = 'agentbridge_http';
    httpBridge = await serveHttp({ env: grandchildEnv });
    opts.extraArgs = [
      ...(opts.extraArgs || []),
      '-c',
      `mcp_servers.${serverName}.url="${httpBridge.url}"`,
      '-c',
      `mcp_servers.${serverName}.bearer_token_env_var="AGENTBRIDGE_ATTEST_KEY"`,
      '-c',
      `mcp_servers.${serverName}.default_tools_approval_mode="approve"`,
    ];
    for (const [name, srv] of Object.entries<any>(passthroughServers)) {
      const k = `mcp_servers.${name}`;
      opts.extraArgs.push('-c', `${k}.command=${JSON.stringify(srv.command)}`, '-c', `${k}.default_tools_approval_mode="approve"`);
      if (srv.args?.length) opts.extraArgs.push('-c', `${k}.args=[${srv.args.map((x: any) => JSON.stringify(x)).join(',')}]`);
      const envs = Object.entries(srv.env || {});
      if (envs.length) {
        opts.extraArgs.push('-c', `${k}.env={${envs.map(([x, y]) => `${JSON.stringify(x)}=${JSON.stringify(String(y))}`).join(',')}}`);
      }
    }
  } else {
    const childBridge = mcpConfigFor(agent, {
      depth: childDepth,
      maxDepth: max,
      permissions: perms,
      models,
      home: env.AGENTBRIDGE_HOME,
      attestBind: env.AGENTBRIDGE_ATTEST_BIND,
      root: env.AGENTBRIDGE_ROOT,
      defaultTimeoutS: env.AGENTBRIDGE_DEFAULT_TIMEOUT_S,
    });
    const combinedServers = { ...childBridge, ...passthroughServers };
    if (Object.keys(combinedServers).length) {
      opts.mcpServers = combinedServers;
    }
  }
  try {
    const it = run(agent, opts);
    let r: any, sid: string | undefined;
    const tools: string[] = [];
    for (;;) {
      const x = await it.next();
      if (x.done) {
        r = x.value;
        break;
      }
      if (x.value.type === 'session') sid = x.value.id;
      if (x.value.type === 'tool' && x.value.output === undefined) tools.push(x.value.name);
      onEvent?.(x.value);
    }
    return {
      agent,
      text: r.text,
      sessionId: r.sessionId ?? sid ?? null,
      promptSha: sha(args.prompt),
      usage: r.usage,
      model: r.model,
      durationMs: r.durationMs,
      permissions: perms,
      depth: childDepth,
      toolCalls: tools,
      ...(passthroughAsked && warnings.length ? { warnings } : {}),
    };
  } finally {
    if (httpBridge) await httpBridge.close();
  }
}

const asResult = (st: any, env: NodeJS.ProcessEnv) => {
  const attestation = attest(st, env);
  return {
    content: [
      { type: 'text', text: st.text || '' },
      { type: 'text', text: META + JSON.stringify(attestation) },
      ...(st.warnings?.length ? st.warnings.map((w: string) => ({ type: 'text', text: `${META}WARNING: ${w}` })) : []),
    ],
    structuredContent: { ...st, attestation },
  };
};
const errResult = (m: string) => ({ isError: true, content: [{ type: 'text', text: m }] });

export async function callTool(
  agent: string,
  args: any,
  {
    env = process.env,
    progress,
    signal,
  }: { env?: NodeJS.ProcessEnv; progress?: (p: number, message: string) => void; signal?: AbortSignal } = {}
): Promise<any> {
  prepare(agent, args, env);
  let n = 0;
  let tr: any = null;
  try {
    tr = createTracker({
      agent,
      opts: { prompt: String(args.prompt ?? ''), model: args.model, cwd: env.AGENTBRIDGE_CHILD_CWD || args.cwd, session: args.session },
      env,
      origin: 'bridge-sync',
    });
  } catch {
    /* ignore */
  }
  let st: any;
  try {
    st = await execute(agent, args, {
      env,
      signal,
      onEvent: (e: any) => {
        try {
          tr?.onEvent(e);
        } catch {
          /* ignore */
        }
        if (e.type === 'text') progress?.(++n, `${agent}: ${String(e.delta).slice(0, 200)}`);
        else if (e.type === 'tool' && e.output === undefined) progress?.(++n, `${agent} tool: ${e.name}`);
      },
    });
  } catch (e) {
    try {
      tr?.finish({ error: e });
    } catch {
      /* ignore */
    }
    throw e;
  }
  try {
    tr?.finish({ result: { text: st.text, sessionId: st.sessionId, usage: st.usage, model: st.model } });
  } catch {
    /* ignore */
  }
  return asResult(st, env);
}

export async function callAny(name: string, args: any, ctx: any = {}): Promise<any> {
  const env = ctx.env || process.env;
  let m: RegExpExecArray | null;
  if ((m = /^ask_(\w+)$/.exec(name)) && agentList(env).includes(m[1])) return callTool(m[1], args, ctx);
  if ((m = /^dispatch_(\w+)$/.exec(name)) && agentList(env).includes(m[1])) {
    const agent = m[1],
      p = prepare(agent, args, env);
    const { rec, deduped } = dispatch({
      agent,
      model: p.model,
      cwd: args.cwd,
      key: args.idempotencyKey,
      prompt: String(args.prompt ?? ''),
      env,
      exec: ({ onEvent, signal }: any) => execute(agent, args, { env, onEvent, signal }),
    });
    const o = { runId: rec.id, state: rec.state, deduped };
    return { content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o };
  }
  if (name === 'list_runs') {
    const l = listRuns(env)
      .filter((r) => !args?.state || r.state === args.state)
      .slice(0, args?.limit || 50)
      .map(summarize);
    return { content: [{ type: 'text', text: JSON.stringify(l) }], structuredContent: { runs: l } };
  }
  if (name === 'send_message') {
    if (!args?.to || typeof args.text !== 'string') return errResult('to and text are required');
    const msg = sendMessage(env, args);
    return { content: [{ type: 'text', text: JSON.stringify(msg) }], structuredContent: msg };
  }
  if (name === 'check_messages') {
    if (!args?.for) return errResult('for is required');
    const l = checkMessages(env, { for: args.for, markRead: args.markRead !== false });
    return { content: [{ type: 'text', text: JSON.stringify(l) }], structuredContent: { messages: l } };
  }
  if (name === 'retain_run' || name === 'release_run') {
    const a =
      typeof args?.id === 'string'
        ? setKeep(args.id, name === 'retain_run', env)
        : { error: `Unknown run id: ${args?.id}`, rec: undefined as any };
    if (a.error) return errResult(a.error);
    const r = a.rec;
    return { content: [{ type: 'text', text: JSON.stringify(summarize(r)) }], structuredContent: summarize(r) };
  }
  if (['wait_run', 'check_run', 'cancel_run'].includes(name)) {
    const id = args?.id;
    const r0 = loadRun(id as string, env);
    if (typeof id !== 'string' || !r0) return errResult(`Unknown run id: ${id}`);
    let r: any;
    if (name === 'cancel_run') {
      const c = cancelRun(id, env);
      if (c.error) return errResult(c.error);
      r = c.rec;
    } else {
      r = name === 'wait_run' ? await waitRun(id, (Number(args.timeoutSeconds) || 30) * 1000, env) : r0;
    }
    const done = r.state === 'done';
    const out: any = { ...summarize(r), ...(done ? { text: r.result?.text, result: r.result } : {}) };
    const content = [{ type: 'text', text: done ? r.result?.text || '' : JSON.stringify(summarize(r)) }];
    if (done) {
      const attestation = attest(r.result, env);
      content.push({ type: 'text', text: META + JSON.stringify(attestation) });
      out.attestation = attestation;
    }
    return { content, structuredContent: out, ...(r.state === 'error' ? { isError: true } : {}) };
  }
  if (name === 'checkpoint_create') {
    const cwdTarget = path.resolve(args?.cwd || process.cwd());
    const allowedRoot = env.AGENTBRIDGE_ROOT ? path.resolve(env.AGENTBRIDGE_ROOT) : null;
    if (allowedRoot) {
      const rel = path.relative(allowedRoot, cwdTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return errResult(`Forbidden: cwd "${cwdTarget}" is outside authorized AGENTBRIDGE_ROOT "${allowedRoot}"`);
      }
    }
    const { ceiling } = resolvePermissionLevel(args?.permissions, { env, cwd: cwdTarget });
    if (ceiling === 'read-only' || args?.permissions === 'read-only') {
      return errResult(`Permission denied: checkpoint_create is not allowed under read-only permissions`);
    }
    const { createCheckpoint } = await import('../extras/checkpoint.js');
    const cp = createCheckpoint(cwdTarget, { message: args?.message, sessionId: args?.sessionId });
    return { content: [{ type: 'text', text: JSON.stringify(cp) }], structuredContent: cp };
  }
  if (name === 'checkpoint_rollback') {
    const cwdTarget = path.resolve(args?.cwd || process.cwd());
    const allowedRoot = env.AGENTBRIDGE_ROOT ? path.resolve(env.AGENTBRIDGE_ROOT) : null;
    if (allowedRoot) {
      const rel = path.relative(allowedRoot, cwdTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return errResult(`Forbidden: cwd "${cwdTarget}" is outside authorized AGENTBRIDGE_ROOT "${allowedRoot}"`);
      }
    }
    const { ceiling } = resolvePermissionLevel(args?.permissions, { env, cwd: cwdTarget });
    if (ceiling === 'read-only' || ceiling === 'plan' || args?.permissions === 'read-only' || args?.permissions === 'plan') {
      return errResult(`Permission denied: checkpoint_rollback is not allowed under "${ceiling}" permissions`);
    }
    const { rollbackCheckpoint } = await import('../extras/checkpoint.js');
    const res = rollbackCheckpoint(cwdTarget, args?.id);
    return { content: [{ type: 'text', text: JSON.stringify(res) }], structuredContent: res };
  }
  if (name === 'checkpoint_list') {
    const cwdTarget = path.resolve(args?.cwd || process.cwd());
    const allowedRoot = env.AGENTBRIDGE_ROOT ? path.resolve(env.AGENTBRIDGE_ROOT) : null;
    if (allowedRoot) {
      const rel = path.relative(allowedRoot, cwdTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return errResult(`Forbidden: cwd "${cwdTarget}" is outside authorized AGENTBRIDGE_ROOT "${allowedRoot}"`);
      }
    }
    const { listCheckpoints } = await import('../extras/checkpoint.js');
    const list = listCheckpoints(cwdTarget, args?.sessionId);
    return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: { checkpoints: list } };
  }
  if (name === 'checkpoint_diff') {
    const cwdTarget = path.resolve(args?.cwd || process.cwd());
    const allowedRoot = env.AGENTBRIDGE_ROOT ? path.resolve(env.AGENTBRIDGE_ROOT) : null;
    if (allowedRoot) {
      const rel = path.relative(allowedRoot, cwdTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return errResult(`Forbidden: cwd "${cwdTarget}" is outside authorized AGENTBRIDGE_ROOT "${allowedRoot}"`);
      }
    }
    const { diffCheckpoint } = await import('../extras/checkpoint.js');
    const diff = diffCheckpoint(cwdTarget, args?.id);
    return { content: [{ type: 'text', text: diff || '(no differences)' }], structuredContent: { id: args?.id, diff } };
  }
  if (name === 'check_quota') {
    const { getProactiveQuotaStatus, formatQuotaStatus } = await import('../quota/proactive.js');
    const agent = args?.agent || 'codex';
    const status = await getProactiveQuotaStatus(agent, undefined, {
      thresholdPercent: args?.thresholdPercent,
    });
    const remainingPercent = Math.max(0, 100 - status.usedPercent);
    const result = {
      ...status,
      remainingPercent,
      formatted: formatQuotaStatus(status),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
  return undefined;
}

function makeHandler({ env, send }: { env: NodeJS.ProcessEnv; send: (m: any) => void }) {
  const inflight = new Map<any, AbortController>();
  attestKey(env);
  setTimeout(() => {
    try {
      sweep(env);
    } catch {
      /* ignore */
    }
  }, 1500).unref?.();
  const handle = async (msg: any): Promise<any> => {
    const { id, method, params } = msg || {};
    const isReq = id !== undefined && !!method;
    try {
      if (!method) return undefined;
      if (method === 'initialize') {
        const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: v,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'agentbridge', version: VERSION },
          },
        };
      }
      if (method === 'notifications/cancelled') {
        inflight.get(params?.requestId)?.abort();
        return undefined;
      }
      if (!isReq) return undefined;
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: allTools(env) } };
      if (method === 'tools/call') {
        const name = params?.name;
        if (!allTools(env).some((t) => t.name === name)) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        const ac = new AbortController();
        inflight.set(id, ac);
        const token = params?._meta?.progressToken;
        const progress =
          token === undefined
            ? undefined
            : (p: number, message: string) =>
                send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: p, message } });
        try {
          return {
            jsonrpc: '2.0',
            id,
            result: await callAny(name, params.arguments ?? {}, { env, progress, signal: ac.signal }),
          };
        } catch (e: any) {
          return { jsonrpc: '2.0', id, result: errResult(`${e.code ? e.code + ': ' : ''}${e.message}`) };
        } finally {
          inflight.delete(id);
        }
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (e: any) {
      return isReq ? { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } } : undefined;
    }
  };
  return { handle, inflight };
}

export function serve({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  exitOnEnd = false,
}: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  exitOnEnd?: boolean;
} = {}): { shutdown: () => Promise<void> } {
  const send = (m: any) => output.write(JSON.stringify(m) + '\n');
  const { handle, inflight } = makeHandler({ env, send });
  const process1 = async (msg: any) => {
    if (Array.isArray(msg)) {
      if (!msg.length) {
        return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } });
      }
      const out = (await Promise.all(msg.map(handle))).filter(Boolean);
      if (out.length) send(out);
    } else {
      const r = await handle(msg);
      if (r) send(r);
    }
  };
  let buf = '',
    scan = 0;
  (input as any).setEncoding?.('utf8');
  input.on('data', (chunk: any) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n', scan)) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      scan = 0;
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      process1(msg);
    }
    scan = buf.length;
  });
  const shutdown = async () => {
    for (const a of inflight.values()) a.abort();
    await abortAll(env).catch(() => {});
    if (exitOnEnd) process.exit(0);
  };
  input.on('end', shutdown);
  return { shutdown };
}

export interface ServeHttpResult {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function serveHttp({
  port = 0,
  host = '127.0.0.1',
  env = process.env,
  path: httpPath = '/mcp',
}: {
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
} = {}): Promise<ServeHttpResult> {
  const { handle } = makeHandler({ env, send: () => {} });
  const authorized = (req: http.IncomingMessage) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const a = Buffer.from(String(token || '')),
      b = Buffer.from(attestKey(env));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const respond = (res: http.ServerResponse, status: number, body?: any) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith(httpPath)) {
      return respond(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Not found' } });
    }
    if (!authorized(req)) {
      return respond(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        return respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (Array.isArray(msg)) {
        if (!msg.length) {
          return respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } });
        }
        const out = (await Promise.all(msg.map(handle))).filter(Boolean);
        return out.length ? respond(res, 200, out) : respond(res, 202);
      }
      const r = await handle(msg);
      return r ? respond(res, 200, r) : respond(res, 202);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address() as any;
      resolve({
        server,
        port: addr.port,
        url: `http://${host}:${addr.port}${httpPath}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const isMcpEntry = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
};

if (isMcpEntry()) {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...a: any[]) => (process.stderr.write as any)(...a);
  for (const k of ['log', 'info', 'debug'] as const) {
    (console as any)[k] = (...a: any[]) => console.error(...a);
  }
  const { shutdown } = serve({ output: { write: (d: any) => realWrite(d) } as any, exitOnEnd: true });
  for (const sg of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sg, () => shutdown().finally(() => process.exit(0)));
  }
}
