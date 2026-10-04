// REAL runs: official `openai` and `@anthropic-ai/sdk` packages against the proxy, backed by the real CLIs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { startProxy } from '../src/server/index.mjs';

const T = { timeout: 280000 };
const PONG = 'Reply with exactly the word PONG and nothing else.';
let proxy, oa, an, MODELS = {};

before(async () => {
  proxy = await startProxy({ port: 0 });
  oa = new OpenAI({ apiKey: 'unused', baseURL: proxy.url + '/v1', maxRetries: 0 });
  an = new Anthropic({ apiKey: 'unused', baseURL: proxy.url, maxRetries: 0 });
  const ids = (await oa.models.list()).data.map((m) => m.id);
  MODELS = {
    claude: 'claude/haiku',
    codex: ids.find((i) => i.startsWith('codex/') && /mini|spark/.test(i)) || ids.find((i) => i.startsWith('codex/')),
    opencode: undefined,
  };
  const cands = [process.env.OC_TEST_MODEL, 'opencode-go/glm-5.3-flash', 'opencode-go/deepseek-v4-flash', 'opencode/gpt-5-nano', 'opencode/gpt-5.4-nano', 'opencode/big-pickle', 'opencode/claude-haiku-4-5'].filter(Boolean).map((m) => 'opencode/' + m);
  for (const m of cands) {
    if (!ids.includes(m)) continue;
    try { await oa.chat.completions.create({ model: m, messages: [{ role: 'user', content: 'Say OK' }] }, { timeout: 40000 }); MODELS.opencode = m; break; } catch { /* try next */ }
  }
});
after(() => proxy?.close());

test('GET /v1/models via both SDKs', T, async () => {
  const a = await oa.models.list();
  assert.ok(a.data.some((m) => m.id === 'claude/haiku'));
  const b = await an.models.list();
  assert.ok(b.data.some((m) => m.id === 'claude/haiku'));
  assert.ok(MODELS.codex, JSON.stringify(MODELS));
});

for (const agent of ['claude', 'codex', 'opencode']) {
  const model = () => MODELS[agent];
  if (agent === 'opencode') test('[opencode] a live model exists', () => assert.ok(MODELS.opencode, 'no live opencode model found'));
  test(`[${agent}] openai chat.completions non-stream + system + usage`, T, async () => {
    const r = await oa.chat.completions.create({ model: model(), messages: [{ role: 'system', content: 'Follow instructions literally.' }, { role: 'user', content: PONG }] });
    assert.equal(r.object, 'chat.completion');
    assert.match(r.choices[0].message.content, /PONG/i);
    assert.equal(r.choices[0].finish_reason, 'stop');
    assert.ok(r.usage.total_tokens > 0);
  });
  test(`[${agent}] openai chat.completions stream (multi-turn)`, T, async () => {
    const s = await oa.chat.completions.create({ model: model(), stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'My secret word is KUMQUAT.' }, { role: 'assistant', content: 'Noted.' }, { role: 'user', content: 'What is my secret word? Answer with only the word.' }] });
    let text = '', usage, finish, n = 0;
    for await (const c of s) { n++; text += c.choices[0]?.delta?.content ?? ''; if (c.choices[0]?.finish_reason) finish = c.choices[0].finish_reason; if (c.usage) usage = c.usage; }
    assert.match(text, /KUMQUAT/i); assert.equal(finish, 'stop'); assert.ok(usage?.total_tokens > 0); assert.ok(n >= 3);
  });
  test(`[${agent}] openai responses non-stream + stream`, T, async () => {
    const r = await oa.responses.create({ model: model(), instructions: 'Follow instructions literally.', input: PONG });
    assert.equal(r.status, 'completed'); assert.match(r.output_text, /PONG/i);
    const s = await oa.responses.create({ model: model(), input: PONG, stream: true });
    const types = []; let text = '';
    for await (const e of s) { types.push(e.type); if (e.type === 'response.output_text.delta') text += e.delta; }
    assert.ok(types[0] === 'response.created' && types.at(-1) === 'response.completed' && types.includes('response.output_text.done'), types.join());
    assert.match(text, /PONG/i);
  });
  test(`[${agent}] anthropic messages non-stream`, T, async () => {
    const r = await an.messages.create({ model: model(), max_tokens: 64, system: 'Follow instructions literally.', messages: [{ role: 'user', content: PONG }] });
    assert.equal(r.type, 'message'); assert.equal(r.stop_reason, 'end_turn');
    assert.match(r.content[0].text, /PONG/i); assert.ok(r.usage.output_tokens > 0);
  });
  test(`[${agent}] anthropic messages stream event sequence`, T, async () => {
    const s = await an.messages.create({ model: model(), max_tokens: 64, stream: true, messages: [{ role: 'user', content: PONG }] });
    const types = []; let text = '';
    for await (const e of s) { types.push(e.type); if (e.type === 'content_block_delta') text += e.delta.text; }
    const uniq = types.filter((t, i) => t !== types[i - 1]);
    assert.deepEqual(uniq.filter((t) => t !== 'ping'), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.match(text, /PONG/i);
  });
}

test('claude effort param mapped (reasoning_effort + thinking budget)', T, async () => {
  const r = await oa.chat.completions.create({ model: 'claude/haiku', reasoning_effort: 'low', messages: [{ role: 'user', content: PONG }] });
  assert.match(r.choices[0].message.content, /PONG/i);
});

test('count_tokens estimate', async () => {
  const r = await an.messages.countTokens({ model: 'claude/haiku', messages: [{ role: 'user', content: 'hello world hello world' }] });
  assert.ok(r.input_tokens > 0);
});

test('openai error shapes: unknown model, hosted tools, bad body', async () => {
  await assert.rejects(oa.chat.completions.create({ model: 'nope-xyz', messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e instanceof OpenAI.NotFoundError && e.status === 404 && e.code === 'model_not_found' && e.type === 'invalid_request_error');
  await assert.rejects(oa.chat.completions.create({ model: 'claude/haiku', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search' }] }),
    (e) => e.status === 400 && e.code === 'tools_not_supported');
  await assert.rejects(oa.chat.completions.create({ model: 'claude/haiku', messages: [] }), (e) => e.status === 400);
});

test('anthropic error shapes: unknown model, server tools, missing max_tokens', async () => {
  await assert.rejects(an.messages.create({ model: 'nope-xyz', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    (e) => e instanceof Anthropic.NotFoundError && e.status === 404 && e.error?.type === 'error' && e.error.error.type === 'not_found_error');
  await assert.rejects(an.messages.create({ model: 'claude/haiku', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }),
    (e) => e instanceof Anthropic.BadRequestError && /not supported/.test(e.message));
  await assert.rejects(an.messages.create({ model: 'claude/haiku', messages: [{ role: 'user', content: 'hi' }] }), (e) => e.status === 400);
});

test('auth token enforced (bearer and x-api-key), loopback-only bind', async () => {
  const p = await startProxy({ port: 0, token: 'sekret' });
  try {
    await assert.rejects(new OpenAI({ apiKey: 'wrong', baseURL: p.url + '/v1', maxRetries: 0 }).models.list(), (e) => e.status === 401);
    assert.ok((await new OpenAI({ apiKey: 'sekret', baseURL: p.url + '/v1', maxRetries: 0 }).models.list()).data.length);
    await assert.rejects(new Anthropic({ apiKey: 'wrong', baseURL: p.url, maxRetries: 0 }).models.list(), (e) => e.status === 401);
  } finally { await p.close(); }
  assert.equal(p.url.startsWith('http://127.0.0.1'), true);
  await assert.rejects(startProxy({ host: '0.0.0.0' }), /non-loopback/);
});

test('client abort stops the request quickly (SDK signal, stream)', T, async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 800);
  await assert.rejects(oa.chat.completions.create({ model: 'claude/haiku', stream: true, messages: [{ role: 'user', content: 'Write a 2000 word essay about the history of the bicycle.' }] }, { signal: ac.signal }),
    (e) => e instanceof OpenAI.APIUserAbortError || /abort/i.test(e.name + e.message));
  assert.ok(Date.now() - t0 < 10000);
  assert.ok((await oa.models.list()).data.length); // server still healthy
});

test('abort before output (raw http destroy) does not crash the server', T, async () => {
  await new Promise((resolve) => {
    const rq = http.request(proxy.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' } });
    rq.on('error', () => resolve()); rq.on('close', resolve);
    rq.end(JSON.stringify({ model: 'claude/haiku', messages: [{ role: 'user', content: 'Write a long story.' }] }));
    setTimeout(() => rq.destroy(), 500);
  });
  assert.ok((await oa.models.list()).data.length);
});

// ---------- client tool calling (real CLIs) ----------
const WEATHER = { type: 'function', function: { name: 'get_weather', description: 'Get the current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } };
const ASK = [{ role: 'user', content: 'What is the weather in Paris? You must use the get_weather tool.' }];

test('openai tool calling round trip (claude, MCP bridge)', T, async () => {
  const r = await oa.chat.completions.create({ model: 'claude/haiku', messages: ASK, tools: [WEATHER] });
  const c = r.choices[0];
  assert.equal(c.finish_reason, 'tool_calls');
  const call = c.message.tool_calls[0];
  assert.equal(call.function.name, 'get_weather');
  assert.match(JSON.parse(call.function.arguments).city, /paris/i);
  const r2 = await oa.chat.completions.create({ model: 'claude/haiku', tools: [WEATHER], messages: [...ASK, c.message, { role: 'tool', tool_call_id: call.id, content: '18C and sunny' }] });
  assert.equal(r2.choices[0].finish_reason, 'stop');
  assert.match(r2.choices[0].message.content, /18/);
});

test('anthropic tool calling round trip, streaming (claude, MCP bridge)', T, async () => {
  const tool = { name: 'get_weather', description: 'Get the current weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
  const msgs = [{ role: 'user', content: 'What is the weather in Paris? You must use the get_weather tool.' }];
  const s = an.messages.stream({ model: 'claude/haiku', max_tokens: 500, tools: [tool], messages: msgs });
  const m = await s.finalMessage();
  assert.equal(m.stop_reason, 'tool_use');
  const use = m.content.find((b) => b.type === 'tool_use');
  assert.equal(use.name, 'get_weather'); assert.match(use.input.city, /paris/i);
  const m2 = await an.messages.create({ model: 'claude/haiku', max_tokens: 500, tools: [tool], messages: [...msgs, { role: 'assistant', content: m.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: '18C and sunny' }] }] });
  assert.equal(m2.stop_reason, 'end_turn');
  assert.match(m2.content.map((b) => b.text || '').join(''), /18/);
});

test('tool calling through prompt emulation (codex)', T, async (t) => {
  if (!MODELS.codex) return t.skip('no codex model');
  const r = await oa.chat.completions.create({ model: MODELS.codex, messages: ASK, tools: [WEATHER] });
  assert.equal(r.choices[0].finish_reason, 'tool_calls');
  assert.equal(r.choices[0].message.tool_calls[0].function.name, 'get_weather');
});
