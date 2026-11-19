#!/usr/bin/env bash
# verify.sh: check the published site on every gateway in gateways.txt (and its manifest on the
# relays), and rewrite gateways-status.md. Exit 0 if at least one gateway works.
#   ./verify.sh                                          the publisher key, every gateway
#   ./verify.sh --gateway 'https://{npub}.example.com/'  one gateway, ad hoc (gateways-status.md untouched)
#   ./verify.sh --npub <npub> --no-relays                another key; skip the relay check
# What "works" means: src/verify.mjs's header.
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
command -v node >/dev/null || { echo "verify.sh: needs node >= 22.22" >&2; exit 2; }
[ -d node_modules/nostr-tools ] || { echo "verify.sh: run 'npm ci --ignore-scripts' first" >&2; exit 2; }
exec node src/verify.mjs "$@"
