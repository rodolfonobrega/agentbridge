import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AgentError } from './errors.mjs';
import { createLineSplitter } from './events.mjs';

const isWin = process.platform === 'win32';

function isFile(p) { try { return statSync(p).isFile(); } catch { return false; } }

/** Resolve a command to an absolute executable path (PATH + PATHEXT on Windows). Returns null if not found. */
export function resolveBinary(cmd, env = process.env) {
  const envGet = (k) => env[k] ?? env[Object.keys(env).find((x) => x.toLowerCase() === k.toLowerCase())];
  const exts = isWin ? (envGet('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasDir = /[\\/]/.test(cmd);
  const dirs = hasDir ? [''] : (envGet('PATH') || '').split(path.delimiter).filter(Boolean);
  const hasExt = isWin && path.extname(cmd) !== '' && exts.some((e) => e.toLowerCase() === path.extname(cmd).toLowerCase());
  for (const d of dirs) {
    const base = hasDir ? path.resolve(cmd) : path.join(d.replace(/^"|"$/g, ''), cmd);
    const cands = isWin ? (hasExt ? [base] : [...exts.map((e) => base + e.toLowerCase()), ...exts.map((e) => base + e)]) : [base];
    for (const c of cands) if (isFile(c)) return c;
  }
  return null;
}

// Windows: node cannot spawn .cmd/.bat directly.
// 1) If the file has exactly the known npm-style shim shape (boilerplate + ONE line that runs a target with %*),
//    spawn the real target (.exe, or .js/.mjs/.cjs via node) directly: args go through the OS argv, no cmd.exe.
// 2) Otherwise run the batch file itself through cmd.exe, which cannot be made injection-proof for arbitrary
//    characters, so any arg containing " % ! CR LF NUL is rejected (BAD_OPTION) and the rest are wrapped in "...".
const SHIM_BOILERPLATE = /^(@?echo\s+off|@?(setlocal|endlocal)\b.*|@?set\s+["']?\w+=.*|if\s.*|\(.*|\).*|goto\s.*|title\s.*|exit\s.*|:\w+)$/i;

function parseShim(txt) {
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(@?rem(\s|$)|::)/i.test(l));
  let exec = null;
  for (const l of lines) {
    if (l.includes('%*')) { if (exec !== null) return null; exec = l; continue; }
    if (!SHIM_BOILERPLATE.test(l)) return null;
  }
  if (exec === null) return null;
  const m = /"%(?:~dp0|dp0%)"?\\?([^"%\r\n]+?)"|"%dp0%\\([^"]+)"|%~dp0\\?([^\s"%]+)/i.exec(exec);
  return m ? (m[1] || m[2] || m[3]).replace(/^\\/, '') : null;
}

function resolveShim(file, args) {
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { file, args };
  try {
    const rel = parseShim(readFileSync(file, 'utf8'));
    if (rel) {
      const target = path.resolve(path.dirname(file), rel);
      const te = path.extname(target).toLowerCase();
      if (isFile(target)) {
        if (te === '.exe') return { file: target, args };
        if (['.js', '.mjs', '.cjs'].includes(te)) {
          const localNode = path.join(path.dirname(file), 'node.exe');
          return { file: isFile(localNode) ? localNode : process.execPath, args: [target, ...args] };
        }
      }
    }
  } catch { /* fall through to running the batch file itself */ }
  return cmdExe(file, args);
}

function cmdExe(file, args) {
  const bad = (m) => new AgentError('BAD_OPTION', m);
  const unsafe = /["%!\r\n\0]/;
  if (unsafe.test(file)) throw bad('Batch file path contains a character unsafe for cmd.exe');
  for (const a of args) {
    if (unsafe.test(a)) throw bad('Argument containing a double quote, %, !, newline or NUL cannot be passed safely to a .cmd/.bat file');
  }
  const q = (a) => '"' + String(a).replace(/(\\+)$/, '$1$1') + '"';
  const line = [q(file), ...args.map(q)].join(' ');
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + line + '"'], verbatim: true };
}

// Live-children registry. Trees are killed on process 'exit' (always) and on SIGINT/SIGTERM/SIGHUP/SIGBREAK
// ONLY when no other listener handles that signal (a host that handles signals itself keeps control; the
// 'exit' hook still reaps children). Handlers exist only while at least one child is live.
const live = new Set();
const SIGS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGBREAK: 21 };
const sigHandlers = new Map();
const killAll = () => { for (const c of live) killTree(c); live.clear(); };
function acquire() {
  if (sigHandlers.size) return;
  process.on('exit', killAll);
  sigHandlers.set('exit', null);
  for (const [sig, n] of Object.entries(SIGS)) {
    const h = () => {
      if (process.listenerCount(sig) > 1) return; // host handles it; do not act on its behalf
      killAll();
      process.exit(128 + n);
    };
    try { process.on(sig, h); sigHandlers.set(sig, h); } catch { /* unsupported on this platform */ }
  }
}
function release() {
  if (live.size || !sigHandlers.size) return;
  process.off('exit', killAll);
  for (const [sig, h] of sigHandlers) if (h) process.off(sig, h);
  sigHandlers.clear();
}

/** Kill a process tree. */
export function killTree(child) {
  if (!child || child.pid == null || child.exitCode !== null || child.signalCode) return;
  if (isWin) {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

/**
 * Start a process. Returns handle:
 *  { pid, lines: AsyncIterable<string> (stdout), stdin: Writable, wait(): Promise<{exitCode,signal,stderr,timedOut,aborted}>, kill() }
 * Never throws for a missing binary synchronously-lazily: throws AgentError NOT_INSTALLED immediately from spawnProc.
 * opts: { cwd, env, input (string written to stdin then closed), keepStdinOpen, timeoutMs, signal, agent }
 */
function validateOpts(cmd, args, opts) {
  const bad = (m) => new AgentError('BAD_OPTION', m);
  if (typeof cmd !== 'string' || !cmd || cmd.includes('\0')) throw bad('command must be a non-empty string');
  if (!Array.isArray(args)) throw bad('args must be an array');
  if (args.some((a) => (typeof a !== 'string' && typeof a !== 'number') || String(a).includes('\0'))) throw bad('args must be strings');
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw bad('opts must be an object');
  const pos = (k) => { if (opts[k] != null && !(typeof opts[k] === 'number' && Number.isFinite(opts[k]) && opts[k] > 0)) throw bad(k + ' must be a positive number'); };
  pos('timeoutMs'); pos('maxBuffer'); pos('maxLine');
  if (opts.cwd != null && (typeof opts.cwd !== 'string' || !opts.cwd || opts.cwd.includes('\0'))) throw bad('cwd must be a string');
  if (opts.env != null && (typeof opts.env !== 'object' || Array.isArray(opts.env))) throw bad('env must be an object');
  if (opts.input != null && typeof opts.input !== 'string') throw bad('input must be a string');
  if (opts.agent != null && typeof opts.agent !== 'string') throw bad('agent must be a string');
  if (opts.keepStdinOpen != null && typeof opts.keepStdinOpen !== 'boolean') throw bad('keepStdinOpen must be a boolean');
  const sg = opts.signal;
  if (sg != null && !(typeof sg === 'object' && typeof sg.aborted === 'boolean' && typeof sg.addEventListener === 'function' && typeof sg.removeEventListener === 'function')) throw bad('signal must be an AbortSignal');
}

export function spawnProc(cmd, args = [], opts = {}) {
  validateOpts(cmd, args, opts);
  if (opts.cwd != null) {
    let ok = false; try { ok = statSync(opts.cwd).isDirectory(); } catch { /* not a dir */ }
    if (!ok) throw new AgentError('BAD_OPTION', `cwd does not exist or is not a directory: ${opts.cwd}`, { agent: opts.agent });
  }
  const env = { ...process.env };
  for (const [k, v] of Object.entries(opts.env || {})) { if (v === undefined || v === null) delete env[k]; else env[k] = String(v); }
  const found = resolveBinary(cmd, env);
  if (!found) throw new AgentError('NOT_INSTALLED', `Executable not found on PATH: ${cmd}`, { agent: opts.agent, binary: cmd });
  const r = resolveShim(found, args.map(String));

  let child;
  try {
    child = nodeSpawn(r.file, r.args, {
      cwd: opts.cwd, env, windowsHide: true, shell: false,
      windowsVerbatimArguments: !!r.verbatim,
      detached: !isWin, // own process group for tree kill on POSIX
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new AgentError(e.code === 'ENOENT' ? 'NOT_INSTALLED' : 'AGENT_FAILED', `spawn ${cmd} failed: ${e.message}`, { agent: opts.agent });
  }

  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  const maxLine = opts.maxLine ?? 16 * 1024 * 1024;
  let stderr = '';
  const errDec = new StringDecoder('utf8');
  child.stderr.on('error', () => {}); // destroy()'d below once we give up on 'close'; never throw for that
  child.stderr.on('data', (d) => { stderr += errDec.write(d); if (stderr.length > 1e6) stderr = stderr.slice(-1e6); });
  child.stdin.on('error', () => {}); // EPIPE etc.

  let timedOut = false, aborted = false, killed = false, spawnError = null;
  live.add(child); acquire();
  const kill = () => { if (child.exitCode === null && !child.signalCode) killed = true; killTree(child); };
  let timer;
  if (opts.timeoutMs > 0) timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
  const onAbort = () => { aborted = true; kill(); };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  // Eagerly drain stdout into a bounded queue so the child never blocks on a full pipe.
  const queue = []; let qBytes = 0, ended = false, streamErr = null, wake = null;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };
  const dec = new StringDecoder('utf8');
  const sp = createLineSplitter({ maxLine });
  const fail = (e) => { if (streamErr) return; streamErr = e; kill(); notify(); };
  const enqueue = (ls) => {
    for (const l of ls) { queue.push(l); qBytes += l.length + 1; }
    if (qBytes > maxBuffer) fail(new AgentError('AGENT_FAILED', `Unconsumed output exceeded maxBuffer (${maxBuffer})`, { agent: opts.agent }));
    notify();
  };
  // Force any stdout consumer still waiting to stop, once we've given up on a natural 'end' event (see the
  // exit/close grace-timeout fallback below): flush whatever the decoder/line-splitter already buffered, then
  // mark ended. Safe to call multiple times; a real 'end' always short-circuits via the `ended` guard.
  const forceEndStdout = () => {
    if (ended) return;
    try { enqueue(sp.push(dec.end())); enqueue(sp.flush()); } catch (e) { if (e.lines) enqueue(e.lines); }
    ended = true; notify();
  };
  child.stdout.on('data', (chunk) => {
    if (streamErr) return;
    try { enqueue(sp.push(dec.write(chunk))); } catch (e) { if (e.lines) enqueue(e.lines); fail(e); }
  });
  child.stdout.on('end', forceEndStdout);
  // Drop our end of the stdio pipes once we've given up on their natural 'end'/'close' (see the exit/close
  // grace-timeout fallback below). This is NOT about unblocking our own JS-level consumers (forceEndStdout /
  // notify already do that) — it is about releasing the libuv pipe handle itself. If a surviving, backgrounded
  // grandchild holds the OS pipe's write end open, the underlying handle stays "active" from Node's point of
  // view even after we've logically moved on, which would otherwise keep the WHOLE HOST PROCESS's event loop
  // non-empty forever (observed: a Node process that ran a turn hitting this path never exits on its own, even
  // long after every promise it handed out has settled). destroy() releases the handle unconditionally,
  // independent of whatever any other process does with its copy of the pipe.
  const releaseStdio = () => {
    child.stdout.on('error', () => {});
    if (!child.stdout.destroyed) child.stdout.destroy();
    if (!child.stderr.destroyed) child.stderr.destroy();
  };

  const done = new Promise((resolve) => {
    let closed = false, graceTimer = null;
    const fin = (exitCode, signal) => {
      if (closed) return; closed = true;
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      clearTimeout(timer); live.delete(child); release();
      opts.signal?.removeEventListener('abort', onAbort);
      // The process is gone (or errored before spawning): stop any stdout consumer still waiting on a pipe
      // 'end'/'close' that may never arrive (see the comment on the 'exit' listener below), and release our
      // end of the stdio pipe handles so a surviving grandchild holding them open can't keep the HOST
      // process's event loop alive forever either.
      forceEndStdout();
      releaseStdio();
      resolve({ exitCode: killed ? null : (exitCode ?? -1), signal: signal ?? (killed ? 'SIGKILL' : null), killed, stderr: (stderr + errDec.end()).trim(), timedOut, aborted, error: spawnError });
    };
    child.on('error', (e) => { spawnError = e; fin(-1, null); });
    child.on('close', (code, sig) => fin(code, sig));
    child.on('exit', (code, sig) => {
      // 'close' normally follows 'exit' almost immediately, once stdio drains — the fast path below resolves
      // from it, unchanged. But if a tool spawned by this process backgrounded a grandchild that inherited
      // this process's stdio pipe handles (e.g. `cmd & disown`), the OS keeps the pipe's write end open via
      // that surviving grandchild even after THIS process is reaped — so Node never sees EOF on stdout/stderr
      // and 'close' never fires, even though the kill (taskkill /T /F or SIGKILL) genuinely succeeded. Without
      // this, `done` (and everything gated on it: wait(), adapters' fetchAc.abort() propagation) would hang
      // forever instead of rejecting ABORTED/TIMEOUT per CONTRACT.md. Give 'close' a short grace window to
      // still win the normal, clean case; only fall back to resolving from 'exit' data if it doesn't.
      if (closed || graceTimer) return;
      graceTimer = setTimeout(() => fin(code, sig), 700);
    });
  });
  // Consumer leaving early (break / return() / throw) kills the process tree: no leaked children.
  const lines = (async function* () {
    let finished = false;
    try {
      for (;;) {
        if (queue.length) { const l = queue.shift(); qBytes -= l.length + 1; yield l; continue; }
        if (streamErr) { finished = true; throw streamErr; }
        if (ended) { finished = true; return; }
        await new Promise((r) => { wake = r; });
      }
    } finally {
      if (!finished) kill();
    }
  })();

  if (opts.input != null) child.stdin.end(String(opts.input));
  else if (!opts.keepStdinOpen) child.stdin.end();

  return {
    pid: child.pid, child, lines, stdin: child.stdin, kill,
    wait: () => done.then((res) => {
      if (streamErr) throw streamErr;
      if (res.error) {
        throw new AgentError(res.error.code === 'ENOENT' ? 'NOT_INSTALLED' : 'AGENT_FAILED', `spawn ${cmd} failed: ${res.error.message}`, { agent: opts.agent });
      }
      return res;
    }),
  };
}

/** Convenience: run to completion, collect stdout. Resolves {stdout, stderr, exitCode, timedOut, aborted}. */
export async function runCollect(cmd, args, opts = {}) {
  const p = spawnProc(cmd, args, opts);
  const out = [];
  for await (const l of p.lines) out.push(l);
  const r = await p.wait();
  return { ...r, stdout: out.join('\n') };
}
