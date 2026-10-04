// feat-worktree: run an agent in a throw-away git worktree (or, when cwd is not a git repo, a temp copy) and return the diff.
// The original directory is never touched. Uncommitted TRACKED changes of a git cwd are carried into the worktree as its baseline;
// untracked files are not copied in git mode (copy mode copies everything except node_modules and .git).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBudgeted } from './budget.mjs';

const G = ['-c', 'user.name=agentbridge', '-c', 'user.email=ab@localhost', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false'];
const git = (cwd, args, o = {}) => execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...o });
const tryGit = (cwd, args, o) => { try { return git(cwd, args, o); } catch { return null; } };

/** Create the sandbox. Returns {mode, dir, cwd, diff(), cleanup()}. */
export function createSandbox(cwd = process.cwd()) {
  cwd = realpathSync(path.resolve(cwd));
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-wt-'));
  const top = tryGit(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  const hasHead = top && tryGit(cwd, ['rev-parse', '--verify', 'HEAD']) != null;
  let mode, root = dir, sub = '';
  if (hasHead) {
    const wt = path.join(dir, 'wt');
    git(top, ['worktree', 'add', '--detach', wt, 'HEAD']); mode = 'git-worktree'; root = wt;
    sub = path.relative(realpathSync(top), cwd);
    const patch = tryGit(top, ['diff', 'HEAD', '--binary']);
    if (patch && patch.trim()) {
      try { git(wt, ['apply', '--whitespace=nowarn', '-'], { input: patch }); git(wt, ['add', '-A']); git(wt, ['commit', '-q', '-m', 'ab-baseline']); } catch { /* baseline stays HEAD */ }
    }
    const cleanup = () => { tryGit(top, ['worktree', 'remove', '--force', wt]); tryGit(top, ['worktree', 'prune']); rmSync(dir, { recursive: true, force: true }); };
    return finish(mode, dir, root, sub, cleanup);
  }
  mode = 'copy'; root = path.join(dir, 'copy'); mkdirSync(root);
  cpSync(cwd, root, { recursive: true, filter: (s) => { const b = path.basename(s); return b !== 'node_modules' && b !== '.git'; } });
  git(root, ['init', '-q']); git(root, ['add', '-A']); git(root, ['commit', '-q', '-m', 'ab-baseline', '--allow-empty']);
  return finish(mode, dir, root, '', () => rmSync(dir, { recursive: true, force: true }));
}

function finish(mode, dir, root, sub, cleanup) {
  return {
    mode, dir, root, cwd: sub ? path.join(root, sub) : root, cleanup,
    diff() {
      git(root, ['add', '-A']);
      const files = git(root, ['diff', '--cached', '--name-only', 'HEAD']).split('\n').map((s) => s.trim()).filter(Boolean);
      return { diff: git(root, ['diff', '--cached', '--binary', 'HEAD']), files };
    },
  };
}

/**
 * Run fn(sandboxCwd) in a sandbox; resolves {value, diff, files, mode}. keep:true leaves the directory (path in .path).
 */
export async function withWorktree(cwd, fn, { keep = false } = {}) {
  const sb = createSandbox(cwd);
  try {
    const value = await fn(sb.cwd, sb);
    const d = sb.diff();
    return { value, ...d, mode: sb.mode, path: keep ? sb.root : null };
  } finally { if (!keep) sb.cleanup(); }
}

/** Run an agent in the sandbox. Returns the Result plus `.worktree = {mode, diff, files}`. */
export async function runInWorktree(agent, opts, { runOne, budget, gen, onEvent, keep } = {}) {
  const one = runOne || ((a, p) => runBudgeted(a, p, budget || {}, { gen, onEvent }));
  const { value, diff, files, mode, path: kept } = await withWorktree(opts.cwd || process.cwd(), (cwd) => one(agent, { ...opts, cwd }), { keep });
  return { ...value, worktree: { mode, diff, files, path: kept } };
}
export const _exists = existsSync;
