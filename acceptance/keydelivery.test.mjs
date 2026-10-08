// Round 7 / N1: the critic reproduced the leak one hop downstream, with NO race needed:
//   - claude adapter writes the attest key in plaintext to %TEMP%/ab-claude-*/mcp.json for the entire child lifetime.
//   - codex adapter passes it via `-c mcp_servers.agentbridge.env={AGENTBRIDGE_ATTEST_KEY="..."}` on the literal command line
//     (readable any time via a plain WMI CommandLine query, no privilege needed).
// Root cause: mcp.mjs handed the key straight into opts.mcpServers.agentbridge.env, which the adapters materialize to disk/argv
// to satisfy each CLI's own --mcp-config mechanism.
//
// Fix: the key never goes into opts.mcpServers.<name>.env any more (see src/bridge/attach.mjs — mcpConfigFor has no attestKey
// parameter at all now). Instead it is set directly on `opts.env`, the top-level env of the CALLER's own CLI process (the `env`
// RunOptions field every adapter already merges as `{...process.env, ...o.env}` before spawning that CLI). That CLI then spawns
// the MCP server (our bridge) as ITS OWN child process; this file empirically proves (not assumes) that such a grandchild
// inherits the parent CLI's env even when the MCP config's own "env" block omits the key entirely — so the key never has to
// touch disk or argv at any hop. This is tested against the REAL adapter-mediated spawn path (not mcpConfigFor() in isolation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { readdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import claude from '../dist/adapters/claude.js';
import codex from '../dist/adapters/codex.js';
import opencode from '../dist/adapters/opencode.js';
import { ask } from '../dist/index.js';

const T = { timeout: 150000 };
const dir = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-kd-')));
const PROBE = fileURLToPath(new URL('./_probe_fixture.mjs', import.meta.url));
const MAX_READ = 256 * 1024; // a key is short; never synchronously (or even async-fully) read multi-MB test fixtures

/**
 * Async, size-bounded scan of everything CREATED IN %TEMP% since `since` (ms epoch), one level of subdirectories deep —
 * mirrors the critic's steal.mjs but never blocks the event loop (fs/promises, not fs sync) and never reads huge files
 * (irrelevant leftover fixtures from earlier rounds, e.g. the "large payload" test's 3MB file, would otherwise dominate).
 */
async function scanTempFor(needle, since, exclude = new Set()) {
  const hits = [];
  let names = []; try { names = await readdir(tmpdir()); } catch { return hits; }
  const check = async (full) => {
    if (exclude.has(full)) return; // the test's OWN probe-output fixture legitimately contains the secret (that's the inheritance proof, not a leak)
    try {
      const st = await stat(full);
      if (st.isDirectory()) { if (st.mtimeMs >= since) { let sub = []; try { sub = await readdir(full); } catch { /* ignore */ } await Promise.all(sub.map((s) => check(path.join(full, s)))); } return; }
      if (st.mtimeMs < since || st.size > MAX_READ) return;
      const c = await readFile(full, 'utf8');
      if (c.includes(needle)) hits.push(full);
    } catch { /* unreadable / vanished mid-scan */ }
  };
  await Promise.all(names.map((n) => check(path.join(tmpdir(), n))));
  return hits;
}

/** Real adapter-mediated run: launches `agent` for real, with a probe MCP server attached (no `env` field in its mcpServers
 * config — only the top-level `env` carries the secret) and, WHILE the agent's process tree is alive, repeatedly scans the
 * whole OS temp dir for the secret (claude/codex-style leak) and, on Windows, the live process list's command lines
 * (codex-style leak) via a real WMI query — exactly the critic's PoC — then confirms whether the probe subprocess actually
 * received the secret via env inheritance. */
async function liveLeakCheck(agent, model, { checkArgv = false, mcpEnv } = {}) {
  const secret = 'SECRET-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  const outFile = path.join(dir(), 'env.json');
  const since = Date.now() - 2000;
  let diskHit = null, argvHit = null, stop = false;
  const scanner = (async () => {
    let lastArgvCheck = 0;
    while (!stop) {
      if (!diskHit) { const hits = await scanTempFor(secret, since, new Set([outFile])); if (hits.length) diskHit = hits[0]; }
      if (checkArgv && !argvHit && Date.now() - lastArgvCheck > 700) {
        lastArgvCheck = Date.now();
        try {
          const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine) -join "`n"'], { encoding: 'utf8', timeout: 4000 });
          if (r.stdout && r.stdout.includes(secret)) argvHit = 'wmi:CommandLine';
        } catch { /* ignore transient WMI errors */ }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  let result, error = null;
  try {
    result = await ask(agent, {
      prompt: 'reply with exactly OK', model, cwd: dir(), timeoutMs: 100000,
      env: { AGENTBRIDGE_ATTEST_KEY: secret }, // top-level CLI process env — NOT inside mcpServers
      mcpServers: { probe: { command: process.execPath, args: [PROBE, outFile], ...(mcpEnv ? { env: mcpEnv(secret) } : {}) } },
    });
  } catch (e) { error = e; }
  stop = true; await scanner;
  // one more pass after the process tree has exited, to catch anything written but not yet flushed
  if (!diskHit) { const hits = await scanTempFor(secret, since, new Set([outFile])); if (hits.length) diskHit = hits[0]; }
  let inherited = null;
  if (existsSync(outFile)) { try { inherited = JSON.parse(readFileSync(outFile, 'utf8')).AGENTBRIDGE_ATTEST_KEY === secret; } catch { inherited = false; } }
  return { secret, diskHit, argvHit, inherited, probeSpawned: existsSync(outFile), result, error };
}

test('N1 (round 7): claude — real adapter-mediated spawn never leaks the key to disk or argv, and inheritance works', T, async () => {
  const r = await liveLeakCheck(claude, 'haiku');
  assert.equal(r.error, null, r.error?.message);
  assert.ok(r.probeSpawned, 'claude must actually spawn the probe MCP subprocess (tool discovery)');
  assert.equal(r.diskHit, null, `key must never be found on disk (found in ${r.diskHit})`);
  assert.equal(r.inherited, true, 'the MCP subprocess must receive the key via OS env inheritance from the claude CLI process');
});

test('N1 (round 7): codex root cause — its MCP subprocess does NOT inherit the parent env at all (proves the workaround below is necessary)', T, async () => {
  const r = await liveLeakCheck(codex, undefined, { checkArgv: true }); // deliberately no mcpServers.probe.env: tests plain OS inheritance
  if (r.error && /usage limit|rate limit/i.test(r.error.message)) { console.log('SKIPPED (codex quota exhausted):', r.error.message); return; }
  assert.equal(r.error, null, r.error?.message);
  assert.ok(r.probeSpawned, 'codex must actually spawn the probe MCP subprocess');
  assert.equal(r.diskHit, null, 'no inheritance attempt ever touches disk either way');
  assert.equal(r.argvHit, null, 'no inheritance attempt never touches argv either way');
  assert.equal(r.inherited, false, "documents the verified fact: codex's MCP-subprocess spawn does not inherit custom parent env vars (confirmed live; every MCP child gets a fixed ~20-var OS-only env)");
});

// Round 8: codex offers a streamable-HTTP MCP transport with `--bearer-token-env-var` (confirmed via `codex mcp add --help`,
// codex-cli 0.155.1) — codex reads a bearer token from ITS OWN process env at request time and sends it as an Authorization
// header; only the ENV VAR NAME goes into codex's config/argv, never the value. src/bridge/mcp.mjs execute() and
// src/bridge/subagent.mjs runOnce() use exactly this for codex: the grandchild bridge runs IN-PROCESS (no separate spawn at
// all — see serveHttp()) and codex is pointed at it via `-c mcp_servers.agentbridge.url=...` + `bearer_token_env_var=...`.
test('N1 (round 8): codex HTTP transport — real end-to-end delegation, key visible NEITHER on disk NOR via WMI CommandLine', T, async () => {
  const { runAsSubagent } = await import('../dist/bridge/subagent.js');
  const key = 'SECRET-' + Math.random().toString(36).slice(2) + '-' + Date.now(); // known in advance so we can scan for it LIVE
  const since = Date.now() - 2000;
  let diskHit = null, argvHit = null, stop = false;
  const scanner = (async () => {
    let last = 0;
    while (!stop) {
      if (!diskHit) { const hits = await scanTempFor(key, since); if (hits.length) diskHit = hits[0]; }
      if (!argvHit && Date.now() - last > 700) {
        last = Date.now();
        try {
          const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine) -join "`n"'], { encoding: 'utf8', timeout: 4000 });
          if (r.stdout && r.stdout.includes(key)) argvHit = 'wmi:CommandLine';
        } catch { /* transient WMI error */ }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  let r, error = null;
  try {
    r = await runAsSubagent({ caller: 'codex', callee: 'claude', task: 'reply with exactly OK', model: 'gpt-5.6-luna', calleeModel: 'haiku', cwd: dir(), timeoutMs: 100000, attestKey: key });
  } catch (e) { error = e; }
  stop = true; await scanner;
  if (!diskHit) { const hits = await scanTempFor(key, since); if (hits.length) diskHit = hits[0]; } // final pass after exit
  if (error && /usage limit|rate limit/i.test(error.message)) { console.log('SKIPPED (codex quota exhausted):', error.message); return; }
  assert.equal(error, null, error?.message);
  assert.equal(diskHit, null, `key must never be found on disk (found in ${diskHit})`);
  assert.equal(argvHit, null, 'key must never appear in any process command line (WMI Win32_Process.CommandLine) — the HTTP transport only exposes the env VAR NAME, never the value');
  assert.ok(r.succeeded, `codex delegation must actually succeed with a verified attestation over the HTTP transport: ${JSON.stringify(r.results).slice(0, 400)}`);
  assert.match(r.text, /OK/);
});

test('N1 (round 7): opencode — real adapter-mediated spawn never leaks the key to disk, and inheritance works', T, async () => {
  const r = await liveLeakCheck(opencode, 'opencode-go/glm-5.3-flash');
  assert.equal(r.error, null, r.error?.message);
  assert.ok(r.probeSpawned, 'opencode must actually spawn the probe MCP subprocess');
  assert.equal(r.diskHit, null, `key must never be found on disk (found in ${r.diskHit})`);
  assert.equal(r.inherited, true, 'the MCP subprocess must receive the key via OS env inheritance from the opencode CLI process');
});

test('mcpConfigFor has no attestKey parameter any more (structural guard against regressing round 7)', async () => {
  const { mcpConfigFor } = await import('../dist/bridge/attach.js');
  const e = mcpConfigFor('claude', { attestKey: 'should-be-ignored-if-someone-re-adds-the-param' }).agentbridge;
  assert.ok(!JSON.stringify(e).includes('should-be-ignored'), 'even if a caller passes attestKey, mcpConfigFor must not surface it');
});
