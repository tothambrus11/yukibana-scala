# The WebAssembly build pipeline

How the in-browser Scala toolchain is produced, and what the resulting assets are.

## Two pipelines, not one

It helps to keep these separate:

1. **Build-time (this document).** On a normal JVM machine, cross-compile the Scala 3 compiler
   with Scala.js and link it to WebAssembly. Runs once, produces static assets.
2. **Run-time (in the browser).** Those assets compile and link *the user's* Scala code.
   See [architecture.md](architecture.md).

## Build-time

```
dotty sources ──sbt──▶ scala3-compiler-sjs (Scala.js classes)
                          │  + org.scala-js:scalajs-linker (published for Scala.js)
                          ▼
                 Scala.js linker (JVM, Wasm backend)
                          │
                          ▼
              main.wasm + main.js + __loader.js
                          +
              rt.jar, scala-lib.jar, scalajs-lib.jar, runtime-sjsir.zip
```

Run it with:

```bash
scripts/build-compiler-assets.sh
```

The script pins a commit of the `scala3-compiler-sjs` fork, copies our own compiler-side
sources from `toolchain/src-sjs/` into its `compiler/src-sjs/`, runs the
`scala3-compiler-sjs/prepareBrowserIDE` sbt task, and stages the output under
`packages/playground/public/assets/` with a manifest describing it.

Adding sources rather than patching means the fork can move without merge conflicts. Today
that is `WasmLinkerBridge.scala`, which exports `linkScalaJSWasmAsync` so user programs can be
linked to WebAssembly; it added 8.5 KB to `main.wasm` and 51 s to an incremental rebuild.

### Requirements

| Tool | Version used | Notes |
| --- | --- | --- |
| JDK | 21 | also the source of `rt.jar` (`java.base` extracted from `jrt:/`) |
| sbt | 1.11.7 | `SBT_OPTS=-Xmx10G -Xss8m` — dotty needs the heap and the stack |
| Node | 22 | the upstream task requires `jszip` for its own demo page |
| git | any | the checkout is ~1 GB with `--filter=blob:none` |

### Measured build

On a 4-core / 15 GB container:

| Stage | Cold caches | Warm ivy/coursier |
| --- | --- | --- |
| clone (blobless) + sbt bootstrap | ~2 min | ~1 min |
| compiler, tasty-core, libraries, `scala3-compiler-sjs`, fastLink to Wasm, asset packing | ~14 min | ~6 min |
| **total** | **~16 min** | **~8 min** |

Both runs exited 0, and the whole script has been verified from a clean `.build-cache`
(fresh clone of the pinned commit through to staged assets), after which the browser test
suites pass unchanged.

The `main.wasm` from a local build is the same size as the one the fork commits
(31,659,267 bytes before our linker bridge is added), which is a good sign the build is
reproducible across machines.

## The assets

| Path | Size | What it is |
| --- | --- | --- |
| `compiler/main.wasm` | 31 MB | Scala 3 compiler **and** Scala.js linker as one WasmGC module |
| `compiler/main.js` | 39 KB | Scala.js JS glue: imports, exports, JS-side intrinsics |
| `compiler/__loader.js` | 6 KB | instantiates the Wasm module |
| `classpath/rt.jar` | 15 MB | `java.base`, the JDK classpath the compiler type-checks against |
| `classpath/scala-lib.jar` | 8.8 MB | Scala 3 library (`.class` + `.tasty`), see below |
| `classpath/scalajs-lib.jar` | 1.1 MB | Scala.js library |
| `runtime/runtime-sjsir.zip` | 7.0 MB | runtime `.sjsir`, linked together with the user's IR |
| `vendor/*.js` | 8 KB | our JSZip-compatible shim (see below) |
| **total** | **~62 MB** | uncompressed |

`manifest.json` ties them together and records which fork commit produced them.

### Replacing the vendored JSZip

The compiler bundle reads classpath jars through a hard-coded import of
`../vendor/jszip-wrapper.js` and uses exactly five JSZip members
(`loadAsync`, `files`, `file`, `entry.async("uint8array")`, `entry.name/dir/date`).
Upstream satisfies that with a 370 KB copy of JSZip. We satisfy it with
`packages/scala-engine/src/jszip-compat.js`, ~90 lines over the platform's
`DecompressionStream("deflate-raw")`, which also makes entry reads lazy — worthwhile when
`rt.jar` is 15 MB and a program touches a few dozen classes.

### The compile-time library jar

The upstream task stages `scala-library-sjs/packageBin` as `scala-lib.jar`. On a clean build
that jar holds only `.sjsir` - Scala.js IR, not classfiles - and a compiler given it cannot
resolve `scala.Predef`, failing with `Not found: type Unit` on the simplest program. Our
script packages `target/scala3-compiler-sjs/node-libs/scala-lib` instead, the merged library
class directory (3,658 `.class` + 941 `.tasty`), which is what the upstream Node-hosted test
uses. The script fails loudly if that directory does not contain `Predef.tasty`.

## Payload

WasmGC compresses very well, and the dev server (`scripts/dev-server.mjs`) gzips on the fly
and caches the result:

| Asset | Raw | Over the wire (gzip) |
| --- | --- | --- |
| `compiler/main.wasm` | 31 MB | **6.4 MB** |
| `classpath/rt.jar` | 15 MB | 15 MB (already deflated) |
| `classpath/scala-lib.jar` | 8.8 MB | 8.8 MB (already deflated) |
| `runtime/runtime-sjsir.zip` | 7.0 MB | 7.0 MB (already deflated) |
| first load, total | ~62 MB | **~38 MB** |

Remaining ideas, in rough order of expected value:

1. **Trim `rt.jar`** - now the largest single item. 15 MB of `java.base` where a browser
   program uses a fraction of it.
2. **Repack the jars.** They are stored deflated at a low level and are opaque to gzip;
   recompressing their entries (or shipping them as a single Brotli-compressed archive the
   engine unpacks) should cut the classpath substantially.
3. **Cache in the browser.** Cache API or OPFS, so a repeat visit costs nothing.
4. **`fullLinkJS`** for the compiler itself: it is currently `fastLinkJS`-linked, with no
   whole-program optimisation.
5. **Split the linker out** of the compiler module so a re-link does not need the compiler
   resident.

## Reproducing just the staging step

If the fork is already built somewhere:

```bash
SKIP_BUILD=1 CHECKOUT_DIR=/path/to/scala3-compiler-sjs scripts/build-compiler-assets.sh
```
