// Images in requests: collected from OpenAI chat (image_url), Responses (input_image) and Anthropic (image) content parts,
// resolved to {mediaType, data(base64)}. Remote URLs are fetched with an SSRF guard (public http/https only, size and time capped).
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './common.mjs';

export const IMAGE_AGENTS = new Set(['claude', 'codex', 'opencode']); // adapters that take `images`
const MAX_IMAGES = 8, MAX_BYTES = 10 * 1024 * 1024, TYPES = /^image\/(png|jpe?g|gif|webp)$/i;

const bad = (m, code = 'invalid_image') => new HttpError(400, m, 'invalid_request_error', code);

/** True for loopback, private, link-local, CGNAT, multicast, unspecified and IPv4-mapped equivalents. */
export function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function assertPublic(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw bad(`image host "${host}" could not be resolved`); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw bad(`image URL points to a private or local address (${host})`, 'image_url_blocked');
}

function parseDataUrl(u) {
  const m = u.match(/^data:([^;,]+)((?:;[^;,]+)*?)(;base64)?,(.*)$/s);
  if (!m) throw bad('malformed data: URL');
  const mediaType = m[1].toLowerCase();
  if (!TYPES.test(mediaType)) throw bad(`unsupported image type "${mediaType}"`);
  const data = m[3] ? m[4] : Buffer.from(decodeURIComponent(m[4]), 'binary').toString('base64');
  if (Buffer.byteLength(data, 'base64') > MAX_BYTES) throw bad('image is larger than 10 MB', 'image_too_large');
  return { mediaType, data };
}

async function fetchImage(raw, fetchImpl = fetch) {
  let url;
  for (let hop = 0; hop < 4; hop++) {
    try { url = new URL(hop ? url : raw); } catch { throw bad('malformed image URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('image URLs must be http(s) or data:');
    await assertPublic(url);
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => { throw bad('image URL could not be fetched', 'image_fetch_failed'); });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
    if (!res.ok) throw bad(`image URL answered ${res.status}`, 'image_fetch_failed');
    const mediaType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPES.test(mediaType)) throw bad(`image URL is not a supported image (${mediaType || 'no content-type'})`);
    const chunks = []; let n = 0;
    for await (const c of res.body) { n += c.length; if (n > MAX_BYTES) throw bad('image is larger than 10 MB', 'image_too_large'); chunks.push(c); }
    return { mediaType, data: Buffer.concat(chunks).toString('base64') };
  }
  throw bad('too many redirects fetching the image', 'image_fetch_failed');
}

/** Image references in request order: [{url} | {mediaType, data}] */
export function findImages(body) {
  const out = [];
  const visit = (c) => {
    if (!Array.isArray(c)) return;
    for (const p of c) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'image_url') out.push({ url: typeof p.image_url === 'string' ? p.image_url : p.image_url?.url });
      else if (p.type === 'input_image') out.push({ url: typeof p.image_url === 'string' ? p.image_url : p.image_url?.url });
      else if (p.type === 'image' && p.source) out.push(p.source.type === 'base64' ? { mediaType: p.source.media_type, data: p.source.data } : { url: p.source.url });
      else if (Array.isArray(p.content)) visit(p.content); // tool_result blocks that carry images
    }
  };
  for (const m of body.messages || []) visit(m?.content);
  if (Array.isArray(body.input)) for (const it of body.input) visit(it?.content);
  return out;
}

export async function resolveImages(body, { fetchImpl } = {}) {
  const found = findImages(body);
  if (found.length > MAX_IMAGES) throw bad(`at most ${MAX_IMAGES} images per request`, 'too_many_images');
  const out = [];
  for (const f of found) {
    if (f.data) {
      if (!TYPES.test(f.mediaType || '')) throw bad(`unsupported image type "${f.mediaType}"`);
      if (Buffer.byteLength(f.data, 'base64') > MAX_BYTES) throw bad('image is larger than 10 MB', 'image_too_large');
      out.push({ mediaType: f.mediaType.toLowerCase(), data: f.data });
    } else if (typeof f.url === 'string') out.push(f.url.startsWith('data:') ? parseDataUrl(f.url) : await fetchImage(f.url, fetchImpl));
    else throw bad('image part has no url or data');
  }
  return out;
}

/**
 * Attach request images to a prepared run `p`. Agents without image support keep the text placeholder and the
 * response gets an `x-agentbridge-warning: images_not_supported` header.
 */
export async function attachImages(p, body, opts = {}) {
  const found = findImages(body);
  if (!found.length) return p;
  const agent = typeof p.target.agent === 'string' ? p.target.agent : p.target.agent?.name;
  if (!IMAGE_AGENTS.has(agent) && p.target.agent?.images !== true) { p.warning = 'images_not_supported: this agent receives a text placeholder instead of the image'; return p; }
  p.images = await resolveImages(body, opts);
  return p;
}
