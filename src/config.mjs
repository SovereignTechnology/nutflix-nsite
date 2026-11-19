// The repo's inputs, read strictly: PIN (which site), publisher.npub (whose site), servers.txt
// (Blossom), relays.txt (Nostr) and gateways.txt (nsite hosts). Every reader refuses anything it
// does not understand rather than guessing: a typo here would publish to the wrong place.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decode as nip19decode } from 'nostr-tools/nip19';

export class ConfigError extends Error {}
const refuse = (msg) => {
  throw new ConfigError(msg);
};

export const HEX40 = /^[0-9a-f]{40}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
/** A site path as PIN names it: relative, '/'-separated, plain characters, no '.'/'..' parts. */
const SITE_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** Lines of a list file with comments (`#` to end of line) and blank lines removed. */
function lines(text) {
  return text
    .split('\n')
    .map((l, i) => ({ n: i + 1, text: l.replace(/#.*$/, '').trim() }))
    .filter((l) => l.text !== '');
}

export const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * pear's SITE_TREE_SHA256 (packages/app-web/scripts/site.ts hashTree): the sha256 of
 * `<sha256>  <path>\n` per file (two spaces, sha256sum's format), in the given order.
 */
export function treeHash(files) {
  return sha256hex(files.map((f) => `${f.sha256}  ${f.path}\n`).join(''));
}

/**
 * PIN: the same `<key> <value...>` lines as sovtech/alpha's kata/nfxweb/site/pear/PEAR.pin (one
 * build feeds both). Checked for shape and for self-consistency: the file lines must be in
 * bytewise order and hash to the `tree` line.
 */
export function parsePin(text) {
  const one = new Map();
  const files = [];
  for (const { n, text: l } of lines(text)) {
    const f = l.split(/\s+/);
    const key = f[0];
    if (key === 'file') {
      if (f.length !== 4) refuse(`PIN line ${n}: 'file <sha256> <bytes> <path>'`);
      const [, sha256, bytes, path] = f;
      if (!HEX64.test(sha256)) refuse(`PIN line ${n}: the sha256 is not 64 lowercase hex`);
      if (!/^[1-9][0-9]{0,9}$/.test(bytes)) refuse(`PIN line ${n}: the size is not a positive integer`);
      if (!SITE_PATH.test(path) || path.length > 99) refuse(`PIN line ${n}: not a plain site path`);
      files.push({ sha256, bytes: Number(bytes), path });
      continue;
    }
    if (!['pear', 'nfx', 'tree', 'tar', 'headers', 'ci'].includes(key))
      refuse(`PIN line ${n}: unknown key '${key}'`);
    if (one.has(key)) refuse(`PIN line ${n}: '${key}' appears twice`);
    one.set(key, f.slice(1));
  }
  const get = (k, re, count = 1) => {
    const v = one.get(k);
    if (v === undefined || v.length !== count) refuse(`PIN: needs exactly one '${k}' line`);
    if (!re.test(v[0])) refuse(`PIN: the '${k}' value has the wrong shape`);
    return v;
  };
  const pin = {
    pear: get('pear', HEX40)[0],
    nfx: get('nfx', HEX40)[0],
    tree: get('tree', HEX64)[0],
    tar: (() => {
      const [sha256, name] = get('tar', HEX64, 2);
      if (!/^nutflix-web-site-[0-9a-f]{12}\.ustar\.tar$/.test(name)) refuse("PIN: the 'tar' name has the wrong shape");
      return { sha256, name };
    })(),
    headers: get('headers', HEX64)[0],
    ci: get('ci', /^[0-9]{1,20}$/)[0],
    files,
  };
  if (files.length === 0) refuse('PIN: no file lines');
  for (let i = 1; i < files.length; i++)
    if (!(Buffer.compare(Buffer.from(files[i - 1].path), Buffer.from(files[i].path)) < 0))
      refuse(`PIN: file lines are not in bytewise order (or repeat) at ${files[i].path}`);
  if (!files.some((f) => f.path === 'index.html')) refuse('PIN: no index.html');
  if (pin.tar.name !== `nutflix-web-site-${pin.pear.slice(0, 12)}.ustar.tar`)
    refuse("PIN: the 'tar' name does not carry the pear commit");
  if (treeHash(files) !== pin.tree) refuse("PIN: the file lines do not hash to the 'tree' line");
  return pin;
}

/**
 * The SovTech operator key (npub1s0vtech…): its root site is reserved for SovTech's own nsite, and
 * publishing replaces a key's root site, Blossom list and relay list. Never the publisher.
 */
export const OPERATOR_HEX = '83d8bce2f7d6966f306e6f1a712497cf0a2c77d073923136a0e2bb54963b3434';

/** publisher.npub: the one npub whose root site this is. Returns its hex, or null if unset. */
export function parsePublisher(text) {
  const ls = lines(text);
  if (ls.length === 0) return null;
  if (ls.length !== 1) refuse('publisher.npub: exactly one npub line');
  const npub = ls[0].text;
  if (/^nsec1/.test(npub)) refuse('publisher.npub: that is a SECRET key (nsec); remove it now');
  let d;
  try {
    d = nip19decode(npub);
  } catch {
    refuse('publisher.npub: not a valid npub');
  }
  if (d.type !== 'npub' || !HEX64.test(d.data)) refuse('publisher.npub: not an npub');
  if (d.data === OPERATOR_HEX)
    refuse("publisher.npub: that is the SovTech operator key; its root site is reserved (README \"The key\")");
  return { npub, hex: d.data };
}

/**
 * A URL list: one URL per line, an optional flag after it. Origins only (Blossom endpoints and
 * relays live at the domain root), no credentials, no query, lowercase host, no trailing slash.
 */
function urlList(text, what, protocol, flags) {
  const out = [];
  const seen = new Set();
  for (const { n, text: l } of lines(text)) {
    const [raw, flag, ...extra] = l.split(/\s+/);
    if (extra.length > 0 || (flag !== undefined && !flags.includes(flag)))
      refuse(`${what} line ${n}: '<url>'${flags.length ? ` or '<url> ${flags.join('|')}'` : ''}`);
    let u;
    try {
      u = new URL(raw);
    } catch {
      refuse(`${what} line ${n}: not a URL`);
    }
    if (u.protocol !== protocol) refuse(`${what} line ${n}: must be ${protocol}//`);
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
      refuse(`${what} line ${n}: an origin only (no path, query, fragment or credentials)`);
    const url = `${u.protocol}//${u.host}`;
    if (seen.has(url)) refuse(`${what} line ${n}: ${url} is listed twice`);
    seen.add(url);
    out.push({ url, host: u.hostname, flag: flag ?? null });
  }
  if (out.length === 0) refuse(`${what}: no entries`);
  return out;
}

/** servers.txt: Blossom servers, most trusted first (BUD-03 order). */
export const parseServers = (text) => urlList(text, 'servers.txt', 'https:', []).map(({ url, host }) => ({ url, host }));

/** relays.txt: `wss://…` for the manifest and the lists, `wss://… lists` for the lists only (indexers). */
export const parseRelays = (text) =>
  urlList(text, 'relays.txt', 'wss:', ['lists']).map(({ url, flag }) => ({ url, listsOnly: flag === 'lists' }));

/** gateways.txt: one `https://{npub}.<host>/` template per line. */
export function parseGateways(text) {
  const out = [];
  for (const { n, text: l } of lines(text)) {
    if (/\s/.test(l)) refuse(`gateways.txt line ${n}: one URL template per line`);
    if (!/^https:\/\/\{npub\}\.[a-z0-9.-]+\/$/.test(l))
      refuse(`gateways.txt line ${n}: must look like https://{npub}.example.com/`);
    out.push(l);
  }
  if (out.length === 0) refuse('gateways.txt: no entries');
  return out;
}

/** Everything at once, from the repo root. */
export function loadConfig(root) {
  const read = (f) => readFileSync(join(root, f), 'utf8');
  return {
    pin: parsePin(read('PIN')),
    publisher: parsePublisher(read('publisher.npub')),
    servers: parseServers(read('servers.txt')),
    relays: parseRelays(read('relays.txt')),
    gateways: parseGateways(read('gateways.txt')),
  };
}
