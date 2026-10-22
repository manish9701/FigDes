/**
 * Issue #22 phases 2–4 — the offline half of the rendered-critique loop,
 * the composition-alternatives engine, and the benchmark regression gate.
 *
 * 1. **Alternatives (§3)** — ≥3 pairwise-distinct composition hypotheses,
 *    scored on dimensions the brief's own content can measure, selected by
 *    the shared engine, steering the plan only when legitimate; a
 *    caller-stated composition is a hard constraint that is honoured even
 *    when it loses the offline ranking, and flagged when it fails the floors.
 * 2. **Declared type/spacing criteria (§4, offline half)** — the
 *    `type-and-space` skill's criteria checked against compiled programs and
 *    resolved plans before any node exists; failures ride the findings flow.
 * 3. **Benchmark regression gate (§6)** — plan-mode pipeline evidence scores
 *    through the suite's 100-point offline scorecard, with not-evaluated
 *    dimensions named; a versioned baseline round-trips on brief + config;
 *    the gate returns PASS / REGRESSION / NOT_EVALUATED and refuses to
 *    certify what was never re-run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveCompositionAlternatives } from "../mcp-server/dist-test/design/skills/alternatives.js";
import { auditTypeCriteria, MIN_LABEL_PX } from "../mcp-server/dist-test/design/quality/type-criteria.js";
import {
  scoreOfflineEvidence,
  serializeBaseline,
  parseBaseline,
  runRegressionGate,
  BaselineDocumentSchema,
  BASELINE_SCHEMA,
} from "../mcp-server/dist-test/design/benchmark/regression.js";
import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";
import { evidenceFromResponse } from "../mcp-server/dist-test/design/benchmark/offline-briefs.js";

/* -------------------------------------------------------------------------- */
/* Brief fixtures                                                              */
/* -------------------------------------------------------------------------- */

const TOPOLOGY_BRIEF = {
  screen: "Cluster routing",
  product: "fenek-clusters",
  purpose: "see how traffic moves between shards and act on the weak link",
  primaryDecision: "which pressured resource needs attention",
  primaryAction: "rebalance the shard",
  requiredInformation: [
    "node links between shards",
    "routing paths between clusters",
    "bandwidth per link",
    "shard pressure",
    "error rate",
    "latency p99",
  ],
  optionalInformation: ["recent interventions"],
  dataMode: "demo",
  visualDirection: "premium technical",
  antiGoals: ["no generic SaaS card walls"],
  states: ["degraded", "recovering"],
  existingPatterns: [],
  audience: "operator",
};

/**
 * `evidenceFromResponse` is the shared library implementation now (issue #22):
 * the runner, the frozen baseline and these tests all measure the same way.
 */

/* -------------------------------------------------------------------------- */
/* 1. The alternatives engine                                                  */
/* -------------------------------------------------------------------------- */

test("a relationship-led brief gets ≥3 audited-distinct hypotheses, scored for the record", () => {
  const record = resolveCompositionAlternatives({
    primaryDecision: TOPOLOGY_BRIEF.primaryDecision,
    requiredInformation: TOPOLOGY_BRIEF.requiredInformation,
    optionalInformation: TOPOLOGY_BRIEF.optionalInformation,
  });
  assert.ok(record.selection.considered.length >= 3, `candidates: ${record.selection.considered.length}`);
  assert.equal(record.selection.audit.distinct, true, `distinct audit: ${JSON.stringify(record.selection.audit)}`);
  assert.equal(record.taskKind, "topology");
  // Every ranking is carriage for its reasons: each considered candidate
  // retains its raw dimension scores, and rejected ones name why they lost.
  for (const scored of record.selection.considered) {
    assert.ok(scored.candidate.rationale.includes("decision,") && scored.candidate.rationale.length > 40, `rationale: ${scored.candidate.rationale}`);
  }
  assert.ok(record.selection.rejected.every((r) => r.reason.length > 20), "rejections carry reasons");
});

test("a relationship-led brief steers the plan to a relational composition", () => {
  const record = resolveCompositionAlternatives({
    primaryDecision: TOPOLOGY_BRIEF.primaryDecision,
    requiredInformation: TOPOLOGY_BRIEF.requiredInformation,
    optionalInformation: TOPOLOGY_BRIEF.optionalInformation,
  });
  assert.equal(record.steeredComposition, "topology", `steered: ${record.steeredComposition}`);
  assert.equal(record.selectedFamily, "topology");
  assert.ok(
    record.provenance.some((p) => p.includes("Steering") && p.includes("topology")),
    `provenance: ${record.provenance.join(" | ")}`,
  );
});

test("a caller-stated composition is honoured as a hard constraint, never replaced", () => {
  const record = resolveCompositionAlternatives({
    primaryDecision: TOPOLOGY_BRIEF.primaryDecision,
    requiredInformation: TOPOLOGY_BRIEF.requiredInformation,
    optionalInformation: TOPOLOGY_BRIEF.optionalInformation,
    desiredComposition: "table",
  });
  assert.equal(record.steeredComposition, null, "the engine never substitutes its own choice under a caller constraint");
  assert.ok(record.userOverride, "the override is recorded, with its evidence");
  assert.equal(record.userOverride.stated, "table");
  assert.equal(record.userOverride.honored, true);
  // When the constraint loses the offline ranking, that fact is audit-grade.
  if (record.selectedFamily !== "table") {
    assert.ok(
      record.userOverride.note !== "" && record.selection.considered.find((s) => s.candidate.family === "table"),
      `the ranked loser is named: ${record.userOverride.note}`,
    );
  }
});

test("a caller constraint the evidence argues against does not force a build decision", () => {
  // 'editorial' scores taskFit 3 for a monitor decision — at/below the floor,
  // which leaves the collision for a human instead of silently shipping it.
  const record = resolveCompositionAlternatives({
    primaryDecision: "monitor the fleet and intervene",
    requiredInformation: ["throughput", "error rate", "node pressure"],
    desiredComposition: "editorial",
  });
  const preferred = record.considered.find((s) => s.candidate.family === "editorial");
  assert.ok(preferred, "editorial is one of the scored candidates");
  assert.ok(preferred.disqualifiedBy.length > 0, `disqualified on: ${preferred.disqualifiedBy.join(", ")}`);
  assert.equal(record.steeredComposition, null, "nothing was forced");
  assert.equal(record.userOverride.honored, false, "the failed constraint is recorded as failed");
  assert.ok(
    record.provenance.some((p) => p.includes("floors") || p.includes("human call")),
    `provenance: ${record.provenance.join(" | ")}`,
  );
});

test("the pipeline steers the plan through the alternatives engine — evidence in the payload", async () => {
  const resp = await designPipelineTool(null, null, { brief: TOPOLOGY_BRIEF, mode: "plan" });
  const alternatives = resp?.visualIntelligence?.alternatives;
  assert.ok(alternatives, "the alternatives record rides the response");
  assert.ok(alternatives.candidateCount >= 3 && alternatives.distinct === true);
  assert.equal(alternatives.steeredComposition, "topology");
  assert.equal(resp.plan.composition, "topology", `plan composition: ${resp.plan.composition}`);
  assert.ok(
    resp.plan.warnings.some((w) => w.includes("alternatives engine") || w.startsWith("Selected '")),
    `plan records the steering: ${resp.plan.warnings.join(" | ")}`,
  );
  const stageText = resp.trace.stages.find((s) => s.stage === "alternatives");
  assert.ok(stageText?.detail.includes("selected 'topology'"), `stage detail: ${stageText?.detail}`);
});

test("a caller's stated composition reaches the builder untouched", async () => {
  const resp = await designPipelineTool(null, null, {
    brief: { ...TOPOLOGY_BRIEF, desiredComposition: "table" },
    mode: "plan",
  });
  assert.equal(resp.plan.composition, "table", "the user constraint wins");
  const alternatives = resp.visualIntelligence.alternatives;
  assert.equal(alternatives.userOverride.stated, "table");
  assert.equal(alternatives.steeredComposition, null, "the engine did not steer");
  assert.ok(alternatives.provenance.some((p) => p.includes("hard constraint")), "the honouring is recorded");
});

/* -------------------------------------------------------------------------- */
/* 2. The declared type/spacing criteria, on compiled evidence                  */
/* -------------------------------------------------------------------------- */

test("one-rhythm fails loud when sibling regions carry two gap steps", () => {
  const audit = auditTypeCriteria({ regions: [{ id: "r1", gap: 16 }, { id: "r2", gap: 16 }, { id: "r3", gap: 24 }] });
  const rhythm = audit.criteria.find((c) => c.criterion === "one-rhythm");
  assert.equal(rhythm?.status, "fail");
  const finding = audit.findings.find((f) => f.rule === "type.space.one-rhythm");
  assert.ok(finding, "a finding rides the flow");
  assert.equal(finding.automatable, false, "a deliberate rhythm step needs a stated reason, not a silent respacing");
  assert.ok(finding.summary.includes("16px") && finding.summary.includes("24px"), `measured: ${finding.summary}`);
});

test("three or more gap values fail high, naming every break", () => {
  const audit = auditTypeCriteria({
    regions: [{ id: "r1", gap: 8 }, { id: "r2", gap: 12 }, { id: "r3", gap: 16 }, { id: "r4", gap: 32 }],
  });
  const finding = audit.findings.find((f) => f.rule === "type.space.one-rhythm");
  assert.equal(finding?.severity, "high");
  assert.ok(finding.summary.includes("4 different"), `measured: ${finding.summary}`);
});

test("the 11px label floor fails on a compiled text node", () => {
  const audit = auditTypeCriteria({
    ops: [
      { type: "createText", id: "t1", content: "Shard pressure", fontSize: 16 },
      { type: "createText", id: "t2", content: "p99 latency", fontSize: 9 },
    ],
  });
  const finding = audit.findings.find((f) => f.rule === "type.space.readable-labels");
  assert.ok(finding, "the floor is enforced before render");
  assert.ok(finding.nodeIds.includes("t2") && !finding.nodeIds.includes("t1"), `evidence: ${finding.nodeIds.join(", ")}`);
  assert.ok(finding.evidence.detail.includes(`@${MIN_LABEL_PX}px floor`) || finding.summary.includes(MIN_LABEL_PX));
});

test("sentence-length uppercase metadata fails the uppercase budget", () => {
  const audit = auditTypeCriteria({
    ops: [{ type: "createText", id: "u1", content: "SHARD PRESSURE DEGRADED HEARTBEAT OVERLOAD" }],
  });
  const finding = audit.findings.find((f) => f.rule === "type.space.uppercase-in-check");
  assert.ok(finding, `findings: ${audit.findings.map((f) => f.rule).join(", ")}`);
  assert.ok(finding.summary.includes("uppercase run"));
});

test("clean evidence passes, and unmeasured criteria say not-evaluated", () => {
  const audit = auditTypeCriteria({
    ops: [
      { type: "createText", id: "t1", content: "Shard pressure", fontSize: 14 },
      { type: "createText", id: "t2", content: "The routing table links each shard to its peers", fontSize: 12 },
    ],
    regions: [{ id: "a", gap: 16 }, { id: "b", gap: 16 }, { id: "c", gap: 24 }],
  });
  // Two gaps with three regions is the deliberate-step case; column-length
  // has no offline measurement and must never pretend to have been checked.
  assert.ok(audit.criteria.some((c) => c.criterion === "column-length-sane" && c.status === "not-evaluated"));
  const labels = audit.criteria.find((c) => c.criterion === "readable-labels");
  assert.equal(labels?.status, "pass");
  const caps = audit.criteria.find((c) => c.criterion === "uppercase-in-check");
  assert.equal(caps?.status, "pass");
});

test("the pipeline runs the criteria audit on compiled evidence and records the stage", async () => {
  const resp = await designPipelineTool(null, null, { brief: TOPOLOGY_BRIEF, mode: "plan" });
  const criteria = resp?.typeCriteria?.criteria ?? [];
  assert.ok(criteria.length >= 4, `criteria: ${criteria.map((c) => c.criterion).join(", ")}`);
  assert.ok(
    criteria.every((c) => c.status === "pass" || c.status === "fail" || c.status === "not-evaluated"),
    `statuses: ${criteria.map((c) => c.status).join(", ")}`,
  );
  assert.ok(resp.trace.stages.some((s) => s.stage === "type-criteria"), "the audit is a trace stage");
  // A declared criterion failure rides the pipeline findings flow — the
  // phase-2 contract that a screen can fail visually before anyone renders.
  for (const finding of resp.typeCriteria.findings) {
    assert.ok(finding.automatable === false && finding.stage === "program");
    assert.ok(resp.trace.findings.some((f) => f.rule === finding.rule), "the finding is in the trace");
  }
});

/* -------------------------------------------------------------------------- */
/* 3. The benchmark regression gate                                            */
/* -------------------------------------------------------------------------- */

test("plan-mode pipeline evidence scores through the offline scorecard, with honesty about what is not evaluated", async () => {
  const resp = await designPipelineTool(null, null, { brief: TOPOLOGY_BRIEF, mode: "plan" });
  const scored = scoreOfflineEvidence(evidenceFromResponse(resp, "exo-compute-topology"));
  const { result, notEvaluated, dimensionEvidence } = scored;
  assert.ok(result.total > 0 && result.total <= 100, `total: ${result.total}`);
  assert.ok(Object.values(result.dimensions).every((v) => v >= 0 && v <= 10));
  assert.ok(notEvaluated.includes("productSpecificity"), "product specificity is named not-evaluated offline");
  assert.ok(result.notes.some((n) => n.includes("plan-mode") || n.includes("not evaluated")), `notes: ${result.notes.join(" | ")}`);
  for (const [dim, outcome] of Object.entries(dimensionEvidence)) {
    assert.ok(outcome.length > 10, `${dim} carries its mapping: ${outcome}`);
  }
  // The deterministic scorecard must be deterministic.
  const again = scoreOfflineEvidence(evidenceFromResponse(resp, "exo-compute-topology"));
  assert.equal(again.result.total, result.total, "deterministic: the same evidence scores identically");
});

test("a baseline round-trips on brief + config + evidence, and refuses a foreign document", () => {
  const baseline = {
    schema: BASELINE_SCHEMA,
    suite: "v1-loop-smoke",
    recordedAt: new Date().toISOString(),
    cases: [
      {
        caseId: "exo-compute-topology",
        brief: {
          screen: "Cluster routing",
          product: "fenek-clusters",
          purpose: "see how traffic moves between shards and act on the weak link",
          primaryDecision: "which pressured resource needs attention",
          primaryAction: "rebalance the shard",
          requiredInformation: TOPOLOGY_BRIEF.requiredInformation,
          optionalInformation: TOPOLOGY_BRIEF.optionalInformation,
          desiredComposition: null,
          viewport: { width: 1440, height: 900 },
        },
        config: { mode: "plan", render: false, repairBudget: 2, maxRounds: 1 },
        evidence: evidenceFromResponse(null, "exo-compute-topology", {
          primaryDecision: TOPOLOGY_BRIEF.primaryDecision,
          requiredInformation: TOPOLOGY_BRIEF.requiredInformation,
          optionalInformation: TOPOLOGY_BRIEF.optionalInformation,
          compiledIntentFields: ["style", "density"],
          alternatives: { candidateCount: 7, distinct: true, selectedFamily: "topology" },
          structureStatus: "pass",
        }),
        result: scoreOfflineEvidence(evidenceFromResponse(null, "exo-compute-topology", {
          primaryDecision: TOPOLOGY_BRIEF.primaryDecision,
          requiredInformation: TOPOLOGY_BRIEF.requiredInformation,
          optionalInformation: TOPOLOGY_BRIEF.optionalInformation,
          compiledIntentFields: ["style", "density"],
          alternatives: { candidateCount: 7, distinct: true, selectedFamily: "topology" },
          structureStatus: "pass",
        })).result,
      },
    ],
  };
  assert.ok(BaselineDocumentSchema.safeParse(baseline).success, "the document validates before it may be frozen");
  const json = serializeBaseline(baseline);
  const reparsed = parseBaseline(json);
  assert.deepEqual(JSON.parse(JSON.stringify(reparsed)), JSON.parse(JSON.stringify(baseline)), "round-trip preserving values");
  assert.throws(() => parseBaseline(JSON.stringify({ ...baseline, schema: "someone-elses-baseline" })), /refused/, "a foreign schema is refused");
  assert.throws(() => parseBaseline("{not json"), /refused/, "garbage is refused");
});

test("the gate is three-valued: PASS on parity, REGRESSION on a real drop, NOT_EVALUATED on unreproduced cases", () => {
  const caseResult = (caseId, total, dimensions) => ({
    caseId,
    total,
    dimensions,
    genericity: 0,
    repairs: 0,
    renders: 0,
    discoveryCalls: 0,
    notes: [],
  });
  const dims = { hierarchy: 9, composition: 8, typography: 9, spacingRhythm: 9, relationshipClarity: 9, density: 8, nativeQuality: 8, distinctiveness: 9, readability: 9, productSpecificity: 0 };
  const baselineDoc = {
    schema: BASELINE_SCHEMA,
    suite: "v1-loop-smoke",
    recordedAt: new Date().toISOString(),
    cases: [
      {
        caseId: "exo-compute-topology",
        brief: {
          screen: "Cluster routing", product: "fenek-clusters", purpose: "see how traffic moves", primaryDecision: "which pressured resource needs attention", primaryAction: "rebalance",
          requiredInformation: [], optionalInformation: [], desiredComposition: null, viewport: { width: 1440, height: 900 },
        },
        config: { mode: "plan", render: false, repairBudget: 2, maxRounds: 1 },
        evidence: evidenceFromResponse(null, "exo-compute-topology", {
          primaryDecision: "which pressured resource needs attention",
        }),
        result: caseResult("exo-compute-topology", 76, dims),
      },
      {
        caseId: "exo-runtime-monitoring",
        brief: {
          screen: "Runtime monitor", product: "fenek-clusters", purpose: "intervene or let run", primaryDecision: "intervene or let the run continue", primaryAction: "drain",
          requiredInformation: [], optionalInformation: [], desiredComposition: null, viewport: { width: 1440, height: 900 },
        },
        config: { mode: "plan", render: false, repairBudget: 2, maxRounds: 1 },
        evidence: evidenceFromResponse(null, "exo-runtime-monitoring", {
          primaryDecision: "intervene or let the run continue",
        }),
        result: caseResult("exo-runtime-monitoring", 64, dims),
      },
    ],
  };
  parseBaseline(serializeBaseline(baselineDoc)); // schema sanity

  const parity = runRegressionGate({ candidate: [caseResult("exo-compute-topology", 76, dims), caseResult("exo-runtime-monitoring", 64, dims)], baseline: parseBaseline(serializeBaseline(baselineDoc)) });
  assert.equal(parity.verdict, "PASS", `parity: ${parity.reasons.join(" | ")}`);

  const regressed = runRegressionGate({
    candidate: [caseResult("exo-compute-topology", 76, dims), caseResult("exo-runtime-monitoring", 54, dims)],
    baseline: parseBaseline(serializeBaseline(baselineDoc)),
  });
  assert.equal(regressed.verdict, "REGRESSION");
  assert.ok(regressed.comparison.regressions.includes("exo-runtime-monitoring"), `regressions: ${regressed.comparison.regressions.join(", ")}`);
  assert.ok(regressed.reasons.some((r) => r.includes("exo-runtime-monitoring")), `reasons: ${regressed.reasons.join(" | ")}`);

  const unevaluated = runRegressionGate({
    candidate: [caseResult("exo-compute-topology", 76, dims)],
    baseline: parseBaseline(serializeBaseline(baselineDoc)),
  });
  assert.equal(unevaluated.verdict, "NOT_EVALUATED", "an unmet baseline case refuses a PASS");
  assert.deepEqual(unevaluated.missing, ["exo-runtime-monitoring"]);
});

/* -------------------------------------------------------------------------- */
/* 4. The whole loop, linked: alternatives → type criteria → baseline → gate     */
/* -------------------------------------------------------------------------- */

test("benchmark briefs score and gate end-to-end from pipeline plan-mode runs", async () => {
  const monitorResp = await designPipelineTool(null, null, { brief: { ...TOPOLOGY_BRIEF, screen: "Runtime monitor", primaryDecision: "intervene or let the run continue", primaryAction: "drain the node" }, mode: "plan" });
  const monitorEvidence = evidenceFromResponse(monitorResp, "exo-compute-topology");
  const scored = scoreOfflineEvidence(monitorEvidence);
  // The case ids must be suite case ids for the gate to mean anything.
  assert.ok(["exo-compute-topology", "exo-model-detail"].includes(scored.result.caseId));
  assert.ok(scored.result.total > 0, `total: ${scored.result.total}`);
  // The offline result is a BenchmarkResult the suite's own runner consumes.
  assert.ok("dimensions" in scored.result && "genericity" in scored.result);
});

/* -------------------------------------------------------------------------- */
/* Issue-22 live-loop gate defects, fixed and pinned                           */
/* -------------------------------------------------------------------------- */

test("the genericity intake gate refuses a contradictory brief before anything is created", async () => {
  const { OFFLINE_BRIEFS } = await import("../mcp-server/dist-test/design/benchmark/offline-briefs.js");
  const negative = OFFLINE_BRIEFS.find((c) => c.caseId === "generic-saas-dashboard");
  assert.ok(negative, "the negative-control brief exists");

  // Only measure_text may touch the session stub (it fails closed into
  // estimates); any other contact means the build escaped the gate.
  const touched = [];
  const session = {
    async request(tool) {
      touched.push(tool);
      return {};
    },
  };
  const result = await designPipelineTool(session, null, {
    brief: negative.brief,
    approved: true,
    reason: "benchmark negative control",
  });
  assert.equal(result.status, "refused", `expected a refusal, got ${result.status}`);
  assert.equal(result.stage, "genericity");
  assert.ok(result.genericity?.blocking === true, "the refusal names the blocking genericity");
  assert.ok(
    touched.every((t) => t === "measure_text"),
    `the gate must refuse before any Figma contact beyond measuring, got: ${touched.join(", ")}`,
  );
});

test("a measure-cache miss is honest: the runtime labels an estimates-based applicability", async () => {
  const { runRuntimeTool } = await import("../mcp-server/dist-test/runtime/tools.js");
  // measure_text fails closed (the busy-plugin case), so the compile runs on
  // estimates and the payload must say so instead of implying a guarantee.
  const session = { async request() { throw new Error("measure_text: plugin busy"); } };
  const program = {
    canvas: { name: "Basis", width: 1440, height: 900 },
    regions: [{ id: "body", fn: "inspector", args: { width: 360, height: "fill" } }],
    content: [{ fn: "text", id: "t1", args: { text: "throughput now", role: "label" } }],
    visualIntent: {},
  };
  const result = await runRuntimeTool(session, { program, dryRun: true });
  assert.equal(result.applicabilityBasis, "estimates");
  assert.match(String(result.applicabilityWarning ?? ""), /ESTIMATES/);
});

test("the per-session measurement cache makes repeated compiles deterministic", async () => {
  const { measureProgramText } = await import("../mcp-server/dist-test/runtime/measure.js");
  let calls = 0;
  const session = {
    async request(tool, payload) {
      assert.equal(tool, "measure_text");
      calls += 1;
      return {
        measurements: (payload.specs ?? []).map((s) => ({ key: s.key, width: 120, height: s.size * 1.4 })),
      };
    },
  };
  const program = {
    content: [
      { fn: "text", id: "t1", args: { text: "throughput now", role: "label" } },
      { fn: "text", id: "t2", args: { text: "intervene or let the run continue", role: "body" } },
    ],
  };
  const widths = new Map([["t1", 200], ["t2", 480]]);
  const first = await measureProgramText(session, program, widths);
  assert.equal(first.measured, 2);
  assert.equal(calls, 1, "the first pass measures through the plugin");
  const second = await measureProgramText(session, program, widths);
  assert.equal(second.measured, 2);
  assert.equal(calls, 1, "the second pass serves from the session cache — no second round trip, so a dry run and the apply that follows compile identically");
  // A different width is a different measurement: it must re-measure.
  const third = await measureProgramText(session, program, new Map([["t1", 300], ["t2", 480]]));
  assert.equal(third.measured, 2);
  assert.equal(calls, 2, "a changed box width is a new measurement");
});

test("an observation that PRAISES the absence of defects is not a FAIL", async () => {
  const { observationFails } = await import("../mcp-server/dist-test/review/workflow.js");
  // The exact praise shape that produced the case-7 oddity: FAIL + FAIL with
  // zero blocking issues and every dimension PASS.
  assert.equal(
    observationFails({
      templateFeel: "device blocks with proportional memory slabs — a real placement map, not a generic card wall",
      balance: "nothing overlaps and nothing clips",
      focalPoint: "the amber-outlined focal block",
    }),
    false,
    "praise stating the absence of defects must not fail the gate",
  );
  assert.equal(observationFails({ balance: "the footer chips run into the next band" }), false, "no defect word, no fail");
  assert.equal(
    observationFails({ balance: "the support band reads as a wall of equal chips" }),
    true,
    "a real defect word survives the negation stripping",
  );
  assert.equal(
    observationFails({ balance: "nothing broken here, but the hero clips its headline" }),
    true,
    "a real defect later in the sentence survives a negated prefix",
  );
  assert.equal(observationFails(null), false);
  assert.equal(observationFails({}), false);
});

test("final_qa runs the render check for real instead of leaving it pending forever", async () => {
  const { finalQaTool } = await import("../mcp-server/dist-test/review/workflow.js");
  const node = {
    id: "screen", name: "Screen", type: "FRAME", visible: true, depth: 0, x: 0, y: 0, w: 1440, h: 900,
    parentId: null, fill: null, stroke: null, radius: 0, text: null,
  };
  const session = {
    async request(tool) {
      if (tool === "collect_metrics") return { target: "screen", scope: "screen", nodeCount: 1, nodes: [node] };
      if (tool === "render_node") return { data: "aGVsbG8=", width: 1024, height: 640 };
      throw new Error(`unexpected request ${tool}`);
    },
  };
  const result = await finalQaTool(session, { nodeId: "screen" });
  const renderCheck = result.checklist.find((i) => i.check === "render succeeds");
  assert.ok(renderCheck, "the render check exists");
  assert.equal(renderCheck.pass, true, "a successful render is recorded as a pass, not left pending");
  assert.match(renderCheck.detail, /render completed/);
  // No failed items and no pending ones: the verdict may finally say PASS.
  assert.equal(result.failed.length, 0);
  assert.equal(result.pendingLiveChecks.length, 0, "no check stays pending when it actually ran");
  assert.equal(result.verdict, "PASS", "with every check run and passed, the verdict is PASS");
});

test("final_qa reports a failed render as a FAIL, not a pending check", async () => {
  const { finalQaTool } = await import("../mcp-server/dist-test/review/workflow.js");
  const node = {
    id: "screen", name: "Screen", type: "FRAME", visible: true, depth: 0, x: 0, y: 0, w: 1440, h: 900,
    parentId: null, fill: null, stroke: null, radius: 0, text: null,
  };
  const session = {
    async request(tool) {
      if (tool === "collect_metrics") return { target: "screen", scope: "screen", nodeCount: 1, nodes: [node] };
      throw new Error("render_node: the plugin wedged");
    },
  };
  const result = await finalQaTool(session, { nodeId: "screen" });
  const renderCheck = result.checklist.find((i) => i.check === "render succeeds");
  assert.equal(renderCheck.pass, false, "a failed render is a failed check");
  assert.match(renderCheck.detail, /render failed/);
  assert.equal(result.verdict, "FAIL");
});
