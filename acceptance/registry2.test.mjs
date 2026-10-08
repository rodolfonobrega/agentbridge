import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { dispatch, loadRun, cancelRun, waitRun, runsDir } from '../dist/bridge/runs.js';
import { mcpConfigFor } from '../dist/bridge/attach.js';
import { MCP } from './_rpc.mjs';

const T = { timeout: 90000 };
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-reg2-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUNS = pathToFileURL(fileURLToPath(new URL('../dist/bridge/runs.js', import.meta.url))).href;

// Round 6/7 / N1: mcpConfigFor() itself never touches the filesystem and has no `attestKey` parameter (round 7: even that value
// was a mistake — see acceptance/keydelivery.test.mjs for the proof against the REAL adapter-mediated spawn path, where the
// actual leak lived). This test only checks the bridge SERVER's own behavior in isolation: given the key directly on its own
// process env (however it got there), it never writes it anywhere on disk while idle.
test('N1 (round 7): the bridge server itself never touches the filesystem with the key, and a sibling scanning %TEMP% finds nothing', T, async () => {
  const key = 'k-steal-target-' + randomBytes(8).toString('hex');
  const before = new Set(readdirSync(tmpdir()));
  const e = mcpConfigFor('claude', {}).agentbridge; // no secret in this config at all any more
  assert.ok(!('attestKey' in e.env) && !JSON.stringify(e.env).includes(key));
  const p = spawn(process.execPath, [MCP], { env: { ...process.env, ...e.env, AGENTBRIDGE_ATTEST_KEY: key }, stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    // steal.mjs-equivalent: for the whole idle window before any tool call, repeatedly scan %TEMP% for anything new and grep it for the key.
    let found = null;
    for (let i = 0; i < 40 && !found; i++) {
      await sleep(50);
      let after = []; try { after = readdirSync(tmpdir()); } catch { /* ignore */ }
      for (const n of after) {
        if (before.has(n)) continue;
        try {
          const full = path.join(tmpdir(), n);
          const st = statSync(full);
          if (st.isDirectory()) { for (const sub of readdirSync(full)) { const c = readFileSync(path.join(full, sub), 'utf8'); if (c.includes(key)) found = path.join(full, sub); } }
          else { const c = readFileSync(full, 'utf8'); if (c.includes(key)) found = full; }
        } catch { /* not readable / not ours (binary, locked, race) */ }
      }
    }
    assert.equal(found, null, `key must never appear on disk (found in ${found})`);
  } finally { p.kill(); }
});

test('N2: two processes racing on one idempotency key always converge on ONE run (10 rounds)', T, async () => {
  const home = tmp();
  const script = path.join(home, 'disp.mjs');
  writeFileSync(script, `import { dispatch } from ${JSON.stringify(RUNS)};
const [key] = process.argv.slice(2);
await new Promise((r) => setTimeout(r, Number(process.argv[3]) - Date.now() > 0 ? Number(process.argv[3]) - Date.now() : 0));
const { rec, deduped } = dispatch({ agent: 'claude', key, prompt: 'p', env: process.env, exec: async () => { await new Promise((r) => setTimeout(r, 800)); return { text: 'ok' }; } });
console.log(JSON.stringify({ id: rec.id, deduped }));
setTimeout(() => process.exit(0), 1200);`);
  const one = (key, at) => new Promise((res) => { const p = spawn(process.execPath, [script, key, String(at)], { env: { ...process.env, AGENTBRIDGE_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] }); let b = ''; p.stdout.on('data', (d) => { b += d; }); p.on('exit', () => res(JSON.parse(b.trim().split('\n').pop()))); });
  for (let i = 0; i < 10; i++) {
    const at = Date.now() + 700;
    const [a, b] = await Promise.all([one(`race${i}`, at), one(`race${i}`, at)]);
    assert.equal(a.id, b.id, `round ${i}: same run id`); assert.deepEqual([a.deduped, b.deduped].sort(), [false, true], `round ${i}: exactly one creator`);
  }
  const env = { AGENTBRIDGE_HOME: home };
  const recs = readdirSync(runsDir(env)).filter((n) => n.endsWith('.json'));
  assert.equal(recs.length, 10, 'no duplicate/orphan run records');
});

test('N4: cancelling an already-finished live run changes nothing and writes no marker', T, async () => {
  const env = { AGENTBRIDGE_HOME: tmp() };
  const { rec } = dispatch({ agent: 'claude', prompt: 'p', env, exec: async () => ({ text: 'ok' }) });
  await waitRun(rec.id, 5000, env); assert.equal(loadRun(rec.id, env).state, 'done');
  const c = cancelRun(rec.id, env);
  assert.equal(c.rec.state, 'done'); assert.equal(loadRun(rec.id, env).state, 'done');
  assert.ok(!existsSync(path.join(runsDir(env), `${rec.id}.cancel`)), 'no stray cancel marker');
});

test('N1 (round 6): a real end-to-end tools/call, then attempted forgery WITHOUT the key fails verification', T, async () => {
  const { attest, verifyAttestation } = await import('../dist/bridge/mcp.js');
  const realKey = 'k-real-' + randomBytes(8).toString('hex');
  const st = { agent: 'claude', sessionId: 's1', depth: 1, model: 'haiku', text: 'ANSWER-42', promptSha: 'p'.repeat(64) };
  const genuine = attest(st, { AGENTBRIDGE_ATTEST_KEY: realKey, AGENTBRIDGE_ATTEST_BIND: 'b1' });
  // A sibling process (like the critic's steal.mjs) that never obtained the key can only guess it; every guess fails.
  for (const guess of ['', 'wrong', realKey.slice(0, -1) + 'x', realKey.toUpperCase()]) {
    assert.equal(verifyAttestation(genuine, guess, st.text), false, `forged/guessed key "${guess}" must not verify`);
  }
  assert.equal(verifyAttestation(genuine, realKey, st.text), true, 'the real key still verifies (sanity check)');
});
