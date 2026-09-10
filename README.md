# Yukibana

A fully client-side Scala IDE for the browser.

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

Early prototype. See [docs/architecture.md](docs/architecture.md) for the design. The compiler
itself is built and released from
[scala-toolchain-wasm](https://github.com/tothambrus11/scala-toolchain-wasm); this repository
consumes a pinned release of it.

| Stage | State |
| --- | --- |
| Scala 3 compiler → WebAssembly | works (via `scala3-compiler-sjs`, verified in Chromium 141) |
| Toolchain built and released separately | works ([scala-toolchain-wasm](https://github.com/tothambrus11/scala-toolchain-wasm)) |
| Compile + link + run in-browser | works, multi-file |
| **JavaScript output** for user programs | works |
| **WebAssembly output** for user programs | works (our `linkScalaJSWasmAsync` bridge) |
| End-to-end browser tests | works (7 cases, headless Chromium) |
| Theia IDE shell (browser-only) | works: run/compile commands, Problems, Output, Scala syntax |
| Static deployment (Cloudflare) | works: 36 files, 75 MB, within the 25 MiB per-file limit |
| Interactive stdin, incremental compilation | planned |
| Macro support | blocked upstream |

Measured in headless Chromium 141 on a 4-core container: compile 3-9 s, link 2-10 s, run
under 40 ms. A hello-world program links to a 153 KB `main.wasm`. First load pulls the
toolchain once: 62 MB raw, ~38 MB gzipped (the 31 MB compiler module compresses to 6.4 MB).

## Repository layout

| Path | Purpose |
| --- | --- |
| `packages/theia-app/` | The browser-only Theia IDE (no backend) |
| `packages/theia-scala/` | Theia extension: commands, diagnostics, output, status bar |
| `packages/playground/` | Minimal static page used to develop and test against the toolchain |
| `vendor/scala-toolchain-wasm/` | The pinned toolchain release (fetched, gitignored) |
| `scripts/` | Toolchain fetch, staging, deploy build, dev server |
| `e2e/` | Playwright tests that drive a real browser |
| `docs/` | Research, architecture, build pipeline, IDE |

## Quick start

Everything starts with the toolchain, downloaded as a pinned release:

```bash
npm install
./scripts/fetch-toolchain.sh
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

**Deploy** (Cloudflare Pages or Workers - see [docs/deploy.md](docs/deploy.md)):

```bash
npm run build:cloudflare     # fetches the toolchain if needed -> dist/cloudflare
npx wrangler deploy
```

Pushing to `main` deploys automatically: the Cloudflare app builds the repository directly.
See [docs/deploy.md](docs/deploy.md) for the exact build settings.

**Tests:**

```bash
npm run test:e2e             # engine, in headless Chromium
npm run test:ide             # the built IDE, in headless Chromium
```

A browser with WebAssembly JSPI is required (Chrome/Edge 137+, or Chromium with
`--enable-experimental-webassembly-features`).

## Documentation

- [docs/architecture.md](docs/architecture.md) — how the pieces fit together
- [docs/toolchain.md](docs/toolchain.md) — consuming, pinning and upgrading the toolchain
- [docs/ide.md](docs/ide.md) — the Theia workbench and its extension
- [docs/deploy.md](docs/deploy.md) — deploying to Cloudflare Pages / Workers
- [docs/research.md](docs/research.md) — prior art, and why this approach
