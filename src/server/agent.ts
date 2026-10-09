// Agent mode of the proxy
import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSandbox, Sandbox } from '../extras/worktree.js';
import { HttpError, rid, sendJson } from './common.js';
import { permRank } from './config.js';

const TTL_MS = Number(process.env.AGENTBRIDGE_AGENT_TTL_MS) || 30 * 60 * 1000;
const INLINE_DIFF_MAX = 256 * 1024;

export interface AgentRunRecord {
  id: string;
  sandbox: Sandbox;
  origin: string;
  created: number;
  last: number;
  applied: boolean;
  busy?: number;
}

const runs = new Map<string, AgentRunRecord>();
const bySession = new Map<string, string>();

let sweeper: NodeJS.Timeout | undefined;
function sweep() {
  const cut = Date.now() - TTL_MS;
  for (const [id, r] of runs) {
    if (r.last < cut && !r.busy) drop(id);
  }
}
function drop(id: string) {
  const r = runs.get(id);
  if (!r) return;
  runs.delete(id);
  for (const [k, v] of bySession) {
    if (v === id) bySession.delete(k);
  }
  try {
    r.sandbox.cleanup();
  } catch {
    /* best effort */
  }
}
function ensureSweeper() {
  if (!sweeper) {
    sweeper = setInterval(sweep, 60_000);
    sweeper.unref();
  }
}
/** Remove every sandbox (server shutdown / tests). */
export function disposeAgentRuns(): void {
  for (const id of [...runs.keys()]) drop(id);
  clearInterval(sweeper);
  sweeper = undefined;
}

const real = (p: string) => {
  try {
    return realpathSync(path.resolve(p));
  } catch {
    return null;
  }
};
const inside = (root: string, p: string) => {
  const r = path.relative(root, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

export interface AgentSettingsResult {
  origin: string;
  permissions: string;
}

/** Throws the right HTTP error when agent mode is not allowed; returns the validated settings. */
export function agentSettings(req: any, opts: any): AgentSettingsResult {
  const c = opts.cfg.get();
  if (!c.agentRoot) {
    throw new HttpError(
      403,
      'Agent mode is disabled. Start the proxy with --agent-root <folder> (and --token) to enable it.',
      'permission_error',
      'agent_mode_disabled'
    );
  }
  if (!opts.token) {
    throw new HttpError(
      403,
      'Agent mode requires the proxy to run with --token (the agents can edit files and run commands).',
      'permission_error',
      'agent_mode_needs_token'
    );
  }
  const root = real(c.agentRoot);
  if (!root || !existsSync(root)) {
    throw new HttpError(500, `agentRoot "${c.agentRoot}" does not exist`, 'api_error', 'agent_root_missing');
  }
  const want = req.headers['x-ab-cwd'];
  const origin = real(path.resolve(root, typeof want === 'string' && want.trim() ? want.trim() : '.'));
  if (!origin || !inside(root, origin)) {
    throw new HttpError(
      403,
      'x-ab-cwd must be an existing folder inside the proxy agent root',
      'permission_error',
      'cwd_outside_agent_root'
    );
  }
  const ceiling = c.maxPermission;
  const rp = req.headers['x-ab-permissions'];
  const permissions =
    typeof rp === 'string' && rp.trim() ? rp.trim() : permRank('edit') <= permRank(ceiling) ? 'edit' : ceiling;
  if (permRank(permissions) < 0) {
    throw new HttpError(400, `x-ab-permissions must be one of read-only|plan|edit|full`, 'invalid_request_error', 'bad_permissions');
  }
  if (permRank(permissions) > permRank(ceiling)) {
    throw new HttpError(
      403,
      `Requested permissions "${permissions}" exceed the proxy ceiling "${ceiling}"`,
      'permission_error',
      'permissions_exceed_ceiling'
    );
  }
  return { origin, permissions };
}

export interface PreparedAgentRun {
  run: AgentRunRecord;
  cwd: string;
  permissions: string;
}

/** Sandbox for this request: reused for the same x-ab-session, else a fresh one. */
export function prepareAgentRun(req: any, opts: any, sessionKey?: string): PreparedAgentRun {
  ensureSweeper();
  const { origin, permissions } = agentSettings(req, opts);
  let r = sessionKey ? runs.get(bySession.get(sessionKey)!) : undefined;
  if (r && r.origin !== origin) {
    throw new HttpError(
      400,
      'This session already works in another folder; start a new x-ab-session',
      'invalid_request_error',
      'session_cwd_mismatch'
    );
  }
  if (!r) {
    let sandbox: Sandbox;
    try {
      sandbox = createSandbox(origin);
    } catch (e: any) {
      throw new HttpError(500, `Cannot create the sandbox: ${e.message}`, 'api_error', 'sandbox_failed');
    }
    r = { id: rid('run_'), sandbox, origin, created: Date.now(), last: Date.now(), applied: false };
    runs.set(r.id, r);
    if (sessionKey) bySession.set(sessionKey, r.id);
  }
  r.last = Date.now();
  r.busy = (r.busy || 0) + 1;
  return { run: r, cwd: r.sandbox.cwd, permissions };
}

/** After the agent finished: what it changed. */
export function finishAgentRun(ctx: PreparedAgentRun): any {
  const r = ctx.run;
  r.busy = Math.max(0, (r.busy || 1) - 1);
  r.last = Date.now();
  let d = { diff: '', files: [] as string[] };
  try {
    d = r.sandbox.diff();
  } catch {
    /* sandbox gone */
  }
  const big = d.diff.length > INLINE_DIFF_MAX;
  return {
    runId: r.id,
    mode: r.sandbox.mode,
    filesChanged: d.files,
    ...(big ? { diffOmitted: true, diffBytes: d.diff.length } : { diff: d.diff }),
    diffUrl: `/agent/runs/${r.id}/diff`,
    applyUrl: `/agent/runs/${r.id}/apply`,
  };
}

export function abortAgentRun(ctx?: PreparedAgentRun): void {
  if (ctx?.run) {
    ctx.run.busy = Math.max(0, (ctx.run.busy || 1) - 1);
    ctx.run.last = Date.now();
  }
}

const topOf = (dir: string): string | null => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};
const gitApply = (cwd: string, args: string[], input: string) =>
  execFileSync('git', ['apply', '--whitespace=nowarn', ...args, '-'], {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });

/** Routes: GET /agent/runs, GET /agent/runs/:id, GET .../diff, POST .../apply, DELETE /agent/runs/:id. */
export async function handleAgentRoutes(req: any, res: any, url: string): Promise<boolean> {
  const m = /^\/agent\/runs(?:\/([A-Za-z0-9_]+)(?:\/(diff|apply))?)?$/.exec(url);
  if (!m) return false;
  const [, id, action] = m;
  const meta = (r: AgentRunRecord) => ({
    runId: r.id,
    mode: r.sandbox.mode,
    origin: r.origin,
    created: Math.floor(r.created / 1000),
    applied: r.applied,
  });
  if (!id) {
    if (req.method !== 'GET') throw new HttpError(405, 'Use GET', 'invalid_request_error', 'method_not_allowed');
    sendJson(res, 200, { runs: [...runs.values()].map(meta) });
    return true;
  }
  const r = runs.get(id);
  if (!r) throw new HttpError(404, `Unknown or expired run ${id}`, 'invalid_request_error', 'run_not_found');
  r.last = Date.now();
  if (!action && req.method === 'GET') {
    const d = r.sandbox.diff();
    sendJson(res, 200, { ...meta(r), filesChanged: d.files });
    return true;
  }
  if (!action && req.method === 'DELETE') {
    drop(id);
    sendJson(res, 200, { deleted: id });
    return true;
  }
  if (action === 'diff' && req.method === 'GET') {
    const d = r.sandbox.diff();
    res.writeHead(200, { 'content-type': 'text/x-diff; charset=utf-8' });
    res.end(d.diff);
    return true;
  }
  if (action === 'apply' && req.method === 'POST') {
    if (r.busy) throw new HttpError(409, 'The agent is still running in this sandbox', 'invalid_request_error', 'run_busy');
    const d = r.sandbox.diff();
    if (!d.diff.trim()) {
      sendJson(res, 200, { runId: id, applied: false, filesChanged: [], reason: 'no changes' });
      return true;
    }
    const cwd = topOf(r.origin) || r.origin;
    try {
      gitApply(cwd, ['--check'], d.diff);
      gitApply(cwd, [], d.diff);
    } catch (e: any) {
      throw new HttpError(
        409,
        `The changes do not apply cleanly to ${r.origin}: ${String(e.stderr || e.message).trim().slice(0, 500)}`,
        'invalid_request_error',
        'apply_conflict'
      );
    }
    r.applied = true;
    sendJson(res, 200, { runId: id, applied: true, filesChanged: d.files, target: cwd });
    return true;
  }
  throw new HttpError(405, 'Method not allowed for this route', 'invalid_request_error', 'method_not_allowed');
}

export interface WithAgentModeResult {
  o: any;
  headers: Record<string, string>;
  finish: () => any;
  abort: () => void;
}

export function withAgentMode(o: any, req: any, opts: any): WithAgentModeResult {
  if (o.target.mode !== 'agent') return { o, headers: {}, finish: () => null, abort() {} };
  const ctx = prepareAgentRun(req, opts, o.sessionKey);
  let settled = false;
  return {
    o: {
      ...o,
      mode: 'agent',
      cwd: ctx.cwd,
      permissions: ctx.permissions,
      timeoutMs: opts.agentTimeoutMs || 20 * 60 * 1000,
    },
    headers: { 'x-agentbridge-run': ctx.run.id },
    finish() {
      if (settled) return null;
      settled = true;
      return finishAgentRun(ctx);
    },
    abort() {
      if (!settled) {
        settled = true;
        abortAgentRun(ctx);
      }
    },
  };
}
