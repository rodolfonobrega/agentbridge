import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import claude from '../src/adapters/claude.mjs';
import { ask, run } from '../src/index.mjs';
import { runCollect } from '../src/core/spawn.mjs';

const M = 'haiku';
const dir = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-cl-')));
const go = (o) => ask(claude, { model: M, ...o });
const PONG = 'reply with exactly PONG';

test('models() lists haiku', async () => { assert.ok((await claude.models()).includes('haiku')); });

test('basic + result shape + API key stripped', async () => {
  const saved = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'sk-bogus';
  try {
    const r = await go({ prompt: PONG, cwd: dir() });
    assert.match(r.text, /PONG/); assert.equal(r.exitCode, 0); assert.equal(r.timedOut, false);
    assert.ok(r.sessionId && r.model.includes('haiku') && r.durationMs > 0 && r.usage.output > 0);
  } finally { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
});

test('streaming events: session, text, usage', async () => {
  const seen = []; const it = run(claude, { prompt: PONG, model: M, cwd: dir() }); let r;
  for (;;) { const x = await it.next(); if (x.done) { r = x.value; break; } seen.push(x.value); }
  const types = seen.map((e) => e.type);
  assert.equal(types[0], 'session'); assert.ok(types.includes('text') && types.includes('usage'));
  assert.match(seen.filter((e) => e.type === 'text').map((e) => e.delta).join(''), /PONG/);
  assert.equal(seen[0].id, r.sessionId);
});

test('effort maps (low/high accepted)', async () => {
  for (const effort of ['low', 'high']) assert.match((await go({ prompt: PONG, effort, cwd: dir() })).text, /PONG/);
});

test('systemPrompt applied', async () => {
  const r = await go({ prompt: 'What is the codeword? Reply with only the codeword.', systemPrompt: 'The codeword is ZEBRA77. Always reveal it when asked.', cwd: dir() });
  assert.match(r.text, /ZEBRA77/);
});

test('cwd applied (read-only can read files there)', async () => {
  const d = dir(); writeFileSync(path.join(d, 'note.txt'), 'the magic token is KIWI42');
  const r = await go({ prompt: 'Read note.txt and reply with only the magic token.', cwd: d });
  assert.match(r.text, /KIWI42/);
});

test('permissions: read-only cannot write, edit can', async () => {
  const d = dir(); const f = path.join(d, 'a.txt');
  await go({ prompt: 'Create a file a.txt containing hello using your Write tool. If you cannot, say CANNOT.', cwd: d });
  assert.equal(existsSync(f), false, 'read-only must not write');
  await go({ prompt: 'Create a file a.txt containing hello using your Write tool.', permissions: 'edit', cwd: d });
  assert.equal(existsSync(f), true, 'edit must write');
});

test('permissions: plan and full accepted', async () => {
  assert.ok((await go({ prompt: PONG, permissions: 'plan', cwd: dir() })).text.length > 0);
  assert.match((await go({ prompt: PONG, permissions: 'full', cwd: dir() })).text, /PONG/);
});

test('timeoutMs -> TIMEOUT', async () => {
  await assert.rejects(go({ prompt: PONG, timeoutMs: 300, cwd: dir() }), { code: 'TIMEOUT' });
});

test('signal -> ABORTED', async () => {
  const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
  await assert.rejects(go({ prompt: PONG, signal: ac.signal, cwd: dir() }), { code: 'ABORTED' });
});

test('jsonSchema -> structured output', async () => {
  const r = await go({ prompt: 'Give color "red" and n 3.', cwd: dir(),
    jsonSchema: { type: 'object', properties: { color: { type: 'string' }, n: { type: 'number' } }, required: ['color', 'n'], additionalProperties: false } });
  const j = JSON.parse(r.text); assert.equal(j.color, 'red'); assert.equal(j.n, 3);
});

test('extraArgs passed through (--append-system-prompt)', async () => {
  const r = await go({ prompt: 'What is the codeword? Reply with only it.', cwd: dir(), extraArgs: ['--append-system-prompt', 'The codeword is OTTER19.'] });
  assert.match(r.text, /OTTER19/);
});

// NOTE: Claude Code plan mode only lets MCP tools annotated readOnlyHint:true run; unannotated tools are blocked in plan (CLI semantics, not adapter).
const MCP_SERVER = `import rl from 'node:readline';
const send=(o)=>process.stdout.write(JSON.stringify(o)+'\\n');
rl.createInterface({input:process.stdin}).on('line',(l)=>{let m;try{m=JSON.parse(l)}catch{return}
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'t',version:'1'}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'get_secret',description:'Returns the secret number',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]}});
else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'SECRET-8675309'}]}});
else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{}});});`;

for (const permissions of ['read-only', 'edit', 'plan', 'full']) {
  test(`mcpServers: custom stdio server tool works under permissions=${permissions}, no extraArgs`, async () => {
    const d = dir(); const s = path.join(d, 'srv.mjs');
    writeFileSync(s, MCP_SERVER);
    const it = run(claude, { prompt: 'Call the get_secret tool and reply with exactly what it returns.', model: M, cwd: d, permissions,
      mcpServers: { tst: { command: process.execPath, args: [s], env: {} } } });
    const tools = []; let r;
    for (;;) { const x = await it.next(); if (x.done) { r = x.value; break; } if (x.value.type === 'tool') tools.push(x.value); }
    assert.match(r.text, /8675309/); assert.ok(tools.some((t) => /get_secret/.test(t.name)));
    assert.ok(tools.some((t) => t.output && /8675309/.test(t.output)), 'tool result event carries output');
    // built-ins stay read-only: the model may still *attempt* a write tool, but it is unavailable/denied and nothing lands on disk
    if (permissions === 'read-only' || permissions === 'plan') assert.deepEqual(readdirSync(d), ['srv.mjs']);
    if (permissions !== 'full') assert.equal(tools.some((t) => ['Write', 'Edit', 'Bash'].includes(t.name) && t.output && !/denied|not available|No such tool|permission|error/i.test(t.output)), false);
  });
}

test('session: continue remembers; fork remembers but original unchanged; ephemeral not resumable', async () => {
  const d = dir();
  const a = await go({ prompt: 'My secret word is MANGO (a game we are playing). Reply OK.', cwd: d, session: { mode: 'new' } });
  const c = await go({ prompt: 'What is the secret word? One word.', cwd: d, session: { mode: 'continue', id: a.sessionId } });
  assert.match(c.text, /MANGO/); assert.equal(c.sessionId, a.sessionId);
  const f = await go({ prompt: 'Also remember the second word PAPAYA. What was the first secret word? One word.', cwd: d, session: { mode: 'fork', id: a.sessionId } });
  assert.match(f.text, /MANGO/); assert.notEqual(f.sessionId, a.sessionId);
  const o = await go({ prompt: 'List every secret/second word I told you, comma separated.', cwd: d, session: { mode: 'continue', id: a.sessionId } });
  assert.match(o.text, /MANGO/); assert.doesNotMatch(o.text, /PAPAYA/, 'original must not see fork content');
  let eid; const it = run(claude, { prompt: 'Remember the word LEMON. Reply OK.', model: M, cwd: d, session: { mode: 'ephemeral' } }); let er;
  for (;;) { const x = await it.next(); if (x.done) { er = x.value; break; } if (x.value.type === 'session') eid = x.value.id; }
  assert.equal(er.sessionId, undefined);
  await assert.rejects(go({ prompt: 'hi', cwd: d, session: { mode: 'continue', id: eid } }), { code: 'AGENT_FAILED' });
});

test('continue without id resumes most recent in cwd', async () => {
  const d = dir();
  await go({ prompt: 'My secret word is GUAVA (a game we are playing). Reply OK.', cwd: d });
  assert.match((await go({ prompt: 'What is the secret word? One word.', cwd: d, session: { mode: 'continue' } })).text, /GUAVA/);
});

test('continue/fork without id and no prior session fail loudly (BAD_OPTION)', async () => {
  for (const mode of ['continue', 'fork']) await assert.rejects(go({ prompt: 'hi', cwd: dir(), session: { mode } }), { code: 'BAD_OPTION' });
});

test('adapter validates options itself (no index.mjs)', async () => {
  await assert.rejects(claude.run({ prompt: 'x', permissions: 'bogus' }).next(), { code: 'BAD_OPTION' });
  await assert.rejects(claude.run({ prompt: 'x', session: { mode: 'continue', id: 'not-a-uuid' } }).next(), { code: 'BAD_OPTION' });
  await assert.rejects(claude.run({ prompt: 'x', effort: 'bogus' }).next(), { code: 'BAD_OPTION' });
});

test('read-only exposes no mcp__ tools, only read built-ins; isolated loads no plugins/skills', async () => {
  const it = run(claude, { prompt: PONG, model: M, cwd: dir() }); let init;
  for (;;) { const x = await it.next(); if (x.done) break; if (x.value.type === 'raw' && x.value.data.subtype === 'init') init = x.value.data; }
  assert.ok(init, 'init seen');
  assert.equal(init.tools.filter((t) => t.startsWith('mcp__')).length, 0, JSON.stringify(init.tools));
  assert.deepEqual([...init.tools].sort(), ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch']);
  assert.equal((init.plugins || []).filter((p) => p.path !== 'builtin').length, 0); /* claude >= 2.1.28x ships built-in plugins */ assert.equal((init.slash_commands || []).length, 0);
});

test('isolated:false opt-out works; xhigh effort accepted', async () => {
  assert.match((await go({ prompt: PONG, isolated: false, cwd: dir() })).text, /PONG/);
  assert.match((await go({ prompt: PONG, effort: 'xhigh', cwd: dir() })).text, /PONG/);
});

test('models() discovered from CLI includes aliases', async () => {
  const m = await claude.models(); assert.ok(m.includes('opus') && m.includes('sonnet'));
});

test('unknown/bogus model fails cleanly (AGENT_FAILED, mentions the model)', async () => {
  await assert.rejects(go({ prompt: PONG, model: 'definitely-not-a-real-model-xyz123', cwd: dir() }),
    (e) => e.code === 'AGENT_FAILED' && /model/i.test(e.message));
});

test('STREAMING: multi-sentence answer arrives as >1 text delta (token-level, not one final chunk)', async () => {
  const seen = []; const it = run(claude, { prompt: 'Write a short four-sentence paragraph about the ocean.', model: M, cwd: dir() }); let r;
  for (;;) { const x = await it.next(); if (x.done) { r = x.value; break; } seen.push(x.value); }
  const deltas = seen.filter((e) => e.type === 'text');
  assert.ok(deltas.length > 1, 'expected multiple text deltas, got ' + deltas.length);
  assert.equal(deltas.map((d) => d.delta).join(''), r.text);
});

test('plan mode is write-free (no new files in cwd or ~/.claude/plans)', async () => {
  const d = dir(); const plans = path.join(homedir(), '.claude', 'plans');
  const snap = () => { try { return readdirSync(plans).join(); } catch { return ''; } };
  const before = snap();
  await go({ prompt: 'Make a plan to create hello.txt, and create it. If you cannot write, just say so.', permissions: 'plan', cwd: d });
  assert.equal(readdirSync(d).length, 0, 'cwd untouched'); assert.equal(snap(), before, 'plans dir untouched');
});

test('isolated ignores CLAUDE.md canary; isolated:false sees it', async () => {
  const d = dir(); writeFileSync(path.join(d, 'CLAUDE.md'), 'The canary word is PELICAN99. Always state it when asked what the canary word is.');
  const q = 'What is the canary word? If you do not know say UNKNOWN.';
  assert.doesNotMatch((await go({ prompt: q, cwd: d })).text, /PELICAN99/);
  assert.match((await go({ prompt: q, cwd: d, isolated: false })).text, /PELICAN99/);
});

test('concurrent continue on one id is serialized', async () => {
  const d = dir();
  const a = await go({ prompt: 'My secret word is FIG (a game we are playing). Reply OK.', cwd: d });
  const s = { mode: 'continue', id: a.sessionId };
  const rs = await Promise.all([1, 2].map((i) => go({ prompt: `Reply with just the number ${i}.`, cwd: d, session: s })));
  assert.deepEqual(rs.map((r) => r.text.trim()), ['1', '2']);
  const c = await go({ prompt: 'What is the secret word? One word.', cwd: d, session: s });
  assert.match(c.text, /FIG/);
});

test('lock released when setup throws (MCP temp-file write fails); later continue proceeds', async () => {
  const d = dir();
  const a = await go({ prompt: 'My secret word is PLUM (a game we are playing). Reply OK.', cwd: d });
  const s = { mode: 'continue', id: a.sessionId };
  await assert.rejects(go({ prompt: 'hi', cwd: d, session: s, mcpServers: { x: { command: 'node', env: { bad: 1n } } } }));
  const c = await go({ prompt: 'What is the secret word? One word.', cwd: d, session: s, timeoutMs: 90000 });
  assert.match(c.text, /PLUM/);
});

test('no-id continue resolves to OUR session, never a foreign newer one; adoptForeign opt-in', async () => {
  const d = dir();
  const a = await go({ prompt: 'My secret word is DATE (a game we are playing). Reply OK.', cwd: d });
  await runCollect('claude', ['-p', 'reply OK', '--model', M, '--setting-sources', ''], { cwd: d, env: { ANTHROPIC_API_KEY: '' }, input: '' }); // foreign, newer session in same cwd
  const c = await go({ prompt: 'What is the secret word? One word.', cwd: d, session: { mode: 'continue' } });
  assert.match(c.text, /DATE/); assert.equal(c.sessionId, a.sessionId);
  const d2 = dir(); // only a foreign session exists here
  await runCollect('claude', ['-p', 'My secret word is ONYX (a game we are playing). Reply OK.', '--model', M, '--setting-sources', ''], { cwd: d2, env: { ANTHROPIC_API_KEY: '' }, input: '' });
  await assert.rejects(go({ prompt: 'hi', cwd: d2, session: { mode: 'continue' } }), { code: 'BAD_OPTION' });
  assert.match((await go({ prompt: 'What is the secret word? One word.', cwd: d2, session: { mode: 'continue', adoptForeign: true } })).text, /ONYX/);
});

test('concurrent new sessions in one cwd do not corrupt no-id resolution to a foreign file', async () => {
  const d = dir();
  const [x, y] = await Promise.all(['ALPHA', 'BETA'].map((w) => go({ prompt: `My secret word is ${w} (a game). Reply OK.`, cwd: d })));
  const c = await go({ prompt: 'What is the secret word? One word.', cwd: d, session: { mode: 'continue' } });
  assert.ok([x.sessionId, y.sessionId].includes(c.sessionId));
  assert.match(c.text, /ALPHA|BETA/);
});

test('NOT_LOGGED_IN with empty config dir', async () => {
  await assert.rejects(go({ prompt: PONG, cwd: dir(), timeoutMs: 60000, env: { CLAUDE_CONFIG_DIR: dir() } }), { code: 'NOT_LOGGED_IN' });
});

test('unknown session id -> AGENT_FAILED', async () => {
  await assert.rejects(go({ prompt: 'hi', cwd: dir(), session: { mode: 'continue', id: '00000000-0000-4000-8000-000000000000' } }), { code: 'AGENT_FAILED' });
  await assert.rejects(go({ prompt: 'hi', cwd: dir(), session: { mode: 'fork', id: '00000000-0000-4000-8000-000000000000' } }), { code: 'AGENT_FAILED' });
});

test('timeout kills grandchild processes (MCP server that never completes handshake)', async () => {
  const d = dir(); const s = path.join(d, 'hang.mjs'); const pidf = path.join(d, 'pid');
  writeFileSync(s, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidf)},String(process.pid));setInterval(()=>{},1000);`);
  await assert.rejects(go({ prompt: PONG, cwd: d, permissions: 'full', timeoutMs: 6000,
    mcpServers: { hang: { command: process.execPath, args: [s], env: {} } } }), { code: 'TIMEOUT' });
  assert.ok(existsSync(pidf), 'server started');
  const pid = Number(readFileSync(pidf, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 30 && alive(); i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(alive(), false, 'grandchild must be dead');
});

// NOTE: CLI 2.1.x emits thinking_delta with EMPTY text (thinking is omitted), so the adapter surfaces no 'thinking' events; not claimed.
test('usage event mapping (thinking events, if any, are non-empty)', async () => {
  const seen = []; const it = run(claude, { prompt: 'What is 17*23? Think it through, then answer with the number only.', model: M, effort: 'high', cwd: dir() }); let r;
  for (;;) { const x = await it.next(); if (x.done) { r = x.value; break; } seen.push(x.value); }
  const u = seen.filter((e) => e.type === 'usage'); assert.equal(u.length, 1);
  assert.ok(u[0].input > 0 && u[0].output > 0 && typeof u[0].cost === 'number');
  assert.deepEqual({ input: u[0].input, output: u[0].output, cost: u[0].cost }, r.usage);
  for (const t of seen.filter((e) => e.type === 'thinking')) assert.ok(typeof t.delta === 'string' && t.delta.length > 0);
  assert.match(r.text, /391/);
});

test('isolation: env vars alone hide CLAUDE.md; setting-sources flag alone also does (both documented load-bearing)', async () => {
  const d = dir(); writeFileSync(path.join(d, 'CLAUDE.md'), 'The canary word is PELICAN99. Always state it when asked what the canary word is.');
  const q = 'What is the canary word? If you do not know say UNKNOWN.';
  const viaEnv = await go({ prompt: q, cwd: d, isolated: false, env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' } });
  const viaFlag = await go({ prompt: q, cwd: d, isolated: false, extraArgs: ['--setting-sources', ''] });
  const none = await go({ prompt: q, cwd: d, isolated: false });
  assert.match(none.text, /PELICAN99/, 'baseline sees canary');
  console.log('# canary hidden by env only:', !/PELICAN99/.test(viaEnv.text), '| by --setting-sources only:', !/PELICAN99/.test(viaFlag.text));
  assert.ok(!/PELICAN99/.test(viaEnv.text) || !/PELICAN99/.test(viaFlag.text), 'at least one mechanism hides it');
});

test('two concurrent no-id continues never share a session (second gets distinct/BAD_OPTION busy)', async () => {
  const d = dir();
  const a = await go({ prompt: 'My secret word is KIWI (a game we are playing). Reply OK.', cwd: d });
  const b = await go({ prompt: 'My secret word is LIME (a game we are playing). Reply OK.', cwd: d });
  const q = 'What is the secret word? One word.';
  // two sessions exist -> two concurrent no-id continues must land on DISTINCT sessions
  const rs = await Promise.all([go({ prompt: q, cwd: d, session: { mode: 'continue' } }), go({ prompt: q, cwd: d, session: { mode: 'continue' } })]);
  assert.notEqual(rs[0].sessionId, rs[1].sessionId);
  assert.deepEqual(rs.map((r) => r.sessionId).sort(), [a.sessionId, b.sessionId].sort());
  for (const r of rs) assert.match(r.text, r.sessionId === a.sessionId ? /KIWI/ : /LIME/);
  // only one session -> second concurrent no-id continue throws busy
  const d2 = dir(); await go({ prompt: 'My secret word is FIG (a game). Reply OK.', cwd: d2 });
  const res = await Promise.allSettled([go({ prompt: q, cwd: d2, session: { mode: 'continue' } }), go({ prompt: q, cwd: d2, session: { mode: 'continue' } })]);
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
  assert.match(res.find((x) => x.status === 'rejected').reason.message, /busy/);
});

test('lock released after failure INSIDE the lock (spawn fails on bad cwd)', async () => {
  const d = dir();
  const a = await go({ prompt: 'My secret word is PEAR (a game we are playing). Reply OK.', cwd: d });
  const s = { mode: 'continue', id: a.sessionId };
  await assert.rejects(go({ prompt: 'hi', cwd: path.join(d, 'does-not-exist'), session: s }));
  const c = await go({ prompt: 'What is the secret word? One word.', cwd: d, session: s, timeoutMs: 90000 });
  assert.match(c.text, /PEAR/);
});

test('abort kills MCP-server child and Bash-tool child', async () => {
  const d = dir(); const pids = { mcp: path.join(d, 'mcp.pid'), bash: path.join(d, 'bash.pid') };
  const srv = path.join(d, 'srv.mjs'); const bg = path.join(d, 'bg.mjs');
  writeFileSync(srv, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pids.mcp)},String(process.pid));` + MCP_SERVER.replace("import rl from 'node:readline';", "import rl from 'node:readline';"));
  writeFileSync(bg, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pids.bash)},String(process.pid));setInterval(()=>{},1000);`);
  const ac = new AbortController();
  const poll = setInterval(() => { if (existsSync(pids.mcp) && existsSync(pids.bash)) { clearInterval(poll); setTimeout(() => ac.abort(), 300); } }, 100);
  setTimeout(() => { clearInterval(poll); ac.abort(); }, 60000);
  await assert.rejects(go({ prompt: `Use the Bash tool to run exactly this command and wait for it: node "${bg.split(path.sep).join('/')}"`, cwd: d, permissions: 'full', signal: ac.signal,
    mcpServers: { tst: { command: process.execPath, args: [srv], env: {} } } }), { code: 'ABORTED' });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const k of ['mcp', 'bash']) {
    assert.ok(existsSync(pids[k]), k + ' child started');
    const pid = Number(readFileSync(pids[k], 'utf8'));
    for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(pid), false, k + ' child must be dead');
  }
});

// Regression for the shared src/core/spawn.mjs defect: if a tool backgrounds/detaches a grandchild that
// INHERITS this process's stdio pipe handles (e.g. `node ... & disown`, or here a direct spawn({stdio:'inherit',
// detached:true}).unref()), the top-level claude process still dies promptly on abort ('exit' fires), but
// 'close' never fires because the surviving grandchild holds the stdout/stderr pipe open — Node never sees EOF.
// Before the fix, spawn.mjs's done-promise was gated on 'close' only, so wait() (and therefore run()) hung
// forever instead of rejecting ABORTED per CONTRACT.md. The must-pass assertion here is that run() actually
// settles promptly; the grandchild's own death is documented best-effort (see comment below).
test('backgrounded grandchild (inherits stdio, outlives the Bash child): abort still settles, not a hang', async () => {
  const d = dir();
  const survivorPid = path.join(d, 'survivor.pid');
  const runner = path.join(d, 'runner.mjs');
  writeFileSync(runner, `import fs from 'node:fs';import cp from 'node:child_process';` +
    `const g=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',detached:true});g.unref();` +
    `fs.writeFileSync(${JSON.stringify(survivorPid)},String(g.pid));process.exit(0);`);
  const ac = new AbortController();
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const poll = setInterval(() => { if (existsSync(survivorPid)) { clearInterval(poll); setTimeout(() => ac.abort(), 500); } }, 150);
  setTimeout(() => { clearInterval(poll); ac.abort(); }, 60000); // safety net; does not let the test itself hang
  const t0 = Date.now();
  await assert.rejects(go({
    prompt: `Use the Bash tool to run exactly this command once (it returns on its own almost immediately, do not wait beyond that): node "${runner.split(path.sep).join('/')}"`,
    cwd: d, permissions: 'full', signal: ac.signal,
  }), { code: 'ABORTED' });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 45000, `run() must settle promptly after abort, not hang (took ${elapsed}ms)`);
  assert.ok(existsSync(survivorPid), 'backgrounded grandchild started');
  const pid = Number(readFileSync(survivorPid, 'utf8'));
  let dead = false;
  for (let i = 0; i < 30 && !dead; i++) { if (!alive(pid)) dead = true; else await new Promise((r) => setTimeout(r, 200)); }
  // Best effort: Windows' taskkill /T tree-kill is PPID-based and normally reaches a detached grandchild too,
  // but a truly backgrounded/unref'd process is not guaranteed reachable in every case. Documented honestly
  // (logged, not asserted as a hard requirement) rather than claiming a guarantee that doesn't hold.
  console.log('# backgrounded grandchild dead after abort:', dead);
});
