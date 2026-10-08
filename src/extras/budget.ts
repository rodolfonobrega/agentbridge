// feat-budget: --max-cost / --max-tokens / --max-time per run and shared across a fanout. Aborts cleanly via AbortSignal.
import { run as coreRun } from '../index.js';

export interface BudgetLimits {
  maxCost?: number | null;
  maxTokens?: number | null;
  maxTimeMs?: number | null;
}

export interface BudgetSpent {
  tokens: number;
  cost: number;
  timeMs: number;
}

export class Budget {
  limits: BudgetLimits;
  ac: AbortController;
  exceeded: string | null;
  startedAt: number;
  per: Map<string, { tokens: number; cost: number }>;
  timer: NodeJS.Timeout | null;

  constructor({ maxCost, maxTokens, maxTimeMs }: BudgetLimits = {}) {
    for (const [k, v] of Object.entries({ maxCost, maxTokens, maxTimeMs })) {
      if (v != null && !(Number.isFinite(v) && v >= 0)) throw new TypeError(`${k} must be a non-negative number`);
    }
    this.limits = { maxCost: maxCost ?? null, maxTokens: maxTokens ?? null, maxTimeMs: maxTimeMs ?? null };
    this.ac = new AbortController();
    this.exceeded = null;
    this.startedAt = Date.now();
    this.per = new Map();
    this.timer = null;
    if (this.limits.maxTimeMs != null) {
      this.timer = setTimeout(() => this.trip('time'), this.limits.maxTimeMs);
      (this.timer as any).unref?.();
    }
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  get spent(): BudgetSpent {
    let tokens = 0,
      cost = 0;
    for (const u of this.per.values()) {
      tokens += u.tokens;
      cost += u.cost;
    }
    return { tokens, cost, timeMs: Date.now() - this.startedAt };
  }

  trip(what: string): void {
    if (!this.exceeded) {
      this.exceeded = what;
      this.ac.abort();
    }
  }

  track(key: string, e: any): void {
    if (e?.type !== 'usage') return;
    this.per.set(key, { tokens: (e.input || 0) + (e.output || 0), cost: e.cost || 0 });
    this.check();
  }

  check(): string | null {
    const s = this.spent,
      l = this.limits;
    if (l.maxTokens != null && s.tokens > l.maxTokens) this.trip('tokens');
    else if (l.maxCost != null && s.cost > l.maxCost) this.trip('cost');
    else if (l.maxTimeMs != null && s.timeMs > l.maxTimeMs) this.trip('time');
    return this.exceeded;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  toJSON(): { exceeded: string | null; limits: BudgetLimits; spent: BudgetSpent } {
    return { exceeded: this.exceeded, limits: this.limits, spent: this.spent };
  }
}

let seq = 0;

/** Iterate an event generator to its return value, forwarding events. */
export async function drain(it: AsyncGenerator<any, any, any>, onEvent?: (e: any) => void): Promise<any> {
  for (;;) {
    const { value, done } = await it.next();
    if (done) return value;
    if (onEvent) onEvent(value);
  }
}

export async function runBudgeted(
  agent: string | { name: string; [key: string]: any },
  opts: any,
  budget?: Budget | BudgetLimits,
  { gen = coreRun, onEvent }: { gen?: any; onEvent?: (e: any) => void } = {}
): Promise<any> {
  const own = !(budget instanceof Budget);
  const b = own ? new Budget(budget || {}) : budget;
  const key = `r${++seq}`;
  const name = typeof agent === 'string' ? agent : agent.name;
  if (b.exceeded)
    return {
      text: '',
      sessionId: null,
      usage: { input: 0, output: 0 },
      exitCode: null,
      model: opts.model ?? null,
      durationMs: 0,
      timedOut: false,
      skipped: true,
      aborted: true,
      agent: name,
      budget: b.toJSON(),
    };
  const signal = opts.signal ? (AbortSignal as any).any([opts.signal, b.signal]) : b.signal;
  const t0 = Date.now();
  let text = '',
    sessionId: string | null = null,
    usage: any = { input: 0, output: 0 };
  try {
    const r = await drain(gen(agent, { ...opts, signal }), (e: any) => {
      if (e.type === 'text') text += e.delta;
      else if (e.type === 'session') sessionId = e.id;
      else if (e.type === 'usage') usage = { input: e.input, output: e.output, cost: e.cost };
      b.track(key, e);
      if (onEvent) onEvent(e);
    });
    b.track(key, { type: 'usage', ...r.usage });
    return { ...r, agent: name, budget: b.toJSON() };
  } catch (e) {
    if (b.exceeded && !opts.signal?.aborted)
      return {
        text,
        sessionId,
        usage,
        exitCode: null,
        model: opts.model ?? null,
        durationMs: Date.now() - t0,
        timedOut: false,
        aborted: true,
        agent: name,
        budget: b.toJSON(),
      };
    throw e;
  } finally {
    if (own) b.dispose();
  }
}
