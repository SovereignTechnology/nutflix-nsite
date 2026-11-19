#!/usr/bin/env bash
# publish.sh: publish the pinned Nutflix web client as the publisher key's root nsite.
#   ./publish.sh --site-tar <nutflix-web-site-*.ustar.tar> --dry-run    offline: check, show, sign nothing
#   ./publish.sh --site-tar <nutflix-web-site-*.ustar.tar>              asks for a bunker:// URI (echo off),
#                                                                       then for the word "publish"
# The procedure, and where the tar comes from: README.md "Publishing". The flow: src/publish.mjs.
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
command -v node >/dev/null || { echo "publish.sh: needs node >= 22.22" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=22)?0:1)' \
    || { echo "publish.sh: needs node >= 22.22 (this is $(node -v))" >&2; exit 1; }
[ -d node_modules/nostr-tools ] || { echo "publish.sh: run 'npm ci --ignore-scripts' first" >&2; exit 1; }
exec node src/publish.mjs "$@"
