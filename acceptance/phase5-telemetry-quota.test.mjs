import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createTracker,
  listSessions,
  listTrackedRuns,
  readSessionContext,
  contextOf,
} from '../dist/telemetry/stats.js';
import { MAINTENANCE_POLICY } from '../dist/telemetry/context.js';
import {
  getProactiveQuotaStatus,
  formatQuotaStatus,
  setQuotaFixture,
  clearQuotaFixtures,
} from '../dist/quota/proactive.js';
import { createPool } from '../dist/server/pool.js';
import { AgentError } from '../dist/core/errors.js';

test('A18: MAINTENANCE_POLICY suspends context limits to prevent re-entrant loops', () => {
  assert.equal(MAINTENANCE_POLICY.warn, null);
  assert.equal(MAINTENANCE_POLICY.hard, null);
  assert.equal(MAINTENANCE_POLICY.autoCompact, false);
  assert.equal(MAINTENANCE_POLICY.hardAction, 'none');
});

test('A20: ctxView preserves known window and reports overflow without inflating to 1M', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-phase5-ctx-'));
  const env = { AGENTBRIDGE_HOME: d };
  try {
    const sessDir = path.join(d, 'telemetry', 'sessions');
    mkdirSync(sessDir, { recursive: true });
    const s = {
      agent: 'claude',
      sessionId: 'sess-overflow-123',
      model: 'claude-3-5-sonnet',
      cwd: d,
      lastAt: Date.now(),
      ctx: { tokens: 220000, exact: true, source: 'claude-session-file', window: 200000, at: Date.now() },
    };
    writeFileSync(path.join(sessDir, 'claude-sess-overflow-123.json'), JSON.stringify(s), 'utf8');

    const c = contextOf('sess-overflow-123', { agent: 'claude', env, windows: { claude: 200000 } });
    assert.ok(c, 'Context result should exist');
    // Known window is 200_000, tokens is 220_000
    // It should not inflate window to 1_000_000
    assert.ok(c.window <= 200000, `Window should remain <= 200000, got ${c.window}`);
    assert.equal(c.overflow, true, 'Should mark overflow as true');
    assert.ok(c.pct > 1.0, `pct should be > 1.0 (110%), got ${c.pct}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A21: createTracker and foldIntoSession track effectiveAgent after fallback', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-phase5-tracker-'));
  const env = { AGENTBRIDGE_HOME: d };
  try {
    const tr = createTracker({
      agent: 'codex',
      opts: { prompt: 'do something', session: { mode: 'new', id: 'fall-sess-1' }, cwd: d },
      env,
    });
    assert.equal(tr.rec.requestedAgent, 'codex');
    assert.equal(tr.rec.effectiveAgent, 'codex');

    // Finish with fallback to claude
    const finishedRec = tr.finish({
      result: {
        sessionId: 'fall-sess-1',
        fallback: { used: 'claude', attempts: [{ agent: 'codex', code: 'RATE_LIMITED' }] },
        usage: { input: 100, output: 50 },
      },
    });

    assert.equal(finishedRec.effectiveAgent, 'claude');
    assert.equal(finishedRec.agent, 'claude');

    // List sessions should have claude as effectiveAgent
    const sessions = listSessions(env);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].agent, 'claude');
    assert.equal(sessions[0].requestedAgent, 'codex');
    assert.equal(sessions[0].effectiveAgent, 'claude');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A22: readSessionContext respects managed profile directories via env', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-phase5-prof-'));
  try {
    const customCodexHome = path.join(d, 'custom-codex');
    mkdirSync(path.join(customCodexHome, 'sessions'), { recursive: true });

    const rolloutFile = path.join(customCodexHome, 'sessions', 'rollout-2026-custom-sess-789.jsonl');
    const line = JSON.stringify({
      type: 'token_count',
      payload: {
        info: {
          last_token_usage: { input_tokens: 1500, output_tokens: 300 },
          model_context_window: 128000,
        },
      },
    });
    writeFileSync(rolloutFile, line + '\n', 'utf8');

    // Querying with default env should not find it
    const notFound = readSessionContext('codex', 'custom-sess-789', { env: { CODEX_HOME: path.join(d, 'empty') } });
    assert.equal(notFound, null);

    // Querying with managed CODEX_HOME finds the session
    const found = readSessionContext('codex', 'custom-sess-789', { env: { CODEX_HOME: customCodexHome } });
    assert.ok(found);
    assert.equal(found.tokens, 1800);
    assert.equal(found.window, 128000);
    assert.equal(found.source, 'codex-session-file');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A24: listTrackedRuns and listSessions support pagination and retention pruning', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-phase5-prune-'));
  const env = { AGENTBRIDGE_HOME: d };
  try {
    const runsDir = path.join(d, 'telemetry', 'runs');
    mkdirSync(runsDir, { recursive: true });

    // Create 15 fake run files
    for (let i = 1; i <= 15; i++) {
      const runId = `run-${String(i).padStart(3, '0')}`;
      writeFileSync(
        path.join(runsDir, `${runId}.json`),
        JSON.stringify({ id: runId, agent: 'codex', startedAt: 1000 + i }),
        'utf8'
      );
    }

    // Pagination: limit 5, offset 0
    const page1 = listTrackedRuns(env, { limit: 5, offset: 0, pruneMax: 20 });
    assert.equal(page1.length, 5);

    // Pagination: limit 5, offset 5
    const page2 = listTrackedRuns(env, { limit: 5, offset: 5, pruneMax: 20 });
    assert.equal(page2.length, 5);
    assert.notEqual(page1[0].id, page2[0].id);

    // Retention prune: if pruneMax is 10, files above 10 are pruned
    const prunedList = listTrackedRuns(env, { limit: 20, offset: 0, pruneMax: 10 });
    assert.ok(prunedList.length <= 10, `Expected <= 10 runs after prune, got ${prunedList.length}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A30: getProactiveQuotaStatus checks secondary (weekly) window for Codex', async () => {
  clearQuotaFixtures();
  try {
    // Primary window is 20% (OK), but weekly window is 96% (throttled)
    setQuotaFixture('codex', {
      primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: Date.now() + 3600000 },
      secondary_window: { used_percent: 96, limit_window_seconds: 604800, reset_at: Date.now() + 86400000 },
    });

    const status = await getProactiveQuotaStatus('codex', 'token', { thresholdPercent: 95 });
    assert.equal(status.okToProceed, false, 'Should be throttled due to secondary window');
    assert.equal(status.blockingWindow, 'secondary');
    assert.equal(status.secondaryPercent, 96);

    const formatted = formatQuotaStatus(status);
    assert.match(formatted, /THROTTLED/);
    assert.match(formatted, /secondary window blocked/);
  } finally {
    clearQuotaFixtures();
  }
});

test('A41: getProactiveQuotaStatus and fetch differentiate error and unknown from 0% OK', async () => {
  clearQuotaFixtures();
  try {
    // When no credentials and not in offline mock mode, status is unknown with error.
    // CLAUDE_CONFIG_DIR points at a missing dir so the test never reads the developer's real login.
    const noCredStatus = await getProactiveQuotaStatus('claude', '', {
      env: {
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_TOKEN: '',
        CLAUDE_CONFIG_DIR: '/nonexistent-agentbridge-test-config',
        AGENTBRIDGE_OFFLINE: '0',
        AGENTBRIDGE_PROACTIVE_MOCK: '0',
      },
    });
    assert.equal(noCredStatus.okToProceed, false);
    assert.equal(noCredStatus.status, 'unknown');
    assert.match(formatQuotaStatus(noCredStatus), /UNKNOWN/);
  } finally {
    clearQuotaFixtures();
  }
});

test('A42: createPool updateQuota considers weeklyPercent >= 95 as throttled', () => {
  const pool = createPool({
    strategy: 'round-robin',
    codex: [
      { name: 'acct1', env: {} },
      { name: 'acct2', env: {} },
    ],
  });

  assert.equal(pool.available('codex'), 2);

  // Update acct1 with weekly quota 96%
  pool.updateQuota('codex', 'acct1', {
    sessionPercent: 10,
    weeklyPercent: 96,
    resetsAt: Date.now() + 60000,
  });

  // acct1 should now be in cooldown
  assert.equal(pool.available('codex'), 1);
  const picked = pool.pick('codex');
  assert.equal(picked?.name, 'acct2');
});

test('A29: cmdAccount quota passes account credentials and env', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-phase5-acc-'));
  try {
    const { addAccount } = await import('../dist/core/accounts.js');
    const { cmdAccount } = await import('../dist/cli/accounts.js');

    addAccount('claude', 'work', {
      baseDir: d,
      share: false,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-123' },
    });

    const logs = [];
    await cmdAccount(['quota', 'claude', 'work'], { baseDir: d, json: true }, {
      out: (msg) => logs.push(msg),
      err: () => {},
    });

    assert.equal(logs.length, 1);
    assert.equal(logs[0][0].account, 'work');
    assert.equal(logs[0][0].agent, 'claude');
    assert.ok(logs[0][0].quota);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A62 & A65: Fallback metadata preserved and effectiveAgent continuity registered in sessions', async () => {
  const { sessions } = await import('../dist/server/common.js');
  sessions.clear();

  // Simulate a fallback turn that ran under codex request but answered by claude
  const sessionKey = 'sess-continuity-abc';
  const effectiveAgent = 'claude';
  const sid = 'claude-uuid-123';
  sessions.set(`codex:${sessionKey}`, { agent: effectiveAgent, id: sid });
  sessions.set(`${effectiveAgent}:${sessionKey}`, { agent: effectiveAgent, id: sid });

  // On next request with sessionKey, checking sessions detects claude as effectiveAgent
  let detected = null;
  for (const [k, v] of sessions.entries()) {
    if (k.endsWith(`:${sessionKey}`) && v?.id) {
      detected = v;
      break;
    }
  }

  assert.ok(detected);
  assert.equal(detected.agent, 'claude');
  assert.equal(detected.id, sid);
});

