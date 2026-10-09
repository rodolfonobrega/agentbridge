// Images in proxy requests: extraction, data: URLs, SSRF guard, limits, unsupported-agent warning (fake adapters, no real CLI).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startProxy } from '../dist/server/index.js';
import { isPrivateIp, findImages, resolveImages, pickAddress } from '../dist/server/images.js';
import { ev } from '../dist/core/events.js';

const PX = 'iVBORw0KGgo='; // not a real PNG; only the type and size are checked
const seen = [];
const mk = (images) => ({ name: 'fake', images, async *run(o) { seen.push(o); yield ev.text('ok'); return { text: 'ok', usage: { input: 1, output: 1 } }; } });
let proxy;
before(async () => { proxy = await startProxy({ port: 0, adapters: { withimg: mk(true), noimg: mk(false) } }); });
after(() => proxy?.close());

const chat = (model, content) => fetch(proxy.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content }] }) });
const dataImg = { type: 'image_url', image_url: { url: `data:image/png;base64,${PX}` } };

test('isPrivateIp', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('findImages: openai, responses and anthropic shapes', () => {
  assert.equal(findImages({ messages: [{ role: 'user', content: [dataImg, { type: 'text', text: 'x' }] }] }).length, 1);
  assert.equal(findImages({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://e.com/a.png' }] }] })[0].url, 'https://e.com/a.png');
  const a = findImages({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PX } }] }] });
  assert.equal(a[0].mediaType, 'image/png');
});

test('pickAddress: the pinning decision returns a validated public address and refuses private ones', () => {
  // production connects to exactly this address, so this pins the fix for TOCTOU DNS rebinding
  assert.equal(pickAddress([{ address: '8.8.8.8' }, { address: '93.184.216.34' }]), '8.8.8.8');
  assert.equal(pickAddress([{ address: '2606:4700::1111' }]), '2606:4700::1111');
  for (const set of [[], [{ address: '127.0.0.1' }], [{ address: '8.8.8.8' }, { address: '10.0.0.5' }], [{ address: '169.254.169.254' }], [{ address: 'fd00::1' }], [{ address: 'not-an-ip' }]]) {
    assert.throws(() => pickAddress(set), (e) => e.status === 400 && /private or local/.test(e.message), JSON.stringify(set));
  }
});

test('the agent receives the decoded image, the prompt has a neutral placeholder', async () => {
  seen.length = 0;
  const r = await chat('withimg/m1', [{ type: 'text', text: 'what is this?' }, dataImg]);
  assert.equal(r.status, 200); assert.equal(r.headers.get('x-agentbridge-warning'), null);
  assert.deepEqual(seen[0].images, [{ mediaType: 'image/png', data: PX }]);
  assert.match(seen[0].prompt, /\[image\]/); assert.doesNotMatch(seen[0].prompt, /omitted/);
});

test('an agent without image support still answers, with a warning header', async () => {
  seen.length = 0;
  const r = await chat('noimg/m1', [{ type: 'text', text: 'hi' }, dataImg]);
  assert.equal(r.status, 200); assert.match(r.headers.get('x-agentbridge-warning'), /images_not_supported/);
  assert.equal(seen[0].images, undefined);
});

test('SSRF: private and local URLs are refused before any fetch', async () => {
  for (const url of ['http://127.0.0.1:1/a.png', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/a.png', 'http://10.0.0.5/a.png', 'ftp://example.com/a.png', 'file:///etc/passwd']) {
    const r = await chat('withimg/m1', [{ type: 'image_url', image_url: { url } }]);
    assert.equal(r.status, 400, url);
    assert.match((await r.json()).error.code, /image_url_blocked|invalid_image/);
  }
});

test('a public URL that redirects to a private address is refused', async () => {
  const fetchImpl = async (u) => (String(u).includes('start') ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.png' } }) : new Response('x'));
  await assert.rejects(resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/start' } }] }] }, { fetchImpl }), /private or local/);
});

test('production transport: a hostname that resolves to loopback is refused through the real DNS path', async () => {
  // exercises the prod chain (dns.lookup -> pickAddress, no injected fetchImpl); an unpinned
  // connection would actually reach the server below
  const srv = http.createServer(() => { throw new Error('must never be reached'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await chat('withimg/m1', [{ type: 'image_url', image_url: { url: `http://localhost:${srv.address().port}/a.png` } }]);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'image_url_blocked');
  } finally {
    srv.close();
  }
});

test('a redirect whose Location cannot be parsed is a 400, not a 502', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://[1:2:3:4:5:6:7:8:9]/x.png' } });
  await assert.rejects(
    resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/start' } }] }] }, { fetchImpl }),
    (e) => e.status === 400 && /malformed redirect location/.test(e.message)
  );
});

test('a public URL is fetched (type and size checked)', async () => {
  const ok = async () => new Response(Buffer.from('abc'), { status: 200, headers: { 'content-type': 'image/png' } });
  const out = await resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/a.png' } }] }] }, { fetchImpl: ok });
  assert.deepEqual(out, [{ mediaType: 'image/png', data: Buffer.from('abc').toString('base64') }]);
  const html = async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
  await assert.rejects(resolveImages({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://8.8.8.8/a' } }] }] }, { fetchImpl: html }), /not a supported image/);
});

test('limits: too many images, unsupported type', async () => {
  let r = await chat('withimg/m1', Array.from({ length: 9 }, () => dataImg));
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'too_many_images');
  r = await chat('withimg/m1', [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } }]);
  assert.equal(r.status, 400);
});

test('a malformed percent-encoded data: URL is a 400, not a 502', async () => {
  for (const url of ['data:image/png,%E0%A4%A', 'data:image/png,%zz']) {
    const r = await chat('withimg/m1', [{ type: 'image_url', image_url: { url } }]);
    assert.equal(r.status, 400, url);
    const j = await r.json();
    assert.equal(j.error.type, 'invalid_request_error');
    assert.match(j.error.message, /malformed data: URL/);
  }
});
