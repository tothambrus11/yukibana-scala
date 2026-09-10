# The IDE

The workbench is [Eclipse Theia](https://theia-ide.org) built for its **browser-only** target:
a frontend with no Node backend, deployable as a static site. That is the only Theia mode
compatible with this project's premise, and it pairs naturally with a compiler that is itself
a static asset.

```
packages/theia-app      the browser-only Theia application (what you deploy)
packages/theia-scala    our Theia extension: commands, diagnostics, output, status
packages/scala-engine   the compiler host - loaded at runtime, not bundled
```

## What the extension contributes

| Kind | Detail |
| --- | --- |
| Commands | `Scala: Run`, `Scala: Run as JavaScript`, `Scala: Run as WebAssembly`, `Scala: Compile`, `Scala: Load Toolchain` |
| Keybindings | `F5` to run, `Ctrl/Cmd+Shift+B` to compile |
| Output | program output and build timings in the **Output** view, channel `Scala` |
| Problems | compiler diagnostics as markers, with file/line/column, in the **Problems** view |
| Status bar | toolchain state: idle, loading, ready, compiling, failed |
| Preferences | `yukibana.outputTarget` (`js` or `wasm`), `yukibana.compileOnSave`, and the URLs of the engine and toolchain |
| First run | seeds a `file:///workspace` folder with a sample `Main.scala` and opens it |

Sources are collected from the workspace, and unsaved editor content wins over what is on
disk, so Run reflects what you see without saving first.

## How the engine is loaded

The Theia frontend does **not** bundle the engine or the 62 MB toolchain. The extension
imports `./scala-engine/index.js` at runtime and the engine fetches `./assets/manifest.json`
from there, both configurable through preferences.

That keeps webpack out of the picture for the parts that are plain ES modules and large
binaries, lets the toolchain be replaced (or served from a CDN) without rebuilding the IDE,
and means the playground and the IDE run *exactly* the same engine code.

The one subtlety: the dynamic `import()` is hidden from TypeScript and the bundler behind
`new Function`, because TypeScript would rewrite it to `require` under `module: commonjs` and
the bundler would try to resolve a path that only exists at runtime.

## Build and run

```bash
scripts/build-compiler-assets.sh    # once: build the WebAssembly toolchain (~16 min)
npm run build:ide                   # compile the extension, bundle the Theia frontend
scripts/stage-ide-assets.sh         # link engine + toolchain into the built frontend
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
