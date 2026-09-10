#!/usr/bin/env bash
#
# Assemble a static site for Cloudflare Pages / Workers static assets.
#
# Two host limits shape this script (identical for Pages and Workers):
#   - 25 MiB per file. `main.wasm` is 31 MB, so it is stored gzipped (6.1 MB) and the engine
#     decompresses it in the browser - `Content-Encoding` set through `_headers` is stripped
#     by Cloudflare, so labelling a pre-compressed file does not work.
#   - 20,000 files (100,000 on paid plans). We are far below that.
#
# Source maps are excluded: they are 40 MB+ each and would fail the upload.
#
# Usage:
#   scripts/build-cloudflare.sh                    # build from local toolchain assets
#   TOOLCHAIN_URL=https://... scripts/build-cloudflare.sh   # fetch prebuilt assets first
#   OUTPUT_DIR=... scripts/build-cloudflare.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/dist/cloudflare}"
FRONTEND="$REPO_ROOT/packages/theia-app/lib/frontend"
ENGINE_SRC="$REPO_ROOT/packages/scala-engine/src"
TOOLCHAIN_ASSETS="${TOOLCHAIN_ASSETS:-$REPO_ROOT/packages/playground/public/assets}"
MODE="${MODE:-production}"

# Cloudflare rejects anything larger; stay under it with a margin.
MAX_FILE_BYTES=$((25 * 1024 * 1024))
WARN_FILE_BYTES=$((24 * 1024 * 1024))

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# A CI builder has no JVM and no 16 minutes to spare, so the toolchain can come prebuilt.
if [[ -n "${TOOLCHAIN_URL:-}" && ! -f "$TOOLCHAIN_ASSETS/compiler/main.wasm" ]]; then
  log "Fetching prebuilt toolchain from $TOOLCHAIN_URL"
  mkdir -p "$TOOLCHAIN_ASSETS"
  curl -fsSL "$TOOLCHAIN_URL" | tar -xz -C "$(dirname "$TOOLCHAIN_ASSETS")"
fi

[[ -f "$TOOLCHAIN_ASSETS/compiler/main.wasm" ]] ||
  die "no toolchain at $TOOLCHAIN_ASSETS - run scripts/build-compiler-assets.sh or set TOOLCHAIN_URL"

log "Building the Theia extension"
npm --prefix "$REPO_ROOT" run build --workspace @yukibana/theia-scala

# scripts/stage-ide-assets.sh symlinks the engine and the toolchain into the frontend for
# development. A production build compresses everything it finds there, and would follow
# those symlinks and litter .gz files through the source tree.
rm -rf "$FRONTEND/scala-engine" "$FRONTEND/assets"

log "Bundling the frontend (mode: $MODE)"
(cd "$REPO_ROOT/packages/theia-app" && npx theia build --mode "$MODE")

log "Assembling $OUTPUT_DIR"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# The frontend, minus source maps (40 MB+ each, and useless to a visitor).
(cd "$FRONTEND" && find . -type f ! -name '*.map' ! -name '*.map.gz' -print0 | tar --null -cf - -T -) |
  tar -xf - -C "$OUTPUT_DIR"

# The engine is fetched at runtime, not bundled - same code the playground runs.
mkdir -p "$OUTPUT_DIR/scala-engine"
cp "$ENGINE_SRC"/*.js "$OUTPUT_DIR/scala-engine/"

log "Staging the toolchain"
mkdir -p "$OUTPUT_DIR/assets/compiler" "$OUTPUT_DIR/assets/classpath" "$OUTPUT_DIR/assets/runtime" "$OUTPUT_DIR/assets/vendor"
cp "$TOOLCHAIN_ASSETS"/compiler/main.js "$TOOLCHAIN_ASSETS"/compiler/__loader.js "$OUTPUT_DIR/assets/compiler/"
cp "$TOOLCHAIN_ASSETS"/classpath/*.jar "$OUTPUT_DIR/assets/classpath/"
cp "$TOOLCHAIN_ASSETS"/runtime/runtime-sjsir.zip "$OUTPUT_DIR/assets/runtime/"
cp "$TOOLCHAIN_ASSETS"/vendor/*.js "$OUTPUT_DIR/assets/vendor/"

log "Compressing the compiler module (over the 25 MiB per-file limit uncompressed)"
gzip -9 -c "$TOOLCHAIN_ASSETS/compiler/main.wasm" > "$OUTPUT_DIR/assets/compiler/main.wasm.gz"

# Record the substitution so the engine knows to decompress it in the browser.
node - "$TOOLCHAIN_ASSETS/manifest.json" "$OUTPUT_DIR/assets/manifest.json" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [, , source, destination] = process.argv;
const manifest = JSON.parse(readFileSync(source, "utf8"));
manifest.compressed = {
  "./compiler/main.wasm": { url: "./compiler/main.wasm.gz", encoding: "gzip" },
};
writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

cat > "$OUTPUT_DIR/_headers" <<'HEADERS'
# The toolchain is content-addressed by its build: safe to cache forever.
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/scala-engine/*
  Cache-Control: public, max-age=3600

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
    printf '\033[1;31m  too large (%.1f MiB): %s\033[0m\n' "$(bc -l <<<"$size/1048576")" "${file#$OUTPUT_DIR/}"
    oversized=1
  elif (( size >= WARN_FILE_BYTES )); then
    printf '\033[1;33m  close to the limit (%.1f MiB): %s\033[0m\n' "$(bc -l <<<"$size/1048576")" "${file#$OUTPUT_DIR/}"
  fi
done < <(find "$OUTPUT_DIR" -type f -print0)
(( oversized == 0 )) || die "some files exceed Cloudflare's 25 MiB per-file limit"

files=$(find "$OUTPUT_DIR" -type f | wc -l)
(( files < 20000 )) || die "$files files exceeds the 20,000 file limit of the free plan"

log "Ready to deploy: $OUTPUT_DIR"
printf '  %s files, %s total\n' "$files" "$(du -sh "$OUTPUT_DIR" | cut -f1)"
printf '  largest:\n'
find "$OUTPUT_DIR" -type f -printf '%s\t%p\n' | sort -rn | head -6 |
  awk -v root="$OUTPUT_DIR/" '{ sub(root, "", $2); printf "    %6.1f MiB  %s\n", $1/1048576, $2 }'
