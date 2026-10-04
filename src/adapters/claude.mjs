import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawnProc, runCollect } from '../core/spawn.mjs';
import { AgentError } from '../core/errors.mjs';
import { ev, parseJsonLine } from '../core/events.mjs';
import { validateOptions } from '../index.mjs';
import { hintFor } from '../core/hints.mjs';

const READ_TOOLS = 'Read,Glob,Grep,WebFetch,WebSearch';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const AUTH_RE = /not logged in|please run \/login|invalid (x-)?api key|authentication_error|invalid authentication|oauth token (has )?(expired|revoked)|failed to authenticate/i;
const ours = new Map(); // resolved cwd -> ordered session ids started/used by THIS process (never resolve no-id to a foreign session)
const busy = new Map();  // session id -> number of in-flight continue runs (claims)
const locks = new Map();     // session id -> promise tail (serializes concurrent continue on one id)
async function lock(id) {
  const prev = locks.get(id) || Promise.resolve();
  let release; const mine = new Promise((res) => { release = res; });
  const tail = prev.then(() => mine); locks.set(id, tail);
  await prev;
  return () => { release(); if (locks.get(id) === tail) locks.delete(id); };
}
const bad = (m) => new AgentError('BAD_OPTION', m);

/** Most recent persisted session id for cwd (stored under <config>/projects/<cwd with non-alnum -> '-'>). */
function latestSession(cwd) {
  let real = cwd; try { real = realpathSync(cwd); } catch { /* keep */ }
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'));
  let best;
  try {
    for (const f of readdirSync(root)) {
      if (!f.endsWith('.jsonl') || !UUID.test(f.slice(0, -6))) continue;
      const t = statSync(path.join(root, f)).mtimeMs;
      if (!best || t > best.t) best = { t, id: f.slice(0, -6) };
    }
  } catch { /* none */ }
  return best?.id;
}

const userMessageLine = (o) => JSON.stringify({ type: 'user', message: { role: 'user', content: [...o.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text: o.prompt }] } }) + '\n';

function buildArgs(o, mcpFile, resumeId) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (o.images?.length) a.push('--input-format', 'stream-json'); // the prompt travels as one user message with image blocks
  if (o.model) a.push('--model', o.model);
  if (o.effort) a.push('--effort', o.effort);
  const isolated = o.isolated !== false;
  // Isolation: no user/project settings (hooks, plugins), no skills. (--bare is unusable: it disables OAuth login.)
  if (isolated) a.push('--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands');
  const ro = !o.permissions || o.permissions === 'read-only';
  switch (o.permissions) {
    case 'edit': a.push('--permission-mode', 'acceptEdits'); break;
    case 'full': a.push('--permission-mode', 'bypassPermissions'); break;
    case 'plan': a.push('--permission-mode', 'plan', '--tools', READ_TOOLS); break; // no Write/Edit/Bash/ExitPlanMode => nothing (incl. ~/.claude/plans) is written
    default: a.push('--permission-mode', 'default', '--tools', READ_TOOLS); // read-only
  }
  if (o.systemPrompt) a.push('--system-prompt', o.systemPrompt);
  if (mcpFile) a.push('--mcp-config', mcpFile, '--strict-mcp-config',
    '--allowedTools', Object.keys(o.mcpServers).map((n) => `mcp__${n.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`).join(',')); // explicitly opted-in servers are usable in every mode
  else if (isolated || ro || o.permissions === 'plan') a.push('--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'); // no user/plugin/connector MCP tools
  if (o.jsonSchema) a.push('--json-schema', JSON.stringify(o.jsonSchema));
  const s = o.session || { mode: 'new' };
  if (s.mode === 'ephemeral') a.push('--no-session-persistence');
  else if (s.mode === 'continue') a.push('--resume', resumeId);
  else if (s.mode === 'fork') a.push('--resume', resumeId, '--fork-session');
  if (o.extraArgs) a.push(...o.extraArgs);
  return a;
}

export default {
  name: 'claude',
  efforts: EFFORTS,
  async models() {
    const set = new Set(['haiku', 'sonnet', 'opus']);
    try { // discover aliases the installed CLI advertises in its --model help
      const r = await runCollect('claude', ['--help'], { timeoutMs: 15000 });
      const sec = r.stdout.match(/--model <model>[\s\S]*?(?=\n\s+--[a-z]|\n\s+-[a-z],)/i)?.[0] || '';
      for (const m of sec.matchAll(/'([a-z][a-z0-9.-]*)'/g)) set.add(m[1]);
    } catch { /* base aliases only */ }
    return [...set];
  },
  async *run(opts) {
    if (opts && opts.isolated != null && typeof opts.isolated !== 'boolean') throw bad('isolated must be boolean');
    if (opts?.effort != null && !EFFORTS.includes(opts.effort)) throw bad(`effort must be one of ${EFFORTS.join('|')}`);
    const { isolated, effort, ...rest } = opts || {};
    const o = { ...validateOptions(rest), isolated, effort };
    const sess = o.session;
    if (sess?.id != null && !UUID.test(sess.id)) throw bad('session.id must be a UUID');
    let resumeId;
    if (sess && (sess.mode === 'continue' || sess.mode === 'fork')) {
      if (sess.id) resumeId = sess.id;
      else {
        // No-id resolution: newest session started by THIS process that no other continue currently holds.
        // Concurrent no-id continues never share a session: the second gets a distinct free one, or BAD_OPTION 'session busy'.
        const mine = [...(ours.get(path.resolve(o.cwd || process.cwd())) || [])].reverse();
        if (sess.mode === 'continue') {
          resumeId = mine.find((id) => !busy.get(id));
          if (!resumeId && mine.length) throw bad('session busy (in use by another continue); pass an explicit session.id');
        } else resumeId = mine[0];
        if (!resumeId && sess.adoptForeign) resumeId = latestSession(o.cwd || process.cwd());
      }
      if (!resumeId) throw bad(`session mode "${sess.mode}" without id: no session started by this process for cwd (set session.adoptForeign=true to adopt the newest on-disk session) ${o.cwd || process.cwd()}`);
    }
    const t0 = Date.now();
    let unlock = null, p, dir, mcpFile, claimed = null;
    if (sess?.mode === 'continue') { claimed = resumeId; busy.set(claimed, (busy.get(claimed) || 0) + 1); } // synchronous claim
    try {
    unlock = claimed ? await lock(resumeId) : null;
    if (o.mcpServers && Object.keys(o.mcpServers).length) {
      dir = mkdtempSync(path.join(tmpdir(), 'ab-claude-'));
      mcpFile = path.join(dir, 'mcp.json');
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: o.mcpServers }));
    }
    const env = { ...process.env, ...(o.env || {}) };
    if (o.isolated !== false) { env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1'; env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'; }
    env.ANTHROPIC_API_KEY = ''; env.ANTHROPIC_AUTH_TOKEN = ''; // force subscription login
    p = spawnProc('claude', buildArgs(o, mcpFile, resumeId), {
      cwd: o.cwd, env, input: o.images?.length ? userMessageLine(o) : o.prompt, timeoutMs: o.timeoutMs, signal: o.signal, agent: 'claude',
    });
    let text = '', sessionId, model, final, stopReason, usage = { input: 0, output: 0 }, sawSession = false;
    const toolNames = new Map();
      for await (const line of p.lines) {
        const m = parseJsonLine(line);
        if (!m) continue;
        if (m.session_id && !sawSession) { sawSession = true; sessionId = m.session_id; if (sess?.mode !== 'ephemeral') { const k = path.resolve(o.cwd || process.cwd()); const l = ours.get(k) || []; if (!l.includes(sessionId)) l.push(sessionId); ours.set(k, l); } yield ev.session(m.session_id); }
        if (m.type === 'system' && m.subtype === 'init') { model = m.model || model; }
        else if (m.type === 'stream_event') {
          const e = m.event || {};
          if (e.type === 'message_start') { model = e.message?.model || model; }
          else if (e.type === 'message_delta') { if (e.delta?.stop_reason) stopReason = e.delta.stop_reason; }
          else if (e.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta' && e.delta.text) { text += e.delta.text; yield ev.text(e.delta.text); }
            else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) yield ev.thinking(e.delta.thinking);
          }
        } else if (m.type === 'assistant') {
          for (const b of m.message?.content || []) {
            if (b.type === 'tool_use') { toolNames.set(b.id, { name: b.name, input: b.input }); yield ev.tool(b.name, b.input); }
          }
        } else if (m.type === 'user') {
          for (const b of (Array.isArray(m.message?.content) ? m.message.content : [])) {
            if (b.type === 'tool_result') {
              const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
              const t = toolNames.get(b.tool_use_id) || { name: 'tool' };
              yield ev.tool(t.name, t.input, out);
            }
          }
        } else if (m.type === 'result') {
          final = m;
          const u = m.usage || {};
          usage = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0 };
          if (m.total_cost_usd != null) usage.cost = m.total_cost_usd;
          yield ev.usage(usage.input, usage.output, usage.cost);
          if (m.modelUsage) model = Object.keys(m.modelUsage)[0] || model;
        }
        yield ev.raw(m);
      }
      const r = await p.wait();
      if (r.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: 'claude' });
      if (r.timedOut) throw new AgentError('TIMEOUT', `claude timed out after ${o.timeoutMs}ms`, { agent: 'claude' });
      if (!final || final.is_error || r.exitCode !== 0) {
        const msg = (final?.result || r.stderr || `claude exited ${r.exitCode}`).toString();
        const code = AUTH_RE.test(msg) ? 'NOT_LOGGED_IN' : 'AGENT_FAILED';
        yield ev.error(msg);
        throw new AgentError(code, code === 'NOT_LOGGED_IN' ? msg + hintFor('claude', code) : msg, { agent: 'claude', exitCode: r.exitCode, stderr: r.stderr });
      }
      let out = typeof final.result === 'string' ? final.result : text;
      if (final.structured_output !== undefined) out = JSON.stringify(final.structured_output);
      return { text: out, sessionId: sess?.mode === 'ephemeral' ? undefined : (final.session_id || sessionId),
        usage, exitCode: r.exitCode, model, durationMs: Date.now() - t0, timedOut: false,
        ...((final.stop_reason || stopReason) ? { stopReason: final.stop_reason || stopReason } : {}),
        ...(final.structured_output !== undefined ? { structured: final.structured_output } : {}) };
    } finally {
      p?.kill();
      unlock?.();
      if (claimed) { const n = (busy.get(claimed) || 1) - 1; if (n) busy.set(claimed, n); else busy.delete(claimed); }
      if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
};
