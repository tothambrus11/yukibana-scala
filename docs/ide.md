# The IDE

The workbench is [Eclipse Theia](https://theia-ide.org) built for its **browser-only** target:
a frontend with no Node backend, deployable as a static site. That is the only Theia mode
compatible with this project's premise, and it pairs naturally with a compiler that is itself
a static asset.

```
packages/theia-app      the browser-only Theia application (what you deploy)
packages/theia-scala    our Theia extension: commands, diagnostics, output, status
vendor/scala-toolchain-wasm   the pinned toolchain release, including its host runtime
```

## What the extension contributes

| Kind | Detail |
| --- | --- |
| Toolbar | a **Run** button and an **Autorun** checkbox, on the editor holding a `.scala` file |
| Commands | `Scala: Run`, `Scala: Run as JavaScript`, `Scala: Run as WebAssembly`, `Scala: Compile`, `Scala: Load Toolchain`, `Scala: Reload Toolchain` |
| Keybindings | `F5` to run, `Ctrl/Cmd+Shift+B` to compile |
| Output | program output and build timings in the **Output** view, channel `Scala` |
| Problems | compiler diagnostics as markers, with file/line/column, in the **Problems** view |
| Status bar | toolchain state: idle, loading, ready, compiling, failed |
| Preferences | `yukibana.outputTarget` (`js` or `wasm`), `yukibana.compileOnSave`, `yukibana.autoRun`, and the URLs of the engine and toolchain |
| First run | seeds `file:///workspace` with the example files below and opens `Main.scala` |

Sources are collected from the workspace, and unsaved editor content wins over what is on
disk, so Run reflects what you see without saving first.

### Running

**Run** compiles and runs, once. **Autorun** keeps doing it: every save re-runs the program,
and ticking the box runs it immediately rather than waiting for the next save. With Autorun
off, saving still compiles for diagnostics — squiggles without the program running — unless
`yukibana.compileOnSave` is off too.

Autorun's state lives in the contribution and is *mirrored* to the preference, not read from
it. A controlled checkbox has to change the moment it is clicked, and a preference write is
asynchronous and in a browser-only workbench may not land at all; reading it back made the box
tick and snap straight back.

### What the workspace starts with

Not a hello-world. The seeded files look like the first weeks of an undergraduate course, so
there is something to read and change:

| File | What it shows |
| --- | --- |
| `Shape.scala` | an `enum` ADT, exhaustive pattern matching, `map`/`sum`, `Option` via `maxByOption` |
| `Recursion.scala` | naive vs `@tailrec` recursion, accumulators, `BigInt` |
| `MiniTest.scala` | a thirty-line test framework: assertions, tolerance for doubles, a summary |
| `ShapeSpec.scala`, `RecursionSpec.scala` | tests for the above |
| `Main.scala` | prints a demo, then runs both suites |

The tests are hand-rolled because they have to be: nothing here reaches Maven Central, so
ScalaTest and munit are unavailable. Seeing a test framework be *this small* is arguably worth
the substitution.

## How the engine is loaded

The Theia frontend does **not** bundle the engine or the 62 MB toolchain. The extension
imports `./toolchain/host/index.js` at runtime and the engine fetches
`./toolchain/manifest.json` from there, both configurable through preferences.

That keeps webpack out of the picture for the parts that are plain ES modules and large
binaries, lets the toolchain be replaced (or served from a CDN) without rebuilding the IDE,
and means the playground and the IDE run *exactly* the same engine code.

The one subtlety: the dynamic `import()` is hidden from TypeScript and the bundler behind
`new Function`, because TypeScript would rewrite it to `require` under `module: commonjs` and
the bundler would try to resolve a path that only exists at runtime.

## Build and run

```bash
scripts/fetch-toolchain.sh          # once: download the pinned toolchain release
npm run build:ide                   # compile the extension, bundle the Theia frontend
scripts/stage-ide-assets.sh         # link the toolchain into the built frontend
ROOT=packages/theia-app/lib/frontend node scripts/dev-server.mjs
# http://localhost:8080
```

`scripts/stage-ide-assets.sh --copy` copies instead of linking, for deployment.

Tests: `node e2e/ide.mjs` boots the built IDE in headless Chromium, runs the seeded program
through the command palette on both backends, and checks that a type error reaches the
Problems view.

## Limitations today

- **No language server.** No completion, hover or go-to-definition yet. The natural next step
  is the Scala presentation compiler, which is in the same fork and could be exposed through
  the same Wasm module behind Theia's language client.
- **No debugger.**
- **Programs run in the compiler's worker**, so a runaway loop blocks further compilation. A
  sandboxed iframe per run is the fix.
- **No stdin.** `readLine` has nothing to read.
- **Macros are unsupported** by the underlying compiler build.
