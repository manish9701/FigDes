#!/usr/bin/env node
/**
 * FigDes live Figma loop, Phase A (handoff §9 + §12 step 10).
 *
 * Drives the REAL deployed server (https://figdes.onrender.com/mcp) against
 * the REAL connected plugin session: plan → dryRun → build → render (PNG
 * saved) → structural review → program critique → score. One case after
 * another, artifacts per case, no fabricated screenshots or scores.
 *
 * Writes: artifacts/design-benchmark/live/case-<id>.json (real evidence) and
 *         artifacts/design-benchmark/live/shots/<id>-r1.png (real PNG bytes).
 * Visual judgement is NOT claimed here — Phase B is a human/vision pass over
 * the saved PNGs, then Phase C repairs.
 *
 * Every frame is named "FigDes Live — <case-id>" so the file owner can find
 * and delete them afterwards. All text content is marked [fixture].
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MCP = process.env.FIGDES_MCP_URL ?? "https://figdes.onrender.com/mcp";
const UA = "opencode/live-loop-phase-a";
const COMMIT = "1b15f1f";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveDir = resolve(root, "artifacts/design-benchmark/live");
const shotsDir = resolve(liveDir, "shots");

const CASES = [
  { id: "exo-compute-topology", decision: "Which device in the EXO compute topology needs attention first?", info: ["devices", "nodes", "links", "latency", "GPU health", "memory pressure"] },
  { id: "exo-model-detail", decision: "Does this model fit the available local hardware?", info: ["model name", "context length", "memory", "throughput", "supported devices", "fit state"] },
  { id: "exo-runtime-monitoring", decision: "Intervene in live inference or let it continue?", info: ["GPU utilization", "memory pressure", "throughput", "error rate", "latency"] },
  { id: "exo-configuration", decision: "Approve this runtime policy and its thresholds?", info: ["current settings", "policy", "threshold", "schedule", "approval status"] },
  { id: "exo-enterprise-workspace", decision: "Which assigned devices need action?", info: ["devices", "team assignments", "deployments", "health", "access policy"] },
  { id: "generic-saas-dashboard", decision: "Review this SaaS dashboard (negative control)", info: ["users", "revenue", "growth", "conversion", "activity"] },
  { id: "data-heavy-workspace", decision: "Which events need follow-up and who owns them?", info: ["events", "incidents", "errors", "owner", "status"] },
  { id: "spatial-relationship", decision: "Where is the weak link in this dependency graph?", info: ["nodes", "edges", "dependencies", "latency", "bandwidth"] },
  { id: "editorial-product-page", decision: "Which model should run, weighing cost and quality?", info: ["model name", "run cost", "latency", "quality", "recommendation"] },
];

/** Minimal fixture programs: exercise the loop mechanics, clearly marked. */
function programFor(id) {
  const canvas = { name: `FigDes Live — ${id}`, width: 1440, height: 900, grid: 8 };
  const F = "[fixture]";
  switch (id) {
    case "exo-compute-topology":
      return { canvas,
        regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology", layout: "topology" } }],
        links: [{ from: "hub", to: "n1", label: "8us" }, { from: "hub", to: "n2" }],
        content: [
          { fn: "deviceNode", id: "hub", parent: "map", args: { label: `hub-01 ${F}`, memory: "1.8 TB" } },
          { fn: "deviceNode", id: "n1", parent: "map", args: { label: `node-01 ${F}`, memory: "96 GB" } },
          { fn: "deviceNode", id: "n2", parent: "map", args: { label: `node-02 ${F}`, health: "degraded" } },
          { fn: "connector", id: "c1", parent: "map", args: { from: "hub", to: "n1", label: "8us" } },
          { fn: "connector", id: "c2", parent: "map", args: { from: "hub", to: "n2" } },
          { fn: "statusPill", id: "st", parent: "map", args: { label: `1 needs attention ${F}`, tone: "warning" } },
        ] };
    case "exo-model-detail":
      return { canvas,
        regions: [{ fn: "inspector", id: "detail", args: { width: "fill", height: "fill" } }],
        content: [
          { fn: "text", id: "t", parent: "detail", args: { text: `atlas-7b ${F}`, fontSize: 28 } },
          { fn: "metric", id: "m1", parent: "detail", args: { label: "Memory", value: `41 GB ${F}`, valueStyle: "technical" } },
          { fn: "metric", id: "m2", parent: "detail", args: { label: "Throughput", value: `88 tok/s ${F}`, valueStyle: "technical" } },
          { fn: "statusPill", id: "st", parent: "detail", args: { label: `fits ${F}`, tone: "success" } },
        ] };
    case "exo-runtime-monitoring":
      return { canvas,
        regions: [{ fn: "frame", id: "board", args: { width: "fill", height: "fill" } }],
        content: [
          { fn: "metric", id: "m1", parent: "board", args: { label: "GPU", value: `92% ${F}`, valueStyle: "technical" } },
          { fn: "metric", id: "m2", parent: "board", args: { label: "Memory pressure", value: `71% ${F}`, valueStyle: "technical" } },
          { fn: "metric", id: "m3", parent: "board", args: { label: "Error rate", value: `0.4% ${F}`, valueStyle: "technical" } },
          { fn: "statusPill", id: "st", parent: "board", args: { label: `watching ${F}`, tone: "warning" } },
        ] };
    case "exo-configuration":
      return { canvas,
        regions: [{ fn: "frame", id: "form", args: { width: "fill", height: "fill" } }],
        content: [
          { fn: "text", id: "t", parent: "form", args: { text: `Runtime policy ${F}`, fontSize: 24 } },
          { fn: "panel", id: "p", parent: "form", args: { title: `Thresholds ${F}` } },
          { fn: "button", id: "ok", parent: "form", args: { label: `Approve ${F}` } },
        ] };
    case "exo-enterprise-workspace":
      return { canvas,
        regions: [
          { fn: "navigation", id: "nav", args: { width: 240 } },
          { fn: "frame", id: "work", args: { width: "fill", height: "fill" } },
        ],
        content: [
          { fn: "text", id: "t", parent: "work", args: { text: `Assigned fleet ${F}`, fontSize: 24 } },
          { fn: "deviceNode", id: "d1", parent: "work", args: { label: `edge-04 ${F}`, health: "degraded" } },
          { fn: "deviceNode", id: "d2", parent: "work", args: { label: `edge-09 ${F}` } },
        ] };
    case "generic-saas-dashboard":
      return { canvas,
        regions: [{ fn: "frame", id: "dash", args: { width: "fill", height: "fill" } }],
        content: [
          { fn: "metric", id: "m1", parent: "dash", args: { label: "Users", value: `12,400 ${F}` } },
          { fn: "metric", id: "m2", parent: "dash", args: { label: "Revenue", value: `$88k ${F}` } },
          { fn: "metric", id: "m3", parent: "dash", args: { label: "Growth", value: `+4% ${F}` } },
        ] };
    case "data-heavy-workspace":
      return { canvas,
        regions: [{ fn: "frame", id: "ws", args: { width: "fill", height: "fill" } }],
        content: [
          { fn: "text", id: "t", parent: "ws", args: { text: `Follow-ups ${F}`, fontSize: 24 } },
          { fn: "metric", id: "m1", parent: "ws", args: { label: "Open incidents", value: `7 ${F}`, valueStyle: "technical" } },
          { fn: "statusPill", id: "st", parent: "ws", args: { label: `owner: rios ${F}`, tone: "info" } },
        ] };
    case "spatial-relationship":
      return { canvas,
        regions: [{ fn: "hero", id: "graph", args: { width: "fill", height: "fill", composition: "topology", layout: "topology" } }],
        links: [{ from: "a", to: "b", label: "feeds" }, { from: "b", to: "c", label: "drains" }],
        content: [
          { fn: "deviceNode", id: "a", parent: "graph", args: { label: `ingest ${F}` } },
          { fn: "deviceNode", id: "b", parent: "graph", args: { label: `relay ${F}`, health: "pressured" } },
          { fn: "deviceNode", id: "c", parent: "graph", args: { label: `store ${F}` } },
          { fn: "connector", id: "c1", parent: "graph", args: { from: "a", to: "b", label: "feeds" } },
          { fn: "connector", id: "c2", parent: "graph", args: { from: "b", to: "c", label: "drains" } },
        ] };
    default: // editorial-product-page
      return { canvas,
        regions: [{ fn: "hero", id: "story", args: { width: "fill", height: "fill" } }],
        content: [
          { fn: "text", id: "t", parent: "story", args: { text: `Run the small model first ${F}`, fontSize: 32 } },
          { fn: "text", id: "b", parent: "story", args: { text: `Half the cost, nearly the quality ${F}`, fontSize: 16 } },
          { fn: "button", id: "go", parent: "story", args: { label: `Run atlas-7b ${F}` } },
        ] };
  }
}

let rpcId = 100;
async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2024-11-05",
      "user-agent": UA,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error).slice(0, 300)}`);
  return json.result;
}

async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(`tool ${name} error: ${JSON.stringify(result.content).slice(0, 500)}`);
  const text = result.content?.find((b) => b.type === "text")?.text;
  // Most tools return JSON in the text block; image-carrying tools (render)
  // return prose — keep it as a note rather than crashing the loop.
  let data;
  try {
    data = text ? JSON.parse(text) : (result.structuredContent ?? null);
  } catch {
    data = { note: text, structuredContent: result.structuredContent ?? null };
  }
  return { data, blocks: result.content ?? [] };
}

function pickRoot(buildData) {
  const nodes = buildData?.transaction?.createdNodes ?? buildData?.createdNodes ?? [];
  const frame = nodes.find((n) => n.type === "FRAME") ?? nodes[0];
  if (!frame) throw new Error(`no created nodes: ${JSON.stringify(buildData).slice(0, 300)}`);
  return { id: frame.figmaNodeId ?? frame.id, name: frame.name, nodes };
}

const only = process.argv[2]; // optional single case id, or --redo to rebuild finished cases
const redo = process.argv.includes("--redo");
const runStarted = Date.now();
await mkdir(shotsDir, { recursive: true });

const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "opencode", version: "live-loop-phase-a" } });
console.log("server:", init.serverInfo?.name, init.serverInfo?.version);
// Note: no notifications/initialized — the stateless server answers it with
// Method-not-found and the session works fine without it.

const summary = [];
for (const c of CASES) {
  if (only && c.id !== only && only !== "--redo") continue;
  const t0 = Date.now();
  const rec = { caseId: c.id, commit: COMMIT, server: MCP, startedAt: new Date().toISOString(), fixtures: [{ key: "all-text", value: "[fixture]", fixture: true }] };
  // Resume: a retry reuses the already-built frame instead of duplicating it.
  let prior = null;
  try {
    const { readFile } = await import("node:fs/promises");
    prior = JSON.parse(await readFile(resolve(liveDir, `case-${c.id}.json`), "utf8"));
  } catch { prior = null; }
  if (prior?.screenshotReference && prior?.status !== "FAILED" && !redo) {
    console.log(`skip ${c.id} (already ${prior.status} on frame=${prior.nativeFrameId})`);
    summary.push({ caseId: c.id, status: prior.status, frame: prior.nativeFrameId ?? null, findings: (prior.structuralFindings ?? []).length });
    continue;
  }
  const resumeFrame = prior?.nativeFrameId && !prior?.screenshotReference ? prior.nativeFrameId : null;
  if (resumeFrame) {
    Object.assign(rec, {
      candidateDirection: prior.candidateDirection ?? null,
      planDerivation: prior.planDerivation ?? null,
      irRevision: prior.irRevision ?? `live-${c.id}-r1`,
      operationManifest: prior.operationManifest ?? [],
      nativeFrameId: resumeFrame,
      buildStatus: `${prior.buildStatus ?? "completed"} (reused from prior attempt — no duplicate frame)`,
    });
    console.log(`resume ${c.id} on existing frame=${resumeFrame}`);
  }
  try {
    if (!resumeFrame) {
      const plan = (await tool("plan_screen", { primaryDecision: c.decision, availableInformation: c.info })).data;
      rec.candidateDirection = {
        selectedFamily: plan.composition?.family ?? plan.derivation?.strategy ?? "unknown",
        rationale: plan.derivation?.note ?? "",
        rejectedAlternatives: [],
        candidates: [],
      };
      rec.planDerivation = plan.derivation ?? null;

      const program = programFor(c.id);
      rec.program = program;
      rec.irRevision = `live-${c.id}-r1`;
      rec.operationManifest = [];
      const dry = (await tool("design_runtime", { program, dryRun: true, description: `FigDes live bench ${c.id} (dry run)` })).data;
      rec.dryRun = { operationCount: dry.stats?.operationCount ?? dry.operations?.length ?? 0, violations: dry.violations ?? [], warnings: dry.warnings ?? [] };
      if ((dry.violations ?? []).length > 0) throw new Error(`dry-run violations: ${JSON.stringify(dry.violations).slice(0, 300)}`);

      const build = (await tool("design_runtime", { program, description: `FigDes live bench ${c.id}` })).data;
      const root = pickRoot(build);
      rec.nativeFrameId = root.id;
      rec.operationManifest = build.operations ?? [];
      rec.buildStatus = build.status;
    } else {
      rec.program = programFor(c.id);
    }
    const rootId = rec.nativeFrameId;
    if (!rootId) throw new Error("no frame id to render");

    const render = await tool("render_design", { nodeId: rootId, detail: "low", maxWidth: 1024 });
    const img = render.blocks.find((b) => b.type === "image");
    if (!img?.data) throw new Error(`no image bytes: ${JSON.stringify(render.data).slice(0, 300)}`);
    const shotPath = resolve(shotsDir, `${c.id}-r1.png`);
    await writeFile(shotPath, Buffer.from(img.data, "base64"));
    rec.screenshotReference = `artifacts/design-benchmark/live/shots/${c.id}-r1.png`;
    rec.renderMeta = render.data;
    rec.renderIds = ["r1"];

    const review = (await tool("review_design", { target: rootId })).data;
    rec.structuralFindings = (review.findings ?? []).map((f) => `${f.severity}/${f.confidence} ${f.rule}: ${f.title}`);
    rec.structuralSummary = review.summary ?? null;
    rec.reviewedNodes = review.reviewedNodes ?? null;

    const critique = (await tool("critique_visual", { program: rec.program })).data;
    rec.programCritique = { verdict: critique.verdict ?? null, qualityGate: critique.qualityGate?.status ?? null, blocking: critique.qualityGate?.blockingIssues ?? [] };

    let score = null;
    try {
      score = (await tool("score_design", { program: rec.program })).data;
    } catch (e) { score = { error: String(e).slice(0, 200) }; }
    rec.programScore = score;

    rec.visualFindings = [];
    rec.visualScores = null;
    rec.visualStatus = "PENDING_VISION_REVIEW";
    rec.repairs = [];
    rec.unresolved = ["visual judgement pending (Phase B)"];
    rec.runtimeMs = Date.now() - t0;
    rec.status = "BUILT_RENDERED_STRUCTURALLY_REVIEWED";
    console.log(`ok ${c.id} frame=${rootId} findings=${rec.structuralFindings.length} ms=${rec.runtimeMs}`);
  } catch (err) {
    rec.status = "FAILED";
    rec.error = String(err).slice(0, 500);
    rec.runtimeMs = Date.now() - t0;
    console.log(`FAIL ${c.id}: ${rec.error}`);
  }
  await writeFile(resolve(liveDir, `case-${c.id}.json`), JSON.stringify(rec, null, 2) + "\n", "utf8");
  summary.push({ caseId: c.id, status: rec.status, frame: rec.nativeFrameId ?? null, findings: (rec.structuralFindings ?? []).length });
}

console.log(JSON.stringify({ done: true, ms: Date.now() - runStarted, summary }, null, 2));
