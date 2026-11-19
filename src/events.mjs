// The four kinds this tool ever asks the signer for, built here as UNSIGNED templates, and the
// check every signed event must pass before it is used: it is exactly its template, signed by the
// publisher key, with a valid signature.
//   24242  Blossom upload authorization (BUD-11), one per blob
//   15128  the root-site manifest (NIP-5A): path -> sha256, plus server hints
//   10063  the key's Blossom server list (BUD-03)
//   10002  the key's relay list (NIP-65): where gateways look for the manifest
import { verifyEvent } from 'nostr-tools/pure';

import { ConfigError, HEX64, sha256hex } from './config.mjs';

export const KINDS = Object.freeze({ AUTH: 24242, SITE: 15128, SERVERS: 10063, RELAYS: 10002 });
export const ALLOWED_KINDS = Object.freeze(Object.values(KINDS));

/**
 * How long an upload authorization is valid (BUD-11 `expiration`). The tokens are signed right
 * before the uploads; 20 minutes covers 7 blobs at the 60 s per-upload timeout with room to spare,
 * and limits what a server that saw a token could do with it (it is also scoped to one blob's hash
 * and to the listed servers' domains).
 */
export const AUTH_TTL_S = 1200;

const refuse = (msg) => {
  throw new ConfigError(msg);
};

/**
 * NIP-5A's aggregate hash: one `<sha256> <absolute-path>\n` line per path tag (ONE space; not
 * pear's two-space tree hash), sorted lexicographically, concatenated, sha256.
 */
export function aggregateHash(files) {
  return sha256hex(
    files
      .map((f) => `${f.sha256} ${f.path}\n`)
      .sort()
      .join(''),
  );
}

/** BUD-11 upload token for one blob, scoped to that blob and to the listed servers' domains. */
export function uploadAuthTemplate(file, servers, now) {
  return {
    kind: KINDS.AUTH,
    created_at: now,
    content: `Upload ${file.path} of the Nutflix nsite`,
    tags: [
      ['t', 'upload'],
      ['x', file.sha256],
      ['expiration', String(now + AUTH_TTL_S)],
      ...servers.map((s) => ['server', s.host]),
    ],
  };
}

/** The kind 15128 root-site manifest. `servers`: the Blossom servers that hold every blob. */
export function siteTemplate(files, servers, pin, now) {
  return {
    kind: KINDS.SITE,
    created_at: now,
    content: '',
    tags: [
      ...files.map((f) => ['path', f.path, f.sha256]),
      ['x', aggregateHash(files), 'aggregate'],
      ...servers.map((s) => ['server', s.url]),
      ['title', 'Nutflix'],
      ['description', 'Watch together, peer to peer: the Nutflix web client.'],
      ['source', `https://github.com/SovereignTechnology/nutflix-pear/tree/${pin.pear}`],
    ],
  };
}

export const serverListTemplate = (servers, now) => ({
  kind: KINDS.SERVERS,
  created_at: now,
  content: '',
  tags: servers.map((s) => ['server', s.url]),
});

export const relayListTemplate = (relays, now) => ({
  kind: KINDS.RELAYS,
  created_at: now,
  content: '',
  tags: relays.map((r) => ['r', r]),
});

const isStrArr = (t) => Array.isArray(t) && t.every((x) => typeof x === 'string');

/**
 * `signed` must be `template` signed by `pubkey`: same kind, created_at, content and tags (in
 * order), a valid id and signature. Returns a fresh plain event of exactly the seven NIP-01 fields.
 *
 * The event is rebuilt from a JSON copy BEFORE verifying: nostr-tools caches a verdict on the
 * object under a symbol (verifiedSymbol), and a returned object carrying `true` there would skip
 * the real check.
 */
export function checkSigned(template, signed, pubkey) {
  let e;
  try {
    e = JSON.parse(JSON.stringify(signed));
  } catch {
    refuse('the signer returned something that is not an event');
  }
  if (e === null || typeof e !== 'object') refuse('the signer returned something that is not an event');
  const ev = {
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags,
    content: e.content,
    sig: e.sig,
  };
  if (ev.pubkey !== pubkey) refuse(`the signer signed kind ${template.kind} with another key`);
  if (ev.kind !== template.kind || ev.created_at !== template.created_at || ev.content !== template.content)
    refuse(`the signer changed the kind ${template.kind} event (kind, created_at or content)`);
  if (
    !Array.isArray(ev.tags) ||
    !ev.tags.every(isStrArr) ||
    JSON.stringify(ev.tags) !== JSON.stringify(template.tags)
  )
    refuse(`the signer changed the kind ${template.kind} event's tags`);
  if (typeof ev.id !== 'string' || !HEX64.test(ev.id) || typeof ev.sig !== 'string' || !/^[0-9a-f]{128}$/.test(ev.sig))
    refuse(`the kind ${template.kind} event has no well-formed id and signature`);
  if (!verifyEvent(ev)) refuse(`the kind ${template.kind} event's id or signature is invalid`);
  return JSON.parse(JSON.stringify(ev));
}
