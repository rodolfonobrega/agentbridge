// `ab install <agent>`: registers the MCP bridge (+ the agentbridge-delegate skill) in OpenCode, Codex and Antigravity.
// Everything runs against throw-away config homes; the user's real configs are never touched. No model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../src/cli/main.mjs', import.meta.url));
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sandbox = () => {
  const r = tmp('ab-inst-');
  const d = { r, proj: path.join(r, 'proj'), home: path.join(r, 'home'), cx: path.join(r, 'cx'), xdg: path.join(r, 'xdg') };
  for (const k of ['proj', 'home', 'cx', 'xdg']) mkdirSync(d[k]);
  return d;
};
const ab = (d, args) => new Promise((res) => {
  const env = { ...process.env, HOME: d.home, USERPROFILE: d.home, CODEX_HOME: d.cx, XDG_CONFIG_HOME: d.xdg, PI_CODING_AGENT_DIR: path.join(d.r, 'pi'), AGENTBRIDGE_HOME: path.join(d.r, 'ab') };
  const p = spawn(process.execPath, [MAIN, 'install', ...args, '--cwd', d.proj], { env });
  let o = '', e = '';
  p.stdout.on('data', (b) => (o += b)); p.stderr.on('data', (b) => (e += b)); p.on('close', (c) => res({ c, o, e }));
});
const has = (bin) => new Promise((res) => {
  const p = spawn(bin, ['--version'], { shell: process.platform === 'win32', stdio: 'ignore' });
  p.on('error', () => res(false)); p.on('close', (c) => res(c === 0));
});
const skillOk = (d) => {
  const f = path.join(d.proj, '.agents', 'skills', 'agentbridge-delegate', 'SKILL.md');
  assert.ok(existsSync(f), f);
  assert.match(readFileSync(f, 'utf8'), /^---\r?\nname: agentbridge-delegate/);
};

test('opencode: merges into an existing opencode.json, keeps other keys, installs the skill', async () => {
  const d = sandbox();
  writeFileSync(path.join(d.proj, 'opencode.json'), JSON.stringify({ model: 'x/y', mcp: { other: { type: 'local', command: ['z'] } } }));
  const r = await ab(d, ['opencode', '--permissions', 'plan', '--max-depth', '1']);
  assert.equal(r.c, 0, r.e + r.o);
  const cfg = JSON.parse(readFileSync(path.join(d.proj, 'opencode.json'), 'utf8'));
  assert.equal(cfg.model, 'x/y'); assert.ok(cfg.mcp.other);
  assert.equal(cfg.mcp.agentbridge.type, 'local'); assert.deepEqual(cfg.mcp.agentbridge.command.slice(-1), ['bridge']);
  assert.equal(cfg.mcp.agentbridge.environment.AGENTBRIDGE_PERMS, 'plan');
  assert.equal(cfg.mcp.agentbridge.environment.AGENTBRIDGE_MAX_DEPTH, '1');
  skillOk(d);
  assert.equal((await ab(d, ['opencode'])).c, 0, 'idempotent');
});

test('opencode: a config with comments is refused untouched; --no-skill skips the skill', async () => {
  const d = sandbox(); const f = path.join(d.proj, 'opencode.json'); const src = '{ // mine\n "model": "a/b" }';
  writeFileSync(f, src);
  const r = await ab(d, ['opencode']);
  assert.notEqual(r.c, 0); assert.equal(readFileSync(f, 'utf8'), src);
  const d2 = sandbox();
  assert.equal((await ab(d2, ['opencode', '--no-skill'])).c, 0);
  assert.ok(!existsSync(path.join(d2.proj, '.agents')));
});

test('opencode user scope writes into XDG_CONFIG_HOME', async () => {
  const d = sandbox(); const r = await ab(d, ['opencode', '--scope', 'user', '--no-skill']);
  assert.equal(r.c, 0, r.e);
  const cfg = JSON.parse(readFileSync(path.join(d.xdg, 'opencode', 'opencode.json'), 'utf8'));
  assert.ok(cfg.mcp.agentbridge);
});

test('codex: registered in its (isolated) config.toml', { skip: !(await has('codex')) && 'codex is not installed' }, async () => {
  const d = sandbox(); const r = await ab(d, ['codex', '--permissions', 'edit']);
  assert.equal(r.c, 0, r.e + r.o);
  const toml = readFileSync(path.join(d.cx, 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.agentbridge\]/); assert.match(toml, /AGENTBRIDGE_PERMS = "edit"/); assert.match(toml, /bridge/);
  skillOk(d);
});

test('agy: registered in its (isolated) mcp_config.json', { skip: !(await has('agy')) && 'agy is not installed' }, async () => {
  const d = sandbox(); const r = await ab(d, ['agy']);
  assert.equal(r.c, 0, r.e + r.o);
  const cfg = JSON.parse(readFileSync(path.join(d.home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.equal(cfg.mcpServers.agentbridge.env.AGENTBRIDGE_PERMS, 'read-only');
  assert.deepEqual(cfg.mcpServers.agentbridge.args.slice(-1), ['bridge']);
  skillOk(d);
});

test('pi: registered in its (isolated) mcp.json with direct exposure, and the bridge connects', { skip: !(await has('pi')) && 'pi is not installed', timeout: 90000 }, async () => {
  const d = sandbox(); const r = await ab(d, ['pi']);
  assert.equal(r.c, 0, r.e + r.o);
  const cfg = JSON.parse(readFileSync(path.join(d.r, 'pi', 'mcp.json'), 'utf8'));
  const s = cfg.mcpServers.agentbridge;
  assert.equal(s.exposure, 'direct'); assert.equal(s.env.AGENTBRIDGE_PERMS, 'read-only'); assert.deepEqual(s.args.slice(-1), ['bridge']);
  skillOk(d);
  // no model involved: pi only connects to the MCP server and lists its tools
  const l = await new Promise((res) => {
    const p = spawn('pi', ['mcp', 'list', '--json'], { shell: process.platform === 'win32', env: { ...process.env, PI_CODING_AGENT_DIR: path.join(d.r, 'pi'), HOME: d.home, USERPROFILE: d.home }, cwd: d.proj });
    let o = ''; p.stdout.on('data', (b) => (o += b)); p.on('close', (c) => res({ c, o }));
  });
  assert.match(l.o, /ask_claude/);
});

test('unknown target and bad options fail', async () => {
  const d = sandbox();
  assert.notEqual((await ab(d, ['nope'])).c, 0);
  assert.notEqual((await ab(d, ['opencode', '--permissions', 'root'])).c, 0);
  assert.notEqual((await ab(d, ['opencode', '--scope', 'weird'])).c, 0);
});
