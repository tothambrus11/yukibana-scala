# Yukibana

A fully client-side Scala IDE for the browser — like [ABI Explorer](https://abiexplorer.org)
("clang in your browser"), but for Scala.

Nothing is compiled on a server. The Scala 3 compiler itself runs in the browser as
WebAssembly, and the programs you write are linked to JavaScript/WebAssembly and executed
in the same tab.

```
   Scala source  ──▶  scalac (WebAssembly)  ──▶  .sjsir  ──▶  Scala.js linker (WebAssembly)  ──▶  JS / Wasm  ──▶  run
                      ^^^^^^^^^^^^^^^^^^^^                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                      both run in your browser, in a Web Worker
```

Your program can be linked to JavaScript or, like the compiler itself, to WebAssembly.

## Status

Early prototype. See [docs/architecture.md](docs/architecture.md) for the design and
[docs/build-pipeline.md](docs/build-pipeline.md) for how the WebAssembly toolchain is built.

| Stage | State |
| --- | --- |
| Scala 3 compiler → WebAssembly | works (via `scala3-compiler-sjs`, verified in Chromium 141) |
| Reproducible from-source build of the toolchain | works (`scripts/build-compiler-assets.sh`, ~16 min) |
| Compile + link + run in-browser | works, multi-file |
| **JavaScript output** for user programs | works |
| **WebAssembly output** for user programs | works (our `linkScalaJSWasmAsync` bridge) |
| End-to-end browser tests | works (7 cases, headless Chromium) |
| Theia IDE shell (browser-only) | next |
| Interactive stdin, incremental compilation | planned |
| Macro support | blocked upstream |

Measured in headless Chromium 141 on a 4-core container: compile 3-9 s, link 2-10 s, run
under 40 ms. A hello-world program links to a 153 KB `main.wasm`.

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/scala-engine/` | Framework-agnostic in-browser Scala toolchain (memory FS, compile, link, run) |
| `packages/playground/` | Minimal static host page used to develop and test the engine |
| `scripts/` | Toolchain build + dev server scripts |
| `e2e/` | Playwright tests that drive a real browser |
| `docs/` | Research notes, architecture, build pipeline |

## Quick start

```bash
# 1. Build (or fetch) the WebAssembly Scala toolchain assets — this is the slow part
./scripts/build-compiler-assets.sh

# 2. Serve the playground
node scripts/dev-server.mjs

# 3. Open http://localhost:8080
```

A browser with WebAssembly JSPI is required (Chrome/Edge 137+, or Chromium with
`--enable-experimental-webassembly-features`).
