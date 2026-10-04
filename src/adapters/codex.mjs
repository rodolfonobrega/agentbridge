// Codex adapter: drives the installed `codex` CLI (`codex exec --json`) using the local ChatGPT login.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawnProc } from '../core/spawn.mjs';
import { AgentError } from '../core/errors.mjs';
import { ev, parseJsonLine } from '../core/events.mjs';
import { validateOptions } from '../index.mjs';

const codexHome = () => process.env.CODEX_HOME || path.join(homedir(), '.codex');
const toml = (v) => JSON.stringify(v); // JSON strings are valid TOML basic strings
const EFFORT = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };
const SANDBOX = { 'read-only': 'read-only', plan: 'read-only', edit: 'workspace-write', full: 'danger-full-access' };
const PLAN_NOTE = 'PLAN MODE: do not modify any files or run state-changing commands. Only analyze and reply with a plan.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (m) => new AgentError('BAD_OPTION', m);

function rolloutExists(id) {
  const root = path.join(codexHome(), 'sessions');
  let found = false;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (found) return;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.startsWith('rollout-') && e.name.endsWith(id + '.jsonl')) found = true;
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

// Most recent rollout whose recorded cwd matches (used for continue/fork without id).
// Sessions created by THIS process (new/fork/continue); id-less continue/fork only adopt these unless adoptForeign.
// Ownership is recorded as id -> scope (session.scope, default ''); id-less continue/fork only adopt sessions in the same cwd AND same scope.
// Give concurrent callers distinct session.scope values to make id-less continue deterministic.
const OWN = new Map();

function newestRollout(cwd, adoptForeign, scope = '') {
  const root = path.join(codexHome(), 'sessions');
  let best = null;
  const want = path.resolve(cwd).toLowerCase();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const m = statSync(p).mtimeMs;
        if (best && m <= best.m) continue;
        try {
          const first = parseJsonLine(readFileSync(p, 'utf8').split('\n', 1)[0]);
          const c = first?.payload?.cwd;
          if (c && (adoptForeign || OWN.get(first.payload.id) === scope) && path.resolve(c).toLowerCase() === want) best = { m, id: first.payload.id };
        } catch { /* ignore */ }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return best?.id;
}

function sandboxInfo(o) {
  const win = process.platform === 'win32' && !(o.extraArgs || []).some((x) => /windows.sandbox/.test(x));
  const mode = SANDBOX[o.permissions];
  const cwd = path.resolve(o.cwd || process.cwd());
  const writeRoots = mode === 'read-only' ? [] : mode === 'workspace-write' ? [cwd, ...(o.writableRoots || []).map((r) => path.resolve(r))] : ['*'];
  const notes = [];
  if (win && mode !== 'danger-full-access') notes.push('Injected -c windows.sandbox="unelevated" (default elevated sandbox fails on this class of host). Writes are restricted; reads are NOT restricted (any file the user can read).');
  if (mode === 'workspace-write') notes.push('TEMP/tmp excluded from writable roots.');
  if (o.permissions === 'plan') notes.push('plan = read-only sandbox + prompt instruction.');
  return { mode, readScope: 'unrestricted', writeRoots, note: notes.join(' ') };
}

const BUSY = new Map(); // session id -> number of in-flight runs holding it
const release = (claim) => {
  if (!claim.id) return;
  const n = (BUSY.get(claim.id) || 1) - 1;
  if (n <= 0) BUSY.delete(claim.id); else BUSY.set(claim.id, n);
  claim.id = undefined;
};

function buildArgs(o, schemaFile, claim = {}) {
  const s = o.session || { mode: 'new' };
  const mode = s.mode || 'new';
  if (!['new', 'ephemeral', 'continue', 'fork'].includes(mode)) throw new AgentError('BAD_OPTION', `Unknown session mode ${mode}`);
  if (s.id != null && !(typeof s.id === 'string' && UUID.test(s.id))) throw bad('session.id must be a session UUID');
  const fresh = mode === 'new' || mode === 'ephemeral';
  const sub = mode === 'continue' ? ['resume'] : mode === 'fork' ? ['fork'] : [];
  const a = ['exec', ...sub, '--json', '--skip-git-repo-check'];
  // Windows: codex's default (elevated) sandbox fails with 'deny-read ACLs' on many hosts. We inject
  // windows.sandbox="unelevated" (restricted-token sandbox). Guarantee: writes are limited to the workspace roots
  // (cwd + writableRoots; TEMP excluded by default for 'edit'), but READS ARE NOT RESTRICTED (any readable file).
  // This is disclosed via result.sandbox and a warning event.
  if (process.platform === 'win32' && !(o.extraArgs || []).some((x) => /windows.sandbox/.test(x))) a.push('-c', 'windows.sandbox="unelevated"');
  if (mode === 'ephemeral') a.push('--ephemeral');
  if (o.model) a.push('-m', o.model);
  if (o.effort) a.push('-c', `model_reasoning_effort=${toml(EFFORT[o.effort])}`);
  const sb = SANDBOX[o.permissions];
  // resume/fork have no --sandbox / -C flags: use config override + process cwd.
  if (fresh) a.push('--sandbox', sb, '-C', path.resolve(o.cwd || process.cwd()));
  else a.push('-c', `sandbox_mode=${toml(sb)}`);
  if (sb === 'workspace-write') {
    const roots = (o.writableRoots || []).map((r) => path.resolve(r));
    if (roots.length) a.push('-c', `sandbox_workspace_write.writable_roots=[${roots.map(toml).join(',')}]`);
    a.push('-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true');
  }
  if (o.systemPrompt) a.push('-c', `developer_instructions=${toml(o.systemPrompt)}`);
  for (const [name, m] of Object.entries(o.mcpServers || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new AgentError('BAD_OPTION', `Invalid mcp server name "${name}"`);
    const k = `mcp_servers.${name}`;
    a.push('-c', `${k}.command=${toml(m.command)}`, '-c', `${k}.default_tools_approval_mode="approve"`);
    if (m.args?.length) a.push('-c', `${k}.args=[${m.args.map(toml).join(',')}]`);
    if (m.env && Object.keys(m.env).length) a.push('-c', `${k}.env={${Object.entries(m.env).map(([x, y]) => `${toml(x)}=${toml(String(y))}`).join(',')}}`);
  }
  if (schemaFile) a.push('--output-schema', schemaFile);
  if (o.extraArgs != null && !(Array.isArray(o.extraArgs) && o.extraArgs.every((x) => typeof x === 'string'))) throw bad('extraArgs must be string[]');
  if (o.extraArgs?.length) a.push(...o.extraArgs.map(String));
  if (sub.length) {
    let id = s.id;
    if (!id) {
      id = newestRollout(o.cwd || process.cwd(), s.adoptForeign === true, s.scope ?? '');
      if (!id) throw bad(`No codex session started by this process found in cwd to ${mode} (pass session.id, or session.adoptForeign=true to adopt the newest session in cwd)`);
    } else if (!rolloutExists(id)) {
      throw bad(`Session ${id} not found (cannot ${mode})`);
    }
    // In-process claim: while a run holds a session, an id-less continue/fork that resolves to it is refused.
    if (!s.id && (BUSY.get(id) || 0) > 0) throw bad('session busy; pass explicit id');
    BUSY.set(id, (BUSY.get(id) || 0) + 1);
    claim.id = id;
    a.push(id);
  }
  a.push('-'); // prompt on stdin
  return a;
}

function listModels() {
  try {
    const j = JSON.parse(readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8'));
    return (j.models || []).filter((m) => m.visibility !== 'hide' && m.visibility !== 'hidden').map((m) => m.slug);
  } catch { return []; }
}

export default {
  name: 'codex',

  async models() { return listModels(); },

  async *run(opts) {
    const { writableRoots, ...base } = opts || {};
    if (writableRoots != null && !(Array.isArray(writableRoots) && writableRoots.every((x) => typeof x === 'string'))) throw bad('writableRoots must be string[]');
    const o = validateOptions(base);
    o.writableRoots = writableRoots;
    const t0 = Date.now();
    let prompt = o.prompt;
    if (o.permissions === 'plan') prompt = `${PLAN_NOTE}\n\n${prompt}`;
    let dir, schemaFile;
    if (o.jsonSchema != null && !(typeof o.jsonSchema === 'object' && !Array.isArray(o.jsonSchema) && o.jsonSchema.type === 'object')) throw bad('jsonSchema must be a JSON Schema object with type "object"');
    if (o.jsonSchema) {
      dir = mkdtempSync(path.join(tmpdir(), 'ab-codex-'));
      schemaFile = path.join(dir, 'schema.json');
      writeFileSync(schemaFile, JSON.stringify(o.jsonSchema));
    }
    const claim = {};
    try {
      const args = buildArgs(o, schemaFile, claim);
      const env = { ...process.env, ...(o.env || {}) };
      delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
      const p = spawnProc('codex', args, { cwd: o.cwd, env, input: prompt, timeoutMs: o.timeoutMs, signal: o.signal, agent: 'codex' });
      const sandbox = sandboxInfo(o);
      yield ev.raw({ type: 'sandbox', ...sandbox });
      if (sandbox.note && o.permissions !== 'full') yield ev.raw({ type: 'warning', message: sandbox.note });
      let modelBad = false;
      const MODEL_RE = /(model.{0,80}(not supported|does not exist|not found|unknown|invalid)|(not supported|unknown|invalid).{0,80}model)/is;
      let text = '', sessionId = o.session?.mode === 'continue' ? o.session.id : undefined;
      const seenErr = new Set();
      const errEv = (m) => (m && !seenErr.has(m) ? (seenErr.add(m), [ev.error(m)]) : []);
      let usage = { input: 0, output: 0, cost: null, cachedInput: 0, reasoning: 0 }, errMsg;
      for await (const line of p.lines) {
        const j = parseJsonLine(line);
        if (!j) continue;
        yield ev.raw(j);
        if (j.type === 'thread.started') {
          if (o.session?.mode === 'ephemeral') continue; // nothing persisted: no resumable id (matches claude adapter)
          sessionId = j.thread_id; OWN.set(sessionId, o.session?.scope ?? ''); yield ev.session(sessionId);
        }
        else if (j.type === 'turn.completed') {
          const u = j.usage || {};
          usage = { input: usage.input + (u.input_tokens || 0), output: usage.output + (u.output_tokens || 0), cost: null, cachedInput: usage.cachedInput + (u.cached_input_tokens || 0), reasoning: usage.reasoning + (u.reasoning_output_tokens || 0) };
          yield { ...ev.usage(u.input_tokens || 0, u.output_tokens || 0), cost: null, cachedInput: u.cached_input_tokens || 0, reasoning: u.reasoning_output_tokens || 0 };
        } else if (j.type === 'error' || j.type === 'turn.failed') {
          errMsg = j.message || j.error?.message || errMsg;
          for (const x of errEv(errMsg)) yield x;
          if (o.model && errMsg && MODEL_RE.test(errMsg)) { modelBad = true; p.kill(); }
        } else if (j.type === 'item.started') {
          // Tool events are emitted ONCE per id, on completion (start is visible only via the raw stream).
        } else if (j.type === 'item.completed' && j.item) {
          const it = j.item;
          if (it.type === 'agent_message') { text = it.text || ''; yield ev.text(text); }
          else if (it.type === 'reasoning') yield ev.thinking(it.text || '');
          else if (it.type === 'command_execution') yield { ...ev.tool('shell', { command: it.command }, it.aggregated_output), id: it.id, exitCode: it.exit_code };
          else if (it.type === 'mcp_tool_call') yield { ...ev.tool(`${it.server}.${it.tool}`, it.arguments, it.result ?? it.error), id: it.id };
          else if (it.type === 'file_change') yield { ...ev.tool('file_change', { changes: it.changes }, it.status), id: it.id };
          else if (it.type === 'error') { errMsg = errMsg || it.message; for (const x of errEv(it.message)) yield x; }
        }
      }
      const r = await p.wait();
      if (r.aborted) throw new AgentError('ABORTED', 'codex run aborted', { agent: 'codex' });
      if (r.timedOut) throw new AgentError('TIMEOUT', `codex timed out after ${o.timeoutMs}ms`, { agent: 'codex', timedOut: true });
      const blob = `${errMsg || ''}\n${r.stderr}`;
      if (o.permissions !== 'full' && /deny-read ACLs|Failed to create unified exec process/i.test(blob)) {
        const msg = 'codex sandbox could not start (' + o.permissions + '); on Windows try extraArgs [-c, windows.sandbox="unelevated"] or permissions "full"';
        yield ev.error(msg);
        throw new AgentError('AGENT_FAILED', msg, { agent: 'codex', stderr: r.stderr });
      }
      if (/unexpected argument|unrecognized (option|arguments?)/i.test(blob)) throw bad(`codex rejected extraArgs: ${blob.trim().slice(0, 200)}`);
      if (o.model && !text && (modelBad || MODEL_RE.test(blob))) throw bad(`Invalid model "${o.model}": ${blob.trim().slice(0, 200)}`);
      if (r.exitCode !== 0 || (errMsg && !text)) {
        if (!text && /not logged in|codex login|401|unauthorized/i.test(blob)) throw new AgentError('NOT_LOGGED_IN', `codex is not logged in (run "codex login"): ${blob.trim().slice(0, 300)}`, { agent: 'codex' });
        throw new AgentError('AGENT_FAILED', `codex exited ${r.exitCode}: ${blob.trim().slice(0, 500)}`, { agent: 'codex', exitCode: r.exitCode, stderr: r.stderr });
      }
      return { text, sessionId, usage, exitCode: r.exitCode, model: o.model || 'default', durationMs: Date.now() - t0, timedOut: false, sandbox };
    } finally {
      release(claim);
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  },
};
