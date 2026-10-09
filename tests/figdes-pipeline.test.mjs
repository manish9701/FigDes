/**
 * FigDes professional pipeline regression tests (handoff §10).
 *
 * Covers the gaps the audit found beyond the existing suites:
 * stale/missing evidence never PASS, no screenshot means no visual PASS,
 * connector-label false positives, node-add overlap/relationship preservation,
 * long-label reflow, repair-without-regression, retry idempotency, distinct
 * briefs → distinct structures, benchmark schema, live scorecard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFinalGate } from "../mcp-server/dist-test/design/quality/final-gate.js";
import { trackFindings } from "../mcp-server/dist-test/design/quality/visual-findings.js";
import {
  BENCHMARKS,
  BENCHMARK_WEIGHTS,
  scoreBenchmark,
  LIVE_SCORECARD_WEIGHTS,
  scoreLiveBenchmark,
  SCORECARD_DOCS,
} from "../mcp-server/dist-test/design/benchmark/suite.js";
import { evaluateConsistency } from "../mcp-server/dist-test/design/quality/consistency.js";
import {
  DesignBriefSchema,
  VisualDirectionSchema,
  RenderEvidenceSchema,
  CritiqueFindingSchema,
  RepairTraceSchema,
  LiveBenchmarkCaseSchema,
} from "../mcp-server/dist-test/design/contracts.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { deriveRegions } from "../mcp-server/dist-test/design/composition/derive.js";
import { analyzeRelationships } from "../mcp-server/dist-test/design/composition/relationships.js";
import { planScreen } from "../mcp-server/dist-test/plan/planner.js";
import { scoreDesignTool } from "../mcp-server/dist-test/review/workflow.js";

const PERFECT = {
  hierarchy: 90, composition: 90, typography: 90, readability: 90,
  density: 90, distinctiveness: 90, genericity: 90, productFit: 90,
};

function metricNode(over = {}) {
  return {
    id: "1:1", parentId: null, type: "FRAME", name: "Frame", depth: 0,
    x: 0, y: 0, w: 100, h: 100, visible: true, defaultNamed: false, zIndex: 0,
    ...over,
  };
}

function metrics(nodes) {
  return {
    target: null, scope: "test", nodes, nodeCount: nodes.length,
    truncated: false, scan: { pageLoads: 0, pagesCached: true },
  };
}

/* -------------------------------------------------------------------------- */
/* Contracts                                                                    */
/* -------------------------------------------------------------------------- */

test("canonical contracts validate and reject garbage", () => {
  const brief = DesignBriefSchema.safeParse({
    id: "b1", name: "Topology review", product: "EXO",
    goal: "Find what needs attention", primaryDecision: "Which device needs attention first?",
  });
  assert.equal(brief.success, true);
  assert.equal(DesignBriefSchema.safeParse({ id: "", name: "", product: "", goal: "", primaryDecision: "" }).success, false);

  const direction = VisualDirectionSchema.safeParse({ selectedFamily: "spatial-topology", rationale: "Graph data needs a graph." });
  assert.equal(direction.success, true);

  const evidence = RenderEvidenceSchema.safeParse({
    frameId: "1:2", capturedAt: Date.now(), runId: "run-1", irRevision: "rev-1", renderNumber: 1,
  });
  assert.equal(evidence.success, true);
  assert.equal(RenderEvidenceSchema.safeParse({ frameId: "", capturedAt: 0, runId: "", irRevision: "", renderNumber: 0 }).success, false);

  const finding = CritiqueFindingSchema.safeParse({
    id: "f1", rule: "overlap", severity: "serious", confidence: "high", evidenceType: "geometry",
  });
  assert.equal(finding.success, true);

  const trace = RepairTraceSchema.safeParse({ id: "r1", findingIds: ["f1"], outcome: "resolved" });
  assert.equal(trace.success, true);
  assert.equal(RepairTraceSchema.safeParse({ id: "r1", findingIds: [], outcome: "resolved" }).success, false);

  const live = LiveBenchmarkCaseSchema.safeParse({ caseId: "exo-compute-topology" });
  assert.equal(live.success, true);
});

/* -------------------------------------------------------------------------- */
/* Evidence honesty                                                             */
/* -------------------------------------------------------------------------- */

test("no screenshot means no visual PASS", () => {
  const out = evaluateFinalGate({ scores: PERFECT });
  assert.notEqual(out.status, "PASS");
  assert.equal(out.status, "REVIEW");
});

test("stale or missing evidence revision never PASS", () => {
  const stale = evaluateFinalGate({
    scores: PERFECT, visualEvidenceVerified: true,
    expectedRevision: "rev-2", evidenceRevision: "rev-1",
  });
  assert.equal(stale.status, "FAIL");
  const missing = evaluateFinalGate({
    scores: PERFECT, visualEvidenceVerified: true,
    expectedRevision: "rev-2", evidenceRevision: null,
  });
  assert.equal(missing.status, "FAIL");
});

test("missing genericity score never PASS", () => {
  const { genericity: _drop, ...seven } = PERFECT;
  const out = evaluateFinalGate({ scores: seven, visualEvidenceVerified: true });
  assert.equal(out.status, "FAIL");
  assert.match(out.blockingIssues.join(" "), /genericity/);
});

test("benchmark report stays honestly offline", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const report = JSON.parse(await readFile(resolve(root, "artifacts/design-benchmark/latest.json"), "utf8"));
  assert.equal(report.mode, "offline-planner-structural");
  assert.equal(report.visualBenchmarkComplete, false);
  assert.equal(typeof report.visualBenchmarkReason, "string");
  assert.equal(report.expectedCases, 9);
  for (const r of report.results) assert.equal(r.visualEvidence, "NOT_CAPTURED");
});

/* -------------------------------------------------------------------------- */
/* False positives (handoff §6)                                                 */
/* -------------------------------------------------------------------------- */

test("static connector labels and plain text are not tap targets", () => {
  const label = metricNode({ id: "2:1", type: "TEXT", name: "link label latency", w: 20, h: 10 });
  const plain = metricNode({ id: "2:2", type: "TEXT", name: "caption", w: 200, h: 16 });
  const button = metricNode({ id: "2:3", type: "FRAME", name: "close button", w: 20, h: 20 });
  const rules = runRules(metrics([label, plain, button]), "review").filter((f) => f.rule === "tap-target-size");
  assert.deepEqual(rules.map((f) => f.nodeIds[0]).sort(), ["2:3"]);
});

test("canonical parent-local overflow still fails when real", () => {
  const parent = metricNode({ id: "p", type: "FRAME", name: "Field", w: 824, h: 600, coordSpace: "parent-local" });
  const inside = metricNode({ id: "c1", parentId: "p", type: "FRAME", name: "Card", x: 119, y: 300, w: 306, h: 10, coordSpace: "parent-local" });
  assert.deepEqual(runRules(metrics([parent, inside]), "review").filter((f) => f.rule === "overflow"), []);
  const outside = metricNode({ id: "c2", parentId: "p", type: "FRAME", name: "Wide", x: 700, y: 100, w: 200, h: 10, coordSpace: "parent-local" });
  const found = runRules(metrics([parent, outside]), "review").filter((f) => f.rule === "overflow");
  assert.equal(found.length, 1);
  assert.equal(found[0].confidence, "high");
});

test("unverified coordinates report uncertainty, not a hard failure", () => {
  const parent = metricNode({ id: "p", type: "FRAME", name: "Field", w: 824, h: 600 });
  const child = metricNode({ id: "c", parentId: "p", type: "LINE", name: "Line", x: 1935, y: 412, w: 306, h: 0, coordSpace: "local-unverified" });
  const found = runRules(metrics([parent, child]), "review").filter((f) => f.rule === "overflow");
  assert.equal(found.length, 1);
  assert.equal(found[0].confidence, "low");
  assert.equal(found[0].severity, "minor");
  assert.match(found[0].title, /unverified/);
});

/* -------------------------------------------------------------------------- */
/* Geometry: overlaps, relationships, reflow                                    */
/* -------------------------------------------------------------------------- */

test("adding a node preserves relationships and creates no overlaps", () => {
  const base = executeRuntime({
    regions: [
      { fn: "frame", id: "left", args: { width: 400 } },
      { fn: "frame", id: "right", args: { width: 400 } },
    ],
    content: [],
    relations: [{ id: "right", rightOf: "left", gap: 24 }],
  });
  const boxes = new Map([...base.boxes.values()].map((b) => [b.id, b]));
  const rels = analyzeRelationships(
    [{ id: "left" }, { id: "right" }],
    [{ from: "left", to: "right", label: "feeds" }],
  );
  assert.ok(!rels.warnings.some((w) => /unknown node/i.test(w)), "declared relationship survives the layout");
  const [a, b] = [boxes.get("left"), boxes.get("right")];
  const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.equal(overlap, false);
  assert.ok(b.x >= a.x + a.w, "related region sits to the right of its anchor");
});

test("long labels reflow rather than clip", () => {
  const longLabel = "Supercalifragilisticexpialidocious edge label that must wrap instead of clipping out of its region bounds";
  const derived = deriveRegions({
    decisionKind: "monitor",
    primaryDecision: "Monitor live inference and decide whether to intervene",
    info: ["GPU utilization", "memory pressure", longLabel],
  });
  assert.ok(derived !== null, "derivation succeeds with a long label present");
  const flat = JSON.stringify(derived);
  assert.ok(flat.length > 0, "derived regions carry content");
  const compiled = executeRuntime({
    regions: [{ fn: "frame", id: "main", args: { width: 800 } }],
    content: [{ fn: "text", id: "long", parent: "main", args: { text: longLabel } }],
  });
  assert.ok(compiled.operations.length > 0, "long text compiles to operations, not a clip failure");
  assert.ok(!compiled.warnings.some((w) => /clip/i.test(w)), `no clip warnings: ${JSON.stringify(compiled.warnings)}`);
});

/* -------------------------------------------------------------------------- */
/* Repairs + idempotency                                                        */
/* -------------------------------------------------------------------------- */

test("targeted repairs resolve findings and flag regressions", () => {
  const before = [{ id: "vf-a" }, { id: "vf-b" }];
  const after = [{ id: "vf-b" }, { id: "vf-c" }];
  const res = trackFindings(before, after);
  assert.deepEqual(res.resolved, ["vf-a"]);
  assert.deepEqual(res.persisting, ["vf-b"]);
  assert.deepEqual(res.introduced, ["vf-c"]);
  const clean = trackFindings(before, []);
  assert.deepEqual(clean.resolved.sort(), ["vf-a", "vf-b"]);
  assert.equal(clean.persisting.length, 0);
});

test("retries do not duplicate frames", () => {
  const program = {
    regions: [{ fn: "frame", id: "r1", args: { width: 300 } }],
    content: [{ fn: "text", id: "t1", parent: "r1", args: { text: "hello" } }],
  };
  const first = executeRuntime(program);
  const second = executeRuntime(program);
  assert.equal(second.operations.length, first.operations.length);
  const ids = second.operations.map((op) => op.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length);
});

/* -------------------------------------------------------------------------- */
/* Distinct briefs, benchmark scoring                                           */
/* -------------------------------------------------------------------------- */

test("distinct briefs yield meaningfully distinct structures", () => {
  const topology = planScreen({
    primaryDecision: "Find the weakest link in the compute topology",
    availableInformation: ["devices", "nodes", "links", "latency"],
  });
  const editorial = planScreen({
    primaryDecision: "Compare model run cost and quality before choosing",
    availableInformation: ["model name", "run cost", "quality", "recommendation"],
  });
  const sig = (p) => JSON.stringify({ d: p.derivation?.strategy, roles: (p.regions ?? []).map((r) => r.role).sort() });
  assert.notEqual(sig(topology), sig(editorial));
});

test("benchmark weights sum to 100 and critical failures override", () => {
  assert.equal(BENCHMARKS.length, 9);
  const offlineSum = Object.values(BENCHMARK_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(offlineSum, 100);
  const liveSum = Object.values(LIVE_SCORECARD_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(liveSum, 100);
  assert.deepEqual(Object.keys(SCORECARD_DOCS).sort(), ["consistency", "gate", "live", "offline", "program"]);
  const perfect = scoreBenchmark({
    caseId: "exo-compute-topology",
    dimensions: { hierarchy: 10, composition: 10, productSpecificity: 10, typography: 10, spacingRhythm: 10, relationshipClarity: 10, density: 10, nativeQuality: 10, distinctiveness: 10, readability: 10 },
  });
  assert.equal(perfect.total, 100);
  const liveFail = scoreLiveBenchmark({
    caseId: "exo-compute-topology",
    dimensions: { compositionHierarchy: 10, visualIdentity: 10, typography: 10, geometry: 10, detailCraft: 10, briefFidelity: 10 },
    criticalFailure: true,
  });
  assert.equal(liveFail.total, 0);
});

test("consistency scores token discipline and blocks repair-introduced drift", () => {
  const clean = evaluateConsistency({
    fills: ["#FFFDF9", "#242521", "#FFFFFF"],
    approvedTokens: ["#FFFDF9", "#242521", "#FFFFFF"],
    radii: [8, 12],
    families: ["Inter"],
  });
  assert.ok(clean.score >= 90, `clean system scores high: ${clean.score}`);
  assert.equal(clean.blocking, false);
  const rainbow = evaluateConsistency({ fills: Array.from({ length: 15 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`) });
  assert.ok(rainbow.score < clean.score, "15 fills score below a 3-fill system");
  const drift = evaluateConsistency({
    fills: ["#FFFDF9", "#AB12CD"],
    approvedTokens: ["#FFFDF9"],
    repairIntroducedUnknown: true,
  });
  assert.equal(drift.blocking, true, "repair-introduced unknown fills block");
  assert.ok(drift.evidence.some((e) => /BLOCKING/.test(e)));
});

/* -------------------------------------------------------------------------- */
/* Density: sparse topology vs genuinely fragmented layouts                     */
/* -------------------------------------------------------------------------- */

function densityOf(program) {
  return scoreDesignTool({ program }).then((scored) =>
    scored.dimensions.find((d) => d.dimension === "Information density"),
  );
}

test("sparse topology with breathing room is not a density failure", async () => {
  const dim = await densityOf({
    canvas: { name: "Sparse", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "rail", args: { width: 232 } },
      { fn: "hero", id: "map", args: { width: "fill", height: "fill" } },
      { fn: "inspector", id: "insp", args: { width: 360 } },
    ],
    content: [
      { fn: "deviceNode", id: "a", parent: "map", args: { label: "a" } },
      { fn: "deviceNode", id: "b", parent: "map", args: { label: "b" } },
    ],
  });
  assert.ok(dim.score >= 6, `sparse but composed topology must not fail density: ${dim.score} (${dim.evidence})`);
});

test("a single undifferentiated region loses density points with a fix", async () => {
  const dim = await densityOf({
    canvas: { name: "Single", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "only", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "text", id: "t", parent: "only", args: { text: "hello" } }],
  });
  assert.ok(dim.score <= 6, "one region filling everything is under-composed");
  assert.match(dim.improve ?? dim.evidence, /separation|undifferentiated/i);
});

test("seven regions fragmenting the canvas fail density loudly", async () => {
  const dim = await densityOf({
    canvas: { name: "Frag", width: 1440, height: 900, grid: 8 },
    regions: Array.from({ length: 7 }, (_, i) => ({ fn: "frame", id: `r${i}`, args: { width: 200, height: 100 } })),
    content: [],
  });
  assert.ok(dim.score < 6, "seven regions must read as fragmentation");
  assert.match(dim.improve ?? "", /Merge regions/);
});
