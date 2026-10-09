import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startUi } from '../dist/ui/server.js';
import { createCheckpoint } from '../dist/extras/checkpoint.js';

function setupRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-ui-cp-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(path.join(dir, 'file.txt'), 'version 1\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

const req = (port, p, { method = 'GET', headers = {} } = {}) =>
  new Promise((ok, bad) => {
    const r = http.request(
      { host: '127.0.0.1', port, path: p, method, headers },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: b }));
      }
    );
    r.on('error', bad);
    r.end();
  });

test('UI server Time Machine endpoints: list, diff, and rollback', async () => {
  const repo = setupRepo();
  const cp1 = createCheckpoint(repo, { message: 'first snapshot' });

  // Modify file
  writeFileSync(path.join(repo, 'file.txt'), 'version 2 modified\n', 'utf8');
  const cp2 = createCheckpoint(repo, { message: 'second snapshot' });

  const ui = await startUi({ port: 0 });
  try {
    // 1. GET /api/checkpoints?cwd=...
    const resList = await req(ui.port, `/api/checkpoints?cwd=${encodeURIComponent(repo)}`);
    assert.equal(resList.status, 200);
    const listData = JSON.parse(resList.body);
    assert.ok(Array.isArray(listData.checkpoints));
    assert.ok(listData.checkpoints.length >= 2);
    assert.ok(listData.checkpoints.some((c) => c.id === cp1.id));
    assert.ok(listData.checkpoints.some((c) => c.id === cp2.id));

    // 2. GET /api/checkpoints/:id/diff
    // Modify file further so diff against cp1 is visible
    writeFileSync(path.join(repo, 'file.txt'), 'version 3 in progress\n', 'utf8');
    const resDiff = await req(ui.port, `/api/checkpoints/${cp1.id}/diff?cwd=${encodeURIComponent(repo)}`);
    assert.equal(resDiff.status, 200);
    const diffData = JSON.parse(resDiff.body);
    assert.equal(diffData.id, cp1.id);
    assert.ok(diffData.diff.includes('version 1') || diffData.diff.includes('version 3'));

    // 3. POST /api/checkpoints/:id/rollback
    const resRollback = await req(ui.port, `/api/checkpoints/${cp1.id}/rollback?cwd=${encodeURIComponent(repo)}`, {
      method: 'POST',
    });
    assert.equal(resRollback.status, 200);
    const rollbackData = JSON.parse(resRollback.body);
    assert.equal(rollbackData.ok, true);
    assert.equal(rollbackData.id, cp1.id);
    assert.ok(rollbackData.restoredOid);

    // Verify workspace restored to cp1 state
    const restoredContent = readFileSync(path.join(repo, 'file.txt'), 'utf8');
    assert.equal(restoredContent, 'version 1\n');

    // 4. Method hardening: rejects GET on rollback or PUT on endpoints
    const resGetRollback = await req(ui.port, `/api/checkpoints/${cp1.id}/rollback?cwd=${encodeURIComponent(repo)}`, {
      method: 'GET',
    });
    assert.equal(resGetRollback.status, 405);
  } finally {
    await ui.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
