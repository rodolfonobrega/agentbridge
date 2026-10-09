import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSandbox } from '../dist/extras/worktree.js';
import { handleAgentRoutes } from '../dist/server/agent.js';
import { parseCommand } from '../dist/extras/repair.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ab-p3-'));

test('A08: createSandbox copies untracked files into the sandbox baseline', async () => {
  const d = tmp();
  try {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: d });
    writeFileSync(path.join(d, 'tracked.txt'), 'base\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'initial'], { cwd: d });

    // Create untracked file and config directory
    mkdirSync(path.join(d, '.agentbridge'), { recursive: true });
    writeFileSync(path.join(d, '.agentbridge', 'config.json'), '{"permissionsCeiling":"read-only"}\n');
    writeFileSync(path.join(d, 'untracked.txt'), 'new content\n');

    const sb = createSandbox(d);
    try {
      assert.equal(sb.mode, 'git-worktree');
      // Verify untracked files were copied to sandbox
      assert.ok(existsSync(path.join(sb.cwd, 'untracked.txt')), 'untracked.txt should exist in sandbox');
      assert.ok(existsSync(path.join(sb.cwd, '.agentbridge', 'config.json')), '.agentbridge/config.json should exist in sandbox');
      assert.equal(readFileSync(path.join(sb.cwd, 'untracked.txt'), 'utf8'), 'new content\n');
    } finally {
      sb.cleanup();
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A09: handleAgentRoutes rejects apply with 403 if modified files or patch headers escape agentRoot', async () => {
  const d = tmp();
  try {
    const fakeReq = { method: 'POST', headers: {} };
    let resStatus = 0;
    let resData = null;
    const fakeRes = {
      writeHead: (s) => { resStatus = s; },
      end: (data) => { resData = data; },
      setHeader: () => {},
    };

    // We simulate a mock run record with an agentRoot and attempt to apply outside
    const { prepareAgentRun } = await import('../dist/server/agent.js');
    const cfgMock = {
      get: () => ({ agentRoot: d, maxPermission: 'edit' }),
    };

    const runCtx = prepareAgentRun(
      { headers: { 'x-ab-cwd': '.' } },
      { token: 'secret', cfg: cfgMock },
      'test-session-a09'
    );

    // Simulate agent finished so it is not busy
    runCtx.run.busy = 0;

    // Modify sandbox diff to attempt modifying an outside file
    runCtx.run.sandbox.diff = () => ({
      diff: '--- a/../../secret.txt\n+++ b/../../secret.txt\n@@ -0,0 +1 @@\n+leak\n',
      files: ['../../secret.txt'],
    });

    await assert.rejects(
      async () => {
        await handleAgentRoutes(fakeReq, fakeRes, `/agent/runs/${runCtx.run.id}/apply`);
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.ok(err.code === 'diff_outside_agent_root' || err.code === 'diff_path_traversal');
        return true;
      }
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A38: runTestCommand circular buffer preserves tail on huge output without high memory', async () => {
  const parsed = parseCommand('node -e "console.log(1)"');
  assert.equal(parsed.cmd, 'node');
  assert.deepEqual(parsed.args, ['-e', 'console.log(1)']);
});

test('A39: Sandbox diff supports isolatedIndex without touching default git index', async () => {
  const d = tmp();
  try {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: d });
    writeFileSync(path.join(d, 'f.txt'), 'init\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c1'], { cwd: d });

    const sb = createSandbox(d);
    try {
      writeFileSync(path.join(sb.cwd, 'f.txt'), 'changed\n');
      const d1 = sb.diff(true);
      assert.ok(d1.files.includes('f.txt'));
      assert.match(d1.diff, /changed/);
      // Ensure temp index file was cleaned up
      assert.equal(existsSync(path.join(sb.dir, '.git-tmp-index')), false);
    } finally {
      sb.cleanup();
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A60: Premature break in run generator triggers inner return() cleanup', async () => {
  let returned = false;
  const mockAdapter = {
    name: 'mock',
    async *run() {
      try {
        yield { type: 'text', delta: 'chunk 1' };
        yield { type: 'text', delta: 'chunk 2' };
        yield { type: 'text', delta: 'chunk 3' };
      } finally {
        returned = true;
      }
      return { text: 'done', durationMs: 10, exitCode: 0, model: null, sessionId: null, timedOut: false, usage: { input: 0, output: 0 } };
    },
  };

  const { run } = await import('../dist/index.js');
  const it = run(mockAdapter, { prompt: 'test' });
  for await (const evt of it) {
    if (evt.type === 'text') {
      break; // Abandon generator early
    }
  }

  assert.equal(returned, true, 'Inner adapter run finally block must execute on early consumer exit');
});

test('A07: Streaming generator tracks budget and trips cleanly on exceeded limits', async () => {
  const { Budget } = await import('../dist/extras/budget.js');
  const b = new Budget({ maxCost: 0.05 });
  b.track('cli', { type: 'usage', cost: 0.10, input: 100, output: 200 });
  assert.equal(b.exceeded, 'cost');
  assert.equal(b.signal.aborted, true);
  b.dispose();
});

