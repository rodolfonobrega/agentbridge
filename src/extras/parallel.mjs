// feat-parallel: fanout (same prompt to many agents/models, collect all) and race (first good answer wins, the rest are cancelled).
import { Budget, runBudgeted } from './budget.mjs';
import { askWithSchema } from './schema.mjs';
import { runInWorktree } from './worktree.mjs';

/** "claude:haiku" | "codex" | "opencode:opencode-go/glm" | {agent, model} -> {agent, model} */
export function parseTarget(t) {
  if (t && typeof t === 'object') return { agent: t.agent, model: t.model };
  const s = String(t).trim(), i = s.indexOf(':');
  return i < 0 ? { agent: s, model: undefined } : { agent: s.slice(0, i), model: s.slice(i + 1) || undefined };
}

/** Run one target with all extras (budget, schema, worktree). Returns a Result. */
export function execOne(agent, opts, { budget, schema, retries, worktree, gen, onEvent } = {}) {
  const runOne = (a, p) => runBudgeted(a, p, budget || {}, { gen, onEvent });
  const inner = (a, p) => (worktree ? runInWorktree(a, p, { runOne }) : runOne(a, p));
  return schema ? askWithSchema(agent, opts, { schema, retries, runOne: inner }) : inner(agent, opts);
}

const entry = (t, r, e, t0) => ({
  agent: t.agent, model: t.model ?? r?.model ?? null, ok: !!r && !e && !r.aborted && r.exitCode === 0 && !(r.schema && !r.schema.valid),
  skipped: !!r?.skipped, aborted: !!r?.aborted, text: r?.text ?? '', result: r || null,
  error: e ? { code: e.code || 'ERROR', message: e.message } : null, durationMs: Date.now() - t0,
});

/**
 * fanout(targets, opts, {budget: limits|Budget, concurrency, schema, retries, worktree, gen, onEvent, exec})
 * -> {results: [{agent, model, ok, text, result, error, skipped, aborted, durationMs}], budget}. Never rejects for a failing agent.
 * A shared budget covers all runs together; once exceeded, running ones are aborted and unstarted ones are skipped.
 */
export async function fanout(targets, opts, o = {}) {
  const ts = targets.map(parseTarget);
  if (!ts.length) throw new TypeError('fanout needs at least one target');
  const shared = o.budget instanceof Budget ? o.budget : new Budget(o.budget || {});
  const limit = Math.max(1, o.concurrency || ts.length), out = new Array(ts.length); let next = 0;
  const exec = o.exec || execOne;
  const worker = async () => {
    for (;;) {
      const i = next++; if (i >= ts.length) return;
      const t = ts[i], t0 = Date.now();
      try { out[i] = entry(t, await exec(t.agent, { ...opts, ...(t.model ? { model: t.model } : {}) }, { ...o, budget: shared, onEvent: o.onEvent && ((e) => o.onEvent(e, t, i)) }), null, t0); }
      catch (e) { out[i] = entry(t, null, e, t0); }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(limit, ts.length) }, worker)); } finally { if (!(o.budget instanceof Budget)) shared.dispose(); }
  return { results: out, budget: shared.toJSON() };
}

/**
 * race(targets, opts, {accept(entry)=>bool, budget, schema, worktree, gen, exec})
 * First entry that is ok AND accepted (default: non-empty text) wins; every other run is aborted and awaited, so when race()
 * resolves no child process of a loser is left running. -> {winner|null, losers:[entry], results, budget}
 */
export async function race(targets, opts, o = {}) {
  const ts = targets.map(parseTarget);
  const ac = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal;
  const accept = o.accept || ((e) => e.text.trim().length > 0);
  const shared = o.budget instanceof Budget ? o.budget : new Budget(o.budget || {});
  const exec = o.exec || execOne; let winner = null; const out = new Array(ts.length);
  await Promise.all(ts.map(async (t, i) => {
    const t0 = Date.now(); let e;
    try { e = entry(t, await exec(t.agent, { ...opts, ...(t.model ? { model: t.model } : {}), signal }, { ...o, budget: shared }), null, t0); }
    catch (err) { e = entry(t, null, err, t0); }
    if (!winner && e.ok && accept(e)) { winner = e; e.winner = true; ac.abort(); }
    else if (winner && winner !== e) { e.ok = false; e.cancelled = true; }
    out[i] = e;
  }));
  if (!(o.budget instanceof Budget)) shared.dispose();
  return { winner, losers: out.filter((e) => e !== winner), results: out, budget: shared.toJSON() };
}
