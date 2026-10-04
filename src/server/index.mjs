// agentbridge compat proxy: OpenAI + Anthropic compatible HTTP API over the local agent CLIs.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { HttpError, sendJson, listModels } from './common.mjs';
import * as openai from './openai.mjs';
import * as anthropic from './anthropic.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function authOk(req, token) {
  if (!token) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  const a = Buffer.from(String(got)), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * startProxy({port=0, host='127.0.0.1', token, allowNonLoopback=false, timeoutMs, fallback}) -> {server, url, port, close()}
 */
export async function startProxy(o = {}) {
  const host = o.host || '127.0.0.1';
  if (!LOOPBACK.has(host) && !o.allowNonLoopback) throw new Error(`Refusing to bind non-loopback host "${host}" (pass allowNonLoopback: true / --allow-non-loopback; this exposes your CLI logins to the network)`);
  const opts = { timeoutMs: o.timeoutMs || 300000, ...(o.fallback ? { fallback: o.fallback } : {}) };
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    const anth = !!req.headers['anthropic-version'] || !!req.headers['x-api-key'];
    const errBody = (e) => (anth || url.startsWith('/v1/messages')) ? anthropic.anthropicError(e) : openai.openaiError(e);
    try {
      if (!authOk(req, o.token)) throw new HttpError(401, 'Invalid or missing API key', 'authentication_error', 'invalid_api_key');
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        const ids = await listModels();
        if (anth) return sendJson(res, 200, { data: ids.map((id) => ({ type: 'model', id, display_name: id, created_at: '1970-01-01T00:00:00Z' })), has_more: false, first_id: ids[0] ?? null, last_id: ids.at(-1) ?? null });
        return openai.models(req, res);
      }
      if (req.method === 'GET' && url === '/') return sendJson(res, 200, { ok: true, service: 'agentbridge-proxy' });
      if (await openai.handle(req, res, url, opts)) return;
      if (await anthropic.handle(req, res, url, opts)) return;
      throw new HttpError(404, `Unknown route ${req.method} ${url}`, 'invalid_request_error', 'not_found');
    } catch (e) {
      const he = e instanceof HttpError ? e : new HttpError(500, String(e?.message || e), 'api_error');
      if (!res.headersSent) sendJson(res, he.status, errBody(he), he.retryAfter != null ? { 'retry-after': String(he.retryAfter) } : {}); else res.end();
    }
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(o.port ?? 0, host, ok); });
  const port = server.address().port;
  return { server, port, url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

// CLI: node src/server/index.mjs [--port N] [--host H] [--token T] [--allow-non-loopback]
if (import.meta.url === new URL(process.argv[1], 'file:///').href || process.argv[1]?.endsWith('server/index.mjs')) {
  const a = process.argv.slice(2), get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  startProxy({ port: Number(get('--port') ?? 8787), host: get('--host'), token: get('--token') || process.env.AGENTBRIDGE_TOKEN, allowNonLoopback: a.includes('--allow-non-loopback') })
    .then((p) => console.log(`agentbridge proxy listening on ${p.url}`), (e) => { console.error(e.message); process.exit(1); });
}
export default { startProxy };
