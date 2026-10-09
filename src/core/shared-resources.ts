// Shared-resource helpers: keep isolated agent homes useful (skills, prompts, plugins, MCP servers)
// without ever sharing credentials, sessions or history.
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Per-agent entries that are safe to share into an isolated home. Credentials (auth.json, .credentials.json),
 * sessions and history are deliberately NOT listed.
 */
export const SHARED_RESOURCES: Record<string, string[]> = {
  claude: ['skills', 'commands', 'agents', 'plugins', 'CLAUDE.md'],
  codex: ['skills', 'prompts', 'hooks', 'plugins', 'AGENTS.md'],
  pi: ['skills', 'extensions', 'prompts', 'themes', 'mcp.json', 'AGENTS.md'],
};

export type LinkResult = 'linked' | 'copied' | 'exists' | 'missing' | 'failed';

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Make `dest` point at `src`. Directories use a symlink (an NTFS junction on Windows, which needs no admin rights);
 * if linking is refused, falls back to a copy. Never overwrites something that already exists at `dest`.
 */
export function linkResource(src: string, dest: string): LinkResult {
  if (!existsSync(src)) return 'missing';
  if (existsSync(dest) || isLink(dest)) return 'exists';
  try {
    mkdirSync(path.dirname(dest), { recursive: true });
    const dir = statSync(src).isDirectory();
    try {
      symlinkSync(src, dest, dir && process.platform === 'win32' ? 'junction' : undefined);
      return 'linked';
    } catch {
      /* fall through to copy */
    }
    cpSync(src, dest, { recursive: true });
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** Remove a link created by linkResource without touching its target. Returns true if it was a link and is gone. */
export function unlinkResource(p: string): boolean {
  if (!isLink(p)) return false;
  try {
    unlinkSync(p);
  } catch {
    try {
      rmdirSync(p);
    } catch {
      /* handled below */
    }
  }
  return !isLink(p);
}

const MCP_HEADER = /^\s*\[\s*mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)(\.[^\]]*)?\]\s*$/;
const ANY_HEADER = /^\s*\[/;

/** Split a codex config.toml into { serverName -> text of its [mcp_servers.<name>*] tables }. */
export function codexMcpTables(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = MCP_HEADER.exec(line);
    if (m) cur = m[1].replace(/^"|"$/g, '');
    else if (ANY_HEADER.test(line)) cur = null;
    if (cur) out[cur] = (out[cur] ? out[cur] + '\n' : '') + line;
  }
  return out;
}

/** Append the MCP server tables found in srcDir/config.toml that destDir/config.toml does not define yet. */
export function mirrorCodexMcp(srcDir: string, destDir: string): string[] {
  const srcFile = path.join(srcDir, 'config.toml');
  if (!existsSync(srcFile)) return [];
  try {
    const src = codexMcpTables(readFileSync(srcFile, 'utf8'));
    const destFile = path.join(destDir, 'config.toml');
    const existing = existsSync(destFile) ? readFileSync(destFile, 'utf8') : '';
    const have = codexMcpTables(existing);
    const added = Object.keys(src).filter((n) => !(n in have));
    if (!added.length) return [];
    mkdirSync(destDir, { recursive: true });
    const block = added.map((n) => src[n]).join('\n\n');
    writeFileSync(destFile, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${existing ? '\n' : ''}# mirrored by agentbridge\n${block}\n`);
    return added;
  } catch {
    return [];
  }
}

export interface ShareReport {
  linked: string[];
  copied: string[];
  failed: string[];
  mcp: string[];
}

/** Share the safe resources of `srcDir` (the user's real agent dir) into the isolated `destDir`. */
export function syncSharedResources(agent: string, srcDir: string, destDir: string, only?: string[]): ShareReport {
  const rep: ShareReport = { linked: [], copied: [], failed: [], mcp: [] };
  const names = (SHARED_RESOURCES[agent.toLowerCase()] || []).filter((n) => !only || only.includes(n));
  for (const n of names) {
    const r = linkResource(path.join(srcDir, n), path.join(destDir, n));
    if (r === 'linked') rep.linked.push(n);
    else if (r === 'copied') rep.copied.push(n);
    else if (r === 'failed') rep.failed.push(n);
  }
  if (agent.toLowerCase() === 'codex' && (!only || only.includes('config.toml'))) rep.mcp = mirrorCodexMcp(srcDir, destDir);
  return rep;
}

// ---------------------------------------------------------------- skill roots

/** Nearest ancestor of `cwd` (inclusive) that holds a `.git` entry, or null. */
export function findGitRoot(cwd: string): string | null {
  let d = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export interface SkillRoot {
  path: string;
  scope: 'global' | 'project';
  skills: number;
}

const PROJECT_SKILL_DIRS = [path.join('.agents', 'skills'), path.join('.claude', 'skills')];

export function countSkills(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(
      (e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(path.join(dir, e.name, 'SKILL.md'))
    ).length;
  } catch {
    return 0;
  }
}

/** Project-level skill directories for `cwd`, walking up to the git root so a subfolder or worktree still sees them. */
export function projectSkillDirs(cwd: string): string[] {
  const top = findGitRoot(cwd);
  const stop = top ? path.resolve(top) : path.resolve(cwd);
  const out: string[] = [];
  let d = path.resolve(cwd);
  for (;;) {
    for (const rel of PROJECT_SKILL_DIRS) {
      const p = path.join(d, rel);
      if (existsSync(p)) out.push(p);
    }
    if (d === stop) break;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/** Every skill directory visible from `cwd`: user-global roots plus project roots up to the git root. */
export function skillRoots(cwd: string, home = homedir()): SkillRoot[] {
  const global = [
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
    path.join(home, '.pi', 'agent', 'skills'),
    path.join(home, '.gemini', 'config', 'skills'),
  ];
  const roots: SkillRoot[] = [];
  const seen = new Set<string>();
  const add = (p: string, scope: SkillRoot['scope']) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key) || !existsSync(p)) return;
    seen.add(key);
    roots.push({ path: p, scope, skills: countSkills(p) });
  };
  for (const g of global) add(g, 'global');
  for (const p of projectSkillDirs(cwd)) add(p, 'project');
  return roots;
}

/**
 * Copy project skill directories that exist in `fromRoot` but not in `toRoot` (typically untracked ones that a
 * fresh git worktree does not contain). Returns the relative paths copied.
 */
export function seedProjectSkills(fromRoot: string, toRoot: string): string[] {
  const done: string[] = [];
  for (const rel of PROJECT_SKILL_DIRS) {
    const src = path.join(fromRoot, rel);
    const dest = path.join(toRoot, rel);
    if (!existsSync(src) || existsSync(dest)) continue;
    try {
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      done.push(rel);
    } catch {
      /* best effort */
    }
  }
  return done;
}
