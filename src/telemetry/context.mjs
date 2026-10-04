// Context policy + compaction + cross-agent handoff.
// Policy limits: number <= 1 = fraction of the context window, number > 1 = absolute tokens. Scopes: default < agent < session.
//   {warn, compact, hard, autoCompact:boolean, hardAction:'block'|'handoff', handoffTo:'<agent>'}
// Compaction mechanisms (real, per agent): claude = native "/compact" through --resume (verified: writes a compact summary into the
// session, same session id). codex / opencode expose no non-interactive compact -> summarize-and-continue: a HANDOFF doc is produced
// from a FORK of the session (original untouched) and seeds a new session on the same agent.
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { AgentError } from '../core/errors.mjs';
import { home } from '../bridge/runs.mjs';
import { contextOf, listSessions, telemetryDir } from './stats.mjs';

const LEVELS = ['ok', 'warn', 'compact', 'hard'];
const KEYS = ['warn', 'compact', 'hard', 'autoCompact', 'hardAction', 'handoffTo'];
export const DEFAULT_POLICY = { warn: 0.7, compact: null, hard: null, autoCompact: false, hardAction: 'block', handoffTo: null };

const polFile = (env) => path.join(telemetryDir(env), 'policy.json');
export function loadPolicies(env = process.env) { try { return JSON.parse(readFileSync(polFile(env), 'utf8')); } catch { return {}; } }
function validateLimits(l) {
  for (const k of Object.keys(l)) if (!KEYS.includes(k)) throw new AgentError('BAD_OPTION', `Unknown policy key "${k}"`);
  for (const k of ['warn', 'compact', 'hard']) if (l[k] != null && !(Number.isFinite(l[k]) && l[k] > 0)) throw new AgentError('BAD_OPTION', `policy.${k} must be a positive number (<=1 fraction, >1 tokens)`);
  const w = l.warn, c = l.compact, h = l.hard;
  const ord = [w, c, h].filter((x) => x != null);
  if (ord.some((x, i) => i && (x <= 1) === (ord[i - 1] <= 1) && x < ord[i - 1])) throw new AgentError('BAD_OPTION', 'policy thresholds must satisfy warn <= compact <= hard');
  if (l.hardAction != null && !['block', 'handoff'].includes(l.hardAction)) throw new AgentError('BAD_OPTION', 'hardAction must be block|handoff');
  return l;
}
/** setPolicy({agent?, session?}, limits) persists; with no scope sets the global default. Returns the stored policies. */
export function setPolicy(scope, limits, env = process.env) {
  validateLimits(limits);
  const all = loadPolicies(env);
  const bucket = scope?.session ? ((all.sessions ||= {})[scope.session] ||= {}) : scope?.agent ? ((all.agents ||= {})[scope.agent] ||= {}) : (all.default ||= {});
  Object.assign(bucket, limits);
  mkdirSync(path.dirname(polFile(env)), { recursive: true });
  const tmp = `${polFile(env)}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(all, null, 1)); renameSync(tmp, polFile(env));
  return all;
}
/** Effective policy (pure given `all`): DEFAULT < all.default < all.agents[agent] < all.sessions[id] < inline. */
export function resolvePolicy(agent, sessionId, all = {}, inline = {}) {
  return { ...DEFAULT_POLICY, ...(all.default || {}), ...(all.agents?.[agent] || {}), ...((sessionId && all.sessions?.[sessionId]) || {}), ...(inline || {}) };
}
export const getPolicy = (agent, sessionId, env = process.env, inline) => resolvePolicy(agent, sessionId, loadPolicies(env), inline);

/** Pure: {tokens, window} + limits -> {level, thresholds(abs tokens), pct}. */
export function evaluate({ tokens, window }, limits) {
  const abs = (v) => (v == null ? null : v <= 1 ? Math.round(v * window) : v);
  const th = { warn: abs(limits.warn), compact: abs(limits.compact), hard: abs(limits.hard) };
  let level = 'ok';
  for (const k of ['warn', 'compact', 'hard']) if (th[k] != null && tokens >= th[k]) level = k;
  return { level, thresholds: th, tokens, window, pct: window ? +(tokens / window).toFixed(4) : null };
}
export const levelAtLeast = (a, b) => LEVELS.indexOf(a) >= LEVELS.indexOf(b);

// ---------- handoff document ----------
export const HANDOFF_PROMPT = `Write a HANDOFF for another engineer (possibly another AI agent) who will continue this work with NO access to this conversation.
Use EXACTLY these markdown sections and be concrete (names, paths, values, decisions, exact identifiers/codes mentioned by the user):
## Summary
## Key facts and decisions
## Key files
## Open tasks
Do not use any tools. Do not add other sections.`;

/** Pure: split "## Heading" markdown into {heading: body}. */
export function parseSections(md) {
  const out = {}; let cur = null;
  for (const line of String(md).split('\n')) { const m = /^##\s+(.+?)\s*$/.exec(line); if (m) { cur = m[1].toLowerCase(); out[cur] = ''; } else if (cur) out[cur] += line + '\n'; }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}
/** Pure: assemble the HANDOFF markdown. files = deterministic list from tool-call telemetry (merged with the model's own list). */
export function buildHandoffDoc({ fromAgent, fromSession, toAgent, cwd, summaryMd, files = [], firstPrompt, lastText, degraded = false, viaContinue = false, at = new Date().toISOString() }) {
  const sec = parseSections(summaryMd || '');
  const get = (k, alt) => sec[k] || sec[alt] || '';
  const fileLines = [...new Set([...files, ...(get('key files').split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean))])].slice(0, 60);
  const openTasks = get('open tasks');
  return [
    `# HANDOFF`, ``,
    `- from: ${fromAgent} session ${fromSession}`, `- to: ${toAgent}`, `- cwd: ${cwd || '(unknown)'}`, `- created: ${at}`,
    degraded ? `- note: DEGRADED handoff (the source session could not be summarized; built from recorded telemetry only)` : `- note: summary written by the source agent from its own session${viaContinue ? ' (this agent cannot fork, so the summary request was appended to the source session)' : ''}`,
    ``, `## Summary`, get('summary') || (degraded ? `Original request: ${firstPrompt || '(unknown)'}\n\nLast agent output:\n${lastText || '(none)'}` : '(none)'),
    ``, `## Key facts and decisions`, get('key facts and decisions', 'key facts') || '(none recorded)',
    ``, `## Key files`, fileLines.length ? fileLines.map((f) => `- ${f}`).join('\n') : '(none)',
    ``, `## Open tasks`, openTasks || '(none recorded)', ``,
    `---`, `You are continuing this work. Treat the facts above as authoritative context from the previous agent; verify files before editing.`, ``,
  ].join('\n');
}
export const seedPrompt = (doc) => `${doc}\n\nYou are taking over this work now. Acknowledge by replying with exactly one line: "READY: " followed by one sentence stating what you are continuing.`;

const lazy = () => import('./track.mjs');

/**
 * handoff(sessionId, toAgent, opts): make a session portable.
 * 1) summarize the source (in a FORK, source untouched) into a HANDOFF doc; 2) write it to <home>/handoffs/; 3) unless seed:false,
 * start a new session on toAgent seeded with it. Returns {doc, path, fromAgent, toAgent, newSessionId, ack, seeded, degraded, sourceContext}.
 * opts: agent (source agent), env, seed=true, cwd, model (for toAgent), fromModel, timeoutMs, summarizer(async ({agent,sessionId,cwd})=>md) for tests.
 */
export async function handoff(sessionId, toAgent, opts = {}) {
  const env = opts.env || process.env;
  const { askWithTelemetry } = await lazy();
  const rec = listSessions(env).find((s) => s.sessionId === sessionId && (!opts.agent || s.agent === opts.agent));
  const ctx = contextOf(sessionId, { agent: opts.agent, env });
  const fromAgent = opts.agent || rec?.agent || ctx?.agent;
  if (!fromAgent) throw new AgentError('BAD_OPTION', `Unknown session "${sessionId}": pass opts.agent`);
  const cwd = opts.cwd || rec?.cwd || process.cwd();
  let summaryMd = '', degraded = false;
  const canFork = opts.summarizer ? true : (await (await import('../index.mjs')).agents.get(fromAgent).catch(() => ({}))).canFork !== false;
  try {
    summaryMd = opts.summarizer ? await opts.summarizer({ agent: fromAgent, sessionId, cwd }) : (await askWithTelemetry(fromAgent, { prompt: HANDOFF_PROMPT, session: { mode: canFork ? 'fork' : 'continue', id: sessionId }, cwd, model: opts.fromModel, permissions: 'read-only', timeoutMs: opts.timeoutMs || 240_000 }, { env, hooks: {} })).text;
    if (!parseSections(summaryMd).summary) throw new Error('summary has no "## Summary" section');
  } catch (e) { degraded = true; summaryMd = ''; opts.onDegraded?.(e); }
  const doc = buildHandoffDoc({ fromAgent, fromSession: sessionId, toAgent, cwd, summaryMd, files: rec?.files || [], firstPrompt: rec?.firstPrompt, lastText: rec?.lastText, degraded, viaContinue: !canFork && !degraded });
  const dir = path.join(home(env), 'handoffs'); mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${fromAgent}-${String(sessionId).slice(0, 8)}-to-${toAgent}-${Date.now()}.md`); writeFileSync(file, doc);
  const out = { doc, path: file, fromAgent, toAgent, fromSession: sessionId, newSessionId: null, ack: null, seeded: false, degraded, sourceContext: ctx };
  if (opts.seed !== false) {
    const r = await askWithTelemetry(toAgent, { prompt: seedPrompt(doc), cwd, model: opts.model, permissions: 'read-only', timeoutMs: opts.timeoutMs || 240_000, session: { mode: 'new' } }, { env, hooks: {} });
    out.newSessionId = r.sessionId; out.ack = String(r.text || '').trim(); out.seeded = true;
  }
  return out;
}

/**
 * compact(sessionId, opts): method 'auto' (default) = native if the agent has one, else summarize-and-continue.
 * Returns {method:'native'|'summarize-new-session', sessionId (to use from now on), before, after, ...}.
 * NOTE: `after` is an estimate for native compaction (only the summary is measurable until the next model call).
 */
export async function compact(sessionId, opts = {}) {
  const env = opts.env || process.env;
  const before = contextOf(sessionId, { agent: opts.agent, env });
  const agent = opts.agent || before?.agent;
  if (!agent) throw new AgentError('BAD_OPTION', `Unknown session "${sessionId}": pass opts.agent`);
  const method = opts.method || 'auto';
  const { askWithTelemetry } = await lazy();
  const cwd = opts.cwd || listSessions(env).find((s) => s.sessionId === sessionId)?.cwd || process.cwd();
  if ((method === 'auto' || method === 'native') && agent === 'claude') {
    try {
      await askWithTelemetry('claude', { prompt: '/compact', session: { mode: 'continue', id: sessionId }, cwd, timeoutMs: opts.timeoutMs || 240_000, permissions: 'read-only', isolated: false }, { env, hooks: {}, policy: { warn: null } }); // isolated:false: the adapter's isolation passes --disable-slash-commands, which kills /compact
      const after = contextOf(sessionId, { agent, env });
      if (after?.source === 'claude-compact-summary-estimate') {
        let measured = null;
        if (opts.measure !== false) { // the summary alone understates (system prompt/tools are re-added): one tiny follow-up call gives the true size
          try { await askWithTelemetry('claude', { prompt: 'Reply with exactly: OK', session: { mode: 'continue', id: sessionId }, cwd, timeoutMs: opts.timeoutMs || 240_000, permissions: 'read-only' }, { env, hooks: {}, policy: { warn: null } }); measured = contextOf(sessionId, { agent, env }); } catch { /* keep estimate */ }
        }
        const fin = measured?.exact ? measured : after;
        return { method: 'native', mechanism: 'claude /compact via --resume', sessionId, before, after: fin, afterMeasuredByFollowUp: !!measured?.exact, summaryOnlyEstimate: after };
      }
    } catch (e) { if (method === 'native') throw e; }
  } else if (method === 'native') throw new AgentError('BAD_OPTION', `${agent} has no non-interactive native compact; use method:'summarize'`);
  const h = await handoff(sessionId, agent, { ...opts, agent, env, seed: true });
  return { method: 'summarize-new-session', mechanism: 'handoff doc from forked session seeds a new session', sessionId: h.newSessionId, previousSession: sessionId, handoffPath: h.path, degraded: h.degraded, before, after: h.newSessionId ? contextOf(h.newSessionId, { agent, env }) : null };
}
