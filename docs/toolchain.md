# The toolchain

The Scala compiler this IDE runs is **not built here**. It lives in
[scala-toolchain-wasm](https://github.com/tothambrus11/scala-toolchain-wasm), because building
it needs a JDK, sbt and 8-16 minutes, and because it is useful on its own — the IDE is one
consumer of it, not its owner.

This repository consumes a pinned release.

## Fetching it

```bash
scripts/fetch-toolchain.sh              # the pinned version, as built
scripts/fetch-toolchain.sh --compressed # main.wasm stored gzipped, for Cloudflare
```

It downloads the release tarball, verifies it against the published `SHA256SUMS`, unpacks it
into `vendor/scala-toolchain-wasm/` (gitignored), refuses a manifest whose `schema` this IDE
does not understand, and prints what you got:

```
    Scala 3.8.3-RC3, Scala.js 1.20.2, JDK 21.0.10, host 0.2.1
    built 2026-09-10T16:19:00Z from 357051c857d4
```

The pinned version is `TOOLCHAIN_VERSION` at the top of the script. Bump it deliberately: a
new compiler can change behaviour even when nothing here changes.

## What we get from it

| Path | What |
| --- | --- |
| `manifest.json` | what the distribution is, and where its pieces are |
| `compiler/` | the Scala 3 compiler **and** the Scala.js linker as one WasmGC module |
| `classpath/` | `rt.jar`, `scala-lib.jar`, `scalajs-lib.jar` |
| `runtime/` | runtime `.sjsir`, linked with the user's program |
| `host/` | the browser runtime: virtual FS, worker protocol, diagnostics parsing |
| `vendor/` | the zip reader the compiler bundle imports by hard-coded path |

The **host runtime ships inside the distribution**, so it can never drift from the compiler
bundle whose contracts it implements. The playground and the IDE both import it from there,
which is why they cannot disagree about how compilation works.

## Warming it up

The first compile of a session scans the classpath and the first link parses the runtime IR -
several seconds, all one-off. Both the IDE and the playground call `engine.warmUp()` right
after loading, which does that work in the background on a throwaway program, so a user's
first Run costs the same as their tenth (~0.6 s compile, ~0.15 s link). Compiles are
serialised, so the warm-up cannot race a real one.

## How it is wired in

Nothing about the toolchain is bundled by webpack. The frontend fetches it at runtime:

| Preference | Default | Purpose |
| --- | --- | --- |
| `yukibana.toolchainManifest` | `./toolchain/manifest.json` | which distribution to load |
| `yukibana.engineModule` | `./toolchain/host/index.js` | the host runtime |
| `yukibana.engineWorker` | `./toolchain/host/worker.js` | the worker it spawns |

`scripts/stage-ide-assets.sh` puts the distribution at `./toolchain` in the built frontend —
a symlink for development, a copy (`--copy`) for deployment. Because the paths are
preferences, an instance can point at a CDN or an R2 bucket instead; URLs inside a manifest
resolve relative to it.

## Upgrading

```bash
TOOLCHAIN_VERSION=0.2.2 scripts/fetch-toolchain.sh   # try it
npm run test:e2e && npm run test:ide                 # prove it
```

Then edit `TOOLCHAIN_VERSION` in `scripts/fetch-toolchain.sh` and commit. The e2e suites are
the acceptance test for a toolchain upgrade — they compile and run real Scala on both
backends, which is exactly what a new compiler could break.

## Working on the toolchain itself

Clone the toolchain repository and point this one at a locally built tarball:

```bash
TOOLCHAIN_URL=../scala-toolchain-wasm/release/scala-toolchain-wasm-0.2.1.tar.gz \
  scripts/fetch-toolchain.sh
```

Its `docs/patches.md` documents every workaround the build carries — read that before
changing anything there; most of them look removable and are not.
