// Small helpers shared by publish and verify.

/**
 * Anything a remote server or relay says (X-Reason, an error, a header) is untrusted text: printed
 * raw, an escape sequence in it would drive the terminal. Printable ASCII only, bounded length.
 */
export function clean(s, max = 200) {
  const t = String(s ?? '').replace(/[^\x20-\x7e]/g, '?');
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

/** The message of a caught value, cleaned. */
export const errText = (e, max = 200) => clean(e instanceof Error ? e.message : String(e), max);

/** As errText, keeping line breaks (the top-level error: our own messages span lines). */
export const errLines = (e) =>
  String(e instanceof Error ? e.message : e)
    .split('\n')
    .slice(0, 20)
    .map((l) => clean(l, 400))
    .join('\n');

/**
 * nostr-tools prints what relays send (NOTICE text, malformed frames, auth errors) straight to
 * console.debug/console.warn, past `clean`. Route every console method through it, once, before
 * any relay is contacted.
 */
let guarded = false;
export function guardConsole() {
  if (guarded) return;
  guarded = true;
  for (const m of ['debug', 'info', 'log', 'warn', 'error', 'trace']) {
    const orig = console[m].bind(console);
    console[m] = (...args) => orig(...args.map((a) => clean(a instanceof Error ? a.message : a, 300)));
  }
}

/**
 * Arguments are never echoed back: a bunker URI or an nsec pasted as an argument is already in
 * shell history and `ps`, and printing it again spreads it further. Say so instead.
 */
export function badArgument(arg, usage) {
  const secretish = /^(bunker:\/\/|nostrconnect:\/\/|nsec1|ncryptsec1)/i.test(String(arg));
  return secretish
    ? `an argument looks like a SECRET (a bunker URI or an nsec). It is now in your shell history: delete that line, and revoke or regenerate the secret. Secrets are only ever typed at the hidden prompt.\n${usage}`
    : `unknown argument (not shown)\n${usage}`;
}

/** UTC timestamp for directory names: 20261119T091500Z. */
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Unix seconds. */
export const unixNow = () => Math.floor(Date.now() / 1000);
