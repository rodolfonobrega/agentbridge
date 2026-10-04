// Anthropic-compatible endpoints: POST /v1/messages (+ /count_tokens). GET /v1/models is served by index.mjs.
import { HttpError, rid, resolveModel, effortFrom, effortFromBudget, buildPrompt, joinSystem, rejectTools, drive, runToEnd,
  mapError, readJson, sendJson, sseStart, sseData, clientAbort, contentText, est } from './common.mjs';

export function anthropicError(e) {
  const type = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error' }[e.status] || (e.status >= 500 || e.status === 499 ? 'api_error' : e.type);
  return { type: 'error', error: { type, message: e.message }, request_id: rid('req_') };
}
function finishErr(res, e, started) {
  if (!started) return sendJson(res, e.status, anthropicError(e), e.retryAfter != null ? { 'retry-after': String(e.retryAfter) } : {});
  sseData(res, anthropicError(e), 'error'); res.end();
}

const blockText = (c) => {
  if (Array.isArray(c) && c.some((b) => b && (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'server_tool_use'))) {
    throw new HttpError(400, 'tool_use/tool_result blocks are not supported by the agentbridge proxy', 'invalid_request_error', 'tools_not_supported');
  }
  return contentText(c);
};

function prep(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, 'messages: Field required', 'invalid_request_error');
  rejectTools(body);
  const target = resolveModel(body.model);
  const sys = [];
  if (body.system) sys.push(blockText(body.system));
  const turns = [];
  for (const m of body.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') throw new HttpError(400, `messages: unsupported role "${m.role}"`, 'invalid_request_error');
    turns.push({ role: m.role, text: blockText(m.content) });
  }
  if (turns[turns.length - 1].role !== 'user') throw new HttpError(400, 'The last message must have role "user" (assistant prefill is not supported by the agentbridge proxy)', 'invalid_request_error');
  const effort = effortFrom(body.output_config?.effort) ?? effortFromBudget(body.thinking);
  return { target, prompt: buildPrompt(turns), systemPrompt: joinSystem(sys), effort, turns, sysText: sys.join('\n') };
}

async function messages(req, res, opts) {
  const body = await readJson(req);
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) throw new HttpError(400, 'max_tokens: Field required (positive integer)', 'invalid_request_error');
  const p = prep(body);
  const signal = clientAbort(res);
  const id = rid('msg_'), model = body.model;
  const o = { target: p.target, prompt: p.prompt, systemPrompt: p.systemPrompt, effort: p.effort, signal, timeoutMs: opts.timeoutMs, fallback: opts.fallback };
  const usageOf = (u) => ({ input_tokens: u.input, output_tokens: u.output });
  const skeleton = { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null };
  if (!body.stream) {
    const r = await runToEnd(o);
    return sendJson(res, 200, { ...skeleton, content: [{ type: 'text', text: r.text }], stop_reason: 'end_turn', usage: usageOf(r.usage) });
  }
  let started = false;
  const ev = (type, data) => sseData(res, { type, ...data }, type);
  try {
    const r = await drive(o, {
      onStart() {
        started = true; sseStart(res);
        ev('message_start', { message: { ...skeleton, usage: { input_tokens: est(p.prompt), output_tokens: 1 } } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('ping', {});
      },
      onDelta(d) { if (d) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: d } }); },
    });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: r.usage.input, output_tokens: r.usage.output } });
    ev('message_stop', {});
    res.end();
  } catch (e) { if (signal.aborted) return res.end(); throw Object.assign(e, { _started: started }); }
}

async function countTokens(req, res) {
  const body = await readJson(req);
  const p = prep(body);
  sendJson(res, 200, { input_tokens: est(p.systemPrompt) + est(p.prompt) });
}

export async function handle(req, res, url, opts) {
  try {
    if (req.method === 'POST' && url === '/v1/messages') { await messages(req, res, opts); return true; }
    if (req.method === 'POST' && url === '/v1/messages/count_tokens') { await countTokens(req, res); return true; }
  } catch (e) { finishErr(res, mapError(e), !!e._started); return true; }
  return false;
}
