// feat-worktree: run an agent in a throw-away git worktree (or, when cwd is not a git repo, a temp copy) and return the diff.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBudgeted } from './budget.js';
import { seedProjectSkills } from '../core/shared-resources.js';

const G = [
  '-c',
  'user.name=agentbridge',
  '-c',
  'user.email=ab@localhost',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'commit.gpgsign=false',
];

const git = (cwd: string, args: string[], o: any = {}): string =>
  execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...o });

const tryGit = (cwd: string, args: string[], o?: any): string | null => {
  try {
    return git(cwd, args, o);
  } catch {
    return null;
  }
};

export interface Sandbox {
  mode: 'git-worktree' | 'copy';
  dir: string;
  root: string;
  cwd: string;
  sub: string;
  cleanup: () => void;
  diff: (isolatedIndex?: boolean) => { diff: string; files: string[] };
}

function normalizePath(p: string): string {
  try {
    p = realpathSync(path.resolve(p));
  } catch {
    p = path.resolve(p);
  }
  if (process.platform === 'win32' && /^[a-z]:/i.test(p)) {
    p = p[0].toUpperCase() + p.slice(1);
  }
  return path.normalize(p);
}

export function createSandbox(cwd = process.cwd()): Sandbox {
  cwd = normalizePath(cwd);
  const dir = normalizePath(mkdtempSync(path.join(tmpdir(), 'ab-wt-')));
  const rawTop = tryGit(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  const top = rawTop ? normalizePath(rawTop) : null;
  const hasHead = top && tryGit(cwd, ['rev-parse', '--verify', 'HEAD']) != null;
  let mode: 'git-worktree' | 'copy',
    root = dir,
    sub = '';
  if (hasHead && top) {
    const wt = normalizePath(path.join(dir, 'wt'));
    git(top, ['worktree', 'add', '--detach', wt, 'HEAD']);
    mode = 'git-worktree';
    root = wt;
    let rel = '';
    if (process.platform === 'win32') {
      rel = top.toLowerCase() === cwd.toLowerCase() ? '' : path.relative(top, cwd);
    } else {
      rel = top === cwd ? '' : path.relative(top, cwd);
    }
    sub = !rel || rel === '.' || rel.startsWith('..') ? '' : rel;
    const patch = tryGit(top, ['diff', 'HEAD', '--binary']);
    let dirty = false;
    if (patch && patch.trim()) {
      try {
        git(wt, ['apply', '--whitespace=nowarn', '-'], { input: patch });
        dirty = true;
      } catch (err: any) {
        throw new Error(`Failed to apply working tree modifications to sandbox worktree: ${err.stderr || err.message}`);
      }
    }
    // Sync relevant untracked files into the sandbox worktree
    const untracked = tryGit(top, ['status', '--porcelain=v1', '-uall']);
    if (untracked) {
      for (const line of untracked.split('\n')) {
        if (line.startsWith('?? ')) {
          const relPath = line.slice(3).trim();
          if (relPath && !relPath.startsWith('.git') && !relPath.includes('node_modules')) {
            const src = path.join(top, relPath);
            const dst = path.join(wt, relPath);
            try {
              if (existsSync(src)) {
                mkdirSync(path.dirname(dst), { recursive: true });
                cpSync(src, dst, { recursive: true });
                dirty = true;
              }
            } catch {}
          }
        }
      }
    }
    if (seedProjectSkills(top, wt).length) dirty = true;
    if (dirty) {
      try {
        git(wt, ['add', '-A']);
        git(wt, ['commit', '-q', '-m', 'ab-baseline']);
      } catch (err: any) {
        throw new Error(`Failed to commit sandbox baseline: ${err.stderr || err.message}`);
      }
    }
    const cleanup = () => {
      tryGit(top, ['worktree', 'remove', '--force', wt]);
      tryGit(top, ['worktree', 'prune']);
      // Best effort: a child process can still hold the sandbox as cwd (EBUSY/EPERM on Windows).
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };
    return finish(mode, dir, root, sub, cleanup);
  }
  mode = 'copy';
  root = path.join(dir, 'copy');
  mkdirSync(root);
  cpSync(cwd, root, {
    recursive: true,
    filter: (s) => {
      const b = path.basename(s);
      return b !== 'node_modules' && b !== '.git';
    },
  });
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'ab-baseline', '--allow-empty']);
  return finish(mode, dir, root, '', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}

function finish(mode: 'git-worktree' | 'copy', dir: string, root: string, sub: string, cleanup: () => void): Sandbox {
  return {
    mode,
    dir,
    root,
    sub,
    cwd: sub ? path.join(root, sub) : root,
    cleanup,
    diff(isolatedIndex = false) {
      const env = isolatedIndex ? { ...process.env, GIT_INDEX_FILE: path.join(dir, '.git-tmp-index') } : process.env;
      git(root, ['add', '-A'], { env });
      const filesArgs = sub ? ['diff', '--cached', '--name-only', 'HEAD', '--', sub] : ['diff', '--cached', '--name-only', 'HEAD'];
      const diffArgs = sub ? ['diff', '--cached', '--binary', 'HEAD', '--', sub] : ['diff', '--cached', '--binary', 'HEAD'];
      const rawFiles = git(root, filesArgs, { env })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const files = sub
        ? rawFiles.map((f) => (path.isAbsolute(f) ? f : path.relative(sub, f))).map((f) => f.replace(/\\/g, '/'))
        : rawFiles;
      const diff = git(root, diffArgs, { env });
      if (isolatedIndex) {
        try { rmSync(path.join(dir, '.git-tmp-index'), { force: true }); } catch {}
      }
      return { diff, files };
    },
  };
}

export async function withWorktree<T>(
  cwd: string,
  fn: (sandboxCwd: string, sandbox: Sandbox) => Promise<T>,
  { keep = false }: { keep?: boolean } = {}
): Promise<{ value: T; diff: string; files: string[]; mode: 'git-worktree' | 'copy'; path: string | null }> {
  const sb = createSandbox(cwd);
  try {
    const value = await fn(sb.cwd, sb);
    const d = sb.diff();
    return { value, ...d, mode: sb.mode, path: keep ? sb.root : null };
  } finally {
    if (!keep) sb.cleanup();
  }
}

export async function runInWorktree(agent: any, opts: any, { runOne, budget, gen, onEvent, keep }: any = {}): Promise<any> {
  const one = runOne || ((a: any, p: any) => runBudgeted(a, p, budget || {}, { gen, onEvent }));
  const { value, diff, files, mode, path: kept } = await withWorktree(
    opts.cwd || process.cwd(),
    (cwd) => one(agent, { ...opts, cwd }),
    { keep }
  );
  return { ...(value as any), worktree: { mode, diff, files, path: kept } };
}

export const _exists = existsSync;
