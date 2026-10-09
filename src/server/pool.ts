// Optional account pool
import { createHash } from 'node:crypto';

export const TOS_WARNING =
  "agentbridge: ACCOUNT POOL ENABLED. Rotating requests over several accounts may violate the provider's terms of service. You are using it at your own risk; remove --accounts to turn it off.";

const STRATEGIES = ['round-robin', 'fill-first', 'sticky'] as const;
export type Strategy = (typeof STRATEGIES)[number];
const STICKY_CAP = 1000; // remembered session->account bindings, oldest dropped past this

const COOLDOWN_MS: Record<string, number> = { quota: 30 * 60_000, overloaded: 30_000, rate: 60_000 };
const hash = (s: string) => createHash('sha256').update(String(s)).digest().readUInt32BE(0);

export interface AccountDef {
  name: string;
  env: Record<string, string>;
}

export interface ParsedAccounts {
  strategy: Strategy;
  byAgent: Map<string, AccountDef[]>;
}

export function parseAccounts(raw: any): ParsedAccounts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('accounts must be a JSON object');
  const strategy: Strategy = raw.strategy ?? 'round-robin';
  if (!STRATEGIES.includes(strategy)) throw new Error(`accounts.strategy must be one of ${STRATEGIES.join('|')}`);
  const byAgent = new Map<string, AccountDef[]>();
  for (const [agent, list] of Object.entries(raw)) {
    if (agent === 'strategy') continue;
    if (!Array.isArray(list) || !list.length) throw new Error(`accounts.${agent} must be a non-empty array`);
    const names = new Set<string>();
    for (const a of list) {
      if (!a || typeof a.name !== 'string' || !a.name) throw new Error(`accounts.${agent}: every account needs a "name"`);
      if (names.has(a.name)) throw new Error(`accounts.${agent}: duplicate account name "${a.name}"`);
      if (a.env != null && (typeof a.env !== 'object' || Object.values(a.env).some((v) => typeof v !== 'string'))) {
        throw new Error(`accounts.${agent}.${a.name}: env must map names to strings`);
      }
      names.add(a.name);
    }
    byAgent.set(
      agent,
      list.map((a: any) => ({ name: a.name, env: { ...(a.env || {}) } }))
    );
  }
  if (!byAgent.size) throw new Error('accounts defines no agent');
  return { strategy, byAgent };
}

/** The operator must opt in twice (the accounts and the risk); otherwise refuse to start. */
export function assertAccepted(acceptTosRisk?: boolean): void {
  if (acceptTosRisk || process.env.AGENTBRIDGE_ACCEPT_TOS_RISK === '1') return;
  throw new Error(
    'The account pool is disabled by default because rotating accounts may violate provider terms of service. Pass --accept-tos-risk (or AGENTBRIDGE_ACCEPT_TOS_RISK=1) together with --accounts to use it at your own risk.'
  );
}

export interface AccountPool {
  strategy: Strategy;
  has: (agent: string) => boolean;
  available: (agent: string, exclude?: Set<string>) => number;
  pick: (agent: string, sessionKey?: string, exclude?: Set<string>) => AccountDef | null;
  ok: (agent: string, name: string) => void;
  fail: (agent: string, name: string, err?: any) => void;
  updateQuota: (agent: string, name: string, quota: { sessionPercent?: number; weeklyPercent?: number; resetsAt?: number | null; isThrottled?: boolean }) => void;
  retryAfterMs: (agent: string) => number;
  status: () => any;
}

export function createPool(raw: any, { now = Date.now }: { now?: () => number } = {}): AccountPool {
  const { strategy, byAgent } = parseAccounts(raw);
  const state = new Map<string, { until: number; kind: string | null; uses: number; fails: number }>();
  const cursor = new Map<string, number>();
  const sticky = new Map<string, string>();
  const st = (agent: string, name: string) => {
    const k = `${agent}:${name}`;
    let s = state.get(k);
    if (!s) {
      s = { until: 0, kind: null, uses: 0, fails: 0 };
      state.set(k, s);
    }
    return s;
  };
  const ready = (agent: string, a: AccountDef) => st(agent, a.name).until <= now();

  const usable = (agent: string, exclude?: Set<string>) =>
    (byAgent.get(agent) || []).filter((a) => !exclude?.has(a.name) && ready(agent, a));

  return {
    strategy,
    has: (agent: string) => byAgent.has(agent),
    available: (agent: string, exclude?: Set<string>) => usable(agent, exclude).length,
    pick(agent: string, sessionKey?: string, exclude?: Set<string>): AccountDef | null {
      const ok = usable(agent, exclude);
      if (!ok.length) return null;
      let a: AccountDef | undefined;
      if (strategy === 'fill-first') {
        a = ok[0];
      } else if (strategy === 'sticky' && sessionKey) {
        const want = sticky.get(`${agent}:${sessionKey}`);
        a = ok.find((x) => x.name === want) || ok[hash(sessionKey) % ok.length];
      } else {
        const all = byAgent.get(agent) || [];
        const start = cursor.get(agent) ?? 0;
        for (let i = 0; i < all.length && !a; i++) {
          const c = all[(start + i) % all.length];
          if (ok.includes(c)) {
            a = c;
            cursor.set(agent, (start + i + 1) % all.length);
          }
        }
      }
      if (sessionKey && a) {
        const k = `${agent}:${sessionKey}`;
        sticky.set(k, a.name);
        while (sticky.size > STICKY_CAP) {
          const oldest = sticky.keys().next();
          if (oldest.done) break;
          sticky.delete(oldest.value);
        }
      }
      return a || null;
    },
    ok(agent: string, name: string) {
      const s = st(agent, name);
      s.uses++;
    },
    fail(agent: string, name: string, err?: any) {
      const s = st(agent, name);
      const kind = err?.kind || 'rate';
      s.fails++;
      s.kind = kind;
      s.until = now() + (err?.retryAfterMs > 0 ? err.retryAfterMs : COOLDOWN_MS[kind] ?? COOLDOWN_MS.rate);
    },
    updateQuota(agent: string, name: string, quota: { sessionPercent?: number; weeklyPercent?: number; resetsAt?: number | null; isThrottled?: boolean }) {
      const s = st(agent, name);
      (s as any).quota = quota;
      const throttled = quota.isThrottled ||
        (typeof quota.sessionPercent === 'number' && quota.sessionPercent >= 95) ||
        (typeof quota.weeklyPercent === 'number' && quota.weeklyPercent >= 95);
      if (throttled) {
        s.kind = 'quota';
        s.until = Math.max(s.until, quota.resetsAt && quota.resetsAt > now() ? quota.resetsAt : now() + COOLDOWN_MS.quota);
      }
    },
    retryAfterMs(agent: string): number {
      const t = now();
      let best = Infinity;
      for (const a of byAgent.get(agent) || []) {
        best = Math.min(best, Math.max(0, st(agent, a.name).until - t));
      }
      return Number.isFinite(best) ? best : 0;
    },
    status() {
      const t = now();
      const out: any = { strategy, agents: {} };
      for (const [agent, list] of byAgent) {
        out.agents[agent] = list.map((a) => {
          const s = st(agent, a.name);
          return {
            name: a.name,
            available: s.until <= t,
            cooldownMs: Math.max(0, s.until - t),
            kind: s.until > t ? s.kind : null,
            uses: s.uses,
            rateLimited: s.fails,
            quota: (s as any).quota || null,
          };
        });
      }
      return out;
    },
  };
}
