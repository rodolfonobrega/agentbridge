import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import codex, { codexDaemonPool } from '../dist/adapters/codex.js';
import { validateOptions } from '../dist/index.js';
import { AgentError } from '../dist/core/errors.js';

const T = 120000;
const cwd = mkdtempSync(path.join(tmpdir(), 'cx-appserver-'));

test('validateOptions accepts transport and appServer options', () => {
  const o1 = validateOptions({ prompt: 'test', transport: 'app-server' });
  assert.equal(o1.transport, 'app-server');

  const o2 = validateOptions({ prompt: 'test', transport: 'cli' });
  assert.equal(o2.transport, 'cli');

  const o3 = validateOptions({ prompt: 'test', appServer: true });
  assert.equal(o3.appServer, true);

  assert.throws(
    () => validateOptions({ prompt: 'test', transport: 'banana' }),
    (e) => e instanceof AgentError && e.code === 'BAD_OPTION'
  );

  assert.throws(
    () => validateOptions({ prompt: 'test', appServer: 'yes' }),
    (e) => e instanceof AgentError && e.code === 'BAD_OPTION'
  );
});

test('codex app-server: live turn with streaming deltas and session continuity', { timeout: T }, async () => {
  // First turn
  const gen1 = codex.run({
    cwd,
    prompt: 'Reply with exactly: HELLO_APP_SERVER',
    transport: 'app-server',
    permissions: 'full',
    timeoutMs: T,
  });

  const events1 = [];
  let n1 = await gen1.next();
  while (!n1.done) {
    events1.push(n1.value);
    n1 = await gen1.next();
  }
  const res1 = n1.value;

  assert.match(res1.text, /HELLO_APP_SERVER/);
  assert.ok(res1.sessionId, 'Should return a sessionId (threadId)');
  assert.equal(res1.transport, 'app-server');
  assert.ok(res1.usage.input > 0 || res1.usage.output > 0, 'Should have usage metrics');
  assert.ok(events1.some((e) => e.type === 'session'), 'Should emit session event');
  assert.ok(events1.some((e) => e.type === 'text'), 'Should emit streaming text delta events');

  // Verify daemon is alive in the pool
  const daemon = codexDaemonPool.get(cwd);
  assert.ok(daemon.alive, 'Codex daemon process should remain alive in daemon pool');

  // Second turn reusing the persistent daemon in the same session
  const gen2 = codex.run({
    cwd,
    prompt: 'Reply with exactly: TURN_TWO_OK',
    transport: 'app-server',
    session: { mode: 'continue', id: res1.sessionId },
    permissions: 'full',
    timeoutMs: T,
  });

  const events2 = [];
  let n2 = await gen2.next();
  while (!n2.done) {
    events2.push(n2.value);
    n2 = await gen2.next();
  }
  const res2 = n2.value;

  assert.match(res2.text, /TURN_TWO_OK/);
  assert.equal(res2.sessionId, res1.sessionId, 'Should continue the same thread');
  assert.ok(daemon.alive, 'Codex daemon should still be alive after second turn');
});

test('codex daemon approval handler responds correctly by permissions', () => {
  const daemon = codexDaemonPool.get(cwd);

  const responses = [];
  const origSend = daemon.sendResponse;
  const origTurn = daemon.activeTurn;

  daemon.sendResponse = (id, res) => { responses.push({ id, res }); };
  daemon.activeTurn = {
    permissions: 'full',
    queue: { push: () => {}, close: () => {} },
  };

  try {
    // 1. Full permissions -> approved
    daemon.handleServerRequest(10, 'item/commandExecution/requestApproval', { command: 'npm run test' });
    assert.equal(responses[responses.length - 1].res.decision, 'approved');

    // 2. Read-only permissions -> denied
    daemon.activeTurn.permissions = 'read-only';
    daemon.handleServerRequest(11, 'item/commandExecution/requestApproval', { command: 'rm -rf test' });
    assert.deepEqual(responses[responses.length - 1].res.decision, {
      denied: { rejection: 'read-only permission: command execution denied' },
    });

    // 3. Plan mode on file changes -> denied
    daemon.activeTurn.permissions = 'plan';
    daemon.handleServerRequest(12, 'item/fileChange/requestApproval', { path: 'src/file.ts' });
    assert.deepEqual(responses[responses.length - 1].res.decision, {
      denied: { rejection: 'plan permission: file modification denied' },
    });

    // 4. Edit mode on file changes -> approved
    daemon.activeTurn.permissions = 'edit';
    daemon.handleServerRequest(13, 'item/fileChange/requestApproval', { path: 'src/file.ts' });
    assert.equal(responses[responses.length - 1].res.decision, 'approved');
  } finally {
    daemon.sendResponse = origSend;
    daemon.activeTurn = origTurn;
  }
});

test('ACP adapter handles in-flight tool approval and session deltas', async () => {
  const { makeAcpAdapter } = await import('../dist/adapters/acp.js');
  const mockScript = `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', (line) => {
      try {
        const j = JSON.parse(line);
        if (j.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { capabilities: {} } }) + '\\n');
        } else if (j.method === 'session/prompt') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/created', params: { sessionId: 'sess-123' } }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tool/requestApproval', params: { tool: 'deploy' } }) + '\\n');
        } else if (j.id === 99) {
          if (j.result && j.result.approved) {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'text/delta', params: { delta: 'APPROVED_AND_DONE' } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { usage: { inputTokens: 10, outputTokens: 20 } } }) + '\\n');
          }
        }
      } catch (e) {}
    });
  `;

  const adapter = makeAcpAdapter({
    command: process.execPath,
    args: ['-e', mockScript],
  });

  const gen = adapter.run({ prompt: 'deploy app', permissions: 'full' });
  const events = [];
  let n = await gen.next();
  while (!n.done) {
    events.push(n.value);
    n = await gen.next();
  }
  const res = n.value;

  assert.equal(res.text, 'APPROVED_AND_DONE');
  assert.equal(res.sessionId, 'sess-123');
  assert.equal(res.usage.input, 10);
  assert.equal(res.usage.output, 20);
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'acp:approval'));
});

test('codex daemon shutdown cleanup', () => {
  codexDaemonPool.shutdownAll();
  const daemon = codexDaemonPool.get(cwd);
  // After shutdown, get returns a fresh unstarted daemon
  assert.equal(daemon.alive, false);
});

