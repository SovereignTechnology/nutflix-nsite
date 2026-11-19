import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { uploadAll } from '../src/blossom.mjs';
import { ConfigError, parsePin } from '../src/config.mjs';
import { aggregateHash } from '../src/events.mjs';
import { publishSite } from '../src/publish.mjs';
import { loadSite } from '../src/site.mjs';
import { blossom, key, pinText } from './helpers.mjs';

const { tar, text } = pinText();
const pin = parsePin(text);
const files = loadSite(tar, pin);
const closers = [];
after(() => Promise.all(closers.map((c) => c())));

const RELAYS = [
  { url: 'wss://ours.example', listsOnly: false },
  { url: 'wss://refuses.example', listsOnly: false },
  { url: 'wss://public.example', listsOnly: false },
  { url: 'wss://indexer.example', listsOnly: true },
];

/** The flow's edges, recorded; `over` replaces any of them. */
function edges(k, servers, over = {}) {
  const calls = { signed: [], sent: [], saved: new Map(), uploads: 0, connects: 0, logs: [] };
  const signer = {
    getPublicKey: async () => k.hex,
    signEvent: async (t) => {
      calls.signed.push(t.kind);
      return k.sign(t);
    },
    close: async () => undefined,
  };
  return {
    calls,
    args: {
      cfg: { pin, publisher: { npub: k.npub, hex: k.hex }, servers, relays: RELAYS },
      files,
      askBunkerUri: async () => 'bunker://x',
      connect: async () => {
        calls.connects++;
        return over.signer ?? signer;
      },
      confirm: async () => true,
      upload: async (s, f, a) => {
        calls.uploads++;
        return uploadAll(s, f, a);
      },
      publish: async (urls, ev) => {
        calls.sent.push({ kind: ev.kind, urls });
        return urls.map((relay) => ({ relay, ok: !relay.includes('refuses'), message: relay.includes('refuses') ? 'blocked: no' : '' }));
      },
      save: (name, ev) => calls.saved.set(name, ev),
      log: (l) => calls.logs.push(l),
      now: () => Math.floor(Date.now() / 1000),
      ...over.args,
    },
  };
}

const refused = (re) => (e) => e instanceof ConfigError && re.test(e.message);

test('publishes: uploads, then a manifest naming only the servers that hold every blob', async () => {
  const good = await blossom('ok');
  const bad = await blossom('refusing');
  closers.push(good.close, bad.close);
  const k = key();
  const { calls, args } = edges(k, [good, bad]);
  const r = await publishSite(args);
  assert.equal(r.published, true);
  assert.equal(good.blobs.size, files.length);
  // 4 tokens, then manifest + server list, then the relay list: nothing else was ever asked for.
  assert.deepEqual(calls.signed, [24242, 24242, 24242, 24242, 15128, 10063, 10002]);
  const site = calls.saved.get('site-15128.json');
  assert.equal(site.pubkey, k.hex);
  assert.deepEqual(site.tags.filter((t) => t[0] === 'server'), [['server', good.url]]);
  assert.deepEqual(site.tags.filter((t) => t[0] === 'path').map((t) => t[1]), files.map((f) => f.path));
  assert.deepEqual(site.tags.find((t) => t[0] === 'x'), ['x', aggregateHash(files), 'aggregate']);
  assert.deepEqual(calls.saved.get('servers-10063.json').tags, [['server', good.url]]);
  // The manifest skips the lists-only relay; the lists go everywhere.
  assert.deepEqual(calls.sent.find((s) => s.kind === 15128).urls, RELAYS.filter((x) => !x.listsOnly).map((x) => x.url));
  assert.deepEqual(calls.sent.find((s) => s.kind === 10063).urls, RELAYS.map((x) => x.url));
  // The relay list names exactly the relays that took the manifest.
  assert.deepEqual(calls.saved.get('relays-10002.json').tags, [
    ['r', 'wss://ours.example'],
    ['r', 'wss://public.example'],
  ]);
  // Upload tokens never reach the disk: only their ids, in the record.
  assert.deepEqual([...calls.saved.keys()].sort(), ['record.json', 'relays-10002.json', 'servers-10063.json', 'site-15128.json']);
  const rec = calls.saved.get('record.json');
  assert.equal(rec.tokens.length, files.length);
  assert.equal(rec.manifest.id, site.id);
  assert.equal(rec.servers.find((s) => s.server === bad.url).ok, false);
});

test('a dry run never connects, signs or sends', async () => {
  const k = key();
  const { calls, args } = edges(k, [{ url: 'https://x.example', host: 'x.example' }]);
  assert.deepEqual(await publishSite({ ...args, dryRun: true }), { dryRun: true });
  assert.equal(calls.connects, 0);
  assert.equal(calls.signed.length, 0);
  assert.equal(calls.sent.length, 0);
  assert.ok(calls.logs.some((l) => l.includes('"kind": 24242')));
});

test('no publisher key yet: refused before anything, though a dry run still shows the plan', async () => {
  const { calls, args } = edges(key(), [{ url: 'https://x.example', host: 'x.example' }]);
  const noKey = { ...args.cfg, publisher: null };
  await assert.rejects(publishSite({ ...args, cfg: noKey }), refused(/not been minted/));
  assert.equal(calls.connects, 0);
  assert.deepEqual(await publishSite({ ...args, cfg: noKey, dryRun: true }), { dryRun: true });
  assert.ok(calls.logs.some((l) => l.includes('publisher.npub not set yet')));
  assert.equal(calls.connects, 0);
});

test('a bunker for another key is refused before it signs anything', async () => {
  const k = key();
  const other = key();
  const { calls, args } = edges(k, [], {
    signer: { getPublicKey: async () => other.hex, signEvent: async () => assert.fail('asked to sign'), close: async () => undefined },
  });
  await assert.rejects(publishSite(args), refused(/not publisher\.npub's key/));
  assert.equal(calls.signed.length, 0);
});

test('a bunker that changes what it signs is refused before any upload', async () => {
  const k = key();
  const { calls, args } = edges(k, [{ url: 'https://x.example', host: 'x.example' }], {
    signer: {
      getPublicKey: async () => k.hex,
      signEvent: async (t) => k.sign({ ...t, tags: [...t.tags, ['server', 'evil.example']] }),
      close: async () => undefined,
    },
  });
  await assert.rejects(publishSite(args), refused(/changed the kind 24242/));
  assert.equal(calls.uploads, 0);
});

test('nak verify refusing an event stops the run', async () => {
  const k = key();
  const { calls, args } = edges(k, [{ url: 'https://x.example', host: 'x.example' }]);
  await assert.rejects(publishSite({ ...args, nakVerify: () => 'invalid .id' }), refused(/nak verify refuses/));
  assert.equal(calls.uploads, 0);
});

test('not typing "publish" signs, uploads and sends nothing', async () => {
  const k = key();
  const { calls, args } = edges(k, [{ url: 'https://x.example', host: 'x.example' }]);
  assert.deepEqual(await publishSite({ ...args, confirm: async () => false }), { published: false });
  assert.equal(calls.signed.length, 0);
  assert.equal(calls.uploads, 0);
  assert.equal(calls.sent.length, 0);
});

test('no server holding every blob: no manifest is signed', async () => {
  const bad = await blossom('corrupting');
  closers.push(bad.close);
  const k = key();
  const { calls, args } = edges(k, [bad]);
  await assert.rejects(publishSite(args), refused(/no Blossom server holds every blob/));
  assert.ok(!calls.signed.includes(15128));
  assert.ok(calls.saved.has('record.json'));
});

test('no relay taking the manifest: no relay list is signed', async () => {
  const good = await blossom('ok');
  closers.push(good.close);
  const k = key();
  const { calls, args } = edges(k, [good], {
    args: { publish: async (urls) => urls.map((relay) => ({ relay, ok: false, message: 'down' })) },
  });
  await assert.rejects(publishSite(args), refused(/no relay accepted the manifest/));
  assert.ok(!calls.signed.includes(10002));
});
