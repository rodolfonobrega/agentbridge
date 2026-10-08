import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(tmpdir(), 'ab-tel-'));
process.env.AGENTBRIDGE_HOME = HOME;
const { stats, contextOf, runWithTelemetry, askWithTelemetry, setContextWindow } = await import('../dist/index.js');
const S = await import('../dist/telemetry/stats.js');
const windowFor = S.windowFor;

// ---------- pure logic ----------
test('estimateTokens is chars/4', () => { assert.equal(S.estimateTokens('abcdefgh'), 2); assert.equal(S.estimateTokens(''), 0); });

test('windowFor: table, model regex, call-level override beats table', () => {
  assert.equal(windowFor('claude', 'claude-opus-4').tokens, 200000);
  assert.equal(windowFor('claude', 'opus[1m]').tokens, 1000000);
  assert.equal(windowFor('codex', 'gpt-5.5').tokens, 258400);
  assert.deepEqual(windowFor('claude', 'claude-opus-4', { claude: { opus: 500000 } }), { tokens: 500000, source: 'override' });
  assert.equal(windowFor('claude', 'sonnet', { claude: { '*': 300000 } }).tokens, 300000);
  assert.equal(windowFor('opencode', 'weird/model').source, 'table');
});

test('setContextWindow persists to <home>/telemetry/config.json', () => {
  setContextWindow('opencode', 'my-model', 64000);
  assert.equal(JSON.parse(readFileSync(path.join(HOME, 'telemetry', 'config.json'), 'utf8')).windows.opencode['my-model'], 64000);
  assert.throws(() => setContextWindow('opencode', 'x', -1));
});

test('runStatus / sessionStatus: active, idle, finished, lost', () => {
  const now = 100000, base = { state: 'running', pid: process.pid, lastEventAt: now - 1000 };
  assert.equal(S.runStatus(base, { now }), 'active');
  assert.equal(S.runStatus({ ...base, lastEventAt: now - 60000 }, { now, idleMs: 30000 }), 'idle');
  assert.equal(S.runStatus({ ...base, pid: 999999 }, { now, isAlive: () => false }), 'lost');
  assert.equal(S.runStatus({ state: 'done' }), 'finished');
  assert.equal(S.runStatus({ state: 'timeout' }), 'timeout');
  assert.equal(S.sessionStatus(['finished', 'idle']), 'idle');
  assert.equal(S.sessionStatus(['idle', 'active']), 'active');
  assert.equal(S.sessionStatus(['finished', 'error']), 'finished');
});

test('readSessionContext reads claude + codex session files (fixtures), incl. compact summary', () => {
  const h = mkdtempSync(path.join(tmpdir(), 'ab-fx-'));
  const cd = path.join(h, '.claude', 'projects', 'proj'); mkdirSync(cd, { recursive: true });
  const asst = { type: 'assistant', message: { model: 'claude-x', usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 7 } } };
  writeFileSync(path.join(cd, 'sidc.jsonl'), [JSON.stringify(asst), '{"type":"attachment"}'].join('\n'));
  assert.deepEqual(S.readSessionContext('claude', 'sidc', { homeDir: h }) && { t: S.readSessionContext('claude', 'sidc', { homeDir: h }).tokens, e: S.readSessionContext('claude', 'sidc', { homeDir: h }).exact }, { t: 1010, e: true });
  writeFileSync(path.join(cd, 'sidd.jsonl'), [JSON.stringify(asst), JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'x'.repeat(400) } })].join('\n'));
  const cs = S.readSessionContext('claude', 'sidd', { homeDir: h });
  assert.equal(cs.tokens, 100); assert.equal(cs.exact, false);
  const xd = path.join(h, '.codex', 'sessions', '2026', '01', '01'); mkdirSync(xd, { recursive: true });
  writeFileSync(path.join(xd, 'rollout-2026-01-01T00-00-00-sidx.jsonl'), JSON.stringify({ payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5000, output_tokens: 20 }, model_context_window: 258400 } } }) + '\n');
  const x = S.readSessionContext('codex', 'sidx', { homeDir: h });
  assert.equal(x.tokens, 5020); assert.equal(x.window, 258400); assert.equal(x.exact, true);
  assert.equal(S.readSessionContext('codex', 'nope', { homeDir: h }), null);
});

test('stats() on empty home is well-formed and persisted', () => {
  const s = stats({});
  assert.equal(s.global.contextTokens, 0); assert.equal(s.global.allExact, true); assert.ok(existsSync(path.join(HOME, 'telemetry', 'stats.json')));
});

// ---------- REAL runs (max 2 concurrent) ----------
const fx = mkdtempSync(path.join(tmpdir(), 'ab-tel-cwd-'));
writeFileSync(path.join(fx, 'note.txt'), 'The lighthouse keeper is called Ottoline.');

test('real claude + codex concurrently: per-run stats, exact context, global total, persisted', { timeout: 280000 }, async () => {
  const seen = [];
  const claudeRun = (async () => {
    const it = runWithTelemetry('claude', { prompt: 'Use the Read tool to read note.txt in the current directory, then reply with just the keeper name.', cwd: fx, timeoutMs: 200000 });
    let midStatus = null, r;
    for (;;) {
      const { value, done } = await it.next();
      if (done) { r = value; break; }
      if (value.type === 'session' && !midStatus) { const s = stats({ persist: false }); midStatus = s.runs.find((x) => x.sessionId === value.id)?.status; }
    }
    seen.push(midStatus); return r;
  })();
  const codexRun = askWithTelemetry('codex', { prompt: 'Reply with exactly: PONG', cwd: fx, timeoutMs: 200000 });
  const [c, x] = await Promise.all([claudeRun, codexRun]);
  assert.match(c.text, /Ottoline/i);
  assert.ok(['active', 'idle'].includes(seen[0]), `mid-run status was ${seen[0]}`);

  const s = stats({});
  const cr = s.runs.find((r) => r.id === c.telemetry.runId), xr = s.runs.find((r) => r.id === x.telemetry.runId);
  assert.equal(cr.status, 'finished'); assert.equal(xr.status, 'finished');
  assert.ok(cr.toolCalls >= 1, 'claude used the Read tool: counted');
  assert.ok(cr.elapsedMs > 0 && cr.cost > 0, 'claude reports cost');
  assert.equal(xr.cost, null, 'codex reports no cost -> null, not invented');
  const cc = contextOf(c.sessionId, { agent: 'claude' }), xc = contextOf(x.sessionId, { agent: 'codex' });
  assert.ok(cc.tokens > 0 && cc.exact && cc.source === 'claude-session-file', JSON.stringify(cc));
  assert.ok(xc.tokens > 0 && xc.exact && xc.source === 'codex-session-file' && xc.window > 100000, JSON.stringify(xc));
  assert.ok(cc.pct > 0 && cc.pct < 1);
  // global total = sum of the parts, agents split
  assert.equal(s.global.contextTokens, cc.tokens + xc.tokens);
  assert.ok(s.agents.claude.contextTokens > 0 && s.agents.codex.contextTokens > 0);
  assert.equal(s.global.allExact, true);
  assert.equal(s.sessions.find((z) => z.sessionId === c.sessionId).status, 'finished');
  // persisted for later processes
  const disk = JSON.parse(readFileSync(path.join(HOME, 'telemetry', 'stats.json'), 'utf8'));
  assert.equal(disk.global.contextTokens, s.global.contextTokens);
  assert.ok(existsSync(path.join(HOME, 'telemetry', 'sessions')) && existsSync(path.join(HOME, 'telemetry', 'runs')));
  // continue: context grows
  const c2 = await askWithTelemetry('claude', { prompt: 'Repeat the keeper name once more.', cwd: fx, session: { mode: 'continue', id: c.sessionId } });
  const cc2 = contextOf(c.sessionId, { agent: 'claude' });
  assert.ok(cc2.tokens >= cc.tokens, `context did not shrink on continue: ${cc.tokens} -> ${cc2.tokens}`);
  assert.equal(stats({}).sessions.find((z) => z.sessionId === c.sessionId).runs, 2);
  assert.ok(c2.text.length > 0);
});

test('multi-process: 8 processes finishing runs of ONE session lose no updates', { timeout: 120000 }, async () => {
  const { spawn } = await import('node:child_process');
  const statsUrl = new URL('../dist/telemetry/stats.js', import.meta.url).href;
  const code = `const S=await import(${JSON.stringify(statsUrl)});const t=S.createTracker({agent:'claude',opts:{prompt:'x'}});t.onEvent({type:'tool',name:'Read',input:{file_path:'/f'+process.pid}});t.finish({result:{sessionId:'RACE-S',model:'m',usage:{input:1,output:1}}});`;
  await Promise.all(Array.from({ length: 8 }, () => new Promise((res, rej) => { const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: 'inherit' }); p.on('exit', (c) => (c === 0 ? res() : rej(new Error('child exit ' + c)))); })));
  const s = S.listSessions().find((x) => x.sessionId === 'RACE-S');
  assert.equal(s.runCount, 8); assert.equal(s.runIds.length, 8); assert.equal(s.toolCalls, 8); assert.equal(s.files.length, 8);
});

test('stats: global has no summed-window pct; maxPct + per-agent pct instead', () => {
  const s = stats({ persist: false });
  assert.equal('pct' in s.global, false); assert.ok('maxPct' in s.global);
});

test('real opencode run: exact context via `opencode export`, model resolved, stats row', { timeout: 200000 }, async () => {
  let r; for (let i = 0; i < 2 && !r; i++) { try { r = await askWithTelemetry('opencode', { prompt: 'Reply with exactly: PING', cwd: fx, timeoutMs: 120000 }); } catch (e) { if (i) throw e; } }
  const c = contextOf(r.sessionId, { agent: 'opencode' });
  assert.ok(c.tokens > 0 && c.exact && c.source === 'opencode-export', JSON.stringify(c));
  const row = stats({}).sessions.find((z) => z.sessionId === r.sessionId);
  assert.equal(row.agent, 'opencode'); assert.ok(row.window > 0);
});

test('codex model resolved from session file (adapter says "default")', { timeout: 200000 }, async () => {
  const r = await askWithTelemetry('codex', { prompt: 'Reply with exactly: OK', cwd: fx, timeoutMs: 150000 });
  const c = contextOf(r.sessionId, { agent: 'codex' });
  assert.ok(c.model && c.model !== 'default', `model=${c.model}`);
});
