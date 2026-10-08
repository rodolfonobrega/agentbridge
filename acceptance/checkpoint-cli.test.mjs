import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allTools, callAny } from '../dist/bridge/mcp.js';

test('MCP bridge exposes checkpoint tools and executes them', async () => {
  const tools = allTools();
  const toolNames = tools.map((t) => t.name);
  assert.ok(toolNames.includes('checkpoint_create'));
  assert.ok(toolNames.includes('checkpoint_rollback'));
  assert.ok(toolNames.includes('checkpoint_list'));

  const repo = mkdtempSync(path.join(tmpdir(), 'ab-mcp-cp-'));
  execSync('git init && git config user.name test && git config user.email test@test.com && git commit --allow-empty -m init', { cwd: repo });
  writeFileSync(path.join(repo, 'doc.md'), '# Initial Document\n');

  // 1. checkpoint_create via MCP
  const createRes = await callAny('checkpoint_create', { cwd: repo, message: 'before agent edits' });
  assert.ok(createRes.structuredContent?.id);
  const cpId = createRes.structuredContent.id;

  // 2. checkpoint_list via MCP
  const listRes = await callAny('checkpoint_list', { cwd: repo });
  assert.equal(listRes.structuredContent?.checkpoints?.length, 1);
  assert.equal(listRes.structuredContent.checkpoints[0].id, cpId);

  // 3. Corrupt file and checkpoint_rollback via MCP
  writeFileSync(path.join(repo, 'doc.md'), '# Corrupted Document\n');
  const rollbackRes = await callAny('checkpoint_rollback', { cwd: repo, id: cpId });
  assert.ok(rollbackRes.structuredContent?.restoredOid);

  const restored = readFileSync(path.join(repo, 'doc.md'), 'utf8');
  assert.equal(restored, '# Initial Document\n');

  rmSync(repo, { recursive: true, force: true });
});
