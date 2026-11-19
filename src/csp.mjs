// Would a gateway's Content-Security-Policy let the Nutflix page run? Every policy the gateway sends
// must allow what pear's own CSP allows (pear packages/app-web dist/site-headers.txt): that list is
// the page's real needs, kept tight by pear. Matching follows CSP Level 3 ("Does url match source
// list"), simplified where it can only make the verdict stricter, never looser.

/** What the page needs, per CSP3 fallback chain (first = the directive the browser checks). */
const SELF = { label: "'self'", type: 'self' };
const WASM = { label: "'wasm-unsafe-eval'", type: 'wasm' };
const ANY_HTTPS = { label: 'https:', type: 'any', scheme: 'https' };
const ANY_WSS = { label: 'wss:', type: 'any', scheme: 'wss' };
const BLOB = { label: 'blob:', type: 'blob' };
export const PAGE_NEEDS = Object.freeze([
  // <script type="module" src> and preloads of the site's own scripts (no nonce, no hash)
  { chain: ['script-src-elem', 'script-src', 'default-src'], needs: [SELF], scripts: true },
  // WebAssembly compilation is checked against script-src, not script-src-elem
  { chain: ['script-src', 'default-src'], needs: [WASM] },
  { chain: ['style-src-elem', 'style-src', 'default-src'], needs: [SELF] },
  { chain: ['img-src', 'default-src'], needs: [SELF, BLOB] },
  { chain: ['media-src', 'default-src'], needs: [SELF, BLOB] },
  // the site itself, relays (wss:), the HTTPS fallback and Blossom (https:), the verified wasm Blob
  { chain: ['connect-src', 'default-src'], needs: [SELF, ANY_HTTPS, ANY_WSS, BLOB] },
  { chain: ['worker-src', 'child-src', 'script-src', 'default-src'], needs: [SELF], scripts: true },
]);
// pear's font-src and manifest-src are left out: the site ships no font and no web manifest.

/** CSP splits on ASCII whitespace only (a no-break space is part of a token). */
const ASCII_WS = /[\t\n\f\r ]+/;

/** One header value -> policies (comma-separated) -> Map directive -> [tokens]; first one wins. */
export function parseCsp(value) {
  return String(value)
    .split(',')
    .map((p) => {
      const m = new Map();
      for (const d of p.split(';')) {
        const [name, ...tokens] = d.trim().split(ASCII_WS);
        const n = (name ?? '').toLowerCase();
        if (n && !m.has(n)) m.set(n, tokens.filter((t) => t !== '').map((t) => t.toLowerCase()));
      }
      return m;
    })
    .filter((m) => m.size > 0);
}

/** CSP3 "scheme-part match": does expression scheme `a` cover URL scheme `b`? */
const schemeMatch = (a, b) =>
  a === b || (a === 'http' && b === 'https') || (a === 'ws' && ['wss', 'http', 'https'].includes(b)) || (a === 'wss' && b === 'https');

const HOST_SOURCE = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\*|[0-9]{1,5}))?(\/.*)?$/;
const DEFAULT_PORT = { https: '443', wss: '443', http: '80', ws: '80' };

/**
 * Does `expr` match a URL of `scheme` on `host` (port: the scheme's default)? `host` null means
 * "every host": the expression must cover them all. The page's own origin is https://<page host>.
 */
function exprMatches(expr, scheme, host, pageHost) {
  if (expr === "'self'") return scheme === 'https' && host === pageHost; // CSP3 'self' also takes wss same-host; not needed
  if (expr === '*') return scheme === 'https' || scheme === 'http'; // HTTP(S) or the page's own scheme (https)
  const s = /^([a-z][a-z0-9+.-]*):$/.exec(expr);
  if (s) return schemeMatch(s[1], scheme);
  const h = HOST_SOURCE.exec(expr);
  if (!h) return false; // keywords, nonces, hashes
  const [, xs, xh, xp, xpath] = h;
  if (xs !== undefined ? !schemeMatch(xs, scheme) : !schemeMatch('https', scheme)) return false;
  if (xh !== '*') {
    if (host === null) return false;
    if (xh.startsWith('*.') ? !host.endsWith(xh.slice(1)) : host !== xh) return false;
  }
  if (xp !== undefined && xp !== '*' && xp !== DEFAULT_PORT[scheme]) return false;
  if (xpath !== undefined && xpath !== '/') return false; // a path limits which files: stricter, not looser
  return true;
}

function allows(list, need, pageHost) {
  switch (need.type) {
    case 'self':
      return list.some((e) => exprMatches(e, 'https', pageHost, pageHost));
    case 'any':
      return list.some((e) => exprMatches(e, need.scheme, null, pageHost));
    case 'blob':
      return list.includes('blob:'); // `*` never covers blob:
    case 'wasm':
      return list.includes("'wasm-unsafe-eval'") || list.includes("'unsafe-eval'");
    default:
      return false;
  }
}

/**
 * What in `headerValue` would break the page on `pageHost`: a list of problems ([] = none). A
 * missing header is no problem. Report-only policies are not read: they block nothing.
 */
export function cspProblems(headerValue, pageHost) {
  if (headerValue === null || headerValue === undefined || headerValue.trim() === '') return [];
  const host = String(pageHost).toLowerCase();
  const problems = [];
  for (const policy of parseCsp(headerValue)) {
    if (policy.has('sandbox')) {
      const s = policy.get('sandbox');
      if (!s.includes('allow-scripts') || !s.includes('allow-same-origin'))
        problems.push('CSP sandbox without allow-scripts and allow-same-origin');
    }
    if (policy.has('require-trusted-types-for')) problems.push('CSP requires Trusted Types');
    for (const { chain, needs, scripts } of PAGE_NEEDS) {
      const from = chain.find((d) => policy.has(d));
      if (from === undefined) continue; // nothing restricts it
      const list = policy.get(from);
      const where = `CSP ${from}${from === chain[0] ? '' : ` (for ${chain[0]})`}`;
      if (scripts && list.includes("'strict-dynamic'")) {
        problems.push(`${where} has 'strict-dynamic': the site's scripts carry no nonce`);
        continue;
      }
      for (const need of needs) if (!allows(list, need, host)) problems.push(`${where} blocks ${need.label}`);
    }
  }
  return [...new Set(problems)];
}
