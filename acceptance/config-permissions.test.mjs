import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateOptions,
  getDefaultPermissions,
  getPermissionsCeiling,
  resolvePermissionLevel,
  loadConfig,
  saveConfig,
  setConfigValue,
  getConfigValue,
  resetConfigValue,
  ask,
} from '../dist/index.js';
import { resolvePerms } from '../dist/bridge/mcp.js';
import { spawnProc } from '../dist/core/spawn.js';

const collect = async (p) => {
  const a = [];
  for await (const l of p.lines) a.push(l);
  return a;
};

const N = process.execPath;
const CLI = path.resolve('dist/cli/main.js');

test('permissions: default is read-only and ceiling is full by default', () => {
  const cleanEnv = {};
  assert.equal(getDefaultPermissions(cleanEnv), 'read-only');
  assert.equal(getPermissionsCeiling(cleanEnv), 'full');

  const o = validateOptions({ prompt: 'inspect code' });
  assert.equal(o.permissions, 'read-only');
  assert.equal(o.defaultPermissions, true);
});

test('permissions: explicit permissions within ceiling are honored', () => {
  for (const perm of ['read-only', 'plan', 'edit', 'full']) {
    const o = validateOptions({ prompt: 'test', permissions: perm });
    assert.equal(o.permissions, perm);
    assert.equal(o.defaultPermissions, undefined);
  }
});

test('permissions: exceeding ceiling throws BAD_OPTION', () => {
  const restrictedEnv = { AGENTBRIDGE_PERMS_CEILING: 'read-only' };
  assert.throws(
    () => resolvePermissionLevel('edit', { env: restrictedEnv }),
    /exceeds the configured permission ceiling/
  );
  assert.throws(
    () => resolvePermissionLevel('full', { env: restrictedEnv }),
    /exceeds the configured permission ceiling/
  );
});

test('permissions: AGENTBRIDGE_DEFAULT_PERMS overrides default', () => {
  const customEnv = { AGENTBRIDGE_DEFAULT_PERMS: 'edit' };
  assert.equal(getDefaultPermissions(customEnv), 'edit');
  const o = validateOptions({ prompt: 'test', env: customEnv });
  assert.equal(o.permissions, 'edit');
});

test('bridge: resolvePerms applies default read-only and respects ceiling', () => {
  // Default when omitted is read-only
  assert.equal(resolvePerms(undefined, {}), 'read-only');
  // Explicit within ceiling
  assert.equal(resolvePerms('edit', { AGENTBRIDGE_PERMS: 'full' }), 'edit');
  // Escalating beyond ceiling throws
  assert.throws(
    () => resolvePerms('edit', { AGENTBRIDGE_PERMS: 'read-only' }),
    /exceeds/
  );
});

test('CLI: ab config get/set/list/reset manages settings cleanly', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-cfg-test-'));
  try {
    const env = { ...process.env, AGENTBRIDGE_HOME: tmp };

    // 1. Initial list in JSON
    let p = spawnProc(N, [CLI, 'config', 'list', '--json'], { cwd: tmp, env });
    let lines = await collect(p);
    const initial = JSON.parse(lines.join('\n'));
    assert.equal(initial.effective.defaultPermissions, 'read-only');
    assert.equal(initial.effective.permissionsCeiling, 'full');

    // 2. Set default-permissions to edit
    p = spawnProc(N, [CLI, 'config', 'set', 'default-permissions', 'edit', '--global'], { cwd: tmp, env });
    await collect(p);

    // 3. Get key
    p = spawnProc(N, [CLI, 'config', 'get', 'default-permissions'], { cwd: tmp, env });
    lines = await collect(p);
    assert.match(lines.join(''), /edit/);

    // 4. Verify list reflects change
    p = spawnProc(N, [CLI, 'config', 'list', '--json'], { cwd: tmp, env });
    lines = await collect(p);
    const updated = JSON.parse(lines.join('\n'));
    assert.equal(updated.config.defaultPermissions, 'edit');

    // 5. Reset key
    p = spawnProc(N, [CLI, 'config', 'reset', 'default-permissions', '--global'], { cwd: tmp, env });
    await collect(p);

    p = spawnProc(N, [CLI, 'config', 'get', 'default-permissions'], { cwd: tmp, env });
    lines = await collect(p);
    assert.match(lines.join(''), /not set/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('endpoints: default read-only operates directly without harness, edit requests harness', async () => {
  const fakeEndpoint = {
    name: 'test_local',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:9999/v1',
    defaultModel: 'test-model',
  };
  const { makeEndpointAdapter } = await import('../dist/adapters/endpoint.js');
  const adapter = makeEndpointAdapter(fakeEndpoint);

  // Default call (read-only): attempts direct HTTP without requiring Claude Code or Pi harness
  // It fails with AGENT_FAILED (cannot connect to 9999), NOT with NOT_INSTALLED (harness missing)
  try {
    await ask(adapter, { prompt: 'hi' });
    assert.fail('should have failed connection');
  } catch (err) {
    assert.equal(err.code, 'AGENT_FAILED');
    assert.match(err.message, /Cannot reach/);
  }

  // Edit call: cleanly requests execution harness
  try {
    await ask(adapter, { prompt: 'create file.txt', permissions: 'edit' });
    assert.fail('should have required harness');
  } catch (err) {
    // Harness was invoked (reports model/auth/install error from harness rather than "Cannot reach baseUrl")
    assert.ok(err.code === 'BAD_OPTION' || err.code === 'NOT_INSTALLED' || err.code === 'AGENT_FAILED' || err.code === 'NOT_LOGGED_IN');
    assert.doesNotMatch(err.message, /Cannot reach test_local/);
  }
});
