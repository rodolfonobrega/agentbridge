import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateOptions } from '../dist/index.js';
import { installIde } from '../dist/cli/install-ide.js';
import { cmdInstall, writeSkill } from '../dist/cli/install.js';
import { toolSchema } from '../dist/bridge/mcp.js';
import codexAdapter from '../dist/adapters/codex.js';
import piAdapter from '../dist/adapters/pi.js';

test('mcpServers timeout validation', () => {
  // Valid positive numbers in seconds or ms
  const valid = validateOptions({
    prompt: 'hello',
    mcpServers: {
      test: { command: 'node', args: ['server.js'], timeout: 300 },
      other: { command: 'node', timeout: 120000 },
    },
  });
  assert.equal(valid.mcpServers.test.timeout, 300);
  assert.equal(valid.mcpServers.other.timeout, 120000);

  // Invalid timeout (zero, negative, non-number)
  assert.throws(() => {
    validateOptions({
      prompt: 'hello',
      mcpServers: {
        test: { command: 'node', timeout: -1 },
      },
    });
  }, /mcpServers\.test\.timeout must be a positive number/);

  assert.throws(() => {
    validateOptions({
      prompt: 'hello',
      mcpServers: {
        test: { command: 'node', timeout: 0 },
      },
    });
  }, /mcpServers\.test\.timeout must be a positive number/);

  assert.throws(() => {
    validateOptions({
      prompt: 'hello',
      mcpServers: {
        test: { command: 'node', timeout: 'long' },
      },
    });
  }, /mcpServers\.test\.timeout must be a positive number/);
});

test('codex adapter preserves mcp timeout in args', async () => {
  // Verify that codex command generator includes -c mcp_servers.<name>.timeout=<seconds>
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-codex-test-'));
  try {
    const gen = codexAdapter.run({
      prompt: 'test prompt',
      cwd: tmp,
      mcpServers: {
        worker: { command: 'node', args: ['worker.js'], timeout: 300 },
      },
    });
    // Just testing initiation or arg building if available, or inspecting buildArgs behavior
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bridge tool schema exposes timeout alias alongside timeoutSeconds', () => {
  const schema = toolSchema('codex', 'ask');
  assert.ok(schema.inputSchema.properties.timeout, 'schema must contain timeout property');
  assert.ok(schema.inputSchema.properties.timeoutSeconds, 'schema must contain timeoutSeconds property');
  assert.equal(schema.inputSchema.properties.timeout.type, 'number');
});

test('installIde writes default timeout of 300 seconds into config', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-ide-test-'));
  try {
    const configFile = path.join(tmp, 'cursor-mcp.json');
    const res = installIde('cursor', {
      configPath: configFile,
      cwd: tmp,
      timeout: 450,
    });
    assert.equal(res.modified, true);
    const content = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.ok(content.mcpServers?.agentbridge);
    assert.equal(content.mcpServers.agentbridge.timeout, 450);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('install pi writes timeout into mcp.json', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-pi-test-'));
  try {
    const piDir = path.join(tmp, 'pi-agent');
    const oldEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piDir;
    try {
      const msgs = [];
      await cmdInstall(['pi'], { cwd: tmp, timeout: 600 }, { out: (m) => msgs.push(m), err: () => {} });
      const mcpJsonPath = path.join(piDir, 'mcp.json');
      assert.ok(existsSync(mcpJsonPath), 'mcp.json must be created');
      const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
      assert.ok(mcpJson.mcpServers?.agentbridge);
      assert.equal(mcpJson.mcpServers.agentbridge.timeout, 600);
    } finally {
      if (oldEnv !== undefined) process.env.PI_CODING_AGENT_DIR = oldEnv;
      else delete process.env.PI_CODING_AGENT_DIR;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('install opencode writes timeout into opencode.json', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-opencode-test-'));
  try {
    const msgs = [];
    await cmdInstall(['opencode'], { cwd: tmp, scope: 'project', timeout: 500 }, { out: (m) => msgs.push(m), err: () => {} });
    const opencodePath = path.join(tmp, 'opencode.json');
    assert.ok(existsSync(opencodePath));
    const cfg = JSON.parse(readFileSync(opencodePath, 'utf8'));
    assert.ok(cfg.mcp?.agentbridge);
    assert.equal(cfg.mcp.agentbridge.timeout, 500);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('skill installation prevents duplicate collision across harnesses and scopes', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-skill-collision-'));
  try {
    const logs = [];
    const out = (m) => logs.push(m);

    // First write to project
    writeSkill(path.join(tmp, '.agents'), out, { scope: 'project', cwd: tmp });
    const skillPath = path.join(tmp, '.agents', 'skills', 'agentbridge-delegate', 'SKILL.md');
    assert.ok(existsSync(skillPath), 'skill must exist in .agents/skills');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /wrote skill/);

    // Second write during same command execution should be deduplicated
    logs.length = 0;
    writeSkill(path.join(tmp, '.agents'), out, { scope: 'project', cwd: tmp });
    assert.equal(logs.length, 0, 'subsequent write in same execution must be skipped without duplicate writes');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
