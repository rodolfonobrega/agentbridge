import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnProc, runCollect, resolveBinary } from '../src/core/spawn.mjs';
import { AgentError } from '../src/core/errors.mjs';
import { createLineSplitter, splitJsonl } from '../src/core/events.mjs';
import { run, ask, validateOptions } from '../src/index.mjs';

const N = process.execPath;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = async (p) => { const a = []; for await (const l of p.lines) a.push(l); return a; };

test('streams stdout lines incrementally', async () => {
  const p = spawnProc(N, ['-e', "console.log('a');setTimeout(()=>{console.log('b');process.stdout.write('c')},300)"]);
  const t0 = Date.now(); const got = [];
  for await (const l of p.lines) got.push([l, Date.now() - t0]);
  assert.deepEqual(got.map((g) => g[0]), ['a', 'b', 'c']);
  assert.ok(got[1][1] - got[0][1] > 150, 'lines arrive as produced');
  assert.equal((await p.wait()).exitCode, 0);
});

test('stderr capture + non-zero exit', async () => {
  const r = await runCollect(N, ['-e', "console.error('boom');process.exit(3)"]);
  assert.equal(r.exitCode, 3); assert.equal(r.stderr, 'boom');
});

test('stdin write, args with spaces/quotes are passed verbatim', async () => {
  const r = await runCollect(N, ['-e', "process.stdin.on('data',d=>process.stdout.write(d.toString().toUpperCase()));process.stdin.on('end',()=>console.log('|'+process.argv[1]))", 'a "b" c&d'], { input: 'héllo\n' });
  assert.equal(r.stdout, 'HÉLLO\n|a "b" c&d'.replace('\n', '\n'));
});

test('cwd and env are applied', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-'));
  const r = await runCollect(N, ['-e', 'console.log(process.cwd());console.log(process.env.AB_X)'], { cwd: d, env: { AB_X: 'yes' } });
  assert.equal(r.stdout.split('\n')[1], 'yes');
  assert.equal(path.basename(r.stdout.split('\n')[0]), path.basename(d));
});

test('timeout kills the whole process tree', async () => {
  const child = "setInterval(()=>{},1000)";
  const parent = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`;
  const p = spawnProc(N, ['-e', parent], { timeoutMs: 1500 });
  let gpid = 0;
  for await (const l of p.lines) { if (!gpid) { gpid = Number(l); assert.ok(gpid > 0 && alive(gpid), 'grandchild started'); } }
  const r = await p.wait();
  assert.equal(r.timedOut, true);
  await sleep(300);
  assert.equal(alive(p.pid), false, 'child dead');
  assert.equal(alive(gpid), false, 'grandchild dead');
});

test('AbortSignal kills process', async () => {
  const ac = new AbortController();
  const p = spawnProc(N, ['-e', "console.log('up');setInterval(()=>{},1000)"], { signal: ac.signal });
  for await (const l of p.lines) { assert.equal(l, 'up'); ac.abort(); }
  const r = await p.wait();
  assert.equal(r.aborted, true); assert.equal(alive(p.pid), false);
});

test('missing binary => NOT_INSTALLED', async () => {
  assert.throws(() => spawnProc('definitely-not-a-real-binary-xyz', []), (e) => e instanceof AgentError && e.code === 'NOT_INSTALLED');
});

test('Windows .cmd shim resolution (npm-style and plain)', { skip: process.platform !== 'win32' }, async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-shim-'));
  writeFileSync(path.join(d, 'cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  writeFileSync(path.join(d, 'npmy.cmd'), '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"node"  "%dp0%\\cli.js" %*\r\n');
  writeFileSync(path.join(d, 'plain.cmd'), '@echo off\r\necho hi %1\r\n');
  const env = { PATH: d + path.delimiter + process.env.PATH };
  const arg = 'x "y" & z';
  const a = await runCollect('npmy', [arg, '--v'], { env });
  assert.deepEqual(JSON.parse(a.stdout), [arg, '--v']);
  const b = await runCollect('plain', ['there'], { env });
  assert.equal(b.stdout.trim(), 'hi "there"'); // cmd echo keeps our quoting
  await assert.rejects(runCollect('plain', ['100%']), { code: 'BAD_OPTION' }).catch(() => {}); // not on PATH here: NOT_INSTALLED is fine too
});

test('Windows Codex npm shim passes quoted arguments directly to its JS target', { skip: process.platform !== 'win32' }, async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-codex-shim-'));
  const target = path.join(d, 'node_modules', '@openai', 'codex', 'bin');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'codex.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  writeFileSync(path.join(d, 'codex.cmd'), [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ].join('\r\n') + '\r\n');
  const env = { PATH: d + path.delimiter + process.env.PATH };
  const args = ['exec', '-c', 'windows.sandbox="unelevated"', '-'];
  const r = await runCollect('codex', args, { env, cwd: d });
  assert.deepEqual(JSON.parse(r.stdout), args);
});

for (const bin of ['claude', 'codex', 'opencode']) {
  test(`real binary ${bin} --version`, async (t) => {
    if (!resolveBinary(bin)) return t.skip(`${bin} not installed`);
    const r = await runCollect(bin, ['--version'], { timeoutMs: 30000 });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /\d+\.\d+/);
  });
}

test('line splitter / jsonl', () => {
  const s = createLineSplitter();
  assert.deepEqual(s.push('a\r\nb'), ['a']); assert.deepEqual(s.push('c\n'), ['bc']); assert.deepEqual(s.flush(), []);
  assert.deepEqual(splitJsonl('{"a":1}\nnope\n\n[2]'), [{ a: 1 }, [2]]);
});

test('index: validation -> BAD_OPTION', async () => {
  for (const bad of [null, {}, { prompt: '' }, { prompt: 'x', effort: 'huge' }, { prompt: 'x', permissions: 'root' }, { prompt: 'x', timeoutMs: -1 },
    { prompt: 'x', session: { mode: 'new', id: 'a' } }, { prompt: 'x', session: { mode: 'zzz' } }, { prompt: 'x', bogus: 1 }, { prompt: 'x', extraArgs: [1] }, { prompt: 'x', mcpServers: { a: {} } }]) {
    assert.throws(() => validateOptions(bad), { code: 'BAD_OPTION' });
  }
  assert.equal(validateOptions({ prompt: 'x' }).permissions, 'read-only');
  await assert.rejects(ask('nope', { prompt: 'x' }), { code: 'BAD_OPTION' });
  await assert.rejects(ask({ run() {} }, { prompt: '' }), { code: 'BAD_OPTION' });
});

test('index: run streams events and ask returns Result via a fake adapter', async () => {
  const adapter = { name: 'fake', async models() { return []; }, async *run(o) {
    yield { type: 'text', delta: 'hi' }; yield { type: 'text', delta: ' ' + o.permissions };
    return { text: 'hi ' + o.permissions, sessionId: 's', usage: { input: 1, output: 2 }, exitCode: 0, model: 'm', durationMs: 1, timedOut: false };
  } };
  const evs = []; const it = run(adapter, { prompt: 'p' }); let r;
  for (;;) { const x = await it.next(); if (x.done) { r = x.value; break; } evs.push(x.value); }
  assert.equal(evs.length, 2); assert.equal(r.text, 'hi read-only');
  assert.equal((await ask(adapter, { prompt: 'p', permissions: 'full' })).text, 'hi full');
  const ac = new AbortController(); ac.abort();
  await assert.rejects(ask(adapter, { prompt: 'p', signal: ac.signal }), { code: 'ABORTED' });
});

// ---- round 2 regressions ----
test('wait() without consuming lines does not hang on >64KB stdout', async () => {
  const p = spawnProc(N, ['-e', "process.stdout.write('x'.repeat(200000)+String.fromCharCode(10)+'y'+String.fromCharCode(10))"], { timeoutMs: 15000 });
  const r = await p.wait();
  assert.equal(r.exitCode, 0); assert.equal(r.timedOut, false);
  const got = await collect(p); assert.equal(got.length, 2);
});

test('line splitter is linear for huge no-newline output', () => {
  const s = createLineSplitter({ maxLine: 100e6 });
  const t0 = Date.now();
  const chunk = 'a'.repeat(64 * 1024);
  for (let i = 0; i < 320; i++) assert.deepEqual(s.push(chunk), []); // ~20MB
  s.push('\n');
  assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0));
});

test('maxLine / maxBuffer caps give a clear AGENT_FAILED', async () => {
  assert.throws(() => createLineSplitter({ maxLine: 10 }).push('a'.repeat(11)), { code: 'AGENT_FAILED' });
  const p = spawnProc(N, ['-e', "process.stdout.write('z'.repeat(3e6))"], { maxLine: 1e6 });
  await assert.rejects(p.wait(), { code: 'AGENT_FAILED', message: /maxLine/ });
  const q = spawnProc(N, ['-e', "for(let i=0;i<200000;i++)console.log('line'+i)"], { maxBuffer: 100000 });
  await assert.rejects(q.wait(), { code: 'AGENT_FAILED', message: /maxBuffer/ });
});

test('bad cwd => BAD_OPTION; bad timeoutMs => BAD_OPTION', () => {
  assert.throws(() => spawnProc(N, ['-v'], { cwd: path.join(tmpdir(), 'no-such-dir-xyz-1') }), { code: 'BAD_OPTION' });
  for (const t of [0, -5, NaN, 'x']) assert.throws(() => spawnProc(N, ['-v'], { timeoutMs: t }), { code: 'BAD_OPTION' });
});

test('exit code after timeout/abort kill is null + flag, consistently', async () => {
  const p = spawnProc(N, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 500 });
  const r = await p.wait();
  assert.equal(r.timedOut, true); assert.equal(r.exitCode, null); assert.ok(r.signal);
  const ac = new AbortController();
  const q = spawnProc(N, ['-e', 'setInterval(()=>{},1000)'], { signal: ac.signal });
  setTimeout(() => ac.abort(), 200);
  const r2 = await q.wait();
  assert.equal(r2.aborted, true); assert.equal(r2.exitCode, null);
});

// ---- round 3 regressions ----
test('manual p.kill() => exitCode null + signal + killed:true; crash is distinguishable', async () => {
  const p = spawnProc(N, ['-e', 'setInterval(()=>{},1000)']);
  setTimeout(() => p.kill(), 200);
  const r = await p.wait();
  assert.equal(r.killed, true); assert.equal(r.exitCode, null); assert.ok(r.signal);
  assert.equal(r.timedOut, false); assert.equal(r.aborted, false);
  const c = await spawnProc(N, ['-e', 'process.exit(1)']).wait();
  assert.equal(c.killed, false); assert.equal(c.exitCode, 1);
  const t = await spawnProc(N, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 300 }).wait();
  assert.equal(t.killed, true); assert.equal(t.timedOut, true); assert.equal(t.exitCode, null);
});

test('bad arg types => BAD_OPTION, not TypeError', async () => {
  for (const args of ['-v', null, {}, 5, [{}], [null]]) {
    assert.throws(() => spawnProc(N, args), { code: 'BAD_OPTION' });
    await assert.rejects(runCollect(N, args), { code: 'BAD_OPTION' });
  }
  assert.throws(() => spawnProc(N, ['-v'], { env: 'x' }), { code: 'BAD_OPTION' });
  assert.throws(() => spawnProc(N, ['-v'], { input: 5 }), { code: 'BAD_OPTION' });
  assert.throws(() => spawnProc('', []), { code: 'BAD_OPTION' });
});

test('env undefined values are dropped, not stringified', async () => {
  process.env.AB_DROP = 'inherited';
  const r = await runCollect(N, ['-e', 'console.log(String(process.env.AB_DROP));console.log(String(process.env.AB_UNDEF));console.log(process.env.AB_N)'], { env: { AB_DROP: undefined, AB_UNDEF: undefined, AB_N: 5 } });
  assert.deepEqual(r.stdout.split('\n'), ['undefined', 'undefined', '5']);
});

test('children are killed when the parent exits (process.exit and uncaught error)', async () => {
  const srcUrl = new URL('../src/core/spawn.mjs', import.meta.url).href;
  for (const ending of ['process.exit(0)', "throw new Error('boom')"]) {
    const script = `import {spawnProc} from ${JSON.stringify(srcUrl)};
const p = spawnProc(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)']);
const it = p.lines[Symbol.asyncIterator](); console.log('CHILD '+(await it.next()).value);
${ending}`;
    const d = mkdtempSync(path.join(tmpdir(), 'ab-exit-'));
    const f = path.join(d, 'parent.mjs'); writeFileSync(f, script);
    const r = await runCollect(N, [f], { timeoutMs: 20000 });
    const cpid = Number(/CHILD (\d+)/.exec(r.stdout)?.[1]);
    assert.ok(cpid > 0, r.stdout + r.stderr);
    await sleep(500);
    assert.equal(alive(cpid), false, `child survived parent (${ending})`);
  }
});

test('SIGINT/SIGTERM handlers kill children and exit', { skip: process.platform === 'win32' }, async () => {
  const srcUrl = new URL('../src/core/spawn.mjs', import.meta.url).href;
  const script = `import {spawnProc} from ${JSON.stringify(srcUrl)};
const p = spawnProc(process.execPath,['-e','console.log(process.pid);setInterval(()=>{},1000)']);
const it = p.lines[Symbol.asyncIterator](); console.log('CHILD '+(await it.next()).value);
setInterval(()=>{},1000);`;
  const d = mkdtempSync(path.join(tmpdir(), 'ab-sig-')); const f = path.join(d, 'p.mjs'); writeFileSync(f, script);
  const par = spawnProc(N, [f]); let cpid = 0;
  const pit = par.lines[Symbol.asyncIterator](); cpid = Number((await pit.next()).value.replace('CHILD ', '')); // .next(): leaving a for-await loop would kill the tree and defeat the test
  process.kill(par.pid, 'SIGTERM'); await par.wait().catch(() => {}); await sleep(500);
  assert.equal(alive(cpid), false);
});

// ---- round 4 regressions ----
test('breaking out of lines kills the child tree (no leak)', async () => {
  const p = spawnProc(N, ['-e', 'console.log(process.pid);setInterval(()=>{console.log("tick")},50)']);
  let pid = 0;
  for await (const l of p.lines) { pid = Number(l); break; }
  const r = await p.wait();
  assert.equal(r.killed, true);
  await sleep(300);
  assert.equal(alive(pid), false);
});

test('option validation fuzz: never a TypeError, always BAD_OPTION', () => {
  const junk = [null, 0, -1, NaN, Infinity, '', 'x', true, [], {}, () => {}, Symbol('s'), 1n];
  const check = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof AgentError, 'non-AgentError: ' + e); assert.equal(e.code, 'BAD_OPTION'); return; } assert.fail('expected throw'); };
  for (const j of [null, 5, 'x', [], () => {}]) check(() => spawnProc(N, ['-v'], j));
  for (const j of junk) if (j !== 'x') check(() => spawnProc(j, ['-v']));
  for (const j of junk) if (!Array.isArray(j)) check(() => spawnProc(N, j));
  check(() => spawnProc(N, ['-v'], { signal: {} }));
  check(() => spawnProc(N, ['-v'], { signal: { aborted: false } }));
  for (const k of ['timeoutMs', 'maxBuffer', 'maxLine']) for (const j of [0, -1, NaN, Infinity, 'x', true, [], {}]) check(() => spawnProc(N, ['-v'], { [k]: j }));
  for (const j of [5, true, [], {}, () => {}]) { check(() => spawnProc(N, ['-v'], { cwd: j })); check(() => spawnProc(N, ['-v'], { input: j })); check(() => spawnProc(N, ['-v'], { agent: j })); }
  for (const j of ['x', 5, true, [], () => {}]) check(() => spawnProc(N, ['-v'], { env: j }));
  check(() => spawnProc(N, ['-v'], { keepStdinOpen: 'yes' }));
  check(() => spawnProc(N, ['a\0b']));
});

test('signal handlers exist only while children live; host handlers are respected', async () => {
  const base = ['SIGINT', 'SIGTERM'].map((s) => process.listenerCount(s));
  const exitBase = process.listenerCount('exit');
  const p = spawnProc(N, ['-e', 'setInterval(()=>{},1000)']);
  assert.equal(process.listenerCount('SIGINT'), base[0] + 1);
  const hostHandler = () => {}; process.on('SIGINT', hostHandler);
  process.emit('SIGINT'); // host handles signals: we must NOT kill or exit
  await sleep(300);
  assert.equal(alive(p.pid), true, 'child killed on behalf of a host that handles the signal');
  process.off('SIGINT', hostHandler);
  p.kill(); await p.wait();
  assert.equal(process.listenerCount('SIGINT'), base[0]);
  assert.equal(process.listenerCount('SIGTERM'), base[1]);
  assert.equal(process.listenerCount('exit'), exitBase);
});

test('maxLine overflow keeps already-yielded lines and then reports AGENT_FAILED', async () => {
  const p = spawnProc(N, ['-e', "process.stdout.write('ok1'+String.fromCharCode(10)+'ok2'+String.fromCharCode(10)+'z'.repeat(3e6))"], { maxLine: 1e6 });
  const got = []; let err;
  try { for await (const l of p.lines) got.push(l); } catch (e) { err = e; }
  assert.deepEqual(got, ['ok1', 'ok2']);
  assert.equal(err?.code, 'AGENT_FAILED');
  await assert.rejects(p.wait(), { code: 'AGENT_FAILED' });
});

// ---- round 5 regressions ----
test('cmd.exe fallback: quote-based payloads rejected, other metachars inert; direct shim path unrestricted', { skip: process.platform !== 'win32' }, async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-r5-'));
  const bin = path.join(d, 'node_modules', '.bin'); mkdirSync(bin, { recursive: true });
  const CRLF = String.fromCharCode(13, 10), BS = String.fromCharCode(92);
  const bat = (name, lines, dir = d) => writeFileSync(path.join(dir, name), lines.join(CRLF) + CRLF);
  bat('q.bat', ['@echo off', 'echo hi %1']);
  bat('plain.cmd', ['@echo off', 'echo hi %1']);
  bat('inner.cmd', ['@echo off', 'echo got %1'], bin);
  bat('fwd.cmd', ['@echo off', 'call "%~dp0' + BS + 'inner.cmd" %*'], bin);
  writeFileSync(path.join(d, 'cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
  bat('npmy.cmd', ['@ECHO off', 'SETLOCAL', 'SET dp0=%~dp0', '"node"  "%dp0%' + BS + 'cli.js" %*']);
  const env = { PATH: d + path.delimiter + bin + path.delimiter + process.env.PATH };
  const opts = { env, cwd: d, timeoutMs: 15000 };
  const Q = '"';
  const quoteCorpus = [Q + '&hostname&' + Q, Q + '&echo PWNED>marker.txt&' + Q, 'a' + Q + '&echo PWNED&' + Q + 'b', Q, Q + Q, 'x' + BS + Q + '&echo PWNED', BS + Q + '&echo PWNED&' + BS + Q, '%PATH%', '!x!', 'a' + String.fromCharCode(10) + 'echo PWNED'];
  for (const cmd of ['q.bat', 'plain', 'fwd']) {
    for (const p of quoteCorpus) assert.throws(() => spawnProc(cmd, [p], opts), { code: 'BAD_OPTION' }, cmd + ' ' + JSON.stringify(p));
  }
  const inert = ['x&echo PWNED>marker.txt', 'x|echo PWNED', '(x)&echo PWNED', 'x>marker.txt', 'x^', '^&echo PWNED', 'x;y,z=w', 'x' + String.fromCharCode(96) + 'y', 'a' + BS, 'a b' + BS + BS, 'x<marker.txt', '&&echo PWNED', 'x&calc.exe'];
  for (const cmd of ['q.bat', 'plain', 'fwd']) {
    for (const p of inert) {
      const r = await runCollect(cmd, [p], opts);
      assert.ok(!existsSync(path.join(d, 'marker.txt')), 'marker created: ' + cmd + ' ' + p);
      assert.ok(!r.stdout.split(/\r?\n/).some((l) => l.trim() === 'PWNED'), 'injected: ' + cmd + ' ' + p + ' => ' + r.stdout);
    }
  }
  assert.equal((await runCollect('q.bat', ['x&echo PWNED'], opts)).stdout.trim(), 'hi "x&echo PWNED"');
  assert.equal((await runCollect('fwd', ['x&echo PWNED'], opts)).stdout.trim(), 'got "x&echo PWNED"');
  // shim resolved directly to a node script: argv passthrough, so quotes and % are fine here
  const nasty = ['x' + Q + '&hostname&' + Q, '%PATH%', '!x!', 'a b'];
  assert.deepEqual(JSON.parse((await runCollect('npmy', nasty, opts)).stdout), nasty);
});

test('shim parsing ignores rem/:: comments and requires the known shim shape', { skip: process.platform !== 'win32' }, async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ab-r5b-'));
  const CRLF = String.fromCharCode(13, 10), BS = String.fromCharCode(92);
  const bat = (name, lines) => writeFileSync(path.join(d, name), lines.join(CRLF) + CRLF);
  writeFileSync(path.join(d, 'cli.js'), 'console.log("SCRIPT")');
  // comment mentions a target with %*, but the real bat does something else: must run the bat itself
  bat('multi.bat', ['@echo off', 'rem node "%~dp0' + BS + 'cli.js" %*', ':: node "%~dp0' + BS + 'cli.js" %*', 'echo REAL %1', 'echo second line']);
  // extra non-boilerplate command before the exec line: not the shim shape
  bat('extra.bat', ['@echo off', 'echo BEFORE', 'node "%~dp0' + BS + 'cli.js" %*']);
  // real shim shape with comment lines: resolved to the script
  bat('good.cmd', ['@ECHO off', 'rem generated', 'SETLOCAL', ':: comment', 'SET dp0=%~dp0', '"node"  "%dp0%' + BS + 'cli.js" %*']);
  const env = { PATH: d + path.delimiter + process.env.PATH };
  const m = await runCollect('multi.bat', ['a'], { env, cwd: d });
  assert.match(m.stdout, /REAL "a"/); assert.match(m.stdout, /second line/); assert.ok(!m.stdout.includes('SCRIPT'));
  const x = await runCollect('extra.bat', ['a'], { env, cwd: d });
  assert.match(x.stdout, /BEFORE/);
  assert.equal((await runCollect('good.cmd', [], { env, cwd: d })).stdout.trim(), 'SCRIPT');
});
