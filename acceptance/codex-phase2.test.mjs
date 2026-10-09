import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServerDaemon, codexDaemonPool } from '../dist/adapters/codex-daemon.js';
import { AgentError } from '../dist/core/errors.js';

test('A04: daemon pool keys instances by cwd and effective account env', () => {
  const dir1 = mkdtempSync(path.join(tmpdir(), 'cx-p2-pool-'));

  const daemon1 = codexDaemonPool.get(dir1, { CODEX_HOME: '/home/user1/.codex', AGENTBRIDGE_ACCOUNT_NAME: 'work' });
  const daemon2 = codexDaemonPool.get(dir1, { CODEX_HOME: '/home/user2/.codex', AGENTBRIDGE_ACCOUNT_NAME: 'personal' });
  const daemon1Reused = codexDaemonPool.get(dir1, { CODEX_HOME: '/home/user1/.codex', AGENTBRIDGE_ACCOUNT_NAME: 'work' });

  // Different accounts in same directory get distinct daemons
  assert.notEqual(daemon1, daemon2, 'Different accounts in the same directory must yield different daemon instances');
  // Same account in same directory reuses the same daemon
  assert.equal(daemon1, daemon1Reused, 'Same account must reuse the active daemon instance');
});

test('A58 & A05: sendRpc respects AbortSignal and times out cleanly without leaks', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-abort-'));
  const daemon = new CodexAppServerDaemon(dir);
  daemon['isAlive'] = true;
  daemon['p'] = { stdin: { write: () => {} }, child: { killed: false, exitCode: null } };

  // Pre-aborted signal
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    daemon.sendRpc('test/method', {}, { signal: ac.signal }),
    (err) => err instanceof AgentError && err.code === 'ABORTED'
  );

  // Signal aborted during execution
  const ac2 = new AbortController();
  const rpcPromise = daemon.sendRpc('test/hanging', {}, { signal: ac2.signal, timeoutMs: 5000 });
  setTimeout(() => ac2.abort(), 10);

  await assert.rejects(
    rpcPromise,
    (err) => err instanceof AgentError && err.code === 'ABORTED'
  );
});

test('A68: turn/completed with failed status propagates AGENT_FAILED', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-fail-'));
  const daemon = new CodexAppServerDaemon(dir);

  // Mock an active turn
  const events = [];
  let errorCaught = null;
  const mockQueue = {
    push: (e) => events.push(e),
    close: () => {},
    fail: (err) => { errorCaught = err; },
  };

  daemon.activeTurn = {
    queue: mockQueue,
    permissions: 'full',
    text: '',
    usage: { input: 10, output: 5 },
  };

  // Simulate turn/completed with failure status
  daemon['handleServerNotification']('turn/completed', {
    turn: {
      status: 'failed',
      error: { message: 'Quota exceeded for model' },
    },
  }, {});

  assert.ok(errorCaught instanceof AgentError);
  assert.equal(errorCaught.code, 'AGENT_FAILED');
  assert.match(errorCaught.message, /Quota exceeded/);
});

test('A03: concurrent runTurn calls are serialized and do not clobber activeTurn', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-turns-'));
  const daemon = new CodexAppServerDaemon(dir);
  daemon['isAlive'] = true;

  const executionLog = [];
  daemon.ensureStarted = async () => {};
  daemon.sendRpc = async (method, params) => {
    if (method === 'turn/start') {
      executionLog.push({ event: 'start', prompt: params.input[0].text });
      // Simulate asynchronous turn completion via notification after delay
      setTimeout(() => {
        executionLog.push({ event: 'complete', prompt: params.input[0].text });
        daemon['handleServerNotification']('turn/completed', { turn: { status: 'completed' } }, {});
      }, 50);
      return { turn: { id: `turn-${Date.now()}` } };
    }
    if (method === 'thread/start') {
      return { thread: { id: 'th-1' } };
    }
    return {};
  };

  // Launch two turns concurrently on the same daemon
  const turn1Promise = (async () => {
    const it = daemon.runTurn({ prompt: 'First turn', permissions: 'read-only' }, Date.now());
    for await (const _ of it) {}
  })();

  const turn2Promise = (async () => {
    const it = daemon.runTurn({ prompt: 'Second turn', permissions: 'full' }, Date.now());
    for await (const _ of it) {}
  })();

  await Promise.all([turn1Promise, turn2Promise]);

  // Turn 1 must start and complete before Turn 2 starts (strictly serialized)
  assert.equal(executionLog.length, 4);
  assert.equal(executionLog[0].event, 'start');
  assert.equal(executionLog[0].prompt, 'First turn');
  assert.equal(executionLog[1].event, 'complete');
  assert.equal(executionLog[1].prompt, 'First turn');
  assert.equal(executionLog[2].event, 'start');
  assert.equal(executionLog[2].prompt, 'Second turn');
  assert.equal(executionLog[3].event, 'complete');
  assert.equal(executionLog[3].prompt, 'Second turn');
});

