#!/usr/bin/env node
// Publish the pinned Nutflix web client as the publisher key's ROOT nsite (NIP-5A kind 15128),
// to every Blossom server in servers.txt and every relay in relays.txt. Run it through
// ./publish.sh; README "Publishing" is the procedure.
//
// Order, each step a STOP if it fails:
//   1. Offline: PIN, the lists, publisher.npub; the site tar against PIN (tar sha256, every file,
//      pear's tree hash). --dry-run stops here: it prints the plan and example templates, and
//      touches neither the network nor the signer.
//   2. The bunker:// URI, read with echo off (never argv: shell history and `ps` keep argv). The
//      bunker must sign for publisher.npub, or nothing is asked of it.
//   3. A summary; typing `publish` goes on (not a reflexive `y`). Nothing is signed before this.
//   4. One kind 24242 upload token per blob, each checked: exactly its template, the publisher's
//      key, a valid signature. Tokens are never written to disk (record.json keeps their ids).
//   5. Every blob to every server, each fetched back and hashed. A server counts only if it holds
//      all of them; at least one must.
//   6. The kind 15128 manifest (server tags = the servers from 5) and the kind 10063 server list,
//      checked as in 4 and by `nak verify` when nak is on PATH, saved, then sent to every relay
//      (the manifest skips `lists` relays). At least one relay must take the manifest.
//   7. The kind 10002 relay list naming the relays that took the manifest (where a gateway will
//      look for it), checked, saved, sent to every relay.
// The manifest, the lists and record.json land in out/<UTC stamp>/ (0700; never overwritten).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { npubEncode } from 'nostr-tools/nip19';

import { ConfigError, loadConfig } from './config.mjs';
import {
  checkSigned,
  relayListTemplate,
  serverListTemplate,
  siteTemplate,
  uploadAuthTemplate,
} from './events.mjs';
import { loadSiteFile } from './site.mjs';
import { badArgument, clean, errLines, guardConsole, stamp, unixNow } from './util.mjs';

export const CONFIRM_WORD = 'publish';
const refuse = (msg) => {
  throw new ConfigError(msg);
};

export function planText({ pin, files, servers, relays, publisher }) {
  return [
    `site: pear ${pin.pear} (nfx ${pin.nfx}), tree ${pin.tree}`,
    ...files.map((f) => `  ${f.sha256}  ${String(f.bytes).padStart(7)}  ${f.path}  (${f.type})`),
    `key: ${publisher === null ? '(publisher.npub not set yet: README "The key")' : publisher.npub}`,
    `Blossom servers (${String(servers.length)}): ${servers.map((s) => s.host).join(', ')}`,
    `relays (${String(relays.length)}): ${relays.map((r) => r.url + (r.listsOnly ? ' (lists only)' : '')).join(', ')}`,
  ].join('\n');
}

/**
 * The whole flow with its edges injected (tests pass fakes; `run` passes the real ones).
 *   cfg           { pin, publisher, servers, relays }
 *   files         loadSite's output (already checked against PIN)
 *   askBunkerUri  () => Promise<string>
 *   connect       (uri) => Promise<{ getPublicKey, signEvent, close }>
 *   confirm       (text) => Promise<boolean>
 *   upload        (servers, files, auths: Map) => Promise<uploadAll's result>
 *   publish       (relayUrls, event) => Promise<[{ relay, ok, message }]>
 *   nakVerify     (event) => string | null   (null: nak absent; otherwise '' = ok, or why not)
 *   save          (name, value) => void
 *   log           (line) => void
 *   now           () => unix seconds
 */
export async function publishSite({
  cfg,
  files,
  askBunkerUri,
  connect,
  confirm,
  upload,
  publish,
  nakVerify = () => null,
  save,
  log,
  dryRun = false,
  now = unixNow,
}) {
  const { pin, publisher, servers, relays } = cfg;
  const plan = planText({ pin, files, servers, relays, publisher });
  if (!dryRun && publisher === null)
    refuse('publisher.npub is empty: the dedicated publisher key has not been minted in Bunker46 yet (README "The key")');
  log(plan);
  if (dryRun) {
    const t = now();
    log('\ndry run: nothing signed, nothing sent. The first upload token would be:');
    log(JSON.stringify(uploadAuthTemplate(files[0], servers, t), null, 2));
    log('then, after the uploads, the kind 15128 manifest (servers = those holding every blob):');
    log(JSON.stringify(siteTemplate(files, servers, pin, t), null, 2));
    return { dryRun: true };
  }

  const uri = await askBunkerUri();
  const signer = await connect(uri);
  const record = { started: new Date(now() * 1000).toISOString(), pin: pin.pear, tree: pin.tree, key: publisher.npub };
  try {
    const pk = await signer.getPublicKey();
    if (pk !== publisher.hex)
      refuse(`the bunker signs for ${npubEncode(pk)}, not publisher.npub's key: nothing was signed`);
    // The signer gets a copy: what it returns is compared with the template we kept.
    const sign = async (template, what) => {
      const ev = checkSigned(template, await signer.signEvent(structuredClone(template)), publisher.hex);
      const why = nakVerify(ev);
      if (why !== null && why !== '') refuse(`nak verify refuses the ${what}: ${clean(why)}`);
      return ev;
    };

    // 3. go?
    if (!(await confirm(plan))) {
      log('not published: nothing was signed, uploaded or sent.');
      return { published: false };
    }

    // 4. the upload tokens, signed just before they are used
    const t0 = now();
    const auths = new Map();
    for (const f of files) auths.set(f.sha256, await sign(uploadAuthTemplate(f, servers, t0), `upload token for ${f.path}`));
    record.tokens = [...auths.values()].map((e) => e.id);
    log(`signed and checked ${String(auths.size)} upload tokens (kind 24242)`);

    // 5. the blobs
    log('uploading:');
    const up = await upload(servers, files, auths);
    record.servers = up.map((u) => ({ server: u.server.url, ok: u.ok, blobs: u.blobs }));
    const holding = up.filter((u) => u.ok).map((u) => u.server);
    if (holding.length === 0) refuse('no Blossom server holds every blob: no manifest was signed or sent');
    log(`servers holding every blob: ${holding.map((s) => s.host).join(', ')}`);

    // 6. the manifest and the server list
    const t1 = now();
    const site = await sign(siteTemplate(files, holding, pin, t1), 'manifest');
    save('site-15128.json', site);
    const serverList = await sign(serverListTemplate(holding, t1), 'server list');
    save('servers-10063.json', serverList);
    const all = relays.map((r) => r.url);
    const siteRelays = relays.filter((r) => !r.listsOnly).map((r) => r.url);
    const sent = async (what, urls, ev) => {
      const res = await publish(urls, ev);
      for (const x of res) log(`  ${x.ok ? 'ok    ' : 'FAILED'} ${what} -> ${x.relay}${x.message ? `: ${clean(x.message)}` : ''}`);
      return res;
    };
    const siteRes = await sent('manifest', siteRelays, site);
    record.manifest = { id: site.id, relays: siteRes };
    const took = siteRes.filter((x) => x.ok).map((x) => x.relay);
    if (took.length === 0) refuse('no relay accepted the manifest');
    record.serverList = { id: serverList.id, relays: await sent('server list', all, serverList) };

    // 7. the relay list: where the manifest is
    const relayList = await sign(relayListTemplate(took, now()), 'relay list');
    save('relays-10002.json', relayList);
    record.relayList = { id: relayList.id, relays: await sent('relay list', all, relayList) };
    log(`published: manifest ${site.id}`);
    return { published: true, record };
  } finally {
    await signer.close();
    save('record.json', record);
  }
}

/** `nak verify` on an event, if nak is on PATH: null (absent), '' (valid) or its complaint. */
export function nakVerify(ev) {
  const r = spawnSync('nak', ['verify'], { input: JSON.stringify(ev), encoding: 'utf8', timeout: 20_000 });
  if (r.error?.code === 'ENOENT') return null;
  if (r.error) return r.error.message;
  return r.status === 0 ? '' : `${r.stderr || r.stdout || `exit ${String(r.status)}`}`.trim();
}

/** A line from the terminal with echo off (the bunker URI carries a one-time secret). */
function askHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY) refuse('run this in a terminal: the bunker URI is read with echo off');
  return new Promise((resolve_, reject) => {
    process.stderr.write(prompt);
    let line = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const done = (err) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      if (err === undefined) resolve_(line.trim());
      else reject(err);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new ConfigError('cancelled'));
        if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1);
        else line += ch;
      }
      return undefined;
    };
    input.on('data', onData);
  });
}

function askLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve_) => {
    rl.question(prompt, (a) => {
      rl.close();
      resolve_(a);
    });
  });
}

const USAGE = 'usage: publish.sh --site-tar <nutflix-web-site-*.ustar.tar> [--dry-run]';

export async function run(argv, root = resolve(fileURLToPath(import.meta.url), '../..')) {
  guardConsole();
  let tar;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--site-tar') {
      tar = argv[++i];
      if (tar === undefined) refuse(USAGE);
    } else if (argv[i] === '--dry-run') dryRun = true;
    else refuse(badArgument(argv[i], USAGE));
  }
  if (tar === undefined) refuse(USAGE);
  const cfg = loadConfig(root);
  const files = loadSiteFile(tar, cfg.pin);
  const log = (line) => process.stderr.write(`${line}\n`);
  log(`site tar ${cfg.pin.tar.name}: matches PIN (tar sha256, ${String(files.length)} files, tree hash)`);

  // Loaded only now: a usage error or a dry run needs no network module.
  const { connectBunker } = await import('./bunker.mjs');
  const { uploadAll } = await import('./blossom.mjs');
  const { publishToRelays } = await import('./relays.mjs');
  let outDir;
  const save = (name, value) => {
    if (outDir === undefined) {
      outDir = join(root, 'out', stamp());
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      log(`saving the signed events and the record to ${outDir}`);
    }
    writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  };
  return publishSite({
    cfg,
    files,
    dryRun,
    askBunkerUri: () => askHidden('bunker:// URI for the publisher key (not shown): '),
    connect: (uri) =>
      connectBunker(uri, {
        onauth: (url) => log(`the bunker asks you to approve this client at: ${clean(url, 300)}`),
      }),
    confirm: async (text) => {
      process.stderr.write(`\n${text}\n\n`);
      return (await askLine(`Type "${CONFIRM_WORD}" to sign, upload and publish: `)).trim() === CONFIRM_WORD;
    },
    upload: (servers, fs_, auths) => uploadAll(servers, fs_, auths, { log }),
    publish: (urls, ev) => publishToRelays(urls, ev),
    nakVerify,
    save,
    log,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`publish: FAILED: ${errLines(err)}\n`);
      process.exit(1);
    },
  );
}
