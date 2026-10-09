import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  addAccount,
  listAccounts,
  getActiveAccount,
  setActiveAccount,
  removeAccount,
  getAccountEnv,
  getAccountsAsPool,
  loadAccountsManifest,
} from '../dist/core/accounts.js';
import { createPool } from '../dist/server/pool.js';
import { cmdAccount } from '../dist/cli/accounts.js';

test('accounts: addAccount creates managed profile dir and sets first account as active', () => {
  const tmpBase = mkdtempSync(path.join(tmpdir(), 'ab-acct-test-'));
  try {
    const acc = addAccount('claude', 'work', { baseDir: tmpBase });
    assert.equal(acc.name, 'work');
    assert.equal(acc.agent, 'claude');
    assert.ok(existsSync(acc.profileDir));
    assert.ok(acc.profileDir.includes(path.join('profiles', 'claude', 'work')));

    const active = getActiveAccount('claude', tmpBase);
    assert.ok(active);
    assert.equal(active.name, 'work');

    const manifest = loadAccountsManifest(tmpBase);
    assert.equal(manifest.active.claude, 'work');
    assert.equal(manifest.accounts.claude.length, 1);
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('accounts: getAccountEnv maps isolated directory to agent config variables', () => {
  const tmpBase = mkdtempSync(path.join(tmpdir(), 'ab-acct-test-'));
  try {
    addAccount('claude', 'work', { baseDir: tmpBase });
    addAccount('codex', 'personal', { baseDir: tmpBase });
    addAccount('pi', 'local', { baseDir: tmpBase });

    const claudeEnv = getAccountEnv('claude', 'work', tmpBase);
    assert.ok(claudeEnv.CLAUDE_CONFIG_DIR);
    assert.ok(claudeEnv.CLAUDE_CONFIG_DIR.includes('work'));
    assert.equal(claudeEnv.ANTHROPIC_API_KEY, '');
    assert.equal(claudeEnv.ANTHROPIC_AUTH_TOKEN, '');

    const codexEnv = getAccountEnv('codex', 'personal', tmpBase);
    assert.ok(codexEnv.CODEX_HOME);
    assert.ok(codexEnv.CODEX_HOME.includes('personal'));

    const piEnv = getAccountEnv('pi', 'local', tmpBase);
    assert.ok(piEnv.PI_CODING_AGENT_DIR);
    assert.ok(piEnv.PI_CODING_AGENT_DIR.includes('local'));
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('accounts: switching and removing accounts updates active state correctly', () => {
  const tmpBase = mkdtempSync(path.join(tmpdir(), 'ab-acct-test-'));
  try {
    addAccount('claude', 'work', { baseDir: tmpBase });
    addAccount('claude', 'personal', { baseDir: tmpBase });

    assert.equal(getActiveAccount('claude', tmpBase)?.name, 'work');

    setActiveAccount('claude', 'personal', tmpBase);
    assert.equal(getActiveAccount('claude', tmpBase)?.name, 'personal');

    const list = listAccounts('claude', tmpBase);
    assert.equal(list.length, 2);

    const removed = removeAccount('claude', 'personal', { deleteProfileDir: true, baseDir: tmpBase });
    assert.equal(removed, true);
    assert.equal(getActiveAccount('claude', tmpBase)?.name, 'work');
    assert.equal(listAccounts('claude', tmpBase).length, 1);
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('accounts: getAccountsAsPool converts managed profiles into valid AccountPool config', () => {
  const tmpBase = mkdtempSync(path.join(tmpdir(), 'ab-acct-test-'));
  try {
    addAccount('claude', 'acc1', { baseDir: tmpBase });
    addAccount('claude', 'acc2', { baseDir: tmpBase });

    const poolCfg = getAccountsAsPool(tmpBase);
    assert.equal(poolCfg.strategy, 'round-robin');
    assert.ok(Array.isArray(poolCfg.claude));
    assert.equal(poolCfg.claude.length, 2);
    assert.equal(poolCfg.claude[0].name, 'acc1');
    assert.ok(poolCfg.claude[0].env.CLAUDE_CONFIG_DIR);

    const pool = createPool(poolCfg);
    assert.equal(pool.available('claude'), 2);
    const p1 = pool.pick('claude');
    assert.equal(p1?.name, 'acc1');
    const p2 = pool.pick('claude');
    assert.equal(p2?.name, 'acc2');
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('accounts CLI: cmdAccount handles list, add, use, remove with formatting', async () => {
  const tmpBase = mkdtempSync(path.join(tmpdir(), 'ab-acct-test-'));
  const outputs = [];
  const errors = [];
  const io = {
    out: (msg) => outputs.push(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    err: (msg) => errors.push(String(msg)),
  };

  try {
    // 1. Initial list when empty
    await cmdAccount(['list'], { baseDir: tmpBase }, io);
    assert.ok(outputs.some((o) => o.includes('No accounts registered')));

    // 2. Add accounts
    await cmdAccount(['add', 'claude', 'primary'], { baseDir: tmpBase }, io);
    await cmdAccount(['add', 'claude', 'secondary'], { baseDir: tmpBase }, io);

    outputs.length = 0;
    // 3. List accounts
    await cmdAccount(['list'], { baseDir: tmpBase }, io);
    assert.ok(outputs.some((o) => o.includes('primary') && o.includes('*')));
    assert.ok(outputs.some((o) => o.includes('secondary')));

    // 4. Switch active account
    await cmdAccount(['use', 'claude', 'secondary'], { baseDir: tmpBase }, io);
    outputs.length = 0;
    await cmdAccount(['list'], { baseDir: tmpBase }, io);
    assert.ok(outputs.some((o) => o.includes('secondary') && o.includes('*')));

    // 5. Remove account with purge
    await cmdAccount(['remove', 'claude', 'primary'], { baseDir: tmpBase, purge: true }, io);
    outputs.length = 0;
    await cmdAccount(['list'], { baseDir: tmpBase }, io);
    assert.ok(!outputs.some((o) => o.includes('primary')));
    assert.ok(outputs.some((o) => o.includes('secondary')));
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});
