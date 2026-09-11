/**
 * Give a toolchain distribution a URL that changes whenever its contents do.
 *
 * Caching a toolchain is worth doing - it is ~35 MB on first load - but the paths were fixed,
 * so a cached copy of one release could answer a request meant for another. Every symptom of
 * that looked like a different bug: "warmUp is not a function", "linkScalaJSAsync is not a
 * function", features reported missing that were present. All one cause.
 *
 * So each distribution is staged under a directory named for its content, and a small
 * `current.json` says which one is current. That file is the only thing that must not be
 * cached; everything under the versioned directory can be immutable for a year, because a
 * different distribution is a different URL and cannot collide with it.
 *
 *   toolchain-current.json                 <- revalidated, ~200 bytes
 *   toolchain/0.3.4-a1b2c3d4/manifest.json <- immutable
 *   toolchain/0.3.4-a1b2c3d4/compiler/...
 *
 * The pointer deliberately sits *beside* the toolchain directory rather than inside it.
 * Cloudflare's `_headers` merges the directives of every matching rule instead of letting a
 * more specific one win, so a pointer under `/toolchain/` came back as
 * `max-age=31536000, immutable, no-cache` - a contradiction, and one a browser may resolve by
 * never revalidating, which would pin it to a single release forever. Two paths that cannot
 * both match is the only way to be sure.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** A name that changes with the distribution: its host version, plus a digest of the manifest. */
export function distributionId(manifestText) {
  const manifest = JSON.parse(manifestText);
  const version = manifest.toolchain?.hostVersion ?? "unknown";
  // The manifest records the build's identity - upstream ref, versions, timestamp - so its
  // digest changes exactly when the distribution does.
  const digest = createHash("sha256").update(manifestText).digest("hex").slice(0, 8);
  return `${version}-${digest}`;
}

export async function stageToolchain({ source, root, copy }) {
  const manifestText = await readFile(join(source, "manifest.json"), "utf8");
  const id = distributionId(manifestText);

  const destination = join(root, "toolchain");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });

  const versioned = join(destination, id);
  if (copy) {
    await cp(source, versioned, { recursive: true, dereference: true });
  } else {
    await symlink(source, versioned);
  }

  await writeFile(
    join(root, "toolchain-current.json"),
    JSON.stringify(
      {
        // Everything the frontend needs to reach this distribution, relative to this file.
        id,
        manifest: `./toolchain/${id}/manifest.json`,
        host: `./toolchain/${id}/host/index.js`,
        worker: `./toolchain/${id}/host/worker.js`,
      },
      null,
      2,
    ) + "\n",
  );

  return { id, manifest: JSON.parse(manifestText) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [source, root, mode] = process.argv.slice(2);
  if (!source || !root) {
    console.error("usage: stage-toolchain.mjs <source> <site-root> [--copy]");
    process.exit(2);
  }
  if (!existsSync(join(source, "manifest.json"))) {
    console.error(`error: no toolchain at ${source}`);
    process.exit(1);
  }
  const { id, manifest } = await stageToolchain({ source, root, copy: mode === "--copy" });
  const t = manifest.toolchain ?? {};
  console.log(`    Scala ${t.scalaVersion}, Scala.js ${t.scalaJSVersion}, host ${t.hostVersion}`);
  console.log(`    staged as toolchain/${id}`);
}
