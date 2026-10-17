import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "dist");

/**
 * Optional pinned endpoint. When DESIGN_AGENT_PUBLIC_URL is set, the plugin
 * dials that address instead of localhost, so the server no longer needs a
 * per-session quick tunnel and the ChatGPT endpoint never changes:
 *
 *   $env:DESIGN_AGENT_PUBLIC_URL = "https://design-agent.example.com"
 *   npm run build:plugin
 *
 * Add the matching host to manifest.json networkAccess before using this with
 * anything other than localhost.
 */
const publicUrl = (process.env.DESIGN_AGENT_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
const bakedUrl = publicUrl || "http://localhost:8787";

/**
 * Which build is this, so a live session can prove it.
 *
 * `PLUGIN_VERSION` is a hand-maintained constant and has never changed, so it
 * cannot tell you anything about the code that is actually running. That matters
 * because Figma loads `dist/code.js` once, when the plugin panel opens: rebuild
 * the bundle and the open panel keeps executing the old one, silently. Every
 * live measurement then describes a build that no longer exists in the repo, and
 * a fix that "did not work" is indistinguishable from a fix that was never
 * loaded. Both issues ask for the tested commit SHA in the evidence, and the
 * plugin had no way to supply it.
 *
 * So the SHA (plus a dirtiness marker) is baked in at build time and reported
 * through `figma_status`. "uncommitted" matters too: a dirty tree means the
 * bundle and the repo disagree about what was measured.
 */
function buildStamp() {
  try {
    const sha = execSync("git rev-parse --short=12 HEAD", { cwd: here, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const dirty = execSync("git status --porcelain", { cwd: here, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}
const bakedBuild = process.env.FIGDES_BUILD ?? buildStamp();

mkdirSync(outDir, { recursive: true });

/**
 * The plugin main thread (`code.js`) has no network access — only the iframe
 * does — so the two bundles stay separate and are bridged by postMessage.
 */
const common = {
  bundle: true,
  format: "iife",
  target: "es2017",
  logLevel: "info",
};

/**
 * `figma.showUI(html)` resolves relative paths in that HTML against the plugin
 * ROOT, not the ui file's own folder. A `<script src="./ui.js">` therefore 404s
 * when the file actually lives in dist/. Rather than depend on how Figma
 * resolves it, the UI script is inlined into the HTML at build time, so the
 * iframe has zero external references to resolve.
 */
function buildUiHtml() {
  const html = readFileSync(resolve(here, "ui/index.html"), "utf8");
  const js = readFileSync(resolve(outDir, "ui.js"), "utf8");

  const inlined = html.replace(
    /<script\s+src="\.\/ui\.js"><\/script>/,
    () => `<script>\n${js}\n</script>`,
  );

  if (inlined === html) {
    throw new Error('index.html must contain exactly <script src="./ui.js"></script> to inline the UI bundle.');
  }
  return inlined;
}

async function build() {
  await esbuild.build({ ...common, entryPoints: [resolve(here, "ui/ui.ts")], outfile: resolve(outDir, "ui.js") });

  const html = buildUiHtml();
  writeFileSync(resolve(outDir, "ui.html"), html);

  // code.ts passes the HTML inline via figma.showUI(__html__), so the same
  // inlined copy has to be baked into that bundle too, along with the endpoint.
  await esbuild.build({
    ...common,
    entryPoints: [resolve(here, "src/code.ts")],
    outfile: resolve(outDir, "code.js"),
    define: {
      __html__: JSON.stringify(html),
      __DESIGN_AGENT_URL__: JSON.stringify(bakedUrl),
      __FIGDES_BUILD__: JSON.stringify(bakedBuild),
    },
  });

  console.log(`${publicUrl ? `built -> ${outDir} (endpoint: ${bakedUrl})` : `built -> ${outDir}`} [build ${bakedBuild}]`);
}

if (process.argv.includes("--watch")) {
  await esbuild
    .context({
      ...common,
      entryPoints: [resolve(here, "src/code.ts")],
      outfile: resolve(outDir, "code.js"),
      define: {
        __html__: JSON.stringify(readFileSync(resolve(here, "ui/index.html"), "utf8")),
        __DESIGN_AGENT_URL__: JSON.stringify(bakedUrl),
        __FIGDES_BUILD__: JSON.stringify(bakedBuild),
      },
    })
    .then((c) => c.watch());
  await esbuild.context({ ...common, entryPoints: [resolve(here, "ui/ui.ts")], outfile: resolve(outDir, "ui.js") }).then((c) => c.watch());
  setInterval(async () => {
    try {
      writeFileSync(resolve(outDir, "ui.html"), buildUiHtml());
    } catch {
      /* mid-write; next tick */
    }
  }, 400);
  console.log(`watching figma-plugin (endpoint: ${bakedUrl})…`);
} else {
  await build();
}