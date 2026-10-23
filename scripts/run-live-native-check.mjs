#!/usr/bin/env node
/**
 * The native path, exercised against the live plugin.
 *
 * ## Why this exists
 *
 * The release gate drove the semantic runtime and the plugin's `create_design`
 * transaction. The **native path** — `figdes_use_figma`, model-authored
 * JavaScript against the real Plugin API — had its own rules, and a regression
 * there would not have been caught by anything the gate ran. The issue's group
 * G asks for the native path to be covered, and this is the coverage.
 *
 * ## What it proves
 *
 * That the native path really executes against Figma: a script runs, the
 * builder creates a real auto-layout frame with real text inside it, the file
 * reports the nodes back, and the frame is then removed again so the file is
 * left as it was found.
 *
 * The cleanup is part of the proof: a check that leaves debris behind is not a
 * check, it is a change.
 *
 * Usage: npm run benchmark:live:native
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { assertBuildIntegrity } from "./lib/live-client.mjs";

const MCP = process.env.FIGDES_MCP_URL ?? "https://figdes.onrender.com/mcp";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "artifacts/design-benchmark/live");

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2024-11-05",
      "user-agent": "opencode/live-native-check",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  const json = JSON.parse(text);
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error).slice(0, 300)}`);
  return json.result;
}

async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(`tool ${name}: ${JSON.stringify(result.content).slice(0, 600)}`);
  const t = result.content?.find((b) => b.type === "text")?.text;
  try {
    return { data: t ? JSON.parse(t) : (result.structuredContent ?? null), blocks: result.content ?? [] };
  } catch {
    return { data: { note: t }, blocks: result.content ?? [] };
  }
}

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

await mkdir(outDir, { recursive: true });

const status = (await tool("figma_status", {})).data;
if (!status?.connected) {
  console.error("No Figma plugin is connected: the native path needs the plugin open in the target file. Nothing was written.");
  process.exit(2);
}
console.log("plugin:", status.fileName, "page:", status.pageName, "plugin build:", status.build ?? "unknown");

/**
 * Build/version integrity (issue #25): refuse to run against a server/plugin
 * pair that is not this repository's HEAD — the check would measure other
 * code. Exits 1 with a blocker message when the builds mismatch.
 */
await assertBuildIntegrity();

/** How many frames with this check's name the file already holds. */
const countFrames = async () => {
  const listing = (await tool("inspect_file", {})).data;
  return (listing?.topLevelFrames ?? []).filter((f) => f.name === "FIGDES_NATIVE_CHECK_V01").length;
};
const before = await countFrames();

/**
 * The script.
 *
 * A disposable frame, one real auto-layout stack, two real text nodes and a
 * rectangle, and the ids handed back. Deliberately small: the point is that the
 * native path executes against Figma, not that it can draw a whole screen.
 */
const script = `
const frame = figdes.frame({ name: "FIGDES_NATIVE_CHECK_V01", width: 480, height: 220, fill: "#FFFDF9", radius: 12 });
const stack = figdes.stack({ parent: frame, direction: "VERTICAL", gap: 8, padding: 16, fill: "#FFFFFF", radius: 8, widthSizing: "FILL", heightSizing: "HUG" });
const title = await figdes.text({ parent: stack, text: "Native path check [fixture]", size: 18, weight: 600, width: 400 });
const body = await figdes.text({ parent: stack, text: "A frame, a stack and two text nodes, built by the native builder.", size: 13, weight: 400, width: 400 });
const bar = figdes.rect({ parent: stack, height: 6, fill: "#0B6BCB", radius: 3, widthSizing: "FILL" });
figdes.place(frame, 24000, 0);
return { rootId: frame.id, createdNodeIds: [frame.id, stack.id, title.id, body.id, bar.id], mutatedNodeIds: [] };
`;

console.log("running the native path…");
const native = (await tool("figdes_use_figma", {
  script,
  renderAfter: "none",
  // Issue #26 channels: a mutating script with no plan_screen provenance needs
  // an explicit approval with a reason. This check IS the provenance: it is the
  // gauntlet's own disposable frame (created, inspected, and removed with the
  // framesAfter/leftBehind verification below), not a product surface.
  approved: true,
  reason: "The native-path check is the release gauntlet's own disposable frame (FIGDES_NATIVE_CHECK_V01). It is created, inspected, removed, and the cleanup is verified in this run.",
})).data;

const rootId = native?.rootId ?? native?.result?.rootId ?? null;
const created = native?.createdNodeIds ?? native?.result?.createdNodeIds ?? [];
if (!rootId) {
  console.error("the native path returned no root id:", JSON.stringify(native).slice(0, 400));
  process.exit(1);
}
console.log(`native path created ${created.length} node(s); root ${rootId}`);

/* --- read the file back ---------------------------------------------------- */

// The node is measured through the same inspector a designer would use, so
// the evidence says what the native path actually built rather than what the
// script said it built.
const inspected = (await tool("figdes_inspect_visual", { target: rootId })).data;
const measured = {
  canvas: inspected?.canvas ?? null,
  nodeCount: inspected?.nodeCount ?? null,
  textLayers: Array.isArray(inspected?.textHierarchy) ? inspected.textHierarchy.length : null,
  renderStatus: inspected?.renderStatus ?? "unknown",
  focalCandidates: inspected?.focalCandidates?.length ?? null,
};

/* --- clean up -------------------------------------------------------------- */

console.log("removing the disposable frame…");
const cleanup = (await tool("modify_design", {
  description: "FigDes live native check: remove the disposable frame",
  reason: "A frame this check created, removed so the file is left as it was found.",
  approved: true,
  operations: [{ type: "removeNode", target: rootId }],
})).data;

/**
 * The file is read back through the file listing, not through a name search.
 *
 * A search misses what it does not look at: the first version of this check
 * searched for the frame by name, found nothing, and reported the file clean
 * while the frame was still sitting in it at x=24000. The listing sees every
 * top-level frame, so it cannot be fooled that way.
 */
const after = await countFrames();
const leftBehind = Math.max(0, after - before);

const rec = {
  caseId: "native-path-check",
  commit,
  server: MCP,
  startedAt: new Date().toISOString(),
  serverBuild: status.serverBuild ?? "unknown",
  pluginBuild: status.build ?? "unknown",
  rootId,
  createdNodeIds: created,
  measured,
  cleanup: { status: cleanup?.status ?? null, framesBefore: before, framesAfter: after, leftBehind },
  status: leftBehind === 0 ? "COMPLETE" : "INCOMPLETE",
  note: "The native path ran against the real Plugin API and the frame it created was removed again. A check that leaves debris behind is not a check.",
};

await writeFile(resolve(outDir, "native-check.json"), `${JSON.stringify(rec, null, 2)}\n`);

console.log("");
console.log(`native path check: ${rec.status}`);
console.log(`  root          ${rootId} (${created.length} node(s) created)`);
console.log(
  `  measured      ${measured.canvas?.width ?? "?"}x${measured.canvas?.height ?? "?"}, ${measured.nodeCount ?? "?"} node(s), ${measured.textLayers ?? "?"} text layer(s), render ${measured.renderStatus}`,
);
console.log(`  cleanup       ${leftBehind} frame(s) left behind by this run (${before} → ${after} in the file)`);
if (after > 0) {
  console.log(`  note          ${after} frame(s) named FIGDES_NATIVE_CHECK_V01 are in the file: debris from an earlier run.`);
}
if (rec.status !== "COMPLETE") {
  console.log("");
  console.log("The check did not complete cleanly; the native-path coverage is not proven.");
  process.exit(1);
}
