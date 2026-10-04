// opencode adapter. Mechanism: a PER-RUN `opencode serve` (127.0.0.1, random free port, random Basic-auth password,
// minimal env allowlist) driven over HTTP + the `/event` SSE stream. Torn down (process tree killed) when the run ends,
// times out, aborts, or the parent exits. Chosen over `run --format json` because that mode only emits whole text parts;
// the server emits real `message.part.delta` token deltas, tool state transitions and permission events.
//
// Mapping notes:
//  - streaming   -> text/reasoning deltas from message.part.delta (part type learned from message.part.updated); parts that
//                   never delta (short ones) are emitted whole from part.updated. Tool parts: one {tool,input} on start,
//                   one {tool,input,output} on completion/error. permission.asked / question.asked are surfaced as `raw`
//                   events ({permissionAsked}) and auto-answered (full => once, else reject) so a run can never hang.
//  - permissions -> config `permission` block via OPENCODE_CONFIG_CONTENT (no secrets in it). Default read-only: edit/bash
//                   denied. Non-full modes also deny read of auth.json / the opencode data dir and any external_directory.
//                   'plan' additionally selects the `plan` agent.
//  - effort      -> prompt `variant`, validated against `opencode models --verbose` for the model; unsupported or no model
//                   => BAD_OPTION. max -> "max" or else "xhigh".
//  - systemPrompt-> native `system` field of the prompt.
//  - extraArgs   -> appended to `opencode serve` (e.g. --log-level ERROR, --pure); unknown flags surface as AGENT_FAILED.
//  - mcpServers  -> config `mcp` (type local). The callee model must be explicit when MCP tools are expected. The
//                   warm-up sequence polls GET /mcp until every configured server leaves 'connecting' before the
//                   first prompt (found+fixed a real race: without this, the model's first turn can start before the
//                   MCP handshake finishes, so the tool is simply absent from its toolset that turn).
//  - jsonSchema  -> emulated (prompt suffix + extraction + subset validation + one repair turn in the same session).
//  - session     -> new: persisted; ephemeral: deleted through the API before teardown; continue: session.id (else the newest
//                   session THIS PROCESS started in cwd; foreign sessions only with session.adoptForeign=true); fork: POST
//                   /session/:id/fork, prompt goes to the new session (original untouched).
//                   session.retryEmpty=true (default off) sends ONE follow-up turn if the model returned no text; it is a
//                   second paid prompt and leaves a synthetic user turn in the session, hence opt-in.
//  - exclusivity -> same pattern as adapters/claude.mjs: two concurrent id-less `continue` calls never silently share a
//                   session — the second gets a distinct free session this process owns, or BAD_OPTION 'session busy'.
//                   An explicit-id continue on an already-busy id is queued (serialized), not rejected.
//  - stall       -> if the session is busy but the model emits nothing for session.stallMs (default 45000) the turn is aborted and
//                   AGENT_FAILED('upstream model stalled') is thrown instead of hanging until timeoutMs (seen with opencode-go models).
//  - security    -> auth.json is read natively by opencode; no key is injected anywhere. The child gets an env ALLOWLIST, not
//                   process.env. Events/results/errors are redacted (raw, base64, hex, reversed, separator-chunked forms of
//                   every auth.json value + key patterns). THIS IS BEST-EFFORT DEFENSE IN DEPTH, NOT A BOUNDARY: in
//                   permissions:'full' the model has bash and can read auth.json and encode it in ways no filter can predict.
//                   Only read-only/edit/plan block reads of the credential store (via opencode permission rules).
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AgentError } from '../core/errors.mjs';
import { ev } from '../core/events.mjs';
import { spawnProc, runCollect, resolveBinary, killTree } from '../core/spawn.mjs';

const BIN = 'opencode';
const bad = (m) => new AgentError('BAD_OPTION', m, { agent: 'opencode' });
const fail = (m, x = {}) => new AgentError('AGENT_FAILED', m, { agent: 'opencode', ...x });
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (x) => String(x).replace(ANSI, '');
const fwd = (p) => p.split('\\').join('/');

const dataDir = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
const authFile = () => path.join(dataDir(), 'auth.json');

function assertInstalled(env) {
  if (!resolveBinary(BIN, env)) throw new AgentError('NOT_INSTALLED', 'opencode executable not found on PATH', { agent: 'opencode', binary: BIN });
}
function hasAuth() {
  try { const j = JSON.parse(readFileSync(authFile(), 'utf8')); return j && Object.keys(j).length > 0; } catch { return false; }
}

// ---- minimal env allowlist (never pass process.env wholesale: it may hold unrelated secrets) ----
const ENV_ALLOW = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'ALLUSERSPROFILE',
  'TEMP', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'LOGNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'LANG', 'LC_ALL', 'TERM', 'SHELL',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'];
function minimalEnv(extra = {}) {
  const out = {};
  const allow = new Set(ENV_ALLOW);
  for (const [k, v] of Object.entries(process.env)) if (allow.has(k.toUpperCase())) out[k] = v;
  return { ...out, ...extra };
}

// ---- redaction (best effort) ----
export function makeRedactor() {
  const secrets = new Set();
  const walk = (v) => { if (typeof v === 'string') { if (v.length >= 8) secrets.add(v); } else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  try { walk(JSON.parse(readFileSync(authFile(), 'utf8'))); } catch { /* none */ }
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const variants = new Set();
  for (const s of secrets) {
    const rev = [...s].reverse().join('');
    for (const b of [s, rev]) {
      variants.add(b);
      variants.add(Buffer.from(b).toString('hex')); variants.add(Buffer.from(b).toString('hex').toUpperCase());
      for (let pad = 0; pad < 3; pad++) { // base64 of the value at any byte alignment inside a larger string
        const enc = Buffer.from('\0'.repeat(pad) + b).toString('base64').replace(/=+$/, '');
        const skip = Math.ceil((pad * 4) / 3) + (pad ? 1 : 0);
        const core = enc.slice(skip, Math.max(skip + 8, enc.length - 2));
        if (core.length >= 12) { variants.add(core); variants.add(core.replace(/\+/g, '-').replace(/\//g, '_')); }
      }
    }
  }
  const list = [...variants].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length);
  const sepRes = [...secrets].flatMap((s) => [s, [...s].reverse().join('')]).filter((s) => s.length >= 12)
    .map((s) => new RegExp([...s].map(esc).join('[\\s\\-_.,:;|/\\\\]{0,3}'), 'g')); // dash/space chunked
  const pat = /\b(?:oc_sk_|sk-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_\-]{8,}/g;
  const str = (t) => {
    let r = t;
    for (const x of list) if (r.includes(x)) r = r.split(x).join('[REDACTED]');
    for (const re of sepRes) r = r.replace(re, '[REDACTED]');
    return r.replace(pat, '[REDACTED]');
  };
  const deep = (v) => (typeof v === 'string' ? str(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  return { str, deep };
}

// ---- sessions started by this process: id -> { cwd, seq } ----
const owned = new Map(); let seq = 0;
const norm = (d) => { try { return realpathSync(d).toLowerCase(); } catch { return path.resolve(d).toLowerCase(); } };
const touch = (id, cwd) => owned.set(id, { cwd: norm(cwd || process.cwd()), seq: ++seq });

// ---- session exclusivity (same pattern as adapters/claude.mjs): a "continue" claims its session id for the
// duration of the turn. Two concurrent id-less continues never silently share the same session id: the second
// either gets a distinct free one this process owns, or BAD_OPTION 'session busy'. An explicit-id continue on an
// already-busy id is serialized (queued), not rejected — matching claude.mjs. ----
const busy = new Map(); // session id -> in-flight continue count
const locks = new Map(); // session id -> promise tail
async function lockSession(id) {
  const prev = locks.get(id) || Promise.resolve();
  let release; const mine = new Promise((res) => { release = res; });
  const tail = prev.then(() => mine); locks.set(id, tail);
  await prev;
  return () => { release(); if (locks.get(id) === tail) locks.delete(id); };
}

// ---- servers: kill on parent exit ----
const live = new Set();
process.on('exit', () => { for (const p of live) killTree(p.child); });

let modelInfoCache;
async function modelInfo() {
  if (modelInfoCache) return modelInfoCache;
  const r = await runCollect(BIN, ['models', '--verbose'], { env: minimalEnv(), agent: 'opencode', timeoutMs: 60000 });
  const map = {};
  const re = /^(\S+\/\S+)\r?\n(\{[\s\S]*?\r?\n\})/gm;
  let m;
  while ((m = re.exec(r.stdout))) { try { map[m[1]] = Object.keys(JSON.parse(m[2]).variants || {}); } catch { /* skip */ } }
  return (modelInfoCache = map);
}
async function resolveVariant(effort, model) {
  const want = effort === 'max' ? ['max', 'xhigh'] : [effort];
  if (!model) throw bad('effort requires an explicit model (variants are model-specific)');
  const vs = (await modelInfo())[model];
  if (!vs) throw bad(`Unknown model "${model}" (see models())`);
  const hit = want.find((w) => vs.includes(w));
  if (!hit) throw bad(`effort "${effort}" is not supported by ${model} (variants: ${vs.join(', ') || 'none'})`);
  return hit;
}

function permissionBlock(p) {
  const full = p === 'full';
  const secretsDeny = { '*': 'allow', '**/auth.json': 'deny', '*auth.json': 'deny', '**/opencode/**': 'deny', '*/opencode/*': 'deny', '**/.local/share/opencode/**': 'deny' };
  const guard = {};
  if (!full) {
    guard.read = secretsDeny; guard.grep = secretsDeny; guard.glob = secretsDeny; guard.list = secretsDeny;
    guard.external_directory = { '*': 'deny' };
  }
  switch (p) {
    case 'full': return { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' };
    case 'edit': return { ...guard, edit: 'allow', bash: 'deny', webfetch: 'allow' };
    default: return { ...guard, edit: 'deny', bash: 'deny', webfetch: 'allow' };
  }
}
function buildConfig(o) {
  const cfg = { permission: permissionBlock(o.permissions), autoupdate: false, share: 'disabled' };
  if (o.mcpServers) {
    cfg.mcp = {};
    for (const [n, s] of Object.entries(o.mcpServers)) cfg.mcp[n] = { type: 'local', command: [s.command, ...(s.args || [])], enabled: true, ...(s.env ? { environment: s.env } : {}) };
  }
  return cfg;
}

// ---- minimal JSON-schema subset validator ----
export function validateSchema(v, s, p = '$') {
  const errs = [];
  if (!s || typeof s !== 'object') return errs;
  const t = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x);
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${p}: not in enum`);
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) errs.push(`${p}: not const`);
  if (s.type) {
    const types = [].concat(s.type);
    const ok = types.some((x) => x === t(v) || (x === 'number' && typeof v === 'number') || (x === 'integer' && Number.isInteger(v)));
    if (!ok) { errs.push(`${p}: expected ${types.join('|')}, got ${t(v)}`); return errs; }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of s.required || []) if (!(k in v)) errs.push(`${p}.${k}: required`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) errs.push(...validateSchema(v[k], sub, `${p}.${k}`));
    if (s.additionalProperties === false) for (const k of Object.keys(v)) if (!(s.properties || {})[k]) errs.push(`${p}.${k}: additional property`);
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => errs.push(...validateSchema(x, s.items, `${p}[${i}]`)));
  return errs;
}
export function extractJson(text) {
  const cands = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) cands.push(fence[1].trim());
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) cands.push(text.slice(a, b + 1));
  const c = text.indexOf('['), d = text.lastIndexOf(']');
  if (c >= 0 && d > c) cands.push(text.slice(c, d + 1));
  for (const x of cands) { try { return { value: JSON.parse(x) }; } catch { /* next */ } }
  return null;
}
const schemaSuffix = (schema) => `\n\nRespond with ONLY a single JSON value (no prose, no markdown fences) that validates against this JSON Schema:\n${JSON.stringify(schema)}`;

const freePort = () => new Promise((res, rej) => {
  const s = createServer(); s.unref(); s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull queue over an SSE response; next(ms) -> event | null (timeout); throws when the stream ends/errs.
function sseQueue(resp, onEnd) {
  const q = []; let waiter = null, ended = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
  (async () => {
    try {
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of resp.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          try { q.push(JSON.parse(data)); wake(); } catch { /* ignore */ }
        }
      }
      ended = new Error('event stream closed');
    } catch (e) { ended = e; }
    wake(); onEnd?.();
  })();
  return {
    async next(ms) {
      for (;;) {
        if (q.length) return q.shift();
        if (ended) throw ended;
        const timed = await new Promise((r) => { const t = ms != null ? setTimeout(() => { waiter = null; r(true); }, ms) : null; waiter = () => { clearTimeout(t); r(false); }; });
        if (timed && !q.length) return null;
      }
    },
  };
}

const errText = (e) => stripAnsi(e?.data?.message || e?.message || e?.name || (typeof e === 'string' ? e : JSON.stringify(e ?? '')));

export default {
  name: 'opencode',

  async models() {
    assertInstalled(process.env);
    const r = await runCollect(BIN, ['models'], { env: minimalEnv(), agent: 'opencode', timeoutMs: 60000 });
    if (r.exitCode !== 0) throw fail(`opencode models failed: ${stripAnsi(r.stderr)}`, { exitCode: r.exitCode });
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[^\s/]+\/\S+$/.test(s));
  },

  async *run(o) {
    const R = makeRedactor();
    let toolCount = 0;
    const it = this._run(o);
    try {
      for (;;) {
        const n = await it.next();
        if (n.done) { const r = R.deep(n.value); if (r.sessionId) touch(r.sessionId, o.cwd); return r; }
        const e = R.deep(n.value);
        if (e.type === 'session') touch(e.id, o.cwd);
        if (e.type === 'tool') toolCount++;
        yield e;
      }
    } catch (e) {
      if (e instanceof AgentError) {
        e.message = R.str(stripAnsi(e.message));
        for (const k of ['stderr', 'partial', 'lastEvents']) if (typeof e[k] === 'string') e[k] = R.str(stripAnsi(e[k]));
      }
      throw e;
    }
  },

  async *_run(o) {
    const started = Date.now();
    assertInstalled(process.env);
    if (!hasAuth()) throw new AgentError('NOT_LOGGED_IN', `No opencode credentials at ${authFile()} (run \`opencode auth login\`)`, { agent: 'opencode' });
    if (o.model && !/^[^\s/]+\/[^\s]+$/.test(o.model)) throw bad('model must be "provider/model"');
    if (o.cwd && !existsSync(o.cwd)) throw bad(`cwd does not exist: ${o.cwd}`);
    const variant = o.effort ? await resolveVariant(o.effort, o.model) : undefined;
    const [providerID, ...rest] = (o.model || '').split('/');
    const modelID = rest.join('/');
    const cwd = path.resolve(o.cwd || process.cwd());
    const mode = o.session?.mode || 'new';

    if ((mode === 'continue' || mode === 'fork') && !o.session.id && !o.session.adoptForeign && ![...owned.values()].some((v) => v.cwd === norm(cwd))) {
      throw bad(`session.mode "${mode}" without id: no session started by this process in ${cwd} (pass session.id, or session.adoptForeign=true to take the newest session on disk)`);
    }

    // For a no-id `continue`, resolve+claim the session BEFORE spinning up a server: this needs only in-process state
    // (the `owned`/`busy` maps), so the 'session busy' BAD_OPTION comes back instantly under concurrency instead of
    // racing against a full per-call `opencode serve` startup (which can itself take a while under load and would
    // otherwise let a slow start masquerade as a plain TIMEOUT rather than the busy conflict it actually is).
    let preClaimedId;
    if (mode === 'continue' && !o.session.id) {
      const mine = [...owned].filter(([, v]) => v.cwd === norm(cwd)).sort((a, b) => b[1].seq - a[1].seq);
      const free = mine.find(([sid]) => !busy.get(sid));
      if (free) { preClaimedId = free[0]; busy.set(preClaimedId, (busy.get(preClaimedId) || 0) + 1); }
      else if (mine.length) throw bad('session busy (in use by another continue); pass an explicit session.id');
    }

    // ---- start the server ----
    const port = await freePort();
    const password = randomBytes(24).toString('hex');
    const userCfg = (() => { try { return JSON.parse(o.env?.OPENCODE_CONFIG_CONTENT || '{}'); } catch { return {}; } })();
    const cfg = buildConfig(o);
    const config = { ...userCfg, ...cfg, permission: { ...(userCfg.permission || {}), ...cfg.permission }, mcp: { ...(userCfg.mcp || {}), ...(cfg.mcp || {}) } };
    const env = minimalEnv({ ...(o.env || {}), OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' });
    const deadline = o.timeoutMs ? started + o.timeoutMs : 0;
    const proc = spawnProc(BIN, ['serve', '--port', String(port), '--hostname', '127.0.0.1', ...(o.extraArgs || [])], { cwd, env, timeoutMs: o.timeoutMs, signal: o.signal, agent: 'opencode' });
    live.add(proc);
    const tail = []; // last stdout lines, for diagnostics
    (async () => { for await (const l of proc.lines) { tail.push(l); if (tail.length > 30) tail.shift(); } })().catch(() => {});
    let exited = null;
    const done = proc.wait().then((r) => { exited = r; return r; }, (e) => { exited = { error: e, exitCode: -1 }; return exited; });
    const fetchAc = new AbortController();
    done.then(() => fetchAc.abort());
    const base = `http://127.0.0.1:${port}`;
    const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
    const dq = `directory=${encodeURIComponent(fwd(cwd))}`;
    const lastEvents = [];
    const recent = (e) => { lastEvents.push(JSON.stringify(e).slice(0, 300)); if (lastEvents.length > 8) lastEvents.shift(); };
    const diag = () => `${exited?.stderr ? `stderr: ${stripAnsi(exited.stderr).split('\n').slice(-6).join(' | ')}; ` : ''}${tail.length ? `server: ${stripAnsi(tail.slice(-4).join(' | '))}; ` : ''}${lastEvents.length ? `last events: ${lastEvents.join(' ; ')}` : ''}`;
    const stopped = () => {
      if (exited?.timedOut) return new AgentError('TIMEOUT', `opencode timed out after ${o.timeoutMs}ms. ${diag()}`, { agent: 'opencode' });
      if (exited?.aborted || o.signal?.aborted) return new AgentError('ABORTED', 'Aborted', { agent: 'opencode' });
      return null;
    };
    const http = async (method, p, body, timeoutMs) => {
      let r;
      try {
        r = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}${dq}`, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: timeoutMs ? AbortSignal.any([fetchAc.signal, AbortSignal.timeout(timeoutMs)]) : fetchAc.signal });
      } catch (e) { throw stopped() || fail(`opencode server request failed: ${errText(e)}. ${diag()}`, { exitCode: exited?.exitCode }); }
      const txt = await r.text();
      let j; try { j = txt ? JSON.parse(txt) : undefined; } catch { j = txt; }
      return { status: r.status, body: j };
    };

    let sessionId; const toDelete = new Set();
    let text = '', json;
    const usage = { input: 0, output: 0 };
    let claimedId, unlockSession;
    try {
      // wait for readiness
      for (let i = 0; ; i++) {
        if (exited) throw stopped() || fail(`opencode serve exited before becoming ready (code ${exited.exitCode}). ${diag()}`, { exitCode: exited.exitCode, stderr: exited.stderr });
        try { const r = await fetch(`${base}/global/health`, { headers: { authorization: auth }, signal: AbortSignal.any([fetchAc.signal, AbortSignal.timeout(3000)]) }); if (r.ok) break; } catch { /* not yet */ }
        if (i > 200) throw fail(`opencode serve did not become ready. ${diag()}`);
        await sleep(150);
      }

      // warm the per-directory instance (plugins/providers/MCP bootstrap) before any session work; prompts sent mid-bootstrap can be lost
      // (bounded: a bootstrap request that hangs is retried once instead of waiting out the whole run timeout)
      for (const p of ['/config/providers', '/agent']) {
        try { await http('GET', p, undefined, 20000); } catch (e) { if (stopped() || exited) throw e; await http('GET', p, undefined, 20000); }
      }

      // Wait for configured MCP servers to finish connecting before the first prompt: without this, a prompt sent
      // immediately after the health check can reach the model before opencode's MCP client handshake completes, so
      // the tool is simply absent from that turn's toolset (not a wrong answer - the tool never existed for it).
      // GET /mcp reports {<name>: {status: 'connecting'|'connected'|'error'|...}} per configured server.
      if (o.mcpServers && Object.keys(o.mcpServers).length) {
        const names = Object.keys(o.mcpServers);
        for (let i = 0; ; i++) {
          const m = await http('GET', '/mcp');
          const st = (m.body && typeof m.body === 'object') ? m.body : {};
          if (names.every((n) => st[n] && st[n].status !== 'connecting')) break;
          if (i > 100) throw fail(`MCP server(s) did not finish connecting within 20s: ${JSON.stringify(st)}. ${diag()}`, { sessionId });
          await sleep(200);
        }
      }

      // ---- session resolution ----
      if (mode === 'continue' || mode === 'fork') {
        let id = o.session.id ?? preClaimedId;
        if (!id) {
          const mine = [...owned].filter(([, v]) => v.cwd === norm(cwd)).sort((a, b) => b[1].seq - a[1].seq);
          if (mode === 'continue') {
            // preClaimedId (above, before the server started) already handles the normal case; reaching here for
            // continue means there were zero owned sessions at all (adoptForeign path) or a stale set, so just retry
            // the same free-pick logic (no new race window: nothing outside this call has run since).
            const free = mine.find(([sid]) => !busy.get(sid));
            if (free) id = free[0];
            else if (mine.length) throw bad('session busy (in use by another continue); pass an explicit session.id');
          } else if (mine.length) id = mine[0][0];
          if (!id && o.session.adoptForeign) {
            const l = await http('GET', '/session');
            const arr = (Array.isArray(l.body) ? l.body : []).filter((x) => x.directory && norm(x.directory) === norm(cwd));
            arr.sort((a, b) => (b.time?.updated ?? b.updated ?? 0) - (a.time?.updated ?? a.updated ?? 0));
            id = arr[0]?.id;
          }
          if (!id) throw bad(`session.mode "${mode}" without id: no session started by this process in ${cwd} (pass session.id, or session.adoptForeign=true to take the newest session on disk)`);
        }
        // Claim + serialize: synchronous (no await between resolving `id` above and this) so two concurrent no-id
        // continues can never both claim the same free id; an explicit-id continue on a busy id queues instead of failing.
        // (preClaimedId was already counted in `busy` before the server started; don't double-count it here.)
        if (mode === 'continue') { claimedId = id; if (id !== preClaimedId) busy.set(claimedId, (busy.get(claimedId) || 0) + 1); }
        unlockSession = claimedId ? await lockSession(claimedId) : null;
        const g = await http('GET', `/session/${encodeURIComponent(id)}`);
        if (g.status !== 200) throw bad(`session not found: ${id}`);
        if (mode === 'fork') {
          const f = await http('POST', `/session/${encodeURIComponent(id)}/fork`, {});
          if (f.status !== 200 || !f.body?.id) throw fail(`fork failed (${f.status}): ${errText(f.body)}. ${diag()}`);
          sessionId = f.body.id;
        } else sessionId = id;
      } else {
        const c = await http('POST', '/session', {}, 30000);
        if (c.status !== 200 || !c.body?.id) throw fail(`session create failed (${c.status}): ${errText(c.body)}. ${diag()}`);
        sessionId = c.body.id;
      }
      if (mode === 'ephemeral') toDelete.add(sessionId);
      yield ev.session(sessionId);

      // ---- event stream ----
      const sr = await fetch(`${base}/event?${dq}`, { headers: { authorization: auth, accept: 'text/event-stream' }, signal: fetchAc.signal }).catch((e) => { throw stopped() || fail(`event stream failed: ${errText(e)}. ${diag()}`); });
      if (!sr.ok) throw fail(`event stream HTTP ${sr.status}`);
      const q = sseQueue(sr);
      for (;;) { const e = await q.next(3000); if (!e || e.type === 'server.connected') break; }

      const agent = o.permissions === 'plan' ? 'plan' : undefined;
      const roles = new Map(), ptypes = new Map(), emitted = new Map(), toolSeen = new Map();
      let lastTool;

      const turn = async function* (prompt) {
        const body = { parts: [{ type: 'text', text: prompt }, ...(o.images || []).map((im, n) => ({ type: 'file', mime: im.mediaType, filename: `image-${n}.${im.mediaType.split('/')[1]}`, url: `data:${im.mediaType};base64,${im.data}` }))] };
        if (o.model) body.model = { providerID, modelID };
        if (variant) body.variant = variant;
        if (agent) body.agent = agent;
        if (o.systemPrompt) body.system = o.systemPrompt;
        const listMsgs = async () => { const m = await http('GET', `/session/${encodeURIComponent(sessionId)}/message`); return Array.isArray(m.body) ? m.body : []; };
        const preIds = new Set((await listMsgs()).map((m) => m.info?.id));
        const pr = await http('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
        if (pr.status >= 300) throw fail(`prompt rejected (${pr.status}): ${errText(pr.body)}. ${diag()}`);
        let out = '', err, idleAt = 0, sawBusy = false, lastOwn = Date.now(), lastPoll = 0, reposted = 0;
        const synth = [];
        for (;;) {
          let e = synth.shift();
          // Fallback: if the SSE stream goes quiet (missed/late events), reconcile from the message API so a run never hangs.
          if (!e && !idleAt && Date.now() - lastOwn > 6000 && Date.now() - lastPoll > 6000) {
            lastPoll = Date.now();
            const msgs = (await listMsgs()).filter((m) => !preIds.has(m.info?.id));
            if (process.env.AGENTBRIDGE_DEBUG) console.error('[oc] poll', msgs.length, JSON.stringify((await http('GET', '/session/status')).body), msgs.map((m) => m.info?.role + ':' + (m.parts || []).map((p) => p.type + '/' + (p.state?.status || '')).join(',')).join(' | '));
            for (const m of msgs) { synth.push({ type: 'message.updated', properties: { sessionID: sessionId, info: m.info } }); for (const pt of m.parts || []) synth.push({ type: 'message.part.updated', properties: { sessionID: sessionId, part: pt } }); }
            if (!msgs.length && reposted < 2) { reposted++; await http('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body); }
            const last = [...msgs].reverse().find((m) => m.info?.role === 'assistant');
            const running = (last?.parts || []).some((pt) => pt.type === 'tool' && !['completed', 'error'].includes(pt.state?.status));
            if (last?.info?.time?.completed && !running) synth.push({ type: 'session.idle', properties: { sessionID: sessionId } });
            const stallMs = o.session?.stallMs ?? 45000;
            if (!running && Date.now() - lastOwn > stallMs) {
              await http('POST', `/session/${encodeURIComponent(sessionId)}/abort`, {}).catch(() => {});
              throw fail(`upstream model stalled: no output for ${Math.round((Date.now() - lastOwn) / 1000)}s while the session was busy (provider/model hang; the turn was aborted). Retry, or choose another model. ${diag()}`, { sessionId, stalled: true });
            }
            e = synth.shift();
          }
          if (!e) try { e = await q.next(idleAt ? 300 : 2000); } catch (x) { throw stopped() || fail(`event stream ended: ${errText(x)}. ${diag()}`, { exitCode: exited?.exitCode }); }
          if (e === null) { if (idleAt) break; const s = stopped(); if (s) throw s; continue; }
          const pr2 = e.properties || {};
          if (pr2.sessionID && pr2.sessionID !== sessionId) continue;
          // Only genuine progress resets the stall clock — NOT generic session.status/heartbeat pings, which
          // repeat every few seconds even while the upstream model is completely hung (this previously masked stalls).
          if (['message.part.updated', 'message.part.delta', 'message.updated', 'session.idle', 'session.error', 'permission.asked', 'question.asked'].includes(e.type)) lastOwn = Date.now();
          recent({ t: e.type, ...(e.type.startsWith('message.part') ? {} : pr2) });
          if (process.env.AGENTBRIDGE_DEBUG) console.error('[oc]', e.type, JSON.stringify(pr2.status || pr2.error || '').slice(0, 300));
          switch (e.type) {
            case 'message.updated': {
              const info = pr2.info || {};
              if (info.id) roles.set(info.id, info.role);
              if (info.role === 'assistant' && info.error) err = errText(info.error);
              break;
            }
            case 'message.part.updated': {
              const part = pr2.part || {};
              if (roles.get(part.messageID) === 'user') break;
              if (part.type === 'text' || part.type === 'reasoning') {
                ptypes.set(part.id, part.type);
                const have = emitted.get(part.id) || 0;
                if (typeof part.text === 'string' && part.text.length > have && roles.get(part.messageID) !== 'user' && roles.has(part.messageID)) {
                  const d = part.text.slice(have); emitted.set(part.id, part.text.length);
                  if (part.type === 'text') { out += d; yield ev.text(d); } else yield ev.thinking(d);
                }
              } else if (part.type === 'tool') {
                const st = part.state || {};
                const prev = toolSeen.get(part.callID);
                if (st.status === 'running' || st.status === 'pending') { if (!prev) { toolSeen.set(part.callID, 'run'); yield ev.tool(part.tool, st.input ?? {}); } }
                else if ((st.status === 'completed' || st.status === 'error') && prev !== 'done') {
                  toolSeen.set(part.callID, 'done');
                  const outp = st.status === 'error' ? `ERROR: ${st.error ?? ''}` : (typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? ''));
                  lastTool = { name: part.tool, output: outp };
                  yield ev.tool(part.tool, st.input ?? {}, outp);
                }
              } else if (part.type === 'step-finish' && !toolSeen.has('sf:' + part.id)) {
                toolSeen.set('sf:' + part.id, 1);
                const t = part.tokens || {};
                const i = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0), c = (t.output || 0) + (t.reasoning || 0);
                usage.input += i; usage.output += c;
                if (typeof part.cost === 'number') usage.cost = (usage.cost || 0) + part.cost;
                yield ev.usage(i, c, part.cost);
              }
              break;
            }
            case 'message.part.delta': {
              if (pr2.field !== 'text' || roles.get(pr2.messageID) === 'user') break;
              const pt = ptypes.get(pr2.partID) || 'text';
              if (!roles.has(pr2.messageID)) break;
              emitted.set(pr2.partID, (emitted.get(pr2.partID) || 0) + pr2.delta.length);
              if (pt === 'text') { out += pr2.delta; yield ev.text(pr2.delta); } else yield ev.thinking(pr2.delta);
              break;
            }
            case 'permission.asked': {
              yield ev.raw({ permissionAsked: pr2 });
              await http('POST', `/permission/${encodeURIComponent(pr2.id || pr2.requestID)}/reply`, { reply: o.permissions === 'full' ? 'once' : 'reject' });
              break;
            }
            case 'question.asked': {
              yield ev.raw({ questionAsked: pr2 });
              await http('POST', `/question/${encodeURIComponent(pr2.id || pr2.requestID)}/reject`, {});
              break;
            }
            case 'session.status': if (pr2.status?.type === 'busy') sawBusy = true; else if (pr2.status?.type === 'idle' && sawBusy && !idleAt) idleAt = Date.now(); break;
            case 'session.idle': if (!idleAt) idleAt = Date.now(); break;
            case 'session.error': err = errText(pr2.error); yield ev.error(err); break;
            default: break;
          }
        }
        if (err) {
          if (/not logged in|unauthori[sz]ed|invalid api key|missing api key|\b401\b/i.test(err)) throw new AgentError('NOT_LOGGED_IN', err, { agent: 'opencode', sessionId });
          throw fail(err, { sessionId, partial: out });
        }
        return out;
      };
      const runTurn = async function* (p) { text = yield* turn(p); };

      yield* runTurn(o.jsonSchema ? o.prompt + schemaSuffix(o.jsonSchema) : o.prompt);
      if (!text.trim() && o.session?.retryEmpty) yield* runTurn('Your last reply was empty. Please answer the previous request now, in text.');
      if (o.jsonSchema) {
        for (let attempt = 0; ; attempt++) {
          const x = extractJson(text);
          const errs = x ? validateSchema(x.value, o.jsonSchema) : ['reply is not valid JSON'];
          if (!errs.length) { json = x.value; text = JSON.stringify(x.value); break; }
          if (attempt >= 1) throw fail(`jsonSchema validation failed: ${errs.slice(0, 5).join('; ')}`, { partial: text });
          yield* runTurn(`Your previous reply was invalid (${errs.slice(0, 5).join('; ')}). Reply again with ONLY the corrected JSON value.`);
        }
      }
      if (!text.trim()) {
        if (lastTool) text = `[no assistant text; last tool "${lastTool.name}" output: ${String(lastTool.output).slice(0, 500)}]`;
        else throw fail('opencode returned an empty response (model produced no text and no tool calls). Retry, pick another model, or set session.retryEmpty=true.', { sessionId, lastEvents: lastEvents.join(' ; ') });
      }
    } catch (e) {
      if (e instanceof AgentError) { e.sessionId ??= sessionId; }
      else if (!(e instanceof AgentError)) { const s = stopped(); if (s) throw s; throw fail(`${errText(e)}. ${diag()}`, { sessionId }); }
      const s = (e.code === 'AGENT_FAILED' || e.code === 'TIMEOUT' || e.code === 'ABORTED') ? stopped() : null;
      throw s || e;
    } finally {
      unlockSession?.();
      if (claimedId) { const n = (busy.get(claimedId) || 1) - 1; if (n > 0) busy.set(claimedId, n); else busy.delete(claimedId); }
      else if (preClaimedId) { const n = (busy.get(preClaimedId) || 1) - 1; if (n > 0) busy.set(preClaimedId, n); else busy.delete(preClaimedId); } // server never reached session resolution
      if (toDelete.size && !exited) for (const id of toDelete) { try { await http('DELETE', `/session/${encodeURIComponent(id)}`); } catch { /* best effort */ } }
      proc.kill(); live.delete(proc);
      await Promise.race([done, sleep(3000)]);
    }
    return {
      text, sessionId, usage, exitCode: 0, model: o.model || 'default', durationMs: Date.now() - started, timedOut: false,
      ...(json !== undefined ? { json } : {}),
    };
  },
};
