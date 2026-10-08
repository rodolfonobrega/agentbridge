import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeUsageResponse, parseCodexUsageResponse } from '../dist/telemetry/quota.js';
import { createPool } from '../dist/server/pool.js';

test('parseClaudeUsageResponse maps 5h and 7d windows correctly', () => {
  const mock = {
    five_hour: { used_percentage: 42, resets_at: '2026-10-08T04:00:00Z' },
    seven_day: { used_percentage: 15, resets_at: '2026-10-15T00:00:00Z' }
  };
  const parsed = parseClaudeUsageResponse(mock);
  assert.equal(parsed.provider, 'claude');
  assert.equal(parsed.sessionWindow?.usedPercent, 42);
  assert.equal(parsed.weeklyWindow?.usedPercent, 15);
  assert.ok(parsed.sessionWindow?.resetsAt && parsed.sessionWindow.resetsAt > 0);
  assert.equal(parsed.isThrottled, false);
});

test('parseClaudeUsageResponse marks throttled when session >= 95%', () => {
  const mock = {
    five_hour: { used_percentage: 96, resets_at: '2026-10-08T04:00:00Z' },
    seven_day: { used_percentage: 30, resets_at: '2026-10-15T00:00:00Z' }
  };
  const parsed = parseClaudeUsageResponse(mock);
  assert.equal(parsed.isThrottled, true);
});

test('parseCodexUsageResponse maps windows and detects throttling', () => {
  const mock = {
    primary_window: { used_percent: 98, limit_window_seconds: 18000, reset_at: Date.now() + 3600000 },
    secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: Date.now() + 86400000 }
  };
  const parsed = parseCodexUsageResponse(mock);
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.sessionWindow?.usedPercent, 98);
  assert.equal(parsed.isThrottled, true);
});

test('account pool skips accounts with proactive quota exhaustion', () => {
  const pool = createPool({
    claude: [
      { name: 'acc1', env: { ANTHROPIC_API_KEY: 'k1' } },
      { name: 'acc2', env: { ANTHROPIC_API_KEY: 'k2' } }
    ]
  });

  // Acc1 is 98% exhausted with reset in 10 minutes
  const resetsAt = Date.now() + 600000;
  pool.updateQuota('claude', 'acc1', { sessionPercent: 98, resetsAt, isThrottled: true });

  // Pool pick should choose acc2, skipping acc1 proactively!
  const picked = pool.pick('claude');
  assert.equal(picked?.name, 'acc2');

  const st = pool.status();
  assert.equal(st.agents.claude[0].available, false);
  assert.equal(st.agents.claude[0].kind, 'quota');
  assert.equal(st.agents.claude[1].available, true);
});
