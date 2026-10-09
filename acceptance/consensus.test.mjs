import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  parseReviewVerdict,
  runReviewLoop,
  runEnsemble,
} from '../dist/extras/consensus.js';
import { AgentError } from '../dist/core/errors.js';

function setupGitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-consensus-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('parseReviewVerdict parses structured JSON verdicts', () => {
  const jsonApproved = '```json\n{"verdict": "APPROVED", "summary": "Looks great!"}\n```';
  const v1 = parseReviewVerdict(jsonApproved);
  assert.equal(v1.approved, true);
  assert.equal(v1.verdict, 'APPROVED');
  assert.equal(v1.issues.length, 0);
  assert.equal(v1.summary, 'Looks great!');

  const jsonRejected = JSON.stringify({
    verdict: 'REJECTED',
    issues: ['Missing error handling', 'Unhandled promise rejection'],
    summary: 'Needs fixes',
  });
  const v2 = parseReviewVerdict(jsonRejected);
  assert.equal(v2.approved, false);
  assert.equal(v2.verdict, 'REJECTED');
  assert.deepEqual(v2.issues, ['Missing error handling', 'Unhandled promise rejection']);
});

test('parseReviewVerdict parses Markdown verdicts with bullet points', () => {
  const mdApproved = 'VERDICT: APPROVED\nCode looks solid and passes all requirements.';
  const v1 = parseReviewVerdict(mdApproved);
  assert.equal(v1.approved, true);
  assert.equal(v1.verdict, 'APPROVED');

  const mdRejected = `
VERDICT: REJECTED
- Memory leak in event listener
- Missing parameter documentation
`;
  const v2 = parseReviewVerdict(mdRejected);
  assert.equal(v2.approved, false);
  assert.equal(v2.verdict, 'REJECTED');
  assert.equal(v2.issues.length, 2);
  assert.ok(v2.issues[0].includes('Memory leak'));
  assert.ok(v2.issues[1].includes('Missing parameter'));
});

test('runReviewLoop completes on turn 1 when reviewer approves', async () => {
  const dir = setupGitRepo();
  try {
    writeFileSync(path.join(dir, 'README.md'), '# Initial', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });

    const implementer = {
      run: async function* (opts) {
        assert.equal(opts.permissions, 'edit');
        writeFileSync(path.join(dir, 'feature.js'), 'export const hello = "world";', 'utf8');
        yield { type: 'text', delta: 'Created feature.js' };
        return { text: 'Created feature.js', usage: { input: 1, output: 1 } };
      },
    };

    const reviewer = {
      run: async function* (opts) {
        assert.equal(opts.permissions, 'read-only');
        assert.ok(opts.prompt.includes('feature.js') || opts.prompt.includes('export const hello'));
        const verdictJson = JSON.stringify({ verdict: 'APPROVED', summary: 'Clean and simple.' });
        yield { type: 'text', delta: verdictJson };
        return { text: verdictJson, usage: { input: 1, output: 1 } };
      },
    };

    const res = await runReviewLoop({
      implementer,
      reviewer,
      task: 'Create feature.js with hello constant',
      cwd: dir,
      maxTurns: 3,
    });

    assert.equal(res.approved, true);
    assert.equal(res.turns, 1);
    assert.equal(res.history.length, 1);
    assert.equal(res.history[0].verdict.approved, true);
    assert.ok(res.finalDiff.includes('feature.js'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runReviewLoop executes multi-turn feedback cycle: rejects turn 1, approves turn 2', async () => {
  const dir = setupGitRepo();
  try {
    writeFileSync(path.join(dir, 'index.js'), '// initial', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });

    let implementerTurns = 0;
    const implementer = {
      run: async function* (opts) {
        implementerTurns++;
        if (implementerTurns === 1) {
          writeFileSync(path.join(dir, 'index.js'), 'function calc() { return 42; }', 'utf8');
          yield { type: 'text', delta: 'Drafted calc function without docs.' };
        } else {
          assert.ok(opts.prompt.includes('Missing JSDoc documentation'));
          writeFileSync(path.join(dir, 'index.js'), '/** Returns answer */\nfunction calc() { return 42; }', 'utf8');
          yield { type: 'text', delta: 'Added JSDoc documentation to calc function.' };
        }
        return { text: 'Done', usage: { input: 5, output: 5 } };
      },
    };

    let reviewerTurns = 0;
    const reviewer = {
      run: async function* () {
        reviewerTurns++;
        if (reviewerTurns === 1) {
          const resp = 'VERDICT: REJECTED\n- Missing JSDoc documentation for calc function';
          yield { type: 'text', delta: resp };
          return { text: resp, usage: { input: 5, output: 5 } };
        } else {
          const resp = 'VERDICT: APPROVED\nAll issues resolved with proper JSDoc.';
          yield { type: 'text', delta: resp };
          return { text: resp, usage: { input: 5, output: 5 } };
        }
      },
    };

    const res = await runReviewLoop({
      implementer,
      reviewer,
      task: 'Implement documented calc function',
      cwd: dir,
      maxTurns: 3,
      checkpointPerTurn: true,
    });

    assert.equal(res.approved, true);
    assert.equal(res.turns, 2);
    assert.equal(implementerTurns, 2);
    assert.equal(reviewerTurns, 2);
    assert.equal(res.history.length, 2);
    assert.equal(res.history[0].verdict.approved, false);
    assert.equal(res.history[1].verdict.approved, true);
    assert.ok(res.history[0].checkpointId);
    assert.ok(res.history[1].checkpointId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runReviewLoop exhausts maxTurns when reviewer continuously rejects', async () => {
  const dir = setupGitRepo();
  try {
    const implementer = {
      run: async function* () {
        yield { type: 'text', delta: 'Implementer turn output' };
        return { text: 'Done', usage: { input: 1, output: 1 } };
      },
    };

    const reviewer = {
      run: async function* () {
        yield { type: 'text', delta: 'VERDICT: REJECTED\n- Unresolved fundamental defect' };
        return { text: 'Rejected', usage: { input: 1, output: 1 } };
      },
    };

    const res = await runReviewLoop({
      implementer,
      reviewer,
      task: 'Impossible task',
      cwd: dir,
      maxTurns: 2,
    });

    assert.equal(res.approved, false);
    assert.equal(res.turns, 2);
    assert.equal(res.maxTurns, 2);
    assert.equal(res.history.length, 2);
    assert.equal(res.history[0].verdict.approved, false);
    assert.equal(res.history[1].verdict.approved, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runEnsemble evaluates multiple agents concurrently and achieves consensus by plurality', async () => {
  const agentA = {
    name: 'agent-a',
    run: async function* () {
      yield { type: 'text', delta: 'Option Alpha' };
      return { text: 'Option Alpha', usage: { input: 1, output: 1 } };
    },
  };

  const agentB = {
    name: 'agent-b',
    run: async function* () {
      yield { type: 'text', delta: 'Option Beta' };
      return { text: 'Option Beta', usage: { input: 1, output: 1 } };
    },
  };

  const agentC = {
    name: 'agent-c',
    run: async function* () {
      yield { type: 'text', delta: 'Option Beta' };
      return { text: 'Option Beta', usage: { input: 1, output: 1 } };
    },
  };

  const res = await runEnsemble({
    agents: [agentA, agentB, agentC],
    task: 'What is the optimal architecture choice?',
  });

  assert.equal(res.outputs.length, 3);
  assert.equal(res.outputs.filter((o) => o.success).length, 3);
  // Option Beta has 2 votes vs 1 for Option Alpha
  assert.equal(res.consensus, 'Option Beta');
});

test('runEnsemble utilizes judge agent to evaluate and synthesize responses', async () => {
  const agent1 = {
    name: 'security-specialist',
    run: async function* () {
      yield { type: 'text', delta: 'Recommend HMAC token authentication.' };
      return { text: 'HMAC', usage: { input: 1, output: 1 } };
    },
  };

  const agent2 = {
    name: 'performance-specialist',
    run: async function* () {
      yield { type: 'text', delta: 'Recommend in-memory LRU cache.' };
      return { text: 'LRU', usage: { input: 1, output: 1 } };
    },
  };

  const judge = {
    name: 'lead-architect',
    run: async function* (opts) {
      assert.ok(opts.prompt.includes('HMAC'));
      assert.ok(opts.prompt.includes('LRU cache'));
      const synthesis = 'Synthesis: Apply HMAC tokens with an in-memory LRU cache for high-throughput security.';
      yield { type: 'text', delta: synthesis };
      return { text: synthesis, usage: { input: 10, output: 10 } };
    },
  };

  const res = await runEnsemble({
    agents: [agent1, agent2],
    task: 'Propose an auth strategy with low latency',
    judge,
    judgeMode: 'synthesize',
  });

  assert.equal(res.outputs.length, 2);
  assert.ok(res.consensus.includes('Synthesis: Apply HMAC'));
  assert.ok(res.judgeOutput?.includes('Synthesis'));
});

test('runEnsemble judge selects specific agent in select mode', async () => {
  const agent1 = {
    name: 'solution-a',
    run: async function* () {
      yield { type: 'text', delta: 'Solution A' };
      return { text: 'Solution A', usage: { input: 1, output: 1 } };
    },
  };

  const agent2 = {
    name: 'solution-b',
    run: async function* () {
      yield { type: 'text', delta: 'Solution B' };
      return { text: 'Solution B', usage: { input: 1, output: 1 } };
    },
  };

  const judge = {
    run: async function* () {
      const decision = 'Selected Agent: solution-b\nSolution B provides superior robustness.';
      yield { type: 'text', delta: decision };
      return { text: decision, usage: { input: 5, output: 5 } };
    },
  };

  const res = await runEnsemble({
    agents: [agent1, agent2],
    task: 'Pick the better solution',
    judge,
    judgeMode: 'select',
  });

  assert.equal(res.selectedAgent, 'solution-b');
  assert.ok(res.consensus.includes('Selected Agent: solution-b'));
});
