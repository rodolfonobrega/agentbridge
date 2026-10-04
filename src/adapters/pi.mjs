// pi (https://pi.dev, `@earendil-works/pi-coding-agent`) adapter. See acceptance/ADAPTER_NOTES.md ("pi") for the verified facts behind each choice.
//
// pi has no sandbox and no permission modes, only a tool allow/deny list, so a run is shaped like this:
//   - the prompt goes through STDIN (no argv length/quoting limits, nothing for a same-user process to read from the command line);
//   - every run gets its OWN agent dir (PI_CODING_AGENT_DIR): a copy of the user's models.json / auth.json / settings.json (resource lists
//     such as packages/extensions/skills stripped) plus the run's generated mcp.json. Project-local `.pi/` files are never trusted (--no-approve);
//   - permissions are tool deny lists: read-only/plan = no bash/powershell/edit/write, edit = no bash/powershell, full = everything;
//   - sessions live in a persistent store of our own (<AGENTBRIDGE_HOME>/pi-store/sessions) so continue/fork work across processes.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync, renameSync, copyFileSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawnProc, runCollect, resolveBinary } from '../core/spawn.mjs';
import { AgentError, looksRateLimited, retryAfterMs } from '../core/errors.mjs';
import { ev, parseJsonLine } from '../core/events.mjs';
import { validateOptions } from '../index.mjs';
import { home } from '../bridge/runs.mjs';
import { extractJson, validate as validateSchema } from '../extras/schema.mjs';

const NAME = 'pi';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const AUTH_RE = /no api key found|\/login|^\s*(401|403)\b|invalid[_ ]api[_ ]key|unauthori[sz]ed|not (logged|signed) in|authentication (failed|error|required)|credentials? (expired|invalid)/i;
const MODEL_RE = /^\s*404\b.*model|model .{0,80}not found|unknown model|no such model|invalid model/i;
const OPTION_RE = /unknown option|unknown argument|no session found|invalid (value|option)|requires (a )?(value|argument)|is not a valid/i;
const busy = new Set();
const bad = (m) => new AgentError('BAD_OPTION', m, { agent: NAME });

// Flags the adapter owns (the output format and session handling are parsed/managed here) and flags that would widen permissions.
const OWNED_FLAGS = /^(--mode|--print|-p|--session-dir|--session|--session-id|--continue|-c|--resume|-r|--fork|--no-session|--approve|-a|--no-approve|-na)(=|$)/;
const PERM_FLAGS = /^(--tools|-t|--no-tools|-nt|--no-builtin-tools|-nbt|--exclude-tools|-xt|--extension|-e|--skill|--prompt-template|--theme|--api-key|--provider)(=|$)/;
// Tools denied per permission level. codemode/tool_search can reach MCP tools indirectly and have no reason to be on in a restricted run.
const DENY = {
  'read-only': ['bash', 'powershell', 'edit', 'write', 'codemode', 'tool_search'],
  plan: ['bash', 'powershell', 'edit', 'write', 'codemode', 'tool_search'],
  edit: ['bash', 'powershell', 'codemode', 'tool_search'],
  full: [],
};
// Resource lists in the user's settings would load extensions/packages into a run that is supposed to be shaped by us.
const STRIP_SETTINGS = ['packages', 'extensions', 'skills', 'prompts', 'themes', 'defaultTools', 'shellCommandPrefix', 'enableSkillCommands'];

export const agentDirOf = (env = process.env) => env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
export const storeDir = (env = process.env) => path.join(home(env), 'pi-store');
export const sessionsDir = (env = process.env) => path.join(storeDir(env), 'sessions');

export function findBinary(env = process.env) {
  const npm = env.APPDATA ? path.join(env.APPDATA, 'npm') : null;
  const cands = [env.PI_BIN, npm && path.join(npm, 'pi.cmd'), npm && path.join(npm, 'pi'), path.join(homedir(), '.local', 'bin', 'pi')].filter(Boolean);
  return resolveBinary(NAME, env) || cands.find((c) => { try { return statSync(c).isFile(); } catch { return false; } }) || null;
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
function headerOf(f) { // first JSONL line of a session file: {type:'session', id, cwd}
  let fd; try { fd = openSync(f, 'r'); const b = Buffer.alloc(4096); const n = readSync(fd, b, 0, 4096, 0); return parseJsonLine(b.subarray(0, n).toString('utf8').split('\n')[0]); } catch { return null; } finally { if (fd != null) try { closeSync(fd); } catch { /* ignore */ } }
}
const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));

/** [{id, cwd, file, mtime}] for the sessions in `dir`, newest first. */
export function listSessions(dir) {
  let names = []; try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  const out = [];
  for (const n of names) { const f = path.join(dir, n); const h = headerOf(f); if (h?.type === 'session' && UUID.test(h.id || '')) { let mtime = 0; try { mtime = statSync(f).mtimeMs; } catch { /* gone */ } out.push({ id: h.id, cwd: h.cwd, file: f, mtime }); } }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Per-run agent dir. `src` is the user's real agent dir; only the files pi needs to authenticate and pick models are carried over. */
export function makeAgentDir({ src, mcpServers, extraSettings = {}, appendSystem, passEnv = [] }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-pi-'));
  try {
    for (const f of ['models.json', 'auth.json']) if (existsSync(path.join(src, f))) copyFileSync(path.join(src, f), path.join(dir, f));
    const settings = readJson(path.join(src, 'settings.json')) || {};
    for (const k of STRIP_SETTINGS) delete settings[k];
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...settings, ...extraSettings }));
    if (mcpServers && Object.keys(mcpServers).length) {
      const servers = {};
      for (const [n, s] of Object.entries(mcpServers)) {
        // `${VAR}` is resolved by pi from ITS OWN process env, so a secret passed in opts.env reaches the server without being written to disk.
        const env = { ...(s.env || {}) }; for (const k of passEnv) env[k] ??= '${' + k + '}';
        servers[n] = { command: s.command, args: s.args || [], env, exposure: 'direct' };
      }
      writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: servers, autoEnableCodemode: false }));
    }
    if (appendSystem) writeFileSync(path.join(dir, 'APPEND_SYSTEM.md'), appendSystem);
  } catch (e) { destroyAgentDir({ dir }); throw e; }
  return { dir, src };
}

/** Delete the per-run dir; first carry a refreshed OAuth token back so a login that expired during the run is not lost. */
export function destroyAgentDir(d) {
  if (!d?.dir) return;
  try {
    if (d.src) {
      const mine = path.join(d.dir, 'auth.json'), real = path.join(d.src, 'auth.json');
      if (existsSync(mine) && existsSync(real) && d.authBefore != null) {
        const now = readFileSync(mine, 'utf8');
        if (now !== d.authBefore && readFileSync(real, 'utf8') === d.authBefore) { const t = `${real}.${process.pid}.tmp`; writeFileSync(t, now, { mode: 0o600 }); renameSync(t, real); }
      }
    }
  } catch { /* best effort: never turn cleanup into a failure */ }
  try { rmSync(d.dir, { recursive: true, force: true }); } catch { /* temp dir */ }
}

const schemaSuffix = (schema) => `\n\nRespond with ONLY a single JSON value (no prose, no markdown fences) that validates against this JSON Schema:\n${JSON.stringify(schema)}`;
const textOf = (m) => (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === 'text').map((c) => c.text).join('') : typeof m?.content === 'string' ? m.content : '');
const outputOf = (r) => (Array.isArray(r?.content) ? r.content.filter((c) => c?.type === 'text').map((c) => c.text).join('') : typeof r === 'string' ? r : JSON.stringify(r ?? ''));

function classify(msg) {
  if (looksRateLimited(msg) && !/^\s*40[13]\b/.test(msg)) return 'RATE_LIMITED';
  if (AUTH_RE.test(msg)) return 'NOT_LOGGED_IN';
  if (MODEL_RE.test(msg) || OPTION_RE.test(msg)) return 'BAD_OPTION';
  return 'AGENT_FAILED';
}

export default {
  name: NAME,
  efforts: EFFORTS,
  canFork: true,
  async models(env = process.env) {
    const bin = findBinary(env);
    if (!bin) return [];
    try {
      const r = await runCollect(bin, ['--list-models'], { timeoutMs: 30000, env: { ...env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' } });
      return (r.stdout + '\n' + r.stderr).split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2 && c[0] !== 'provider' && /^[\w.-]+$/.test(c[0]) && /\S/.test(c[1])).map((c) => `${c[0]}/${c[1]}`);
    } catch { return []; }
  },
  async *run(opts) {
    const o = validateOptions(opts);
    if (o.isolated === false) throw bad('pi always runs with its own agent dir (that is how MCP servers and permissions are applied); isolated:false is not supported');
    if (o.effort != null && !EFFORTS.includes(o.effort)) throw bad(`effort must be one of ${EFFORTS.join('|')}`);
    const perms = o.permissions || 'read-only';
    const sess = o.session || { mode: 'new' };
    for (const a of o.extraArgs || []) {
      if (OWNED_FLAGS.test(a)) throw bad(`extraArgs may not contain ${a}: the adapter owns the output mode, session handling and project trust`);
      if (perms !== 'full' && PERM_FLAGS.test(a)) throw bad(`extraArgs may not contain ${a} when permissions is "${perms}" (it would change the tool set, extensions or provider)`);
    }
    const env = { ...process.env, ...(o.env || {}) };
    const bin = findBinary(env);
    if (!bin) throw new AgentError('NOT_INSTALLED', 'pi not found on PATH (npm i -g @earendil-works/pi-coding-agent). Log in once with `pi` (/login) or configure a provider in ~/.pi/agent/models.json, or set PI_BIN.', { agent: NAME, binary: NAME });
    const cwd = path.resolve(o.cwd || process.cwd());

    // ---- session resolution (an unknown id must fail loudly)
    const sdir = sessionsDir(env);
    let resume, claimed = null;
    if (sess.mode === 'continue' || sess.mode === 'fork') {
      if (sess.id != null && !UUID.test(sess.id)) throw bad('session.id must be a UUID');
      const all = listSessions(sdir);
      const hit = sess.id ? all.find((s) => s.id.toLowerCase() === sess.id.toLowerCase()) : all.find((s) => norm(s.cwd) === norm(cwd) && !busy.has(s.id));
      if (!hit) throw bad(sess.id ? `Unknown pi session "${sess.id}"` : `session mode "${sess.mode}" without id: no pi session recorded for cwd ${cwd}`);
      if (sess.mode === 'continue') { if (busy.has(hit.id)) throw bad('session busy (in use by another continue)'); busy.add(hit.id); claimed = hit.id; }
      resume = hit.id;
    }
    const ephemeral = sess.mode === 'ephemeral';

    const t0 = Date.now();
    let ad, p, tmpSessions;
    try {
      const mcpNames = Object.keys(o.mcpServers || {});
      ad = makeAgentDir({
        src: agentDirOf(env), mcpServers: o.mcpServers, appendSystem: o.systemPrompt, passEnv: ['AGENTBRIDGE_ATTEST_KEY'].filter((k) => o.env?.[k] != null),
        // fail fast on provider limits so a fallback can take over; one retry still absorbs a transient blip
        extraSettings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000, maxAgentDelayMs: 5000 }, enableInstallTelemetry: false },
      });
      try { ad.authBefore = existsSync(path.join(ad.dir, 'auth.json')) ? readFileSync(path.join(ad.dir, 'auth.json'), 'utf8') : null; } catch { ad.authBefore = null; }
      if (ephemeral && o.jsonSchema) { tmpSessions = mkdtempSync(path.join(tmpdir(), 'ab-pi-sess-')); } // schema repair needs a second turn in the same session
      mkdirSync(sdir, { recursive: true });

      const spawnTurn = (prompt, sessionArgs) => {
        // -ne disables every extension; an explicit -e still loads, so only the built-in MCP support stays (and only when there are servers)
        const args = ['--mode', 'json', '--no-approve', '-ns', '-np', '-ne', ...(mcpNames.length ? ['-e', 'builtin:mcp'] : [])];
        if (o.model) args.push('--model', o.model);
        if (o.effort) args.push('--thinking', o.effort);
        if (DENY[perms].length) args.push('--exclude-tools', DENY[perms].join(','));
        args.push(...sessionArgs);
        if (o.extraArgs) args.push(...o.extraArgs);
        return spawnProc(bin, args, {
          cwd, input: prompt, timeoutMs: o.timeoutMs, signal: o.signal, agent: NAME,
          env: { ...(o.env || {}), PI_CODING_AGENT_DIR: ad.dir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
        });
      };

      let sessionId, text = '', structured;
      const sum = { input: 0, output: 0, cachedInput: 0, reasoning: 0, cost: 0 }; let usageSeen = false;
      const tools = new Map();

      const turn = async function* (prompt, sessionArgs) {
        p = spawnTurn(prompt, sessionArgs);
        let streamed = '', last, lastErr;
        for await (const line of p.lines) {
          const m = parseJsonLine(line); if (!m) continue;
          switch (m.type) {
            case 'session': if (!sessionId) sessionId = m.id; yield ev.session(m.id); break;
            case 'message_update': {
              const a = m.assistantMessageEvent || {};
              if (a.type === 'text_delta' && a.delta) { streamed += a.delta; yield ev.text(a.delta); } else if (a.type === 'thinking_delta' && a.delta) yield ev.thinking(a.delta);
              break;
            }
            case 'message_end':
              if (m.message?.role === 'assistant') {
                last = m.message; const u = m.message.usage;
                if (u) { usageSeen = true; sum.input += (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0); sum.output += u.output || 0; sum.cachedInput += u.cacheRead || 0; sum.reasoning += u.reasoning || 0; sum.cost += u.cost?.total || 0; yield ev.usage((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0), u.output || 0, u.cost?.total || undefined); }
                if (m.message.stopReason === 'error' || m.message.errorMessage) lastErr = m.message.errorMessage || 'provider error';
              }
              break;
            case 'tool_execution_start': tools.set(m.toolCallId, m.args); yield ev.tool(m.toolName, m.args); break;
            case 'tool_execution_end': yield ev.tool(m.toolName, tools.get(m.toolCallId), (m.isError ? 'ERROR: ' : '') + outputOf(m.result)); break;
            case 'auto_retry_start': yield ev.error(`pi is retrying after: ${m.errorMessage}`); break;
            default: break;
          }
          if (!(m.type === 'message_start' || m.type === 'message_end') || m.message?.role !== 'system') yield ev.raw(m);
        }
        const r = await p.wait();
        if (r.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: NAME });
        if (r.timedOut) throw new AgentError('TIMEOUT', `pi timed out after ${o.timeoutMs}ms`, { agent: NAME });
        const stderr = (r.stderr || '').replace(/^Warning: Model .* not found for provider .* Using custom model id\.\s*$/gm, '').trim();
        const fail = (msg) => {
          const code = classify(msg);
          return new AgentError(code, msg.slice(0, 1500), { agent: NAME, exitCode: r.exitCode, stderr: r.stderr, sessionId, ...(code === 'RATE_LIMITED' ? { retryAfterMs: retryAfterMs(msg) } : {}) });
        };
        if (r.exitCode !== 0 && !last) { const msg = stderr || `pi exited ${r.exitCode}`; throw fail(msg); }
        if (lastErr && (!textOf(last).trim() || last.stopReason === 'error')) throw fail(lastErr);
        if (r.exitCode !== 0) throw fail(stderr || `pi exited ${r.exitCode}`);
        const out = (textOf(last) || streamed).trimEnd();
        return out;
      };

      // first turn: session args per mode
      const first = ephemeral ? (tmpSessions ? ['--session-dir', tmpSessions] : ['--no-session'])
        : ['--session-dir', sdir, ...(sess.mode === 'continue' ? ['--session', resume] : sess.mode === 'fork' ? ['--fork', resume] : [])];
      text = yield* turn(o.jsonSchema ? o.prompt + schemaSuffix(o.jsonSchema) : o.prompt, first);
      if (o.jsonSchema) {
        const again = () => ['--session-dir', tmpSessions || sdir, '--session', sessionId];
        for (let attempt = 0; ; attempt++) {
          const x = extractJson(text);
          const errs = x.ok ? validateSchema(o.jsonSchema, x.value) : ['reply is not valid JSON'];
          if (!errs.length) { structured = x.value; text = JSON.stringify(x.value); break; }
          if (attempt >= 1) throw new AgentError('AGENT_FAILED', `jsonSchema validation failed: ${errs.slice(0, 5).join('; ')}`, { agent: NAME, sessionId, partial: text });
          text = yield* turn(`Your previous reply was invalid (${errs.slice(0, 5).join('; ')}). Reply again with ONLY the corrected JSON value.`, again());
        }
      }
      if (!text.trim()) {
        const msg = 'pi returned an empty response (the model produced no text)';
        yield ev.error(msg);
        throw new AgentError('AGENT_FAILED', msg, { agent: NAME, sessionId });
      }
      const usage = usageSeen ? { input: sum.input, output: sum.output, ...(sum.cachedInput ? { cachedInput: sum.cachedInput } : {}), ...(sum.reasoning ? { reasoning: sum.reasoning } : {}), ...(sum.cost ? { cost: sum.cost } : {}) } : { input: 0, output: 0 };
      return { text, sessionId: ephemeral ? undefined : sessionId, usage, exitCode: 0, model: o.model || 'default', durationMs: Date.now() - t0, timedOut: false, ...(structured !== undefined ? { structured } : {}) };
    } finally {
      p?.kill();
      destroyAgentDir(ad);
      if (tmpSessions) try { rmSync(tmpSessions, { recursive: true, force: true }); } catch { /* temp */ }
      if (claimed) busy.delete(claimed);
    }
  },
};
