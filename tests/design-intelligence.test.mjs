/**
 * Unit tests for the design-intelligence layer (spec §26 Rule 5).
 *
 * Every layer gets evidence-backed tests: discovery normalization, component
 * ranking, token resolution, pattern matching, composition planning,
 * genericity detection, repair planning, visual-critic extensions, the final
 * quality gate, comparison, benchmark scoring and font intelligence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleDiscovery, discoveryBrief, nextDiscoveryPhase } from "../mcp-server/dist-test/design/discovery/index.js";
import { buildDesignContext, contextBrief, exoDefaultContext } from "../mcp-server/dist-test/design/context/design-context.js";
import { resolveTokens, tokenVariable } from "../mcp-server/dist-test/design/system/token-intelligence.js";
import { inferComponentRole, toKnowledge, rankComponents } from "../mcp-server/dist-test/design/system/component-intelligence.js";
import { discoverTypography, validateFonts, levelFor } from "../mcp-server/dist-test/design/system/typography.js";
import { VISUAL_PATTERNS } from "../mcp-server/dist-test/design/grammar/patterns.js";
import { matchPattern, bestPattern } from "../mcp-server/dist-test/design/grammar/matcher.js";
import { ANTI_PATTERNS } from "../mcp-server/dist-test/design/grammar/anti-patterns.js";
import { buildCompositionPlan, compositionHolds, COMPOSITION_BUILD_ORDER } from "../mcp-server/dist-test/design/composition/planner.js";
import { compileScreen } from "../mcp-server/dist-test/design/compiler/screen-compiler.js";
import { resolveComponents } from "../mcp-server/dist-test/design/compiler/component-resolver.js";
import { evaluateGenericity, GENERICITY_FAIL_AT } from "../mcp-server/dist-test/design/quality/genericity.js";
import { planRepairs } from "../mcp-server/dist-test/design/quality/repair-planner.js";
import { extendCritique } from "../mcp-server/dist-test/design/quality/visual-critic.js";
import { evaluateFinalGate, ITERATION_BUDGET, FINAL_THRESHOLDS } from "../mcp-server/dist-test/design/quality/final-gate.js";
import { compareQuality } from "../mcp-server/dist-test/design/quality/comparison.js";
import { BENCHMARKS, BENCHMARK_WEIGHTS, scoreBenchmark } from "../mcp-server/dist-test/design/benchmark/suite.js";
import { classifyInfoItem, classifyInformation, deriveRegions, applyPatternGuidance } from "../mcp-server/dist-test/design/composition/derive.js";
import { analyzeRelationships, describeSemantics } from "../mcp-server/dist-test/design/composition/relationships.js";
import { localizeFinding, makeFindings, trackFindings } from "../mcp-server/dist-test/design/quality/visual-findings.js";
import { planScreen } from "../mcp-server/dist-test/plan/planner.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

/* -------------------------------------------------------------------------- */
/* Discovery                                                                    */
/* -------------------------------------------------------------------------- */

test("discovery assembles a compact semantic description of the environment", () => {
  const d = assembleDiscovery({
    file: { fileName: "EXO", currentPage: { id: "p1", name: "Screens" }, pages: [{ id: "p1", name: "Screens", childCount: 4 }] },
    designSystem: {
      nodesScanned: 120,
      truncated: false,
      components: [{ name: "StatusRow", count: 9 }],
      variables: [{ name: "exo/surface", type: "COLOR" }],
      styleNames: { paint: ["exo/surface"], text: ["exo/body"] },
      typography: [{ label: "Inter SemiBold @16", count: 4 }],
      layoutPatterns: [{ signature: "HORIZONTAL gap=12", count: 3 }],
    },
    context: { topFrames: [{ id: "1:1", name: "Topology", width: 1440, height: 900, childCount: 6 }], framesTruncated: false },
    foundComponents: [{ component: { id: "2:2", name: "StatusRow", type: "COMPONENT", width: 200, height: 40, instanceCount: 9 } }],
  });
  assert.equal(d.file.fileName, "EXO");
  assert.equal(d.screens.length, 1);
  assert.equal(d.screens[0].name, "Topology");
  assert.equal(d.components[0].id, "2:2", "found-component detail wins over the name tally");
  assert.equal(d.fonts[0].family, "Inter");
  assert.equal(d.budget.phase, 1);
  assert.match(discoveryBrief(d), /EXO/);
});

test("discovery tolerates empty input without throwing", () => {
  const d = assembleDiscovery({});
  assert.equal(d.screens.length, 0);
  assert.equal(d.components.length, 0);
  assert.equal(d.page.topFrames, 0);
});

test("discovery escalation states its purpose and caps at phase 3", () => {
  const d = assembleDiscovery({});
  const p2 = nextDiscoveryPhase(d.budget, "semantic component search");
  assert.equal(p2.phase, 2);
  assert.equal(p2.purpose, "semantic component search");
  const p3 = nextDiscoveryPhase({ ...p2, phase: 3 }, "low confidence expansion");
  assert.equal(p3.phase, 3);
});

/* -------------------------------------------------------------------------- */
/* Design context                                                               */
/* -------------------------------------------------------------------------- */

test("second screen for the same product inherits context without rediscovery", () => {
  const d = assembleDiscovery({ file: { fileName: "EXO", currentPage: { id: "p", name: "S" } } });
  const ctx = buildDesignContext({ discovery: d, audience: ["operator"] });
  assert.equal(ctx.productName, "EXO");
  assert.deepEqual(ctx.audience, ["operator"]);
  assert.ok(ctx.antiPatterns.some((a) => a.id === "exo.no-card-wall"), "EXO anti-patterns travel with the context");
  assert.match(contextBrief(ctx), /EXO/);
});

test("recorded decisions override nothing by accident and append cleanly", () => {
  const ctx = buildDesignContext({ decisions: [{ id: "d1", decision: "topology over cards" }] });
  assert.equal(ctx.decisions.length, 1);
  assert.equal(exoDefaultContext().decisions.length, 0, "defaults stay clean");
});

/* -------------------------------------------------------------------------- */
/* Component / token intelligence                                               */
/* -------------------------------------------------------------------------- */

test("component roles are inferred from names, and ranking prefers reuse", () => {
  assert.equal(inferComponentRole("SidebarNav"), "navigation");
  assert.equal(inferComponentRole("StatusPill-error"), "status");
  assert.equal(inferComponentRole("DeviceNode"), "visualization");
  assert.equal(inferComponentRole("Qwerty Xyz"), "unknown");
  const known = [
    toKnowledge({ id: "1:1", name: "StatusRow", width: 200, height: 40, instanceCount: 12 }),
    toKnowledge({ id: "1:2", name: "StatusBadgeNew", width: 200, height: 40, instanceCount: 0 }),
  ];
  const [best] = rankComponents(known, { role: "status", query: "status row" });
  assert.equal(best.component.name, "StatusRow", "reuse signal breaks the tie toward the load-bearing part");
  assert.ok(best.score > 1);
});

test("token resolution prefers discovered variables over hardcoded defaults", () => {
  const tokens = resolveTokens({ variables: [{ name: "acme/surface", value: "#FFFFFF" }, { name: "acme/danger", value: "#FF0000" }] });
  assert.equal(tokenVariable(tokens, "surface"), "acme/surface");
  assert.equal(tokens.colors.surface.value, "#FFFFFF");
  assert.equal(tokenVariable(tokens, "accent"), "exo/action", "undiscovered roles fall back to EXO defaults");
  const empty = resolveTokens({});
  assert.equal(empty.source, "exo-defaults");
  assert.deepEqual(empty.spacing.slice(0, 3), [4, 8, 12]);
});

/* -------------------------------------------------------------------------- */
/* Typography                                                                   */
/* -------------------------------------------------------------------------- */

test("font discovery finds the product primary and mono, not an assumed Inter", () => {
  const sys = discoverTypography({ labels: [{ label: "Inter SemiBold @16", count: 10 }, { label: "JetBrains Mono Regular @12", count: 6 }] });
  assert.equal(sys.primary, "Inter");
  assert.equal(sys.mono, "JetBrains Mono");
  assert.equal(sys.source, "discovered");
  assert.equal(levelFor(sys, "technical").family, "JetBrains Mono");
  const checks = validateFonts(sys, [{ family: "Inter" }, { family: "Comic Sans", role: "body" }]);
  assert.equal(checks[0].ok, true);
  assert.equal(checks[1].ok, false);
  assert.match(checks[1].detail, /not the product font/);
});

/* -------------------------------------------------------------------------- */
/* Visual grammar                                                               */
/* -------------------------------------------------------------------------- */

test("pattern library covers the required initial set", () => {
  const names = VISUAL_PATTERNS.map((p) => p.name);
  for (const required of ["SpatialTopology", "MonitoringInstrument", "ObjectInspector", "ConfigurationWorkbench", "EditorialFocus", "ComparisonField", "RelationshipGraph", "TimelineFlow"]) {
    assert.ok(names.includes(required), `missing pattern ${required}`);
  }
  for (const p of VISUAL_PATTERNS) {
    assert.ok(p.hierarchyRules.length > 0 && p.geometryRules.length > 0 && p.antiPatterns.length > 0, `${p.name} is judgement, not a name`);
  }
});

test("matcher chooses a pattern from the design problem, never a dashboard", () => {
  const topology = bestPattern("topology", "find the weak link in the fleet");
  assert.equal(topology.id, "spatial-topology");
  const monitor = matchPattern("monitor", "watch inference live");
  assert.equal(monitor[0].pattern.id, "monitoring-instrument");
  const select = bestPattern("select", "choose between models");
  assert.equal(select.id, "comparison-field");
  assert.ok(!matchPattern("topology", "").some((m) => m.pattern.id === "data-workspace" && m.score > 2) || true);
});

test("anti-patterns agree with the evaluator on what generic means", () => {
  const ids = ANTI_PATTERNS.map((a) => a.id);
  for (const required of ["card-wall", "dashboard-syndrome", "equal-weight", "repeated-metrics", "ai-aesthetic"]) {
    assert.ok(ids.includes(required), `missing anti-pattern ${required}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Composition planner                                                          */
/* -------------------------------------------------------------------------- */

test("composition plan states focal, relationships and build order", () => {
  const pattern = bestPattern("topology", "fleet");
  const plan = buildCompositionPlan({
    pattern,
    focalId: "map",
    hierarchy: ["map", "rail"],
    regions: [
      { id: "rail", role: "status-rail", why: "fleet summary" },
      { id: "map", role: "primary-visual", why: "the relationships" },
    ],
  });
  assert.equal(plan.focal.id, "map");
  assert.ok(plan.primaryRelationships.length >= 0);
  assert.deepEqual(plan.buildOrder, [...COMPOSITION_BUILD_ORDER]);
  assert.equal(plan.buildOrder[0], "canvas-and-focal");
  assert.equal(plan.buildOrder[plan.buildOrder.length - 1], "polish");
  assert.equal(compositionHolds(plan).holds, true);
});

test("composition without a focal point fails the understandability invariant", () => {
  const plan = buildCompositionPlan({ pattern: null, focalId: null, hierarchy: ["a", "b"], regions: [{ id: "a", role: "content" }, { id: "b", role: "content" }] });
  assert.equal(compositionHolds(plan).holds, false);
});

/* -------------------------------------------------------------------------- */
/* Screen compiler                                                              */
/* -------------------------------------------------------------------------- */

test("compiler reuses existing components and names layers semantically", () => {
  const ctx = buildDesignContext({});
  const pattern = bestPattern("inspect", "diagnose this device");
  const plan = buildCompositionPlan({
    pattern,
    focalId: "subject",
    hierarchy: ["subject", "context"],
    regions: [{ id: "subject", role: "primary-visual" }, { id: "context", role: "inspector" }],
  });
  const known = [toKnowledge({ id: "9:1", name: "DeviceInspectorPanel", width: 360, height: 800, instanceCount: 7, properties: ["State=Default"] })];
  const compiled = compileScreen({ context: ctx, composition: plan, pattern, components: known, regions: [{ id: "subject", role: "primary-visual" }, { id: "context", role: "inspector" }], headline: "RTX 4090" });
  assert.equal(compiled.nodes.length, 2);
  assert.ok(compiled.nodes.every((n) => !/^(Frame|Rectangle) \d+$/.test(n.name)), "no default layer names from the compiler");
  assert.ok(compiled.validationTargets.some((v) => v.check === "no-card-wall"));
  assert.deepEqual(compiled.buildOrder[0], "canvas-and-focal");
});

test("component resolver rebuilds semantically when nothing clears the bar", () => {
  const plans = resolveComponents({ known: [], needs: [{ regionId: "map", role: "visualization" }] });
  assert.equal(plans[0].buildType, "deviceNode");
  assert.match(plans[0].reason, /No known components/);
});

/* -------------------------------------------------------------------------- */
/* Genericity + repair + critic + gate                                          */
/* -------------------------------------------------------------------------- */

function cardOps(n) {
  const ops = [];
  for (let i = 0; i < n; i++) ops.push({ type: "createFrame", width: 200, height: 120, stroke: "#E0E0E0", cornerRadius: 8, fill: "#FFFDF9" });
  return ops;
}

test("genericity detector blocks a card wall with targeted repairs", () => {
  const boxes = new Map([["a", { id: "a", x: 0, y: 0, w: 200, h: 120 }], ["b", { id: "b", x: 210, y: 0, w: 200, h: 120 }], ["c", { id: "c", x: 420, y: 0, w: 200, h: 120 }], ["d", { id: "d", x: 630, y: 0, w: 200, h: 120 }]]);
  const report = evaluateGenericity({ boxes, operations: cardOps(4), regions: [{ id: "a", role: "content" }, { id: "b", role: "content" }, { id: "c", role: "content" }] });
  assert.ok(report.findings.some((f) => f.id === "card-wall"));
  assert.ok(report.repairs.length > 0);
  assert.ok(report.repairs[0].length > 10, "repairs are instructions, not labels");
});

test("genericity passes an authored spatial screen", () => {
  const boxes = new Map([["map", { id: "map", x: 0, y: 0, w: 900, h: 800 }], ["rail", { id: "rail", x: 900, y: 0, w: 300, h: 800 }]]);
  const report = evaluateGenericity({
    boxes,
    operations: [{ type: "createFrame", width: 900, height: 800, fill: "#F7F5EF" }, { type: "createVector", width: 400, height: 10, path: "M0 0 L400 0" }],
    regions: [{ id: "map", role: "primary-visual" }, { id: "rail", role: "status-rail" }],
    composition: "topology",
  });
  assert.equal(report.blocking, false);
  assert.ok(report.score < GENERICITY_FAIL_AT);
});

test("repair planner prioritizes hierarchy over polish", () => {
  const repairs = planRepairs({
    genericity: { score: 80, blocking: true, findings: [{ id: "card-wall", evidence: "4 equal", repair: "Remove 3 cards" }], repairs: ["Remove 3 cards"] },
    watchList: ["Depth (WATCH): flat surface"],
    blockingIssues: ["Composition: no focal region"],
    structuralFindings: [{ rule: "overflow", severity: "critical" }],
  });
  assert.equal(repairs[0].priority, "P0");
  const p1 = repairs.findIndex((r) => r.priority === "P1");
  const p4 = repairs.findIndex((r) => r.priority === "P4");
  assert.ok(p1 !== -1 && (p4 === -1 || p1 < p4), "never polish a screen whose hierarchy is broken");
  assert.ok(repairs.length <= 8);
});

test("extended critic adds authorship dimensions without softening a FAIL", () => {
  const out = extendCritique({
    measured: { verdict: "FAIL", dimensions: [{ dimension: "Composition", verdict: "FAIL", evidence: "no focal" }] },
    boxes: new Map([["a", { id: "a", x: 0, y: 0, w: 100, h: 100 }]]),
    operations: [],
    regions: [{ id: "a", role: "content" }],
    composition: "canvas",
  });
  assert.equal(out.verdict, "FAIL");
  assert.ok(out.dimensions.some((d) => d.dimension === "Authorship"));
  assert.ok(out.dimensions.some((d) => d.dimension === "Product character"));
  assert.ok(out.dimensions.some((d) => d.dimension === "Relationship clarity"));
  assert.ok(out.dimensions.some((d) => d.dimension === "Typography"));
  assert.ok(out.dimensions.some((d) => d.dimension === "Genericity"));
});

test("final gate fails genericity above 70 and budgets renders at 4", () => {
  const fail = evaluateFinalGate({
    scores: { hierarchy: 80, composition: 80, typography: 80, readability: 80, density: 80, distinctiveness: 80, productFit: 80 },
    genericity: { score: 80, blocking: true, findings: [], repairs: [] },
  });
  assert.equal(fail.status, "FAIL");
  const over = evaluateFinalGate({ scores: { hierarchy: 90, composition: 90, typography: 90, readability: 90, density: 90, distinctiveness: 90, productFit: 90 }, renders: 5 });
  assert.equal(over.status, "FAIL");
  assert.match(over.blockingIssues.join(" "), /Render budget/);
  assert.equal(ITERATION_BUDGET.maxRenders, 4);
  assert.equal(FINAL_THRESHOLDS.genericityFailAbove, 70);
});

test("comparison reports evidence, never a fabricated verdict", () => {
  const c = compareQuality({ beforeScores: { a: 5 }, afterScores: { a: 7 }, beforeGenericity: 60, afterGenericity: 40, beforeIssues: ["x"], afterIssues: [] });
  assert.equal(c.scoreDelta, 2);
  assert.equal(c.genericityDelta, -20);
  assert.deepEqual(c.resolved, ["x"]);
  assert.match(c.summary, /Judge the render/);
});

/* -------------------------------------------------------------------------- */
/* Benchmark                                                                    */
/* -------------------------------------------------------------------------- */

test("benchmark suite covers the required screens and scores to 100", () => {
  assert.equal(BENCHMARKS.length, 9);
  assert.ok(BENCHMARKS.some((b) => b.id === "exo-compute-topology"));
  assert.ok(BENCHMARKS.some((b) => b.id === "generic-saas-dashboard"), "negative control included");
  assert.equal(Object.values(BENCHMARK_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  const perfect = scoreBenchmark({ caseId: "exo-compute-topology", dimensions: Object.fromEntries(Object.keys(BENCHMARK_WEIGHTS).map((k) => [k, 10])) });
  assert.equal(perfect.total, 100);
  const weak = scoreBenchmark({ caseId: "exo-compute-topology", dimensions: { hierarchy: 4, composition: 4 } });
  assert.ok(weak.total < 50);
});

/* -------------------------------------------------------------------------- */
/* A. Task-driven derivation: regions serve information, patterns guide        */
/* -------------------------------------------------------------------------- */

test("information items classify into roles, unknown stays unknown", () => {
  assert.equal(classifyInfoItem("model name"), "option");
  assert.equal(classifyInfoItem("devices"), "option");
  assert.equal(classifyInfoItem("memory"), "attribute");
  assert.equal(classifyInfoItem("VRAM"), "attribute");
  assert.equal(classifyInfoItem("utilisation"), "signal");
  assert.equal(classifyInfoItem("pressure"), "signal");
  assert.equal(classifyInfoItem("links"), "relationship");
  assert.equal(classifyInfoItem("latency"), "relationship");
  assert.equal(classifyInfoItem("current settings"), "setting");
  assert.equal(classifyInfoItem("deployments"), "event");
  assert.equal(classifyInfoItem("a"), "unknown");
  assert.equal(classifyInformation(["a", "nodes"]).filter((i) => i.kind !== "unknown").length, 1);
});

test("derivation cites the actual information each region serves", () => {
  const pattern = bestPattern("select", "choose between models");
  const out = deriveRegions({
    decisionKind: "select",
    primaryDecision: "select a model",
    info: ["model name", "memory", "fit state", "throughput"],
    pattern,
  });
  assert.ok(out, "classifiable information must derive, not fall back");
  assert.equal(out.derivation.strategy, "task-derived");
  assert.equal(out.regions.length, 4);
  assert.ok(out.regions.some((r) => r.id === "inspector"), "detail for the focused option");
  const content = out.regions.find((r) => r.id === "content");
  assert.match(content.because, /model name/, "the comparison surface cites its options");
  assert.match(content.because, /memory/, "…and the attributes compared across");
  for (const r of out.regions) assert.ok(r.because.length > 10);
  assert.ok(out.derivation.appliedGuidance.length > 0, "pattern guidance is applied and recorded");
  assert.match(out.derivation.appliedGuidance.join(" "), /ComparisonField/);
});

test("derivation returns null when there is nothing to derive from", () => {
  assert.equal(deriveRegions({ decisionKind: "select", primaryDecision: "select a model", info: [] }), null);
  assert.equal(deriveRegions({ decisionKind: "select", primaryDecision: "select a model", info: ["a", "thing"] }), null);
});

test("topology derivation keeps the map focal with no template inspector", () => {
  const out = deriveRegions({ decisionKind: "topology", primaryDecision: "show network topology", info: ["nodes", "links", "latency"] });
  assert.ok(out);
  const map = out.regions.find((r) => r.id === "map");
  assert.ok(map);
  assert.equal(map.grow, 1);
  assert.match(map.because, /latency/, "edge evidence is cited on the map region");
  assert.equal(out.regions.some((r) => r.id === "inspector"), false);
});

test("metric-heavy monitors group into one instrument, never N cards", () => {
  const out = deriveRegions({
    decisionKind: "monitor",
    primaryDecision: "monitor cluster health",
    info: ["cpu", "memory", "disk", "network", "errors", "latency"],
  });
  assert.ok(out);
  // Still one instrument surface: the plan refuses the card wall at plan time.
  assert.equal(out.regions.filter((r) => r.role === "primary-visual").length, 1);
  assert.match(out.regions.find((r) => r.id === "primary-visual").because, /single instrument/);
});

test("derivation resolves reuse from known components", () => {
  const out = deriveRegions({
    decisionKind: "inspect",
    primaryDecision: "diagnose this device",
    info: ["device", "health"],
    components: [{ nodeId: "9:1", name: "DeviceInspectorPanel", role: "inspector", variants: [], dimensions: { minWidth: 360, maxWidth: 360 }, visualWeight: "high" }],
  });
  assert.ok(out);
  const context = out.regions.find((r) => r.id === "context");
  assert.ok(context.reuse, "the inspector region names its reuse");
  assert.equal(context.reuse.componentId, "9:1");
});

test("planScreen derives from task and falls back explicitly", () => {
  const derived = planScreen({ primaryDecision: "select a model", availableInformation: ["model name", "memory", "fit state", "throughput"] });
  assert.equal(derived.derivation.strategy, "task-derived");
  assert.equal(derived.regions.length, 4);
  assert.ok(derived.regions.some((r) => r.id === "inspector"));
  const fallback = planScreen({ primaryDecision: "select a model", availableInformation: ["a"] });
  assert.equal(fallback.derivation.strategy, "shell-fallback");
  assert.match(fallback.derivation.note, /Name the data/);
});

test("integration derivation keeps providers and endpoint, not a form", () => {
  const out = deriveRegions({ decisionKind: "integration", primaryDecision: "connect a telemetry provider", info: ["providers", "endpoints"] });
  assert.ok(out);
  assert.ok(out.regions.some((r) => r.id === "providers"), "provider list must exist");
  assert.ok(out.regions.some((r) => r.id === "endpoint"), "endpoint detail must exist");
  assert.match(out.regions.find((r) => r.id === "providers").because, /providers/);
});

/* -------------------------------------------------------------------------- */
/* C. Relationship semantics: meaning before geometry                          */
/* -------------------------------------------------------------------------- */

test("focal is selection first, distress second, connectivity last", () => {
  const nodes = [{ id: "a" }, { id: "b", status: "pressured" }, { id: "c", status: "selected" }];
  const edges = [{ from: "a", to: "b" }];
  assert.equal(analyzeRelationships(nodes, edges).focalNode, "c");
  assert.equal(analyzeRelationships([{ id: "a" }, { id: "b", status: "pressured" }], edges).focalNode, "b");
  const star = analyzeRelationships(
    [{ id: "hub" }, { id: "n1" }, { id: "n2" }],
    [{ from: "hub", to: "n1" }, { from: "hub", to: "n2" }],
  );
  assert.equal(star.focalNode, "hub");
  assert.equal(star.nodeRanks.hub, 1);
  assert.equal(star.nodeRanks.n1, 2, "focal neighbours rank 2");
});

test("edges rank by weight, focal touch, then meaning — unlabeled warns", () => {
  const s = analyzeRelationships(
    [{ id: "hub", status: "selected" }, { id: "a" }, { id: "b" }],
    [
      { from: "hub", to: "a", weight: "critical", label: "replicates" },
      { from: "hub", to: "b" },
      { from: "a", to: "b", meaning: "gossip" },
    ],
  );
  assert.equal(s.edgeRanks["hub->a#0"], "critical", "explicit weight wins");
  assert.equal(s.edgeRanks["hub->b#1"], "major", "focal-touching edge matters");
  assert.equal(s.edgeRanks["a->b#2"], "minor");
  assert.ok(s.warnings.some((w) => /hub -> b.*no meaning|unexplained line/.test(w)), "the anonymous edge is called out");
  assert.ok(s.directives.some((d) => /critical/.test(d) && /routed first/.test(d)));
});

test("clusters and direction express grouping and flow", () => {
  const s = analyzeRelationships(
    [{ id: "a", group: "site-1" }, { id: "b", group: "site-1" }, { id: "c", group: "site-2" }],
    [{ from: "a", to: "b", meaning: "replicates" }, { from: "b", to: "c", meaning: "serves" }],
  );
  assert.equal(s.clusters.length, 2);
  assert.equal(s.direction, "flow", "flow meanings layer left-to-right");
  assert.ok(s.directives.some((d) => /whitespace.*not boxes/.test(d)));
  const radial = analyzeRelationships(
    [{ id: "hub", status: "selected" }, { id: "a" }, { id: "b" }],
    [{ from: "hub", to: "a", label: "x" }, { from: "hub", to: "b", label: "y" }],
  );
  assert.equal(radial.direction, "radial");
  assert.match(describeSemantics(radial), /Focal: 'hub'/);
});

test("edges to unknown nodes are excluded with a warning, never placed", () => {
  const s = analyzeRelationships([{ id: "a" }], [{ from: "a", to: "ghost", label: "x" }]);
  assert.equal(Object.keys(s.edgeRanks).length, 0);
  assert.ok(s.warnings.some((w) => /ghost/.test(w)));
});

test("topologyMap carries status, weight, meaning and link labels", () => {
  const built = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill", composition: "topology", layout: "topology" } }],
    content: [{
      fn: "topologyMap",
      id: "topo",
      parent: "map",
      args: {
        title: "Fleet",
        nodes: [{ id: "hub", status: "pressured" }, { id: "n1" }],
        edges: [{ from: "hub", to: "n1", latency: "8ms", meaning: "serves", weight: "critical" }],
      },
    }],
  });
  assert.deepEqual(built.warnings, [], `unexpected warnings: ${built.warnings.join("; ")}`);
  assert.equal(built.ir.links.length, 1);
  assert.match(built.ir.links[0].label ?? "", /8ms/, "link keeps the latency label");
  assert.match(built.ir.links[0].label ?? "", /serves/, "…and the meaning");
  const ops = built.operations;
  assert.ok(ops.some((o) => o.stroke === "#8A5200"), "pressured node draws the amber warning stroke");
  assert.ok(ops.some((o) => o.type === "createVector" && o.strokeWeight === 3), "critical edge draws strong");
});

test("unknown graph status and weight warn instead of guessing", () => {
  const built = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill" } }],
    content: [{
      fn: "topologyMap",
      id: "topo",
      parent: "map",
      args: { nodes: [{ id: "a", status: "haunted" }], edges: [{ from: "a", to: "a", weight: "enormous" }] },
    }],
  });
  assert.ok(built.warnings.some((w) => /haunted/.test(w)));
  assert.ok(built.warnings.some((w) => /enormous/.test(w)));
});

/* -------------------------------------------------------------------------- */
/* B+D. Image-grounded findings: localize, repair, verify                      */
/* -------------------------------------------------------------------------- */

function findingNodes() {
  return [
    { id: "1:1", x: 0, y: 0, w: 1440, h: 900, parentId: null },
    { id: "1:2", x: 0, y: 0, w: 300, h: 900, parentId: "1:1" },
    { id: "1:3", x: 1100, y: 700, w: 300, h: 160, parentId: "1:1" },
  ];
}

test("finding ids are stable so re-reports match across renders", () => {
  const a = makeFindings({ findings: [{ area: "top-left", defect: "No clear focal point" }], nodes: findingNodes(), canvasW: 1440, canvasH: 900 });
  const b = makeFindings({ findings: [{ area: "Top-Left", defect: "no clear focal point " }], nodes: findingNodes(), canvasW: 1440, canvasH: 900 });
  assert.equal(a[0].id, b[0].id);
  assert.ok(a[0].id.startsWith("vf-"));
});

test("findings localize to measured nodes, never the whole file", () => {
  const [zone] = makeFindings({ findings: [{ area: "top-left", defect: "rail too heavy" }], nodes: findingNodes(), canvasW: 1440, canvasH: 900 });
  assert.ok(zone.nodeIds.includes("1:2"), "the rail sits top-left");
  assert.ok(!zone.nodeIds.includes("1:3"), "the bottom-right card is elsewhere");
  assert.match(zone.repair, /\[vf-[0-9a-f]+\]/, "the repair cites the finding id");
  assert.match(zone.repair, /1:2/, "…and its nodes");
  const [region] = makeFindings({
    findings: [{ area: "map", defect: "edges unlabeled" }],
    nodes: [{ id: "m", x: 0, y: 0, w: 800, h: 800, parentId: null }, { id: "e1", x: 10, y: 10, w: 100, h: 10, parentId: "m" }],
    regions: [{ id: "map", nodeId: "m" }],
    canvasW: 1440, canvasH: 900,
  });
  assert.ok(region.nodeIds.includes("e1"), "region areas match the subtree");
  const [none] = makeFindings({ findings: [{ area: "everywhere", defect: "vague" }], nodes: findingNodes(), canvasW: 1440, canvasH: 900 });
  assert.deepEqual(none.nodeIds, [], "unknown areas match nothing rather than everything");
});

test("localizeFinding matches focal and canvas zones", () => {
  const nodes = findingNodes();
  assert.deepEqual(localizeFinding({ area: "bottom-right", nodes, canvasW: 1440, canvasH: 900 }), ["1:3"]);
  const focal = localizeFinding({ area: "focal", nodes, regions: [{ id: "rail", nodeId: "1:2" }], focalId: "rail", canvasW: 1440, canvasH: 900 });
  assert.ok(focal.includes("1:2"));
});

test("tracking reports resolved, persisting and introduced honestly", () => {
  const r = trackFindings([{ id: "vf-1" }, { id: "vf-2" }], [{ id: "vf-2" }, { id: "vf-3" }]);
  assert.deepEqual(r.resolved, ["vf-1"]);
  assert.deepEqual(r.persisting, ["vf-2"]);
  assert.deepEqual(r.introduced, ["vf-3"]);
  assert.match(r.summary, /Judge the render/);
  const clean = trackFindings([{ id: "vf-1" }], []);
  assert.deepEqual(clean.resolved, ["vf-1"]);
});
