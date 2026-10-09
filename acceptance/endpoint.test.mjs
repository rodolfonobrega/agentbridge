// REAL runs against a local Ollama (skipped, loudly, if it is not reachable). A tiny local HTTP server is used ONLY as a
// protocol fixture to observe the auth headers our client sends / force 401; it never stands in for a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-ep-home-')));
process.env.AGENTBRIDGE_HOME = HOME;
const { ask, run, agents, AgentError, loadEndpoints } = await import('../dist/index.js');
const { saveEndpoint } = await import('../dist/adapters/endpoint.js');
const { callAny, allTools } = await import('../dist/bridge/mcp.js');

const MAIN = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const BASE = 'http://127.0.0.1:11434';
let up = false, MODEL;
try { const r = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(4000) }); const j = await r.json(); up = r.ok; MODEL = (j.models || []).map((m) => m.name).find((n) => /glm|qwen2\.5:7b/i.test(n)) || j.models?.[0]?.name; } catch { /* not running */ }
const live = (name, fn) => (up && MODEL ? test(name, { timeout: 240000 }, fn) : test(name, { skip: 'Ollama is not running on 127.0.0.1:11434 (start it with `ollama serve`)' }, fn));
const code = async (p) => { try { await p; } catch (e) { return e.code; } return 'no-error'; };

test('config validation (no network)', async () => {
  assert.throws(() => saveEndpoint('Bad-Name', { baseUrl: 'http://x/v1' }), (e) => e.code === 'BAD_OPTION');
  assert.throws(() => saveEndpoint('claude', { baseUrl: 'http://x/v1' }), (e) => e.code === 'BAD_OPTION');
  assert.throws(() => saveEndpoint('okname', { baseUrl: 'ftp://x' }), (e) => e.code === 'BAD_OPTION');
  assert.throws(() => saveEndpoint('okname', { baseUrl: 'http://x/v1', type: 'grpc' }), (e) => e.code === 'BAD_OPTION');
  writeFileSync(path.join(HOME, 'endpoints.json'), '{ not json');
  assert.throws(() => loadEndpoints(), (e) => e.code === 'BAD_OPTION');
  writeFileSync(path.join(HOME, 'endpoints.json'), '{}');
  assert.deepEqual(Object.keys(loadEndpoints()), ['ollama']);
  assert.ok(agents.names.includes('ollama') && agents.names.includes('claude'));
  assert.equal(await code(ask('nope_agent', { prompt: 'x' })), 'BAD_OPTION');
});

test('OLLAMA_HOST is honored for the built-in ollama endpoint', () => {
  const eps = loadEndpoints({ ...process.env, OLLAMA_HOST: '10.1.2.3:9999' });
  assert.equal(eps.ollama.baseUrl, 'http://10.1.2.3:9999/v1');
});

test('unsupported options in plain chat throw BAD_OPTION (never silently ignored)', async () => {
  assert.equal(await code(ask('ollama', { prompt: 'x', model: 'm', extraArgs: ['--x'] })), 'BAD_OPTION');
  saveEndpoint('anth_fixture', { type: 'anthropic', baseUrl: BASE });
  assert.equal(await code(ask('anth_fixture', { prompt: 'x', model: 'm', effort: 'high' })), 'BAD_OPTION');
  assert.equal(await code(ask('anth_fixture', { prompt: 'x', model: 'm', jsonSchema: { type: 'object' } })), 'BAD_OPTION');
});

test('permissions "edit" on ollama routes to execution harness instead of rejecting', async () => {
  const c = await code(ask('ollama', { prompt: 'x', model: 'm', permissions: 'edit', timeoutMs: 1500 }));
  assert.notEqual(c, 'BAD_OPTION', 'must not reject permissions "edit" with BAD_OPTION');
});

test('harness options validation and routing', async () => {
  assert.equal(await code(ask('ollama', { prompt: 'x', model: 'm', harness: 'invalid' })), 'BAD_OPTION');
  assert.equal(await code(ask('ollama', { prompt: 'x', model: 'm', harness: 'none', extraArgs: ['--foo'] })), 'BAD_OPTION');

  const tools = allTools();
  const askOllama = tools.find((t) => t.name === 'ask_ollama');
  assert.ok(askOllama, 'ask_ollama should exist');
  assert.ok(askOllama.inputSchema.properties.harness, 'ask_ollama should have harness property');
  assert.deepEqual(askOllama.inputSchema.properties.harness.enum, ['auto', 'claude', 'pi', 'none']);
});

test('unreachable endpoint -> AGENT_FAILED with the URL in the message', async () => {
  saveEndpoint('dead_end', { baseUrl: 'http://127.0.0.1:1/v1', defaultModel: 'm' });
  const e = await ask('dead_end', { prompt: 'x', timeoutMs: 8000 }).catch((x) => x);
  assert.equal(e.code, 'AGENT_FAILED'); assert.match(e.message, /127\.0\.0\.1:1/);
});

test('auth: apiKeyEnv is sent as Bearer; 401 -> NOT_LOGGED_IN (protocol fixture)', async () => {
  let seen;
  const srv = http.createServer((req, res) => {
    seen = req.headers.authorization;
    if (seen !== 'Bearer sekret') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"nope"}'); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"model":"fx","choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    saveEndpoint('keyed', { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, apiKeyEnv: 'AB_TEST_EP_KEY', defaultModel: 'fx' });
    assert.equal(await code(ask('keyed', { prompt: 'x', env: { AB_TEST_EP_KEY: 'wrong' } })), 'NOT_LOGGED_IN');
    const r = await ask('keyed', { prompt: 'x', env: { AB_TEST_EP_KEY: 'sekret' }, session: { mode: 'ephemeral' } });
    assert.equal(r.text, 'hi'); assert.equal(seen, 'Bearer sekret'); assert.deepEqual([r.usage.input, r.usage.output], [3, 1]); assert.equal(r.model, 'fx');
  } finally { srv.close(); }
});

live('real ask: text, usage, model, streaming deltas, ephemeral has no session', async () => {
  const r = await ask('ollama', { prompt: 'Reply with exactly: PONG', model: MODEL, session: { mode: 'ephemeral' }, timeoutMs: 200000 });
  assert.match(r.text, /PONG/); assert.equal(r.exitCode, 0); assert.equal(r.sessionId, undefined); assert.ok(r.usage.input > 0 && r.usage.output > 0); assert.ok(r.model);
  let deltas = 0; const it = run('ollama', { prompt: 'Count from 1 to 12 separated by single spaces.', model: MODEL, session: { mode: 'ephemeral' }, timeoutMs: 200000 });
  for (;;) { const x = await it.next(); if (x.done) break; if (x.value.type === 'text') deltas++; }
  assert.ok(deltas > 1, `expected incremental streaming, got ${deltas} delta(s)`);
});

live('models() lists real models; model omitted -> first listed', async () => {
  const ms = await agents.models('ollama'); assert.ok(ms.includes(MODEL));
  const r = await ask('ollama', { prompt: 'Reply with exactly: OK', session: { mode: 'ephemeral' }, timeoutMs: 200000 });
  assert.ok(r.model);
});

live('sessions: new -> continue recalls; fork leaves the original untouched; continue without id picks the latest for cwd', async () => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-ep-cwd-')));
  const a = await ask('ollama', { prompt: 'Remember the secret word MANGO. Reply only OK.', model: MODEL, cwd, session: { mode: 'new' }, timeoutMs: 200000 });
  assert.ok(a.sessionId);
  const b = await ask('ollama', { prompt: 'What is the secret word? One word.', model: MODEL, cwd, session: { mode: 'continue', id: a.sessionId }, timeoutMs: 200000 });
  assert.match(b.text, /MANGO/i); assert.equal(b.sessionId, a.sessionId);
  const f = await ask('ollama', { prompt: 'The secret word is now KIWI. Reply only OK.', model: MODEL, cwd, session: { mode: 'fork', id: a.sessionId }, timeoutMs: 200000 });
  assert.notEqual(f.sessionId, a.sessionId);
  const orig = JSON.parse(readFileSync(path.join(HOME, 'endpoint-sessions', `${a.sessionId}.json`), 'utf8'));
  assert.ok(!orig.messages.some((m) => /KIWI/.test(m.content)), 'fork must not modify the original session');
  const c = await ask('ollama', { prompt: 'What is the secret word? One word.', model: MODEL, cwd, session: { mode: 'continue' }, timeoutMs: 200000 });
  assert.match(c.text, /KIWI/i);
  assert.equal(await code(ask('ollama', { prompt: 'x', model: MODEL, session: { mode: 'continue', id: 'not-a-uuid' } })), 'BAD_OPTION');
  assert.equal(await code(ask('ollama', { prompt: 'x', model: MODEL, session: { mode: 'continue', id: '00000000-0000-4000-8000-000000000000' } })), 'BAD_OPTION');
});

live('concurrent continue on one session: second gets BAD_OPTION busy', async () => {
  const a = await ask('ollama', { prompt: 'Reply OK.', model: MODEL, session: { mode: 'new' }, timeoutMs: 200000 });
  const p1 = ask('ollama', { prompt: 'Write 40 words about the sea.', model: MODEL, session: { mode: 'continue', id: a.sessionId }, timeoutMs: 200000 });
  await new Promise((r) => setTimeout(r, 50));
  const e = await ask('ollama', { prompt: 'x', model: MODEL, session: { mode: 'continue', id: a.sessionId } }).catch((x) => x);
  assert.equal(e.code, 'BAD_OPTION'); assert.match(e.message, /busy/);
  await p1;
});

live('errors: invalid model -> BAD_OPTION, timeout -> TIMEOUT, abort -> ABORTED', async () => {
  assert.equal(await code(ask('ollama', { prompt: 'hi', model: 'no-such-model-xyz', session: { mode: 'ephemeral' } })), 'BAD_OPTION');
  assert.equal(await code(ask('ollama', { prompt: 'Write a very long story.', model: MODEL, timeoutMs: 100, session: { mode: 'ephemeral' } })), 'TIMEOUT');
  const ac = new AbortController(); const t0 = Date.now();
  const it = run('ollama', { prompt: 'Write a 2000 word essay about the history of Rome.', model: MODEL, signal: ac.signal, session: { mode: 'ephemeral' }, timeoutMs: 200000 });
  let e;
  try { for (;;) { const x = await it.next(); if (x.done) break; if (x.value.type === 'text' || x.value.type === 'thinking') ac.abort(); } } catch (x) { e = x; }
  assert.equal(e?.code, 'ABORTED'); assert.ok(Date.now() - t0 < 120000);
});

live('jsonSchema (openai-type) returns parsed structured output', async () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const r = await ask('ollama', { prompt: 'Return JSON with the capital of France in field city.', model: MODEL, jsonSchema: schema, session: { mode: 'ephemeral' }, timeoutMs: 200000 });
  assert.match(String(r.structured?.city), /paris/i);
});

live('anthropic-type endpoint works against the same server (Ollama /v1/messages)', async () => {
  saveEndpoint('ollama_anth', { type: 'anthropic', baseUrl: BASE, defaultModel: MODEL });
  const r = await ask('ollama_anth', { prompt: 'Reply with exactly: PONG', session: { mode: 'ephemeral' }, timeoutMs: 200000 });
  assert.match(r.text, /PONG/); assert.ok(r.usage.output > 0);
});

live('a custom-named endpoint on another base URL is usable via the bridge (ask_ + dispatch_ + wait_run)', async () => {
  saveEndpoint('lab_gpu', { baseUrl: `${BASE}/v1`, defaultModel: MODEL });
  const env = { ...process.env, AGENTBRIDGE_HOME: HOME };
  assert.ok(allTools(env).some((t) => t.name === 'ask_lab_gpu'));
  const r = await callAny('ask_lab_gpu', { prompt: 'Reply with exactly: PONG', session: { mode: 'ephemeral' }, timeoutSeconds: 200 }, { env });
  assert.match(r.content[0].text, /PONG/); assert.equal(r.structuredContent.agent, 'lab_gpu'); assert.ok(r.structuredContent.attestation?.hmac);
  const d = await callAny('dispatch_lab_gpu', { prompt: 'Reply with exactly: ASYNC', session: { mode: 'ephemeral' }, timeoutSeconds: 200 }, { env });
  const w = await callAny('wait_run', { id: d.structuredContent.runId, timeoutSeconds: 120 }, { env });
  assert.match(w.content[0].text, /ASYNC/i);
  assert.ok(await callAny('ask_lab_gpu', { prompt: 'x', permissions: 'full' }, { env: { ...env, AGENTBRIDGE_PERMS: 'read-only' } }).then(() => false, () => true), 'permission ceiling still applies to endpoints');
});

test('CLI: endpoint add/list/remove and install claude (project scope, no model call)', async () => {
  const run1 = (args, cwd) => new Promise((res) => { const p = spawn(process.execPath, [MAIN, ...args], { cwd, env: { ...process.env, AGENTBRIDGE_HOME: HOME } }); let o = '', e = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d)); p.on('close', (c) => res({ c, o, e })); });
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-ep-proj-')));
  let r = await run1(['endpoint', 'add', 'cli_ep', 'http://127.0.0.1:9/v1', '--model', 'm'], cwd); assert.equal(r.c, 0, r.e);
  r = await run1(['endpoint', 'list'], cwd); assert.match(r.o, /cli_ep/);
  r = await run1(['endpoint', 'add', 'claude', 'http://x/v1'], cwd); assert.notEqual(r.c, 0);
  r = await run1(['install', 'claude', '--permissions', 'edit', '--max-depth', '1'], cwd); assert.equal(r.c, 0, r.e + r.o);
  const mcp = JSON.parse(readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).mcpServers.agentbridge;
  assert.equal(mcp.env.AGENTBRIDGE_PERMS, 'edit'); assert.equal(mcp.env.AGENTBRIDGE_MAX_DEPTH, '1'); assert.deepEqual(mcp.args.slice(-1), ['bridge']);
  const sk = path.join(cwd, '.claude', 'skills', 'agentbridge-delegate', 'SKILL.md'); assert.ok(existsSync(sk), 'skill installed');
  assert.match(readFileSync(sk, 'utf8'), /^---\r?\nname: agentbridge-delegate\r?\n/);
  for (const n of ['codex', 'opencode', 'ollama', 'cli_ep']) {
    const f = path.join(cwd, '.claude', 'agents', `${n}-agent.md`); assert.ok(existsSync(f), f);
    assert.match(readFileSync(f, 'utf8'), new RegExp(`mcp__agentbridge__ask_${n}`));
  }
  r = await run1(['endpoint', 'remove', 'cli_ep'], cwd); assert.equal(r.c, 0, r.e);
  r = await run1(['install', 'nosuchagent'], cwd); assert.notEqual(r.c, 0);
  r = await run1(['install', 'claude', '--scope', 'weird'], cwd); assert.notEqual(r.c, 0);
});
