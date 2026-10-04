// `ab ui`: a read-only local dashboard over the telemetry agentbridge already records (runs, sessions, context, tokens, fallbacks).
// Loopback only, GET/HEAD only, strict CSP, Host-header check against DNS rebinding. It never starts, cancels or edits anything.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { stats, loadTrackedRun } from '../telemetry/stats.mjs';
import { loadRun } from '../bridge/runs.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const asset = (name) => readFileSync(new URL(`./${name}`, import.meta.url));
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const FAILED = new Set(['error', 'timeout', 'lost']);

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
const blank = () => ({ runs: 0, running: 0, finished: 0, failed: 0, cancelled: 0, rateLimited: 0, rescued: 0, tokensIn: 0, tokensOut: 0, cost: null, toolCalls: 0, durations: [] });

/** Pure aggregation over stats().runs (exported for the tests). `since` = window start (ms epoch). */
export function summarize(runs, { now = Date.now(), sinceMs = 24 * 3600_000, buckets = 48 } = {}) {
  const since = now - sinceMs, step = sinceMs / buckets;
  const inWin = runs.filter((r) => (r.endedAt || now) >= since && r.startedAt <= now);
  const total = blank(), byAgent = {}, byOrigin = {}, tools = {}, timeline = Array.from({ length: buckets }, (_, i) => ({ t: since + i * step, ok: 0, failed: 0, tokens: 0 }));
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
      t.tokensIn += r.usage?.input || 0; t.tokensOut += r.usage?.output || 0;
      if (typeof r.cost === 'number') t.cost = (t.cost || 0) + r.cost;
      t.toolCalls += r.toolCalls || 0;
      if (r.endedAt) t.durations.push(r.elapsedMs);
    }
    for (const [n, c] of Object.entries(r.toolsByName || {})) tools[n] = (tools[n] || 0) + c;
    const i = Math.min(buckets - 1, Math.max(0, Math.floor((r.startedAt - since) / step)));
    if (r.status === 'finished') timeline[i].ok++; else if (FAILED.has(r.status)) timeline[i].failed++;
    timeline[i].tokens += (r.usage?.input || 0) + (r.usage?.output || 0);
  }
  const fin = (t) => {
    const d = t.durations.sort((x, y) => x - y); const done = t.finished + t.failed;
    const { durations, ...rest } = t; void durations;
    return { ...rest, successRate: done ? t.finished / done : null, medianMs: pct(d, 0.5), p95Ms: pct(d, 0.95), avgMs: d.length ? Math.round(d.reduce((s, x) => s + x, 0) / d.length) : null };
  };
  return {
    since, now, total: fin(total), byAgent: Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, fin(v)])), byOrigin,
    topTools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })), timeline,
  };
}

function authOk(req, token) {
  if (!token) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(String(got)), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** startUi({port=8788, host='127.0.0.1', token, env, allowNonLoopback}) -> {server, url, port, close()} */
export async function startUi(o = {}) {
  const host = o.host || '127.0.0.1', env = o.env || process.env;
  if (!LOOPBACK.has(host) && !o.allowNonLoopback) throw new Error(`Refusing to bind non-loopback host "${host}" (pass allowNonLoopback: true / --allow-non-loopback; the dashboard shows prompts and outputs of your runs)`);
  let port = o.port ?? 8788;
  const hostOk = (h) => { if (o.allowNonLoopback) return true; const m = /^(\[::1\]|[^:]+)(?::(\d+))?$/.exec(h || ''); return !!m && LOOPBACK.has(m[1].replace(/^\[|\]$/g, '')) && (!m[2] || +m[2] === port); };
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer', ...extra }); res.end(body); };
  const json = (res, code, v) => send(res, code, JSON.stringify(v));

  const server = http.createServer((req, res) => {
    try {
      if (!hostOk(req.headers.host)) return json(res, 403, { error: 'bad host' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'read-only dashboard' });
      const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/\/+$/, '') || '/';
      if (p.startsWith('/api/') && !authOk(req, o.token)) return json(res, 401, { error: 'missing or invalid token' });
      if (FILES[p]) { const [f, type] = FILES[p]; return send(res, 200, req.method === 'HEAD' ? '' : asset(f), type); }
      if (p === '/api/stats') {
        const sinceMs = Math.min(30 * 24 * 3600_000, Math.max(60_000, Number(u.searchParams.get('since')) || 24 * 3600_000));
        const now = Date.now();
        const s = stats({ env, persist: false, sinceMs, runLimit: 5000, now });
        return json(res, 200, { ...s, runs: s.runs.slice(0, 300), summary: summarize(s.runs, { now, sinceMs }), version: 1 });
      }
      let m;
      if ((m = /^\/api\/run\/([\w-]{1,64})$/.exec(p))) {
        const r = loadTrackedRun(m[1], env) || loadRun(m[1], env);
        if (!r) return json(res, 404, { error: 'unknown run' });
        const { id, agent, model, cwd, sessionId, state, startedAt, endedAt, tools, usage, cost, error, files, promptHead, textTail, origin, fallback, events } = r;
        return json(res, 200, { id, agent, model, cwd, sessionId, state, startedAt, endedAt, tools, usage, cost, error, files, promptHead, textTail, origin, fallback, events: Array.isArray(events) ? events.slice(-40) : undefined });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 500, { error: String(e?.message || e) }); }
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, host, ok); });
  port = server.address().port;
  const shown = host.includes(':') ? `[${host}]` : host;
  return { server, port, url: `http://${shown}:${port}`, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }) };
}
