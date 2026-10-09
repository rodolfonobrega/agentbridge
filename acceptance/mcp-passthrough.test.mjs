import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getPassthroughMcpServers } from '../dist/bridge/attach.js';

test('getPassthroughMcpServers: respects offline gate', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-pt-test-'));
  try {
    writeFileSync(
      path.join(d, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          rea: { command: 'node', args: ['rea.js'], exposure: 'deferred' },
        },
      })
    );
    // Offline: true should return empty even if passthrough requested
    const res = getPassthroughMcpServers({
      passthrough: 'rea',
      sourceDir: d,
      offline: true,
      permissions: 'full',
    });
    assert.deepEqual(res, {});
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('getPassthroughMcpServers: respects permission gate', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-pt-test-'));
  try {
    writeFileSync(
      path.join(d, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          rea: { command: 'node', args: ['rea.js'] },
        },
      })
    );
    // read-only and plan should be blocked
    const ro = getPassthroughMcpServers({
      passthrough: 'rea',
      sourceDir: d,
      permissions: 'read-only',
    });
    assert.deepEqual(ro, {});

    const plan = getPassthroughMcpServers({
      passthrough: 'rea',
      sourceDir: d,
      permissions: 'plan',
    });
    assert.deepEqual(plan, {});
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('getPassthroughMcpServers: passes allowed servers with direct exposure under edit/full', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-pt-test-'));
  try {
    writeFileSync(
      path.join(d, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          rea: { command: 'node', args: ['rea.js'], env: { FOO: 'bar' } },
          other: { command: 'other', args: [] },
          agentbridge: { command: 'node', args: ['bridge.js'] },
        },
      })
    );
    const res = getPassthroughMcpServers({
      passthrough: ['rea'],
      sourceDir: d,
      permissions: 'edit',
      offline: false,
    });
    assert.ok(res.rea, 'rea should be present');
    assert.equal(res.rea.command, 'node');
    assert.deepEqual(res.rea.args, ['rea.js']);
    assert.deepEqual(res.rea.env, { FOO: 'bar' });
    assert.equal(res.rea.exposure, 'direct');
    assert.equal(res.other, undefined, 'other should not be passed');
    assert.equal(res.agentbridge, undefined, 'agentbridge entry should be skipped');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
