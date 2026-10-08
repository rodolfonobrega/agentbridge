import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatch, loadRun, recordSubagent, summarize } from '../dist/bridge/runs.js';

test('recordSubagent updates RunRecord and summarizes subagents hierarchy', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-sub-'));
  const env = { AGENTBRIDGE_HOME: d };

  const { rec } = dispatch({
    agent: 'claude',
    prompt: 'orchestrate multi-agents',
    env,
    exec: async () => ({ text: 'done' }),
  });

  // Record child subagent 1
  recordSubagent(rec.id, {
    id: 'sub-research-1',
    name: 'Researcher',
    task: 'Scan repository for security issues',
    state: 'running',
    tokens: { input: 120, output: 40 },
  }, env);

  // Record child subagent 2
  recordSubagent(rec.id, {
    id: 'sub-fix-2',
    name: 'Coder',
    parentId: 'sub-research-1',
    task: 'Apply patch to auth module',
    state: 'done',
    tokens: { input: 350, output: 150 },
  }, env);

  const loaded = loadRun(rec.id, env);
  assert.ok(loaded);
  assert.equal(loaded.subagents?.length, 2);
  assert.equal(loaded.subagents[0].name, 'Researcher');
  assert.equal(loaded.subagents[1].parentId, 'sub-research-1');

  // Summary contains subagents
  const sum = summarize(loaded);
  assert.equal(sum.subagents?.length, 2);
  assert.equal(sum.subagents[1].state, 'done');

  rmSync(d, { recursive: true, force: true });
});
