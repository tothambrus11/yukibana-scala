/**
 * Worker entry point for the Scala engine.
 *
 * The compiler is a 31 MB WebAssembly module and a build takes seconds, so everything
 * happens off the UI thread. The protocol is request/response with `id` correlation, plus
 * unsolicited `progress` and `stdout` events.
 *
 * Requests:  {id, type: "init" | "compile" | "run", ...}
 * Responses: {id, type: "result", value} | {id, type: "error", error}
 * Events:    {type: "progress", stage} | {id, type: "stdout", chunk}
 */
import { ScalaToolchain, captureConsole } from "./toolchain.js";

let toolchainPromise = null;
let manifestUrl = "./assets/manifest.json";

function post(message) {
  self.postMessage(message);
}

/**
 * Errors crossing the Wasm boundary are not always `Error`s: Scala.js can throw a wrapped
 * Scala exception, and objects with a null prototype make even `String(value)` throw. Be
 * careful here, or a real failure is replaced by a confusing one.
 */
function describeError(error) {
  const text = (value) => {
    try {
      return String(value);
    } catch {
      try {
        return JSON.stringify(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    }
  };

  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof error?.getMessage === "function"
        ? text(error.getMessage())
        : text(error);

  return {
    name: typeof error?.name === "string" ? error.name : error?.constructor?.name ?? "Error",
    message,
    stack: typeof error?.stack === "string" ? error.stack : null,
    detail: error && typeof error === "object" ? Object.keys(error).slice(0, 20) : null,
    missing: error?.missing ?? null,
  };
}

function toolchain() {
  if (!toolchainPromise) {
    toolchainPromise = ScalaToolchain.load({
      manifestUrl,
      onProgress: (stage, detail) => post({ type: "progress", stage, detail }),
    });
  }
  return toolchainPromise;
}

/** Import the linked module; a linker main initializer means importing it runs the program. */
async function execute(code, id) {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  const started = performance.now();
  try {
    const { lines } = await captureConsole(async () => {
      const module = await import(url);
      // Give any queued microtasks (Scala.js schedules through them) a chance to drain.
      await Promise.resolve();
      return module;
    });
    for (const line of lines) post({ id, type: "stdout", chunk: line });
    return { output: lines.join("\n"), durationMs: performance.now() - started };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const handlers = {
  async init(request) {
    if (request.manifestUrl) manifestUrl = request.manifestUrl;
    await toolchain();
    return { ready: true };
  },

  async compile(request) {
    const tools = await toolchain();
    post({ type: "progress", stage: "compiling" });
    const compilation = await tools.compile(request.files, { options: request.options });
    return summarizeCompilation(compilation);
  },

  async run(request) {
    const tools = await toolchain();

    post({ type: "progress", stage: "compiling" });
    const compilation = await tools.compile(request.files, { options: request.options });
    const summary = summarizeCompilation(compilation);
    if (!compilation.ok) return { ...summary, ran: false };

    const entry = request.mainClass ?? compilation.entryPoints[0]?.mainClass;
    if (!entry) {
      return {
        ...summary,
        ran: false,
        error: "No runnable entry point found. Define `object Main` or a top-level `@main` method.",
      };
    }

    post({ type: "progress", stage: "linking" });
    const link = await tools.link(compilation.irFiles, { mainClass: entry });

    post({ type: "progress", stage: "running" });
    const execution = await execute(link.code, request.id);

    return {
      ...summary,
      ran: true,
      mainClass: entry,
      linkMs: link.durationMs,
      linkedBytes: link.code.length,
      output: execution.output,
      runMs: execution.durationMs,
    };
  },
};

function summarizeCompilation(compilation) {
  return {
    ok: compilation.ok,
    exitCode: compilation.exitCode,
    diagnostics: compilation.diagnostics,
    errorCount: compilation.errorCount,
    warningCount: compilation.warningCount,
    compilerOutput: compilation.output,
    entryPoints: compilation.entryPoints,
    irFileCount: compilation.irFiles.length,
    compileMs: compilation.durationMs,
  };
}

self.addEventListener("message", async (event) => {
  const request = event.data ?? {};
  const handler = handlers[request.type];
  if (!handler) {
    post({ id: request.id, type: "error", error: describeError(new Error(`Unknown request: ${request.type}`)) });
    return;
  }

  try {
    post({ id: request.id, type: "result", value: await handler(request) });
  } catch (error) {
    post({ id: request.id, type: "error", error: describeError(error) });
  }
});
