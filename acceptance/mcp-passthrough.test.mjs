import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getPassthroughMcpServers, resolvePassthrough } from '../dist/bridge/attach.js';
import {
  linkResource,
  unlinkResource,
  mirrorCodexMcp,
  codexMcpTables,
  syncSharedResources,
  findGitRoot,
  projectSkillDirs,
  skillRoots,
  seedProjectSkills,
} from '../dist/core/shared-resources.js';
import { addAccount, removeAccount } from '../dist/core/accounts.js';
import { makeAgentDir, destroyAgentDir } from '../dist/adapters/pi.js';
import { validateOptions } from '../dist/index.js';
import { createSandbox } from '../dist/extras/worktree.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ab-share-test-'));
const write = (f, c = 'x') => {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, c);
};
const skill = (root, name) => write(path.join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
const mcpFile = (dir, servers) => write(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: servers }));
const ENV = (extra = {}) => ({ AGENTBRIDGE_MCP_PASSTHROUGH: 'rea', ...extra });

// ---------------------------------------------------------------- passthrough gates

test('passthrough: offline gate blocks everything', () => {
  const d = tmp();
  try {
    mcpFile(d, { rea: { command: 'node', args: ['rea.js'] } });
    assert.deepEqual(getPassthroughMcpServers({ sourceDir: d, offline: true, permissions: 'full', env: ENV() }), {});
    assert.deepEqual(getPassthroughMcpServers({ sourceDir: d, permissions: 'full', env: ENV({ AGENTBRIDGE_OFFLINE: '1' }) }), {});
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('passthrough: read-only and plan get nothing', () => {
  const d = tmp();
  try {
    mcpFile(d, { rea: { command: 'node' } });
    for (const permissions of ['read-only', 'plan']) {
      assert.deepEqual(getPassthroughMcpServers({ sourceDir: d, permissions, env: ENV() }), {});
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('passthrough: operator allowlist is the ceiling, the caller can only narrow it', () => {
  const d = tmp();
  try {
    mcpFile(d, {
      rea: { command: 'node', args: ['rea.js'], env: { FOO: 'bar' }, exposure: 'deferred' },
      other: { command: 'other' },
      agentbridge: { command: 'node' },
    });
    // No operator allowlist: a caller asking for servers gets nothing.
    assert.deepEqual(getPassthroughMcpServers({ sourceDir: d, permissions: 'edit', passthrough: ['rea'], env: {} }), {});
    // Caller cannot widen: asking for "other" or "*" does not exceed {rea}.
    const widen = getPassthroughMcpServers({ sourceDir: d, permissions: 'edit', passthrough: ['other'], env: ENV() });
    assert.deepEqual(widen, {});
    const star = getPassthroughMcpServers({ sourceDir: d, permissions: 'edit', passthrough: ['*'], env: ENV() });
    assert.deepEqual(Object.keys(star), ['rea']);
    // Default: whole allowlist; exposure is forced to direct, env/args preserved, agentbridge never copied.
    const res = getPassthroughMcpServers({ sourceDir: d, permissions: 'full', env: ENV() });
    assert.deepEqual(Object.keys(res), ['rea']);
    assert.equal(res.rea.exposure, 'direct');
    assert.deepEqual(res.rea.args, ['rea.js']);
    assert.deepEqual(res.rea.env, { FOO: 'bar' });
    // A "*" ceiling lets the caller pick any of them.
    const any = getPassthroughMcpServers({ sourceDir: d, permissions: 'full', passthrough: ['other'], env: ENV({ AGENTBRIDGE_MCP_PASSTHROUGH: '*' }) });
    assert.deepEqual(Object.keys(any), ['other']);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('passthrough: also reads the project .mcp.json, skips non-stdio servers', () => {
  const d = tmp();
  const proj = tmp();
  try {
    mcpFile(d, {});
    mkdirSync(path.join(proj, '.git'));
    write(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { rea: { command: 'node' }, http: { url: 'http://x' } } }));
    const sub = path.join(proj, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    const res = getPassthroughMcpServers({
      sourceDir: d,
      cwd: sub,
      permissions: 'edit',
      env: ENV({ AGENTBRIDGE_MCP_PASSTHROUGH: 'rea,http' }),
    });
    assert.deepEqual(Object.keys(res), ['rea']);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('validateOptions accepts skills and mcpPassthrough (they used to be rejected as unknown options)', () => {
  const o = validateOptions({ prompt: 'hi', skills: true, mcpPassthrough: ['rea'] });
  assert.equal(o.skills, true);
});

// ---------------------------------------------------------------- passthrough drops

test('resolvePassthrough reports why each explicitly requested server was dropped', () => {
  const d = tmp();
  try {
    mcpFile(d, { rea: { command: 'node', args: ['rea.js'] }, urlsrv: { url: 'http://x' } });
    // Offline drops every requested name.
    const off = resolvePassthrough({ sourceDir: d, offline: true, permissions: 'full', passthrough: ['rea', 'db'], env: ENV() });
    assert.deepEqual(off.servers, {});
    assert.deepEqual(off.drops, [
      { name: 'rea', reason: 'offline mode' },
      { name: 'db', reason: 'offline mode' },
    ]);
    // Read-only drops every requested name.
    const ro = resolvePassthrough({ sourceDir: d, permissions: 'read-only', passthrough: ['rea'], env: ENV() });
    assert.deepEqual(ro.servers, {});
    assert.deepEqual(ro.drops, [{ name: 'rea', reason: 'permissions "read-only" blocks MCP passthrough' }]);
    // No operator allowlist set.
    const noAllow = resolvePassthrough({ sourceDir: d, permissions: 'edit', passthrough: ['rea'], env: {} });
    assert.deepEqual(noAllow.drops, [{ name: 'rea', reason: 'operator allowlist AGENTBRIDGE_MCP_PASSTHROUGH is not set' }]);
    // Requested name outside the allowlist.
    const na = resolvePassthrough({ sourceDir: d, permissions: 'edit', passthrough: ['other'], env: ENV() });
    assert.deepEqual(na.servers, {});
    assert.deepEqual(na.drops, [{ name: 'other', reason: 'not in operator allowlist' }]);
    // Allowed but absent from every mcp.json source.
    const nf = resolvePassthrough({ sourceDir: d, permissions: 'edit', passthrough: ['ghost'], env: ENV({ AGENTBRIDGE_MCP_PASSTHROUGH: 'rea,ghost' }) });
    assert.deepEqual(nf.servers, {});
    assert.deepEqual(nf.drops, [{ name: 'ghost', reason: 'not found in any mcp.json source' }]);
    // Allowed but not a stdio server.
    const ns = resolvePassthrough({ sourceDir: d, permissions: 'edit', passthrough: ['urlsrv'], env: ENV({ AGENTBRIDGE_MCP_PASSTHROUGH: 'rea,urlsrv' }) });
    assert.deepEqual(ns.servers, {});
    assert.deepEqual(ns.drops, [{ name: 'urlsrv', reason: 'not a stdio server (only command servers are passed)' }]);
    // A "*" ask expands to the allowlist: drops only for allowed-but-invalid or not-found names.
    const star = resolvePassthrough({ sourceDir: d, permissions: 'edit', passthrough: ['*'], env: ENV({ AGENTBRIDGE_MCP_PASSTHROUGH: 'rea,ghost,urlsrv' }) });
    assert.deepEqual(Object.keys(star.servers), ['rea']);
    assert.deepEqual(star.drops, [
      { name: 'urlsrv', reason: 'not a stdio server (only command servers are passed)' },
      { name: 'ghost', reason: 'not found in any mcp.json source' },
    ]);
    // No explicit ask: nothing is reported even when the default allowlist does not fully land.
    const silent = resolvePassthrough({ sourceDir: d, permissions: 'edit', env: ENV({ AGENTBRIDGE_MCP_PASSTHROUGH: 'rea,ghost' }) });
    assert.deepEqual(Object.keys(silent.servers), ['rea']);
    assert.deepEqual(silent.drops, []);
    // Everything requested landed: no drops.
    const ok = resolvePassthrough({ sourceDir: d, permissions: 'edit', passthrough: ['rea'], env: ENV() });
    assert.deepEqual(ok.drops, []);
    assert.deepEqual(getPassthroughMcpServers({ sourceDir: d, permissions: 'edit', passthrough: ['rea'], env: ENV() }), ok.servers);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- linking

test('linkResource links a directory, refuses to overwrite, and unlink never touches the target', () => {
  const d = tmp();
  try {
    const src = path.join(d, 'src', 'skills');
    skill(src, 'one');
    const dest = path.join(d, 'dest', 'skills');
    const r = linkResource(src, dest);
    assert.ok(r === 'linked' || r === 'copied', r);
    assert.ok(existsSync(path.join(dest, 'one', 'SKILL.md')));
    assert.equal(linkResource(src, dest), 'exists');
    assert.equal(linkResource(path.join(d, 'nope'), path.join(d, 'x')), 'missing');
    if (r === 'linked') {
      assert.equal(unlinkResource(dest), true);
      assert.ok(existsSync(path.join(src, 'one', 'SKILL.md')), 'target must survive unlink');
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('codex MCP tables are mirrored once, without overriding the profile', () => {
  const d = tmp();
  try {
    const sys = path.join(d, 'sys');
    const prof = path.join(d, 'prof');
    write(
      path.join(sys, 'config.toml'),
      ['model = "x"', '', '[mcp_servers.rea]', 'command = "node"', '', '[mcp_servers.rea.env]', 'A = "1"', '', '[other]', 'k = 1', '', '[mcp_servers.db]', 'command = "db"', ''].join('\n')
    );
    write(path.join(prof, 'config.toml'), '[mcp_servers.db]\ncommand = "mine"\n');
    assert.deepEqual(Object.keys(codexMcpTables(readFileSync(path.join(sys, 'config.toml'), 'utf8'))).sort(), ['db', 'rea']);
    assert.deepEqual(mirrorCodexMcp(sys, prof), ['rea']);
    const out = readFileSync(path.join(prof, 'config.toml'), 'utf8');
    assert.match(out, /command = "mine"/);
    assert.match(out, /\[mcp_servers\.rea\.env\]/);
    assert.doesNotMatch(out, /\[other\]/);
    assert.deepEqual(mirrorCodexMcp(sys, prof), [], 'idempotent');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('syncSharedResources shares skills but never credentials', () => {
  const d = tmp();
  try {
    const sys = path.join(d, 'sys');
    const prof = path.join(d, 'prof');
    skill(path.join(sys, 'skills'), 'one');
    write(path.join(sys, 'auth.json'), '{"secret":1}');
    write(path.join(sys, 'AGENTS.md'), 'rules');
    const rep = syncSharedResources('codex', sys, prof);
    assert.ok([...rep.linked, ...rep.copied].includes('skills'));
    assert.ok(existsSync(path.join(prof, 'skills', 'one', 'SKILL.md')));
    assert.ok(existsSync(path.join(prof, 'AGENTS.md')));
    assert.equal(existsSync(path.join(prof, 'auth.json')), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('addAccount shares skills into a new profile and --purge never deletes the real skills', () => {
  const d = tmp();
  const prev = process.env.CODEX_HOME;
  try {
    const sys = path.join(d, 'codex-home');
    skill(path.join(sys, 'skills'), 'keep-me');
    process.env.CODEX_HOME = sys;
    const base = path.join(d, 'ab');
    const rec = addAccount('codex', 'work', { baseDir: base });
    assert.ok(existsSync(path.join(rec.profileDir, 'skills', 'keep-me', 'SKILL.md')));
    const rec2 = addAccount('codex', 'bare', { baseDir: base, share: false });
    assert.equal(existsSync(path.join(rec2.profileDir, 'skills')), false);
    assert.equal(removeAccount('codex', 'work', { deleteProfileDir: true, baseDir: base }), true);
    assert.equal(existsSync(rec.profileDir), false);
    assert.ok(existsSync(path.join(sys, 'skills', 'keep-me', 'SKILL.md')), 'real skills must survive a purge');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    rmSync(d, { recursive: true, force: true });
  }
});

test('pi sandbox links skills only when asked, and destroying it keeps the real skills', () => {
  const d = tmp();
  try {
    const src = path.join(d, 'agent');
    skill(path.join(src, 'skills'), 'rea');
    write(path.join(src, 'settings.json'), '{}');
    const off = makeAgentDir({ src });
    assert.equal(existsSync(path.join(off.dir, 'skills')), false);
    destroyAgentDir(off);
    const on = makeAgentDir({ src, shareSkills: true });
    assert.ok(existsSync(path.join(on.dir, 'skills', 'rea', 'SKILL.md')));
    destroyAgentDir(on);
    assert.equal(existsSync(on.dir), false);
    assert.ok(existsSync(path.join(src, 'skills', 'rea', 'SKILL.md')), 'real skills must survive');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- skill roots

test('project skills are found from a subfolder up to the git root, and not beyond it', () => {
  const d = tmp();
  try {
    skill(path.join(d, 'above', '.agents', 'skills'), 'outside');
    const repo = path.join(d, 'above', 'repo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    skill(path.join(repo, '.agents', 'skills'), 'root-skill');
    const sub = path.join(repo, 'pkg', 'deep');
    skill(path.join(sub, '.claude', 'skills'), 'local-skill');
    assert.equal(findGitRoot(sub), repo);
    const dirs = projectSkillDirs(sub).map((p) => path.relative(d, p).replace(/\\/g, '/'));
    assert.deepEqual(dirs.sort(), ['above/repo/.agents/skills', 'above/repo/pkg/deep/.claude/skills']);
    const roots = skillRoots(sub, path.join(d, 'nohome'));
    assert.ok(roots.every((r) => r.scope === 'project') && roots.length === 2);
    assert.equal(roots.reduce((n, r) => n + r.skills, 0), 2);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('seedProjectSkills copies only what the worktree lacks', () => {
  const d = tmp();
  try {
    const from = path.join(d, 'from');
    const to = path.join(d, 'to');
    skill(path.join(from, '.agents', 'skills'), 'a');
    skill(path.join(from, '.claude', 'skills'), 'b');
    skill(path.join(to, '.claude', 'skills'), 'already');
    mkdirSync(to, { recursive: true });
    assert.deepEqual(seedProjectSkills(from, to), [path.join('.agents', 'skills')]);
    assert.ok(existsSync(path.join(to, '.agents', 'skills', 'a', 'SKILL.md')));
    assert.equal(existsSync(path.join(to, '.claude', 'skills', 'b')), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('git worktree sandbox contains untracked project skills and they are not part of the diff', () => {
  const d = tmp();
  let sb;
  try {
    const run = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, stdio: 'pipe' });
    run('init', '-q');
    write(path.join(d, 'f.txt'), '1');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    skill(path.join(d, '.agents', 'skills'), 'untracked');
    sb = createSandbox(d);
    assert.ok(existsSync(path.join(sb.root, '.agents', 'skills', 'untracked', 'SKILL.md')));
    assert.deepEqual(sb.diff().files, []);
  } finally {
    sb?.cleanup();
    rmSync(d, { recursive: true, force: true });
  }
});
