/**
 * Static dev server for the playground and the built IDE.
 *
 * Serves the repository root (so the playground can import the engine sources directly, no
 * bundler in the loop) or, with ROOT set, a built frontend. Two things matter here that a
 * generic static server would get wrong:
 *
 *   - WebAssembly streaming instantiation needs `application/wasm`
 *   - the toolchain is 62 MB uncompressed, and `main.wasm` alone goes 31 MB -> 6 MB with
 *     gzip, so responses are compressed and the result is cached in memory
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
// ROOT=packages/theia-app/lib/frontend serves the built IDE instead of the repository.
const ROOT = process.env.ROOT ? resolve(REPO_ROOT, process.env.ROOT) : REPO_ROOT;
const HOME = process.env.HOME_PATH ?? (process.env.ROOT ? "/index.html" : "/packages/playground/public/index.html");
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".jar": "application/java-archive",
  ".zip": "application/zip",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

// Jars and zips are already deflated; compressing them again only burns CPU.
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".wasm", ".map", ".svg"]);
const MAX_CACHED_BYTES = 512 * 1024 * 1024;

const compressed = new Map();
let cachedBytes = 0;

async function gzipCached(filePath, info) {
  const key = `${filePath}:${info.mtimeMs}:${info.size}`;
  const hit = compressed.get(key);
  if (hit) return hit;

  const body = await gzipAsync(await readFile(filePath), { level: 6 });
  if (cachedBytes + body.length <= MAX_CACHED_BYTES) {
    compressed.set(key, body);
    cachedBytes += body.length;
  }
  return body;
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === "/" ? HOME : decodeURIComponent(url.pathname);
  const filePath = join(ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      response.writeHead(302, { Location: `${pathname.replace(/\/$/, "")}/index.html` }).end();
      return;
    }

    const extension = extname(filePath);
    const headers = {
      "Content-Type": TYPES[extension] ?? "application/octet-stream",
      "Cache-Control": pathname.includes("/assets/") ? "public, max-age=31536000" : "no-cache",
    };

    const acceptsGzip = /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
    if (acceptsGzip && COMPRESSIBLE.has(extension)) {
      const body = await gzipCached(filePath, info);
      response.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": body.length });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    response.writeHead(200, { ...headers, "Content-Length": info.size });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" }).end(`Not found: ${pathname}`);
  }
}).listen(PORT, () => {
  console.log(`Yukibana serving ${ROOT} at http://localhost:${PORT}/`);
});
