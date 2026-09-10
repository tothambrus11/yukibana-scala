# Third-party components

Yukibana builds on existing open-source work. The in-browser toolchain is not compiled from
this repository's sources; it is produced by `scripts/build-compiler-assets.sh` from:

- **Scala 3 (dotty)** — Apache License 2.0, <https://github.com/scala/scala3>
- **`scala3-compiler-sjs`** — a research fork of dotty that cross-compiles the compiler with
  Scala.js and links it to WebAssembly, Apache License 2.0,
  <https://github.com/pgilliar/scala3-compiler-sjs>
- **Scala.js**, including the linker that the compiler bundle embeds — Apache License 2.0,
  <https://github.com/scala-js/scala-js>

The generated assets (`main.wasm`, the classpath jars, the runtime IR bundle) carry the
licenses of those projects. They are build outputs and are not committed to this repository.

The design of the browser host (worker protocol, memory file system, JSZip-compatible
adapter) in `packages/scala-engine/` was written for this project, informed by the reference
`compiler/browser-ide` demo in the fork above.
