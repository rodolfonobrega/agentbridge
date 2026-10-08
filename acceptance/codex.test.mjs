import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import codex from '../dist/adapters/codex.js';
import { AgentError } from '../dist/core/errors.js';

const T = 240000;
const cwd = mkdtempSync(path.join(tmpdir(), 'cx-acc-'));
async function go(opts) {
  const g = codex.run({ cwd, timeoutMs: T, ...opts });
  const events = [];
  let n = await g.next();
  while (!n.done) { events.push(n.value); n = await g.next(); }
  return { events, r: n.value };
}
const rolloutText = (id) => {
  const root = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
  let out = '';
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.includes(id)) out += readFileSync(p, 'utf8'); } };
  walk(root);
  return out;
};
const rolloutCount = (id) => {
  const root = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
  let c = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.includes(id)) c++; } };
  if (existsSync(root)) walk(root);
  return c;
};

test('models() lists slugs', async () => {
  const m = await codex.models();
  assert.ok(Array.isArray(m) && m.length > 0 && m.every((x) => typeof x === 'string'));
});

test('basic run: events, result shape, ignores OPENAI_API_KEY', { timeout: T }, async () => {
  process.env.OPENAI_API_KEY = 'sk-invalid-should-be-stripped';
  const { events, r } = await go({ prompt: 'Reply with exactly: PONG' });
  delete process.env.OPENAI_API_KEY;
  assert.match(r.text, /PONG/);
  assert.ok(r.sessionId && r.usage.input > 0 && r.exitCode === 0 && r.timedOut === false && r.durationMs > 0);
  assert.ok(events.some((e) => e.type === 'session') && events.some((e) => e.type === 'text') && events.some((e) => e.type === 'usage'));
});

// NOTE (documented CLI limitation, not a fixable adapter bug): `codex exec --json` emits the agent's
// reply as a single buffered `item.completed` event of type `agent_message` once the whole response is
// ready. Confirmed by dumping every raw event type for a multi-sentence prompt: only
// sandbox/warning/thread.started/turn.started/item.completed:agent_message/turn.completed appear -
// there is no incremental agent_message_delta (or similar token-level) event in the exec JSONL stream,
// unlike `claude --include-partial-messages` or opencode's SSE stream. The adapter therefore cannot
// emit more than one 'text' event per run without inventing chunk boundaries the CLI never provides.
// (codex's experimental `app-server` subcommand may expose incremental deltas over JSON-RPC, but
// switching the adapter to that transport is a rewrite, out of scope here.) This test documents the
// actual, verified behavior instead of asserting streaming that cannot occur.
test('STREAMING (documented CLI limitation): codex exec --json delivers exactly one buffered text event', { timeout: T }, async () => {
  const { events, r } = await go({ prompt: 'Write a short four-sentence paragraph about the ocean.' });
  const deltas = events.filter((e) => e.type === 'text');
  assert.equal(deltas.length, 1, 'codex exec --json buffers the whole reply into one text event (no incremental deltas exist in the CLI stream)');
  assert.equal(deltas[0].delta, r.text);
});

test('model + effort + permissions(full) + extraArgs', { timeout: T }, async () => {
  const model = (await codex.models())[0];
  const { r } = await go({ prompt: 'Reply with exactly: OK', model, effort: 'low', permissions: 'full', extraArgs: ['--color', 'never'] });
  assert.match(r.text, /OK/);
  assert.equal(r.model, model, 'Result.model must reflect the requested model');
});

test('Result.model reflects the resolved default when no model is requested', { timeout: T }, async () => {
  const { r } = await go({ prompt: 'Reply with exactly: OK' });
  assert.match(r.text, /OK/);
  assert.equal(r.model, 'default');
});

test('systemPrompt is honored', { timeout: T }, async () => {
  const { r } = await go({ prompt: 'Hello', systemPrompt: 'Always answer with only the single word PINEAPPLE.' });
  assert.match(r.text, /PINEAPPLE/i);
});

test('cwd is honored', { timeout: T }, async () => {
  writeFileSync(path.join(cwd, 'marker_zq.txt'), 'x');
  const { r } = await go({ prompt: 'List files in the current directory using a shell command; reply with the file name containing "marker".', permissions: 'full' });
  assert.match(r.text, /marker_zq/);
});

test('permissions really enforced: read-only reads but cannot write; edit writes; plan does not write', { timeout: T * 4 }, async () => {
  writeFileSync(path.join(cwd, 'data.txt'), 'kiwi-7731');
  const rd = await go({ prompt: 'Use a shell command to print data.txt and reply with its exact content only.', permissions: 'read-only' });
  assert.match(rd.r.text, /kiwi-7731/, 'read-only can read');
  await go({ prompt: 'Use a shell command to create ro.txt containing hi. Reply done or failed.', permissions: 'read-only' });
  assert.equal(existsSync(path.join(cwd, 'ro.txt')), false, 'read-only refuses writes');
  await go({ prompt: 'Use a shell command to create rw.txt containing hi. Reply done.', permissions: 'edit' });
  assert.equal(existsSync(path.join(cwd, 'rw.txt')), true, 'edit can write');
  await go({ prompt: 'Create file plan.txt containing hi', permissions: 'plan' });
  assert.equal(existsSync(path.join(cwd, 'plan.txt')), false, 'plan writes nothing');
});

test('session validation: bad ids -> BAD_OPTION; unknown continue never silently starts new', async () => {
  const code = (c) => (e) => e instanceof AgentError && e.code === c;
  await assert.rejects(go({ prompt: 'x', session: { mode: 'continue', id: '--help' } }), code('BAD_OPTION'));
  await assert.rejects(go({ prompt: 'x', session: { mode: 'fork', id: 'abc; rm' } }), code('BAD_OPTION'));
  await assert.rejects(go({ prompt: 'x', session: { mode: 'fork', id: '00000000-0000-4000-8000-000000000000' } }), code('BAD_OPTION'));
  await assert.rejects(go({ prompt: 'x', session: { mode: 'continue', id: '00000000-0000-4000-8000-000000000000' } }), code('BAD_OPTION'));
  const empty = mkdtempSync(path.join(tmpdir(), 'cx-empty-'));
  await assert.rejects(go({ prompt: 'x', cwd: empty, session: { mode: 'continue' } }), (e) => e instanceof AgentError && ['BAD_OPTION', 'AGENT_FAILED'].includes(e.code));
});

test('up-front validation: jsonSchema, extraArgs, bad model, bad flag', { timeout: T }, async () => {
  const code = (c) => (e) => e instanceof AgentError && e.code === c;
  await assert.rejects(go({ prompt: 'x', jsonSchema: [1] }), code('BAD_OPTION'));
  await assert.rejects(go({ prompt: 'x', jsonSchema: { type: 'string' } }), code('BAD_OPTION'));
  await assert.rejects(go({ prompt: 'x', extraArgs: [5] }), code('BAD_OPTION'));
  await assert.rejects(go({ prompt: 'x', extraArgs: ['--no-such-flag'] }), code('BAD_OPTION'));
  await assert.rejects(go({ prompt: 'x', model: 'definitely-not-a-model-xyz' }), code('BAD_OPTION'));
  { const g = codex.run({ cwd, prompt: 'x', model: 'definitely-not-a-model-xyz' }); const errs = []; try { for await (const x of g) if (x.type === 'error') errs.push(x); } catch {} assert.equal(new Set(errs.map((x) => x.message)).size, errs.length, 'no duplicate error events'); }
});

test('jsonSchema yields conforming JSON', { timeout: T }, async () => {
  const jsonSchema = { type: 'object', properties: { color: { type: 'string' }, n: { type: 'integer' } }, required: ['color', 'n'], additionalProperties: false };
  const { r } = await go({ prompt: 'Give color "red" and n 7.', jsonSchema });
  const j = JSON.parse(r.text);
  assert.equal(j.color, 'red'); assert.equal(j.n, 7);
});

test('mcpServers via -c overrides: server is started and its tool is callable', { timeout: T }, async () => {
  const srv = path.join(cwd, 'mcp.mjs');
  writeFileSync(srv, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'sec', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'get_secret', description: 'Returns the secret code', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'SECRET=' + process.env.SECRET_VAL }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});`);
  const { events, r } = await go({
    prompt: 'Call the get_secret tool from the "sec" MCP server and reply with exactly what it returns.',
    permissions: 'read-only',
    mcpServers: { sec: { command: process.execPath, args: [srv], env: { SECRET_VAL: 'kiwi42' } } },
  });
  assert.match(r.text, /kiwi42/);
  assert.ok(events.some((e) => e.type === 'tool' && /sec/.test(e.name)));
});

test('timeoutMs throws TIMEOUT; abort signal throws ABORTED', { timeout: T }, async () => {
  await assert.rejects(go({ prompt: 'Write a very long essay', timeoutMs: 1500 }), (e) => e instanceof AgentError && e.code === 'TIMEOUT');
  const ac = new AbortController(); setTimeout(() => ac.abort(), 1500);
  await assert.rejects(go({ prompt: 'Write a very long essay', signal: ac.signal, timeoutMs: T }), (e) => e instanceof AgentError && e.code === 'ABORTED');
});

test('sessions: continue remembers, fork branches without touching original, ephemeral persists nothing', { timeout: T * 4 }, async () => {
  const a = await go({ prompt: 'Remember the secret word MANGOSTEEN. Reply only: stored.' });
  const id = a.r.sessionId; assert.ok(id);
  // continue
  const c = await go({ prompt: 'What was the secret word? One word.', session: { mode: 'continue', id } });
  assert.match(c.r.text, /MANGOSTEEN/i);
  assert.equal(c.r.sessionId, id);
  // fork: remembers, new id, diverges
  const f = await go({ prompt: 'What was the secret word? One word. Also, new fact: the second word is KUMQUAT. Reply: <word1> stored.', session: { mode: 'fork', id } });
  assert.match(f.r.text, /MANGOSTEEN/i);
  assert.notEqual(f.r.sessionId, id);
  const orig = await go({ prompt: 'What fruit was named as the second word earlier? If none was ever mentioned, reply NONE.', session: { mode: 'continue', id } });
  assert.doesNotMatch(orig.r.text, /KUMQUAT/i);
  const fk = await go({ prompt: 'What was the second word? One word.', session: { mode: 'continue', id: f.r.sessionId } });
  assert.match(fk.r.text, /KUMQUAT/i);
  // fork without id = most recent in cwd
  const f2 = await go({ prompt: 'Reply only: ok', session: { mode: 'fork' } });
  assert.ok(f2.r.sessionId && f2.r.sessionId !== id);
  // continue without id = most recent
  const c2 = await go({ prompt: 'Reply only: ok', session: { mode: 'continue' } });
  assert.ok(c2.r.text.length > 0);
  // ephemeral
  const e = await go({ prompt: 'Remember the secret word DURIAN. Reply only: stored.', session: { mode: 'ephemeral' } });
  assert.match(e.r.text, /stored/i);
  assert.equal(e.r.sessionId, undefined, 'ephemeral has no resumable id');
  const tid = e.events.find((x) => x.type === 'raw' && x.data?.type === 'thread.started').data.thread_id;
  assert.equal(rolloutCount(tid), 0, 'no rollout persisted');
  await assert.rejects(go({ prompt: 'What word?', session: { mode: 'continue', id: tid } }), (x) => x instanceof AgentError && x.code === 'BAD_OPTION');
});

test('hidden model slug is accepted (not pre-rejected); bogus slug fails fast as BAD_OPTION', { timeout: T }, async () => {
  const cache = JSON.parse(readFileSync(path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'models_cache.json'), 'utf8'));
  const hidden = (cache.models || []).find((m) => m.visibility === 'hide' || m.visibility === 'hidden')?.slug || 'codex-auto-review';
  const { r } = await go({ prompt: 'Reply only: ok', model: hidden });
  assert.match(r.text, /ok/i);
  const t0 = Date.now();
  await assert.rejects(go({ prompt: 'x', model: 'bogus-model-zzz' }), (e) => e.code === 'BAD_OPTION');
  assert.ok(Date.now() - t0 < 60000);
});

test('bad options throw BAD_OPTION', async () => {
  await assert.rejects(go({ prompt: 'x', effort: 'extreme' }), (e) => e.code === 'BAD_OPTION');
  await assert.rejects(go({ prompt: 'x', mcpServers: { 'bad name': { command: 'x' } } }), (e) => e.code === 'BAD_OPTION');
});

test('sandbox disclosure: event + result.sandbox + usage fidelity + tool ids', { timeout: T }, async () => {
  const { events, r } = await go({ prompt: 'Run the shell command "echo hi" and then reply ok.', permissions: 'edit' });
  const sb = events.find((e) => e.type === 'raw' && e.data?.type === 'sandbox');
  assert.ok(sb && sb.data.mode === 'workspace-write');
  assert.ok(events.some((e) => e.type === 'raw' && e.data?.type === 'warning' && /unelevated|reads/i.test(e.data.message)) || process.platform !== 'win32');
  assert.equal(r.sandbox.mode, 'workspace-write'); assert.equal(r.sandbox.readScope, 'unrestricted');
  assert.ok(r.sandbox.writeRoots.includes(path.resolve(cwd)));
  if (process.platform === 'win32') assert.match(r.sandbox.note, /unelevated/);
  assert.equal(r.usage.cost, null); assert.ok('cachedInput' in r.usage && 'reasoning' in r.usage);
  const u = events.find((e) => e.type === 'usage'); assert.ok(u && 'cachedInput' in u && u.cost === null);
  const t = events.find((e) => e.type === 'tool' && e.name === 'shell'); assert.ok(t && t.id);
});

test('edit excludes TEMP by default; writableRoots opens extra roots', { timeout: T * 2 }, async () => {
  const outside = path.join(tmpdir(), 'cx-outside-' + Date.now() + '.txt');
  await go({ prompt: 'Use a shell command to write the text hi into the file ' + outside + ' . Reply done or failed.', permissions: 'edit' });
  assert.equal(existsSync(outside), false, 'TEMP not writable in edit');
  const extra = path.resolve('.tmp-cx-writable'); rmSync(extra, { recursive: true, force: true }); mkdirSync(extra);
  try {
    const target = path.join(extra, 'w.txt');
    await go({ prompt: 'Use a shell command to write the text hi into the file ' + target + ' . Reply done.', permissions: 'edit', writableRoots: [extra] });
    assert.equal(existsSync(target), true, 'writableRoots honored');
    const t2 = path.join(extra, 'no.txt');
    await go({ prompt: 'Use a shell command to write the text hi into the file ' + t2 + ' . Reply done or failed.', permissions: 'edit' });
    assert.equal(existsSync(t2), false, 'not writable without writableRoots');
  } finally { rmSync(extra, { recursive: true, force: true }); }
});

const psAlive = (marker) => {
  try {
    return Number(execFileSync('powershell', ['-NoProfile', '-Command', "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*" + marker + "*' -and $_.ProcessId -ne $PID }).Count"], { encoding: 'utf8' }).trim()) > 0;
  } catch { return false; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function killTest(how) {
  const marker = 'CXKILL' + how + Date.now();
  const ac = new AbortController();
  const opts = { cwd, permissions: 'full', timeoutMs: how === 'timeout' ? 30000 : T, signal: ac.signal,
    prompt: 'Call your shell tool exactly once with this command, and wait for it: powershell -NoProfile -Command "Start-Sleep -Seconds 300 # ' + marker + '"' };
  let seen = false;
  const poll = (async () => { for (let i = 0; i < 100; i++) { if (psAlive(marker)) { seen = true; if (how === 'abort') { await sleep(1500); ac.abort(); } return; } await sleep(1000); } })();
  const runP = go(opts).then(() => null, (e) => e);
  await poll;
  assert.ok(seen, 'grandchild process started');
  const err = await runP;
  assert.equal(err?.code, how === 'abort' ? 'ABORTED' : 'TIMEOUT');
  await sleep(2000);
  assert.equal(psAlive(marker), false, 'grandchild gone after ' + how);
}
test('abort kills grandchild processes', { timeout: T }, () => killTest('abort'));
// Why 25s: codex itself ends the turn ~40s after a long shell call ("command still running", observed 54s total),
// leaving the child orphaned. To exercise OUR timer the timeout must fire before that, so it is 38s, and we assert
// the marker process was alive right up to the kill and that TIMEOUT arrived at ~timeoutMs (our timer, not codex exiting).
test('timeoutMs (our timer) kills a live grandchild', { timeout: T }, async () => {
  const marker = 'CXTMO' + Date.now();
  const timeoutMs = 38000;
  const t0 = Date.now();
  let settled = false, endAt = 0, lastAlive = 0;
  const runP = go({ cwd, permissions: 'full', timeoutMs,
    prompt: 'Call your shell tool exactly once with this command, and wait for it: powershell -NoProfile -Command "Start-Sleep -Seconds 300 # ' + marker + '"' })
    .then(() => null, (e) => e).then((e) => { settled = true; endAt = Date.now(); return e; });
  while (!settled) { if (psAlive(marker)) lastAlive = Date.now(); await sleep(400); }
  const err = await runP;
  assert.equal(err?.code, 'TIMEOUT');
  assert.equal(err.timedOut, true);
  const elapsed = endAt - t0;
  assert.ok(elapsed >= timeoutMs - 500 && elapsed < timeoutMs + 10000, 'thrown by our timer, elapsed ' + elapsed);
  assert.ok(lastAlive > 0 && endAt - lastAlive < 4000, 'marker process was alive right before the kill');
  await sleep(2000);
  assert.equal(psAlive(marker), false, 'grandchild dead after timeout');
});

// Regression for the shared src/core/spawn.mjs defect: if a tool backgrounds/detaches a grandchild that
// INHERITS this process's stdio pipe handles (e.g. `node ... & disown`, or here a direct spawn({stdio:'inherit',
// detached:true}).unref()), the top-level codex process still dies promptly on abort/timeout ('exit' fires), but
// 'close' never fires because the surviving grandchild holds the stdout/stderr pipe open — Node never sees EOF.
// Before the fix, spawn.mjs's done-promise was gated on 'close' only, so wait() (and therefore run()) hung
// forever instead of rejecting ABORTED/TIMEOUT per CONTRACT.md. The must-pass assertion here is that run()
// actually settles promptly; the grandchild's own death is documented best-effort (see comment below).
test('backgrounded grandchild (inherits stdio, outlives the shell child): abort still settles, not a hang', { timeout: T }, async () => {
  const marker = 'CXBG' + Date.now();
  const runner = path.join(cwd, 'runner-' + marker + '.mjs');
  writeFileSync(runner, `import cp from 'node:child_process';const g=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000) // ${marker}'],{stdio:'inherit',detached:true});g.unref();process.exit(0);`);
  const ac = new AbortController();
  const opts = { cwd, permissions: 'full', timeoutMs: T, signal: ac.signal,
    prompt: 'Call your shell tool exactly once with this command (it returns almost immediately on its own; do not wait beyond that): node "' + runner.split(path.sep).join('/') + '"' };
  const t0 = Date.now();
  const runP = go(opts).then(() => null, (e) => e);
  let started = false;
  for (let i = 0; i < 100 && !started; i++) { if (psAlive(marker)) started = true; else await sleep(1000); }
  assert.ok(started, 'backgrounded grandchild started');
  await sleep(500);
  ac.abort();
  const err = await runP;
  const elapsed = Date.now() - t0;
  assert.equal(err?.code, 'ABORTED');
  assert.ok(elapsed < T - 5000, `run() must settle promptly after abort, not hang (took ${elapsed}ms)`);
  // Best effort: Windows' taskkill /T tree-kill is PPID-based and normally reaches a detached grandchild too,
  // but a truly backgrounded/unref'd process is not guaranteed reachable in every case. Documented honestly
  // (logged, not asserted as a hard requirement) rather than claiming a guarantee that doesn't hold.
  let dead = false;
  for (let i = 0; i < 30 && !dead; i++) { if (!psAlive(marker)) dead = true; else await sleep(200); }
  console.log('# backgrounded grandchild dead after abort:', dead);
});

test('same cwd+scope concurrent id-less continue: second claimant gets BAD_OPTION busy', { timeout: T * 2 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-busy-'));
  const a = await go({ cwd: dir, prompt: 'Remember the secret word ALPHA. Reply only: stored.' });
  const res = await Promise.allSettled([
    go({ cwd: dir, prompt: 'What was the secret word? One word.', session: { mode: 'continue' } }),
    go({ cwd: dir, prompt: 'What was the secret word? One word.', session: { mode: 'continue' } }),
  ]);
  const ok = res.filter((x) => x.status === 'fulfilled'), bad = res.filter((x) => x.status === 'rejected');
  assert.equal(ok.length, 1); assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.code, 'BAD_OPTION'); assert.match(bad[0].reason.message, /session busy; pass explicit id/);
  assert.equal(ok[0].value.r.sessionId, a.r.sessionId); assert.match(ok[0].value.r.text, /ALPHA/i);
  // claim released afterwards
  const again = await go({ cwd: dir, prompt: 'Reply only: ok', session: { mode: 'continue' } });
  assert.equal(again.r.sessionId, a.r.sessionId);
});

test('one tool event per shell command id', { timeout: T }, async () => {
  const { events } = await go({ prompt: 'Run the shell command "echo hi" once, then reply ok.', permissions: 'full' });
  const ids = events.filter((e) => e.type === 'tool' && e.name === 'shell').map((e) => e.id);
  assert.ok(ids.length >= 1 && new Set(ids).size === ids.length, 'unique ids: ' + ids);
});

test('concurrent id-less continue: each run continues ITS OWN session (scoped)', { timeout: T * 2 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-conc-'));
  const [a, b] = await Promise.all([
    go({ cwd: dir, prompt: 'Remember the secret word ALPHA. Reply only: stored.', session: { mode: 'new', scope: 'a' } }),
    go({ cwd: dir, prompt: 'Remember the secret word BRAVO. Reply only: stored.', session: { mode: 'new', scope: 'b' } }),
  ]);
  assert.notEqual(a.r.sessionId, b.r.sessionId);
  const [ca, cb] = await Promise.all([
    go({ cwd: dir, prompt: 'What was the secret word? One word.', session: { mode: 'continue', scope: 'a' } }),
    go({ cwd: dir, prompt: 'What was the secret word? One word.', session: { mode: 'continue', scope: 'b' } }),
  ]);
  assert.equal(ca.r.sessionId, a.r.sessionId); assert.match(ca.r.text, /ALPHA/i); assert.doesNotMatch(ca.r.text, /BRAVO/i);
  assert.equal(cb.r.sessionId, b.r.sessionId); assert.match(cb.r.text, /BRAVO/i); assert.doesNotMatch(cb.r.text, /ALPHA/i);
  const foreignDir = mkdtempSync(path.join(tmpdir(), 'cx-foreign-'));
  await assert.rejects(go({ cwd: foreignDir, prompt: 'x', session: { mode: 'continue' } }), (e) => e.code === 'BAD_OPTION');
  const viaId = await go({ cwd: dir, prompt: 'What was the secret word? One word.', session: { mode: 'continue', id: a.r.sessionId } });
  assert.match(viaId.r.text, /ALPHA/i);
});
