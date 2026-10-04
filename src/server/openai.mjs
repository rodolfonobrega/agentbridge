// OpenAI-compatible endpoints: POST /v1/chat/completions, POST /v1/responses, GET /v1/models
import { HttpError, rid, now, resolveModel, listModels, effortFrom, buildPrompt, joinSystem, rejectTools, drive, runToEnd,
  mapError, readJson, sendJson, sseStart, sseData, clientAbort, contentText, est } from './common.mjs';

export function openaiError(e) {
  return { error: { message: e.message, type: e.type, param: null, code: e.code } };
}

function finishErr(res, e, started) {
  if (!started) return sendJson(res, e.status === 499 ? 499 : e.status, openaiError(e), e.retryAfter != null ? { 'retry-after': String(e.retryAfter) } : {});
  sseData(res, openaiError(e)); sseData(res, '[DONE]'); res.end();
}

function schemaFromFormat(rf, sys) {
  if (!rf) return undefined;
  if (rf.type === 'json_schema' && rf.json_schema?.schema) return rf.json_schema.schema;
  if (rf.type === 'json_object') sys.push('Reply with a single valid JSON object and nothing else.');
  return undefined;
}

function prepChat(body) {
  if (!Array.isArray(body.messages) || !body.messages.length) throw new HttpError(400, '`messages` must be a non-empty array', 'invalid_request_error', 'invalid_messages');
  rejectTools(body);
  if (body.n != null && body.n !== 1) throw new HttpError(400, 'Only n=1 is supported', 'invalid_request_error', 'unsupported_n');
  const target = resolveModel(body.model);
  const sys = [], turns = [];
  for (const m of body.messages) {
    if (m.role === 'tool' || m.role === 'function' || m.tool_calls || m.function_call) throw new HttpError(400, 'Tool messages/tool_calls are not supported by the agentbridge proxy', 'invalid_request_error', 'tools_not_supported');
    const t = contentText(m.content);
    if (m.role === 'system' || m.role === 'developer') sys.push(t);
    else if (m.role === 'user' || m.role === 'assistant') turns.push({ role: m.role, text: t });
    else throw new HttpError(400, `Unsupported message role "${m.role}"`, 'invalid_request_error', 'invalid_role');
  }
  if (!turns.length) throw new HttpError(400, 'At least one user message is required', 'invalid_request_error', 'invalid_messages');
  const jsonSchema = schemaFromFormat(body.response_format, sys);
  return { target, prompt: buildPrompt(turns), systemPrompt: joinSystem(sys), effort: effortFrom(body.reasoning_effort), jsonSchema };
}

async function chat(req, res, opts) {
  const body = await readJson(req);
  const p = prepChat(body);
  const signal = clientAbort(res);
  const id = rid('chatcmpl-'), created = now(), model = body.model;
  const o = { ...p, signal, timeoutMs: opts.timeoutMs, fallback: opts.fallback };
  const mk = (delta, finish, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], ...extra });
  if (!body.stream) {
    const r = await runToEnd(o);
    return sendJson(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: r.text, refusal: null }, finish_reason: 'stop', logprobs: null }],
      usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output },
    });
  }
  let started = false;
  try {
    const r = await drive(o, {
      onStart() { started = true; sseStart(res); sseData(res, mk({ role: 'assistant', content: '' }, null)); },
      onDelta(d) { if (d) sseData(res, mk({ content: d }, null)); },
    });
    sseData(res, mk({}, 'stop'));
    if (body.stream_options?.include_usage) {
      sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output } });
    }
    sseData(res, '[DONE]'); res.end();
  } catch (e) { if (signal.aborted) return res.end(); throw Object.assign(e, { _started: started }); }
}

function responsesInput(body) {
  const sys = body.instructions ? [body.instructions] : [];
  const turns = [];
  const inp = body.input;
  if (typeof inp === 'string') turns.push({ role: 'user', text: inp });
  else if (Array.isArray(inp)) {
    for (const it of inp) {
      if (typeof it === 'string') { turns.push({ role: 'user', text: it }); continue; }
      const ty = it.type || 'message';
      if (ty !== 'message') throw new HttpError(400, `Input item type "${ty}" is not supported by the agentbridge proxy`, 'invalid_request_error', 'tools_not_supported');
      const t = contentText(it.content);
      if (it.role === 'system' || it.role === 'developer') sys.push(t);
      else if (it.role === 'user' || it.role === 'assistant') turns.push({ role: it.role, text: t });
      else throw new HttpError(400, `Unsupported role "${it.role}"`, 'invalid_request_error', 'invalid_role');
    }
  } else throw new HttpError(400, '`input` must be a string or array', 'invalid_request_error', 'invalid_input');
  if (!turns.length) throw new HttpError(400, 'At least one user input is required', 'invalid_request_error', 'invalid_input');
  return { sys, turns };
}

async function responses(req, res, opts) {
  const body = await readJson(req);
  rejectTools(body);
  const target = resolveModel(body.model);
  const { sys, turns } = responsesInput(body);
  let jsonSchema;
  const f = body.text?.format;
  if (f?.type === 'json_schema' && f.schema) jsonSchema = f.schema; else if (f?.type === 'json_object') sys.push('Reply with a single valid JSON object and nothing else.');
  const signal = clientAbort(res);
  const o = { target, prompt: buildPrompt(turns), systemPrompt: joinSystem(sys), effort: effortFrom(body.reasoning?.effort), jsonSchema, signal, timeoutMs: opts.timeoutMs, fallback: opts.fallback };
  const id = rid('resp_'), msgId = rid('msg_'), created = now(), model = body.model;
  const resp = (status, text, usage) => ({
    id, object: 'response', created_at: created, status, model, error: null, incomplete_details: null, instructions: body.instructions ?? null,
    output: status === 'completed' ? [{ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }] : [],
    parallel_tool_calls: false, tool_choice: 'none', tools: [], temperature: body.temperature ?? null, top_p: body.top_p ?? null,
    usage: usage ? { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } : null,
  });
  if (!body.stream) { const r = await runToEnd(o); return sendJson(res, 200, resp('completed', r.text, r.usage)); }
  let started = false, seq = 0;
  const ev = (type, data) => sseData(res, { type, sequence_number: seq++, ...data }, type);
  try {
    const r = await drive(o, {
      onStart() {
        started = true; sseStart(res);
        ev('response.created', { response: resp('in_progress') }); ev('response.in_progress', { response: resp('in_progress') });
        ev('response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
        ev('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      },
      onDelta(d) { if (d) ev('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: d }); },
    });
    ev('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text: r.text });
    ev('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: r.text, annotations: [] } });
    ev('response.output_item.done', { output_index: 0, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: r.text, annotations: [] }] } });
    ev('response.completed', { response: resp('completed', r.text, r.usage) });
    res.end();
  } catch (e) { if (signal.aborted) return res.end(); throw Object.assign(e, { _started: started }); }
}

export async function models(req, res) {
  const ids = await listModels();
  sendJson(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: id.split('/')[0] })) });
}

/** returns true if handled */
export async function handle(req, res, url, opts) {
  const m = req.method;
  try {
    if (m === 'POST' && url === '/v1/chat/completions') { await chat(req, res, opts); return true; }
    if (m === 'POST' && url === '/v1/responses') { await responses(req, res, opts); return true; }
  } catch (e) {
    finishErr(res, mapError(e), !!e._started);
    return true;
  }
  return false;
}
export { est };
