#!/usr/bin/env node
// Check the published site where people will open it: on each gateway in gateways.txt (or the
// --gateway templates given), and its manifest on the relays. Run it through ./verify.sh.
//
// Per gateway, at https://<npub>.<gateway>/ with redirects NOT followed:
//   - `/` and every PIN path: status 200, exactly PIN's bytes;
//   - no redirect on any file: the page fetches the wasm with `redirect: 'error'` and preloads
//     nfx/player.js with SRI, so a gateway answering with a 302 to a Blossom URL breaks it;
//   - Content-Type: text/html for the page, a JavaScript type for .js (module scripts are strict),
//     text/css for .css (standards mode ignores a stylesheet of any other type); the .wasm's type
//     is only recorded: pear's page wraps the SRI-checked bytes in its own application/wasm Blob;
//   - the page's CSP must allow what pear's own CSP allows (csp.mjs).
// "works" means these static checks pass; whether the page PLAYS there is the browser proof
// (sovtech/alpha run-prove-live.sh --page-mesh --url, README "Proof").
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decode as nip19decode, npubEncode } from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';

import { readLimited } from './blossom.mjs';
import { ConfigError, HEX64, loadConfig, parseGateways, sha256hex } from './config.mjs';
import { cspProblems } from './csp.mjs';
import { KINDS } from './events.mjs';
import { badArgument, clean, errLines, errText, guardConsole } from './util.mjs';

export const GATEWAY_TIMEOUT_MS = 30_000;
const JS_TYPE = /^(text|application)\/(x-)?(javascript|ecmascript)\s*(;|$)/i;
const mediaType = (ct) => (ct ?? '').split(';')[0].trim().toLowerCase();

const refuse = (msg) => {
  throw new ConfigError(msg);
};

/** What a path's Content-Type must be, or null when any type works. */
function typeRule(path) {
  if (path === '/' || path.endsWith('.html')) return { ok: (ct) => mediaType(ct) === 'text/html', want: 'text/html' };
  if (path.endsWith('.js')) return { ok: (ct) => JS_TYPE.test(ct ?? ''), want: 'a JavaScript type' };
  if (path.endsWith('.css')) return { ok: (ct) => mediaType(ct) === 'text/css', want: 'text/css' };
  return null;
}

/**
 * Asked like a browser would ask, so a gateway that varies on the client is judged on what a
 * browser gets (it can still serve a browser something else: the browser proof settles that).
 */
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function get(url, fetchImpl) {
  return fetchImpl(url, { redirect: 'manual', headers: BROWSER_HEADERS, signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
}

/**
 * One gateway. `base`: https://<npub>.<host>/. `files`: [{ path: '/x', sha256, bytes }].
 * Returns { gateway, url, verdict: 'works'|'fails'|'not found'|'unreachable', problems, wasmType, csp }.
 */
export async function checkGateway(base, files, { fetchImpl = fetch } = {}) {
  const u = new URL(base);
  const gateway = u.hostname.split('.').slice(1).join('.');
  const problems = [];
  const index = files.find((f) => f.path === '/index.html');
  const targets = [{ path: '/', want: index }, ...files.map((f) => ({ path: f.path, want: f }))];
  const statuses = [];
  let csp = null;
  let wasmType = null;
  for (const { path, want } of targets) {
    let res;
    try {
      res = await get(new URL(path, u).href, fetchImpl);
    } catch (e) {
      statuses.push(0);
      problems.push(`${path}: ${errText(e)}`);
      continue;
    }
    statuses.push(res.status);
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const loc = res.headers.get('location');
      let to = '';
      try {
        to = loc ? ` to ${clean(new URL(loc, u).host, 80)}` : '';
      } catch {
        to = ' (bad Location)';
      }
      problems.push(`${path}: redirect ${String(res.status)}${to}`);
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      problems.push(`${path}: ${String(res.status)}`);
      continue;
    }
    const ct = res.headers.get('content-type');
    if (/^\s*attachment/i.test(res.headers.get('content-disposition') ?? ''))
      problems.push(`${path}: Content-Disposition attachment (the browser downloads it)`);
    if (path === '/' || (path === '/index.html' && csp === null)) csp = res.headers.get('content-security-policy');
    let body;
    try {
      body = await readLimited(res, want.bytes + 1);
    } catch (e) {
      problems.push(`${path}: ${errText(e)}`);
      continue;
    }
    if (body.length !== want.bytes || sha256hex(body) !== want.sha256) problems.push(`${path}: other bytes than PIN's`);
    const rule = typeRule(path);
    if (rule !== null && !rule.ok(ct)) problems.push(`${path}: Content-Type ${clean(ct ?? 'none', 60)}, needs ${rule.want}`);
    if (path.endsWith('.wasm')) wasmType = clean(ct ?? 'none', 60);
  }
  problems.push(...cspProblems(csp, u.hostname).map((p) => clean(p)));
  let verdict = problems.length === 0 ? 'works' : 'fails';
  if (statuses.every((s) => s === 0)) verdict = 'unreachable';
  else if (statuses.every((s) => s === 404)) verdict = 'not found';
  return { gateway, url: u.href, verdict, problems, wasmType, csp: csp === null ? null : clean(csp, 400) };
}

/** Do a manifest's path tags name exactly PIN's files? */
export function manifestMatches(ev, files) {
  const paths = ev.tags.filter((t) => t[0] === 'path');
  if (paths.length !== files.length) return false;
  const want = new Map(files.map((f) => [f.path, f.sha256]));
  return paths.every((t) => want.get(t[1]) === t[2]) && new Set(paths.map((t) => t[1])).size === files.length;
}

/**
 * The newest valid kind 15128 by `hex` on the relays, and whether it is PIN's site; plus the
 * key's 10002 relay list. `query`: (relayUrls, filter) => events.
 */
export async function checkRelays(relayUrls, hex, files, query) {
  const valid = (evs, kind) =>
    evs
      .map((e) => JSON.parse(JSON.stringify(e))) // drop nostr-tools' cached verdict, then verify
      .filter(
        (e) =>
          e.kind === kind &&
          e.pubkey === hex &&
          Number.isSafeInteger(e.created_at) &&
          e.created_at > 0 &&
          e.created_at < 2 ** 33 &&
          Array.isArray(e.tags) &&
          e.tags.length <= 1000 &&
          verifyEvent(e),
      )
      .sort((a, b) => b.created_at - a.created_at)[0];
  const site = valid(await query(relayUrls, { kinds: [KINDS.SITE], authors: [hex] }), KINDS.SITE);
  const relays = valid(await query(relayUrls, { kinds: [KINDS.RELAYS], authors: [hex] }), KINDS.RELAYS);
  return {
    manifest:
      site === undefined
        ? null
        : {
            id: site.id,
            created: new Date(site.created_at * 1000).toISOString(),
            matchesPin: manifestMatches(site, files),
            servers: site.tags.filter((t) => t[0] === 'server').slice(0, 20).map((t) => clean(t[1], 120)),
          },
    relayList: relays === undefined ? null : relays.tags.filter((t) => t[0] === 'r').slice(0, 20).map((t) => clean(t[1], 120)),
  };
}

/**
 * Text from gateways and relays lands in a committed Markdown file: clean it, then escape every
 * character Markdown or HTML gives meaning to, so it can only ever be literal text.
 */
export const cell = (s) => clean(s, 400).replace(/[\\`*_{}[\]()<>#+!|~&"']/g, (c) => `\\${c}`);

export function statusMarkdown({ pin, npub, checked, relays, results }) {
  const out = [
    '# Gateway status',
    '',
    'Written by `verify.sh`; do not edit by hand. "works" = the static checks pass (every path is PIN\'s bytes,',
    'no redirects, usable Content-Types, a CSP that allows the page); playing is proved separately (README "Proof").',
    '',
    `- Checked: ${checked}`,
    `- Site: pear \`${pin.pear}\`, tree \`${pin.tree}\``,
    `- Key: \`${npub}\``,
  ];
  if (relays !== null) {
    const m = relays.manifest;
    out.push(
      m === null
        ? '- Manifest on the relays: **not found**'
        : `- Manifest on the relays: \`${m.id}\` (${m.created}), ${m.matchesPin ? 'matches PIN' : '**does NOT match PIN**'}; servers: ${m.servers.map(cell).join(', ') || 'none'}`,
      `- Relay list (10002): ${relays.relayList === null ? '**none**' : relays.relayList.map(cell).join(', ')}`,
    );
  }
  out.push('', '| Gateway | Verdict | Problems | wasm Content-Type | CSP |', '|---|---|---|---|---|');
  for (const r of results)
    out.push(
      `| ${cell(r.gateway)} | ${r.verdict} | ${cell(r.problems.join('; ') || '-')} | ${cell(r.wasmType ?? '-')} | ${r.csp === null ? 'none' : cell(r.csp)} |`,
    );
  return `${out.join('\n')}\n`;
}

const USAGE = 'usage: verify.sh [--npub <npub>] [--gateway https://{npub}.host/]... [--no-relays]';

export async function run(argv, root = resolve(fileURLToPath(import.meta.url), '../..')) {
  guardConsole();
  let npub;
  const adhoc = [];
  let relaysToo = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--npub') npub = argv[++i];
    else if (argv[i] === '--gateway') adhoc.push(argv[++i]);
    else if (argv[i] === '--no-relays') relaysToo = false;
    else refuse(badArgument(argv[i], USAGE));
  }
  const cfg = loadConfig(root);
  let hex;
  if (npub !== undefined) {
    let d;
    try {
      d = nip19decode(npub);
    } catch {
      refuse('--npub: not an npub');
    }
    if (d.type !== 'npub' || !HEX64.test(d.data)) refuse('--npub: not an npub');
    hex = d.data;
  } else {
    if (cfg.publisher === null) refuse('publisher.npub is empty: pass --npub');
    ({ hex } = cfg.publisher);
  }
  npub = npubEncode(hex);
  const gateways = adhoc.length > 0 ? parseGateways(adhoc.join('\n')) : cfg.gateways;
  const files = cfg.pin.files.map((f) => ({ path: `/${f.path}`, sha256: f.sha256, bytes: f.bytes }));
  const log = (line) => process.stderr.write(`${line}\n`);

  let relays = null;
  if (relaysToo) {
    const { queryRelays } = await import('./relays.mjs');
    relays = await checkRelays(cfg.relays.map((r) => r.url), hex, files, queryRelays);
    log(
      relays.manifest === null
        ? 'manifest: not found on any relay'
        : `manifest: ${relays.manifest.id} (${relays.manifest.created}) ${relays.manifest.matchesPin ? 'matches PIN' : 'does NOT match PIN'}`,
    );
  }
  const results = [];
  for (const g of gateways) {
    const r = await checkGateway(g.replace('{npub}', npub), files);
    results.push(r);
    log(`${r.verdict.padEnd(11)} ${r.gateway}${r.problems.length ? `: ${r.problems.join('; ')}` : ''}`);
  }
  // gateways-status.md is committed: only the publisher key's run over every listed gateway writes it.
  if (adhoc.length === 0 && npub === cfg.publisher?.npub) {
    const md = statusMarkdown({ pin: cfg.pin, npub, checked: new Date().toISOString(), relays, results });
    writeFileSync(join(root, 'gateways-status.md'), md);
    log('wrote gateways-status.md');
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (results) => process.exit(results.some((r) => r.verdict === 'works') ? 0 : 1),
    (err) => {
      process.stderr.write(`verify: FAILED: ${errLines(err)}\n`);
      process.exit(2);
    },
  );
}
