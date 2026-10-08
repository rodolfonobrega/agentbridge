// RATE_LIMITED classification + `fallback` chains. The primary that "runs out of tokens" is a tiny local HTTP server that answers
// 429/529/500 (a protocol fixture: it is the only way to force a provider limit on demand); every agent that ANSWERS after the
// fallback is a REAL one (claude haiku). Adapter objects are used only for the side-effect guard, to emit a tool event and then a limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-fb-home-')));
process.env.AGENTBRIDGE_HOME = HOME;
const { ask, run, AgentError, ev, validateOptions, asRateLimited, retryAfterMs, looksRateLimited, askWithTelemetry } = await import('../dist/index.js');
const { saveEndpoint } = await import('../dist/adapters/endpoint.js');
const { callAny, verifyAttestation } = await import('../dist/bridge/mcp.js');
const { startProxy } = await import('../dist/server/index.js');
const { retryHeaderMs } = await import('../dist/core/errors.js');
const MAIN = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'no-error'; };
const PONG = 'Reply with exactly: PONG';

let hits = { limited: 0, busy: 0, broken: 0 };
const srv = http.createServer((q, r) => {
  const which = q.url.split('/')[1]; hits[which]++;
  if (which === 'limited') { r.writeHead(429, { 'retry-after': '7', 'content-type': 'application/json' }); r.end('{"error":{"message":"Rate limit exceeded"}}'); }
  else if (which === 'busy') { r.writeHead(529, { 'content-type': 'application/json' }); r.end('{"error":{"message":"Overloaded"}}'); }
  else { r.writeHead(500, { 'content-type': 'application/json' }); r.end('{"error":{"message":"internal error"}}'); }
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
for (const n of ['limited', 'busy', 'broken']) saveEndpoint(n, { baseUrl: `http://127.0.0.1:${srv.address().port}/${n}/v1`, defaultModel: 'm' });
test.after(() => srv.close());

const limitedAdapter = (events = [], err = new AgentError('RATE_LIMITED', '429 rate limit', { agent: 'fake' })) => ({ name: 'fake', async *run() { for (const e of events) yield e; throw err; } });

test('classification: provider limit messages become RATE_LIMITED, everything else is left alone', () => {
  for (const m of ['429 Too Many Requests', 'Rate limit exceeded', 'rate_limit_error', "You've hit your usage limit. Try again in 3 hours", 'Claude AI usage limit reached|1700000000',
    'RESOURCE_EXHAUSTED: Quota exceeded for quota metric', 'You exceeded your current quota', 'insufficient_quota', 'Your credit balance is too low', 'Overloaded', 'HTTP 529', 'weekly limit reached',
    "You've hit your limit · resets 3pm", 'The model is at capacity right now']) {
    assert.equal(asRateLimited(new AgentError('AGENT_FAILED', m)).code, 'RATE_LIMITED', m);
  }
  for (const m of ['context hard limit reached (900000/1000000 tokens, exact); compact or handoff first', 'Invalid model "x"', 'spawn failed: ENOENT', 'unexpected argument --foo', 'empty response', 'build failed with 4290 errors', 'the file has 1429 lines']) {
    assert.equal(asRateLimited(new AgentError('AGENT_FAILED', m)).code, 'AGENT_FAILED', m);
  }
  // only AGENT_FAILED is reclassified: an auth error that happens to mention a limit stays an auth error
  assert.equal(asRateLimited(new AgentError('NOT_LOGGED_IN', 'rate limit? no: not logged in')).code, 'NOT_LOGGED_IN');
  assert.equal(asRateLimited(new Error('plain')).message, 'plain');
  const e = asRateLimited(new AgentError('AGENT_FAILED', 'Rate limit hit. Retry after 20s', { agent: 'x', stderr: 'e', sessionId: 's' }));
  assert.deepEqual([e.agent, e.stderr, e.sessionId, e.retryAfterMs, e instanceof AgentError], ['x', 'e', 's', 20000, true]);
  assert.ok(looksRateLimited('quota exhausted') && !looksRateLimited('all good'));
});

test('retry hints are parsed from text and from the Retry-After header', () => {
  assert.equal(retryAfterMs('retry after 20s'), 20000); assert.equal(retryAfterMs('Retry-After: 30'), 30000);
  assert.equal(retryAfterMs('try again in 3 minutes'), 180000); assert.equal(retryAfterMs('resets in 2 hours'), 7200000); assert.equal(retryAfterMs('retry after 500ms'), 500);
  assert.equal(retryAfterMs('nothing here'), undefined);
  assert.equal(retryHeaderMs('7'), 7000); assert.equal(retryHeaderMs(''), undefined); assert.equal(retryHeaderMs(null), undefined);
  const d = retryHeaderMs(new Date(Date.now() + 60000).toUTCString()); assert.ok(d > 50000 && d <= 60000, String(d));
});

test('endpoint: HTTP 429/529 are RATE_LIMITED with retryAfterMs; 500 stays AGENT_FAILED', async () => {
  let e = await ask('limited', { prompt: 'x' }).catch((x) => x);
  assert.equal(e.code, 'RATE_LIMITED'); assert.equal(e.retryAfterMs, 7000); assert.equal(e.status, 429);
  e = await ask('busy', { prompt: 'x' }).catch((x) => x); assert.equal(e.code, 'RATE_LIMITED');
  e = await ask('broken', { prompt: 'x' }).catch((x) => x); assert.equal(e.code, 'AGENT_FAILED');
});

test('fallback option validation', () => {
  const bad = (f) => assert.throws(() => validateOptions({ prompt: 'x', ...f }), (e) => e.code === 'BAD_OPTION', JSON.stringify(f));
  bad({ fallback: 'codex' }); bad({ fallback: [1] }); bad({ fallback: [''] }); bad({ fallback: [{ model: 'x' }] }); bad({ fallback: [{ agent: 'a', model: 3 }] });
  bad({ fallback: ['a', 'b', 'c', 'd', 'e', 'f'] }); bad({ fallbackOn: [] }); bad({ fallbackOn: ['BAD_OPTION'] }); bad({ fallbackOn: 'RATE_LIMITED' });
  const o = validateOptions({ prompt: 'x', fallback: ['codex', 'ollama:glm-5.3-flash:cloud', { agent: 'claude', model: 'haiku' }, 'opencode:'] });
  assert.deepEqual(o.fallback, [{ agent: 'codex' }, { agent: 'ollama', model: 'glm-5.3-flash:cloud' }, { agent: 'claude', model: 'haiku' }, { agent: 'opencode' }]);
});

test('no fallback configured: the RATE_LIMITED error is thrown as is', async () => {
  const e = await ask('limited', { prompt: 'x' }).catch((x) => x);
  assert.equal(e.code, 'RATE_LIMITED'); assert.equal(e.fallback, undefined);
});

test('a rate-limited primary hands the task to a REAL fallback agent (event, result.fallback, its own model)', async () => {
  const seen = []; const it = run('limited', { prompt: PONG, model: 'primary-only-model', fallback: ['claude:haiku'], timeoutMs: 120000 });
  let r; for (;;) { const x = await it.next(); if (x.done) { r = x.value; break; } seen.push(x.value); }
  assert.match(r.text, /PONG/); assert.match(r.model, /haiku/i);
  assert.equal(r.fallback.used, 'claude'); assert.equal(r.fallback.contextLost, false);
  assert.deepEqual(r.fallback.attempts.map((a) => [a.agent, a.code, a.model, a.retryAfterMs]), [['limited', 'RATE_LIMITED', 'primary-only-model', 7000]]);
  const f = seen.filter((e) => e.type === 'fallback'); assert.equal(f.length, 1);
  assert.deepEqual([f[0].from, f[0].to, f[0].code], ['limited', 'claude', 'RATE_LIMITED']);
  assert.ok(seen.indexOf(f[0]) < seen.findIndex((e) => e.type === 'text'), 'fallback event precedes the fallback agent output');
});

test('agent-specific options (effort, extraArgs, model) are NOT forwarded to the fallback agent', async () => {
  const r = await ask(limitedAdapter(), { prompt: PONG, model: 'primary-only-model', effort: 'max', extraArgs: ['--definitely-not-a-claude-flag'], fallback: ['claude:haiku'], timeoutMs: 120000 });
  assert.match(r.text, /PONG/); assert.match(r.model, /haiku/i);
});

test('chain: limited -> busy -> real agent; the whole chain failing reports every attempt', async () => {
  const r = await ask('limited', { prompt: PONG, fallback: ['busy', 'claude:haiku'], timeoutMs: 120000 });
  assert.equal(r.fallback.used, 'claude'); assert.deepEqual(r.fallback.attempts.map((a) => a.agent), ['limited', 'busy']);
  const e = await ask('limited', { prompt: 'x', fallback: ['busy', 'limited'] }).catch((x) => x);
  assert.equal(e.code, 'RATE_LIMITED'); assert.deepEqual(e.fallback.attempts.map((a) => a.agent), ['limited', 'busy', 'limited']);
});

test('fallbackOn: AGENT_FAILED does not fall back by default, does when asked; BAD_OPTION never does', async () => {
  assert.equal(await code(ask('broken', { prompt: 'x', fallback: ['claude:haiku'] })), 'AGENT_FAILED');
  const r = await ask('broken', { prompt: PONG, fallback: ['claude:haiku'], fallbackOn: ['AGENT_FAILED'], timeoutMs: 120000 });
  assert.equal(r.fallback.used, 'claude'); assert.equal(r.fallback.attempts[0].code, 'AGENT_FAILED');
  assert.equal(await code(ask('claude', { prompt: 'x', model: 'haiku', effort: 'nonsense', fallback: ['claude'], fallbackOn: ['AGENT_FAILED', 'RATE_LIMITED'] })), 'BAD_OPTION');
});

test('side-effect guard: a run that already used tools under edit/full is NOT repeated elsewhere; read-only is', async () => {
  for (const permissions of ['edit', 'full']) {
    const seen = []; let err;
    try { const it = run(limitedAdapter([ev.tool('write_file', { path: 'a' }, 'ok')]), { prompt: PONG, permissions, fallback: ['claude:haiku'] }); for (;;) { const x = await it.next(); if (x.done) break; seen.push(x.value); } } catch (e) { err = e; }
    assert.equal(err?.code, 'RATE_LIMITED', permissions); assert.match(err.fallbackSkipped, /already ran tools/);
    assert.ok(!seen.some((e) => e.type === 'fallback'), 'no fallback attempt was made');
  }
  // edit permission but the limit hit BEFORE any tool: safe to fall back
  const r1 = await ask(limitedAdapter([]), { prompt: PONG, permissions: 'edit', fallback: ['claude:haiku'], timeoutMs: 120000 });
  assert.equal(r1.fallback.used, 'claude');
  // read-only: tools cannot have changed anything
  const r2 = await ask(limitedAdapter([ev.tool('read_file', { path: 'a' }, 'ok')]), { prompt: PONG, permissions: 'read-only', fallback: ['claude:haiku'], timeoutMs: 120000 });
  assert.equal(r2.fallback.used, 'claude');
});

test('a session being continued is not carried over: the fallback starts fresh and says so', async () => {
  const r = await ask(limitedAdapter(), { prompt: PONG, session: { mode: 'continue', id: 'abc' }, fallback: ['claude:haiku'], timeoutMs: 120000 });
  assert.equal(r.fallback.contextLost, true); assert.ok(r.sessionId && r.sessionId !== 'abc');
});

test('an aborted run never falls back', async () => {
  const ac = new AbortController(); ac.abort();
  assert.equal(await code(ask('limited', { prompt: 'x', signal: ac.signal, fallback: ['claude:haiku'] })), 'ABORTED');
  const ac2 = new AbortController(); const before = hits.limited;
  const a = { name: 'fake', async *run() { ac2.abort(); throw new AgentError('RATE_LIMITED', '429'); } };
  assert.equal(await code(ask(a, { prompt: 'x', signal: ac2.signal, fallback: ['claude:haiku'] })), 'RATE_LIMITED');
  assert.equal(hits.limited, before);
});

test('telemetry wrapper: the fallback agent owns the session and the run still completes', async () => {
  const r = await askWithTelemetry('limited', { prompt: PONG, fallback: ['claude:haiku'], timeoutMs: 120000 }, { noGlobalHooks: true });
  assert.match(r.text, /PONG/); assert.equal(r.fallback.used, 'claude'); assert.ok(r.telemetry && !r.telemetry.policyError, r.telemetry?.policyError);
  if (r.telemetry.context) assert.equal(r.telemetry.context.agent ?? 'claude', 'claude');
});

test('bridge: ask_<agent> with fallback answers via the fallback and the attestation names the agent that ANSWERED', async () => {
  const key = 'k-' + Math.random(); const env = { ...process.env, AGENTBRIDGE_ATTEST_KEY: key };
  const r = await callAny('ask_limited', { prompt: PONG, fallback: ['claude:haiku'], timeoutSeconds: 120 }, { env });
  assert.ok(!r.isError, JSON.stringify(r.content)); assert.match(r.content[0].text, /PONG/);
  assert.equal(r.structuredContent.fallback.used, 'claude'); assert.equal(r.structuredContent.agent, 'claude'); assert.equal(r.structuredContent.attestation.agent, 'claude');
  assert.ok(verifyAttestation(r.structuredContent.attestation, key, r.content[0].text));
  assert.equal(r.structuredContent.fallback.attempts[0].code, 'RATE_LIMITED');
  // without fallback the error surfaces as a tool error carrying the code
  const e = await callAny('ask_limited', { prompt: 'x' }, { env }).catch((x) => x); assert.ok(e.isError || e.code === 'RATE_LIMITED', JSON.stringify(e).slice(0, 200));
  // unknown fallback agents and bad codes are rejected up front
  for (const args of [{ fallback: ['nope'] }, { fallback: 'claude' }, { fallbackOn: ['BAD_OPTION'] }, { fallback: ['a', 'b', 'c', 'd', 'e', 'f'] }]) {
    const x = await callAny('ask_limited', { prompt: 'x', ...args }, { env }).catch((z) => z); assert.ok(x.isError || x instanceof Error, JSON.stringify(args));
  }
});

test('bridge: dispatch_<agent> + fallback finishes with the fallback result', async () => {
  const env = { ...process.env, AGENTBRIDGE_ATTEST_KEY: 'k' };
  const d = await callAny('dispatch_limited', { prompt: PONG, fallback: ['claude:haiku'], timeoutSeconds: 120 }, { env });
  const id = d.structuredContent.runId; assert.ok(id);
  const w = await callAny('wait_run', { id, timeoutSeconds: 150 }, { env });
  const sc = w.structuredContent; assert.equal(sc.state, 'done', JSON.stringify(sc).slice(0, 300)); assert.match(String(sc.text ?? sc.result?.text ?? ''), /PONG/);
});

test('proxy: a limited agent answers 429 + Retry-After; with --fallback the client just gets the answer', async () => {
  const body = JSON.stringify({ model: 'limited/m', messages: [{ role: 'user', content: PONG }] });
  const post = (p, extra = {}) => fetch(`${p.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, ...extra });
  const p1 = await startProxy({});
  try {
    const r = await post(p1); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '7');
    const j = await r.json(); assert.equal(j.error.type, 'rate_limit_error');
    const a = await fetch(`${p1.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'x' }, body: JSON.stringify({ model: 'limited/m', max_tokens: 50, messages: [{ role: 'user', content: PONG }] }) });
    assert.equal(a.status, 429); assert.equal((await a.json()).error.type, 'rate_limit_error');
  } finally { await p1.close(); }
  const p2 = await startProxy({ fallback: ['claude:haiku'] });
  try {
    const r = await post(p2); assert.equal(r.status, 200, await r.clone().text());
    assert.match((await r.json()).choices[0].message.content, /PONG/);
  } finally { await p2.close(); }
});

const cli = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [MAIN, ...args], { env: { ...process.env, AGENTBRIDGE_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '', e = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => resolve({ code: c, out: o, err: e }));
});

test('CLI: ab run --fallback prints the answer and explains the switch; --json carries result.fallback', async () => {
  let r = await cli(['run', 'limited', PONG, '--fallback', 'claude:haiku', '--timeout', '120']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /PONG/); assert.match(r.err, /\[fallback: limited RATE_LIMITED \(retry in 7s\) -> answered by claude/);
  r = await cli(['run', 'limited', PONG, '--fallback', 'claude:haiku', '--json', '--timeout', '120']);
  assert.equal(JSON.parse(r.out).fallback.used, 'claude');
  r = await cli(['run', 'limited', PONG, '--stream', '--fallback', 'claude:haiku', '--timeout', '120']);
  assert.match(r.err, /\[fallback\] limited failed \(RATE_LIMITED\); trying claude/);
  r = await cli(['ask', 'limited', 'x']); assert.equal(r.code, 1); assert.match(r.err, /RATE_LIMITED/);
  r = await cli(['ask', 'limited', 'x', '--fallback', 'claude', '--fallback-on', 'BAD_OPTION']); assert.equal(r.code, 2);
});
