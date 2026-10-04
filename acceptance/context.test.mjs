import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(tmpdir(), 'ab-ctx-'));
process.env.AGENTBRIDGE_HOME = HOME;
const { runWithTelemetry, askWithTelemetry, contextOf, setPolicy, getPolicy, handoff, compact, AgentError } = await import('../src/index.mjs');
const C = await import('../src/telemetry/context.mjs');
const cwd = mkdtempSync(path.join(tmpdir(), 'ab-ctx-cwd-'));
const collect = async (it) => { const ev = []; for (;;) { const { value, done } = await it.next(); if (done) return { ev, result: value }; ev.push(value); } };

// ---------- pure logic ----------
test('evaluate: fractions and absolute tokens, level ordering', () => {
  const lim = { warn: 0.5, compact: 0.8, hard: 0.95 };
  assert.equal(C.evaluate({ tokens: 40000, window: 100000 }, lim).level, 'ok');
  assert.equal(C.evaluate({ tokens: 50000, window: 100000 }, lim).level, 'warn');
  assert.equal(C.evaluate({ tokens: 85000, window: 100000 }, lim).level, 'compact');
  assert.equal(C.evaluate({ tokens: 96000, window: 100000 }, lim).level, 'hard');
  const abs = C.evaluate({ tokens: 1500, window: 100000 }, { warn: 1000, hard: 2000 });
  assert.equal(abs.level, 'warn'); assert.deepEqual(abs.thresholds, { warn: 1000, compact: null, hard: 2000 });
  assert.equal(C.evaluate({ tokens: 9e9, window: 1 }, {}).level, 'ok');
  assert.ok(C.levelAtLeast('hard', 'compact') && !C.levelAtLeast('warn', 'compact'));
});

test('policy precedence default < agent < session < inline; validation; persisted', () => {
  setPolicy(null, { warn: 0.6 }); setPolicy({ agent: 'claude' }, { warn: 0.5, compact: 0.8 }); setPolicy({ session: 's1' }, { warn: 0.3 });
  assert.equal(getPolicy('codex', 's0').warn, 0.6);
  assert.equal(getPolicy('claude', 's0').warn, 0.5);
  assert.equal(getPolicy('claude', 's1').warn, 0.3);
  assert.equal(getPolicy('claude', 's1').compact, 0.8);
  assert.equal(getPolicy('claude', 's1', process.env, { warn: 0.1 }).warn, 0.1);
  assert.throws(() => setPolicy(null, { warn: 0 }), (e) => e.code === 'BAD_OPTION');
  assert.throws(() => setPolicy(null, { bogus: 1 }), (e) => e.code === 'BAD_OPTION');
  assert.throws(() => setPolicy(null, { warn: 0.9, compact: 0.5 }), (e) => e.code === 'BAD_OPTION');
  assert.equal(JSON.parse(readFileSync(path.join(HOME, 'telemetry', 'policy.json'), 'utf8')).agents.claude.compact, 0.8);
});

test('parseSections + buildHandoffDoc (merges model file list with telemetry file list; degraded fallback)', () => {
  const md = '## Summary\nBuilding X.\n## Key facts and decisions\n- code is 42\n## Key files\n- src/a.mjs\n## Open tasks\n- write tests';
  assert.equal(C.parseSections(md)['open tasks'], '- write tests');
  const d = C.buildHandoffDoc({ fromAgent: 'claude', fromSession: 's', toAgent: 'codex', cwd: '/w', summaryMd: md, files: ['/w/b.mjs', 'src/a.mjs'] });
  assert.match(d, /code is 42/); assert.match(d, /- \/w\/b\.mjs/); assert.equal((d.match(/src\/a\.mjs/g) || []).length, 1); assert.match(d, /- write tests/);
  const g = C.buildHandoffDoc({ fromAgent: 'claude', fromSession: 's', toAgent: 'codex', summaryMd: '', firstPrompt: 'do the thing', lastText: 'did half', degraded: true });
  assert.match(g, /DEGRADED/); assert.match(g, /do the thing/); assert.match(g, /did half/);
});

// ---------- REAL: handoff transfers a fact across agents ----------
const FACT = 'MARZIPAN-7731-QUOKKA';
test('handoff claude -> codex really transfers a fact (and leaves source untouched)', { timeout: 290000 }, async () => {
  const a = await askWithTelemetry('claude', { prompt: `We are building a tiny CLI. Decision: the release codename is ${FACT}. Remember it. Reply OK.`, cwd, timeoutMs: 200000 });
  const h = await handoff(a.sessionId, 'codex', { agent: 'claude', cwd });
  assert.equal(h.seeded, true); assert.ok(h.newSessionId && h.newSessionId !== a.sessionId);
  assert.equal(h.degraded, false);
  assert.match(h.doc, new RegExp(FACT)); assert.match(h.ack, /READY/i);
  const b = await askWithTelemetry('codex', { prompt: 'What is the release codename? Answer with only the codename.', cwd, session: { mode: 'continue', id: h.newSessionId }, timeoutMs: 200000 });
  assert.match(b.text, new RegExp(FACT), `codex answered: ${b.text}`);
  assert.equal(contextOf(h.newSessionId, { agent: 'codex' }).exact, true);
});

test('handoff codex -> claude really transfers a fact', { timeout: 290000 }, async () => {
  const F2 = 'TANGERINE-2209-WOMBAT';
  const a = await askWithTelemetry('codex', { prompt: `Project note: the internal service nickname is ${F2}. Remember it. Reply OK.`, cwd, timeoutMs: 200000 });
  const h = await handoff(a.sessionId, 'claude', { agent: 'codex', cwd });
  assert.equal(h.degraded, false, 'codex fork summary worked');
  const b = await askWithTelemetry('claude', { prompt: 'What is the internal service nickname? Answer with only the nickname.', cwd, session: { mode: 'continue', id: h.newSessionId }, timeoutMs: 200000 });
  assert.match(b.text, new RegExp(F2), `claude answered: ${b.text}`);
});

// ---------- REAL: native compact + policy ----------
test('claude native /compact keeps the session id and the fact; policy warn+autoCompact fire in the wrapper', { timeout: 290000 }, async () => {
  const F3 = 'GOOSEBERRY-5518-LYNX';
  setPolicy({ session: 'ignored' }, { warn: 0.5 });
  const { ev, result } = await collect(runWithTelemetry('claude', { prompt: `Remember: the vault code is ${F3}. Reply OK.`, cwd, timeoutMs: 200000 }, { policy: { warn: 100, compact: 200, autoCompact: true } }));
  const w = ev.find((e) => e.type === 'raw' && e.data?.abTelemetry === 'context-warning');
  assert.ok(w && w.data.level === 'compact', 'warning event emitted at compact level');
  const cp = ev.find((e) => e.type === 'raw' && e.data?.abTelemetry === 'context-compact');
  assert.ok(cp, `auto-compact event; telemetry=${JSON.stringify(result.telemetry)}`);
  assert.equal(result.telemetry.compaction.method, 'native');
  assert.equal(cp.data.sessionId, result.sessionId, 'native compact keeps the session id');
  const after = contextOf(result.sessionId, { agent: 'claude' });
  assert.equal(result.telemetry.compaction.after > 1000, true, `after=${result.telemetry.compaction.after}: measured incl. system prompt, not summary-only`);
  assert.equal(after.exact, true, 'follow-up call made the size exact'); assert.equal(after.source, 'claude-session-file');
  const b = await askWithTelemetry('claude', { prompt: 'What is the vault code? Answer with only the code.', cwd, session: { mode: 'continue', id: result.sessionId } }, { policy: { warn: null } });
  assert.match(b.text, new RegExp(F3));
  // hard limit now enforced on this known session, no agent call
  const it = runWithTelemetry('claude', { prompt: 'x', cwd, session: { mode: 'continue', id: result.sessionId } }, { policy: { hard: 10 } });
  await assert.rejects(it.next(), (e) => e instanceof AgentError && e.reason === 'CONTEXT_HARD_LIMIT');
});

test('compact() on codex uses summarize-new-session (no native mechanism) and keeps the fact', { timeout: 290000 }, async () => {
  const F4 = 'PERSIMMON-9046-HERON';
  const a = await askWithTelemetry('codex', { prompt: `Remember: the cache key prefix is ${F4}. Reply OK.`, cwd, timeoutMs: 200000 });
  await assert.rejects(compact(a.sessionId, { agent: 'codex', method: 'native' }), (e) => e.code === 'BAD_OPTION');
  const c = await compact(a.sessionId, { agent: 'codex', cwd });
  assert.equal(c.method, 'summarize-new-session'); assert.notEqual(c.sessionId, a.sessionId);
  const b = await askWithTelemetry('codex', { prompt: 'What is the cache key prefix? Answer with only it.', cwd, session: { mode: 'continue', id: c.sessionId } });
  assert.match(b.text, new RegExp(F4));
});

// ---------- REAL opencode (flaky CLI: bounded retry) ----------
const retry = async (fn, n = 2) => { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (x) { e = x; } } throw e; };
test('opencode: handoff opencode -> codex and summarize-compact keep a fact; context is exact via export', { timeout: 290000 }, async () => {
  const F5 = 'LARKSPUR-3384-OTTER';
  const a = await retry(() => askWithTelemetry('opencode', { prompt: `Remember: the build flavor is ${F5}. Reply OK.`, cwd, timeoutMs: 120000 }));
  const c = contextOf(a.sessionId, { agent: 'opencode' });
  assert.ok(c.tokens > 0 && c.exact && c.source === 'opencode-export', JSON.stringify(c));
  const h = await retry(() => handoff(a.sessionId, 'codex', { agent: 'opencode', cwd }));
  const b = await askWithTelemetry('codex', { prompt: 'What is the build flavor? Answer with only it.', cwd, session: { mode: 'continue', id: h.newSessionId }, timeoutMs: 200000 });
  assert.match(b.text, new RegExp(F5), `codex answered: ${b.text}`);
  const k = await retry(() => compact(a.sessionId, { agent: 'opencode', cwd }));
  assert.equal(k.method, 'summarize-new-session');
  const d = await retry(() => askWithTelemetry('opencode', { prompt: 'What is the build flavor? Answer with only it.', cwd, session: { mode: 'continue', id: k.sessionId }, timeoutMs: 120000 }));
  assert.match(d.text, new RegExp(F5));
});
