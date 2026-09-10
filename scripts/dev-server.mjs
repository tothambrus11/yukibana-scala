/**
 * Static dev server for the playground.
 *
 * Serves the repository root so that the playground page can import the engine sources
 * directly (no bundler in the loop), with the MIME types WebAssembly streaming needs.
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const HOME = "/packages/playground/public/index.html";
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

    response.writeHead(200, {
      "Content-Type": TYPES[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": pathname.includes("/assets/") ? "public, max-age=31536000" : "no-cache",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain" }).end(`Not found: ${pathname}`);
  }
}).listen(PORT, () => {
  console.log(`Yukibana playground: http://localhost:${PORT}/`);
});
