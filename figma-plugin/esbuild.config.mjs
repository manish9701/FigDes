import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
    },
  });

  console.log(publicUrl ? `built -> ${outDir} (endpoint: ${bakedUrl})` : `built -> ${outDir}`);
}

if (process.argv.includes("--watch")) {
  await esbuild
    .context({
      ...common,
      entryPoints: [resolve(here, "src/code.ts")],
      outfile: resolve(outDir, "code.js"),
      define: { __html__: JSON.stringify(readFileSync(resolve(here, "ui/index.html"), "utf8")), __DESIGN_AGENT_URL__: JSON.stringify(bakedUrl) },
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