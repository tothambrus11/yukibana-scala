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
MODE="${1:-symlink}"   # --copy for deployment, otherwise a symlink

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$FRONTEND" ]] || die "no built frontend at $FRONTEND (run: npm run build:ide)"
[[ -f "$TOOLCHAIN/manifest.json" ]] || die "no toolchain at $TOOLCHAIN (run: scripts/fetch-toolchain.sh)"

if [[ "$MODE" == "--copy" ]]; then
  log "Copying the toolchain into $FRONTEND"
else
  log "Linking the toolchain into $FRONTEND"
fi

# Staged under a name derived from its content, with a small `current.json` pointing at it,
# so a cached copy of an older release can never answer for this one. See stage-toolchain.mjs.
node "$REPO_ROOT/scripts/stage-toolchain.mjs" "$TOOLCHAIN" "$FRONTEND/toolchain" "$MODE"
