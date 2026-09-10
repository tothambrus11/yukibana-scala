# Prior art: running the Scala toolchain in a browser

Research notes for the Yukibana prototype. Everything marked **verified** was reproduced
locally in this repository's development environment (Chromium 141 headless, Node 22, JDK 21).

## The goal, restated

ABI Explorer runs `clang` in the browser: the compiler is a WebAssembly module, the user's
code never leaves the tab. For Scala we need two tools client-side, not one:

1. **scalac** (Scala 3 / dotty) — Scala source → Scala.js IR (`.sjsir`)
2. **the Scala.js linker** — `.sjsir` + runtime IR → an executable JavaScript or WebAssembly module

Only then can the result run in the browser.

## Candidate routes evaluated

| Route | Idea | Verdict |
| --- | --- | --- |
| **Scala.js (WasmGC backend)** | Cross-compile the compiler *itself* with Scala.js, emitting Wasm | **Chosen.** Works today. |
| CheerpJ | Run the stock scalac JAR on a WebAssembly JVM | Rejected: proprietary runtime, JDK 11-era class support, output is JVM bytecode that still cannot run natively in the browser |
| GraalVM Native Image → Wasm | `native-image` the compiler, Web Image backend | Rejected for now: experimental, heavyweight build, poor fit for a compiler that loads a classpath at runtime |
| Scala Native → Wasm | Compile via Scala Native's Wasm/Emscripten target | Rejected: Scala Native cannot build dotty; `shadaj/scala-native-wasm` is a stale experiment |
| Server-side compile (Scastie/ScalaFiddle model) | Send source to a JVM on a server | Rejected: contradicts the "no server" goal |

## Why Scala.js is the right substrate

- The **Scala.js WebAssembly backend** (WasmGC) shipped in Scala.js 1.17 and is considered
  stable and a drop-in replacement for the JS backend as of 1.22. Engine support: Chrome 137+,
  Firefox 134+, Safari 26+, Node 25+.
- The **Scala.js linker is published for Scala.js itself** — `org.scala-js:scalajs-linker_sjs1_2.13`
  exists on Maven Central (1.22.0 at time of writing). **Verified.** This is the load-bearing
  fact for the whole design: it means the linker can be bundled *into* the same in-browser
  compiler module, so the second half of the pipeline needs no server either.
- Scala 3 has first-class Scala.js support (`-scalajs`), so the same compiler binary that runs
  in the browser can emit Scala.js IR for user code.

## Existing effort: `scala3-compiler-sjs`

The key piece of prior art is a fork of the Scala 3 compiler that cross-compiles dotty with
Scala.js and links it with the Wasm backend:

- repo: `github.com/pgilliar/scala3-compiler-sjs`, branches `base-sjs-compiler`, `macro`, `browser`
- discussion: <https://contributors.scala-lang.org/t/scala-3-compiler-plugins-embedded-in-browser-with-wasm/7472>

The `browser` branch adds `compiler/browser-ide`, a minimal static page driven by a Web Worker,
and an sbt task `scala3-compiler-sjs/prepareBrowserIDE` that assembles the browser assets.

### What it produces

| Asset | Size | Role |
| --- | --- | --- |
| `assets/compiler/main.wasm` | 31 MB | the Scala 3 compiler + the Scala.js linker, as one WasmGC module |
| `assets/compiler/main.js`, `__loader.js` | 45 KB | Scala.js glue / loader for the Wasm module |
| `assets/classpath/rt.jar` | 13 MB | `java.base` extracted from the build JDK, used as the compile-time JDK classpath |
| `assets/classpath/scala-lib.jar` | 9.2 MB | Scala 3 library compiled for Scala.js |
| `assets/classpath/scalajs-lib.jar` | 1.1 MB | Scala.js library |
| `assets/runtime/runtime-sjsir.zip` | 6.8 MB | `.sjsir` of the runtime libraries, fed to the linker at link time |

Total ≈ 60 MB uncompressed. Size reduction is an open problem — see architecture notes.

### Verified behaviour

Serving that directory and driving it with headless Chromium 141:

- the compiler module loads and reports ready in ~1.5 s (assets served from localhost)
- compiling, linking and running a small Scala 3 program (`@main`, `Range.map`, `mkString`,
  `sum`) took **18.3 s** end to end on a 4-core container, and produced the correct output
- Chromium needs `--disable-dev-shm-usage` in a container, otherwise the renderer is killed
  while instantiating the 31 MB module

### Constraints inherited from that design

- **JSPI required.** The compiler bundle uses `WebAssembly.JSTag`, `WebAssembly.Suspending`
  and `WebAssembly.promising` (JavaScript Promise Integration) because the in-browser
  classpath/archive reads are asynchronous. Chrome/Edge 137+ have JSPI on by default.
- **No macros.** Macro expansion is unsupported in the Scala.js-hosted compiler; this is the
  most significant language-level gap (it also rules out most of the ecosystem's inline/derived code).
- **JS output only.** The bundled linker bridge is configured with `ModuleKind.ESModule` and
  no Wasm flag, so user programs currently link to JavaScript even though the *compiler*
  is WebAssembly. Enabling `withExperimentalUseWebAssembly(true)` in that bridge is a
  tractable next step.
- **Single source file, no incremental state**, and a crude stdin emulation that re-runs the
  whole program with accumulated input.

## Sources

- <https://contributors.scala-lang.org/t/scala-3-compiler-plugins-embedded-in-browser-with-wasm/7472>
- <https://www.scala-js.org/doc/project/webassembly.html>
- <https://scaladays.org/editions/2025/talks/compiling-scala-js-to-webassembly>
- <https://labs.leaningtech.com/blog/cheerpj-4.0>
- <https://github.com/shadaj/scala-native-wasm>
- <https://github.com/scalacenter/scastie>
