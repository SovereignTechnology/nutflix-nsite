#!/usr/bin/env bash
# Inside a networked throwaway Kata VM: pinned node + Playwright Chromium, then proof/playback.mjs on each URL.
#   laptop: kata-run --net --no-setup --timeout 2400 --max-wait 5400 -- bash proof/playback-vm.sh [--alpha-off] <https url>...
#   (--net runs on the home runner only: the LAN path to booty. A punch from outside the home NAT needs a
#   networked runner elsewhere, which kata-run does not offer yet.)
#
# --alpha-off  the drill (nutflix-nsite PIN gate, plan "Nutflix keeps working when alpha is unreachable"): two
#   passes of `playback.mjs --alphaoff`, alpha's names resolving to an unroutable address (connections hang, as in
#   the 2026-11-26 outage), then not resolving at all (--no-names). alpha is cut in the browser, which proves the
#   cut at the start of each run (the guest has no CAP_NET_ADMIN for a firewall: playback.mjs "How alpha is cut").
#   Each RUN line records the listing, the playback and whether any request to alpha got an answer (it must not).
# Refuses to run anywhere but the CI VM: it installs packages as root.
set -uo pipefail
[ "${GITLAB_CI:-}" = true ] && [ "$(id -u)" = 0 ] || { echo "playback-vm.sh runs only inside the kata-run job" >&2; exit 2; }
ALPHA_OFF=0
[ "${1:-}" = --alpha-off ] && { ALPHA_OFF=1; shift; }
[ $# -ge 1 ] || { echo "usage: playback-vm.sh [--alpha-off] <https url>..." >&2; exit 2; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
W=/var/tmp/playback; rm -rf "$W"; mkdir -p "$W/node" "$W/pw"
NODE_VERSION=22.23.4 NODE_SHA256=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
curl -sSfL --proto '=https' --tlsv1.2 --retry 5 -o "$W/node.tgz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz" || { echo "!! node download"; exit 1; }
echo "$NODE_SHA256  $W/node.tgz" | sha256sum -c --quiet - || { echo "!! node sha256"; exit 1; }
tar -xzf "$W/node.tgz" -C "$W/node" --strip-components=1 --no-same-owner
export PATH="$W/node/bin:$PATH"
cd "$W/pw" && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund --silent playwright@1.63.0 >/dev/null 2>&1 \
  && npx --no-install playwright install --with-deps chromium >/dev/null 2>&1 || { echo "!! playwright install"; exit 1; }
cp "$HERE/playback.mjs" "$W/pw/"

fail=0
for u in "$@"; do
  if [ "$ALPHA_OFF" = 1 ]; then
    echo "== $u (alpha off, names resolve)"
    node playback.mjs "$u" --cold 0 --settled 0 --nortc 0 --alphaoff "${PLAYBACK_ALPHAOFF:-2}" || fail=1
    echo "== $u (alpha off, names unresolvable)"
    node playback.mjs "$u" --cold 0 --settled 0 --nortc 0 --alphaoff "${PLAYBACK_ALPHAOFF:-2}" --no-names || fail=1
  else
    echo "== $u"
    node playback.mjs "$u" --cold "${PLAYBACK_COLD:-3}" --settled "${PLAYBACK_SETTLED:-2}" --nortc "${PLAYBACK_NORTC:-2}" || fail=1
  fi
done
echo "PLAYBACK_DONE fail=$fail"
exit $fail
