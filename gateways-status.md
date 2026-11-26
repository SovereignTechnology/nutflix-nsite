# Gateway status

Written by `verify.sh`; do not edit by hand. "works" = the static checks pass (every path is PIN's bytes,
no redirects, usable Content-Types, a CSP that allows the page); playing is proved separately (README "Proof").

- Checked: 2026-11-26T05:00:02.976Z
- Site: pear `1e0fef56da16ce981f18ced2b33ee3cf7288f4f6`, tree `bbb04c7c77f2530555504022aec4fbd2dff36383d65286c9bc3452edd4684297`
- Key: `npub1t2uhpqsznqhcn5q2ljl6ckrq7gmnnk92dhg5jdd4dnfkdknudw9q6069jk`
- Manifest on the relays: `f87bf7e803a325325d65ee1ed655ecd63a7f41cf56f4cf8906d5d285400c4cfd` (2026-11-26T04:58:25.000Z), matches PIN; servers: https://nostr.download, https://blossom.ditto.pub, https://blossom.data.haus, https://blossom.yakihonne.com
- Relay list (10002): wss://relay.nsite.lol, wss://relay.primal.net

| Gateway | Verdict | Problems | wasm Content-Type | CSP |
|---|---|---|---|---|
| sovpro.dev | unreachable | /: fetch failed; /app.js: fetch failed; /index.html: fetch failed; /nfx/player.js: fetch failed; /nfx/wasm/nfx\_wasm\_bg.wasm: fetch failed; /shell.css: fetch failed; /source.json: fetch failed; /ui.css: fetch failed | - | none |
| nsite.lol | works | - | application/wasm | none |
| nosto.re | unreachable | /: fetch failed; /app.js: fetch failed; /index.html: fetch failed; /nfx/player.js: fetch failed; /nfx/wasm/nfx\_wasm\_bg.wasm: fetch failed; /shell.css: fetch failed; /source.json: fetch failed; /ui.css: fetch failed | - | none |
| nwb.tf | works | - | application/octet-stream | none |
| nsite.run | fails | CSP script-src blocks \'wasm-unsafe-eval\'; CSP connect-src blocks blob: | application/wasm | default-src \'self\'; script-src \'self\' \'unsafe-inline\' blob: https:; style-src \'self\' \'unsafe-inline\' https:; worker-src \'self\' blob:; img-src \* data: blob:; media-src \* data: blob:; font-src \* data: https:; connect-src \'self\' wss: https:; frame-src \'self\' blob: https:; object-src \'none\' |
