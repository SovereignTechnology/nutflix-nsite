// Test fixtures: a small site, its PIN text, its ustar tar (byte-for-byte sovtech/alpha
// site/ustar-files.py), throwaway keys, and an in-process HTTP server.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';

export const sha = (b) => createHash('sha256').update(b).digest('hex');

export const PEAR = '008b2f33f7059c4afc4871cae61d11140605f208';

/** The fixture site: PIN-relative paths, bytewise order. */
export const SITE = [
  ['app.js', Buffer.from('export const app = 1;\n')],
  ['index.html', Buffer.from('<!doctype html><meta charset="utf-8"><title>t</title><script type="module" src="app.js"></script>\n')],
  ['nfx/wasm/nfx_wasm_bg.wasm', Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])],
  ['shell.css', Buffer.from('body{margin:0}\n')],
];

const num = (n, w) => Buffer.from(`${n.toString(8).padStart(w - 1, '0')}\0`, 'latin1');

/** ustar-files.py's bytes for `entries` ([path, Buffer]). */
export function ustar(entries) {
  const parts = [];
  for (const [name, data] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'latin1');
    num(0o644, 8).copy(h, 100);
    num(0, 8).copy(h, 108);
    num(0, 8).copy(h, 116);
    num(data.length, 12).copy(h, 124);
    num(0, 12).copy(h, 136);
    h.fill(0x20, 148, 156);
    h.write('0', 156, 'latin1');
    h.write('ustar\0', 257, 'latin1');
    h.write('00', 263, 'latin1');
    num(0, 8).copy(h, 329);
    num(0, 8).copy(h, 337);
    let s = 0;
    for (const b of h) s += b;
    Buffer.from(`${s.toString(8).padStart(6, '0')}\0 `, 'latin1').copy(h, 148);
    parts.push(h, data, Buffer.alloc(-data.length & 511));
  }
  parts.push(Buffer.alloc(1024));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.alloc((10240 - (body.length % 10240)) % 10240)]);
}

/** PIN text for `entries`, with its tar's sha256. */
export function pinText(entries = SITE) {
  const tar = ustar(entries);
  const files = entries.map(([p, d]) => `file ${sha(d)} ${String(d.length)} ${p}`);
  const tree = sha(entries.map(([p, d]) => `${sha(d)}  ${p}\n`).join(''));
  return {
    tar,
    text: [
      '# fixture',
      `pear ${PEAR}`,
      `nfx ${'1'.repeat(40)}`,
      `tree ${tree}`,
      ...files,
      `tar ${sha(tar)} nutflix-web-site-${PEAR.slice(0, 12)}.ustar.tar`,
      `headers ${'2'.repeat(64)}`,
      'ci 44063623178',
      '',
    ].join('\n'),
  };
}

export function key() {
  const sk = generateSecretKey();
  const hex = getPublicKey(sk);
  // finalizeEvent fills in the object it is given: sign a copy, as a remote signer would.
  return { sk, hex, npub: npubEncode(hex), sign: (t) => finalizeEvent(structuredClone(t), sk) };
}

/** Start `handler` on 127.0.0.1; returns { url, host, close }. */
export async function serve(handler) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      Promise.resolve(handler(req, res, Buffer.concat(chunks))).catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${String(port)}`,
    host: '127.0.0.1',
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * A Blossom server (BUD-01/02/11 as far as publish.sh uses it). `mode`:
 *   'ok'          checks the token and stores the blob
 *   'std-only'    refuses base64url tokens with 401 (an older server), takes standard base64
 *   'std-only-400'  the same refusal as a 400 naming the token's encoding
 *   'type-400'    400 on every upload for its file type: not a token problem, never retried
 *   'lying'       answers a descriptor with another sha256
 *   'corrupting'  stores the blob, then serves other bytes
 *   'refusing'    403 on every upload, with an X-Reason carrying a terminal control sequence (8-bit CSI:
 *                 Node's server refuses a raw ESC in a header, but sends 0x80-0xff, and undici hands it over)
 */
export async function blossom(mode = 'ok') {
  const blobs = new Map();
  const seen = { puts: 0, tokens: [] };
  const s = await serve((req, res, body) => {
    const u = new URL(req.url, 'http://x');
    const hash = /^\/([0-9a-f]{64})$/.exec(u.pathname)?.[1];
    if ((req.method === 'GET' || req.method === 'HEAD') && hash) {
      const b = blobs.get(hash);
      if (!b) {
        res.statusCode = 404;
        return res.end();
      }
      const out = mode === 'corrupting' ? Buffer.concat([b.subarray(1), Buffer.from('!')]) : b;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(out.length));
      return res.end(req.method === 'HEAD' ? undefined : out);
    }
    if (req.method === 'PUT' && u.pathname === '/upload') {
      seen.puts++;
      if (mode === 'refusing') {
        res.statusCode = 403;
        res.setHeader('x-reason', 'no \u009b31mred\u009b0m uploads');
        return res.end();
      }
      if (mode === 'type-400') {
        res.statusCode = 400;
        res.setHeader('x-reason', 'unsupported content type');
        return res.end();
      }
      const token = /^Nostr (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (mode === 'std-only-400' && (/[-_]/.test(token) || token.length % 4 !== 0)) {
        res.statusCode = 400;
        res.setHeader('x-reason', 'invalid base64 token');
        return res.end();
      }
      if (mode === 'std-only' && (/[-_]/.test(token) || token.length % 4 !== 0)) {
        res.statusCode = 401;
        return res.end();
      }
      let ev;
      try {
        ev = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      } catch {
        res.statusCode = 401;
        return res.end();
      }
      seen.tokens.push(ev);
      const x = sha(body);
      const tag = (n) => ev.tags.filter((t) => t[0] === n).map((t) => t[1]);
      if (
        ev.kind !== 24242 ||
        !tag('t').includes('upload') ||
        !tag('x').includes(x) ||
        req.headers['x-sha-256'] !== x ||
        Number(tag('expiration')[0]) <= Math.floor(Date.now() / 1000)
      ) {
        res.statusCode = 401;
        return res.end();
      }
      const existed = blobs.has(x);
      blobs.set(x, body);
      res.statusCode = existed ? 200 : 201;
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify({
          url: `${s.url}/${x}.bin`,
          sha256: mode === 'lying' ? 'f'.repeat(64) : x,
          size: body.length,
          type: req.headers['content-type'],
          uploaded: 1,
        }),
      );
    }
    res.statusCode = 404;
    return res.end();
  });
  return { ...s, blobs, seen };
}
