// Blossom: put each blob on each server (BUD-02 PUT /upload with a BUD-11 token), then prove the
// server serves exactly those bytes. A server counts only if it holds every blob of the site.
import { isIP } from 'node:net';

import { sha256hex } from './config.mjs';
import { clean, errText } from './util.mjs';

export const UPLOAD_TIMEOUT_MS = 60_000;
export const FETCH_TIMEOUT_MS = 30_000;
const DESCRIPTOR_MAX = 64 * 1024;
const MAX_REDIRECTS = 3;

/**
 * `Authorization: Nostr <token>`. BUD-11 says base64url without padding; servers written before
 * that decode standard base64, so a 401 is retried once in that form (same signed event).
 */
export function authHeader(event, style = 'url') {
  const json = JSON.stringify(event);
  return `Nostr ${Buffer.from(json).toString(style === 'url' ? 'base64url' : 'base64')}`;
}

const reasonOf = (res) => {
  const r = res.headers.get('x-reason');
  return r ? `: ${clean(r)}` : '';
};

/** The body, refusing more than `max` bytes (a server could send anything). */
export async function readLimited(res, max) {
  const len = Number(res.headers.get('content-length') ?? NaN);
  if (len > max) {
    await res.body?.cancel();
    throw new Error(`answer too large (${String(len)} bytes)`);
  }
  if (res.body === null) return Buffer.alloc(0);
  const parts = [];
  let n = 0;
  for await (const chunk of res.body) {
    n += chunk.length;
    if (n > max) throw new Error('answer too large');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

const HASH_IN_URL = /([0-9a-f]{64})(?:\.[A-Za-z0-9]{1,10})?$/;

/**
 * Where a server may send this tool with a redirect: https only, a DNS name (no IP literal), and
 * not a local or internal name. A server cannot point the laptop at its LAN, its tailnet or
 * localhost (names resolving to private addresses are not caught here: that would need a resolver
 * check per hop, and the hop must still serve exactly the blob).
 */
export function redirectTargetOk(url) {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const h = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(h) !== 0) return false;
  if (!h.includes('.') || /(^|\.)(localhost|local|internal|lan|home|arpa|ts\.net)$/.test(h)) return false;
  return true;
}

/**
 * GET <server>/<sha256> must give exactly the blob. Redirects (BUD-01 307/308) are followed by
 * hand, at most MAX_REDIRECTS, each to a redirectTargetOk URL that ends in the same hash.
 */
export async function checkServed(server, file, fetchImpl = fetch) {
  let url = new URL(`${server.url}/${file.sha256}`);
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status < 300 || res.status >= 400) break;
    await res.body?.cancel();
    if (hop === MAX_REDIRECTS) return { ok: false, why: 'GET: too many redirects' };
    let next;
    try {
      next = new URL(res.headers.get('location') ?? '', url);
    } catch {
      return { ok: false, why: 'GET: a redirect without a usable Location' };
    }
    if (!redirectTargetOk(next)) return { ok: false, why: 'GET redirected to a non-https, local or IP address' };
    if (HASH_IN_URL.exec(next.pathname)?.[1] !== file.sha256)
      return { ok: false, why: 'GET redirected to a URL without the blob hash' };
    url = next;
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    return { ok: false, why: `GET answered ${String(res.status)}${reasonOf(res)}` };
  }
  const body = await readLimited(res, file.bytes + 1);
  if (body.length !== file.bytes || sha256hex(body) !== file.sha256)
    return { ok: false, why: 'GET serves other bytes than the blob' };
  return { ok: true, type: clean(res.headers.get('content-type') ?? '', 80) };
}

function put(server, file, auth, style, fetchImpl) {
  return fetchImpl(`${server.url}/upload`, {
    method: 'PUT',
    redirect: 'error', // never re-send the token and the body to wherever a redirect points
    headers: {
      Authorization: authHeader(auth, style),
      'Content-Type': file.type,
      'X-SHA-256': file.sha256,
    },
    body: file.data,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  });
}

/**
 * One blob on one server. Always PUT, even if the server already has the blob: Blossom keeps an
 * owner list per blob, and a blob only someone else owns goes when they delete it (or when anyone
 * who pre-uploaded it under their own key does). 201 = stored now, 200 = it was there and the
 * publisher key is now an owner too. Then the descriptor is checked and the blob fetched back.
 * Returns { ok, action: 'uploaded'|'present'|'failed', why?, type? }.
 */
export async function uploadBlob(server, file, auth, fetchImpl = fetch) {
  let res = await put(server, file, auth, 'url', fetchImpl);
  if (res.status === 401) {
    await res.body?.cancel();
    res = await put(server, file, auth, 'std', fetchImpl);
  }
  if (res.status !== 200 && res.status !== 201) {
    await res.body?.cancel();
    return { ok: false, action: 'failed', why: `PUT /upload answered ${String(res.status)}${reasonOf(res)}` };
  }
  const action = res.status === 201 ? 'uploaded' : 'present';
  let d;
  try {
    d = JSON.parse((await readLimited(res, DESCRIPTOR_MAX)).toString('utf8'));
  } catch {
    return { ok: false, action: 'failed', why: 'PUT /upload answered no blob descriptor' };
  }
  if (d === null || typeof d !== 'object' || d.sha256 !== file.sha256)
    return { ok: false, action: 'failed', why: 'the blob descriptor names another sha256' };
  if (d.size !== undefined && Number(d.size) !== file.bytes)
    return { ok: false, action: 'failed', why: 'the blob descriptor names another size' };
  const served = await checkServed(server, file, fetchImpl);
  return served.ok ? { ok: true, action, type: served.type } : { ok: false, action: 'failed', why: served.why };
}

/**
 * Every blob on every server: servers in parallel, a server's blobs one after another.
 * `auths`: Map sha256 -> the signed kind 24242 for that blob.
 * Returns [{ server, ok, blobs: [{ path, ok, action, why?, type? }] }] in `servers` order.
 */
export async function uploadAll(servers, files, auths, { fetchImpl = fetch, log = () => undefined } = {}) {
  return Promise.all(
    servers.map(async (server) => {
      const blobs = [];
      for (const file of files) {
        let r;
        try {
          r = await uploadBlob(server, file, auths.get(file.sha256), fetchImpl);
        } catch (e) {
          r = { ok: false, action: 'failed', why: errText(e) };
        }
        blobs.push({ path: file.path, ...r });
        log(`  ${r.ok ? 'ok    ' : 'FAILED'} ${server.host}${file.path}: ${r.action}${r.why ? ` (${r.why})` : ''}`);
      }
      return { server, ok: blobs.every((b) => b.ok), blobs };
    }),
  );
}
