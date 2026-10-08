// Git Hidden-Ref Checkpointing inspired by T3 Code.
// Captures instant snapshots of the workspace using isolated GIT_INDEX_FILE plumbing,
// storing commits under refs/agentbridge/checkpoints/<session>/<id> without polluting the
// user's active branch, git log, or staging index.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentError } from '../core/errors.js';

const G = [
  '-c', 'user.name=agentbridge',
  '-c', 'user.email=ab@localhost',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'commit.gpgsign=false',
];

function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  try {
    return execFileSync('git', [...G, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) },
      input: options.input,
    }).trim();
  } catch (e: any) {
    const err = e.stderr ? String(e.stderr).trim() : e.message;
    throw new AgentError('AGENT_FAILED', `git ${args.join(' ')} failed: ${err}`);
  }
}

function findRepoRoot(cwd: string): string {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new AgentError('BAD_OPTION', `Directory is not a git repository: ${cwd}`);
  }
}

export interface CheckpointInfo {
  id: string;
  ref: string;
  commitOid: string;
  treeOid: string;
  createdAt: number;
  message: string;
  sessionId?: string;
}

export interface CheckpointOptions {
  message?: string;
  sessionId?: string;
}

export function createCheckpoint(cwd: string = process.cwd(), options: CheckpointOptions = {}): CheckpointInfo {
  const root = findRepoRoot(cwd);
  const sessionId = options.sessionId || 'default';
  const checkpointId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const ref = `refs/agentbridge/checkpoints/${sessionId}/${checkpointId}`;
  const message = options.message || `checkpoint ${checkpointId}`;

  // Isolated index file to ensure the developer's .git/index is NEVER touched
  const tempIndexFile = path.join(tmpdir(), `ab-cp-index-${checkpointId}.tmp`);
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndexFile };

  try {
    // Check if HEAD exists
    let hasHead = false;
    let headOid = '';
    try {
      headOid = git(root, ['rev-parse', 'HEAD']);
      hasHead = true;
    } catch {
      hasHead = false;
    }

    if (hasHead) {
      // Seed the isolated index with the current HEAD tree
      git(root, ['read-tree', headOid], { env });
    }

    // Add current working tree changes into the isolated index
    git(root, ['add', '-A'], { env });

    // Write tree from isolated index
    const treeOid = git(root, ['write-tree'], { env });

    // Commit the tree without advancing any branch
    const commitArgs = ['commit-tree', treeOid, '-m', `agentbridge checkpoint: ${message}`];
    if (hasHead) {
      commitArgs.push('-p', headOid);
    }
    const commitOid = git(root, commitArgs);

    // Update hidden ref
    git(root, ['update-ref', ref, commitOid]);

    return {
      id: checkpointId,
      ref,
      commitOid,
      treeOid,
      createdAt: Date.now(),
      message,
      sessionId,
    };
  } finally {
    try {
      if (existsSync(tempIndexFile)) rmSync(tempIndexFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function listCheckpoints(cwd: string = process.cwd(), sessionId?: string): CheckpointInfo[] {
  const root = findRepoRoot(cwd);
  const pattern = sessionId
    ? `refs/agentbridge/checkpoints/${sessionId}/`
    : 'refs/agentbridge/checkpoints/';

  let raw = '';
  try {
    raw = git(root, ['for-each-ref', '--format=%(refname)|%(objectname)|%(subject)', pattern]);
  } catch {
    return [];
  }

  if (!raw) return [];

  const list: CheckpointInfo[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [ref, commitOid, subject] = line.split('|');
    const parts = ref.split('/');
    const id = parts[parts.length - 1];
    const sess = parts.length > 4 ? parts[3] : 'default';
    list.push({
      id,
      ref,
      commitOid,
      treeOid: '',
      createdAt: Number(id.split('-')[0]) || Date.now(),
      message: (subject || '').replace(/^agentbridge checkpoint:\s*/, ''),
      sessionId: sess,
    });
  }

  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export function rollbackCheckpoint(cwd: string = process.cwd(), checkpointId: string): { restoredOid: string } {
  const root = findRepoRoot(cwd);
  const all = listCheckpoints(root);
  const target = all.find((c) => c.id === checkpointId || c.ref.endsWith(`/${checkpointId}`));
  if (!target) {
    throw new AgentError('BAD_OPTION', `Checkpoint not found: ${checkpointId}`);
  }

  // Restore working tree files directly from the checkpoint commit
  git(root, ['checkout', target.commitOid, '--', '.']);

  // Clean untracked files that didn't exist in the checkpoint
  try {
    git(root, ['clean', '-fd']);
  } catch {
    /* ignore clean errors */
  }

  return { restoredOid: target.commitOid };
}

export function diffCheckpoint(cwd: string = process.cwd(), checkpointId: string): string {
  const root = findRepoRoot(cwd);
  const all = listCheckpoints(root);
  const target = all.find((c) => c.id === checkpointId || c.ref.endsWith(`/${checkpointId}`));
  if (!target) {
    throw new AgentError('BAD_OPTION', `Checkpoint not found: ${checkpointId}`);
  }

  const tempIndexFile = path.join(tmpdir(), `ab-cp-diff-${randomBytes(4).toString('hex')}.tmp`);
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndexFile };
  try {
    try {
      const head = git(root, ['rev-parse', 'HEAD']);
      git(root, ['read-tree', head], { env });
    } catch {
      /* ignore */
    }
    git(root, ['add', '-A'], { env });
    const currentTree = git(root, ['write-tree'], { env });
    return git(root, ['diff', target.commitOid, currentTree]);
  } finally {
    try {
      if (existsSync(tempIndexFile)) rmSync(tempIndexFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function deleteCheckpoint(cwd: string = process.cwd(), checkpointId: string): boolean {
  const root = findRepoRoot(cwd);
  const all = listCheckpoints(root);
  const target = all.find((c) => c.id === checkpointId || c.ref.endsWith(`/${checkpointId}`));
  if (!target) return false;

  git(root, ['update-ref', '-d', target.ref]);
  return true;
}
