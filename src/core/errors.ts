export const CODES = Object.freeze([
  'NOT_INSTALLED',
  'NOT_LOGGED_IN',
  'TIMEOUT',
  'ABORTED',
  'BAD_OPTION',
  'AGENT_FAILED',
  'RATE_LIMITED',
] as const);

export type ErrorCode = (typeof CODES)[number];

export class AgentError extends Error {
  code: ErrorCode;
  agent?: string;
  exitCode?: number;
  stderr?: string;
  sessionId?: string;
  partial?: any;
  status?: string | number;
  retryAfterMs?: number;
  kind?: 'quota' | 'overloaded' | 'rate';
  fallback?: any;
  fallbackSkipped?: string;
  [key: string]: any;

  constructor(code: ErrorCode | string, message: string, extra: Record<string, any> = {}) {
    super(message);
    if (!CODES.includes(code as ErrorCode)) throw new TypeError(`Unknown AgentError code: ${code}`);
    this.name = 'AgentError';
    this.code = code as ErrorCode;
    Object.assign(this, extra); // e.g. exitCode, stderr, agent, retryAfterMs
  }
}

export const isAgentError = (e: unknown, code?: string): e is AgentError =>
  e instanceof AgentError && (!code || e.code === code);

// Provider-side "you are out of budget / slow down / we are full" messages. Deliberately specific: our own
// "context hard limit reached" and plain "limit" words must NOT match (they are not something another agent can fix).
const RATE_PATTERNS = [
  /\b429\b/,
  /\b529\b/,
  /rate[ _-]?limit/i,
  /too many requests/i,
  /resource[_ ]exhausted/i,
  /insufficient[_ ]quota/i,
  /exceeded your (current )?quota/i,
  /\bquota\b.*\b(exceeded|exhausted|reached)\b/i,
  /\b(exceeded|exhausted|reached)\b.*\bquota\b/i,
  /(usage|message|daily|weekly|monthly|hourly|session|5[- ]hour|token|request)s? limit/i,
  /limit (will )?reset/i,
  /out of (credits?|tokens|usage|messages)/i,
  /insufficient[_ ]credits?/i,
  /credit balance/i,
  /hit (your|the) [a-z -]{0,20}limit/i,
  /you.ve (reached|hit) [a-z -]{0,30}limit/i,
  /overloaded/i,
  /at capacity/i,
  /high demand/i,
  /subscription limit/i,
  /usage cap/i,
];

/** Milliseconds a provider asked us to wait ("retry after 20s", "try again in 3 minutes", "retry-after: 30"), else undefined. */
export function retryAfterMs(text?: string | null): number | undefined {
  const s = String(text ?? '');
  const m =
    /retry[- ]after[":\s]+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hours?)?/i.exec(s) ||
    /(?:try again|retry|resets?|available again)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hours?)/i.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = (m[2] || 's').toLowerCase();
  const k = u === 'ms' ? 1 : u[0] === 's' ? 1000 : u === 'm' || u.startsWith('min') ? 60000 : 3600000;
  return Math.round(n * k);
}

export const looksRateLimited = (text?: string | null): boolean =>
  RATE_PATTERNS.some((re) => re.test(String(text ?? '')));

/**
 * What kind of limit a provider message describes (the right reaction differs):
 *  'quota'      budget/credits/usage window exhausted: switching account/agent helps, waiting only after the reset
 *  'overloaded' provider-side capacity (529/overloaded): short wait, same account is fine
 *  'rate'       per-minute/request rate limit (429): short wait on the same account
 */
export function rateLimitKind(text?: string | null): 'overloaded' | 'quota' | 'rate' {
  const t = String(text ?? '');
  if (/overloaded| 529 |at capacity|high demand/i.test(t)) return 'overloaded';
  if (/quota|credit|usage (limit|cap)|subscription limit|(daily|weekly|monthly|hourly|session|5[- ]hour) limit|limit (will )?reset|out of (usage|messages|tokens)/i.test(t))
    return 'quota';
  return 'rate';
}

/** If `err` is a generic AGENT_FAILED whose message says the provider is rate/usage limited, return the same error as RATE_LIMITED. */
export function asRateLimited(err: unknown): unknown {
  if (!(err instanceof AgentError) || err.code !== 'AGENT_FAILED') return err;
  const blob = `${err.message}\n${err.stderr || ''}`;
  if (!looksRateLimited(blob)) return err;
  const out = new AgentError('RATE_LIMITED', err.message, {
    agent: err.agent,
    exitCode: err.exitCode,
    stderr: err.stderr,
    sessionId: err.sessionId,
    partial: err.partial,
    status: err.status,
    retryAfterMs: err.retryAfterMs ?? retryAfterMs(blob),
    kind: rateLimitKind(blob),
  });
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Value of an HTTP Retry-After header (seconds or an HTTP date) in ms, else undefined. */
export function retryHeaderMs(v?: string | number | null): number | undefined {
  if (v == null || v === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(String(v).trim())) return Math.round(Number(v) * 1000);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}
