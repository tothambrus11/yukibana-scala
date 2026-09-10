export { ScalaEngine } from "./client.js";
export {
  ScalaToolchain,
  UnsupportedRuntimeError,
  missingWasmFeatures,
  findEntryPoints,
  selectEntryPoint,
} from "./toolchain.js";
export { VirtualFileSystem } from "./memory-fs.js";
export { parseDiagnostics } from "./diagnostics.js";
export { readZipEntries } from "./zip.js";
