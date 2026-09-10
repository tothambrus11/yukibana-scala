#!/usr/bin/env bash
#
# Put the browser Scala engine and the WebAssembly toolchain where the built Theia frontend
# can fetch them.
#
# The engine and the ~62 MB of toolchain assets are deliberately not part of the webpack
# bundle: the frontend loads them at runtime from `./scala-engine/` and `./assets/`, so they
# can be replaced (or served from a CDN) without rebuilding the IDE.
#
# Usage:
#   scripts/stage-ide-assets.sh           # symlink (fast, for development)
#   scripts/stage-ide-assets.sh --copy    # copy (for deployment)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND="${FRONTEND:-$REPO_ROOT/packages/theia-app/lib/frontend}"
ENGINE_SRC="$REPO_ROOT/packages/scala-engine/src"
TOOLCHAIN_ASSETS="$REPO_ROOT/packages/playground/public/assets"
MODE="${1:-symlink}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$FRONTEND" ]] || die "no built frontend at $FRONTEND (run: npm run build:ide)"
[[ -d "$TOOLCHAIN_ASSETS" ]] || die "no toolchain assets at $TOOLCHAIN_ASSETS (run: scripts/build-compiler-assets.sh)"

rm -rf "$FRONTEND/scala-engine" "$FRONTEND/assets"

if [[ "$MODE" == "--copy" ]]; then
  log "Copying engine and toolchain into $FRONTEND"
  mkdir -p "$FRONTEND/scala-engine"
  cp "$ENGINE_SRC"/*.js "$FRONTEND/scala-engine/"
  cp -R "$TOOLCHAIN_ASSETS" "$FRONTEND/assets"
else
  log "Linking engine and toolchain into $FRONTEND"
  ln -s "$ENGINE_SRC" "$FRONTEND/scala-engine"
  ln -s "$TOOLCHAIN_ASSETS" "$FRONTEND/assets"
fi

log "Staged:"
printf '  %s\n' "$FRONTEND/scala-engine" "$FRONTEND/assets"
