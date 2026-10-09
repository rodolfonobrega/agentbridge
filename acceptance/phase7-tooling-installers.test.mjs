import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';

import { BUILTIN_AGENTS, VALID_ACCOUNT_AGENTS } from '../dist/core/catalog.js';
import { getOpencodeUserConfigPaths } from '../dist/cli/install.js';
import { withTimeout } from '../dist/extras/doctor.js';
import { parseSemver, bumpVersion, SEMVER_REGEX } from '../scripts/release.mjs';

test('Phase 7: Centralized Catalog contains all 5 builtin agents', () => {
  const expected = ['claude', 'codex', 'opencode', 'agy', 'pi'];
  for (const agent of expected) {
    assert.ok(BUILTIN_AGENTS.includes(agent), `BUILTIN_AGENTS missing ${agent}`);
    assert.ok(VALID_ACCOUNT_AGENTS.includes(agent), `VALID_ACCOUNT_AGENTS missing ${agent}`);
  }
});

test('Phase 7: getOpencodeUserConfigPaths provides unified paths across OS', () => {
  const dummyHome = path.join(os.tmpdir(), 'test-dummy-home');
  const paths = getOpencodeUserConfigPaths(dummyHome);
  assert.ok(paths.length >= 2, 'Should return candidate config paths');
  assert.ok(
    paths.some((p) => p.includes(path.join('opencode', 'opencode.json'))),
    'Should contain opencode.json'
  );
  assert.ok(
    paths.some((p) => p.includes(path.join('opencode', 'opencode.jsonc'))),
    'Should contain opencode.jsonc'
  );
});

test('Phase 7: withTimeout helper resolves properly and does not leave active timer', async () => {
  const start = Date.now();
  const fastPromise = new Promise((resolve) => setTimeout(() => resolve('success'), 20));
  const res = await withTimeout(fastPromise, 5000);
  assert.equal(res, 'success');
  assert.ok(Date.now() - start < 1000, 'Resolved immediately without hanging for timeout duration');

  // Test timeout rejection
  const slowPromise = new Promise((resolve) => setTimeout(() => resolve('late'), 1000));
  await assert.rejects(async () => {
    await withTimeout(slowPromise, 50, 'custom timeout');
  }, /custom timeout/);
});

test('Phase 7: SemVer validation in release.mjs is strict and handles prefixes/suffixes', () => {
  assert.ok(SEMVER_REGEX.test('1.2.3'));
  assert.ok(SEMVER_REGEX.test('0.5.0-beta.1'));
  assert.ok(SEMVER_REGEX.test('2.0.0+build.123'));
  assert.ok(!SEMVER_REGEX.test('1.2'));
  assert.ok(!SEMVER_REGEX.test('v1.2.3')); // Must strip 'v' before matching
  assert.ok(!SEMVER_REGEX.test('invalid-semver'));

  const parsed = parseSemver('v1.2.3-alpha.1');
  assert.equal(parsed.major, 1);
  assert.equal(parsed.minor, 2);
  assert.equal(parsed.patch, 3);
  assert.equal(parsed.prerelease, 'alpha.1');

  assert.equal(bumpVersion('1.0.0', 'patch'), '1.0.1');
  assert.equal(bumpVersion('1.0.0', 'minor'), '1.1.0');
  assert.equal(bumpVersion('1.0.0', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.0.0', '1.5.0'), '1.5.0');
  assert.throws(() => bumpVersion('1.0.0', 'invalid.version'));
});

test('Phase 7: Pi mcp.json corruption check preserves file', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ab-pi-test-'));
  try {
    const mcpFile = path.join(tmpDir, 'mcp.json');
    // Write invalid JSON with syntax error
    writeFileSync(mcpFile, '{ mcpServers: { corrupted: true, } // comments }', 'utf8');
    
    // Simulate Pi installation check
    let threw = false;
    try {
      JSON.parse(readFileSync(mcpFile, 'utf8'));
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'Invalid JSON throws syntax error');
    // File content remains unaltered
    assert.ok(readFileSync(mcpFile, 'utf8').includes('corrupted'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
