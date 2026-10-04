#!/usr/bin/env node
// agentbridge CLI (`ab` / `agentbridge`). Plain Node ESM, zero deps. See CONTRACT.md for the full spec.
import { parseArgs, UsageError, num, readStdin } from './args.mjs';
import { run, runTracked, ask, agents, AgentError, stats, contextOf, handoff, compact, wait, fanout, race, doctor } from '../index.mjs';
import { runBudgeted } from '../extras/budget.mjs';
import { runInWorktree } from '../extras/worktree.mjs';
import { listRuns, loadRun, summarize, cancelRun, sweep } from '../bridge/runs.mjs';
import { listSessions } from '../telemetry/stats.mjs';

const out = (o) => process.stdout.write(typeof o === 'string' ? o + (o.endsWith('\n') ? '' : '\n') : JSON.stringify(o, null, 2) + '\n');
const err = (s) => process.stderr.write(String(s).endsWith('\n') ? s : s + '\n');
const AGENT_NAMES = new Set(agents.names);

function checkAgent(a) { if (!AGENT_NAMES.has(a)) throw new UsageError(`Unknown agent "${a}". Expected one of: ${agents.names.join(', ')}`); }

async function promptFrom(_, flags) {
  if (_[1] === '-' || (flags.stdinPrompt && _.length < 2)) return readStdin();
  if (_.length >= 2) return _.slice(1).join(' ');
  if (!process.stdin.isTTY) { const s = await readStdin(); if (s.trim()) return s; }
  throw new UsageError('missing prompt (pass it as an argument, or pipe it on stdin with `-`)');
}

// every CLI run leaves a run record, so `ab ps`, `ab stats` and `ab ui` can see it
const cliGen = (agent, opts) => runTracked(agent, opts, { origin: 'cli' });

function baseOpts(flags, prompt) {
  const o = { prompt };
  if (flags.model) o.model = flags.model;
  if (flags.effort) o.effort = flags.effort;
  if (flags.permissions) o.permissions = flags.permissions;
  if (flags.cwd) o.cwd = flags.cwd;
  if (flags.timeout != null) o.timeoutMs = num(flags, 'timeout', { min: 0 }) * 1000;
  if (flags.system) o.systemPrompt = flags.system;
  if (flags.fallback) o.fallback = String(flags.fallback).split(',').map((x) => x.trim()).filter(Boolean);
  if (flags['fallback-on']) o.fallbackOn = String(flags['fallback-on']).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (flags['json-schema']) { try { o.jsonSchema = JSON.parse(flags['json-schema']); } catch { throw new UsageError('--json-schema must be valid JSON'); } }
  if (flags.session) {
    const mode = flags.session;
    if (!['new', 'ephemeral', 'continue', 'fork'].includes(mode)) throw new UsageError('--session must be new|ephemeral|continue|fork');
    o.session = { mode, ...(flags['session-id'] ? { id: flags['session-id'] } : {}) };
  } else if (flags['session-id']) o.session = { mode: 'continue', id: flags['session-id'] };
  return o;
}

function budgetOf(flags) {
  const b = {};
  if (flags['max-cost'] != null) b.maxCost = num(flags, 'max-cost', { min: 0 });
  if (flags['max-tokens'] != null) b.maxTokens = num(flags, 'max-tokens', { min: 0, int: true });
  if (flags['max-time'] != null) b.maxTimeMs = num(flags, 'max-time', { min: 0 }) * 1000;
  return b;
}

function printEvent(e, json) {
  if (json) return out(JSON.stringify({ event: e })); // NDJSON: one compact line per event, never pretty-printed
  if (e.type === 'session') err(`[session ${e.id}]`);
  else if (e.type === 'text') process.stdout.write(e.delta);
  else if (e.type === 'thinking') err(e.delta);
  else if (e.type === 'tool') err(`[tool ${e.name}]`);
  else if (e.type === 'usage') err(`[usage in=${e.input} out=${e.output}${e.cost != null ? ` cost=$${e.cost}` : ''}]`);
  else if (e.type === 'error') err(`[error] ${e.message}`);
  else if (e.type === 'fallback') err(`[fallback] ${e.from} failed (${e.code}); trying ${e.to}`);
}

function fail(e, json) {
  const code = e instanceof AgentError ? e.code : (e.code === 'USAGE' ? 'USAGE' : 'ERROR');
  if (json) out({ error: { code, message: e.message } }); else err(`error (${code}): ${e.message}`);
  process.exitCode = code === 'USAGE' || code === 'BAD_OPTION' ? 2 : 1;
}

// ---------- commands ----------

async function cmdRun(_, flags, { askOnly = false } = {}) {
  const agent = _[0]; if (!agent) throw new UsageError('usage: ab run <agent> [prompt|-] [flags]');
  checkAgent(agent);
  const prompt = await promptFrom(_, flags);
  let opts = baseOpts(flags, prompt);
  const b = budgetOf(flags);
  const useWorktree = !!flags.worktree;
  const runOne = (a, p) => runBudgeted(a, p, b, { gen: cliGen });
  const exec = (a, p) => (useWorktree ? runInWorktree(a, p, { runOne }) : runOne(a, p));

  if (flags.stream && !askOnly) {
    let sawEvent = false;
    for await (const e of cliGen(agent, opts)) { sawEvent = true; printEvent(e, flags.json); }
    if (!sawEvent) throw new Error('adapter produced no events');
    return;
  }
  const r = await exec(agent, opts);
  if (flags.json) return out(r);
  if (r.aborted) { err(`[budget exceeded: ${r.budget?.exceeded}]`); }
  if (r.fallback) err(`[fallback: ${r.fallback.attempts.map((a) => `${a.agent} ${a.code}${a.retryAfterMs != null ? ` (retry in ${Math.round(a.retryAfterMs / 1000)}s)` : ''}`).join(' -> ')} -> answered by ${r.fallback.used}${r.fallback.contextLost ? '; session context was NOT carried over' : ''}]`);
  if (r.worktree) err(`[worktree: ${r.worktree.mode}, ${r.worktree.files.length} file(s) changed]`);
  out(askOnly ? r.text : r.text || '');
  if (!askOnly) err(`[${r.model || opts.model || agent} session=${r.sessionId || '-'} exit=${r.exitCode} ${r.durationMs}ms in=${r.usage?.input ?? '-'} out=${r.usage?.output ?? '-'}${r.usage?.cost != null ? ` cost=$${r.usage.cost}` : ''}]`);
  if (r.worktree?.diff) out(r.worktree.diff);
  if (r.exitCode && r.exitCode !== 0) process.exitCode = 1;
}

function targetsFrom(_, flags) {
  const ts = (flags.agents ? flags.agents.split(',') : _.slice(1)).map((s) => s.trim()).filter(Boolean);
  if (!ts.length) throw new UsageError('usage: ab fanout|race "<prompt>" agent[:model] [agent[:model] ...] (or --agents a,b)');
  return ts;
}

async function cmdFanoutRace(mode, _, flags) {
  const prompt = _[0]; if (!prompt) throw new UsageError('usage: ab fanout|race "<prompt>" agent[:model] ...');
  const targets = targetsFrom(_, flags);
  for (const t of targets) checkAgent(String(t).split(':')[0]);
  const opts = baseOpts(flags, prompt); delete opts.prompt;
  const runOpts = { prompt, ...opts };
  const o = { gen: cliGen, budget: budgetOf(flags), worktree: !!flags.worktree, concurrency: flags.concurrency ? num(flags, 'concurrency', { min: 1, int: true }) : undefined };
  const res = mode === 'race' ? await race(targets, runOpts, o) : await fanout(targets, runOpts, o);
  if (flags.json) return out(res);
  if (mode === 'race') {
    if (res.winner) { out(res.winner.text); err(`[winner: ${res.winner.agent}${res.winner.model ? ':' + res.winner.model : ''} ${res.winner.durationMs}ms]`); }
    else err('[no winner: every target failed or was rejected]');
    for (const l of res.losers) err(`  loser ${l.agent}${l.model ? ':' + l.model : ''}: ${l.cancelled ? 'cancelled' : l.error ? l.error.message : l.skipped ? 'skipped (budget)' : 'not accepted'}`);
    if (!res.winner) process.exitCode = 1;
  } else {
    for (const r of res.results) { err(`=== ${r.agent}${r.model ? ':' + r.model : ''} ${r.ok ? 'ok' : 'FAILED'} ${r.durationMs}ms ===`); out(r.ok ? r.text : `(${r.error ? r.error.message : r.aborted ? 'aborted/budget' : 'no output'})`); }
    if (res.results.some((r) => !r.ok)) process.exitCode = 1;
  }
}

async function cmdSessions(_, flags) {
  const rows = listSessions().sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  if (flags.json) return out(rows);
  if (!rows.length) return out('(no sessions)');
  for (const s of rows) out(`${s.sessionId}  ${s.agent}/${s.model || '?'}  runs=${s.runCount || 0}  ${new Date(s.lastAt || 0).toISOString()}`);
}

async function cmdPs(_, flags) {
  const rows = listRuns().filter((r) => r.state === 'running').map(summarize);
  if (flags.json) return out(rows);
  if (!rows.length) return out('(no active runs)');
  for (const r of rows) out(`${r.id}  ${r.agent}${r.model ? '/' + r.model : ''}  ${(r.elapsedMs / 1000).toFixed(0)}s  ${r.sessionId || '-'}`);
}

async function cmdTop(_, flags) {
  const once = flags.once || !process.stdout.isTTY;
  const render = () => {
    const s = stats();
    const lines = [`agentbridge top — ${new Date().toISOString()}  global maxPct=${s.global.maxPct != null ? (s.global.maxPct * 100).toFixed(0) + '%' : '-'} active=${s.global.activeRuns} idle=${s.global.idleRuns}`, ''];
    for (const a of Object.keys(s.agents)) { const g = s.agents[a]; lines.push(`${a.padEnd(10)} sessions=${g.sessions} active=${g.active} tokens=${g.contextTokens} pct=${g.pct != null ? (g.pct * 100).toFixed(0) + '%' : '-'} cost=${g.cost != null ? '$' + g.cost.toFixed(4) : '-'}`); }
    lines.push('', 'running:');
    for (const r of listRuns().filter((r) => r.state === 'running')) lines.push(`  ${r.id} ${r.agent} ${(((r.lastEventAt || Date.now()) - r.startedAt) / 1000).toFixed(0)}s`);
    if (once) return out(lines.join('\n'));
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  };
  render();
  if (!once) { const iv = setInterval(render, 2000); iv.unref?.(); await new Promise((res) => process.on('SIGINT', () => { clearInterval(iv); res(); })); }
}

async function cmdStats(_, flags) { out(flags.json ? stats() : summarizeStats(stats())); }
function summarizeStats(s) {
  const lines = [`sessions=${s.global.sessions} activeRuns=${s.global.activeRuns} idleRuns=${s.global.idleRuns} maxPct=${s.global.maxPct != null ? (s.global.maxPct * 100).toFixed(0) + '%' : '-'} cost=${s.global.cost != null ? '$' + s.global.cost.toFixed(4) : '-'}`];
  for (const [a, g] of Object.entries(s.agents)) lines.push(`  ${a}: sessions=${g.sessions} tokens=${g.contextTokens} pct=${g.pct != null ? (g.pct * 100).toFixed(0) + '%' : '-'}`);
  return lines.join('\n');
}

async function cmdContext(_, flags) {
  const sid = _[0]; if (!sid) throw new UsageError('usage: ab context <session> [--agent a]');
  const c = contextOf(sid, { agent: flags.agent });
  if (!c) { process.exitCode = 1; if (flags.json) return out({ error: 'unknown session' }); err('unknown session'); return; }
  out(flags.json ? c : `${c.agent}/${c.sessionId} tokens=${c.tokens}/${c.window} (${c.pct != null ? (c.pct * 100).toFixed(1) + '%' : '-'}) source=${c.source} exact=${c.exact}`);
}

async function cmdHandoff(_, flags) {
  const sid = _[0]; if (!sid || !flags.to) throw new UsageError('usage: ab handoff <session> --to <agent> [--agent source-agent]');
  checkAgent(flags.to);
  const h = await handoff(sid, flags.to, { agent: flags.agent, cwd: flags.cwd, seed: flags.seed !== false });
  out(flags.json ? h : `handed off ${sid} -> ${flags.to} new session ${h.newSessionId || '-'} (doc: ${h.path || h.docPath || '-'})`);
}

async function cmdWatch(_, flags, waitMode) {
  const id = _[0]; if (!id) throw new UsageError(`usage: ab ${waitMode ? 'wait' : 'watch'} <run|session>`);
  const r = await wait(id, { timeoutMs: flags.timeout ? num(flags, 'timeout', { min: 0 }) * 1000 : 600000 });
  out(flags.json ? r : `${id}: ${r.notFound ? 'not found' : r.waitTimedOut ? 'timed out' : r.status}`);
  if (r.notFound || r.status === 'error') process.exitCode = 1;
}

async function cmdDoctor(_, flags) {
  const ports = flags.port ? [num(flags, 'port', { min: 0, int: true })] : undefined;
  const d = await doctor({ live: !!flags.live, models: flags['no-models'] !== true, ...(ports ? { ports } : {}) });
  if (flags.json) { out(d); if (!d.ok) process.exitCode = 1; return; }
  for (const c of d.checks) out(`[${c.status === 'ok' ? ' ok ' : c.status === 'warn' ? 'WARN' : 'FAIL'}] ${c.name}: ${c.detail}`);
  if (!d.ok) process.exitCode = 1;
}

async function cmdCancel(_, flags) {
  const id = _[0]; if (!id) throw new UsageError('usage: ab cancel <run>');
  const r = cancelRun(id);
  out(flags.json ? r : (r.error || `cancelled ${id} (state=${r.rec?.state})`));
  if (r.error) process.exitCode = 1;
}

async function cmdServe(_, flags) {
  const { startProxy } = await import('../server/index.mjs');
  const p = await startProxy({ port: flags.port ? num(flags, 'port', { min: 0, int: true }) : 8787, host: flags.host, token: flags.token || process.env.AGENTBRIDGE_TOKEN, allowNonLoopback: !!flags['allow-non-loopback'], ...(flags.fallback ? { fallback: String(flags.fallback).split(',').map((x) => x.trim()).filter(Boolean) } : {}) });
  err(`agentbridge proxy listening on ${p.url}`);
  await new Promise((res) => { for (const sg of ['SIGINT', 'SIGTERM']) process.on(sg, () => p.close().then(res)); });
}

async function cmdUi(_, flags) {
  const { startUi } = await import('../ui/server.mjs');
  const u = await startUi({ port: flags.port != null ? num(flags, 'port', { min: 0, int: true }) : 8788, host: flags.host, token: flags.token || process.env.AGENTBRIDGE_TOKEN, allowNonLoopback: !!flags['allow-non-loopback'] });
  const link = u.url + (flags.token || process.env.AGENTBRIDGE_TOKEN ? `/?token=${encodeURIComponent(flags.token || process.env.AGENTBRIDGE_TOKEN)}` : '');
  err(`agentbridge dashboard: ${link}  (read-only, Ctrl+C to stop)`);
  if (flags.open) { const { spawn } = await import('node:child_process'); const [c, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', link]] : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]]; spawn(c, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); }
  await new Promise((res) => { for (const sg of ['SIGINT', 'SIGTERM']) process.on(sg, () => u.close().then(res)); });
}

async function cmdBridge() {
  // src/bridge/mcp.mjs only auto-starts its server when it detects it's the process entry module (it isn't here,
  // main.mjs is), so importing it is side-effect-free; we drive its `serve()` export directly instead.
  const { serve } = await import('../bridge/mcp.mjs');
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...a) => process.stderr.write(...a);
  for (const k of ['log', 'info', 'debug']) console[k] = (...a) => console.error(...a);
  const { shutdown } = serve({ output: { write: (d) => realWrite(d) }, exitOnEnd: true });
  for (const sg of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sg, () => shutdown().finally(() => process.exit(0)));
  await new Promise(() => {}); // runs until stdin closes (handled inside serve)
}

const HELP = `agentbridge (ab) — drive local claude/codex/opencode/agy/pi CLIs and HTTP model endpoints.

  ab run <agent> [prompt|-] [--model][--effort][--permissions][--cwd][--timeout s]
                             [--session new|ephemeral|continue|fork][--session-id id]
                             [--system][--json-schema '<json>'][--stream][--json]
                             [--fallback a,b:model][--fallback-on RATE_LIMITED,TIMEOUT,...]   # next agent when this one is out of tokens
                             [--worktree][--max-cost][--max-tokens][--max-time s]
  ab ask <agent> [prompt|-] [same flags]           # prints only the result text
  ab fanout "<prompt>" agent[:model] ...           # run all, collect all
  ab race   "<prompt>" agent[:model] ...           # first accepted wins, rest cancelled
  ab sessions | ab ps | ab top [--once] | ab stats
  ab context <session> [--agent a]
  ab handoff <session> --to <agent>
  ab watch <run> | ab wait <run> | ab cancel <run>
  ab serve [--port][--host][--token][--allow-non-loopback][--fallback a,b:model]   # answer 429 only when every fallback is also limited
  ab ui [--port 8788][--open][--token t]            # live dashboard: runs, tokens, context, fallbacks (read-only, loopback)
  ab bridge                                        # stdio MCP server
  ab doctor [--live][--json]
  ab install claude [--scope project|user|local] [--permissions read-only|plan|edit|full] [--max-depth N] [--no-agents] [--no-skill]
                                                   # register the bridge in Claude Code + write codex/opencode/ollama relay subagents
  ab endpoint [list] | add <name> <baseUrl> [--type openai|anthropic] [--model m] [--api-key-env VAR] | remove <name>
                                                   # HTTP chat endpoints (Ollama, vLLM, LM Studio, remote gateways...); \`ollama\` is built in
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  let _, flags;
  try { ({ _, flags } = parseArgs(argv.slice(1))); } catch (e) { fail(e, false); return; }
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help' || flags?.help) { out(HELP); return; }
  try {
    switch (cmd) {
      case 'run': await cmdRun(_, flags); break;
      case 'ask': await cmdRun(_, flags, { askOnly: true }); break;
      case 'fanout': await cmdFanoutRace('fanout', _, flags); break;
      case 'race': await cmdFanoutRace('race', _, flags); break;
      case 'sessions': await cmdSessions(_, flags); break;
      case 'ps': await cmdPs(_, flags); break;
      case 'top': await cmdTop(_, flags); break;
      case 'stats': await cmdStats(_, flags); break;
      case 'context': await cmdContext(_, flags); break;
      case 'handoff': await cmdHandoff(_, flags); break;
      case 'watch': await cmdWatch(_, flags, false); break;
      case 'wait': await cmdWatch(_, flags, true); break;
      case 'cancel': await cmdCancel(_, flags); break;
      case 'sweep': out(sweep()); break;
      case 'serve': await cmdServe(_, flags); break;
      case 'ui': await cmdUi(_, flags); break;
      case 'bridge': await cmdBridge(_, flags); break;
      case 'doctor': await cmdDoctor(_, flags); break;
      case 'install': await (await import('./install.mjs')).cmdInstall(_, flags, { out, err }); break;
      case 'endpoint': await (await import('./install.mjs')).cmdEndpoint(_, flags, { out, err }); break;
      default: throw new UsageError(`unknown command "${cmd}". Run "ab --help".`);
    }
  } catch (e) { fail(e, !!flags?.json); }
}

const invoked = process.argv[1] && /main\.mjs$/i.test(process.argv[1].replace(/\\/g, '/'));
if (invoked) main();
export { main };
