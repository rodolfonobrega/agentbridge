// Account pool: opt-in guard, rotation, cooldown after RATE_LIMITED, sticky sessions (fake adapter, no real CLI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProxy } from '../src/server/index.mjs';
import { createPool, parseAccounts } from '../src/server/pool.mjs';
import { AgentError } from '../src/core/errors.mjs';
import { ev } from '../src/core/events.mjs';

const ACCOUNTS = (strategy) => ({ strategy, fake: [{ name: 'a', env: { HOME_X: 'A' } }, { name: 'b', env: { HOME_X: 'B' } }] });
const used = [];
let limited = new Set(); // accounts (by env) that answer RATE_LIMITED
const adapter = { name: 'fake', async *run(o) {
  const who = o.env?.HOME_X ?? 'none';
  used.push(who);
  if (limited.has(who)) throw new AgentError('RATE_LIMITED', 'usage limit reached', { retryAfterMs: 60_000, kind: 'quota' });
  yield ev.text('ok-' + who);
  return { text: 'ok-' + who, usage: { input: 1, output: 1 } };
} };

const withProxy = async (extra, fn) => {
  const p = await startProxy({ port: 0, adapters: { fake: adapter }, ...extra });
  used.length = 0; limited = new Set();
  try { await fn(p); } finally { await p.close(); }
};
const chat = (p, headers = {}) => fetch(p.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }] }) });

test('pool refuses to start without --accept-tos-risk', async () => {
  const keep = process.env.AGENTBRIDGE_ACCEPT_TOS_RISK; delete process.env.AGENTBRIDGE_ACCEPT_TOS_RISK;
  try {
    await assert.rejects(startProxy({ port: 0, adapters: { fake: adapter }, accounts: ACCOUNTS() }), /terms of service/);
    process.env.AGENTBRIDGE_ACCEPT_TOS_RISK = '1';
    const p = await startProxy({ port: 0, adapters: { fake: adapter }, accounts: ACCOUNTS() }); await p.close();
  } finally { if (keep === undefined) delete process.env.AGENTBRIDGE_ACCEPT_TOS_RISK; else process.env.AGENTBRIDGE_ACCEPT_TOS_RISK = keep; }
});

test('parseAccounts validates the file', () => {
  assert.throws(() => parseAccounts({ strategy: 'x', fake: [{ name: 'a' }] }), /strategy/);
  assert.throws(() => parseAccounts({ fake: [] }), /non-empty/);
  assert.throws(() => parseAccounts({ fake: [{ name: 'a' }, { name: 'a' }] }), /duplicate/);
  assert.throws(() => parseAccounts({ fake: [{ name: 'a', env: { X: 1 } }] }), /env/);
});

test('round-robin rotates accounts', async () => {
  await withProxy({ accounts: ACCOUNTS('round-robin'), acceptTosRisk: true }, async (p) => {
    for (let i = 0; i < 4; i++) await chat(p);
    assert.deepEqual(used, ['A', 'B', 'A', 'B']);
  });
});

test('fill-first sticks to the first account until it is limited', async () => {
  await withProxy({ accounts: ACCOUNTS('fill-first'), acceptTosRisk: true }, async (p) => {
    await chat(p); await chat(p);
    assert.deepEqual(used, ['A', 'A']);
    limited.add('A');
    const r = await chat(p);
    assert.equal(r.status, 200); assert.equal((await r.json()).choices[0].message.content, 'ok-B'); // retried on B within the request
    await chat(p);
    assert.deepEqual(used.slice(-3), ['A', 'B', 'B']); // A is cooling down now: skipped
  });
});

test('every account limited -> 429 with retry-after; /admin/status shows cooldowns without env', async () => {
  await withProxy({ accounts: ACCOUNTS('round-robin'), acceptTosRisk: true }, async (p) => {
    limited = new Set(['A', 'B']);
    const r = await chat(p);
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);
    const r2 = await chat(p); // both cooling: refused without spawning anything
    assert.equal(r2.status, 429); assert.equal(used.length, 2);
    const s = await (await fetch(p.url + '/admin/status')).json();
    assert.equal(s.pool.agents.fake.every((a) => !a.available && a.kind === 'quota'), true);
    assert.ok(!JSON.stringify(s).includes('HOME_X'));
  });
});

test('sticky: the same session key keeps its account', async () => {
  const pool = createPool(ACCOUNTS('sticky'));
  const first = pool.pick('fake', 's1');
  for (let i = 0; i < 5; i++) assert.equal(pool.pick('fake', 's1').name, first.name);
  pool.fail('fake', first.name, { retryAfterMs: 1000 });
  assert.notEqual(pool.pick('fake', 's1').name, first.name);
});

test('cooldown ends on its own', () => {
  let t = 0;
  const pool = createPool(ACCOUNTS('fill-first'), { now: () => t });
  pool.fail('fake', 'a', { retryAfterMs: 1000 });
  assert.equal(pool.pick('fake').name, 'b');
  t = 1500;
  assert.equal(pool.pick('fake').name, 'a');
});

test('no pool by default: requests run with no extra env', async () => {
  await withProxy({}, async (p) => {
    await chat(p);
    assert.deepEqual(used, ['none']);
    assert.equal((await (await fetch(p.url + '/admin/status')).json()).pool, null);
  });
});

test('/admin/usage counts runs per agent/account and writes a JSONL log', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ab-log-')), logFile = join(dir, 'u.jsonl');
  try {
    await withProxy({ accounts: ACCOUNTS('round-robin'), acceptTosRisk: true, logFile }, async (p) => {
      await chat(p); await chat(p); await chat(p);
      const u = await (await fetch(p.url + '/admin/usage')).json();
      assert.equal(u.total.requests, 3); assert.equal(u.groups.length, 2);
      assert.equal(u.groups.find((g) => g.account === 'a').requests, 2);
      const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(lines.length, 3); assert.ok(!('prompt' in lines[0]));
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
