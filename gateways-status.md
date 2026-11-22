# Gateway status

Written by `verify.sh`; do not edit by hand. "works" = the static checks pass (every path is PIN's bytes,
no redirects, usable Content-Types, a CSP that allows the page); playing is proved separately (README "Proof").

- Checked: 2026-11-22T12:22:58.708Z
- Site: pear `008b2f33f7059c4afc4871cae61d11140605f208`, tree `98c822837de852230aeb78f24fb129697f9149bb0b0fb30171cb369dcd615640`
- Key: `npub1t2uhpqsznqhcn5q2ljl6ckrq7gmnnk92dhg5jdd4dnfkdknudw9q6069jk`
- Manifest on the relays: `cea8aaea1f07e5daafadf6fea00308419e36945150f7a10a294c303f6dc7bbfc` (2026-11-22T12:19:57.000Z), matches PIN; servers: https://nostr.download, https://blossom.ditto.pub
- Relay list (10002): wss://relay.nsite.lol, wss://relay.primal.net

| Gateway | Verdict | Problems | wasm Content-Type | CSP |
|---|---|---|---|---|
| sovpro.dev | unreachable | /: fetch failed; /app.js: fetch failed; /index.html: fetch failed; /nfx/player.js: fetch failed; /nfx/wasm/nfx\_wasm\_bg.wasm: fetch failed; /shell.css: fetch failed; /source.json: fetch failed; /ui.css: fetch failed | - | none |
| nsite.lol | works | - | application/wasm | none |
| nosto.re | fails | /: 502; /app.js: 502; /index.html: 502; /nfx/player.js: 502; /nfx/wasm/nfx\_wasm\_bg.wasm: 502; /shell.css: 502; /source.json: 502; /ui.css: 502 | - | none |
| nwb.tf | works | - | application/octet-stream | none |
| nsite.run | fails | CSP script-src blocks \'wasm-unsafe-eval\'; CSP connect-src blocks blob: | application/wasm | default-src \'self\'; script-src \'self\' \'unsafe-inline\' blob: https:; style-src \'self\' \'unsafe-inline\' https:; worker-src \'self\' blob:; img-src \* data: blob:; media-src \* data: blob:; font-src \* data: https:; connect-src \'self\' wss: https:; frame-src \'self\' blob: https:; object-src \'none\' |
