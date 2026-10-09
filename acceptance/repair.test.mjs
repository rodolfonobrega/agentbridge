import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { autoRepair } from '../dist/extras/repair.js';
import { AgentError } from '../dist/core/errors.js';

function setupGitRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-repair-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

test('autoRepair succeeds immediately when initial test passes', async () => {
  const dir = setupGitRepo();
  try {
    const testFile = path.join(dir, 'test.js');
    writeFileSync(testFile, 'process.exit(0);', 'utf8');

    const mockAgent = {
      run: async function* () {
        throw new Error('Agent should not be called when test passes immediately');
      },
    };

    const res = await autoRepair({
      testCommand: [process.execPath, testFile],
      agent: mockAgent,
      cwd: dir,
      maxAttempts: 3,
    });

    assert.equal(res.success, true);
    assert.equal(res.attempts, 0);
    assert.equal(res.rolledBack, false);
    assert.equal(res.history.length, 1);
    assert.equal(res.history[0].testPassed, true);
    assert.equal(res.history[0].exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRepair repairs failing code and verifies passing test on attempt 1', async () => {
  const dir = setupGitRepo();
  try {
    const codeFile = path.join(dir, 'math.js');
    const testFile = path.join(dir, 'test.js');

    // Buggy initial implementation: add(a, b) returns a - b
    writeFileSync(codeFile, 'function add(a, b) { return a - b; }\nmodule.exports = { add };', 'utf8');
    writeFileSync(
      testFile,
      'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.error("add(2,3) != 5"); process.exit(1); } else { process.exit(0); }',
      'utf8'
    );

    // Initial git commit so repo has clean base
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial buggy code'], { cwd: dir, stdio: 'ignore' });

    let agentCalledTimes = 0;
    const mockAgent = {
      run: async function* (opts) {
        agentCalledTimes++;
        assert.ok(opts.prompt.includes('add(2,3) != 5'));
        assert.equal(opts.permissions, 'edit');
        // Fix the bug
        writeFileSync(codeFile, 'function add(a, b) { return a + b; }\nmodule.exports = { add };', 'utf8');
        yield { type: 'text', delta: 'Fixed add function by replacing subtraction with addition.' };
        return { text: 'Fixed', usage: { input: 10, output: 10 } };
      },
    };

    const res = await autoRepair({
      testCommand: [process.execPath, testFile],
      agent: mockAgent,
      cwd: dir,
      prompt: 'Fix the add function so add(2,3) equals 5',
      maxAttempts: 3,
    });

    assert.equal(res.success, true);
    assert.equal(res.attempts, 1);
    assert.equal(agentCalledTimes, 1);
    assert.equal(res.rolledBack, false);
    assert.equal(res.history.length, 2);
    assert.equal(res.history[0].testPassed, false);
    assert.equal(res.history[1].testPassed, true);
    assert.ok(res.history[1].agentOutput.includes('Fixed add function'));
    assert.ok(readFileSync(codeFile, 'utf8').includes('a + b'));
    assert.ok(res.initialCheckpoint);
    assert.ok(res.finalCheckpoint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRepair retries up to maxAttempts and rolls back on persistent failure', async () => {
  const dir = setupGitRepo();
  try {
    const targetFile = path.join(dir, 'code.js');
    const testFile = path.join(dir, 'test.js');

    writeFileSync(targetFile, '// pristine original code', 'utf8');
    writeFileSync(testFile, 'console.error("always failing test"); process.exit(1);', 'utf8');

    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'pristine commit'], { cwd: dir, stdio: 'ignore' });

    let callCount = 0;
    const mockAgent = {
      run: async function* () {
        callCount++;
        // Agent modifies the file with an ineffective attempt
        writeFileSync(targetFile, `// corrupted attempt ${callCount}`, 'utf8');
        yield { type: 'text', delta: `Attempt ${callCount} did not help.` };
        return { text: 'Done', usage: { input: 10, output: 10 } };
      },
    };

    const res = await autoRepair({
      testCommand: [process.execPath, testFile],
      agent: mockAgent,
      cwd: dir,
      maxAttempts: 2,
      autoRollback: true,
    });

    assert.equal(res.success, false);
    assert.equal(res.attempts, 2);
    assert.equal(callCount, 2);
    assert.equal(res.rolledBack, true);
    assert.equal(res.history.length, 3); // initial baseline (0) + attempt 1 + attempt 2

    // Verify rollback restored the pristine original code
    const restoredContent = readFileSync(targetFile, 'utf8');
    assert.equal(restoredContent, '// pristine original code');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRepair respects autoRollback: false on failure', async () => {
  const dir = setupGitRepo();
  try {
    const targetFile = path.join(dir, 'code.js');
    const testFile = path.join(dir, 'test.js');

    writeFileSync(targetFile, '// original', 'utf8');
    writeFileSync(testFile, 'process.exit(1);', 'utf8');

    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });

    const mockAgent = {
      run: async function* () {
        writeFileSync(targetFile, '// edited but still failing', 'utf8');
        yield { type: 'text', delta: 'Edited' };
        return { text: 'Edited', usage: { input: 5, output: 5 } };
      },
    };

    const res = await autoRepair({
      testCommand: [process.execPath, testFile],
      agent: mockAgent,
      cwd: dir,
      maxAttempts: 1,
      autoRollback: false,
    });

    assert.equal(res.success, false);
    assert.equal(res.rolledBack, false);
    assert.equal(readFileSync(targetFile, 'utf8'), '// edited but still failing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('autoRepair aborts gracefully when signal is aborted', async () => {
  const dir = setupGitRepo();
  try {
    const testFile = path.join(dir, 'test.js');
    writeFileSync(testFile, 'process.exit(1);', 'utf8');

    const ac = new AbortController();
    ac.abort();

    const mockAgent = {
      run: async function* () {
        yield { type: 'text', delta: 'test' };
        return { text: 'test', usage: { input: 1, output: 1 } };
      },
    };

    await assert.rejects(
      () =>
        autoRepair({
          testCommand: [process.execPath, testFile],
          agent: mockAgent,
          cwd: dir,
          signal: ac.signal,
        }),
      (err) => err instanceof AgentError && err.code === 'ABORTED'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
