#!/usr/bin/env bash
#
# Assemble a static site for Cloudflare Pages / Workers static assets.
#
# Two host limits shape this script (identical for Pages and Workers):
#   - 25 MiB per file. The uncompressed compiler module is 31 MB, so we deploy the toolchain's
#     `-compressed` release variant, which stores `main.wasm` gzipped (6 MB) and records the
#     substitution in its manifest; the host runtime decompresses it in the browser. Labelling
#     a pre-compressed file with `Content-Encoding` does not work here - Cloudflare strips that
#     header from `_headers`.
#   - 20,000 files (100,000 on paid plans). We are far below that.
#
# Source maps are excluded: they are 40 MB+ each and would fail the upload.
#
# Usage:
#   scripts/build-cloudflare.sh              # uses vendor/scala-toolchain-wasm
#   OUTPUT_DIR=... scripts/build-cloudflare.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/dist/cloudflare}"
FRONTEND="$REPO_ROOT/packages/theia-app/lib/frontend"
TOOLCHAIN="${TOOLCHAIN:-$REPO_ROOT/vendor/scala-toolchain-wasm}"
MODE="${MODE:-production}"

# Cloudflare rejects anything larger; stay under it with a margin.
MAX_FILE_BYTES=$((25 * 1024 * 1024))
WARN_FILE_BYTES=$((24 * 1024 * 1024))

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$TOOLCHAIN/manifest.json" ]] ||
  die "no toolchain at $TOOLCHAIN - run: scripts/fetch-toolchain.sh --compressed"

# Deploying the uncompressed variant would fail the upload, and only at the end of it.
if [[ ! -f "$TOOLCHAIN/compiler/main.wasm.gz" ]]; then
  die "this is the uncompressed toolchain; Cloudflare caps files at 25 MiB.
       Run: scripts/fetch-toolchain.sh --compressed"
fi

log "Building the Theia extension"
npm --prefix "$REPO_ROOT" run build --workspace @yukibana/theia-scala

# scripts/stage-ide-assets.sh symlinks the toolchain into the frontend for development. A
# production build compresses everything it finds there and would follow that symlink,
# littering .gz files through the vendored distribution.
rm -rf "$FRONTEND/toolchain"

log "Bundling the frontend (mode: $MODE)"
(cd "$REPO_ROOT/packages/theia-app" && npx theia build --mode "$MODE")

log "Assembling $OUTPUT_DIR"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# The frontend, minus source maps (40 MB+ each, and useless to a visitor).
(cd "$FRONTEND" && find . -type f ! -name '*.map' ! -name '*.map.gz' -print0 | tar --null -cf - -T -) |
  tar -xf - -C "$OUTPUT_DIR"

log "Staging the toolchain"
cp -R "$TOOLCHAIN" "$OUTPUT_DIR/toolchain"

cat > "$OUTPUT_DIR/_headers" <<'HEADERS'
# A toolchain release is immutable: safe to cache forever.
/toolchain/*
  Cache-Control: public, max-age=31536000, immutable

/*.js
  Cache-Control: public, max-age=3600

/index.html
  Cache-Control: no-cache
HEADERS

log "Checking Cloudflare limits"
oversized=0
while IFS= read -r -d '' file; do
  size=$(stat -c %s "$file")
  if (( size >= MAX_FILE_BYTES )); then
    printf '\033[1;31m  too large (%.1f MiB): %s\033[0m\n' "$(awk -v s="$size" 'BEGIN{print s/1048576}')" "${file#"$OUTPUT_DIR/"}"
    oversized=1
  elif (( size >= WARN_FILE_BYTES )); then
    printf '\033[1;33m  close to the limit (%.1f MiB): %s\033[0m\n' "$(awk -v s="$size" 'BEGIN{print s/1048576}')" "${file#"$OUTPUT_DIR/"}"
  fi
done < <(find "$OUTPUT_DIR" -type f -print0)
(( oversized == 0 )) || die "some files exceed Cloudflare's 25 MiB per-file limit"

files=$(find "$OUTPUT_DIR" -type f | wc -l)
(( files < 20000 )) || die "$files files exceeds the 20,000 file limit of the free plan"

log "Ready to deploy: $OUTPUT_DIR"
printf '  %s files, %s total, toolchain %s\n' \
  "$files" "$(du -sh "$OUTPUT_DIR" | cut -f1)" \
  "$(node -p "require('$TOOLCHAIN/manifest.json').toolchain.scalaVersion")"
printf '  largest:\n'
find "$OUTPUT_DIR" -type f -printf '%s\t%p\n' | sort -rn | head -6 |
  awk -v root="$OUTPUT_DIR/" '{ sub(root, "", $2); printf "    %6.1f MiB  %s\n", $1/1048576, $2 }'
