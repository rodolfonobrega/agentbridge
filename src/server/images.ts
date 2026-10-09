// Images in requests
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './common.js';
import { ImageInput } from '../types/index.js';

export const IMAGE_AGENTS = new Set(['claude', 'codex', 'opencode']);
const MAX_IMAGES = 8,
  MAX_BYTES = 10 * 1024 * 1024,
  TYPES = /^image\/(png|jpe?g|gif|webp)$/i;

const bad = (m: string, code = 'invalid_image') => new HttpError(400, m, 'invalid_request_error', code);

function parseIpv4Bytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) return -1;
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : -1;
  });
  if (nums.some((n) => n === -1)) return null;
  return nums;
}

function isPrivateIpv4Bytes(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  return (
    a === 0 || // 'this' network
    a === 10 || // private 10.0.0.0/8
    a === 127 || // loopback 127.0.0.0/8
    a >= 224 || // multicast / reserved
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private 172.16.0.0/12
    (a === 192 && b === 168) || // private 192.168.0.0/16
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF / TEST-NET-1
    (a === 198 && (b === 18 || b === 19 || b === 51)) || // benchmark / TEST-NET-2
    (a === 203 && b === 0 && c === 113) // TEST-NET-3
  );
}

function parseIpv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4Bytes(s.slice(lastColon + 1));
    if (!v4) return null;
    const hex = ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hex;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').map((h) => (h ? parseInt(h, 16) : -1)) : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':').map((h) => (h ? parseInt(h, 16) : -1)) : [];
  if (left.some((n) => isNaN(n) || n < 0 || n > 0xffff) || right.some((n) => isNaN(n) || n < 0 || n > 0xffff)) {
    return null;
  }
  const missing = 8 - (left.length + right.length);
  if (parts.length === 2 && missing < 0) return null;
  const words = parts.length === 2 ? [...left, ...Array(missing).fill(0), ...right] : left;
  if (words.length !== 8) return null;
  const bytes: number[] = [];
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
  return bytes;
}

/** True for loopback, private, link-local, CGNAT, multicast, unspecified and IPv4-mapped equivalents. */
export function isPrivateIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = parseIpv4Bytes(clean);
  if (v4) return isPrivateIpv4Bytes(v4);

  const v6 = parseIpv6Bytes(clean);
  if (v6) {
    // Unspecified ::
    if (v6.every((b) => b === 0)) return true;
    // Loopback ::1
    if (v6.slice(0, 15).every((b) => b === 0) && v6[15] === 1) return true;
    // Unique local fc00::/7
    if ((v6[0] & 0xfe) === 0xfc) return true;
    // Link local fe80::/10
    if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) return true;
    // Multicast ff00::/8
    if (v6[0] === 0xff) return true;
    // IPv4-mapped ::ffff:0:0/96
    if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) {
      return isPrivateIpv4Bytes(v6.slice(12));
    }
    // IPv4-compatible ::/96 (deprecated)
    if (v6.slice(0, 12).every((b) => b === 0) && (v6[12] !== 0 || v6[13] !== 0 || v6[14] !== 0 || v6[15] > 1)) {
      return isPrivateIpv4Bytes(v6.slice(12));
    }
    // NAT64 64:ff9b::/96
    if (v6[0] === 0 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && v6.slice(4, 12).every((b) => b === 0)) {
      return isPrivateIpv4Bytes(v6.slice(12));
    }
    // 6to4 2002::/16
    if (v6[0] === 0x20 && v6[1] === 0x02) {
      return isPrivateIpv4Bytes(v6.slice(2, 6));
    }
    return false;
  }

  return true; // Malformed IP defaults to blocked
}

async function assertPublic(url: URL): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => {
        throw bad(`image host "${host}" could not be resolved`);
      });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw bad(`image URL points to a private or local address (${host})`, 'image_url_blocked');
  }
  return addrs[0].address;
}

function parseDataUrl(u: string): ImageInput {
  const m = u.match(/^data:([^;,]+)((?:;[^;,]+)*?)(;base64)?,(.*)$/s);
  if (!m) throw bad('malformed data: URL');
  const mediaType = m[1].toLowerCase();
  if (!TYPES.test(mediaType)) throw bad(`unsupported image type "${mediaType}"`);
  const data = m[3] ? m[4] : Buffer.from(decodeURIComponent(m[4]), 'binary').toString('base64');
  if (Buffer.byteLength(data, 'base64') > MAX_BYTES) throw bad('image is larger than 10 MB', 'image_too_large');
  return { mediaType, data };
}

async function fetchImage(raw: string, fetchImpl: typeof fetch = fetch): Promise<ImageInput> {
  let url!: URL;
  for (let hop = 0; hop < 4; hop++) {
    try {
      url = new URL(hop ? url.href : raw);
    } catch {
      throw bad('malformed image URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('image URLs must be http(s) or data:');
    await assertPublic(url);
    const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => {
      throw bad('image URL could not be fetched', 'image_fetch_failed');
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw bad(`image URL answered ${res.status}`, 'image_fetch_failed');
    const mediaType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPES.test(mediaType)) throw bad(`image URL is not a supported image (${mediaType || 'no content-type'})`);
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of res.body as any) {
      n += c.length;
      if (n > MAX_BYTES) throw bad('image is larger than 10 MB', 'image_too_large');
      chunks.push(c);
    }
    return { mediaType, data: Buffer.concat(chunks).toString('base64') };
  }
  throw bad('too many redirects fetching the image', 'image_fetch_failed');
}

export interface ImageRef {
  url?: string;
  mediaType?: string;
  data?: string;
}

/** Image references in request order: [{url} | {mediaType, data}] */
export function findImages(body: any): ImageRef[] {
  const out: ImageRef[] = [];
  const visit = (c: any) => {
    if (!Array.isArray(c)) return;
    for (const p of c) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'image_url') out.push({ url: typeof p.image_url === 'string' ? p.image_url : p.image_url?.url });
      else if (p.type === 'input_image') out.push({ url: typeof p.image_url === 'string' ? p.image_url : p.image_url?.url });
      else if (p.type === 'image' && p.source) {
        out.push(
          p.source.type === 'base64'
            ? { mediaType: p.source.media_type, data: p.source.data }
            : { url: p.source.url }
        );
      } else if (Array.isArray(p.content)) {
        visit(p.content);
      }
    }
  };
  for (const m of body.messages || []) visit(m?.content);
  if (Array.isArray(body.input)) {
    for (const it of body.input) visit(it?.content);
  }
  return out;
}

export async function resolveImages(body: any, { fetchImpl }: { fetchImpl?: typeof fetch } = {}): Promise<ImageInput[]> {
  const found = findImages(body);
  if (found.length > MAX_IMAGES) throw bad(`at most ${MAX_IMAGES} images per request`, 'too_many_images');
  const out: ImageInput[] = [];
  for (const f of found) {
    if (f.data) {
      if (!TYPES.test(f.mediaType || '')) throw bad(`unsupported image type "${f.mediaType}"`);
      if (Buffer.byteLength(f.data, 'base64') > MAX_BYTES) throw bad('image is larger than 10 MB', 'image_too_large');
      out.push({ mediaType: f.mediaType!.toLowerCase(), data: f.data });
    } else if (typeof f.url === 'string') {
      out.push(f.url.startsWith('data:') ? parseDataUrl(f.url) : await fetchImage(f.url, fetchImpl));
    } else {
      throw bad('image part has no url or data');
    }
  }
  return out;
}

/**
 * Attach request images to a prepared run `p`.
 */
export async function attachImages(p: any, body: any, opts: { fetchImpl?: typeof fetch } = {}): Promise<any> {
  const found = findImages(body);
  if (!found.length) return p;
  const agent = typeof p.target.agent === 'string' ? p.target.agent : p.target.agent?.name;
  if (!IMAGE_AGENTS.has(agent) && p.target.agent?.images !== true) {
    p.warning = 'images_not_supported: this agent receives a text placeholder instead of the image';
    return p;
  }
  p.images = await resolveImages(body, opts);
  return p;
}
