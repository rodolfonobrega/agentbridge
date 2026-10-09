// `ab ui`: a read-only local dashboard over telemetry
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { stats, loadTrackedRun } from '../telemetry/stats.js';
import { loadRun } from '../bridge/runs.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const FILES: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const asset = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url));
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const FAILED = new Set(['error', 'timeout', 'lost']);

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
const blank = () => ({
  runs: 0,
  running: 0,
  finished: 0,
  failed: 0,
  cancelled: 0,
  rateLimited: 0,
  rescued: 0,
  tokensIn: 0,
  tokensOut: 0,
  cost: null as number | null,
  toolCalls: 0,
  durations: [] as number[],
});

/** Pure aggregation over stats().runs (exported for the tests). `since` = window start (ms epoch). */
export function summarize(
  runs: any[],
  {
    now = Date.now(),
    sinceMs = 24 * 3600_000,
    buckets = 48,
  }: { now?: number; sinceMs?: number; buckets?: number } = {}
): any {
  const since = now - sinceMs,
    step = sinceMs / buckets;
  const inWin = runs.filter((r) => (r.endedAt || now) >= since && r.startedAt <= now);
  const total = blank(),
    byAgent: Record<string, any> = {},
    byOrigin: Record<string, number> = {},
    tools: Record<string, number> = {},
    timeline = Array.from({ length: buckets }, (_, i) => ({ t: since + i * step, ok: 0, failed: 0, tokens: 0 }));
  for (const r of inWin) {
    const a = (byAgent[r.agent] ||= blank());
    byOrigin[r.origin || 'tracker'] = (byOrigin[r.origin || 'tracker'] || 0) + 1;
    for (const t of [total, a]) {
      t.runs++;
      if (r.status === 'active' || r.status === 'idle') t.running++;
      else if (r.status === 'finished') t.finished++;
      else if (FAILED.has(r.status)) t.failed++;
      else if (r.status === 'cancelled') t.cancelled++;
      if (/^RATE_LIMITED/.test(r.error || '')) t.rateLimited++;
      if (r.fallback) t.rescued++;
      t.tokensIn += r.usage?.input || 0;
      t.tokensOut += r.usage?.output || 0;
      if (typeof r.cost === 'number') t.cost = (t.cost || 0) + r.cost;
      t.toolCalls += r.toolCalls || 0;
      if (r.endedAt) t.durations.push(r.elapsedMs);
    }
    for (const [n, c] of Object.entries(r.toolsByName || {})) tools[n] = (tools[n] || 0) + (c as number);
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((r.startedAt - since) / step)));
    if (r.status === 'finished') timeline[i].ok++;
    else if (FAILED.has(r.status)) timeline[i].failed++;
    timeline[i].tokens += (r.usage?.input || 0) + (r.usage?.output || 0);
  }
  const fin = (t: any) => {
    const d = t.durations.sort((x: number, y: number) => x - y);
    const done = t.finished + t.failed;
    const { durations, ...rest } = t;
    void durations;
    return {
      ...rest,
      successRate: done ? t.finished / done : null,
      medianMs: pct(d, 0.5),
      p95Ms: pct(d, 0.95),
      avgMs: d.length ? Math.round(d.reduce((s: number, x: number) => s + x, 0) / d.length) : null,
    };
  };
  const activeRuns = inWin.filter((r) => r.status === 'active' || r.status === 'idle');
  const activeByAgent: Record<string, number> = {};
  for (const r of activeRuns) activeByAgent[r.agent] = (activeByAgent[r.agent] || 0) + 1;
  const activeAgents = Object.keys(activeByAgent);
  return {
    since,
    now,
    total: fin(total),
    byAgent: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, fin(v)])),
    byOrigin,
    activeRuns: activeRuns.length,
    activeAgents,
    activeByAgent,
    topTools: Object.entries(tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
    timeline,
  };
}

function authOk(req: http.IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(String(got)),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface UiServerResult {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface StartUiOptions {
  port?: number;
  host?: string;
  token?: string;
  env?: NodeJS.ProcessEnv;
  allowNonLoopback?: boolean;
}

/** startUi({port=8788, host='127.0.0.1', token, env, allowNonLoopback}) -> {server, url, port, close()} */
export async function startUi(o: StartUiOptions = {}): Promise<UiServerResult> {
  const host = o.host || '127.0.0.1',
    env = o.env || process.env;
  if (!LOOPBACK.has(host) && !o.allowNonLoopback) {
    throw new Error(
      `Refusing to bind non-loopback host "${host}" (pass allowNonLoopback: true / --allow-non-loopback; the dashboard shows prompts and outputs of your runs)`
    );
  }
  let port = o.port ?? 8788;
  const hostOk = (h?: string) => {
    if (o.allowNonLoopback) return true;
    const m = /^(\[::1\]|[^:]+)(?::(\d+))?$/.exec(h || '');
    return !!m && LOOPBACK.has(m[1].replace(/^\[|\]$/g, '')) && (!m[2] || +m[2] === port);
  };
  const send = (res: http.ServerResponse, code: number, body: any, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(code, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': CSP,
      'referrer-policy': 'no-referrer',
      ...extra,
    });
    res.end(body);
  };
  const json = (res: http.ServerResponse, code: number, v: any) => send(res, code, JSON.stringify(v));

  const server = http.createServer((req, res) => {
    try {
      if (!hostOk(req.headers.host)) return json(res, 403, { error: 'bad host' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'read-only dashboard' });
      const u = new URL(req.url || '/', 'http://x'),
        p = u.pathname.replace(/\/+$/, '') || '/';
      if (p.startsWith('/api/') && !authOk(req, o.token)) return json(res, 401, { error: 'missing or invalid token' });
      if (FILES[p]) {
        const [f, type] = FILES[p];
        return send(res, 200, req.method === 'HEAD' ? '' : asset(f), type);
      }
      if (p === '/api/stats') {
        const sinceMs = Math.min(
          30 * 24 * 3600_000,
          Math.max(60_000, Number(u.searchParams.get('since')) || 24 * 3600_000)
        );
        const now = Date.now();
        const s = stats({ env, persist: false, sinceMs, runLimit: 5000, now });
        return json(res, 200, {
          ...s,
          runs: s.runs.slice(0, 300),
          summary: summarize(s.runs, { now, sinceMs }),
          version: 1,
        });
      }
      let m: RegExpExecArray | null;
      if ((m = /^\/api\/run\/([\w-]{1,64})$/.exec(p))) {
        const r = loadTrackedRun(m[1], env) || loadRun(m[1], env);
        if (!r) return json(res, 404, { error: 'unknown run' });
        const {
          id,
          agent,
          model,
          cwd,
          sessionId,
          state,
          startedAt,
          endedAt,
          tools,
          usage,
          cost,
          error,
          files,
          promptHead,
          textTail,
          origin,
          fallback,
          events,
        } = r as any;
        return json(res, 200, {
          id,
          agent,
          model,
          cwd,
          sessionId,
          state,
          startedAt,
          endedAt,
          tools,
          usage,
          cost,
          error,
          files,
          promptHead,
          textTail,
          origin,
          fallback,
          subagents: (r as any).subagents,
          events: Array.isArray(events) ? events.slice(-40) : undefined,
        });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e: any) {
      json(res, 500, { error: String(e?.message || e) });
    }
  });
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(port, host, () => ok());
  });
  port = (server.address() as any).port;
  const shown = host.includes(':') ? `[${host}]` : host;
  return {
    server,
    port,
    url: `http://${shown}:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        (server as any).closeAllConnections?.();
        server.close(() => ok());
      }),
  };
}
