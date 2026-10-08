import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { dispatch, loadRun, cancelRun, setKeep, waitRun, sendMessage, checkMessages, runsDir } from '../dist/bridge/runs.js';
import { bridgeMeta } from '../dist/bridge/subagent.js';
import { attest } from '../dist/bridge/mcp.js';

const T = { timeout: 60000 };
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-reg-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUNS = pathToFileURL(fileURLToPath(new URL('../dist/bridge/runs.js', import.meta.url))).href;

test('D1: cross-process cancel + retain survive an owner that streams events constantly', T, async () => {
  const home = tmp();
  const script = path.join(home, 'owner.mjs');
  writeFileSync(script, `import { dispatch } from ${JSON.stringify(RUNS)};
const env = { ...process.env };
const { rec } = dispatch({ agent: 'claude', prompt: 'x', env, exec: async ({ onEvent, signal }) => { for (let i = 0; i < 2000; i++) { if (signal.aborted) throw new Error('aborted'); onEvent({ type: 'text', delta: 'x' }); await new Promise((r) => setTimeout(r, 5)); } return { text: 'done' }; } });
console.log('ID ' + rec.id);
setTimeout(() => process.exit(0), 12000);`);
  const p = spawn(process.execPath, [script], { env: { ...process.env, AGENTBRIDGE_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const id = await new Promise((res) => { let b = ''; p.stdout.on('data', (d) => { b += d; const m = /ID (\S+)/.exec(b); if (m) res(m[1]); }); });
    const env = { AGENTBRIDGE_HOME: home };
    await sleep(500);
    assert.equal(loadRun(id, env).state, 'running');
    setKeep(id, true, env);
    await sleep(700);
    assert.equal(loadRun(id, env).keep, true, 'retain survives owner saves');
    const t0 = Date.now(); cancelRun(id, env);
    for (;;) { if (loadRun(id, env).state === 'cancelled') break; if (Date.now() - t0 > 4000) assert.fail('cancel lost under streaming'); await sleep(50); }
    assert.equal(loadRun(id, env).keep, true, 'keep still set after cancel');
  } finally { p.kill(); }
});

test('D5: concurrent send_message/check_messages never lose or duplicate messages; sender is server-stamped', T, async () => {
  const env = { AGENTBRIDGE_HOME: tmp() };
  const got = []; let stop = false;
  const reader = (async () => { while (!stop) { got.push(...checkMessages(env, { for: 'w' })); await sleep(2); } })();
  const reader2 = (async () => { while (!stop) { got.push(...checkMessages(env, { for: 'w' })); await sleep(3); } })();
  await Promise.all(Array.from({ length: 60 }, (_, i) => (async () => { await sleep(i % 7); sendMessage(env, { to: 'w', from: 'i-am-root', text: `m${i}` }); })()));
  await sleep(200); stop = true; await Promise.all([reader, reader2]); got.push(...checkMessages(env, { for: 'w' }));
  assert.equal(got.length, 60); assert.equal(new Set(got.map((m) => m.text)).size, 60);
  assert.ok(got.every((m) => m.fromVerified === false && m.sender.pid === process.pid && m.fromClaimed === 'i-am-root'));
});

test('D6: idempotency key of a dead/GC-ed run is reclaimable; live/done runs still dedupe', T, async () => {
  const env = { AGENTBRIDGE_HOME: tmp() };
  const ok = async () => ({ text: 'ok' });
  const a = dispatch({ agent: 'claude', key: 'k', prompt: 'p', env, exec: async () => { throw new Error('boom'); } });
  await waitRun(a.rec.id, 5000, env); assert.equal(loadRun(a.rec.id, env).state, 'error');
  const b = dispatch({ agent: 'claude', key: 'k', prompt: 'p', env, exec: ok });
  assert.notEqual(b.rec.id, a.rec.id); assert.equal(b.deduped, false, 'retry after error creates a fresh run');
  await waitRun(b.rec.id, 5000, env); assert.equal(loadRun(b.rec.id, env).state, 'done');
  const c = dispatch({ agent: 'claude', key: 'k', prompt: 'p', env, exec: ok });
  assert.equal(c.rec.id, b.rec.id); assert.equal(c.deduped, true, 'done run still dedupes');
  unlinkSync(path.join(runsDir(env), `${b.rec.id}.json`)); // simulate GC
  const d = dispatch({ agent: 'claude', key: 'k', prompt: 'p', env, exec: ok });
  assert.notEqual(d.rec.id, b.rec.id); assert.equal(d.deduped, false, 'lock pointing at a missing run is reclaimed');
  await waitRun(d.rec.id, 5000, env); assert.ok(loadRun(d.rec.id, env));
});

test('cancel/retain are scoped to the launch root', T, async () => {
  const home = tmp();
  const mine = { AGENTBRIDGE_HOME: home, AGENTBRIDGE_ROOT: 'rootA' }, other = { AGENTBRIDGE_HOME: home, AGENTBRIDGE_ROOT: 'rootB' };
  const { rec } = dispatch({ agent: 'claude', prompt: 'x', env: mine, exec: async ({ signal }) => { await new Promise((r) => signal.addEventListener('abort', r)); throw new Error('aborted'); } });
  assert.match(cancelRun(rec.id, other).error, /different launch root/); assert.match(setKeep(rec.id, true, other).error, /different launch root/);
  assert.equal(cancelRun(rec.id, mine).rec.state, 'cancelled');
});

test('D2: attestation replay / cross-launch / wrong-prompt are rejected; one-time use', T, () => {
  const key = 'k-' + randomBytes(4).toString('hex');
  const env = { AGENTBRIDGE_ATTEST_KEY: key, AGENTBRIDGE_ATTEST_BIND: 'bindA' };
  const promptSha = 'p'.repeat(64);
  const a = attest({ agent: 'claude', sessionId: 's', depth: 1, model: 'haiku', text: 'ANS', promptSha }, env);
  const out = JSON.stringify({ content: [{ type: 'text', text: 'ANS' }, { type: 'text', text: '[agentbridge] ' + JSON.stringify(a) }] });
  const seen = new Set();
  assert.equal(bridgeMeta(out, key, { bind: 'bindB', seen, promptSha }), null, 'other launch (bind) rejected');
  assert.equal(bridgeMeta(out, key, { bind: 'bindA', seen, promptSha: 'q'.repeat(64) }), null, 'other prompt rejected');
  assert.ok(bridgeMeta(out, key, { bind: 'bindA', seen, promptSha }), 'first use accepted');
  assert.equal(bridgeMeta(out, key, { bind: 'bindA', seen, promptSha }), null, 'replay rejected');
});

test('D3/N1 (round 7): mcpConfigFor carries NO secret at all — attestKey has no parameter, so it can only reach the child via its own top-level env', async () => {
  const { mcpConfigFor } = await import('../dist/bridge/attach.js');
  const key = 'super-secret-' + randomBytes(4).toString('hex');
  const e = mcpConfigFor('codex', { attestKey: key }).agentbridge; // attestKey is not a recognized option any more
  assert.ok(!JSON.stringify(e).includes(key), 'mcpConfigFor must never surface a key value, even if a caller passes one by mistake');
  const { attestKey } = await import('../dist/bridge/mcp.js');
  assert.equal(attestKey({ AGENTBRIDGE_ATTEST_KEY: key }), key, 'attestKey() itself still just reads whatever env it is given');
});
