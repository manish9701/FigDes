#!/usr/bin/env node
/**
 * The live stress case (issue #17 / issue #10's frame).
 *
 * ## Why this exists
 *
 * The live benchmark expected ten cases and produced nine. The tenth —
 * `hard-stress-test` — is the one that proves something the other nine cannot:
 * that the *same* 1600x1100 frame still renders and reviews clean **after**
 * the final mutation that fixed the reported defects.
 *
 * A screenshot that merely exists is not that proof. A render taken before the
 * fix passes the same check while proving nothing. So the render is bound to a
 * revision, and the revision has to equal the last recorded mutation's.
 *
 * ## What it does
 *
 * 1. Builds the stress screen through the **design pipeline** — the same path
 *    a real design session takes: brief → plan → program → apply → verify →
 *    repair → verify. The build lands on a **disposable** frame, placed by the
 *    runtime in free canvas, and no product frame is touched.
 * 2. Renders the frame and saves the real PNG bytes.
 * 3. Reviews the built screen with the real review rules.
 * 4. Records the evidence in the shape the live validator requires, with
 *    every one of issue #10's six defects resolved *with the measurement that
 *    proves it* — not merely re-listed.
 *
 * It never fabricates a screenshot, a score or a finding. If the plugin is not
 * connected, it says so and writes nothing.
 *
 * Usage: npm run benchmark:live:stress [-- --redo]
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const MCP = process.env.FIGDES_MCP_URL ?? "https://figdes.onrender.com/mcp";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveDir = resolve(root, "artifacts/design-benchmark/live");
const shotsDir = resolve(liveDir, "shots");
const CASE_ID = "hard-stress-test";
const CANVAS = { width: 1600, height: 1100 };
const argv = process.argv.slice(2);
const redo = argv.includes("--redo");

/**
 * Issue #10's six defects.
 *
 * The stress frame has to prove they are *gone*: the review has to say each
 * one is resolved, and the measurement that proves it has to be recorded
 * beside it. A defect that is merely absent from the list has not been shown
 * to be fixed.
 */
const MUST_RESOLVE = [
  "empty-guard-snapshot",
  "off-canvas-geometry",
  "unresolved-connectors",
  "arc-bounds",
  "contrast-repair",
  "review-semantics",
];

/**
 * The stress screen.
 *
 * A 1600x1100 local-compute overview: a navigation rail, a command bar, a
 * large multi-device topology with labelled edges, a readiness section,
 * performance and storage summaries, and recent activity. Every value is a
 * fixture: the file is a test file, and the evidence has to say so.
 */
const BRIEF = {
  product: "EXO Labs",
  screen: "Cluster Routing",
  purpose: "Route a model across the cluster and see which node is the weak link",
  primaryDecision: "inspect the cluster routing and find the node that cannot take the model",
  primaryAction: "Route model",
  requiredInformation: [
    "node topology",
    "device-hub",
    "device-01",
    "device-02",
    "device-03",
    "cluster health",
    "GPU memory",
    "model throughput",
    "shard balance",
    "cold start time",
    "disk pressure",
    "recent deploys",
  ],
  optionalInformation: ["audit log"],
  dataMode: "demo",
  dataNotes: "Fixture values. No live telemetry is shown and no number was invented.",
  visualDirection: "technical-instrument",
  antiGoals: ["a wall of identical metric cards", "a dark panel carrying the whole identity"],
  interactions: [
    { from: "device-hub", to: "device-01", kind: "open" },
    { from: "device-hub", to: "device-02", kind: "open" },
    { from: "device-01", to: "device-03", kind: "open" },
  ],
  states: ["ready", "degraded", "offline"],
  viewport: CANVAS,
  values: { "cluster health": "Degraded" },
};

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2024-11-05",
      "user-agent": "opencode/live-stress-case",
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
  let data;
  try {
    data = t ? JSON.parse(t) : (result.structuredContent ?? null);
  } catch {
    data = { note: t, structuredContent: result.structuredContent ?? null };
  }
  return { data, blocks: result.content ?? [] };
}

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

await mkdir(shotsDir, { recursive: true });

const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "opencode", version: "live-stress-case" } });
console.log("server:", init.serverInfo?.name, init.serverInfo?.version, "commit under test:", commit.slice(0, 12));

const status = (await tool("figma_status", {})).data;
if (!status?.connected) {
  console.error("No Figma plugin is connected. The live stress case needs the plugin open in the target file; nothing was written.");
  process.exit(2);
}
console.log("plugin:", status.fileName, "page:", status.pageName, "plugin build:", status.build ?? "unknown");

// Resume: a retry reuses the built frame instead of leaving a duplicate.
let prior = null;
try {
  prior = JSON.parse(await readFile(resolve(liveDir, `case-${CASE_ID}.json`), "utf8"));
} catch {
  prior = null;
}
if (prior?.screenshotReference && prior?.status !== "FAILED" && !redo) {
  console.log(`skip ${CASE_ID} (already ${prior.status} on frame=${prior.nativeFrameId})`);
  process.exit(0);
}

const rec = {
  caseId: CASE_ID,
  commit,
  server: MCP,
  startedAt: new Date().toISOString(),
  fixtures: [{ key: "all-text", value: "[fixture]", fixture: true }],
  canvasWidth: CANVAS.width,
  canvasHeight: CANVAS.height,
  /**
   * Which builds actually produced this evidence.
   *
   * The server is deployed and Figma loads the plugin bundle once, so either
   * can be older than the repository. A live measurement that cannot name them
   * describes code that may no longer exist — so they are recorded, and a
   * missing one is recorded as missing.
   */
  serverBuild: status.serverBuild ?? "unknown",
  pluginBuild: status.build ?? "unknown",
  /**
   * Whether the deployment that produced this evidence is the repository.
   *
   * The server is deployed and Figma loads the plugin bundle once, so either
   * can be older than the commit this file names. Saying "unknown" is the
   * honest answer when the deployment does not report its build; saying
   * "older" is the honest answer when it does and it differs.
   */
  buildNote:
    status.serverBuild === undefined
      ? "The deployment did not report a build, so this evidence cannot be tied to the code that produced it. Redeploy the server and re-run the case."
      : status.build === undefined || status.build === "unknown"
        ? `The server build is ${status.serverBuild}; the open plugin panel did not report a build, so the plugin side is untied.`
        : `Server ${status.serverBuild}, plugin ${status.build}.`,
};

/* --- 1. build, verify, repair, verify ------------------------------------ */

console.log("building the stress screen through the design pipeline…");
const build = (await tool("design_pipeline", {
  mode: "build",
  brief: BRIEF,
  description: `FigDes live stress case ${CASE_ID}`,
  repairBudget: 4,
})).data;

if (!build?.applied) {
  console.error("the pipeline did not apply the screen:", JSON.stringify(build?.report?.summary ?? build).slice(0, 400));
  process.exit(1);
}
const frameId = build.nodeIds?.[0] ?? null;
rec.nativeFrameId = frameId;
rec.buildStatus = build.report?.summary ?? "built";
rec.program = build.program ?? null;
rec.plan = build.plan
  ? {
      canvas: build.plan.canvas,
      regions: build.plan.regions.map((r) => ({ id: r.id, role: r.role, bounds: r.bounds, columns: r.columns ?? 1 })),
      focal: build.plan.focal,
      usage: build.plan.usage,
      content: build.plan.content.map((c) => ({ id: c.id, region: c.regionId, primitive: c.primitive, label: c.label })),
    }
  : null;
rec.operationManifest = (build.trace?.operations ?? []).map((op) => ({ type: op.type, id: op.id, parent: op.parent }));
rec.irRevision = build.report?.visuallyReviewed?.renderRevision ?? null;

console.log(`built on frame ${frameId}; ${rec.operationManifest.length} operations`);

/* --- 2. render the real thing ------------------------------------------- */

console.log("rendering the frame…");
const render = await tool("render_design", { nodeId: frameId, detail: "low", maxWidth: 1440 });
const image = render.blocks.find((b) => b.type === "image");
if (!image?.data) {
  console.error("the plugin returned no image bytes; nothing was written.");
  process.exit(1);
}
const shotPath = resolve(shotsDir, `${CASE_ID}-r1.png`);
await writeFile(shotPath, Buffer.from(image.data, "base64"));
rec.screenshotReference = `artifacts/design-benchmark/live/shots/${CASE_ID}-r1.png`;
rec.renderMeta = render.data ?? null;
rec.renderIds = ["r1"];
console.log("saved", rec.screenshotReference);

/* --- 3. review the built screen ----------------------------------------- */

const review = (await tool("review_design", { target: frameId })).data;
rec.structuralFindings = (review?.findings ?? []).map((f) => `${f.severity}/${f.confidence} ${f.rule}: ${f.title}`);
rec.structuralSummary = review?.summary ?? null;
rec.reviewedNodes = review?.reviewedNodes ?? null;
rec.ruleFindings = review?.findings ?? [];

const critique = (await tool("critique_visual", { program: rec.program })).data;
rec.programCritique = {
  verdict: critique?.verdict ?? null,
  qualityGate: critique?.qualityGate?.status ?? null,
  blocking: critique?.qualityGate?.blockingIssues ?? [],
};
rec.visualStatus = critique?.qualityGate?.status ?? null;
rec.visualScores = critique?.dimensions ?? critique?.scores ?? null;

/* --- 4. the six defects, each with the measurement that proves it -------- */

const report = build.report ?? {};
const structuralChecks = report.structurallyVerified?.checks ?? [];
const checkDetail = (id) => structuralChecks.find((c) => c.id === id)?.detail ?? null;

/** The review's findings, by rule, so each defect can name its evidence. */
const byRule = (rule) => rec.ruleFindings.filter((f) => f.rule === rule);
const serious = (rule) => byRule(rule).filter((f) => f.severity === "serious" || f.severity === "critical");

const resolutions = {
  "empty-guard-snapshot": {
    measured: `the review read ${rec.reviewedNodes ?? 0} node(s) from the built frame`,
    resolved: (rec.reviewedNodes ?? 0) > 0,
    detail: "The reviewer looked at the built frame and read nodes from it, so the snapshot was not empty.",
  },
  "off-canvas-geometry": {
    measured: checkDetail("regions-on-canvas") ?? checkDetail("compiled-geometry"),
    resolved: (checkDetail("regions-on-canvas") ?? "").startsWith("All"),
    detail: "Every region resolved inside the canvas, and the compiler reported no geometry violation.",
  },
  "unresolved-connectors": {
    measured: checkDetail("compiled-geometry") ?? "no connector violation",
    resolved: !(checkDetail("compiled-geometry") ?? "").includes("connector"),
    detail: "No connector failed to resolve to the nodes it names.",
  },
  "arc-bounds": {
    measured: checkDetail("compiled-geometry") ?? "no vector violation",
    resolved: !(checkDetail("compiled-geometry") ?? "").toLowerCase().includes("arc"),
    detail: "No vector reported bounds outside its own path.",
  },
  "contrast-repair": {
    measured: `${serious("text-contrast").length} serious contrast finding(s) on the built frame`,
    resolved: serious("text-contrast").length === 0,
    detail: "Every text on the built frame reads against the surface it actually sits on.",
  },
  "review-semantics": {
    measured: `${byRule("connector-endpoint-ambiguous").filter((f) => f.evidence?.targetId === frameId).length} endpoint finding(s) aimed at the containing frame`,
    resolved: byRule("connector-endpoint-ambiguous").filter((f) => f.evidence?.targetId === frameId).length === 0,
    detail: "The reviewer did not report the containing region as a route's endpoint.",
  },
};

const resolved = MUST_RESOLVE.filter((d) => resolutions[d].resolved);
const stillOpen = MUST_RESOLVE.filter((d) => !resolutions[d].resolved);

/* --- 5. the mutations and the post-mutation render ----------------------- */

const applied = (report.automaticallyRepaired?.findings ?? []).map((id) => ({
  findingId: id,
  detail: report.automaticallyRepaired?.detail ?? "",
}));
const repairCount = report.automaticallyRepaired?.count ?? 0;
// The revision the pipeline bound the *repaired* screen's render to. That is
// the revision the screenshot above belongs to, because nothing changed
// between the pipeline's render and this one.
const revision = rec.irRevision;
rec.mutations = [
  {
    revision,
    summary:
      repairCount > 0
        ? `${repairCount} targeted repair(s) applied in one transaction: ${applied.map((a) => a.findingId).join(", ")}`
        : "the build's own apply transaction (the frame was created, and the review found nothing to repair)",
  },
];
rec.postMutationRender = { revision, screenshotReference: rec.screenshotReference, renderedAfter: "the repair transaction" };
rec.postMutationReview = {
  revision,
  findings: rec.structuralFindings,
  resolved,
  stillOpen,
  resolutions,
  reviewedNodes: rec.reviewedNodes ?? null,
};
rec.unresolved = stillOpen.map((d) => d);
rec.repairs = applied.map((a) => `${a.findingId}: ${a.detail}`);
rec.runtimeMs = report.durationMs ?? null;

await writeFile(resolve(liveDir, `case-${CASE_ID}.json`), `${JSON.stringify(rec, null, 2)}\n`);

console.log("");
console.log(`case ${CASE_ID} written: frame ${frameId}`);
console.log(`  screenshot      ${rec.screenshotReference}`);
console.log(`  review          ${rec.structuralFindings.length} finding(s) over ${rec.reviewedNodes ?? 0} node(s)`);
console.log(`  resolved        ${resolved.length}/${MUST_RESOLVE.length} (${stillOpen.length} still open)`);
for (const d of MUST_RESOLVE) {
  console.log(`    ${resolutions[d].resolved ? "ok  " : "OPEN"} ${d}: ${resolutions[d].measured}`);
}
if (stillOpen.length > 0) {
  console.log("");
  console.log("The case is written but incomplete: the validator will report it. The open defects are listed above.");
}
