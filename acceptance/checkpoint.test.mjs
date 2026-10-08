import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCheckpoint, listCheckpoints, rollbackCheckpoint, diffCheckpoint } from '../dist/extras/checkpoint.js';

test('createCheckpoint and rollbackCheckpoint restore exact working directory state', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'ab-cp-test-'));
  execSync('git init && git config user.name test && git config user.email test@test.com && git commit --allow-empty -m init', { cwd: repo });
  
  writeFileSync(path.join(repo, 'file.txt'), 'version 1 original\n');
  const cp1 = createCheckpoint(repo, { message: 'before changes' });
  
  assert.ok(cp1.id);
  assert.ok(cp1.ref.startsWith('refs/agentbridge/checkpoints/'));
  assert.ok(cp1.commitOid);

  // List should contain cp1
  const list = listCheckpoints(repo);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, cp1.id);
  assert.equal(list[0].message, 'before changes');

  // Modify file and add new unwanted file
  writeFileSync(path.join(repo, 'file.txt'), 'version 2 corrupted\n');
  writeFileSync(path.join(repo, 'unwanted.txt'), 'delete me\n');

  // Diff should show changes
  const diff = diffCheckpoint(repo, cp1.id);
  assert.match(diff, /version 2 corrupted/);

  // Rollback to cp1
  rollbackCheckpoint(repo, cp1.id);

  // File should be back to version 1
  const content = readFileSync(path.join(repo, 'file.txt'), 'utf8');
  assert.equal(content, 'version 1 original\n');

  rmSync(repo, { recursive: true, force: true });
});
