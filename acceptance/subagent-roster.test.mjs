import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dispatch, loadRun, recordSubagent, summarize } from '../dist/bridge/runs.js';
import { SubagentRoster } from '../dist/bridge/subagent-roster.js';

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

test('SubagentRoster: tracks hierarchy (parent -> child -> grandchild) and builds tree', () => {
  const roster = new SubagentRoster();

  // Root task (parent)
  const root = roster.registerSubagent({
    id: 'task-root',
    name: 'Architect',
    task: 'Design multi-agent system',
    status: 'running',
    startedAt: 1000,
  });

  // Child task
  const child = roster.registerSubagent({
    id: 'task-child-1',
    name: 'Developer',
    parentId: 'task-root',
    task: 'Implement auth module',
    status: 'running',
    startedAt: 1050,
  });

  // Grandchild task
  const grandchild = roster.registerSubagent({
    id: 'task-grandchild-1',
    name: 'Tester',
    parentId: 'task-child-1',
    task: 'Run auth unit tests',
    status: 'running',
    startedAt: 1100,
  });

  assert.equal(roster.size, 3);

  // Verify tree structure
  const tree = roster.getTree();
  assert.equal(tree.length, 1);
  assert.equal(tree[0].id, 'task-root');
  assert.equal(tree[0].children?.length, 1);
  assert.equal(tree[0].children[0].id, 'task-child-1');
  assert.equal(tree[0].children[0].children?.length, 1);
  assert.equal(tree[0].children[0].children[0].id, 'task-grandchild-1');

  // Subtree query
  const childSubtree = roster.getTree('task-child-1');
  assert.equal(childSubtree.length, 1);
  assert.equal(childSubtree[0].id, 'task-child-1');
  assert.equal(childSubtree[0].children?.length, 1);
  assert.equal(childSubtree[0].children[0].id, 'task-grandchild-1');
});

test('SubagentRoster: tracks state transitions and listActive querying', () => {
  const roster = new SubagentRoster();

  roster.registerSubagent({ id: 'task-1', name: 'Agent 1', status: 'running' });
  roster.registerSubagent({ id: 'task-2', name: 'Agent 2', status: 'running' });
  roster.registerSubagent({ id: 'task-3', name: 'Agent 3', status: 'running' });

  assert.equal(roster.listActive().length, 3);

  // Complete task-1
  const updated1 = roster.updateStatus('task-1', {
    status: 'completed',
    completedAt: 2500,
    tokens: { input: 100, output: 50 },
  });
  assert.equal(updated1?.status, 'completed');
  assert.equal(updated1?.completedAt, 2500);
  assert.equal(updated1?.tokens.total, 150);

  // Fail task-2
  const updated2 = roster.updateStatus('task-2', {
    status: 'failed',
    error: 'Execution timeout exceeded',
  });
  assert.equal(updated2?.status, 'failed');
  assert.equal(updated2?.error, 'Execution timeout exceeded');
  assert.ok(updated2?.completedAt);

  // listActive only returns task-3
  const active = roster.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'task-3');
});

test('SubagentRoster: consumes task_started, ask_*, dispatch_*, and subAgentActivity events', () => {
  const roster = new SubagentRoster();

  // 1. task_started event
  roster.consumeEvent({
    type: 'task_started',
    id: 'sub-planning',
    name: 'Planner',
    task: 'Create execution plan',
    parentId: null,
  });
  assert.equal(roster.getSubagent('sub-planning')?.name, 'Planner');
  assert.equal(roster.getSubagent('sub-planning')?.status, 'running');

  // 2. ask_codex tool call (starts)
  roster.consumeEvent({
    type: 'tool',
    name: 'ask_codex',
    id: 'call-codex-1',
    input: { prompt: 'Write python function' },
    parentId: 'sub-planning',
  });
  const codexAgent = roster.getSubagent('call-codex-1');
  assert.ok(codexAgent);
  assert.equal(codexAgent.name, 'codex');
  assert.equal(codexAgent.parentId, 'sub-planning');
  assert.equal(codexAgent.status, 'running');

  // ask_codex finishes with output
  roster.consumeEvent({
    type: 'tool',
    name: 'ask_codex',
    id: 'call-codex-1',
    output: 'def foo(): return 42',
    tokens: { input: 80, output: 30 },
  });
  assert.equal(roster.getSubagent('call-codex-1')?.status, 'completed');
  assert.equal(roster.getSubagent('call-codex-1')?.tokens.total, 110);

  // 3. dispatch_claude tool call
  roster.consumeEvent({
    type: 'tool',
    name: 'dispatch_claude',
    id: 'call-claude-dispatch',
    input: { prompt: 'Review PR' },
    parentId: 'sub-planning',
  });
  assert.equal(roster.getSubagent('call-claude-dispatch')?.status, 'running');

  // dispatch_claude finishes with error
  roster.consumeEvent({
    type: 'tool',
    name: 'dispatch_claude',
    id: 'call-claude-dispatch',
    error: 'Rate limit reached',
  });
  assert.equal(roster.getSubagent('call-claude-dispatch')?.status, 'failed');
  assert.equal(roster.getSubagent('call-claude-dispatch')?.error, 'Rate limit reached');

  // 4. subAgentActivity event
  roster.consumeEvent({
    type: 'subAgentActivity',
    subagentId: 'sub-worker-4',
    name: 'Worker',
    action: 'start',
    task: 'Process queue',
    parentId: 'sub-planning',
  });
  assert.equal(roster.getSubagent('sub-worker-4')?.status, 'running');

  roster.consumeEvent({
    type: 'subAgentActivity',
    subagentId: 'sub-worker-4',
    action: 'finish',
    tokens: { input: 50, output: 25 },
  });
  assert.equal(roster.getSubagent('sub-worker-4')?.status, 'completed');
  assert.equal(roster.getSubagent('sub-worker-4')?.tokens.total, 75);

  // Check toRunSubagents compatibility
  const entries = roster.toRunSubagents();
  assert.equal(entries.length, 4);
  const doneEntries = entries.filter((e) => e.state === 'done');
  assert.equal(doneEntries.length, 2);
});
