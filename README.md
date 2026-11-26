# nutflix-nsite

Publishes the Nutflix web client as an **nsite** ([NIP-5A](https://github.com/nostr-protocol/nips/blob/master/5A.md)),
so that anyone's nsite infrastructure can serve it, not only ours:

- **public Blossom servers** hold the 7 files (addressed by sha256);
- **public relays** carry the signed manifest (kind 15128: path → sha256) and the key's lists;
- **any nsite gateway** can serve it at `https://<npub>.<gateway>/` (where it runs today:
  [`gateways-status.md`](gateways-status.md)).

There is no app code here. The page is pear's web client (`SovereignTechnology/nutflix-pear`,
`packages/app-web`): the exact tree `https://web.nutflix.xyz/` serves, pinned in [`PIN`](PIN). Peers don't
depend on where the page is hosted: rooms come from the network, video, rendition and relays, and relays,
STUN and WebRTC work from any HTTPS origin. Saved settings start fresh on a new origin.

## Files

| File | What |
|---|---|
| `PIN` | the site: pear commit, tree hash, every file's sha256 and size, the site tar's sha256. Same values as sovtech/alpha `kata/nfxweb/site/pear/PEAR.pin` |
| `publisher.npub` | the dedicated publisher key's npub, one line ([The key](#the-key)) |
| `servers.txt` | Blossom servers, most trusted first |
| `relays.txt` | relays; `lists` marks an indexer that gets only the key's lists |
| `gateways.txt` | gateways `verify.sh` checks |
| `gateways-status.md` | `verify.sh`'s last answer per gateway (written by it; commit it) |
| `publish.sh` → `src/publish.mjs` | the publish flow |
| `verify.sh` → `src/verify.mjs` | the gateway and relay checks |
| `proof/` | the real-browser playback and startup-timing test, run in a Kata VM |
| `test/` | `node --test`, run in a Kata VM (`kata-run`), never on a laptop |

## The key

One root site per key, so the site gets a **dedicated key**. Never the SovTech operator key: its root site
is reserved for SovTech's own nsite.

1. Cameron mints it in Bunker46 (the web UI is reachable from laptop2). The nsec stays in Bunker46; it
   never reaches this repo, a laptop or alpha.
2. Its npub goes in `publisher.npub` (one line; an nsec there is refused).
3. Each publish run pairs a fresh NIP-46 connection: in Bunker46 generate a bunker URI that may
   `sign_event` **only kinds 15128, 10063, 10002 and 24242**. That is all `publish.sh` ever asks for
   (`src/events.mjs`). Delete the connection after the run: its client key is gone with the process.

## Getting the site tar

`publish.sh` reads the site from the ustar tar that sovtech/alpha's `build-pear.sh` brings back from its
Kata build (the same build that feeds web.nutflix.xyz). It builds in a networked agentrun VM; nothing
builds on the laptop:

```sh
cd ~/Projects/sovtech-alpha        # main, or any branch whose kata/nfxweb/site/pear is main's
bash kata/nfxweb/site/pear/build-pear.sh build ~/.cache/nutflix-nsite-site
# -> ~/.cache/nutflix-nsite-site/build-<stamp>/nutflix-web-site-<pear12>.ustar.tar
#    and "== our tar = PEAR.pin's", "== tree hash = PEAR.pin's", "== every file's sha256 and size = PEAR.pin's"
```

`publish.sh` refuses any tar whose sha256 is not `PIN`'s `tar` line, then checks every file and the tree
hash again. Nothing is extracted to disk.

## Publishing

```sh
npm ci --ignore-scripts
./publish.sh --site-tar <tar> --dry-run   # offline: checks the tar, shows the plan and the first events
./publish.sh --site-tar <tar>             # in a terminal: the bunker URI is read with echo off
```

What the real run does, each step a stop if it fails (detail: `src/publish.mjs`'s header):

1. The bunker must sign for `publisher.npub`'s key, or nothing is asked of it.
2. A summary; you type `publish`. Nothing is signed before this.
3. One upload token (kind 24242, BUD-11) per blob, scoped to that blob's hash and the servers' domains,
   valid 20 minutes, never written to disk. Every signed event is checked: exactly its template, the
   publisher's key, a valid signature (rebuilt from JSON first, so a cached "verified" flag on the
   returned object counts for nothing).
4. Every blob to every server (BUD-02 `PUT /upload`). Always a PUT, even when the server has the blob: a
   blob only another key owns goes when that key deletes it. Each blob is fetched back and hashed;
   redirects are followed only to public `https` names carrying the same hash. A server counts only
   if it holds all 7.
5. The manifest (kind 15128: `path` tags, the NIP-5A aggregate `x`, `server` tags naming only the servers
   from step 4, title, description, source) and the key's server list (kind 10063), checked again and by
   `nak verify` when nak is on PATH, then sent: the manifest to every relay not marked `lists`, the server
   list to every relay.
6. The key's relay list (kind 10002) naming the relays that accepted the manifest (where gateways look for
   it), sent to every relay, the `lists` indexers included.

The manifest, the two lists and a `record.json` (per-server and per-relay results, the token ids) go to
`out/<UTC stamp>/` (mode 0700; ignored by git; nothing in it is secret). Relay and server text is cleaned
of control characters before it reaches the terminal, nostr-tools' own console output included. Then
run `verify.sh`.

## Verifying

```sh
./verify.sh                                       # every gateway in gateways.txt + the relays; rewrites gateways-status.md
./verify.sh --gateway 'https://{npub}.example.org/'   # one gateway, ad hoc
```

Per gateway, with redirects **not** followed, every path must give exactly `PIN`'s bytes. The checks:

- **Redirects.** The page fetches its wasm with `redirect: 'error'` and preloads `nfx/player.js` with SRI,
  so a gateway answering with a 302 to a Blossom URL breaks it.
- **Content types.** The page must be `text/html`, the scripts a JavaScript type (module scripts are strict)
  and the stylesheets `text/css`.
- **CSP.** The gateway's Content-Security-Policy must allow what pear's own allows: `'wasm-unsafe-eval'`,
  `blob:` media and connections, `wss:`/`https:` connections.
- **The wasm's content type is only recorded.** pear's page wraps the SRI-checked bytes in its own
  `application/wasm` Blob, so a gateway's type for it doesn't matter.

"works" means those static checks pass. The checker asks like a browser, but a gateway can still serve a
browser something else; the [proof](#proof) settles that. Only a run for `publisher.npub` over every listed
gateway rewrites `gateways-status.md`; gateway text is escaped there so it stays literal. Commit it after a run.

## Proof

`proof/playback-vm.sh` plays the real video in headless Chromium, in a throwaway Kata VM, and times each
stage of the startup:

```sh
kata-run --where agentrun --net --no-setup --timeout 3300 --max-wait 5400 -- \
  bash proof/playback-vm.sh https://<npub>.nsite.lol/ https://<npub>.nwb.tf/ https://web.nutflix.xyz/
```

Each URL gets three kinds of run: Play pressed at once (`cold`), Play pressed after the seeder's beacon has
arrived (`settled`), and the same in a browser whose WebRTC cannot use UDP (`nortc`).

**Last run, 2026-11-22, on the previous pin (pear `008b2f3`): 21 of 21 played past 8 s** on nsite.lol,
nwb.tf and web.nutflix.xyz, with no page error and no CSP violation. It has not been run again since pear
`1e0fef5` was published on 2026-11-26. Click to first frame:

| Run | Click to first frame |
|---|---|
| `cold` | 44.7-55.3 s, of which 41.8-51.7 s is waiting for a beacon |
| `settled` | 3.4-5.1 s |
| `nortc` | 3.7-5.1 s, plus one 14.7 s outlier on nsite.lol |

- **The slow start is the wait for a seeder's beacon** (the page's "Finding seeders…"). Beacons are
  ephemeral and republished every 60 s, so the wait is anywhere from 0 to 60 s. The harness's runs follow
  each other and fall into step with the beacon, which is why its `cold` waits all land near 45 s.
- **WebRTC does not delay the first frame.** Blocking it changes nothing, and the first frame arrives
  over HTTPS with at most 2 KB received over WebRTC. The mesh then connects and carries 3.5-20 MB within the
  next 8 s.
- **Not covered here:** alpha's stricter check that the selected pair names its mesh endpoint and that no
  tracker websocket opens (`kata/nfxweb/proof/run-prove-live.sh`, which assumes web.nutflix.xyz's headers).

## Updating

A new pear release moves alpha's `PEAR.pin` first (the pear session's `m5.sh site`). Then:

1. copy its value lines into `PIN` (keep this file's header);
2. build the tar, then run `publish.sh` and `verify.sh`.

Old blobs stay on the Blossom servers; the manifest is replaced (kind 15128 is replaceable).

## Our own gateway (sovpro.dev on alpha)

`*.sovpro.dev`, `relay.sovpro.dev` and `blossom.sovpro.dev` are listed, but alpha's nsite pod is stopped until
its memory re-budget. Serving the site there also takes the publisher key on alpha's allowlist (publish-only
first, then routed: sovtech/alpha `kata/nsite/README.md` "Allowlist"), and nsedge adding pear's headers on
that host. These are alpha MRs, and they go live on Cameron's go. Until then those entries fail, and each
run reports them.

## Tests

```sh
kata-run --where agentrun --net --no-setup -- bash -c 'npm ci --ignore-scripts && npm test'
```

The tests use fake Blossom servers, fake gateways and throwaway keys, all in-process. The real network is
never touched.

## License

AGPL-3.0-or-later, as nutflix-pear.
