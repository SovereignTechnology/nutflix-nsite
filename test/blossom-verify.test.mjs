import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { authHeader, checkServed, redirectTargetOk, uploadAll } from '../src/blossom.mjs';
import { parsePin } from '../src/config.mjs';
import { checkSigned, uploadAuthTemplate } from '../src/events.mjs';
import { loadSite } from '../src/site.mjs';
import { cell, checkGateway, checkRelays, manifestMatches, statusMarkdown } from '../src/verify.mjs';
import { blossom, key, pinText, serve } from './helpers.mjs';

const { tar, text } = pinText();
const pin = parsePin(text);
const files = loadSite(tar, pin);
const k = key();
const closers = [];
after(() => Promise.all(closers.map((c) => c())));

async function tokens(servers) {
  const now = Math.floor(Date.now() / 1000);
  return new Map(
    files.map((f) => {
      const t = uploadAuthTemplate(f, servers, now);
      return [f.sha256, checkSigned(t, k.sign(t), k.hex)];
    }),
  );
}

test('authHeader: base64url without padding by default, standard base64 on request', () => {
  const ev = { content: '??>>' };
  assert.equal(authHeader(ev), `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64url')}`);
  assert.equal(authHeader(ev, 'std'), `Nostr ${Buffer.from(JSON.stringify(ev)).toString('base64')}`);
});

test('uploadAll: every blob on every server, each fetched back; bad servers are named', async () => {
  const servers = await Promise.all(['ok', 'std-only', 'lying', 'corrupting', 'refusing'].map((m) => blossom(m)));
  closers.push(...servers.map((s) => s.close));
  const lines = [];
  const res = await uploadAll(servers, files, await tokens(servers), { log: (l) => lines.push(l) });
  assert.deepEqual(
    res.map((r) => r.ok),
    [true, true, false, false, false],
  );
  assert.deepEqual(new Set(res[0].blobs.map((b) => b.action)), new Set(['uploaded']));
  assert.match(res[2].blobs[0].why, /descriptor names another sha256/);
  assert.match(res[3].blobs[0].why, /other bytes/);
  assert.match(res[4].blobs[0].why, /403: no \?31mred\?0m uploads/);
  assert.ok(lines.every((l) => /^[\x20-\x7e]*$/.test(l)), 'no control character reaches the terminal');
  // The token went to the server untouched and names the blob.
  const tok = servers[0].seen.tokens[0];
  assert.equal(tok.kind, 24242);
  assert.ok(tok.tags.some((t) => t[0] === 'x' && t[1] === files[0].sha256));
  // A second run PUTs again (so the key owns every blob) and the server says it had them.
  const puts = servers[0].seen.puts;
  const again = await uploadAll([servers[0]], files, await tokens([servers[0]]));
  assert.ok(again[0].ok);
  assert.deepEqual(new Set(again[0].blobs.map((b) => b.action)), new Set(['present']));
  assert.equal(servers[0].seen.puts, puts + files.length);
});

test('redirects: only to a public https name, and only to the same hash', async () => {
  assert.ok(redirectTargetOk(new URL('https://cdn.example.org/x')));
  for (const u of ['http://cdn.example.org/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://10.0.0.1/x',
    'https://localhost/x', 'https://nas.local/x', 'https://box.ts.net/x', 'https://intranet/x'])
    assert.equal(redirectTargetOk(new URL(u)), false, u);
  const f = files[0];
  const server = { url: 'https://blossom.example', host: 'blossom.example' };
  const answer = (status, headers, body) => new Response(body ?? null, { status, headers });
  const via = (location) => async (url) =>
    url.startsWith('https://blossom.example/') ? answer(307, { location }) : answer(200, {}, f.data);
  assert.deepEqual(await checkServed(server, f, via(`https://cdn.example.org/${f.sha256}.js`)), { ok: true, type: '' });
  assert.match((await checkServed(server, f, via(`http://cdn.example.org/${f.sha256}`))).why, /non-https, local or IP/);
  assert.match((await checkServed(server, f, via(`https://192.168.8.1/${f.sha256}`))).why, /non-https, local or IP/);
  assert.match((await checkServed(server, f, via(`https://cdn.example.org/${'0'.repeat(64)}`))).why, /without the blob hash/);
  const loop = async (url) => answer(307, { location: `${url.replace(/\/[^/]*$/, '')}/${f.sha256}` });
  assert.match((await checkServed(server, f, loop)).why, /too many redirects/);
});

/** A gateway serving `files` at /<path> and index.html at /, with `opts` breaking it on purpose. */
async function gateway(opts = {}) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const g = await serve((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const f = path === '/' ? byPath.get('/index.html') : byPath.get(path);
    if (opts.empty || !f) {
      res.statusCode = 404;
      return res.end();
    }
    if (opts.redirect && path.endsWith('.wasm')) {
      res.statusCode = 302;
      res.setHeader('location', `https://blossom.example/${f.sha256}`);
      return res.end();
    }
    res.setHeader('content-type', opts.types?.[path] ?? (path === '/' ? 'text/html; charset=utf-8' : f.type));
    if (opts.csp) res.setHeader('content-security-policy', opts.csp);
    if (opts.attachment) res.setHeader('content-disposition', 'attachment; filename=x');
    return res.end(opts.corrupt && path === '/app.js' ? Buffer.from('nope') : f.data);
  });
  closers.push(g.close);
  return `http://${k.npub}.localhost:${g.url.split(':')[2]}/`;
}

/** fetch() for http://<npub>.localhost:<port>/: Node resolves *.localhost, but be explicit. */
const local = (url, init) => fetch(url.replace(/^http:\/\/[^/]*localhost:/, 'http://127.0.0.1:'), init);

test('checkGateway: a gateway that serves the bytes plainly works', async () => {
  const r = await checkGateway(await gateway(), files, { fetchImpl: local });
  assert.equal(r.verdict, 'works', r.problems.join('; '));
  assert.equal(r.wasmType, 'application/wasm');
  assert.equal(r.csp, null);
});

test('checkGateway: the wasm Content-Type alone is recorded, not a failure', async () => {
  const r = await checkGateway(
    await gateway({ types: { '/nfx/wasm/nfx_wasm_bg.wasm': 'application/octet-stream' } }),
    files,
    { fetchImpl: local },
  );
  assert.equal(r.verdict, 'works');
  assert.equal(r.wasmType, 'application/octet-stream');
});

test('checkGateway: a redirect, wrong bytes, a wrong page type, a strict CSP each fail it', async () => {
  const cases = [
    [{ redirect: true }, /\/nfx\/wasm\/nfx_wasm_bg\.wasm: redirect 302 to blossom\.example/],
    [{ corrupt: true }, /\/app\.js: other bytes/],
    [{ types: { '/app.js': 'text/plain' } }, /\/app\.js: Content-Type text\/plain, needs a JavaScript type/],
    [{ types: { '/shell.css': 'application/octet-stream' } }, /shell\.css: Content-Type/],
    [{ types: { '/': 'application/octet-stream' } }, /^\/: Content-Type/],
    [{ csp: "default-src 'self'" }, /blocks/],
    [{ attachment: true }, /^\/: Content-Disposition attachment/],
  ];
  for (const [opts, re] of cases) {
    const r = await checkGateway(await gateway(opts), files, { fetchImpl: local });
    assert.equal(r.verdict, 'fails', JSON.stringify(opts));
    assert.ok(r.problems.some((p) => re.test(p)), `${JSON.stringify(opts)}: ${r.problems.join('; ')}`);
  }
});

test('checkGateway: no site there is "not found"; nothing listening is "unreachable"', async () => {
  assert.equal((await checkGateway(await gateway({ empty: true }), files, { fetchImpl: local })).verdict, 'not found');
  const dead = await serve(() => undefined);
  await dead.close();
  const r = await checkGateway(`http://${k.npub}.localhost:${dead.url.split(':')[2]}/`, files, { fetchImpl: local });
  assert.equal(r.verdict, 'unreachable');
});

test('checkRelays: the newest valid manifest by the key, matched against PIN', async () => {
  const pf = files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }));
  const mk = (created, fs) =>
    k.sign({ kind: 15128, created_at: created, content: '', tags: fs.map((f) => ['path', f.path, f.sha256]) });
  const good = mk(200, pf);
  const old = mk(100, pf.slice(1));
  const forged = { ...mk(300, pf.slice(1)), sig: '0'.repeat(128) };
  const stranger = key().sign({ kind: 15128, created_at: 400, content: '', tags: [] });
  const list = k.sign({ kind: 10002, created_at: 1, content: '', tags: [['r', 'wss://relay.nsite.lol']] });
  const query = async (_r, f) => (f.kinds[0] === 15128 ? [old, good, forged, stranger] : [list]);
  const r = await checkRelays(['wss://x'], k.hex, pf, query);
  assert.equal(r.manifest.id, good.id);
  assert.equal(r.manifest.matchesPin, true);
  assert.deepEqual(r.relayList, ['wss://relay.nsite.lol']);
  assert.equal(manifestMatches(old, pf), false);
  const md = statusMarkdown({ pin, npub: k.npub, checked: 'now', relays: r, results: [] });
  assert.match(md, /matches PIN/);
});

test('gateways-status.md: gateway text can only ever be literal text', () => {
  const evil = '`x` | [click](https://evil.example) <img src=x> ![i](y) \u001b[31m';
  const c = cell(evil);
  assert.ok(!/(^|[^\\])[`|[\]()<>!]/.test(c), c);
  assert.ok(!c.includes('\u001b'));
});
