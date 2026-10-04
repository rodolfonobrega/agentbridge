// Optional account pool: several logins of the SAME user per agent (each = an env that points the CLI at another config dir).
// OFF unless the operator passes --accounts <file> AND --accept-tos-risk. Spreading load over accounts may violate a provider's
// terms of service; it is the operator's own decision and risk. No fingerprinting or cloaking is done here.
//
// accounts file: { "strategy": "round-robin" | "fill-first" | "sticky",
//                  "claude": [{ "name": "a", "env": { "CLAUDE_CONFIG_DIR": "C:/x/a" } }, ...],
//                  "codex":  [{ "name": "b", "env": { "CODEX_HOME": "C:/x/b" } }] }
import { createHash } from 'node:crypto';

export const TOS_WARNING = 'agentbridge: ACCOUNT POOL ENABLED. Rotating requests over several accounts may violate the provider\'s terms of service. You are using it at your own risk; remove --accounts to turn it off.';

const STRATEGIES = ['round-robin', 'fill-first', 'sticky'];
const COOLDOWN_MS = { quota: 30 * 60_000, overloaded: 30_000, rate: 60_000 };
const hash = (s) => createHash('sha256').update(String(s)).digest().readUInt32BE(0);

export function parseAccounts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('accounts must be a JSON object');
  const strategy = raw.strategy ?? 'round-robin';
  if (!STRATEGIES.includes(strategy)) throw new Error(`accounts.strategy must be one of ${STRATEGIES.join('|')}`);
  const byAgent = new Map();
  for (const [agent, list] of Object.entries(raw)) {
    if (agent === 'strategy') continue;
    if (!Array.isArray(list) || !list.length) throw new Error(`accounts.${agent} must be a non-empty array`);
    const names = new Set();
    for (const a of list) {
      if (!a || typeof a.name !== 'string' || !a.name) throw new Error(`accounts.${agent}: every account needs a "name"`);
      if (names.has(a.name)) throw new Error(`accounts.${agent}: duplicate account name "${a.name}"`);
      if (a.env != null && (typeof a.env !== 'object' || Object.values(a.env).some((v) => typeof v !== 'string'))) throw new Error(`accounts.${agent}.${a.name}: env must map names to strings`);
      names.add(a.name);
    }
    byAgent.set(agent, list.map((a) => ({ name: a.name, env: { ...(a.env || {}) } })));
  }
  if (!byAgent.size) throw new Error('accounts defines no agent');
  return { strategy, byAgent };
}

/** The operator must opt in twice (the accounts and the risk); otherwise refuse to start. */
export function assertAccepted(acceptTosRisk) {
  if (acceptTosRisk || process.env.AGENTBRIDGE_ACCEPT_TOS_RISK === '1') return;
  throw new Error('The account pool is disabled by default because rotating accounts may violate provider terms of service. Pass --accept-tos-risk (or AGENTBRIDGE_ACCEPT_TOS_RISK=1) together with --accounts to use it at your own risk.');
}

export function createPool(raw, { now = Date.now } = {}) {
  const { strategy, byAgent } = parseAccounts(raw);
  const state = new Map(); // "agent:name" -> {until, kind, uses, fails}
  const cursor = new Map(); // agent -> next index (round-robin)
  const sticky = new Map(); // "agent:sessionKey" -> account name
  const st = (agent, name) => { const k = `${agent}:${name}`; let s = state.get(k); if (!s) state.set(k, s = { until: 0, kind: null, uses: 0, fails: 0 }); return s; };
  const ready = (agent, a) => st(agent, a.name).until <= now();

  const usable = (agent, exclude) => (byAgent.get(agent) || []).filter((a) => !exclude?.has(a.name) && ready(agent, a));

  return {
    strategy,
    has: (agent) => byAgent.has(agent),
    /** Number of accounts that could still serve `agent` right now (excluding `exclude`). */
    available: (agent, exclude) => usable(agent, exclude).length,
    /** Choose an account; null when the agent has no pool or every account is cooling down / excluded. */
    pick(agent, sessionKey, exclude) {
      const ok = usable(agent, exclude);
      if (!ok.length) return null;
      let a;
      if (strategy === 'fill-first') a = ok[0];
      else if (strategy === 'sticky' && sessionKey) {
        const want = sticky.get(`${agent}:${sessionKey}`);
        a = ok.find((x) => x.name === want) || ok[hash(sessionKey) % ok.length];
      } else {
        const all = byAgent.get(agent), start = cursor.get(agent) ?? 0;
        for (let i = 0; i < all.length && !a; i++) { const c = all[(start + i) % all.length]; if (ok.includes(c)) { a = c; cursor.set(agent, (start + i + 1) % all.length); } }
      }
      if (sessionKey) sticky.set(`${agent}:${sessionKey}`, a.name);
      return a;
    },
    ok(agent, name) { const s = st(agent, name); s.uses++; },
    /** Put an account in cooldown after a RATE_LIMITED error (uses retryAfterMs, else a default per kind). */
    fail(agent, name, err) {
      const s = st(agent, name), kind = err?.kind || 'rate';
      s.fails++; s.kind = kind; s.until = now() + (err?.retryAfterMs > 0 ? err.retryAfterMs : COOLDOWN_MS[kind] ?? COOLDOWN_MS.rate);
    },
    /** ms until the first account of `agent` is usable again (0 if one is). */
    retryAfterMs(agent) {
      const t = now(); let best = Infinity;
      for (const a of byAgent.get(agent) || []) best = Math.min(best, Math.max(0, st(agent, a.name).until - t));
      return Number.isFinite(best) ? best : 0;
    },
    /** Safe to expose: never includes env values. */
    status() {
      const t = now(), out = { strategy, agents: {} };
      for (const [agent, list] of byAgent) out.agents[agent] = list.map((a) => { const s = st(agent, a.name); return { name: a.name, available: s.until <= t, cooldownMs: Math.max(0, s.until - t), kind: s.until > t ? s.kind : null, uses: s.uses, rateLimited: s.fails }; });
      return out;
    },
  };
}
