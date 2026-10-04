// The dashboard (`ab ui`). Offline part: aggregation maths, the HTTP surface and its hardening, run records written by the tracker.
// Live part (skipped when claude is missing): a REAL claude run made through the CLI path must show up in /api/stats.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-ui-test-home-')));
process.env.AGENTBRIDGE_HOME = HOME;
const { startUi, summarize } = await import('../src/ui/server.mjs');
const { createTracker, stats } = await import('../src/telemetry/stats.mjs');
const { runTracked } = await import('../src/index.mjs');
const { resolveBinary } = await import('../src/core/spawn.mjs');
const MAIN = fileURLToPath(new URL('../src/cli/main.mjs', import.meta.url));

const get = (port, p, { host, method = 'GET', headers = {} } = {}) => new Promise((ok, bad) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(host ? { host } : {}), ...headers } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: b })); });
  r.on('error', bad); r.end();
});

// ---- seed REAL run records through the tracker (the same code path every run uses)
function seed(agent, o) {
  const tr = createTracker({ agent, opts: { prompt: o.prompt || 'seeded prompt', model: o.model, cwd: '/work' }, origin: o.origin || 'cli' });
  tr.onEvent({ type: 'session', id: o.session || `sess-${Math.random().toString(16).slice(2)}` });
  if (o.usage) tr.onEvent({ type: 'usage', input: o.usage[0], output: o.usage[1], cost: o.cost });
  for (const t of o.tools || []) { tr.onEvent({ type: 'tool', name: t, input: {} }); }
  tr.onEvent({ type: 'text', delta: o.out || 'ok' });
  if (o.error) tr.finish({ error: Object.assign(new Error(o.error.msg), { code: o.error.code }) });
  else tr.finish({ result: { text: o.out || 'ok', sessionId: undefined, usage: o.usage && { input: o.usage[0], output: o.usage[1], ...(o.cost != null ? { cost: o.cost } : {}) }, ...(o.fallback ? { fallback: o.fallback } : {}) } });
  return tr.rec;
}

test('summarize: counts, rates, tokens, cost, fallback, durations and buckets', () => {
  const now = 1_000_000_000;
  const mk = (o) => ({ agent: 'a', origin: 'cli', startedAt: now - 1000, endedAt: now, elapsedMs: 1000, status: 'finished', usage: null, cost: null, toolCalls: 0, toolsByName: {}, error: null, fallback: null, ...o });
  const runs = [
    mk({ agent: 'claude', usage: { input: 100, output: 20 }, cost: 0.01, toolCalls: 2, toolsByName: { Read: 2 }, elapsedMs: 1000 }),
    mk({ agent: 'claude', status: 'error', error: 'RATE_LIMITED: 429', elapsedMs: 3000 }),
    mk({ agent: 'claude', status: 'finished', fallback: { used: 'codex', attempts: [] }, usage: { input: 5, output: 5 }, elapsedMs: 2000 }),
    mk({ agent: 'codex', status: 'active', endedAt: null, elapsedMs: 500 }),
    mk({ agent: 'codex', status: 'cancelled' }),
    mk({ agent: 'old', startedAt: now - 10 * 3600_000, endedAt: now - 9 * 3600_000 }), // outside a 1h window
  ];
  const s = summarize(runs, { now, sinceMs: 3600_000, buckets: 12 });
  assert.equal(s.total.runs, 5);
  assert.equal(s.total.finished, 2); assert.equal(s.total.failed, 1); assert.equal(s.total.running, 1); assert.equal(s.total.cancelled, 1);
  assert.equal(s.total.rateLimited, 1); assert.equal(s.total.rescued, 1);
  assert.equal(s.total.tokensIn, 105); assert.equal(s.total.tokensOut, 25); assert.equal(s.total.cost, 0.01);
  assert.ok(Math.abs(s.total.successRate - 2 / 3) < 1e-9, 'success = finished / (finished + failed), running and cancelled excluded');
  assert.equal(s.byAgent.claude.medianMs, 2000); assert.equal(s.byAgent.claude.p95Ms, 3000);
  assert.equal(s.byAgent.codex.cost, null, 'no cost is invented for agents that do not report it');
  assert.ok(!s.byAgent.old, 'runs outside the window are excluded');
  assert.deepEqual(s.topTools, [{ name: 'Read', count: 2 }]);
  assert.equal(s.timeline.length, 12); assert.equal(s.timeline.reduce((n, b) => n + b.ok + b.failed, 0), 3);
  assert.equal(summarize([], { now }).total.successRate, null, 'empty window: no division by zero');
});

test('tracker records origin and fallback, and stats() exposes them', () => {
  seed('claude', { model: 'haiku', origin: 'proxy', usage: [10, 2], tools: ['Read'], fallback: { used: 'codex', attempts: [{ agent: 'claude', code: 'RATE_LIMITED', message: 'x' }] } });
  seed('codex', { model: 'm', error: { code: 'TIMEOUT', msg: 'timed out' } });
  const s = stats({ persist: false, runLimit: 50 });
  const rescued = s.runs.find((r) => r.fallback);
  assert.equal(rescued.origin, 'proxy'); assert.equal(rescued.fallback.used, 'codex'); assert.equal(rescued.fallback.attempts[0].code, 'RATE_LIMITED');
  assert.ok(s.runs.some((r) => r.status === 'timeout' && /TIMEOUT/.test(r.error)));
});

test('HTTP surface: page, assets, stats and run detail', async () => {
  const rec = seed('claude', { model: 'haiku', usage: [30, 4], cost: 0.002, tools: ['Read', 'Read'], out: 'hello world', prompt: 'say hello' });
  const ui = await startUi({ port: 0 });
  try {
    const page = await get(ui.port, '/');
    assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.match(page.body, /<title>agentbridge<\/title>/);
    for (const a of ['/app.js', '/app.css', '/favicon.svg']) assert.equal((await get(ui.port, a)).status, 200, a);
    const st = await get(ui.port, '/api/stats?since=3600000');
    assert.equal(st.status, 200);
    const j = JSON.parse(st.body);
    assert.ok(j.summary.total.runs >= 1 && j.summary.byAgent.claude.tokensIn >= 30);
    const d = JSON.parse((await get(ui.port, `/api/run/${rec.id}`)).body);
    assert.equal(d.promptHead, 'say hello'); assert.equal(d.textTail, 'hello world'); assert.equal(d.tools.byName.Read, 2);
    assert.equal((await get(ui.port, '/api/run/does-not-exist')).status, 404);
    assert.equal((await get(ui.port, '/nope')).status, 404);
  } finally { await ui.close(); }
});

test('hardening: read-only, loopback only, Host check against DNS rebinding, strict CSP, optional token, no path traversal', async () => {
  await assert.rejects(startUi({ port: 0, host: '0.0.0.0' }), /non-loopback/);
  const ui = await startUi({ port: 0 });
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await get(ui.port, '/api/stats', { method })).status, 405, method);
    assert.equal((await get(ui.port, '/api/stats', { host: 'evil.example.com' })).status, 403, 'rebinding host');
    assert.equal((await get(ui.port, '/api/stats', { host: `localhost:${ui.port + 1}` })).status, 403, 'wrong port');
    assert.equal((await get(ui.port, '/api/stats', { host: `localhost:${ui.port}` })).status, 200);
    const page = await get(ui.port, '/');
    assert.match(page.headers['content-security-policy'], /default-src 'none'/); assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/package.json', '/app.js/../../package.json']) assert.notEqual((await get(ui.port, p)).status, 200, p);
    assert.doesNotMatch((await get(ui.port, '/../package.json')).body, /"name"/);
  } finally { await ui.close(); }
  const t = await startUi({ port: 0, token: 's3cret' });
  try {
    assert.equal((await get(t.port, '/api/stats')).status, 401);
    assert.equal((await get(t.port, '/api/stats', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await get(t.port, '/api/stats', { headers: { authorization: 'Bearer s3cret' } })).status, 200);
    assert.equal((await get(t.port, '/')).status, 200, 'the static shell carries no data');
  } finally { await t.close(); }
});

test('front-end never writes data into the DOM as HTML (prompts and outputs are untrusted)', () => {
  const js = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /\.innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8'), /<script>[\s\S]*?\S[\s\S]*?<\/script>|\son\w+=/, 'no inline scripts or handlers (CSP)');
});

test('CLI `ab ui` serves the dashboard and stops on SIGTERM', async () => {
  const { spawn } = await import('node:child_process');
  const p = spawn(process.execPath, [MAIN, 'ui', '--port', '0'], { env: { ...process.env, AGENTBRIDGE_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; const url = await new Promise((ok, bad) => { p.stderr.on('data', (d) => { err += d; const m = /(http:\/\/127\.0\.0\.1:\d+)/.exec(err); if (m) ok(m[1]); }); p.on('exit', () => bad(new Error('exited: ' + err))); setTimeout(() => bad(new Error('timeout: ' + err)), 15000); });
  try { const r = await fetch(url + '/api/stats'); assert.equal(r.status, 200); assert.ok((await r.json()).summary); } finally { p.kill(); }
});

// ---- live: a REAL claude run via the same wrapper the CLI/proxy use must appear on the dashboard
const haveClaude = !!resolveBinary('claude');
test('a real claude run made through runTracked shows up in the dashboard API', { skip: haveClaude ? false : 'claude is not installed', timeout: 180000 }, async () => {
  const it = runTracked('claude', { prompt: 'Reply with exactly: PONG', model: 'haiku', timeoutMs: 150000 }, { origin: 'proxy' });
  let x; while (!(x = await it.next()).done);
  const ui = await startUi({ port: 0 });
  try {
    const j = JSON.parse((await get(ui.port, '/api/stats?since=3600000')).body);
    const r = j.runs.find((q) => q.agent === 'claude' && q.origin === 'proxy' && q.status === 'finished');
    assert.ok(r, 'the run is listed'); assert.ok(r.usage.input > 0 && r.usage.output > 0, JSON.stringify(r.usage)); assert.equal(typeof r.cost, 'number', 'claude reports cost');
    assert.match(JSON.parse((await get(ui.port, `/api/run/${r.id}`)).body).textTail, /PONG/);
  } finally { await ui.close(); }
});
