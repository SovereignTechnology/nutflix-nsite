import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ConfigError,
  loadConfig,
  parseGateways,
  parsePin,
  parsePublisher,
  parseRelays,
  parseServers,
} from '../src/config.mjs';
import { loadSite, readUstar } from '../src/site.mjs';
import { key, pinText, sha, SITE, ustar } from './helpers.mjs';

const throwsConfig = (fn, re) => assert.throws(fn, (e) => e instanceof ConfigError && re.test(e.message));

test('the repo PIN parses and its file lines hash to its tree line', () => {
  const pin = parsePin(readFileSync(new URL('../PIN', import.meta.url), 'utf8'));
  assert.equal(pin.files.length, 7);
  assert.ok(pin.files.some((f) => f.path === 'nfx/wasm/nfx_wasm_bg.wasm'));
  assert.equal(pin.tar.name, `nutflix-web-site-${pin.pear.slice(0, 12)}.ustar.tar`);
});

test('the repo lists parse; publisher.npub may be empty until the key exists', () => {
  const cfg = loadConfig(new URL('..', import.meta.url).pathname);
  assert.ok(cfg.servers.length >= 2 && cfg.relays.length >= 2 && cfg.gateways.length >= 2);
  assert.ok(cfg.relays.some((r) => r.listsOnly));
  assert.ok(cfg.publisher === null || /^npub1/.test(cfg.publisher.npub));
});

test('PIN: a changed file line no longer matches the tree line', () => {
  const { text } = pinText();
  const bad = text.replace(/^file ([0-9a-f])/m, (_m, c) => `file ${c === 'a' ? 'b' : 'a'}`);
  throwsConfig(() => parsePin(bad), /tree/);
});

test('PIN: refuses unknown keys, repeats, bad paths and bad order', () => {
  const { text } = pinText();
  throwsConfig(() => parsePin(`${text}\nmirror x`), /unknown key/);
  throwsConfig(() => parsePin(`${text}\nci 1`), /twice/);
  throwsConfig(() => parsePin(text.replace(' app.js', ' ../app.js')), /plain site path/);
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith('file '));
  [lines[i], lines[i + 1]] = [lines[i + 1], lines[i]];
  throwsConfig(() => parsePin(lines.join('\n')), /bytewise order/);
});

test('publisher.npub: empty is null; an nsec is refused loudly', () => {
  assert.equal(parsePublisher('# nothing yet\n'), null);
  const k = key();
  assert.deepEqual(parsePublisher(`${k.npub}\n`), { npub: k.npub, hex: k.hex });
  throwsConfig(() => parsePublisher('nsec1qqqq'), /SECRET/);
  throwsConfig(() => parsePublisher(`${k.npub}\n${k.npub}`), /exactly one/);
  throwsConfig(
    () => parsePublisher('npub1s0vtechh66tx7vrwdud8zfyheu9zca7swwfrzd4qu2a4f93mxs6qvn9adx'),
    /operator key/,
  );
});

test('lists: origins only, right scheme, no repeats', () => {
  assert.deepEqual(parseServers('https://Blossom.Band/  # c\n'), [{ url: 'https://blossom.band', host: 'blossom.band' }]);
  throwsConfig(() => parseServers('http://x.example'), /https:/);
  throwsConfig(() => parseServers('https://x.example/upload'), /origin only/);
  throwsConfig(() => parseServers('https://u:p@x.example'), /origin only/);
  throwsConfig(() => parseServers('https://x.example\nhttps://x.example/'), /twice/);
  assert.deepEqual(parseRelays('wss://a.example\nwss://b.example lists'), [
    { url: 'wss://a.example', listsOnly: false },
    { url: 'wss://b.example', listsOnly: true },
  ]);
  throwsConfig(() => parseRelays('wss://a.example readonly'), /lists/);
  throwsConfig(() => parseRelays('ws://a.example'), /wss:/);
  assert.deepEqual(parseGateways('https://{npub}.nsite.lol/'), ['https://{npub}.nsite.lol/']);
  throwsConfig(() => parseGateways('https://nsite.lol/{npub}'), /look like/);
});

test('the site tar: read back exactly, then checked against PIN', () => {
  const { tar, text } = pinText();
  assert.deepEqual(
    readUstar(tar).map((e) => [e.path, e.data]),
    SITE,
  );
  const files = loadSite(tar, parsePin(text));
  assert.deepEqual(
    files.map((f) => [f.path, f.type, f.sha256]),
    [
      ['/app.js', 'text/javascript', sha(SITE[0][1])],
      ['/index.html', 'text/html', sha(SITE[1][1])],
      ['/nfx/wasm/nfx_wasm_bg.wasm', 'application/wasm', sha(SITE[2][1])],
      ['/shell.css', 'text/css', sha(SITE[3][1])],
    ],
  );
});

test('the site tar: any other tar is refused before it is read', () => {
  const { text } = pinText();
  const pin = parsePin(text);
  const other = ustar(SITE.map(([p, d], i) => [p, i === 0 ? Buffer.from('export const app = 2;\n') : d]));
  throwsConfig(() => loadSite(other, pin), /not PIN's/);
});

test('ustar reader: refuses a bad checksum, a non-file entry and trailing bytes', () => {
  const tar = ustar(SITE.slice(0, 1));
  const badSum = Buffer.from(tar);
  badSum[0] ^= 1;
  throwsConfig(() => readUstar(badSum), /checksum/);
  const link = Buffer.from(tar);
  link[156] = 0x32; // '2' symlink
  let s = 0;
  link.fill(0x20, 148, 156);
  for (const b of link.subarray(0, 512)) s += b;
  Buffer.from(`${s.toString(8).padStart(6, '0')}\0 `, 'latin1').copy(link, 148);
  throwsConfig(() => readUstar(link), /not a regular file/);
  const trailing = Buffer.concat([tar, Buffer.from('x')]);
  throwsConfig(() => readUstar(trailing), /after the end/);
});
