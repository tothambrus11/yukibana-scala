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

The script pins a commit of the `scala3-compiler-sjs` fork, runs its
`scala3-compiler-sjs/prepareBrowserIDE` sbt task, and stages the output under
`packages/playground/public/assets/` with a manifest describing it.

### Requirements

| Tool | Version used | Notes |
| --- | --- | --- |
| JDK | 21 | also the source of `rt.jar` (`java.base` extracted from `jrt:/`) |
| sbt | 1.11.7 | `SBT_OPTS=-Xmx10G -Xss8m` — dotty needs the heap and the stack |
| Node | 22 | the upstream task requires `jszip` for its own demo page |
| git | any | the checkout is ~1 GB with `--filter=blob:none` |

### Measured build

On a 4-core / 15 GB container, from a cold sbt cache:

| Stage | Time |
| --- | --- |
| clone (blobless) + sbt bootstrap | ~2 min |
| non-bootstrapped compiler, tasty-core, libraries, `scala3-compiler-sjs`, fastLinkJS to Wasm, asset packing | ~14 min |
| **total** | **~16 min**, exit 0 |

The resulting `main.wasm` was byte-for-byte the same size as the one the fork commits
(31,659,267 bytes), which is a good sign the build is deterministic across machines.

## The assets

| Path | Size | What it is |
| --- | --- | --- |
| `compiler/main.wasm` | 31 MB | Scala 3 compiler **and** Scala.js linker as one WasmGC module |
| `compiler/main.js` | 39 KB | Scala.js JS glue: imports, exports, JS-side intrinsics |
| `compiler/__loader.js` | 6 KB | instantiates the Wasm module |
| `classpath/rt.jar` | 15 MB | `java.base`, the JDK classpath the compiler type-checks against |
| `classpath/scala-lib.jar` | 5.2 MB | Scala 3 library, compiled for Scala.js |
| `classpath/scalajs-lib.jar` | 1.1 MB | Scala.js library |
| `runtime/runtime-sjsir.zip` | 7.0 MB | runtime `.sjsir`, linked together with the user's IR |
| `vendor/*.js` | 8 KB | our JSZip-compatible shim (see below) |
| **total** | **~58 MB** | uncompressed |

`manifest.json` ties them together and records which fork commit produced them.

### Replacing the vendored JSZip

The compiler bundle reads classpath jars through a hard-coded import of
`../vendor/jszip-wrapper.js` and uses exactly five JSZip members
(`loadAsync`, `files`, `file`, `entry.async("uint8array")`, `entry.name/dir/date`).
Upstream satisfies that with a 370 KB copy of JSZip. We satisfy it with
`packages/scala-engine/src/jszip-compat.js`, ~90 lines over the platform's
`DecompressionStream("deflate-raw")`, which also makes entry reads lazy — worthwhile when
`rt.jar` is 15 MB and a program touches a few dozen classes.

## Payload reduction (not yet done)

Ideas in rough order of expected value:

1. **Serve compressed.** WasmGC compresses well; Brotli should take `main.wasm` to a few MB.
   This is a server/CDN setting, not a build change.
2. **`fullLinkJS`.** The compiler is currently `fastLinkJS`-linked (no whole-program
   optimisation). A full link should cut the module substantially at the cost of build time.
3. **Trim `rt.jar`.** 15 MB of `java.base` where a browser program uses a fraction.
4. **Cache in the browser.** Cache API or OPFS so the 58 MB is a one-time cost per version.
5. **Split the linker out** of the compiler module so a re-run that only re-links does not
   need the compiler resident.

## Reproducing just the staging step

If the fork is already built somewhere:

```bash
SKIP_BUILD=1 CHECKOUT_DIR=/path/to/scala3-compiler-sjs scripts/build-compiler-assets.sh
```
