// Relays: publish a signed event to each, and read events back, every relay getting an answer
// (accepted, refused, or timed out).
import { clearTimeout, setTimeout } from 'node:timers';

import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

import { clean, errText } from './util.mjs';

// As pear's scripts/release-publish.mjs (2026-10-05): nostr-tools on Node 22's built-in WebSocket
// can recurse to a stack overflow on an unreachable relay, and `ws` emits an unhandled `error`
// when nostr-tools closes a socket that is still connecting. `ws`, with a listener of its own.
// Messages are capped at 1 MiB (ws's default is 100 MiB): every event this tool reads, and every
// answer from the bunker, is a few KiB.
export const MAX_MESSAGE_BYTES = 1024 * 1024;
class RelaySocket extends WebSocket {
  constructor(address, protocols) {
    super(address, protocols, { maxPayload: MAX_MESSAGE_BYTES });
    this.on('error', () => undefined);
  }
}
useWebSocketImplementation(RelaySocket);

export const PUBLISH_TIMEOUT_MS = 15_000;
export const QUERY_TIMEOUT_MS = 10_000;

/** Publish `event` to every relay URL. Returns [{ relay, ok, message }] in `relays` order. */
export async function publishToRelays(relays, event, timeoutMs = PUBLISH_TIMEOUT_MS) {
  const pool = new SimplePool();
  try {
    const attempts = pool.publish([...relays], event);
    return await Promise.all(
      attempts.map(async (p, i) => {
        let timer;
        const late = new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('no answer in time')), timeoutMs);
        });
        try {
          const message = await Promise.race([p, late]);
          return { relay: relays[i], ok: true, message: typeof message === 'string' ? clean(message) : '' };
        } catch (e) {
          return { relay: relays[i], ok: false, message: errText(e) };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  } finally {
    pool.close([...relays]);
  }
}

/** Every event matching `filter` that any relay returns within the timeout (unverified: check them). */
export async function queryRelays(relays, filter, timeoutMs = QUERY_TIMEOUT_MS) {
  const pool = new SimplePool();
  try {
    return await pool.querySync([...relays], filter, { maxWait: timeoutMs });
  } finally {
    pool.close([...relays]);
  }
}
