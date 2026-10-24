/**
 * Issue #16 — the design pipeline's own regression matrix.
 *
 * The issue's testing plan names fourteen fixtures, G01–G14, and asks for each
 * one to store its evidence. This file is that matrix: the fixtures run
 * offline against the real planner, the real compiler and the real verifier,
 * so a regression in the pipeline shows up here rather than in a live file.
 *
 * The claims under test are behavioural:
 *
 *   1. A brief that contradicts itself is refused *before* anything is created.
 *   2. A brief becomes a composition plan, and the plan becomes a program whose
 *      geometry the compiler agrees with.
 *   3. The build is verified against the resolved geometry, not the operation
 *      log — and a check that could not run is never reported as a pass.
 *   4. A retry cannot duplicate the screen.
 *   5. A repair touches only the nodes it names.
 *   6. The final report separates what was generated, what was verified, what
 *      was repaired and what could not be checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { normalizeBrief } from "../mcp-server/dist-test/pipeline/brief.js";
import { buildCompositionPlan } from "../mcp-server/dist-test/pipeline/plan.js";
import { buildProgram, applyMeasuredWidths } from "../mcp-server/dist-test/pipeline/program.js";
import { verifyPlan, verifyLive } from "../mcp-server/dist-test/pipeline/verify.js";
import { planRepairs, deduplicateOperations } from "../mcp-server/dist-test/pipeline/repair.js";
import { buildReport } from "../mcp-server/dist-test/pipeline/report.js";
import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { reuseAdvisory } from "../mcp-server/dist-test/runtime/tools.js";
import { JobLedger } from "../mcp-server/dist-test/reliability/sessions.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

const ARTIFACT_DIR = "artifacts/pipeline";

/** Runs the pipeline offline: brief → plan → program → compile → verify. */
function run(briefInput) {
  const { brief, assumptions, clarifications, blockers } = normalizeBrief(briefInput);
  const plan = buildCompositionPlan(brief);
  const built = buildProgram(brief, plan);
  const first = executeRuntime(built.program);
  const refined = applyMeasuredWidths(built.program, first.boxes);
  const compiled = executeRuntime(refined.program);
  const program = refined.measured > 0 ? refined.program : built.program;
  const labels = program.content.map((c) => String(c.args.text ?? c.args.label ?? c.args.title ?? ""));
  const structure = verifyPlan(plan, brief, compiled, labels);
  return { brief, assumptions, clarifications, blockers, plan, built, program, compiled, structure };
}

/** The evidence the issue asks each fixture to store. */
function storeEvidence(id, result) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const evidence = {
    caseId: id,
    // Deliberately no timestamp: the fixtures are deterministic, and an
    // evidence file that changes every run is one nobody reviews.
    runtime: { plugin: "figma-design-agent", pipeline: "design-pipeline-v1" },
    brief: result.brief,
    assumptions: result.assumptions,
    clarifications: result.clarifications.map((c) => c.id),
    blockers: result.blockers,
    plan: {
      canvas: result.plan.canvas,
      regions: result.plan.regions,
      content: result.plan.content,
      focal: result.plan.focal,
      hierarchy: result.plan.hierarchy,
      usage: result.plan.usage,
    },
    operations: result.compiled.operations.map((op) => ({
      type: op.type,
      id: op.id,
      parent: op.parent,
      name: op.name,
      x: op.x,
      y: op.y,
      width: op.width,
      height: op.height,
      layoutMode: op.layoutMode,
    })),
    structuralChecks: result.structure.checks,
    findings: result.structure.findings,
    violations: result.compiled.violations,
    applicable: result.compiled.applicable,
    status: result.structure.status,
  };
  writeFileSync(`${ARTIFACT_DIR}/${id}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

const failingChecks = (checks) => checks.filter((c) => c.status === "fail").map((c) => c.id);
const opOf = (compiled, id) => compiled.operations.find((o) => o.id === id);
const framesOf = (compiled) => compiled.operations.filter((o) => o.type === "createFrame");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

const PRODUCT_OVERVIEW = {
  product: "EXO Labs",
  screen: "Fleet Overview",
  purpose: "See the health of the fleet and decide where to intervene",
  primaryDecision: "monitor fleet health and decide where to intervene",
  primaryAction: "Open cluster",
  requiredInformation: ["cluster health", "GPU memory", "model throughput", "node topology", "recent deploys"],
  optionalInformation: ["audit log"],
  dataMode: "demo",
  visualDirection: "technical-instrument",
  antiGoals: ["a wall of identical metric cards"],
  values: { "cluster health": "Degraded" },
};

const SPLIT_VIEW = {
  product: "EXO Labs",
  screen: "Model Detail",
  purpose: "Compare a model against the cluster it has to fit",
  primaryDecision: "compare a model against the cluster it has to fit",
  primaryAction: "Schedule placement",
  requiredInformation: ["model throughput", "GPU memory", "shard count", "latency"],
  viewport: { width: 1440, height: 900 },
  visualDirection: "technical-instrument",
};

const DENSE_DASHBOARD = {
  product: "EXO Labs",
  screen: "Operations",
  purpose: "Watch every service at once and catch the one that is wrong",
  primaryDecision: "monitor every service and find the one that needs attention",
  primaryAction: "Acknowledge incident",
  requiredInformation: [
    "API latency", "API errors", "API throughput", "Queue depth", "Queue lag",
    "Worker saturation", "Disk pressure", "Memory pressure", "Network throughput", "Cache hit rate",
    "Model throughput", "Model errors", "Shard balance", "Replica lag", "Clock skew",
    "Auth failures", "Token refresh errors", "Rate limit rejections", "Cold start time", "Warm pool size",
    "Inference queue", "Batch backlog", "Index rebuild", "Snapshot age", "Backup failures",
    "Certificate expiry", "Config drift", "Deploy frequency", "Change failure rate", "Time to restore",
  ],
  viewport: { width: 1440, height: 900 },
  visualDirection: "dense-admin",
};

const LONG_LABELS = {
  product: "EXO Labs",
  screen: "Placement",
  purpose: "Place a very long model identifier on a cluster",
  primaryDecision: "place a model on a cluster",
  primaryAction: "Place model",
  requiredInformation: [
    "meta-llama/Llama-3.1-405B-Instruct-AWQ-INT4-128k-context-rev-2026-08",
    "CUDA out of memory while allocating the sharded KV cache for shard 7 of 12",
  ],
  values: {},
  dataMode: "demo",
};

const DIAGRAM = {
  product: "EXO Labs",
  screen: "Topology",
  purpose: "See how the cluster is wired and where the traffic goes",
  primaryDecision: "inspect the network topology of the fleet",
  primaryAction: "Trace path",
  requiredInformation: ["node topology", "GPU memory", "model throughput", "latency"],
  interactions: [
    { from: "node topology", to: "GPU memory", kind: "connect" },
    { from: "node topology", to: "latency", kind: "connect" },
  ],
  dataMode: "demo",
};

const REFERENCE_LED = {
  product: "EXO Labs",
  screen: "Cluster Console",
  purpose: "Operate a cluster from one console",
  primaryDecision: "operate a cluster from one console",
  primaryAction: "Drain node",
  references: {
    observations: ["The reference console uses a dark instrument surface for the live region and a light chrome around it."],
    assumptions: ["The dark region is the focal area, not the whole screen."],
  },
  visualDirection: "quiet-instrument",
  antiGoals: ["scanlines on every surface", "green accents on unrelated elements"],
  requiredInformation: ["cluster health", "node topology", "recent deploys"],
  dataMode: "demo",
};

const STATES = {
  product: "EXO Labs",
  screen: "Model List",
  purpose: "Find a model that is ready to run",
  primaryDecision: "select a model that is ready to run",
  primaryAction: "Run model",
  requiredInformation: ["model throughput", "GPU memory", "shard count"],
  states: ["ready", "loading", "error", "empty"],
  dataMode: "demo",
};

/* -------------------------------------------------------------------------- */
/* G11 — the brief is checked before anything is created                        */
/* -------------------------------------------------------------------------- */

test("G11 — a contradictory brief fails before any canvas mutation", async () => {
  const cases = [
    {
      name: "the direction and the anti-goal contradict each other",
      brief: { ...PRODUCT_OVERVIEW, visualDirection: "dark instrument", antiGoals: ["no dark surfaces"] },
      expect: "direction-conflict-dark",
    },
    {
      name: "the data is called live and described as sample",
      brief: { ...PRODUCT_OVERVIEW, dataMode: "live", dataNotes: "sample numbers from the last demo run" },
      expect: "data-mode-conflict",
    },
    {
      name: "the primary action is also a secondary action",
      brief: { ...PRODUCT_OVERVIEW, secondaryActions: ["Open cluster"] },
      expect: "action-conflict",
    },
    {
      name: "the same information is required and optional",
      brief: { ...PRODUCT_OVERVIEW, optionalInformation: ["cluster health"] },
      expect: "information-conflict",
    },
    {
      name: "the screen has no task at all",
      brief: { screen: "Empty" },
      expect: "no-task",
    },
    {
      name: "the viewport cannot hold a screen",
      brief: { ...PRODUCT_OVERVIEW, viewport: { width: 200, height: 200 } },
      expect: "viewport-too-small",
    },
  ];

  for (const c of cases) {
    const result = await designPipelineTool(null, null, { brief: c.brief });
    assert.equal(result.status, "blocked", `${c.name}: expected a blocked brief`);
    assert.ok(
      result.blockers.some((b) => b.id === c.expect),
      `${c.name}: expected blocker '${c.expect}', got ${result.blockers.map((b) => b.id).join(", ")}`,
    );
    assert.equal(result.operations, undefined, `${c.name}: a blocked brief must not produce operations`);
  }
});

test("G11 — a blocked brief never reaches the plugin", async () => {
  let touched = false;
  const session = {
    request: () => {
      touched = true;
      throw new Error("the pipeline must not contact Figma for a contradictory brief");
    },
  };
  const result = await designPipelineTool(session, null, {
    brief: { screen: "Nothing", visualDirection: "dark", antiGoals: ["no dark surfaces"] },
  });
  assert.equal(result.status, "blocked");
  assert.equal(touched, false, "the pipeline contacted Figma despite a contradictory brief");
});

/* -------------------------------------------------------------------------- */
/* G01/G02/G03 — the brief becomes a composition                                */
/* -------------------------------------------------------------------------- */

test("G01 — a product overview becomes a composed screen with a hero, an action and supporting content", () => {
  const result = run(PRODUCT_OVERVIEW);
  assert.equal(result.blockers.length, 0);
  assert.ok(result.plan.focal !== null, "the plan has no focal region");
  assert.ok(
    result.plan.content.some((s) => s.id === "slot-action-primary" && s.label === "Open cluster"),
    "the primary action is not in the plan",
  );
  assert.ok(result.plan.content.length >= 5, `the plan carries ${result.plan.content.length} slots`);
  assert.equal(result.compiled.applicable, true, `the program does not resolve: ${result.compiled.inapplicableReasons.join("; ")}`);
  assert.deepEqual(failingChecks(result.structure.checks), [], "a structural check failed");
  storeEvidence("G01", result);
});

test("G02 — an asymmetric split view keeps the inspector fixed and the canvas fluid", () => {
  const result = run(SPLIT_VIEW);
  const inspector = result.plan.regions.find((r) => r.role === "inspector");
  const canvas = result.plan.regions.find((r) => r.role === "content" || r.role === "primary-visual");
  assert.ok(inspector !== undefined, "the split view has no inspector");
  assert.ok(canvas !== undefined, "the split view has no canvas");
  assert.equal(typeof inspector.sizing.width, "number", "the inspector is not a fixed-width region");
  assert.ok(inspector.sizing.width < result.plan.canvas.width / 2, "the inspector is not subordinate to the canvas");
  assert.equal(result.compiled.applicable, true);
  storeEvidence("G02", result);
});

test("G03 — a dense dashboard holds thirty items without losing its structure", () => {
  const result = run(DENSE_DASHBOARD);
  assert.equal(result.blockers.length, 0);
  assert.ok(
    result.plan.content.filter((s) => s.kind !== "heading" && s.kind !== "action").length >= 30,
    `the plan carries ${result.plan.content.length} slots, fewer than the 30 items the brief names`,
  );
  assert.equal(result.compiled.applicable, true, `the dense program does not resolve: ${result.compiled.inapplicableReasons.join("; ")}`);
  assert.deepEqual(failingChecks(result.structure.checks), [], "a structural check failed on the dense screen");
  assert.equal(
    result.structure.checks.find((c) => c.id === "required-information-present")?.status,
    "pass",
    "the dense screen lost required information",
  );
  storeEvidence("G03", result);
});

/* -------------------------------------------------------------------------- */
/* G04 — text wrapping                                                         */
/* -------------------------------------------------------------------------- */

test("G04 — long identifiers and errors wrap inside their region at 390px and 1440px", () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const result = run({ ...LONG_LABELS, viewport });
    assert.equal(result.blockers.length, 0, `the ${viewport.width}px brief was blocked`);
    assert.equal(result.compiled.applicable, true, `the ${viewport.width}px program does not resolve`);
    for (const op of result.compiled.operations) {
      if (op.type !== "createText") continue;
      // The pipeline's own text nodes are the ones with a wrapping promise.
      // A component's internal label is sized by the component.
      if (typeof op.id !== "string" || !op.id.startsWith("slot-")) continue;
      const width = typeof op.width === "number" ? op.width : 0;
      assert.ok(width > 0, `text '${op.content}' has no width`);
      assert.ok(width <= viewport.width, `text '${op.content}' is ${width}px wide on a ${viewport.width}px viewport`);
    }
    // The wrapping width is a promise, so it has to be in the program.
    const texts = result.program.content.filter((c) => c.fn === "text");
    assert.ok(texts.length > 0, "the screen has no text");
    for (const t of texts) {
      assert.equal(typeof t.args.maxWidth, "number", `text '${t.args.text}' has no wrapping width`);
    }
  }
  storeEvidence("G04", run({ ...LONG_LABELS, viewport: { width: 390, height: 844 } }));
});

/* -------------------------------------------------------------------------- */
/* G05 — semantic diagrams                                                      */
/* -------------------------------------------------------------------------- */

test("G05 — a relationship is drawn between the nodes it names, not as decoration", () => {
  const result = run(DIAGRAM);
  const connectors = result.program.content.filter((c) => c.fn === "connector");
  assert.equal(connectors.length, 2, `expected two connectors, found ${connectors.length}`);
  for (const connector of connectors) {
    assert.equal(typeof connector.args.from, "string");
    assert.equal(typeof connector.args.to, "string");
    // The endpoints have to be real content ids, or the connector points at
    // nothing and the compiler reports it as unresolvable.
    const ids = new Set(result.program.content.map((c) => c.id));
    assert.ok(ids.has(connector.args.from), `connector endpoint '${connector.args.from}' names no node`);
    assert.ok(ids.has(connector.args.to), `connector endpoint '${connector.args.to}' names no node`);
  }
  assert.equal(
    result.compiled.violations.filter((v) => v.rule === "connector").length,
    0,
    "a connector did not resolve to the nodes it names",
  );
  storeEvidence("G05", result);
});

/* -------------------------------------------------------------------------- */
/* G06/G07 — the visual system                                                  */
/* -------------------------------------------------------------------------- */

test("G06 — a reference-led direction becomes rules, and the anti-goals are kept", () => {
  const result = run(REFERENCE_LED);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.brief.visualDirection, "quiet-instrument");
  assert.deepEqual(result.brief.antiGoals, ["scanlines on every surface", "green accents on unrelated elements"]);
  assert.equal(result.program.visualIntent.style, "quiet-instrument", "the direction did not reach the build");
  // A reference observation and a reference assumption are kept apart.
  assert.equal(result.brief.references.observations.length, 1);
  assert.equal(result.brief.references.assumptions.length, 1);
  assert.ok(
    result.assumptions.some((a) => a.source === "inferred" && a.statement.includes("dark region is the focal area")),
    "the inferred assumption was not recorded as an inference",
  );
  storeEvidence("G06", result);
});

test("G07 — one visual system produces two different screens", () => {
  const a = run(PRODUCT_OVERVIEW);
  const b = run({ ...PRODUCT_OVERVIEW, screen: "Incident Console", primaryDecision: "diagnose why a job failed" });
  assert.equal(a.program.visualIntent.style, b.program.visualIntent.style, "the two screens lost the shared visual system");
  const regionsA = a.plan.regions.map((r) => r.id).join(",");
  const regionsB = b.plan.regions.map((r) => r.id).join(",");
  assert.notEqual(regionsA, regionsB, "the two screens have the same composition, which is the template trap");
  storeEvidence("G07", b);
});

/* -------------------------------------------------------------------------- */
/* G08 — reuse                                                                  */
/* -------------------------------------------------------------------------- */

test("G08 — repeated surfaces are reported as duplicates rather than shipped silently", () => {
  const result = run(DENSE_DASHBOARD);
  const advisories = reuseAdvisory(result.compiled.operations);
  assert.ok(advisories.length > 0, "thirty repeated surfaces produced no reuse advisory");
  assert.match(advisories[0], /create_component|create_instance/);
  storeEvidence("G08", result);
});

/* -------------------------------------------------------------------------- */
/* G09 — states                                                                 */
/* -------------------------------------------------------------------------- */

test("G09 — the declared states are part of the composition", () => {
  const result = run(STATES);
  const stateSlot = result.plan.content.find((s) => s.id === "slot-states");
  assert.ok(stateSlot !== undefined, "the declared states are not in the plan");
  assert.deepEqual(stateSlot.states, ["ready", "loading", "error", "empty"]);
  const strip = result.program.content.find((c) => c.id === "slot-states");
  assert.ok(strip !== undefined, "the state strip is not in the program");
  assert.deepEqual(strip.args.states, ["ready", "loading", "error", "empty"]);
  storeEvidence("G09", result);
});

/* -------------------------------------------------------------------------- */
/* G10 — a retry cannot duplicate the screen                                     */
/* -------------------------------------------------------------------------- */

test("G10 — the same brief builds the same screen, so a retry cannot duplicate it", () => {
  const first = run(PRODUCT_OVERVIEW);
  const second = run(PRODUCT_OVERVIEW);
  const ids = (r) => r.compiled.operations.map((o) => `${o.type}:${o.id ?? ""}:${o.parent ?? ""}:${o.x ?? ""}:${o.y ?? ""}`).join("|");
  assert.equal(ids(first), ids(second), "the same brief produced two different builds");
});

test("G10 — the ledger returns the prior result for a repeated transaction id", () => {
  const ledger = new JobLedger();
  const session = { id: "s1", fileKey: "k1", fileName: "Test.figma" };
  ledger.begin({ transactionId: "txn_1", tool: "create_design", session, operationCount: 2 });
  const result = { status: "success", createdNodes: [{ figmaNodeId: "1:1" }] };
  ledger.complete("txn_1", "committed", { done: 2, createdIds: ["1:1"] }, result);
  const prior = ledger.priorResult("txn_1");
  assert.deepEqual(prior, result, "a repeated transaction id did not return the prior result");
  assert.equal(ledger.priorResult("txn_other"), undefined, "an unknown transaction id returned a result");
});

/* -------------------------------------------------------------------------- */
/* G12 — a repair is targeted                                                    */
/* -------------------------------------------------------------------------- */

test("G12 — a repair touches only the nodes it names", () => {
  const findings = [
    {
      id: "f1",
      stage: "live",
      severity: "high",
      confidence: 0.9,
      nodeIds: ["12:34"],
      summary: "A card overflows its region",
      why: "The card is wider than the region that holds it.",
      evidence: { kind: "geometry", detail: "363 > 320" },
      fix: "Resize the card.",
      automatable: true,
      suggestedOperations: [{ type: "setSize", target: "12:34", width: 320, height: 90 }],
    },
    {
      id: "f2",
      stage: "live",
      severity: "medium",
      confidence: 0.6,
      nodeIds: ["56:78"],
      summary: "Two labels are too close together",
      why: "Spacing is inconsistent.",
      evidence: { kind: "geometry", detail: "8px" },
      fix: "Increase the gap.",
      automatable: true,
    },
    {
      id: "f3",
      stage: "live",
      severity: "low",
      confidence: 0.3,
      nodeIds: ["90:12"],
      summary: "A label could be nicer",
      why: "Taste.",
      evidence: { kind: "heuristic", detail: "taste" },
      fix: "Rephrase it.",
      automatable: false,
    },
  ];

  const plan = planRepairs(findings, { budget: 3 });
  assert.equal(plan.instructions.length, 1, "a finding without a targeted operation became a repair");
  assert.deepEqual(plan.instructions[0].targetIds, ["12:34"]);
  assert.equal(plan.instructions[0].operations.length, 1);
  assert.ok(
    plan.skipped.some((s) => s.findingId === "f2" && /no targeted operation/i.test(s.why)),
    "the skipped finding did not say why it was skipped",
  );
  assert.ok(
    plan.skipped.some((s) => s.findingId === "f3" && /human decision/i.test(s.why)),
    "a finding that needs a human was not reported as such",
  );

  // The budget is a budget, and running out of it is not convergence.
  const tight = planRepairs(findings, { budget: 1 });
  assert.equal(tight.instructions.length, 1);
  assert.ok(tight.skipped.some((s) => /budget/i.test(s.why)));
});

test("G12 — a repeated repair operation is applied once", () => {
  const ops = [
    { type: "setSize", target: "1:1", width: 320 },
    { type: "setSize", target: "1:1", width: 320 },
    { type: "setPosition", target: "1:1", x: 10 },
  ];
  const deduped = deduplicateOperations(ops);
  assert.equal(deduped.length, 2, "a repeated operation survived deduplication");
});

/* -------------------------------------------------------------------------- */
/* G13/G14 — verification honesty                                                */
/* -------------------------------------------------------------------------- */

test("G13 — an empty inspection is never a pass", () => {
  const result = run(PRODUCT_OVERVIEW);
  const live = verifyLive(result.plan, { createdNodes: [] });
  assert.equal(live.status, "indeterminate", "an empty inspection was reported as a success");
  assert.ok(live.findings.some((f) => f.id === "no-nodes-created"));
  assert.ok(
    live.checks.find((c) => c.id === "nodes-created")?.status === "indeterminate",
    "the empty inspection did not produce an indeterminate check",
  );
});

test("G13 — a stale render is a failure, not a pass", () => {
  const result = run(PRODUCT_OVERVIEW);
  const live = verifyLive(result.plan, {
    createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
    metrics: null,
    render: { revisionId: "rev-1", at: Date.now() },
    currentRevision: "rev-2",
  });
  assert.equal(live.status, "fail", "a stale render was reported as a success");
  assert.ok(live.findings.some((f) => f.id === "render-stale"));
});

test("G14 — a render discrepancy is caught even though every operation succeeded", () => {
  const result = run(PRODUCT_OVERVIEW);
  // Every operation succeeded: the transaction created its nodes.
  const live = verifyLive(result.plan, {
    createdNodes: [
      { temporaryId: "root", figmaNodeId: "1:1" },
      { temporaryId: "header", figmaNodeId: "1:2" },
    ],
    metrics: null,
    render: { revisionId: "rev-1", at: Date.now() },
    currentRevision: "rev-2",
  });
  assert.equal(live.status, "fail");
  const report = buildReport({
    planned: true,
    applied: true,
    operations: result.compiled.operations.length,
    nodeIds: ["1:1", "1:2"],
    transactionId: "txn_1",
    structure: { status: "pass", checks: result.structure.checks, detail: "offline checks" },
    live: { status: live.status, checks: live.checks, detail: "live checks" },
    visual: { status: "fail", detail: "the render is stale", renderRevision: "rev-1" },
    repairs: [],
    findings: live.findings,
    blocked: [],
    trace: { briefId: "b", planId: "p", stages: [], operations: [], nodeIds: [], checks: [], findings: [], repairs: [], render: null },
  });
  assert.equal(report.status, "incomplete", "a stale render was reported as a finished screen");
  assert.equal(report.visuallyReviewed.status, "fail");
  assert.equal(report.generated.applied, true, "the build itself did happen, and the report must say so");
});

test("the report separates generated, verified, repaired and blocked", () => {
  const result = run(PRODUCT_OVERVIEW);
  const report = buildReport({
    planned: true,
    applied: true,
    operations: result.compiled.operations.length,
    nodeIds: ["1:1"],
    transactionId: "txn_1",
    structure: { status: "pass", checks: result.structure.checks, detail: "offline checks" },
    live: null,
    visual: { status: "not-run", detail: "nothing was rendered", renderRevision: null },
    repairs: [{ findingId: "f1", operations: 2, result: "applied", detail: "resized a card" }],
    findings: [],
    blocked: [{ check: "visual-review", why: "no render was produced" }],
    trace: { briefId: "b", planId: "p", stages: [], operations: [], nodeIds: [], checks: [], findings: [], repairs: [], render: null },
  });
  assert.equal(report.generated.applied, true);
  assert.equal(report.structurallyVerified.status, "pass");
  assert.equal(report.visuallyReviewed.status, "not-run", "an unrendered screen claimed a visual verdict");
  assert.equal(report.automaticallyRepaired.count, 1);
  assert.equal(report.blocked.length, 1);
  assert.match(report.summary, /not rendered or reviewed/);
  assert.doesNotMatch(report.summary, /verified:/);
});

/* -------------------------------------------------------------------------- */
/* The auto-layout container                                                     */
/* -------------------------------------------------------------------------- */

test("a region whose content has known extents is built as a native auto-layout container", () => {
  const result = run({
    ...PRODUCT_OVERVIEW,
    screen: "Only Components",
    // Issue #25 + plan content fit: the region that carries the required
    // information holds value-stated components only — a component with a
    // known extent is one whose value is stated (a required item with no
    // value renders as its label text, and a region whose every readout the
    // valueless-instrument policy omits is not built at all). The headings
    // stay in the identity rail, where the plan puts them; the readouts land
    // in the flow-vertical secondary band, whose every child has a fixed
    // extent — the case a native auto-layout container exists for.
    requiredInformation: ["shard count", "model version", "benchmark score"],
    optionalInformation: [],
    values: {
      "shard count": "12 of 12 synced",
      "model version": "v4.2-awq",
      "benchmark score": "68.4",
    },
  });
  const autoRegions = result.plan.regions.filter((r) => r.autoLayout);
  assert.ok(autoRegions.length > 0, "no region was built as an auto-layout container");
  for (const region of autoRegions) {
    const op = opOf(result.compiled, region.id);
    assert.ok(op !== undefined, `region '${region.id}' has no frame`);
    assert.equal(op.layoutMode, "VERTICAL", `region '${region.id}' is not a native auto-layout container`);
  }
  assert.equal(
    result.structure.checks.find((c) => c.id === "auto-layout-applied")?.status,
    "pass",
    "the auto-layout check did not pass",
  );
});

test("a region holding text keeps absolute placement, and says why", () => {
  const result = run(PRODUCT_OVERVIEW);
  // Whichever region carries the screen's identity, it holds text — and a
  // region holding text cannot be handed to Figma's own layout, because text
  // height is estimated rather than measured.
  const withText = result.plan.regions.filter((r) => r.contentHierarchy.some((id) => id.startsWith("slot-heading")));
  assert.ok(withText.length > 0, "no region carries the screen's identity");
  for (const region of withText) {
    assert.equal(region.autoLayout, false, `region '${region.id}' holds text and was handed to Figma's own layout`);
    const op = opOf(result.compiled, region.id);
    assert.equal(op.layoutMode, undefined, `the '${region.id}' frame was given an auto layout it cannot honour`);
  }
});

/* -------------------------------------------------------------------------- */
/* The plan is reviewable before it exists                                       */
/* -------------------------------------------------------------------------- */

test("the plan says why every region exists, and what it carries", () => {
  const result = run(PRODUCT_OVERVIEW);
  for (const region of result.plan.regions) {
    assert.ok(region.why.length > 10, `region '${region.id}' has no reason`);
    assert.ok(region.constraints.overflow.length > 0, `region '${region.id}' has no overflow rule`);
    assert.ok(region.priority > 0, `region '${region.id}' has no priority`);
  }
  for (const slot of result.plan.content) {
    assert.ok(slot.because.length > 10, `slot '${slot.id}' has no reason`);
  }
  assert.ok(result.plan.hierarchy.length > 0, "the plan has no hierarchy");
  assert.ok(result.plan.usage.notes.length === 0 || result.plan.usage.coverage > 0, "the plan did not measure the canvas");
});
