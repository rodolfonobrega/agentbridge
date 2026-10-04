// feat-doctor: environment check. Installed? logged in? versions, models, cwd writable, ports free, git present.
// "Logged in" is checked offline by looking for each CLI's local credential store (no tokens are read out or printed);
// pass {live:true} to also run one tiny real prompt per installed agent, which is the only definitive test.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolveBinary, runCollect } from '../core/spawn.mjs';
import { findBinary as findAgy } from '../adapters/agy.mjs';
import { findBinary as findPi } from '../adapters/pi.mjs';

const home = os.homedir();
const CRED = {
  claude: () => [path.join(home, '.claude', '.credentials.json'), path.join(home, '.claude.json')].find((f) => { try { return f.endsWith('.json') && /oauthAccount|claudeAiOauth/.test(readFileSync(f, 'utf8')); } catch { return false; } }),
  codex: () => [path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json')].find(existsSync),
  opencode: () => [path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'auth.json'), path.join(process.env.LOCALAPPDATA || '', 'opencode', 'auth.json')].find((f) => { try { return Object.keys(JSON.parse(readFileSync(f, 'utf8'))).length > 0; } catch { return false; } }),
};

export function portFree(port, host = '127.0.0.1') {
  return new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(port, host, () => s.close(() => res(true))); });
}

async function version(bin) {
  try { const r = await runCollect(bin, ['--version'], { timeoutMs: 15000 }); const v = (r.stdout || '').trim().split('\n')[0]; return v || null; } catch { return null; }
}

/** doctor({cwd, ports:[8787], live:false, agents}) -> {ok, checks:[{name,status,detail}], agents:{name:{...}}} */
export async function doctor({ cwd = process.cwd(), ports = [8787], live = false, agents = ['claude', 'codex', 'opencode', 'agy', 'pi'], models = true } = {}) {
  const checks = []; const add = (name, status, detail) => checks.push({ name, status, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22 ? 'ok' : 'fail', `v${process.versions.node} (need >= 22)`);
  add('platform', 'ok', `${process.platform} ${os.release()}`);
  const g = resolveBinary('git'); add('git', g ? 'ok' : 'warn', g ? `${g} (needed by --worktree)` : 'not found: --worktree needs git');
  try { const d = mkdtempSync(path.join(cwd, '.ab-doctor-')); writeFileSync(path.join(d, 't'), 'x'); rmSync(d, { recursive: true, force: true }); add('cwd writable', 'ok', cwd); }
  catch (e) { add('cwd writable', 'warn', `${cwd}: ${e.code || e.message} (fine for read-only runs)`); }
  for (const p of ports) { const free = await portFree(p); add(`port ${p}`, free ? 'ok' : 'warn', free ? 'free' : 'in use (pick another with --port)'); }
  const info = {};
  await Promise.all(agents.map(async (name) => {
    const bin = name === 'agy' ? findAgy() : name === 'pi' ? findPi() : resolveBinary(name); const a = info[name] = { installed: !!bin, path: bin, version: null, loggedIn: null, credentials: null, models: null, live: null };
    if (!bin) { add(name, 'fail', 'not installed (not on PATH)'); return; }
    a.version = await version(bin);
    const noOffline = !CRED[name]; // agy keeps its login outside HOME in a place we cannot inspect: only --live can tell
    const cred = CRED[name]?.(); a.credentials = cred ? path.basename(cred) : null; a.loggedIn = noOffline ? null : !!cred;
    if (models) { try { const { agents: reg } = await import('../index.mjs'); a.models = (await Promise.race([reg.models(name), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 20000))])).slice(0, 30); } catch (e) { a.models = null; a.modelsError = e.message; } }
    if (live) {
      try { const { ask } = await import('../index.mjs'); const t0 = Date.now(); const r = await ask(name, { prompt: 'reply with exactly PONG', timeoutMs: 120000, cwd: os.tmpdir(), session: { mode: 'ephemeral' } }); a.live = { ok: /PONG/i.test(r.text), ms: Date.now() - t0 }; a.loggedIn = a.live.ok ? true : a.loggedIn; }
      catch (e) { a.live = { ok: false, error: `${e.code || ''} ${e.message}`.trim() }; if (e.code === 'NOT_LOGGED_IN') a.loggedIn = false; }
    }
    const st = a.loggedIn === false ? 'warn' : (a.live && !a.live.ok ? 'fail' : 'ok');
    add(name, st, `${a.version || 'version unknown'}; ${a.loggedIn === null ? 'login not checkable offline (use --live)' : a.loggedIn ? `logged in (${a.credentials || 'live test'})` : 'no login found (run the CLI login)'}${a.models ? `; ${a.models.length} models` : ''}${a.live ? `; live ${a.live.ok ? `ok ${a.live.ms}ms` : 'FAILED: ' + a.live.error}` : ''}`);
  }));
  checks.sort((x, y) => x.name.localeCompare(y.name));
  return { ok: !checks.some((c) => c.status === 'fail'), checks, agents: info };
}
export const _unlink = unlinkSync;
