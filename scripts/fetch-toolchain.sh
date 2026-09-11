#!/usr/bin/env bash
#
# Fetch the Scala WebAssembly toolchain this IDE is built against.
#
# The toolchain lives in its own repository because building it needs a JDK, sbt and 8-16
# minutes: https://github.com/tothambrus11/scala-toolchain-wasm. Here we consume a release.
#
# Usage:
#   scripts/fetch-toolchain.sh                    # the pinned version, as built
#   scripts/fetch-toolchain.sh --compressed       # main.wasm stored gzipped (for static hosts
#                                                 # that cap files at 25 MiB, e.g. Cloudflare)
#   TOOLCHAIN_URL=... scripts/fetch-toolchain.sh  # an explicit tarball (URL or local path)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The toolchain release this IDE is pinned to. Bump deliberately: a new compiler can change
# behaviour, and the manifest inside records exactly what you got.
TOOLCHAIN_VERSION="${TOOLCHAIN_VERSION:-0.3.2}"
TOOLCHAIN_REPO="${TOOLCHAIN_REPO:-tothambrus11/scala-toolchain-wasm}"
TARGET_DIR="${TARGET_DIR:-$REPO_ROOT/vendor/scala-toolchain-wasm}"

variant=""
[[ "${1:-}" == "--compressed" ]] && variant="-compressed"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

name="scala-toolchain-wasm-${TOOLCHAIN_VERSION}${variant}.tar.gz"
url="${TOOLCHAIN_URL:-https://github.com/$TOOLCHAIN_REPO/releases/download/v$TOOLCHAIN_VERSION/$name}"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

if [[ -f "$url" ]]; then
  log "Using local tarball $url"
  cp "$url" "$staging/$name"
else
  log "Downloading $url"
  curl -fsSL --retry 3 -o "$staging/$name" "$url" ||
    die "could not download $name - check that release v$TOOLCHAIN_VERSION exists"

  # Checksums are published with the release; verify when we can reach them.
  if curl -fsSL --retry 2 -o "$staging/SHA256SUMS" \
    "https://github.com/$TOOLCHAIN_REPO/releases/download/v$TOOLCHAIN_VERSION/SHA256SUMS" 2>/dev/null; then
    expected=$(awk -v n="./$name" '$2 == n { print $1 }' "$staging/SHA256SUMS")
    actual=$(sha256sum "$staging/$name" | cut -d' ' -f1)
    [[ -z "$expected" || "$expected" == "$actual" ]] ||
      die "checksum mismatch for $name (expected $expected, got $actual)"
    [[ -n "$expected" ]] && log "Checksum verified"
  else
    printf '\033[1;33mwarning:\033[0m no SHA256SUMS published; skipping verification\n'
  fi
fi

log "Unpacking into $TARGET_DIR"
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
tar -xzf "$staging/$name" -C "$TARGET_DIR" --strip-components=1

[[ -f "$TARGET_DIR/manifest.json" ]] || die "tarball did not contain a manifest"
[[ -f "$TARGET_DIR/host/index.js" ]] || die "tarball did not contain the host runtime"

node -e '
const manifest = require(process.argv[1] + "/manifest.json");
const t = manifest.toolchain ?? {};
if (manifest.schema !== 1) {
  console.error(`error: manifest schema ${manifest.schema} is not supported by this IDE`);
  process.exit(1);
}
console.log(`    Scala ${t.scalaVersion}, Scala.js ${t.scalaJSVersion}, JDK ${t.buildJdk}, host ${t.hostVersion}`);
console.log(`    built ${t.builtAt} from ${t.ref?.slice(0, 12)}`);
' "$TARGET_DIR"
