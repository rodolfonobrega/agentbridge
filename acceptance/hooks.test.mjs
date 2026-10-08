import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(tmpdir(), 'ab-hk-'));
process.env.AGENTBRIDGE_HOME = HOME;
const { askWithTelemetry, wait, waitAll } = await import('../dist/index.js');
const H = await import('../dist/telemetry/hooks.js');
const cwd = mkdtempSync(path.join(tmpdir(), 'ab-hk-cwd-'));
const N = process.execPath;
const summary = { runId: 'r1', agent: 'claude', sessionId: 's1', status: 'finished', event: 'finish' };
const server = () => new Promise((res) => { const got = []; const s = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => { got.push(JSON.parse(b)); r.end('ok'); }); }); s.listen(0, '127.0.0.1', () => res({ s, got, url: `http://127.0.0.1:${s.address().port}/hook` })); });

// ---------- pure + failure-mode unit tests ----------
test('normalizeHooks accepts the four kinds, drops invalid, rejects unknown events', () => {
  const { hooks, problems } = H.normalizeHooks({ finish: [() => {}, { command: 'x' }, { file: '/d' }, { http: 'http://127.0.0.1:1' }, { nonsense: 1 }], bogus: [() => {}] });
  assert.equal(hooks.finish.length, 4); assert.equal(problems.length, 2);
});

test('summaryOf carries the run summary fields', () => {
  const s = H.summaryOf({ id: 'a', agent: 'codex', state: 'done', startedAt: 1, endedAt: 1001, tools: { total: 3 }, usage: { input: 1, output: 2 }, cost: null, textTail: 'hello', pid: process.pid }, 'finish');
  assert.equal(s.status, 'finished'); assert.equal(s.elapsedMs, 1000); assert.equal(s.toolCalls, 3); assert.equal(s.resultPreview, 'hello');
});

test('fire: all four kinds deliver; command gets JSON on stdin + env', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-hk-out-')), srv = await server(); let cb = null;
  const out = path.join(d, 'cmd.json');
  const r = await H.fire('finish', summary, { finish: [
    (s) => { cb = s; },
    { command: N, args: ['-e', `let b='';process.stdin.on('data',c=>b+=c).on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify({b:JSON.parse(b),ev:process.env.AB_EVENT,id:process.env.AB_RUN_ID})))`] },
    { file: path.join(d, 'drop') }, { http: srv.url } ] });
  srv.s.close();
  assert.deepEqual(r.map((x) => x.ok), [true, true, true, true], JSON.stringify(r));
  assert.equal(cb.runId, 'r1');
  const c = JSON.parse(readFileSync(out, 'utf8')); assert.equal(c.b.sessionId, 's1'); assert.equal(c.ev, 'finish'); assert.equal(c.id, 'r1');
  assert.ok(existsSync(path.join(d, 'drop', 'r1.finish.json')));
  assert.equal(srv.got[0].runId, 'r1');
});

test('fire never hangs or throws: hanging fn, hanging command (killed), throwing fn, dead/non-loopback webhook', async () => {
  const t0 = Date.now(); const pidFile = path.join(mkdtempSync(path.join(tmpdir(), 'ab-hk-p-')), 'pid');
  const r = await H.fire('error', summary, { error: [
    () => new Promise(() => {}),                                               // never resolves
    () => { throw new Error('boom'); },
    { command: N, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`], timeoutMs: 800 },
    { command: 'definitely-not-a-binary-xyz' },
    { http: 'http://127.0.0.1:1/x', timeoutMs: 800 },                            // connection refused
    { http: 'http://example.com/x' },                                           // not loopback: refused before any network
  ] }, { timeoutMs: 1000 });
  assert.ok(Date.now() - t0 < 6000, `bounded: ${Date.now() - t0}ms`);
  assert.equal(r.length, 6); assert.ok(r.every((x) => x.ok === false), JSON.stringify(r));
  assert.match(r[0].error, /timed out/); assert.equal(r[1].error, 'boom'); assert.match(r[5].error, /loopback/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((res) => setTimeout(res, 500));
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'timed-out command hook process was killed (no leak)');
});

test('wait(): resolves on terminal record, times out with waitTimedOut, notFound, works by sessionId', async () => {
  const dir = path.join(HOME, 'telemetry', 'runs'); mkdirSync(dir, { recursive: true });
  const rec = (id, o) => writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, agent: 'claude', sessionId: `sess-${id}`, pid: process.pid, startedAt: Date.now(), lastEventAt: Date.now(), tools: { total: 0 }, ...o }));
  rec('w1', { state: 'running' }); rec('w2', { state: 'running' });
  const p = wait('w1', { pollMs: 50, timeoutMs: 5000 }); const q = wait('sess-w2', { pollMs: 50, timeoutMs: 5000 });
  setTimeout(() => { rec('w1', { state: 'done', endedAt: Date.now() }); rec('w2', { state: 'error', error: 'AGENT_FAILED: x', endedAt: Date.now() }); }, 300);
  const [a, b] = await Promise.all([p, q]);
  assert.equal(a.event, 'finish'); assert.equal(b.event, 'error'); assert.equal(b.runId, 'w2');
  rec('w3', { state: 'running' });
  const t = await wait('w3', { pollMs: 50, timeoutMs: 400 }); assert.equal(t.waitTimedOut, true); assert.equal(t.runId, 'w3');
  assert.equal((await wait('missing-id', { pollMs: 50, timeoutMs: 500 })).notFound, true);
  assert.equal((await waitAll(['w1', 'w2'], { pollMs: 50 })).length, 2);
});

// ---------- REAL runs ----------
test('real claude run: start + finish hooks (fn, command, file, http) with run summary; wait() sees it', { timeout: 280000 }, async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-hk-real-')), srv = await server(); const got = [];
  const r = await askWithTelemetry('claude', { prompt: 'Reply with exactly: HOOKED', cwd, timeoutMs: 200000 }, { hooks: {
    start: [(s) => got.push(['fn', s.event])],
    finish: [(s) => got.push(['fn', s.event, s]), { file: d }, { http: srv.url }, { command: N, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(d, 'cmd.txt'))},process.env.AB_EVENT+':'+process.env.AB_STATUS)`] }, () => { throw new Error('bad hook must not break the run'); }],
  } });
  srv.s.close();
  assert.match(r.text, /HOOKED/);
  assert.deepEqual(got[0], ['fn', 'start']);
  const fin = got.find((g) => g[1] === 'finish')[2];
  assert.equal(fin.agent, 'claude'); assert.equal(fin.status, 'finished'); assert.equal(fin.sessionId, r.sessionId); assert.match(fin.resultPreview, /HOOKED/); assert.ok(fin.usage.input > 0); assert.ok(fin.elapsedMs > 0);
  assert.ok(existsSync(path.join(d, `${r.telemetry.runId}.finish.json`)));
  assert.equal(readFileSync(path.join(d, 'cmd.txt'), 'utf8'), 'finish:finished');
  assert.equal(srv.got.length, 1); assert.equal(srv.got[0].runId, r.telemetry.runId);
  assert.equal(r.telemetry.hooks.filter((x) => !x.ok).length, 1, 'only the throwing hook failed');
  const w = await wait(r.telemetry.runId, { timeoutMs: 2000 }); assert.equal(w.event, 'finish'); assert.equal(w.runId, r.telemetry.runId);
});

test('real error + timeout hooks (2 concurrent runs)', { timeout: 280000 }, async () => {
  const ev = [];
  const hooks = { error: [(s) => ev.push(['error', s])], timeout: [(s) => ev.push(['timeout', s])] };
  const slow = askWithTelemetry('claude', { prompt: 'Write a 2000 word essay about the history of lighthouses.', cwd, timeoutMs: 2500 }, { hooks });
  const bad = askWithTelemetry('codex', { prompt: 'hi', cwd, model: 'definitely-not-a-real-model-zzz', timeoutMs: 120000 }, { hooks });
  const [a, b] = await Promise.allSettled([slow, bad]);
  const kinds = ev.map((e) => e[0]);
  assert.ok(kinds.includes('timeout'), `timeout hook fired; got ${kinds} / slow=${a.status}:${a.reason?.code || a.value?.timedOut}`);
  assert.ok(kinds.includes('error'), `error hook fired; got ${kinds} / bad=${b.status}`);
  assert.equal(ev.find((e) => e[0] === 'timeout')[1].status, 'timeout');
  assert.ok(ev.find((e) => e[0] === 'error')[1].error);
});
