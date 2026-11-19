// The site's bytes: the ustar tar sovtech/alpha's build-pear.sh brings back from its Kata build
// (site/ustar-files.py's exact format), checked against PIN before anything else looks at it.
// Nothing is extracted to disk: the 7 files are held in memory and uploaded from there.
import { readFileSync } from 'node:fs';

import { ConfigError, sha256hex, treeHash } from './config.mjs';

const refuse = (msg) => {
  throw new ConfigError(msg);
};

/** Content-Type sent with each upload (Blossom stores it; gateways forward it, NIP-5A). */
export const MIME = Object.freeze({
  html: 'text/html',
  js: 'text/javascript',
  css: 'text/css',
  wasm: 'application/wasm',
  json: 'application/json',
});
export function mimeOf(path) {
  const ext = /\.([a-z0-9]+)$/.exec(path)?.[1];
  const t = ext === undefined ? undefined : MIME[ext];
  if (t === undefined) refuse(`no content type known for ${path} (add its extension to MIME)`);
  return t;
}

const octal = (field) => {
  const s = field.toString('latin1').replace(/[\0 ]+$/, '');
  if (!/^[0-7]{1,11}$/.test(s)) refuse('site tar: a numeric header field is not octal');
  return parseInt(s, 8);
};

/**
 * Read ustar-files.py's tar: regular files only, names in the 100-byte field (no prefix, no pax),
 * then two zero blocks and zero padding. Anything else is refused.
 */
export function readUstar(buf) {
  const out = [];
  let off = 0;
  for (;;) {
    if (off + 512 > buf.length) refuse('site tar: truncated');
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    if (h.toString('latin1', 257, 263) !== 'ustar\0') refuse('site tar: not ustar');
    const sum = octal(h.subarray(148, 156));
    let s = 0;
    for (let i = 0; i < 512; i++) s += i >= 148 && i < 156 ? 32 : h[i];
    if (s !== sum) refuse('site tar: a header checksum is wrong');
    if (h[156] !== 0x30) refuse('site tar: an entry is not a regular file');
    if (!h.subarray(345, 500).every((b) => b === 0)) refuse('site tar: a name uses the prefix field');
    const nameEnd = h.indexOf(0);
    const name = h.toString('latin1', 0, nameEnd === -1 || nameEnd > 100 ? 100 : nameEnd);
    const size = octal(h.subarray(124, 136));
    off += 512;
    if (off + size > buf.length) refuse('site tar: truncated');
    out.push({ path: name, data: Buffer.from(buf.subarray(off, off + size)) });
    off += size + (-size & 511);
  }
  if (!buf.subarray(off).every((b) => b === 0)) refuse('site tar: bytes after the end blocks');
  return out;
}

/**
 * The site, checked against PIN: the tar's own sha256 first, then every entry (same paths, same
 * order, same size and sha256), then pear's tree hash. Returns the files with `/`-rooted paths.
 */
export function loadSite(tarBuf, pin) {
  if (sha256hex(tarBuf) !== pin.tar.sha256)
    refuse(`the site tar is not PIN's (${pin.tar.name}, sha256 ${pin.tar.sha256})`);
  const entries = readUstar(tarBuf);
  if (entries.length !== pin.files.length) refuse('the site tar holds another number of files than PIN');
  const files = entries.map((e, i) => {
    const want = pin.files[i];
    if (e.path !== want.path) refuse(`site tar entry ${i + 1} is ${JSON.stringify(e.path)}, PIN says ${want.path}`);
    if (e.data.length !== want.bytes) refuse(`${want.path}: ${e.data.length} bytes, PIN says ${want.bytes}`);
    const sha256 = sha256hex(e.data);
    if (sha256 !== want.sha256) refuse(`${want.path}: sha256 differs from PIN`);
    return { path: `/${want.path}`, sha256, bytes: want.bytes, type: mimeOf(want.path), data: e.data };
  });
  if (treeHash(pin.files) !== pin.tree) refuse("PIN's file lines do not hash to its tree line");
  return files;
}

export const loadSiteFile = (file, pin) => loadSite(readFileSync(file), pin);
