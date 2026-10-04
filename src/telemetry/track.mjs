// Thin wrapper around run(): tracks the run (telemetry), fires hooks, applies the context policy.
//   for await (const e of runWithTelemetry('claude', opts, { hooks, policy, env })) ...
// Extra events are type:'raw' with data.abTelemetry = 'context-warning' | 'context-compact' | 'context-hard'.
// The final Result gets an additive `telemetry` field: {runId, context, level, compaction?, hooks:[...]}.
import { AgentError } from '../core/errors.mjs';
import { createTracker, contextOf } from './stats.mjs';
import { fire, summaryOf, mergeHooks, loadGlobalHooks } from './hooks.mjs';
import { getPolicy, evaluate, levelAtLeast, compact, handoff } from './context.mjs';

export async function* runWithTelemetry(agent, opts, tele = {}) {
  const env = tele.env || process.env;
  const { run, validateOptions } = await import('../index.mjs');
  const o = validateOptions(opts); // BAD_OPTION before anything is tracked
  const name = typeof agent === 'string' ? agent : agent.name;
  const hooks = mergeHooks(tele.noGlobalHooks ? {} : loadGlobalHooks(env), tele.hooks || {});
  const hookOpts = { timeoutMs: tele.hookTimeoutMs || 10_000 };
  const pending = []; const hookResults = [];
  const emit = (event, s) => { const p = fire(event, s, hooks, hookOpts).then((r) => { hookResults.push(...r); }); pending.push(p); return p; };
  const policyOf = (sid) => getPolicy(name, sid, env, tele.policy);

  // hard limit: refuse to grow a session already over its limit
  const startSid = o.session?.mode === 'continue' || o.session?.mode === 'fork' ? o.session.id : null;
  if (startSid) {
    const c = contextOf(startSid, { agent: name, env, windows: tele.windows }); const pol = policyOf(startSid);
    if (c && pol.hard != null && evaluate(c, pol).level === 'hard') {
      if (pol.hardAction === 'handoff' && pol.handoffTo) {
        const h = await handoff(startSid, pol.handoffTo, { agent: name, env, cwd: o.cwd });
        throw new AgentError('AGENT_FAILED', `context hard limit reached (${c.tokens}/${c.window} tokens): session handed off to ${pol.handoffTo} session ${h.newSessionId}`, { reason: 'CONTEXT_HARD_LIMIT', handoff: h });
      }
      throw new AgentError('AGENT_FAILED', `context hard limit reached (${c.tokens}/${c.window} tokens, ${c.exact ? 'exact' : 'estimate'}); compact or handoff first`, { reason: 'CONTEXT_HARD_LIMIT', context: c });
    }
  }

  const tr = createTracker({ agent: name, opts: o, env });
  emit('start', summaryOf(tr.rec, 'start'));
  let finished = false, result;
  try {
    const it = run(agent, o);
    for (;;) {
      const { value, done } = await it.next();
      if (done) { result = value; break; }
      tr.onEvent(value);
      yield value;
    }
    const rec = tr.finish({ result });
    finished = true;
    await emit(rec.state === 'timeout' ? 'timeout' : 'finish', summaryOf(rec, rec.state === 'timeout' ? 'timeout' : 'finish'));
  } catch (e) {
    if (!finished) {
      const rec = tr.finish({ error: e }); finished = true;
      await emit(rec.state === 'timeout' ? 'timeout' : 'error', summaryOf(rec, rec.state === 'timeout' ? 'timeout' : 'error'));
    }
    await Promise.allSettled(pending);
    throw e;
  } finally {
    if (!finished) { // consumer abandoned the generator
      const rec = tr.finish({ error: new AgentError('ABORTED', 'consumer stopped iterating') });
      emit('error', summaryOf(rec, 'error'));
      await Promise.allSettled(pending);
    }
  }

  // context policy (after the run, so the session file is up to date)
  const tel = { runId: tr.rec.id, context: null, level: 'ok', compaction: null, hooks: hookResults };
  try {
    const who = result.fallback?.used || name; // a fallback answered: the session (and its context window) belongs to that agent
    const sid = result.sessionId || tr.rec.sessionId;
    const c = sid && o.session?.mode !== 'ephemeral' ? contextOf(sid, { agent: who, env, windows: tele.windows }) : null;
    if (c) {
      tel.context = c; const pol = getPolicy(who, sid, env, tele.policy); const ev = evaluate(c, pol); tel.level = ev.level;
      if (ev.level !== 'ok') {
        const info = { abTelemetry: ev.level === 'hard' ? 'context-hard' : 'context-warning', level: ev.level, sessionId: sid, agent: who, tokens: c.tokens, exact: c.exact, window: c.window, pct: c.pct, thresholds: ev.thresholds };
        yield { type: 'raw', data: info };
        await emit('context-threshold', summaryOf(tr.rec, 'context-threshold', { context: info }));
        if (levelAtLeast(ev.level, 'compact') && pol.autoCompact) {
          const cr = await compact(sid, { agent: who, env, cwd: o.cwd });
          tel.compaction = { method: cr.method, sessionId: cr.sessionId, before: cr.before?.tokens, after: cr.after?.tokens };
          yield { type: 'raw', data: { abTelemetry: 'context-compact', ...tel.compaction, previousSession: sid } };
        }
      }
    }
  } catch (e) { tel.policyError = String(e?.message || e); }
  await Promise.allSettled(pending);
  return { ...result, telemetry: tel };
}

/**
 * run() + run record only (no hooks, no context policy, no extra events): what the CLI, the proxy and the bridge use so that
 * their runs show up in stats() and in `ab ui`. Never changes behaviour; a failure to write the record is swallowed by the tracker.
 */
export async function* runTracked(agent, opts, { env = process.env, origin = 'tracker' } = {}) {
  const { run } = await import('../index.mjs');
  const name = typeof agent === 'string' ? agent : agent.name;
  const tr = createTracker({ agent: name, opts: { ...opts, prompt: String(opts?.prompt ?? '') }, env, origin });
  let finished = false;
  try {
    const it = run(agent, opts);
    for (;;) {
      const { value, done } = await it.next();
      if (done) { tr.finish({ result: value }); finished = true; return value; }
      tr.onEvent(value);
      yield value;
    }
  } catch (e) { if (!finished) { tr.finish({ error: e }); finished = true; } throw e; } finally {
    if (!finished) tr.finish({ error: new AgentError('ABORTED', 'consumer stopped iterating') });
  }
}

export async function askWithTelemetry(agent, opts, tele) {
  const it = runWithTelemetry(agent, opts, tele);
  for (;;) { const { value, done } = await it.next(); if (done) return value; }
}
