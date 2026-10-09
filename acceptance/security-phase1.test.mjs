import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isPrivateIp } from '../dist/server/images.js';
import { callAny, allTools } from '../dist/bridge/mcp.js';
import { createCheckpoint } from '../dist/extras/checkpoint.js';
import { startUi } from '../dist/ui/server.js';

test('A14: isPrivateIp detects mapped hex IPv6 loopback and private ranges', () => {
  // Loopback variants
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:7f00:1'), true); // 127.0.0.1 in hex
  assert.equal(isPrivateIp('::ffff:7f00:0001'), true);
  assert.equal(isPrivateIp('::ffff:0a00:0001'), true); // 10.0.0.1 in hex
  assert.equal(isPrivateIp('::ffff:c0a8:0101'), true); // 192.168.1.1 in hex
  assert.equal(isPrivateIp('::ffff:ac10:0001'), true); // 172.16.0.1 in hex

  // Public IP variants
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false);
  assert.equal(isPrivateIp('::ffff:0808:0808'), false);
});

test('A02: MCP bridge rejects checkpoint_rollback under read-only permissions and omits it from allTools', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-sec-mcp-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(path.join(dir, 'file.txt'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

  const cp = createCheckpoint(dir, { message: 'snap1' });

  const readOnlyEnv = {
    ...process.env,
    AGENTBRIDGE_PERMS_CEILING: 'read-only',
    AGENTBRIDGE_DEFAULT_PERMS: 'read-only',
  };

  // allTools should NOT list checkpoint_rollback
  const tools = allTools(readOnlyEnv);
  const toolNames = tools.map((t) => t.name);
  assert.equal(toolNames.includes('checkpoint_rollback'), false);
  assert.equal(toolNames.includes('checkpoint_list'), true);

  // Direct callAny invocation of checkpoint_rollback must be denied
  const res = await callAny('checkpoint_rollback', { cwd: dir, id: cp.id }, { env: readOnlyEnv });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Permission denied/);

  rmSync(dir, { recursive: true, force: true });
});

test('A16: UI server rejects cross-origin mutations (CSRF protection)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-sec-ui-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(path.join(dir, 'file.txt'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  const cp = createCheckpoint(dir, { message: 'snap1' });

  const ui = await startUi({ port: 0, allowedRoot: tmpdir() });

  const req = (headers) =>
    new Promise((ok, bad) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port: ui.port,
          path: `/api/checkpoints/${cp.id}/rollback?cwd=${encodeURIComponent(dir)}`,
          method: 'POST',
          headers,
        },
        (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => ok({ status: res.statusCode, body: b }));
        }
      );
      r.on('error', bad);
      r.end();
    });

  try {
    // Cross-origin request with external Origin must receive 403
    const blockedRes = await req({ origin: 'https://malicious-site.example.com' });
    assert.equal(blockedRes.status, 403);
    assert.match(blockedRes.body, /cross-origin request blocked/);

    // Cross-site with sec-fetch-site must receive 403
    const blockedSec = await req({ 'sec-fetch-site': 'cross-site' });
    assert.equal(blockedSec.status, 403);
    assert.match(blockedSec.body, /cross-origin request blocked/);

    // Loopback origin must be accepted
    const okRes = await req({ origin: `http://127.0.0.1:${ui.port}` });
    assert.equal(okRes.status, 200);
    const body = JSON.parse(okRes.body);
    assert.equal(body.ok, true);
  } finally {
    await ui.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
