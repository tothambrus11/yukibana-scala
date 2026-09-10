# Deploying to Cloudflare

The whole product is static files, so it fits Cloudflare Pages or Workers static assets
directly. Two platform limits shape the build, and both are identical for Pages and Workers:

| Limit | Value | What it means here |
| --- | --- | --- |
| Per-file size | **25 MiB** | `main.wasm` is 31 MB and **cannot be uploaded as-is** |
| Files per deployment | 20,000 free / 100,000 paid | we ship 36 |
| Build timeout (Pages CI) | 20 minutes | too tight to build the Scala toolchain there |

`scripts/build-cloudflare.sh` handles all three. It fails loudly if any file crosses the
size limit, so a bad deploy is caught before upload rather than after.

## Settings

| Setting | Value |
| --- | --- |
| Framework preset | **None** |
| Root directory | `/` (the repository root) |
| Build command | `npm ci && npm run build:cloudflare` |
| Build output directory | **`dist/cloudflare`** |
| Environment variables | `NODE_VERSION=22`, and `TOOLCHAIN_URL` (see below) |

For Workers instead of Pages, `wrangler.jsonc` is already in the repo:

```bash
npm run build:cloudflare
npx wrangler deploy          # or: npm run deploy:cloudflare
```

## The one thing that needs planning: the toolchain

The 62 MB WebAssembly toolchain is built by `scripts/build-compiler-assets.sh`, which needs a
**JDK and sbt** and takes 8-16 minutes. Cloudflare's build image has neither, and the build
would be uncomfortably close to the 20-minute timeout anyway. Pick one of these:

### Direct upload (simplest, recommended to start)

Build locally - where you already have the toolchain - and push the finished directory:

```bash
npm run build:cloudflare
npx wrangler pages deploy dist/cloudflare --project-name yukibana
# or, for Workers: npx wrangler deploy
```

No Cloudflare build step is involved, so nothing can time out.

### Git-connected builds with a prebuilt toolchain

Publish the toolchain once as a tarball (a GitHub Release asset, or R2):

```bash
tar -czf yukibana-toolchain.tar.gz -C packages/playground/public assets
```

Then set `TOOLCHAIN_URL` in the Pages project to that URL. The build script downloads and
unpacks it when `packages/playground/public/assets` is absent, so Cloudflare only has to
bundle the frontend - about two minutes.

Rebuild and republish that tarball whenever the pinned compiler commit changes.

## What the build produces

```
dist/cloudflare/
  index.html, bundle.js, bundle.css, editor.worker.js, ...   the Theia frontend
  scala-engine/*.js                                          the compiler host
  assets/manifest.json                                       toolchain manifest
  assets/compiler/main.wasm.gz                               the compiler, gzipped
  assets/compiler/main.js, __loader.js
  assets/classpath/*.jar, assets/runtime/runtime-sjsir.zip
  _headers                                                   cache policy
```

36 files, ~75 MB stored, largest file 14.2 MiB.

### Why the compiler is stored gzipped

`main.wasm` is 31 MB, over the 25 MiB per-file limit. The usual workaround - upload it
pre-compressed and declare `Content-Encoding: gzip` in `_headers` - does not work on
Cloudflare, which strips that header and manages compression itself.

So the build stores `main.wasm.gz` (6.0 MiB) and records the substitution in the manifest:

```json
"compressed": { "./compiler/main.wasm": { "url": "./compiler/main.wasm.gz", "encoding": "gzip" } }
```

The compiler bundle's own loader asks for `main.wasm` and cannot be told otherwise, so the
engine installs a narrow `fetch` shim for exactly those URLs and pipes the response through
`DecompressionStream`. It stays streaming, so `WebAssembly.instantiateStreaming` still
compiles as bytes arrive. See `packages/scala-engine/src/compressed-assets.js`.

Source maps (40 MB+ each) are excluded from the deploy directory - they would fail the
upload, and the production bundle is 11.4 MB rather than the 23 MB development one.

## Headers and browser requirements

- **No COOP/COEP needed.** Nothing here uses `SharedArrayBuffer`.
- `.wasm` is served as `application/wasm` by Cloudflare automatically.
- `_headers` sets long-lived caching for `/assets/*` so a repeat visit re-downloads nothing.
- Visitors need **WebAssembly JSPI**: Chrome/Edge 137+. Other engines get a clear message
  naming the missing features rather than a broken page.

## Verifying a build before you ship it

The IDE test suite can run against the deploy directory instead of the dev build:

```bash
FRONTEND=dist/cloudflare node e2e/ide.mjs
```

That boots the exact bundle you are about to upload in headless Chromium, compiles and runs
Scala on both backends, and checks diagnostics - including the gzipped-compiler path, which
is only exercised in the deploy build.
