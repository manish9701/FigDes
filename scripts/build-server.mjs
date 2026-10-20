#!/usr/bin/env node
/**
 * Builds the server bundle with the commit it was built from baked in.
 *
 * ## Why the server needs a build stamp too
 *
 * The plugin has had one since issue #15: a live session has to be able to
 * say which build it is running, because Figma loads the bundle once and a
 * rebuild does not reach an open panel. The server has the same problem from
 * the other side — it is deployed, and the deployment is not the repository
 * until it is redeployed.
 *
 * A live measurement therefore runs against *two* builds: the server that
 * answered and the plugin that applied the operations. If either is older
 * than the commit the evidence claims, the evidence describes code that may
 * no longer exist. The stamp makes that visible instead of invisible.
 */
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The commit, plus a marker when the tree is dirty. */
function buildStamp() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

const stamp = process.env.FIGDES_BUILD ?? buildStamp();

await build({
  entryPoints: [resolve(root, "mcp-server/src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  outfile: resolve(root, "mcp-server/dist/index.js"),
  define: { __FIGDES_SERVER_BUILD__: JSON.stringify(stamp) },
  logLevel: "warning",
});

console.log(`server bundle built from ${stamp}`);
