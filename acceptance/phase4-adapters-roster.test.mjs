import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOptions } from '../dist/index.js';
import { validate as validateSchema } from '../dist/extras/schema.js';
import { parseReviewVerdict, runEnsemble } from '../dist/extras/consensus.js';
import { runPipeline } from '../dist/extras/pipeline.js';
import { Budget } from '../dist/extras/budget.js';
import { BUILTIN } from '../dist/adapters/endpoint.js';
import { SubagentRoster } from '../dist/bridge/subagent-roster.js';
import { mcpConfigFor } from '../dist/bridge/attach.js';

test('A31: validateOptions accepts writableRoots and validates fallbackOn', () => {
  const o = validateOptions({
    prompt: 'test prompt',
    writableRoots: ['/tmp/allowed'],
    fallbackOn: ['TIMEOUT', 'AGENT_FAILED'],
  });
  assert.deepEqual(o.writableRoots, ['/tmp/allowed']);
  assert.deepEqual(o.fallbackOn, ['TIMEOUT', 'AGENT_FAILED']);
});

test('A43: validateSchema prevents prototype pollution and cyclic self-referential refs', () => {
  // Prototype property access blocked
  const protoSchema = { $ref: '#/__proto__/polluted' };
  const errs1 = validateSchema(protoSchema, {});
  assert.ok(errs1.some((e) => e.includes('prohibited prototype property')));

  // Self-referential loop blocked
  const cyclicSchema = { $ref: '#' };
  const errs2 = validateSchema(cyclicSchema, {});
  assert.ok(errs2.some((e) => e.includes('cyclic or self-referential')));

  // Object.hasOwn ensures inherited properties do not satisfy required
  const reqSchema = { type: 'object', required: ['toString'] };
  const objWithoutOwnToString = Object.create({ toString: () => 'ok' });
  const errs3 = validateSchema(reqSchema, objWithoutOwnToString);
  assert.ok(errs3.some((e) => e.includes('missing required property "toString"')));
});

test('A44: parseReviewVerdict enforces rejection precedence over approved boolean', () => {
  const rawJson = JSON.stringify({
    verdict: 'REJECTED',
    approved: true, // Contradictory flag
    issues: ['Critical flaw in design'],
  });
  const verdict = parseReviewVerdict(rawJson);
  assert.equal(verdict.approved, false, 'Explicit REJECTED verdict must never be approved');
  assert.equal(verdict.verdict, 'REJECTED');
  assert.deepEqual(verdict.issues, ['Critical flaw in design']);
});

test('A72: runEnsemble identifies lack of consensus on tie votes', async () => {
  const mockAgent1 = {
    name: 'agent1',
    async *run() {
      yield { type: 'text', delta: 'Output Alpha' };
      return { text: 'Output Alpha', durationMs: 5, exitCode: 0, model: null, sessionId: null, timedOut: false, usage: { input: 0, output: 0 } };
    },
  };
  const mockAgent2 = {
    name: 'agent2',
    async *run() {
      yield { type: 'text', delta: 'Output Beta' };
      return { text: 'Output Beta', durationMs: 5, exitCode: 0, model: null, sessionId: null, timedOut: false, usage: { input: 0, output: 0 } };
    },
  };

  const res = await runEnsemble({
    agents: [mockAgent1, mockAgent2],
    task: 'Generate an identifier',
  });

  assert.equal(res.hasConsensus, false, 'Ensemble with 1 vs 1 tie must report hasConsensus: false');
  assert.equal(res.consensusMethod, 'tie');
  assert.equal(res.consensus, '');
});

test('A36: runPipeline with stopOnError: false reports success: false when a step fails', async () => {
  const pipeline = {
    name: 'multi-wave',
    steps: [
      {
        id: 'step1',
        agent: 'claude',
        prompt: 'Intentional fail step',
      },
      {
        id: 'step2',
        agent: 'codex',
        prompt: 'Step 2 prompt',
        dependsOn: ['step1'],
      },
    ],
  };

  // Mock agent run
  const origGet = (await import('../dist/index.js')).agents.get;
  (await import('../dist/index.js')).agents.get = async (name) => {
    if (name === 'claude') {
      return {
        name: 'claude',
        async *run() {
          throw new Error('Step 1 execution error');
        },
      };
    }
    return {
      name: 'codex',
      async *run() {
        yield { type: 'text', delta: 'Step 2 succeeded' };
        return { text: 'Step 2 succeeded', durationMs: 5, exitCode: 0, model: null, sessionId: null, timedOut: false, usage: { input: 0, output: 0 } };
      },
    };
  };

  try {
    const res = await runPipeline(pipeline, { stopOnError: false });
    assert.equal(res.success, false, 'Pipeline with failing step must report success: false even if stopOnError is false');
    assert.equal(res.failedStepId, 'step1');
    assert.equal(res.stepResults.step1.success, false);
  } finally {
    (await import('../dist/index.js')).agents.get = origGet;
  }
});

test('A37: Budget.track supports multi-turn incremental usage events', () => {
  const b = new Budget({ maxTokens: 100 });
  b.track('run1', { type: 'usage', input: 30, output: 20, incremental: true });
  assert.equal(b.spent.tokens, 50);
  assert.equal(b.exceeded, null);

  b.track('run1', { type: 'usage', input: 40, output: 20, incremental: true });
  assert.equal(b.spent.tokens, 110);
  assert.equal(b.exceeded, 'tokens');
  b.dispose();
});

test('A63: BUILTIN array in endpoint adapter reserves all 10 built-in agents', () => {
  for (const name of ['claude', 'codex', 'opencode', 'agy', 'pi', 'cursor', 'grok', 'gemini', 'devin', 'acp']) {
    assert.ok(BUILTIN.includes(name), `BUILTIN must include ${name}`);
  }
});

test('A64: SubagentRoster parses full MCP prefixes and tracks async dispatch runId', () => {
  const roster = new SubagentRoster();

  // Test full mcp prefix: mcp__agentbridge__ask_codex
  const node = roster.consumeEvent({
    type: 'tool',
    name: 'mcp__agentbridge__ask_codex',
    id: 'call-123',
    input: { prompt: 'Subagent mission' },
  });

  assert.ok(node, 'Roster must register node for mcp__agentbridge__ prefixed call');
  assert.equal(node.name, 'codex');
  assert.equal(node.status, 'running');

  // Test async dispatch response with runId: must remain running
  const updated = roster.consumeEvent({
    type: 'tool',
    name: 'mcp__agentbridge__dispatch_claude',
    id: 'call-123',
    result: { runId: 'run_bg_456' },
  });

  assert.equal(updated.status, 'running', 'Async dispatch with runId must remain running');
});

test('A69: mcpConfigFor gracefully handles all supported agents and returns empty object on unknown', () => {
  const cfgCursor = mcpConfigFor('cursor', {});
  assert.ok(cfgCursor.agentbridge, 'cursor should receive agentbridge bridge configuration');

  const cfgUnknown = mcpConfigFor('custom-unknown-agent', {});
  assert.deepEqual(cfgUnknown, {}, 'unknown caller agent should return empty config without throwing');
});

test('A06 & A70: Cursor adapter rejects unsupported options', async () => {
  const cursorMod = await import('../dist/adapters/cursor.js');
  const cursor = cursorMod.default;

  await assert.rejects(
    async () => {
      const it = cursor.run({ prompt: 'hi', session: { mode: 'continue', id: 's1' } });
      await it.next();
    },
    (err) => {
      assert.equal(err.code, 'BAD_OPTION');
      assert.match(err.message, /session mode "continue"/);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      const it = cursor.run({ prompt: 'hi', offline: true });
      await it.next();
    },
    (err) => {
      assert.equal(err.code, 'BAD_OPTION');
      assert.match(err.message, /Offline mode/);
      return true;
    }
  );
});
