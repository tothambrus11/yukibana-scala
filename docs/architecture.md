# Architecture

## Design goal

A Scala IDE that runs entirely in the browser tab: editing, compilation, linking and
execution. No compile server, no round trip, works offline once cached.

## The pipeline

```
 ┌─ Web Worker ─────────────────────────────────────────────────────────────┐
 │                                                                          │
 │  in-memory FS          scalac (WasmGC)            Scala.js linker        │
 │  ┌──────────┐          ┌───────────────┐          ┌──────────────┐       │
 │  │ /lib/*.jar│ ───────▶ │ dotty.tools   │ ──────▶  │ StandardImpl │ ────┐ │
 │  │ /src/*.scala        │ .dotc.MainJS  │  .sjsir  │ .linker(...) │     │ │
 │  └──────────┘          └───────────────┘          └──────────────┘     │ │
 │       ▲                        │                                       │ │
 │       └── rt.jar, scala-lib, scalajs-lib, runtime .sjsir               │ │
 └────────────────────────────────────────────────────────────────────────┼─┘
                                                                          │
                                  ES module: JavaScript *or* WebAssembly ─┘
                                                    │
                                                    ▼
                                       executed in a sandboxed context
```

Both tools live in **one** WebAssembly module: the fork cross-compiles dotty with Scala.js
and adds `org.scala-js:scalajs-linker` (published for Scala.js) as a dependency, exporting
two entry points to JavaScript:

| Export | Signature | Purpose |
| --- | --- | --- |
| `runScala3CompilerSJSAsync(args)` | `Promise<int>` | runs the compiler CLI; reads/writes the JS-hosted FS |
| `linkScalaJSAsync(irFiles, mainClass)` | `Promise<{jsFileName, code}>` | links to JavaScript, running `mainClass.main` on import |
| `linkScalaJSModuleAsync(irFiles)` | `Promise<{jsFileName, code}>` | links to JavaScript with no entry point |
| `linkScalaJSWasmAsync(irFiles, mainClass)` | `Promise<{jsFileName, files}>` | **ours** - links to WebAssembly, returning every emitted file |

`linkScalaJSWasmAsync` comes from `toolchain/src-sjs/yukibana/WasmLinkerBridge.scala`, which
the build copies into the fork before compiling, so the user's program can be WebAssembly
too. It returns all three emitted files (`main.js`, `__loader.js`, `main.wasm`) because
there is no directory in the browser to write them to.

### Executing linked output

A JavaScript link is one file: wrap it in a blob URL and `import()` it. A WebAssembly link is
three files that reference each other by relative name, and the emitted loader resolves the
`.wasm` against `import.meta.url` - which, inside a blob module, resolves to nothing useful.
So `module-loader.js` gives each supporting file its own blob URL (the `.wasm` blob typed
`application/wasm`, so `WebAssembly.instantiateStreaming` accepts it) and rewrites the entry
module's `"./name"` references to those URLs before importing it.

The compiler reaches the file system through a global, `globalThis.__scala3CompilerSJSHostFS`,
which the host supplies. It is a synchronous, Node-`fs`-shaped object
(`existsSync`, `statSync`, `readdirSync`, `readFileSync`, `mkdirSync`, `writeFileSync`,
`appendFileSync`, `rmSync`, `rmdirSync`, `unlinkSync`, `truncateSync`, `cwd`). That is the
whole contract between the browser host and the compiler — everything else is data.

## Layering

The engine is deliberately independent of any IDE framework, so that the same core can be
driven by the throwaway playground today and by Theia later.

```
scala-toolchain-wasm      a separate repository: the compiler, and the host runtime that drives it
        │  (consumed as a pinned release, unpacked into vendor/)
        ├── packages/playground      minimal static page (dev + e2e target)
        └── packages/theia-scala     the Theia extension, in packages/theia-app
```

Both the playground and the IDE import the **same** host runtime out of the distribution, so
they cannot disagree about how compilation works. See [toolchain.md](toolchain.md).

### Why Theia, and why "browser-only"

Theia supports a *browser-only* deployment: no Node backend, everything in the page. That is
the only Theia mode compatible with this project's no-server premise; it gives us a real
workbench (editors, layout, terminals, problems view, file explorer over an in-memory FS)
without a server component. The engine's worker becomes the "build task" and "run" backend
behind Theia's task API.

## Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | Compiler runs as **Scala.js/WasmGC**, not a JVM-in-Wasm | Only route that is open-source, buildable from source, and whose *output* also runs natively in the browser |
| 2 | Compiler and linker in **one module** | The linker is published for Scala.js; bundling avoids a second 10 MB+ download and a second runtime |
| 3 | Everything in a **Web Worker** | A 31 MB WasmGC module and a multi-second compile must not block the UI thread |
| 4 | The engine lives **in the toolchain repository** | It exists to implement the compiler bundle's contracts, so it versions with the bundle, not with the IDE |
| 5 | User program execution will move to a **sandboxed iframe** | Today the linked module is imported into the compiler worker, so user code shares a realm with the toolchain |
| 6 | Our compiler-side code is **added, not patched** | `toolchain/src-sjs/` is copied into the fork checkout, so the fork can move without conflicts |

## Known risks

- **Payload size.** ~60 MB of assets. Mitigations: Brotli (WasmGC compresses well), serving
  a trimmed `rt.jar`, `fullLinkJS` instead of `fastLinkJS` for the compiler, streaming
  compilation, and caching in the Cache API / OPFS.
- **JSPI dependence** limits browser support to Chrome/Edge 137+ today.
- **No macros** — this is upstream in the fork and affects real-world code more than it looks.
- **Fork maintenance.** `scala3-compiler-sjs` is a research fork tracking dotty; our build
  pins a commit and applies patches on top.
