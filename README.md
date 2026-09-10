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
| Theia IDE shell (browser-only) | works: run/compile commands, Problems, Output, Scala syntax |
| Interactive stdin, incremental compilation | planned |
| Macro support | blocked upstream |

Measured in headless Chromium 141 on a 4-core container: compile 3-9 s, link 2-10 s, run
under 40 ms. A hello-world program links to a 153 KB `main.wasm`. First load pulls the
toolchain once: 62 MB raw, ~38 MB gzipped (the 31 MB compiler module compresses to 6.4 MB).

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/scala-engine/` | Framework-agnostic in-browser Scala toolchain (memory FS, compile, link, run) |
| `packages/theia-app/` | The browser-only Theia IDE (no backend) |
| `packages/theia-scala/` | Theia extension: commands, diagnostics, output, status bar |
| `packages/playground/` | Minimal static host page used to develop and test the engine |
| `toolchain/src-sjs/` | Scala sources compiled *into* the WebAssembly toolchain (the Wasm linker bridge) |
| `scripts/` | Toolchain build, asset staging, dev server |
| `e2e/` | Playwright tests that drive a real browser |
| `docs/` | Research, architecture, build pipeline, IDE |

## Quick start

Everything starts with the toolchain, which is built once from source (~16 minutes):

```bash
npm install
./scripts/build-compiler-assets.sh
```

**The IDE:**

```bash
npm run build:ide
./scripts/stage-ide-assets.sh
ROOT=packages/theia-app/lib/frontend node scripts/dev-server.mjs   # http://localhost:8080
```

Press `F5` to run the open Scala file; the output appears in the Output view and compiler
errors in Problems. `Scala: Run as WebAssembly` links your program to Wasm instead of JS.

**The playground** (a minimal page used to develop and test the engine):

```bash
npm run start:playground     # http://localhost:8080
```

**Tests:**

```bash
npm run test:e2e             # engine, in headless Chromium
node e2e/ide.mjs             # the built IDE, in headless Chromium
```

A browser with WebAssembly JSPI is required (Chrome/Edge 137+, or Chromium with
`--enable-experimental-webassembly-features`).

## Documentation

- [docs/architecture.md](docs/architecture.md) — how the pieces fit together
- [docs/build-pipeline.md](docs/build-pipeline.md) — building the WebAssembly toolchain
- [docs/ide.md](docs/ide.md) — the Theia workbench and its extension
- [docs/research.md](docs/research.md) — prior art, and why this approach
