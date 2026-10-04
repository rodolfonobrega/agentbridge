// Fills AGENTBRIDGE_HOME with SAMPLE run records spread over the last 24 hours, to look at (or screenshot) `ab ui` without spending tokens.
// The records are written through the real tracker and then back-dated; nothing here talks to a model.
//   AGENTBRIDGE_HOME=/tmp/ab-demo node scripts/demo-data.mjs && AGENTBRIDGE_HOME=/tmp/ab-demo ab ui --open
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTracker, telemetryDir } from '../src/telemetry/stats.mjs';

if (!process.env.AGENTBRIDGE_HOME) { console.error('Set AGENTBRIDGE_HOME to a scratch folder first (this writes sample data).'); process.exit(1); }
const H = 3600_000, now = Date.now();
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const AGENTS = [
  { agent: 'claude', model: 'claude-sonnet-4-5', w: 5, ms: [4000, 40000], tok: [6000, 60000], cost: true, tools: ['Read', 'Edit', 'Bash', 'Grep'] },
  { agent: 'codex', model: 'gpt-5.6-luna', w: 4, ms: [6000, 60000], tok: [5000, 50000], tools: ['shell', 'apply_patch'] },
  { agent: 'opencode', model: 'opencode-go/glm-5.3-flash', w: 2, ms: [3000, 30000], tok: [3000, 30000], tools: ['read', 'bash'] },
  { agent: 'agy', model: 'gemini-3.8-flash', w: 2, ms: [5000, 45000], tok: [4000, 40000], tools: ['view_file', 'run_command'] },
  { agent: 'pi', model: 'ollama/glm-5.3-flash:cloud', w: 2, ms: [2000, 20000], tok: [1500, 15000], tools: ['read', 'write'] },
  { agent: 'ollama', model: 'qwen3:14b', w: 1, ms: [1500, 9000], tok: [200, 2500], tools: [] },
];
const ORIGINS = ['cli', 'cli', 'cli', 'proxy', 'bridge-sync', 'tracker'];
const between = ([a, b]) => Math.round(a + rnd() * (b - a));
const pool = AGENTS.flatMap((a) => Array(a.w).fill(a));

for (let i = 0; i < 70; i++) {
  const a = pick(pool), start = now - Math.floor(rnd() * 23.5 * H), dur = between(a.ms), r = rnd();
  const tr = createTracker({ agent: a.agent, opts: { prompt: pick(['Review the auth module for security bugs', 'Write unit tests for parser.mjs', 'Explain why the build fails on CI', 'Refactor the config loader', 'Summarize the open TODOs in this repo', 'Fix the flaky test in queue.test.mjs']), model: a.model, cwd: 'C:/work/api-service' }, origin: pick(ORIGINS) });
  tr.onEvent({ type: 'session', id: `demo-${i}-${a.agent}` });
  const tin = between(a.tok), tout = Math.round(tin * (0.05 + rnd() * 0.2));
  if (r > 0.1) tr.onEvent({ type: 'usage', input: tin, output: tout, cost: a.cost ? +(tin * 3e-6 + tout * 15e-6).toFixed(4) : undefined });
  const nt = a.tools.length ? between([0, 6]) : 0;
  for (let t = 0; t < nt; t++) tr.onEvent({ type: 'tool', name: pick(a.tools), input: {} });
  tr.onEvent({ type: 'text', delta: 'sample output' });
  if (r < 0.08) tr.finish({ error: Object.assign(new Error('429 Too Many Requests'), { code: 'RATE_LIMITED' }) });
  else if (r < 0.14) tr.finish({ error: Object.assign(new Error('timed out'), { code: 'TIMEOUT' }) });
  else if (r < 0.18) tr.finish({ error: Object.assign(new Error('agent failed'), { code: 'AGENT_FAILED' }) });
  else tr.finish({ result: { text: 'sample output', sessionId: `demo-${i}-${a.agent}`, usage: { input: tin, output: tout, ...(a.cost ? { cost: +(tin * 3e-6 + tout * 15e-6).toFixed(4) } : {}) }, ...(r > 0.9 ? { fallback: { used: pick(['codex', 'claude', 'opencode']), attempts: [{ agent: a.agent, code: 'RATE_LIMITED' }] } } : {}) } });
  const f = path.join(telemetryDir(), 'runs', `${tr.rec.id}.json`), rec = JSON.parse(readFileSync(f, 'utf8'));
  Object.assign(rec, { startedAt: start, lastEventAt: start + dur, endedAt: start + dur });
  writeFileSync(f, JSON.stringify(rec));
}
// a few runs that are still going
for (const a of [AGENTS[0], AGENTS[1]]) {
  const tr = createTracker({ agent: a.agent, opts: { prompt: 'Migrate the database layer to the new ORM', model: a.model, cwd: 'C:/work/api-service' }, origin: 'bridge' });
  tr.onEvent({ type: 'session', id: `demo-live-${a.agent}` }); tr.onEvent({ type: 'tool', name: a.tools[0], input: {} }); tr.onEvent({ type: 'tool', name: a.tools[1], input: {} });
  // this script exits right away: drop the pid so the run is not reported as 'lost', and keep it fresh enough to read as running
  const f = path.join(telemetryDir(), 'runs', `${tr.rec.id}.json`), rec = JSON.parse(readFileSync(f, 'utf8'));
  Object.assign(rec, { pid: null, startedAt: now - 95_000, lastEventAt: now }); writeFileSync(f, JSON.stringify(rec));
}
console.log('sample data written to', telemetryDir());
