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
| Build command | `npm ci && ./scripts/fetch-toolchain.sh --compressed && npm run build:cloudflare` |
| Build output directory | **`dist/cloudflare`** |
| Environment variables | `NODE_VERSION=22`, and `TOOLCHAIN_URL` (see below) |

For Workers instead of Pages, `wrangler.jsonc` is already in the repo:

```bash
npm run build:cloudflare
npx wrangler deploy          # or: npm run deploy:cloudflare
```

## The toolchain is downloaded, not built

Building the compiler needs a JDK, sbt and 8-16 minutes, which does not fit Cloudflare's
20-minute build image — and does not need to. It is built and released from
[scala-toolchain-wasm](https://github.com/tothambrus11/scala-toolchain-wasm); the deploy build
downloads a pinned release:

```bash
./scripts/fetch-toolchain.sh --compressed
```

`--compressed` matters here: that variant stores `main.wasm` gzipped, which is what keeps the
distribution under Cloudflare's per-file limit. `scripts/build-cloudflare.sh` refuses to
assemble a site from the uncompressed variant rather than letting the upload fail at the end.

Cloudflare then only bundles the frontend — about two minutes.

## What the build produces

```
dist/cloudflare/
  index.html, bundle.js, bundle.css, editor.worker.js, ...   the Theia frontend
  toolchain/manifest.json                                    the pinned release
  toolchain/compiler/main.wasm.gz                            the compiler, gzipped
  toolchain/compiler/main.js, __loader.js
  toolchain/classpath/*.jar, toolchain/runtime/runtime-sjsir.zip
  toolchain/host/*.js                                        the runtime that drives it
  _headers                                                   cache policy
```

37 files, ~75 MB stored, largest file 14.2 MiB.

### Why the compiler is stored gzipped

`main.wasm` is 31 MB, over the 25 MiB per-file limit. The usual workaround - upload it
pre-compressed and declare `Content-Encoding: gzip` in `_headers` - does not work on
Cloudflare, which strips that header and manages compression itself.

So the toolchain's `-compressed` release stores `main.wasm.gz` (6.0 MiB) and records the
substitution in its manifest:

```json
"compressed": { "./compiler/main.wasm": { "url": "./compiler/main.wasm.gz", "encoding": "gzip" } }
```

The compiler bundle's own loader asks for `main.wasm` and cannot be told otherwise, so the
engine installs a narrow `fetch` shim for exactly those URLs and pipes the response through
`DecompressionStream`. It stays streaming, so `WebAssembly.instantiateStreaming` still
compiles as bytes arrive. See `host/src/compressed-assets.js` in the toolchain repository.

Source maps (40 MB+ each) are excluded from the deploy directory - they would fail the
upload, and the production bundle is 11.4 MB rather than the 23 MB development one.

## Headers and browser requirements

- **No COOP/COEP needed.** Nothing here uses `SharedArrayBuffer`.
- `.wasm` is served as `application/wasm` by Cloudflare automatically.
- `_headers` sets immutable caching for `/toolchain/*` — a release never changes, so a repeat
  visit re-downloads nothing.
- Visitors need **WebAssembly JSPI**: Chrome/Edge 137+. Other engines get a clear message
  naming the missing features rather than a broken page.

## Continuous deployment

`.github/workflows/deploy.yml` runs the same steps on every push to `main`: fetch the pinned
toolchain, build, verify the bundle in headless Chromium, then deploy with Wrangler. It needs
two repository secrets:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → Account ID |

Without them the workflow still builds and tests, and skips only the deploy step — so a fork
or a first push does not fail on missing secrets.

## Verifying a build before you ship it

The IDE test suite can run against the deploy directory instead of the dev build:

```bash
FRONTEND=dist/cloudflare node e2e/ide.mjs
```

That boots the exact bundle you are about to upload in headless Chromium, compiles and runs
Scala on both backends, and checks diagnostics - including the gzipped-compiler path, which
is only exercised in the deploy build.
