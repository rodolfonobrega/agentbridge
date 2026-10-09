import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAnthropicUsage,
  parseCodexUsage,
  fetchAnthropicUsage,
  fetchCodexUsage,
  getProactiveQuotaStatus,
  formatQuotaStatus,
  formatQuotaForPrompt,
  setQuotaFixture,
  clearQuotaFixtures,
  ANTHROPIC_OAUTH_USAGE_URL,
  CODEX_USAGE_URL,
} from '../dist/quota/proactive.js';

test('parseAnthropicUsage extracts 5h and 7d window usage and resets correctly', () => {
  const fixture = {
    five_hour: {
      used_percentage: 42.6,
      resets_at: '2026-10-09T18:00:00Z',
    },
    seven_day: {
      used_percentage: 15.2,
      resets_at: 1791650000,
    },
  };

  const parsed = parseAnthropicUsage(fixture);
  assert.equal(parsed.fiveHourPercent, 43);
  assert.equal(parsed.sevenDayPercent, 15);
  assert.equal(typeof parsed.fiveHourResetsAt, 'number');
  assert.equal(typeof parsed.sevenDayResetsAt, 'number');
  assert.equal(parsed.fiveHour?.usedPercent, 43);
  assert.equal(parsed.sevenDay?.usedPercent, 15);
});

test('parseCodexUsage extracts primary window %, window duration, and reset timestamp', () => {
  const fixture = {
    primary_window: {
      used_percent: 78.4,
      limit_window_seconds: 18000, // 300 minutes
      reset_at: 1791500000,
    },
    secondary_window: {
      used_percent: 32,
      limit_window_seconds: 604800,
      reset_at: 1792100000,
    },
  };

  const parsed = parseCodexUsage(fixture);
  assert.equal(parsed.primaryPercent, 78);
  assert.equal(parsed.secondaryPercent, 32);
  assert.equal(parsed.windowMinutes, 300);
  assert.equal(parsed.resetsAt, 1791500000000);
});

test('fetchAnthropicUsage sends oauth-2025-04-20 header and Authorization token', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};

  const mockFetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers || {};
    return {
      ok: true,
      json: async () => ({
        five_hour: { used_percentage: 25, resets_at: Date.now() + 3600000 },
        seven_day: { used_percentage: 10, resets_at: Date.now() + 86400000 },
      }),
    };
  };

  const usage = await fetchAnthropicUsage('test-anthropic-token', { fetchImpl: mockFetch });
  assert.equal(capturedUrl, ANTHROPIC_OAUTH_USAGE_URL);
  assert.equal(capturedHeaders['Authorization'], 'Bearer test-anthropic-token');
  assert.equal(capturedHeaders['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(usage.fiveHourPercent, 25);
  assert.equal(usage.sevenDayPercent, 10);
});

test('fetchCodexUsage sends Authorization token to ChatGPT backend endpoint', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};

  const mockFetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers || {};
    return {
      ok: true,
      json: async () => ({
        primary_window: { used_percent: 65, limit_window_seconds: 18000, reset_at: 1791500000 },
      }),
    };
  };

  const usage = await fetchCodexUsage('test-codex-token', { fetchImpl: mockFetch });
  assert.equal(capturedUrl, CODEX_USAGE_URL);
  assert.equal(capturedHeaders['Authorization'], 'Bearer test-codex-token');
  assert.equal(usage.primaryPercent, 65);
  assert.equal(usage.windowMinutes, 300);
});

test('fallback mock and fixture support when offline or in test mode', async () => {
  clearQuotaFixtures();

  // Test explicit fixture injection
  setQuotaFixture('claude', {
    five_hour: { used_percentage: 88, resets_at: 1791500000 },
    seven_day: { used_percentage: 20, resets_at: 1792000000 },
  });

  const claudeHealth = await getProactiveQuotaStatus('claude', 'any-token');
  assert.equal(claudeHealth.agent, 'claude');
  assert.equal(claudeHealth.usedPercent, 88);
  assert.equal(claudeHealth.windowMinutes, 300);
  assert.equal(claudeHealth.okToProceed, true); // < 95% threshold

  clearQuotaFixtures();
});

test('getProactiveQuotaStatus threshold checks detect approaching limits', async () => {
  clearQuotaFixtures();

  // 1. Normal usage: okToProceed is true
  setQuotaFixture('claude', {
    five_hour: { used_percentage: 40, resets_at: Date.now() + 3600000 },
    seven_day: { used_percentage: 15, resets_at: Date.now() + 86400000 },
  });
  const okStatus = await getProactiveQuotaStatus('claude');
  assert.equal(okStatus.usedPercent, 40);
  assert.equal(okStatus.okToProceed, true);

  // 2. High usage (>= 95%): okToProceed is false
  setQuotaFixture('claude', {
    five_hour: { used_percentage: 96, resets_at: Date.now() + 1800000 },
    seven_day: { used_percentage: 30, resets_at: Date.now() + 86400000 },
  });
  const throttledStatus = await getProactiveQuotaStatus('claude');
  assert.equal(throttledStatus.usedPercent, 96);
  assert.equal(throttledStatus.okToProceed, false);

  // 3. Custom threshold (e.g. 80%)
  setQuotaFixture('codex', {
    primary_window: { used_percent: 85, limit_window_seconds: 18000, reset_at: Date.now() + 3600000 },
  });
  const customThreshold = await getProactiveQuotaStatus('codex', 'token', { thresholdPercent: 80 });
  assert.equal(customThreshold.usedPercent, 85);
  assert.equal(customThreshold.okToProceed, false);

  clearQuotaFixtures();
});

test('formatQuotaStatus and formatQuotaForPrompt format human and prompt outputs', () => {
  const health = {
    agent: 'claude',
    usedPercent: 92,
    windowMinutes: 300,
    resetAt: 1791500000000,
    okToProceed: true,
  };

  const formatted = formatQuotaStatus(health);
  assert.ok(formatted.includes('[claude]'));
  assert.ok(formatted.includes('92% used'));
  assert.ok(formatted.includes('300m window'));
  assert.ok(formatted.includes('OK'));

  const promptBlock = formatQuotaForPrompt(health);
  assert.ok(promptBlock.includes('[PROACTIVE QUOTA - CLAUDE]'));
  assert.ok(promptBlock.includes('Used: 92%'));
  assert.ok(promptBlock.includes('Window: 300m'));
});
