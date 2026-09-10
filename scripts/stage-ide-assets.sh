#!/usr/bin/env bash
#
# Put the Scala toolchain where the built Theia frontend can fetch it.
#
# The ~62 MB distribution (compiler, classpath, runtime IR, and the host runtime that drives
# them) is deliberately not part of the webpack bundle: the frontend loads it at runtime from
# `./toolchain/`, so it can be upgraded - or served from a CDN - without rebuilding the IDE.
#
# Usage:
#   scripts/stage-ide-assets.sh           # symlink (fast, for development)
#   scripts/stage-ide-assets.sh --copy    # copy (for deployment)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="${FRONTEND:-$REPO_ROOT/packages/theia-app/lib/frontend}"
TOOLCHAIN="${TOOLCHAIN:-$REPO_ROOT/vendor/scala-toolchain-wasm}"
MODE="${1:-symlink}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$FRONTEND" ]] || die "no built frontend at $FRONTEND (run: npm run build:ide)"
[[ -f "$TOOLCHAIN/manifest.json" ]] || die "no toolchain at $TOOLCHAIN (run: scripts/fetch-toolchain.sh)"

rm -rf "$FRONTEND/toolchain"

if [[ "$MODE" == "--copy" ]]; then
  log "Copying the toolchain into $FRONTEND"
  cp -R "$TOOLCHAIN" "$FRONTEND/toolchain"
else
  log "Linking the toolchain into $FRONTEND"
  ln -s "$TOOLCHAIN" "$FRONTEND/toolchain"
fi

node -e '
const t = require(process.argv[1] + "/manifest.json").toolchain ?? {};
console.log(`    Scala ${t.scalaVersion}, Scala.js ${t.scalaJSVersion}, host ${t.hostVersion}`);
' "$TOOLCHAIN"
