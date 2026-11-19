import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError } from '../src/config.mjs';
import { cspProblems } from '../src/csp.mjs';
import {
  AUTH_TTL_S,
  aggregateHash,
  checkSigned,
  relayListTemplate,
  serverListTemplate,
  siteTemplate,
  uploadAuthTemplate,
} from '../src/events.mjs';
import { key, PEAR, sha } from './helpers.mjs';

// The symbol pure.js really caches its verdict under (nostr-tools/core exports a different one).
const verifiedSymbol = Object.getOwnPropertySymbols(key().sign({ kind: 1, created_at: 1, tags: [], content: '' }))[0];

const files = [
  { path: '/index.html', sha256: 'b'.repeat(64), bytes: 1 },
  { path: '/app.js', sha256: 'a'.repeat(64), bytes: 1 },
];
const servers = [
  { url: 'https://blossom.band', host: 'blossom.band' },
  { url: 'https://nostr.download', host: 'nostr.download' },
];

test('aggregate hash: NIP-5A recipe (one space, lines sorted)', () => {
  const lines = [`${'a'.repeat(64)} /app.js\n`, `${'b'.repeat(64)} /index.html\n`].join('');
  assert.equal(aggregateHash(files), sha(Buffer.from(lines)));
});

test('templates carry exactly the tags the specs ask for', () => {
  const now = 1_763_540_000;
  const auth = uploadAuthTemplate(files[0], servers, now);
  assert.equal(auth.kind, 24242);
  assert.deepEqual(auth.tags, [
    ['t', 'upload'],
    ['x', 'b'.repeat(64)],
    ['expiration', String(now + AUTH_TTL_S)],
    ['server', 'blossom.band'], // BUD-11: a bare domain, not a URL
    ['server', 'nostr.download'],
  ]);
  const site = siteTemplate(files, servers, { pear: PEAR }, now);
  assert.equal(site.kind, 15128);
  assert.ok(!site.tags.some((t) => t[0] === 'd'), 'a root site has no d tag');
  assert.deepEqual(site.tags.slice(0, 2), [
    ['path', '/index.html', 'b'.repeat(64)],
    ['path', '/app.js', 'a'.repeat(64)],
  ]);
  assert.deepEqual(site.tags[2], ['x', aggregateHash(files), 'aggregate']);
  assert.deepEqual(site.tags.filter((t) => t[0] === 'server'), [
    ['server', 'https://blossom.band'],
    ['server', 'https://nostr.download'],
  ]);
  assert.deepEqual(site.tags.find((t) => t[0] === 'source'), [
    'source',
    `https://github.com/SovereignTechnology/nutflix-pear/tree/${PEAR}`,
  ]);
  assert.deepEqual(serverListTemplate(servers, now).tags, [
    ['server', 'https://blossom.band'],
    ['server', 'https://nostr.download'],
  ]);
  assert.deepEqual(relayListTemplate(['wss://a.example'], now).tags, [['r', 'wss://a.example']]);
});

test('checkSigned: takes exactly the template signed by the key, as a plain event', () => {
  const k = key();
  const t = siteTemplate(files, servers, { pear: PEAR }, 1_763_540_000);
  const ev = checkSigned(t, k.sign(t), k.hex);
  assert.deepEqual(Object.keys(ev).sort(), ['content', 'created_at', 'id', 'kind', 'pubkey', 'sig', 'tags']);
  assert.equal(ev[verifiedSymbol], undefined);
});

test('checkSigned: refuses another key, a changed event, and a forged verdict', () => {
  const k = key();
  const other = key();
  const t = serverListTemplate(servers, 1_763_540_000);
  const refused = (fn, re) => assert.throws(fn, (e) => e instanceof ConfigError && re.test(e.message));
  refused(() => checkSigned(t, other.sign(t), k.hex), /another key/);
  refused(() => checkSigned(t, k.sign({ ...t, tags: [...t.tags, ['server', 'https://evil.example']] }), k.hex), /tags/);
  refused(() => checkSigned(t, k.sign({ ...t, created_at: t.created_at + 1 }), k.hex), /changed/);
  // A returned object that claims to be verified (nostr-tools' cached verdict) with a bad signature.
  const forged = { ...k.sign(t) };
  forged.sig = forged.sig.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  forged[verifiedSymbol] = true;
  assert.equal(typeof verifiedSymbol, 'symbol');
  refused(() => checkSigned(t, forged, k.hex), /invalid/);
  refused(() => checkSigned(t, null, k.hex), /not an event/);
});

const PEAR_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' https: wss: blob:; worker-src 'self'; manifest-src 'self'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests; frame-ancestors 'none'";

test('CSP: none, and pear\'s own, let the page run', () => {
  assert.deepEqual(cspProblems(null, 'x.nsite.lol'), []);
  assert.deepEqual(cspProblems(PEAR_CSP, 'x.nsite.lol'), []);
});

test('CSP: what breaks the page is named', () => {
  assert.deepEqual(cspProblems("script-src 'self'", 'h'), ["CSP script-src blocks 'wasm-unsafe-eval'"]);
  assert.ok(cspProblems("default-src 'self'", 'h').includes('CSP default-src (for connect-src) blocks blob:'));
  assert.ok(cspProblems("default-src 'self'", 'h').includes('CSP default-src (for connect-src) blocks wss:'));
  assert.ok(cspProblems("connect-src * ; media-src *", 'h').includes('CSP connect-src blocks blob:'));
  assert.ok(cspProblems("connect-src * ; media-src *", 'h').includes('CSP media-src blocks blob:'));
  assert.deepEqual(cspProblems('sandbox allow-scripts', 'h'), ['CSP sandbox without allow-scripts and allow-same-origin']);
  assert.ok(cspProblems(`${PEAR_CSP}; require-trusted-types-for 'script'`, 'h').includes('CSP requires Trusted Types'));
});

test('CSP: every policy must allow the page (two policies, the second strict)', () => {
  assert.deepEqual(cspProblems(`${PEAR_CSP}, script-src 'self'`, 'h'), ["CSP script-src blocks 'wasm-unsafe-eval'"]);
});

test('CSP: script-src-elem, strict-dynamic and a no-break space are read as browsers read them', () => {
  const allowWasm = "script-src 'self' 'wasm-unsafe-eval'";
  assert.ok(cspProblems(`${allowWasm}; script-src-elem 'none'`, 'h').includes("CSP script-src-elem blocks 'self'"));
  assert.ok(cspProblems(`${allowWasm}; style-src-elem 'none'`, 'h').includes("CSP style-src-elem blocks 'self'"));
  assert.ok(
    cspProblems("script-src 'self' 'wasm-unsafe-eval' 'strict-dynamic'", 'h').includes(
      "CSP script-src (for script-src-elem) has 'strict-dynamic': the site's scripts carry no nonce",
    ),
  );
  assert.ok(cspProblems("script-src 'self'\u00a0'wasm-unsafe-eval'", 'h').length > 0);
});

test('CSP: host sources with ports and wildcards, and scheme rules', () => {
  const rest = "img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' https: wss: blob:; style-src 'self'";
  assert.deepEqual(cspProblems(`script-src https://x.nsite.lol:443 'wasm-unsafe-eval'; ${rest}`, 'x.nsite.lol'), []);
  assert.deepEqual(cspProblems(`script-src https://* 'wasm-unsafe-eval'; ${rest}`, 'x.nsite.lol'), []);
  assert.ok(cspProblems(`script-src https://x.nsite.lol:8443 'wasm-unsafe-eval'; ${rest}`, 'x.nsite.lol').length > 0);
  assert.ok(cspProblems(`script-src https://other.example 'wasm-unsafe-eval'; ${rest}`, 'x.nsite.lol').length > 0);
  // `https:` does not cover wss:, `*` does not cover blob:
  assert.ok(cspProblems("connect-src 'self' https: blob:", 'h').includes('CSP connect-src blocks wss:'));
  assert.ok(cspProblems("connect-src 'self' wss://* https://* blob:", 'h').length === 0);
});

test("CSP: 'unsafe-eval', ws: and a host source count as allowing", () => {
  const p =
    "script-src https://*.nsite.lol 'unsafe-eval'; style-src x.nsite.lol; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self' https: ws: blob:; worker-src 'self'";
  assert.deepEqual(cspProblems(p, 'x.nsite.lol'), []);
});
