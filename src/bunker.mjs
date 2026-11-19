// The NIP-46 connection to Bunker46, the only place the publisher key lives.
//
// Only `bunker://<64-hex>?relay=wss://…&secret=…` is accepted (as pear's packages/core
// nip46-connect.ts): nostr-tools' parseBunkerInput would also resolve `name@domain` through an
// HTTPS fetch of a URL named by input, and a `ws://` relay would carry the channel's metadata in
// the clear. The URI's one-time secret is used for the `connect` handshake and never written,
// logged or printed. The channel's client key is made per run and dropped at exit.
import { BUNKER_REGEX, BunkerSigner } from 'nostr-tools/nip46';
import { SimplePool } from 'nostr-tools/pool';
import { generateSecretKey } from 'nostr-tools/pure';

import './relays.mjs'; // installs the `ws` socket class before any pool is made
import { ConfigError } from './config.mjs';
import { errText } from './util.mjs';

/** Each NIP-46 request waits this long for the bunker (connect, get_public_key, sign_event). */
export const BUNKER_TIMEOUT_MS = 60_000;

export function parseBunkerUri(uri) {
  const m = BUNKER_REGEX.exec(String(uri).trim());
  if (m === null) throw new ConfigError('not a bunker://<64-hex pubkey>?relay=wss://… URI');
  const qs = new URLSearchParams(m[2] ?? '');
  const relays = qs.getAll('relay');
  if (relays.length === 0) throw new ConfigError('the bunker URI names no relay');
  for (const r of relays) {
    let u;
    try {
      u = new URL(r);
    } catch {
      throw new ConfigError('a bunker relay is not a URL');
    }
    if (u.protocol !== 'wss:') throw new ConfigError('bunker relays must be wss://');
  }
  const secret = qs.get('secret');
  if (secret === null || secret === '')
    throw new ConfigError('the bunker URI has no secret: generate a fresh one in Bunker46');
  return { pubkey: m[1], relays, secret };
}

/**
 * Connect and return { getPublicKey, signEvent, close }. `onauth` hears an auth_url challenge
 * (untrusted text: the caller cleans it before printing).
 */
export async function connectBunker(uri, { onauth = () => undefined, timeoutMs = BUNKER_TIMEOUT_MS } = {}) {
  const bp = parseBunkerUri(uri);
  const pool = new SimplePool();
  const signer = BunkerSigner.fromBunker(generateSecretKey(), bp, { pool, onauth, timeout: timeoutMs });
  const close = async () => {
    await signer.close().catch(() => undefined);
    pool.close(bp.relays);
  };
  try {
    await signer.connect();
  } catch (e) {
    await close();
    throw new ConfigError(`the bunker did not accept the connection (${errText(e)})`);
  }
  return {
    getPublicKey: () => signer.getPublicKey(),
    signEvent: (t) => signer.signEvent(t),
    close,
  };
}
