import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contentRevision,
  canonicalize,
  evaluateFreshness,
  EVALUATOR_VERSION,
} from "../mcp-server/dist-test/design/quality/revision.js";
import {
  makeFinding,
  normalizeSeverity,
  confidenceToNumber,
  evidenceConfidence,
  fromProtocolFinding,
  fromVisualFinding,
  applyAdjudication,
  applyAcceptedRisk,
  applyAdjudications,
  isBlocking,
  isConfirmedDefect,
  tallyFindings,
} from "../mcp-server/dist-test/design/quality/finding.js";
import {
  evaluateGate,
  dimensionFromFindings,
  GATE_THRESHOLDS,
  thresholdSnapshot,
  detectThresholdDrift,
} from "../mcp-server/dist-test/design/quality/dimensions.js";
import {
  scoreCandidate,
  selectComposition,
  auditCandidateSet,
  assessDistinctness,
  ensureCandidateMinimum,
  MIN_CANDIDATES,
} from "../mcp-server/dist-test/design/composition/candidates.js";
import {
  compositionSignature,
  compareSignatures,
  detectTemplateCollapse,
} from "../mcp-server/dist-test/design/composition/similarity.js";
import {
  validateGraph,
  anchorEdges,
  movedNodeEffects,
  connectedComponents,
} from "../mcp-server/dist-test/design/graph/graph-model.js";
import { evaluateProductCritic } from "../mcp-server/dist-test/design/quality/product-critic.js";
import { evaluateAccessibility } from "../mcp-server/dist-test/design/quality/accessibility.js";
import {
  diagnose,
  recordRepair,
  assessRepairIntegrity,
  summarizeRepairs,
  requiresNewDiagnosis,
} from "../mcp-server/dist-test/design/quality/repair-history.js";
import { buildReleaseGate } from "../mcp-server/dist-test/design/quality/release-gate.js";
import {
  BENCHMARKS,
  scoreBenchmark,
  compareBenchmarkRuns,
  summarizeBenchmarkRun,
  UNCOVERED_CHALLENGE_CATEGORIES,
  POSITIVE_CONTROL_CASE,
  EXPANDED_BENCHMARKS,
  EXPANDED_SUITE_VERSION,
  scoreChallenge,
} from "../mcp-server/dist-test/design/benchmark/suite.js";
import { evaluateConsistency } from "../mcp-server/dist-test/design/quality/consistency.js";
import { planScreen, classifyDecision } from "../mcp-server/dist-test/plan/planner.js";

/* -------------------------------------------------------------------------- */
/* revision: content fingerprint + freshness                                    */
/* -------------------------------------------------------------------------- */

test("revisions are stable, order-insensitive and value-sensitive", () => {
  const a = contentRevision({ regions: [{ id: "map" }, { id: "rail" }], w: 1440 });
  const b = contentRevision({ w: 1440, regions: [{ id: "map" }, { id: "rail" }] });
  const c = contentRevision({ regions: [{ id: "map" }, { id: "other" }], w: 1440 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith("rev-"));
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
});

test("freshness: missing evidence is PENDING, never a pass", () => {
  const v = evaluateFreshness({ evidence: null, expectedRevision: "rev-1" });
  assert.equal(v.status, "PENDING");
});

test("freshness: stale revision and post-render mutations FAIL", () => {
  const base = {
    frameId: "f1",
    viewport: { width: 1440, height: 900 },
    revisionId: "rev-old",
    renderedAt: Date.now(),
    evaluatorVersion: EVALUATOR_VERSION,
  };
  assert.equal(evaluateFreshness({ evidence: base, expectedRevision: "rev-new" }).status, "FAIL");
  const fresh = { ...base, revisionId: "rev-new" };
  const mutated = evaluateFreshness({ evidence: fresh, expectedRevision: "rev-new", postRenderMutations: ["setFill n1"] });
  assert.equal(mutated.status, "FAIL");
  assert.ok(evaluateFreshness({ evidence: fresh, expectedRevision: "rev-new" }).status === "PASS");
  assert.equal(
    evaluateFreshness({ evidence: { ...fresh, evaluatorVersion: "ancient" }, expectedRevision: "rev-new" }).status,
    "FAIL",
  );
});

/* -------------------------------------------------------------------------- */
/* finding: one vocabulary, revision-bound evidence, lifecycle                 */
/* -------------------------------------------------------------------------- */

test("severity vocabularies collapse to one scale without inflating", () => {
  assert.equal(normalizeSeverity("serious"), "high");
  assert.equal(normalizeSeverity("major"), "high");
  assert.equal(normalizeSeverity("critical"), "critical");
  assert.equal(normalizeSeverity("minor"), "low");
  assert.equal(confidenceToNumber("high"), 0.9);
  assert.equal(confidenceToNumber("low"), 0.3);
});

test("evidence-free findings are hypotheses, not confirmed defects", () => {
  const thin = makeFinding({
    ruleId: "r.thin",
    category: "structural",
    severity: "high",
    confidence: 0.9,
    summary: "thin",
    rationale: "no evidence",
    evidence: [],
    verification: "re-check",
  });
  assert.ok(thin.confidence < 0.6);
  assert.equal(isConfirmedDefect(thin), false);
  assert.ok(evidenceConfidence([{ type: "node", revisionId: "", reference: "n1" }], 0.9) < 0.6);
});

test("protocol and visual findings adapt into the canonical shape", () => {
  const p = fromProtocolFinding(
    { rule: "overflow", confidence: "high", severity: "serious", title: "overflow", evidence: { over: 12 }, nodeIds: ["n1"] },
    "rev-1",
  );
  assert.equal(p.category, "structural");
  assert.equal(p.severity, "high");
  assert.equal(p.evidence[0].revisionId, "rev-1");
  assert.equal(p.evaluatorVersion, EVALUATOR_VERSION);

  const v = fromVisualFinding(
    { id: "vf-1", area: "top", defect: "crowded", severity: "major", nodeIds: ["n2"], repair: "space it", status: "open" },
    "rev-1",
    "snap.png",
  );
  assert.equal(v.category, "visual");
  assert.equal(v.evidence[0].reference, "snap.png#top");
});

test("only open critical findings block; lifecycle moves are explicit", () => {
  const critical = makeFinding({
    ruleId: "r.c", category: "structural", severity: "critical", confidence: 0.9,
    summary: "c", rationale: "c", verification: "re-run",
    evidence: [{ type: "node", revisionId: "rev-1", reference: "n1" }],
  });
  assert.equal(isBlocking(critical), true);
  const adj = applyAdjudication(critical, { findingId: critical.id, disposition: "false-positive", rationale: "rule bug", reviewer: "qa", at: 1, ruleCorrection: "fixed in v2" });
  assert.equal(adj.status, "adjudicated");
  assert.ok(adj.rationale.includes("rule bug"));
  assert.equal(isBlocking(adj), false);

  const refused = applyAcceptedRisk(critical, { findingId: critical.id, reason: "", evidence: [], owner: "", correctionConditions: "" });
  assert.equal(refused, null);
  const accepted = applyAcceptedRisk(critical, {
    findingId: critical.id,
    reason: "demo scope",
    evidence: [{ type: "requirement", revisionId: "rev-1", reference: "brief-1" }],
    owner: "design-lead",
    correctionConditions: "revisit before ship",
  });
  assert.equal(accepted.status, "accepted-risk");

  const applied = applyAdjudications([critical], [{ findingId: "nope", disposition: "confirmed", rationale: "x", reviewer: "y", at: 1 }]);
  assert.equal(applied.orphaned.length, 1);
  assert.equal(applied.applied.length, 0);
});

test("tally keeps five categories separate, never one blended number", () => {
  const mk = (category, severity, status) =>
    makeFinding({ ruleId: `r.${category}`, category, severity, confidence: 0.9, summary: "s", rationale: "r", verification: "v", evidence: [{ type: "node", revisionId: "rev-1", reference: "n" }], status });
  const t = tallyFindings([mk("structural", "critical", "open"), mk("visual", "medium", "fixed"), mk("product", "low", "open")]);
  assert.equal(t.blocking, 1);
  assert.equal(t.byCategory.structural.open, 1);
  assert.equal(t.byCategory.visual.fixed, 1);
  assert.equal(t.unresolved.length, 1);
});

/* -------------------------------------------------------------------------- */
/* dimensions: eight explicit states + documented aggregation                   */
/* -------------------------------------------------------------------------- */

const dim = (dimension, status, reasons = ["r"]) => ({ dimension, status, reasons, findingIds: [] });

test("gate aggregation follows the documented policy", () => {
  assert.equal(evaluateGate({ dimensions: [dim("structure", "FAIL")] }).status, "FAIL");
  assert.equal(evaluateGate({ dimensions: [] }).status, "PENDING");
  const limited = evaluateGate({
    dimensions: [dim("structure", "PASS"), dim("visual", "PASS"), dim("product", "PASS"), dim("accessibility", "PASS"), dim("consistency", "PASS"), dim("evidence_freshness", "PASS")],
    acceptedRisks: [{ findingId: "df-1", reason: "demo", evidence: [{ type: "requirement", revisionId: "rev-1", reference: "b" }], owner: "lead", correctionConditions: "before ship" }],
  });
  assert.equal(limited.status, "PASS_WITH_LIMITATIONS");
  const mixed = evaluateGate({
    dimensions: [dim("structure", "PASS"), dim("visual", "PASS"), dim("product", "PASS"), dim("accessibility", "PASS"), dim("consistency", "PASS"), dim("evidence_freshness", "PASS"), dim("live_validation", "FAIL", ["live down"])],
  });
  assert.equal(mixed.status, "MIXED");
  const pass = evaluateGate({
    dimensions: [dim("structure", "PASS"), dim("visual", "PASS"), dim("product", "PASS"), dim("accessibility", "PASS"), dim("consistency", "PASS"), dim("evidence_freshness", "PASS")],
  });
  assert.equal(pass.status, "PASS");
  // A required dimension marked NOT_APPLICABLE cannot read as fine.
  assert.equal(evaluateGate({ dimensions: [dim("structure", "NOT_APPLICABLE")] }).status !== "PASS", true);
});

test("dimension derivation: critical fails, missing score pends", () => {
  const critical = makeFinding({ ruleId: "r", category: "structural", severity: "critical", confidence: 0.9, summary: "s", rationale: "r", verification: "v", evidence: [{ type: "node", revisionId: "rev-1", reference: "n" }] });
  assert.equal(dimensionFromFindings({ dimension: "structure", findings: [critical], score: 95 }).status, "FAIL");
  assert.equal(dimensionFromFindings({ dimension: "visual", findings: [], score: null }).status, "PENDING");
  assert.equal(dimensionFromFindings({ dimension: "visual", findings: [], score: 90 }).status, "PASS");
  assert.equal(dimensionFromFindings({ dimension: "visual", findings: [], score: 40 }).status, "FAIL");
});

test("thresholds are versioned and drift is detectable", () => {
  const snap = thresholdSnapshot();
  assert.equal(snap.version, GATE_THRESHOLDS.version);
  assert.equal(detectThresholdDrift(snap).stable, true);
  assert.equal(detectThresholdDrift({ ...snap, minPassScore: 1 }).stable, false);
});

/* -------------------------------------------------------------------------- */
/* candidates: distinct hypotheses, scored dimensions, recorded choice         */
/* -------------------------------------------------------------------------- */

const hyp = (id, family, overrides = {}) => ({
  id,
  family,
  informationArchitecture: [`${family} regions`],
  spatialArrangement: `${family} arrangement`,
  interactionPattern: family,
  emphasis: `${family} emphasis`,
  navigationModel: `${family} nav`,
  treatmentOfMainObject: `${family} object`,
  rationale: `${family} fits because the task needs it.`,
  ...overrides,
});

test("cosmetic-only pairs are not distinct compositions", () => {
  const a = hyp("a", "spatial");
  const b = hyp("b", "spatial");
  const verdict = assessDistinctness(a, b);
  assert.equal(verdict.distinct, false);
  assert.ok(auditCandidateSet([a, b]).warnings.length > 0);
  const c = hyp("c", "table", { spatialArrangement: "rows across", interactionPattern: "table" });
  assert.equal(assessDistinctness(a, c).distinct, true);
});

test("candidate sets need three, scoring disqualifies on a weak dimension", () => {
  assert.ok(auditCandidateSet([hyp("a", "spatial")]).warnings.length > 0);
  const bad = scoreCandidate(hyp("x", "y", { scores: { taskFit: 1 } }), "topology");
  assert.ok(bad.disqualifiedBy.includes("taskFit"));
});

test("selection keeps raw dimensions and rejects losers with reasons", () => {
  const s = selectComposition(
    [hyp("a", "spatial", { scores: { taskFit: 9 } }), hyp("b", "table", { scores: { taskFit: 4 } }), hyp("c", "canvas", { scores: { taskFit: 2 } })],
    { taskCategory: "topology" },
  );
  assert.equal(s.selected.candidate.id, "a");
  assert.equal(s.rejected.length, 2);
  assert.ok(s.tradeoffs.length > 0);
  assert.equal(s.weightsVersion, "cand-v1");
  assert.ok(Object.keys(s.considered[0].dimensions).length === 10);

  const none = selectComposition([hyp("z", "y", { scores: { taskFit: 1, informationHierarchy: 1 } })]);
  assert.equal(none.selected, null);

  const topped = ensureCandidateMinimum([hyp("a", "spatial")], [hyp("b", "table", { spatialArrangement: "rows", interactionPattern: "table" }), hyp("c", "canvas", { spatialArrangement: "single column", interactionPattern: "canvas" })]);
  assert.ok(topped.candidates.length >= MIN_CANDIDATES);
});

/* -------------------------------------------------------------------------- */
/* similarity: shell reuse is allowed, task-region collapse is not             */
/* -------------------------------------------------------------------------- */

const box = (id, role, x, y, w, h) => ({ id, role, x, y, width: w, height: h });

test("identical task regions for different tasks collapse; shared shells do not", () => {
  const regions = [box("nav", "navigation", 0, 0, 200, 900), box("map", "primary-visual", 200, 0, 1000, 900)];
  const frame = { width: 1440, height: 900 };
  const s1 = compositionSignature({ screenId: "s1", frame, regions });
  const s2 = compositionSignature({ screenId: "s2", frame, regions });
  const cmp = compareSignatures(s1, s2);
  assert.equal(cmp.shellIdentical, true);
  assert.equal(cmp.taskIdentical, true);
  assert.ok(cmp.similarity > 0.9);

  const collapsed = detectTemplateCollapse([
    { screenId: "s1", taskKey: "where needs attention", signature: s1 },
    { screenId: "s2", taskKey: "choose a model", signature: s2 },
  ]);
  assert.equal(collapsed.collapsed, true);
  assert.ok(collapsed.action !== null);

  // Same task, same shape: consistency, not collapse.
  const sameTask = detectTemplateCollapse([
    { screenId: "s1", taskKey: "same job", signature: s1 },
    { screenId: "s2", taskKey: "same job", signature: s2 },
  ]);
  assert.equal(sameTask.collapsed, false);
});

/* -------------------------------------------------------------------------- */
/* graph: the model is validated, edges are identities, moves re-route        */
/* -------------------------------------------------------------------------- */

test("graph validation names missing endpoints, duplicates, loops and islands", () => {
  const v = validateGraph({
    nodes: [{ id: "a" }, { id: "b" }, { id: "lonely" }],
    edges: [
      { id: "e1", fromNodeId: "a", toNodeId: "b" },
      { id: "e2", fromNodeId: "a", toNodeId: "b" },
      { id: "e3", fromNodeId: "a", toNodeId: "ghost" },
      { id: "e4", fromNodeId: "a", toNodeId: "a" },
    ],
  });
  const kinds = new Set(v.defects.map((d) => d.kind));
  assert.ok(kinds.has("missing-endpoint"));
  assert.ok(kinds.has("duplicate-edge"));
  assert.ok(kinds.has("self-loop"));
  assert.ok(kinds.has("isolated-node") || kinds.has("disconnected-component"));
  assert.equal(connectedComponents([{ id: "a" }, { id: "b" }], [{ id: "e", fromNodeId: "a", toNodeId: "b" }]).length, 1);
});

test("anchored edges re-route when a node moves, and only for that node", () => {
  const graph = {
    nodes: [
      { id: "a", bounds: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "b", bounds: { x: 300, y: 0, width: 100, height: 100 } },
      { id: "c", bounds: { x: 300, y: 300, width: 100, height: 100 } },
    ],
    edges: [
      { id: "ab", fromNodeId: "a", toNodeId: "b" },
      { id: "bc", fromNodeId: "b", toNodeId: "c" },
    ],
  };
  const before = anchorEdges(graph);
  const moved = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === "a" ? { ...n, bounds: { x: 50, y: 50, width: 100, height: 100 } } : n)),
  };
  const after = anchorEdges(moved);
  const effects = movedNodeEffects(before, after, "a", graph);
  assert.ok(effects.changedEdgeIds.includes("ab"));
  assert.ok(!effects.changedEdgeIds.includes("bc"));
  assert.ok(effects.incidentEdgeIds.includes("ab"));
});

/* -------------------------------------------------------------------------- */
/* product critic: an independent evaluation, not a score alias                */
/* -------------------------------------------------------------------------- */

test("product critic flags missing primaries, missing content and fake live data", () => {
  const r = evaluateProductCritic({
    revisionId: "rev-1",
    screenGoal: "understand distributed machines and their relationships",
    actions: [{ label: "Deploy", prominence: "secondary" }],
    requiredContent: [{ id: "map", label: "fabric map", priority: "critical" }],
    presentContent: [{ id: "feed", label: "news feed" }],
    metrics: [{ label: "p99 latency", value: "42" }],
    requiredStates: ["error", "stale"],
    states: ["default"],
    claims: [{ text: "recommended", kind: "recommendation" }],
    liveDataConnected: false,
    liveImplyingTerms: ["live"],
    renderedLabels: ["live fleet overview", "deploy saturday"],
  });
  const rules = new Set(r.findings.map((f) => f.ruleId));
  assert.ok(rules.has("product.primary-action-missing"));
  assert.ok(rules.has("product.required-content-missing"));
  assert.ok(rules.has("product.state-missing"));
  assert.ok(rules.has("product.metric-uninterpretable"));
  assert.ok(rules.has("product.claims-live-data-without-source"));
  assert.ok(r.findings.every((f) => f.category === "product"));
  assert.ok(r.notChecked.length >= 0);
});

/* -------------------------------------------------------------------------- */
/* accessibility: explicit checks plus an explicit uncovered list              */
/* -------------------------------------------------------------------------- */

test("accessibility measures contrast, colour-only state, targets and names", () => {
  const r = evaluateAccessibility({
    revisionId: "rev-1",
    texts: [{ id: "t1", content: "hello", size: 12, contrastRatio: 2.1 }],
    nonText: [{ id: "b1", label: "border", contrastRatio: 1.5 }],
    stateIndicators: [{ id: "s1", label: "critical", colorOnly: true }],
    targets: [{ id: "btn", label: "run", width: 16, height: 16 }],
    controls: [{ id: "c1", label: "icon", hasAccessibleName: false, keyboardReachable: false }],
    errors: [{ id: "e1", message: "", identifiesControlAndFix: false }],
  });
  const rules = new Set(r.findings.map((f) => f.ruleId));
  assert.ok(rules.has("a11y.text-contrast"));
  assert.ok(rules.has("a11y.non-text-contrast"));
  assert.ok(rules.has("a11y.color-only-state"));
  assert.ok(rules.has("a11y.target-too-small"));
  assert.ok(rules.has("a11y.unlabelled-control"));
  assert.ok(rules.has("a11y.empty-error-message"));
  assert.ok(r.findings.every((f) => f.category === "accessibility"));
  // Static frames cannot prove focus, keyboard paths or motion behaviour.
  assert.ok(r.notChecked.some((c) => c.startsWith("focus-visibility")));
  assert.ok(r.notChecked.some((c) => c.startsWith("reduced-motion")));
  // The report must never read as a conformance verdict — only as findings + coverage.
  assert.ok(r.summary.includes("not a conformance claim"));
});

/* -------------------------------------------------------------------------- */
/* repair history: diagnosis, traces, and the anti-suppression guard            */
/* -------------------------------------------------------------------------- */

test("diagnosis picks the shared source for shared defects", () => {
  const f = makeFinding({ ruleId: "token.contrast", category: "consistency", severity: "high", confidence: 0.9, summary: "s", rationale: "r", verification: "v", evidence: [{ type: "token", revisionId: "rev-1", reference: "danger" }], affectedNodeIds: ["n1", "n2"] });
  assert.equal(diagnose(f, { isTokenDriven: true }).scope, "token");
  assert.equal(diagnose(f, {}).scope, "local");
});

test("repair integrity refuses unverified passes and repeats", () => {
  const f = makeFinding({ ruleId: "overflow.clip", category: "structural", severity: "high", confidence: 0.9, summary: "s", rationale: "r", verification: "v", evidence: [{ type: "node", revisionId: "rev-1", reference: "n1" }], affectedNodeIds: ["n1"] });
  const trace = recordRepair({ id: "rt-1", finding: f, revisionBefore: "rev-1", mutations: [{ kind: "operation", description: "move n1", targetIds: ["n1"] }], result: "unchanged" });
  const integrity = assessRepairIntegrity({ trace, dimensionBefore: "FAIL", dimensionAfter: "PASS", adjudication: { disposition: "false-positive" } });
  assert.equal(integrity.clean, false);
  assert.ok(integrity.violations.includes("finding-closed-without-verification"));
  assert.ok(integrity.violations.includes("adjudication-without-rule-correction"));

  const repeat = assessRepairIntegrity({ trace, dimensionBefore: "FAIL", dimensionAfter: "FAIL", history: [trace] });
  assert.ok(repeat.violations.includes("repeated-failed-attempt"));
  assert.equal(requiresNewDiagnosis([trace, trace], f.id), true);

  const summary = summarizeRepairs([trace, recordRepair({ id: "rt-2", finding: f, revisionBefore: "rev-1", mutations: [{ kind: "operation", description: "other", targetIds: ["n1"] }], result: "resolved" })]);
  assert.equal(summary.traces, 2);
  assert.ok(summary.repairSuccessRate > 0 && summary.repairSuccessRate < 1);
});

/* -------------------------------------------------------------------------- */
/* release gate: independent evaluators, one honest verdict                     */
/* -------------------------------------------------------------------------- */

test("release gate fails critical structure and pends without evidence", () => {
  const bad = buildReleaseGate({
    revisionId: "rev-1",
    structuralFindings: [{ rule: "overflow", confidence: "high", severity: "critical", title: "overflow", evidence: { over: 9 }, nodeIds: ["n1"] }],
    evidence: null,
  });
  const structure = bad.dimensions.find((d) => d.dimension === "structure");
  assert.equal(structure.status, "FAIL");
  assert.equal(bad.status, "FAIL");
  assert.ok(bad.handoff.wording.includes("high-fidelity visual prototype"));
  // The report must disclaim production-readiness, never claim it.
  assert.ok(bad.handoff.wording.includes("not production-ready"));

  const pending = buildReleaseGate({ revisionId: "rev-1", structuralFindings: [], evidence: null });
  assert.equal(pending.status, "PENDING");

  const cleanEvidence = { frameId: "f", viewport: { width: 1440, height: 900 }, revisionId: "rev-1", renderedAt: Date.now(), evaluatorVersion: EVALUATOR_VERSION };
  const limited = buildReleaseGate({
    revisionId: "rev-1",
    structuralFindings: [],
    evidence: cleanEvidence,
    accessibility: { revisionId: "rev-1", texts: [] },
    acceptedRisks: [{ findingId: "df-x", reason: "demo", evidence: [{ type: "requirement", revisionId: "rev-1", reference: "b" }], owner: "lead", correctionConditions: "before ship" }],
  });
  assert.ok(["PASS_WITH_LIMITATIONS", "PENDING", "MIXED"].includes(limited.status));
  assert.ok(limited.notVerified.length > 0);
});

/* -------------------------------------------------------------------------- */
/* benchmark: comparisons, uncovered categories, positive control               */
/* -------------------------------------------------------------------------- */

test("benchmark comparison reports regressions instead of hiding them", () => {
  const dims = Object.fromEntries(Object.keys({ a: 1 }).map(() => ["hierarchy", 8]));
  void dims;
  const full = Object.fromEntries(["hierarchy", "composition", "productSpecificity", "typography", "spacingRhythm", "relationshipClarity", "density", "nativeQuality", "distinctiveness", "readability"].map((k) => [k, 8]));
  const base = [scoreBenchmark({ caseId: BENCHMARKS[0].id, dimensions: full })];
  const worse = [scoreBenchmark({ caseId: BENCHMARKS[0].id, dimensions: { ...full, hierarchy: 1, composition: 1, productSpecificity: 1 } })];
  const report = compareBenchmarkRuns(base, worse);
  assert.equal(report.regressions.length, 1);
  assert.equal(report.broadImprovement, false);
  assert.ok(UNCOVERED_CHALLENGE_CATEGORIES.length > 0);
  assert.ok(POSITIVE_CONTROL_CASE.id.length > 0);
});

test("expanded v2 suite covers the uncovered categories without touching v1", () => {
  assert.equal(BENCHMARKS.length, 9, "v1 baseline is frozen");
  assert.equal(EXPANDED_BENCHMARKS.length, UNCOVERED_CHALLENGE_CATEGORIES.length);
  assert.ok(EXPANDED_SUITE_VERSION.length > 0);
  // No id collisions across suites: results compare without ambiguity.
  const v1 = new Set(BENCHMARKS.map((b) => b.id));
  for (const b of EXPANDED_BENCHMARKS) assert.ok(!v1.has(b.id), `collision: ${b.id}`);
  // The unfamiliar-domain case is genuinely unfamiliar: no EXO terms.
  const strange = EXPANDED_BENCHMARKS.find((b) => b.id === "unfamiliar-domain");
  assert.ok(strange && !/exo|device|model|inference/i.test(strange.brief));
  // summarizeBenchmarkRun accepts a custom case list (defaults to v1).
  const full = Object.fromEntries(["hierarchy", "composition", "productSpecificity", "typography", "spacingRhythm", "relationshipClarity", "density", "nativeQuality", "distinctiveness", "readability"].map((k) => [k, 8]));
  const v2report = summarizeBenchmarkRun(
    EXPANDED_BENCHMARKS.map((b) => scoreBenchmark({ caseId: b.id, dimensions: full })),
    EXPANDED_BENCHMARKS,
  );
  assert.equal(v2report.expectedCases, EXPANDED_BENCHMARKS.length);
  assert.equal(v2report.readyForComparison, true);
});

test("three-outcome challenge scoring never hides a failure", () => {
  const ok = (status, reason = "measured") => ({ status, reasons: [reason] });
  const pass = scoreChallenge({ caseId: "x", structural: ok("PASS"), visual: ok("PASS"), product: ok("PASS") });
  assert.equal(pass.overall, "PASS");

  const visualFail = scoreChallenge({ caseId: "x", structural: ok("PASS"), visual: ok("FAIL", "hierarchy 2/10"), product: ok("PASS") });
  assert.equal(visualFail.overall, "FAIL");
  assert.ok(visualFail.reason.includes("visual"));

  const pending = scoreChallenge({ caseId: "x", structural: ok("PASS"), visual: ok("PENDING", "no render yet"), product: ok("PASS") });
  assert.equal(pending.overall, "PENDING");

  // A pending visual the caller declared optional does not block.
  const optionalPending = scoreChallenge({
    caseId: "x", structural: ok("PASS"), visual: ok("PENDING", "offline run"), product: ok("PASS"),
    optionalOutcomes: ["visual"],
  });
  assert.equal(optionalPending.overall, "PASS");

  // NOT_APPLICABLE on a required outcome cannot read as fine.
  const na = scoreChallenge({ caseId: "x", structural: ok("PASS"), visual: ok("NOT_APPLICABLE", "n/a?"), product: ok("PASS") });
  assert.notEqual(na.overall, "PASS");
  assert.ok(na.notVerified.length > 0);
});

/* -------------------------------------------------------------------------- */
/* wiring: planner alternatives for every kind, live consistency               */
/* -------------------------------------------------------------------------- */

test("every decision kind yields at least three composition candidates", () => {
  const decisions = [
    "select a model",
    "monitor cluster health",
    "configure scheduler settings",
    "find an available checkpoint",
    "inspect why this job failed",
    "compare throughput against latency",
    "show network topology of the fleet",
    "provision a new machine",
  ];
  for (const primaryDecision of decisions) {
    const plan = planScreen({ primaryDecision, availableInformation: ["a", "b"] });
    assert.ok(
      plan.compositionCandidates.length >= 3,
      `${classifyDecision(primaryDecision)} produced ${plan.compositionCandidates.length}`,
    );
  }
  // The previously empty kinds now have real alternatives.
  for (const primaryDecision of ["configure scheduler settings", "provision a new machine"]) {
    const plan = planScreen({ primaryDecision, availableInformation: ["a", "b"] });
    assert.ok(plan.compositionCandidates.filter((c) => !c.recommended).length >= 2);
  }
});

test("consistency is a measured dimension with a blocking signal", () => {
  const clean = evaluateConsistency({ fills: ["#0b0e14", "#ffffff"], approvedTokens: ["#0b0e14", "#ffffff"], radii: [8], families: ["Inter"] });
  assert.ok(clean.score >= 70 && !clean.blocking);
  const drifted = evaluateConsistency({ fills: ["#0b0e14", "#ff0000"], approvedTokens: ["#0b0e14"], radii: [8], families: ["Inter"], repairIntroducedUnknown: true });
  assert.equal(drifted.blocking, true);
});
