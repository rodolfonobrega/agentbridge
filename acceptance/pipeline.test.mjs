import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionWaves, interpolatePrompt, runPipeline } from '../dist/extras/pipeline.js';
import { runPipeline as runPipelineFromRoot } from '../dist/index.js';
import { parseArgs } from '../dist/cli/args.js';
import { AgentError } from '../dist/core/errors.js';

test('buildExecutionWaves resolves linear and diamond DAG dependencies', () => {
  // Linear: A -> B -> C
  const linear = [
    { id: 'step1', agent: 'mock', prompt: '1' },
    { id: 'step2', agent: 'mock', prompt: '2', dependsOn: ['step1'] },
    { id: 'step3', agent: 'mock', prompt: '3', dependsOn: ['step2'] },
  ];
  const linearWaves = buildExecutionWaves(linear);
  assert.equal(linearWaves.length, 3);
  assert.deepEqual(linearWaves[0].map(s => s.id), ['step1']);
  assert.deepEqual(linearWaves[1].map(s => s.id), ['step2']);
  assert.deepEqual(linearWaves[2].map(s => s.id), ['step3']);

  // Diamond: A -> (B, C) -> D
  const diamond = [
    { id: 'A', agent: 'mock', prompt: 'root' },
    { id: 'B', agent: 'mock', prompt: 'branch 1', dependsOn: ['A'] },
    { id: 'C', agent: 'mock', prompt: 'branch 2', dependsOn: ['A'] },
    { id: 'D', agent: 'mock', prompt: 'join', dependsOn: ['B', 'C'] },
  ];
  const diamondWaves = buildExecutionWaves(diamond);
  assert.equal(diamondWaves.length, 3);
  assert.deepEqual(diamondWaves[0].map(s => s.id), ['A']);
  assert.deepEqual(diamondWaves[1].map(s => s.id).sort(), ['B', 'C']);
  assert.deepEqual(diamondWaves[2].map(s => s.id), ['D']);
});

test('buildExecutionWaves rejects cyclic dependencies', () => {
  const cyclic = [
    { id: 'A', agent: 'mock', prompt: '1', dependsOn: ['C'] },
    { id: 'B', agent: 'mock', prompt: '2', dependsOn: ['A'] },
    { id: 'C', agent: 'mock', prompt: '3', dependsOn: ['B'] },
  ];
  assert.throws(
    () => buildExecutionWaves(cyclic),
    (err) => err instanceof AgentError && err.code === 'BAD_OPTION' && /Cyclic/i.test(err.message)
  );
});

test('interpolatePrompt replaces step output tokens', () => {
  const stepResults = {
    spec: { id: 'spec', agent: 'claude', output: 'UserRESTApi', durationMs: 10, success: true },
    types: { id: 'types', agent: 'codex', output: 'interface User {}', durationMs: 12, success: true },
  };

  const rawPrompt = 'Generate tests for spec: {{steps.spec.output}} with types: {{steps.types.output}}';
  const resolved = interpolatePrompt(rawPrompt, stepResults);

  assert.equal(resolved, 'Generate tests for spec: UserRESTApi with types: interface User {}');
});

test('parseArgs treats pipeline boolean flags as booleans (bare true, =false false)', () => {
  assert.equal(parseArgs(['p.json', '--auto-rollback']).flags['auto-rollback'], true);
  const neg = parseArgs(['p.json', '--auto-rollback=false']).flags['auto-rollback'];
  assert.equal(neg, false);
  assert.equal(typeof neg, 'boolean', 'must be boolean false, not the string "false"');
  assert.equal(parseArgs(['p.json', '--auto-rollback=true']).flags['auto-rollback'], true);
  // bare at the end of argv must not throw "needs a value"
  assert.doesNotThrow(() => parseArgs(['p.json', '--auto-rollback']));
  assert.equal(parseArgs(['--checkpoint-each']).flags['checkpoint-each'], true);
});

test('runPipeline is part of the package root export', () => {
  assert.equal(typeof runPipelineFromRoot, 'function');
  assert.equal(runPipelineFromRoot, runPipeline);
});
