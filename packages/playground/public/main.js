import { ScalaEngine } from "/vendor/scala-toolchain-wasm/host/index.js";

const SAMPLE = `@main def hello(): Unit =
  val squares = (1 to 5).map(n => n * n)
  println(s"squares: \${squares.mkString(", ")}")
  println(s"sum = \${squares.sum}")
`;

const sourceEl = document.getElementById("source");
const runButton = document.getElementById("run");
const outputEl = document.getElementById("output");
const statusEl = document.getElementById("status");
const diagnosticsEl = document.getElementById("diagnostics");
const timingsEl = document.getElementById("timings");
const targetEl = document.getElementById("target");

sourceEl.value = SAMPLE;

// The toolchain is a pinned release of scala-toolchain-wasm, fetched into vendor/ by
// scripts/fetch-toolchain.sh - the same distribution the IDE ships.
const engine = new ScalaEngine({
  workerUrl: new URL("/vendor/scala-toolchain-wasm/host/worker.js", location.origin),
  manifestUrl: new URL("/vendor/scala-toolchain-wasm/manifest.json", location.origin).href,
});

const STAGES = {
  manifest: "Reading manifest...",
  classpath: "Downloading classpath...",
  compiler: "Loading compiler (31 MB WebAssembly)...",
  ready: "Toolchain ready",
  compiling: "Compiling...",
  macros: "Preparing macro support (one-off, about a minute)...",
  linking: "Linking...",
  running: "Running...",
};

function setStatus(text, state = "loading") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

function renderDiagnostics(diagnostics = []) {
  diagnosticsEl.replaceChildren(
    ...diagnostics.map((diagnostic) => {
      const item = document.createElement("li");
      item.dataset.severity = diagnostic.severity;

      const where = document.createElement("div");
      where.className = "where";
      const location = diagnostic.file
        ? `${diagnostic.file.replace("/workspace/", "")}:${diagnostic.line}:${diagnostic.column}`
        : "";
      where.textContent = [diagnostic.severity, diagnostic.code, location].filter(Boolean).join(" ");

      const message = document.createElement("div");
      message.textContent = diagnostic.message;

      item.append(where, message);
      return item;
    }),
  );
}

function renderTimings(result) {
  const parts = [];
  if (result.compileMs != null) parts.push(`compile ${Math.round(result.compileMs)} ms`);
  if (result.linkMs != null) parts.push(`link ${Math.round(result.linkMs)} ms`);
  if (result.runMs != null) parts.push(`run ${Math.round(result.runMs)} ms`);
  if (result.irFileCount != null) parts.push(`${result.irFileCount} IR files`);
  if (result.linkedBytes != null) {
    const kind = result.target === "wasm" ? "WebAssembly" : "JavaScript";
    parts.push(`${(result.linkedBytes / 1024).toFixed(1)} KB linked ${kind}`);
  }
  if (result.linkedFiles) {
    parts.push(result.linkedFiles.map((file) => `${file.name} ${(file.size / 1024).toFixed(1)} KB`).join(", "));
  }
  timingsEl.textContent = parts.join(" | ");
}

engine.on("progress", ({ stage }) => setStatus(STAGES[stage] ?? stage, stage === "ready" ? "ready" : "loading"));

async function run() {
  runButton.disabled = true;
  outputEl.textContent = "";
  diagnosticsEl.replaceChildren();
  timingsEl.textContent = "";

  try {
    const result = await engine.run({ "Main.scala": sourceEl.value }, { target: targetEl.value });
    renderDiagnostics(result.diagnostics);
    renderTimings(result);

    if (!result.ok) {
      outputEl.textContent = result.compilerOutput || "Compilation failed.";
      setStatus(`${result.errorCount} error(s)`, "error");
    } else if (!result.ran) {
      outputEl.textContent = result.error ?? "Nothing to run.";
      setStatus("Nothing to run", "error");
    } else {
      outputEl.textContent = result.output || "(no output)";
      setStatus("Done", "ready");
    }
  } catch (error) {
    outputEl.textContent =
      [
        `${error.name ?? "Error"}: ${error.message ?? ""}`.trim(),
        error.detail?.length ? `fields: ${error.detail.join(", ")}` : null,
        error.stack,
      ]
        .filter(Boolean)
        .join("\n\n") || "Engine failed with an empty error.";
    setStatus("Failed", "error");
  } finally {
    runButton.disabled = false;
    document.body.dataset.busy = "false";
  }
}

runButton.addEventListener("click", run);
sourceEl.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    run();
  }
});

engine
  .init()
  .then((info) => {
    if (!info.supportsWasmTarget) {
      targetEl.querySelector('option[value="wasm"]').disabled = true;
      targetEl.title = "This toolchain build cannot link to WebAssembly";
    }
    setStatus("Toolchain ready", "ready");
    runButton.disabled = false;
    document.body.dataset.ready = "true";

    // Warm the compiler and linker in the background so the first Run is not the slow one.
    engine.warmUp(targetEl.value).catch(() => undefined);
  })
  .catch((error) => {
    setStatus("Toolchain failed to load", "error");
    outputEl.textContent = error.message;
    document.body.dataset.ready = "false";
  });
