/**
 * Issue #26 — pipeline connector-evidence + first-build completeness gates.
 *
 * What this pins, and why each assertion is at the level it is:
 *
 *   1. Connector evidence reaches the pipeline preflight. The pipeline used
 *      to thread only the geometry trio into its `PreflightContext`, so
 *      `checkConnectors` silently no-oped on the pipeline path while the
 *      runtime path carried `compiled.connectorRoutes`. The test compiles a
 *      real connector program, threads the routes the way the pipeline now
 *      does, and shows the blocking connector class fires on drifted
 *      geometry — and stays quiet without the evidence. It also pins that
 *      the pipeline's evidence is the same shape the runtime already uses.
 *   2. Critical/high `verifyPlan` findings (required-information-missing,
 *      primary-action-missing, region-off-canvas) refuse the apply through
 *      `firstBuildBlockers`, while medium/low stay advisory. One leg runs
 *      the real `designPipelineTool` build path with a stubbed session and
 *      asserts nothing is created; the unit legs pin the predicate itself.
 *   3. Type-criteria sub-11px labels (`type.space.readable-labels`) enter
 *      the same gate: 10px blocks, 11px passes, a documented exception passes.
 *   4. `verifyLive` fails — never reviews — a promised connector with no
 *      attached route in the live metrics, or with a missing/stale render.
 *      Controls prove the check passes when the route is routed and rendered,
 *      and stays out of the way when nothing was promised.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyPlan, verifyLive } from "../mcp-server/dist-test/pipeline/verify.js";
import { designPipelineTool, firstBuildBlockers } from "../mcp-server/dist-test/pipeline/tools.js";
import { normalizeBrief } from "../mcp-server/dist-test/pipeline/brief.js";
import { buildCompositionPlan } from "../mcp-server/dist-test/pipeline/plan.js";
import { buildProgram, applyMeasuredWidths } from "../mcp-server/dist-test/pipeline/program.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { runtimePreflightContext } from "../mcp-server/dist-test/runtime/tools.js";
import { auditTypeCriteria } from "../mcp-server/dist-test/design/quality/type-criteria.js";
import { validateTransaction } from "../mcp-server/dist-test/reliability/preflight.js";
import { JobLedger } from "../mcp-server/dist-test/reliability/sessions.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

/** The offline pipeline run: brief → plan → program → compile → labels. */
function runOffline(briefInput) {
  const { brief } = normalizeBrief(briefInput, `brief_${Date.now().toString(36)}`);
  const plan = buildCompositionPlan(brief);
  const built = buildProgram(brief, plan);
  const first = executeRuntime(built.program);
  const refined = applyMeasuredWidths(built.program, first.boxes);
  const compiled = executeRuntime(refined.program);
  const program = refined.measured > 0 ? refined.program : built.program;
  const labels = program.content.map((c) => String(c.args.text ?? c.args.label ?? c.args.title ?? c.args.value ?? ""));
  return { brief, plan, built, program, compiled, labels };
}

/** A stub session that fails closed: only the named tools may be contacted. */
function stubSession(touched, handlers = {}) {
  return {
    id: "s26",
    fileKey: "k26",
    fileName: "Issue26.figma",
    notify() {},
    requestIdFor() {
      return "req_26";
    },
    async request(tool, payload) {
      touched.push(tool);
      if (handlers[tool] !== undefined) return handlers[tool](payload);
      if (tool === "measure_text") return {};
      if (tool === "extract_design_system") return {};
      throw new Error(`must not contact Figma tool '${tool}' on this path`);
    },
  };
}

/**
 * A brief with more required inventory than a 360x640 canvas can hold, so
 * required items land in `notPlaced` and `verifyPlan` reports them missing.
 * Probed offline: plan mode reports sixteen required-information-missing
 * (high) plus primary-action-missing (critical) for exactly this brief.
 */
const OVERFLOW_BRIEF = {
  product: "EXO",
  screen: "Ops Wall",
  purpose: "Watch every service at once and catch the one that is wrong",
  primaryDecision: "monitor every service and find the one that needs attention",
  primaryAction: "Acknowledge incident",
  requiredInformation: [
    "API latency", "API errors", "API throughput", "Queue depth", "Queue lag",
    "Worker saturation", "Disk pressure", "Memory pressure", "Network throughput", "Cache hit rate",
    "Model throughput", "Model errors", "Shard balance", "Replica lag",
    "Auth failures", "Token refresh errors", "Rate limit rejections", "Cold start time", "Warm pool size",
    "Inference queue",
  ],
  viewport: { width: 360, height: 640 },
  visualDirection: "dense-admin",
};

const CLEAN_BRIEF = {
  product: "EXO Labs",
  screen: "Fleet Overview",
  purpose: "See the health of the fleet and decide where to intervene",
  primaryDecision: "monitor fleet health and decide where to intervene",
  primaryAction: "Open cluster",
  requiredInformation: ["cluster health", "GPU memory", "model throughput", "node topology", "recent deploys"],
  dataMode: "demo",
  visualDirection: "technical-instrument",
};

/* -------------------------------------------------------------------------- */
/* 1. connector evidence reaches the pipeline preflight                         */
/* -------------------------------------------------------------------------- */

function connectorProgram() {
  return executeRuntime({
    canvas: { name: "Topology", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "deviceNode", id: "hub", parent: "map", args: { label: "hub-01" } },
      { fn: "deviceNode", id: "n1", parent: "map", args: { label: "node-01" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "hub", to: "n1" } },
    ],
  });
}

test("a compiled connector program carries routes the preflight can check", () => {
  const compiled = connectorProgram();
  assert.ok(compiled.connectorRoutes.length > 0, "the compile must route the connector");
  const route = compiled.connectorRoutes[0];
  assert.equal(route.from, "hub");
  assert.equal(route.to, "n1");
  assert.ok(Array.isArray(route.endpoints) && route.endpoints.length >= 2, "a route needs a distinct start and end");
});

test("the pipeline threads connector evidence in the runtime's shape", () => {
  const compiled = connectorProgram();
  // The pipeline builds its context inline from the same compiled result;
  // the runtime helper is the shape contract it must match.
  const runtimeCtx = runtimePreflightContext(compiled);
  assert.ok(Array.isArray(runtimeCtx.connectors) && runtimeCtx.connectors.length > 0);
  const pipelineConnectors = compiled.connectorRoutes;
  assert.deepEqual(pipelineConnectors, runtimeCtx.connectors, "the pipeline threads compiled.connectorRoutes, the runtime's own evidence");
  for (const spec of pipelineConnectors) {
    assert.equal(typeof spec.id, "string");
    assert.equal(typeof spec.from, "string");
    assert.equal(typeof spec.to, "string");
    assert.ok(Array.isArray(spec.endpoints), "endpoints travel with the spec, or checkConnectors has nothing to prove");
  }
});

test("connector evidence activates the blocking connector class — and only with the evidence", () => {
  const compiled = connectorProgram();
  const ops = compiled.operations;
  const boxes = Object.fromEntries([...compiled.boxes].map(([id, box]) => [id, box]));
  // Drift one endpoint's box away from the geometry the route was solved
  // against: the route no longer touches the node it names.
  const drifted = { ...boxes, n1: { ...boxes.n1, x: boxes.n1.x + 500, y: boxes.n1.y + 500 } };
  const base = { planBoxes: drifted };
  const without = validateTransaction(ops, base);
  const withConnectors = validateTransaction(ops, { ...base, connectors: compiled.connectorRoutes });
  assert.ok(
    !without.issues.some((i) => i.message.startsWith("connector:")),
    `without connector evidence the connector class must no-op, got: ${JSON.stringify(without.issues)}`,
  );
  assert.ok(
    withConnectors.issues.some((i) => i.message.startsWith("connector:")),
    "with connector evidence a drifted endpoint must be a blocking issue",
  );
  assert.equal(withConnectors.ok, false, "a drifted connector refuses the transaction");
});

/* -------------------------------------------------------------------------- */
/* 2. critical/high structure findings refuse the apply                         */
/* -------------------------------------------------------------------------- */

test("firstBuildBlockers takes required-information, primary-action and off-canvas at critical/high", () => {
  const { brief, plan, compiled, labels } = runOffline(OVERFLOW_BRIEF);
  const structure = verifyPlan(plan, brief, compiled, labels);
  assert.ok(structure.findings.some((f) => f.id.startsWith("required-information-missing")), "the fixture must lose required information");
  const blocked = firstBuildBlockers(structure, { findings: [] });
  assert.ok(blocked.length > 0, "critical/high completeness findings must block");
  assert.ok(blocked.some((f) => f.id.startsWith("required-information-missing")), "missing required information blocks");
  assert.ok(blocked.every((f) => f.severity === "critical" || f.severity === "high"), "only critical/high block");
  for (const f of blocked) {
    assert.ok(f.summary.length > 0 && f.fix.length > 0, "every blocker names what is wrong and how to fix it");
  }
});

test("firstBuildBlockers leaves medium/low findings advisory", () => {
  const advisory = {
    findings: [
      { id: "focal-missing", severity: "medium", summary: "No focal region.", fix: "Name one." },
      { id: "region-off-canvas-01", severity: "medium", summary: "Hypothetically off canvas.", fix: "Move it." },
      { id: "canvas-usage-01", severity: "low", summary: "Sparse.", fix: "Fill it." },
      { id: "information-not-placed-01", severity: "info", summary: "Optional item dropped.", fix: "Nothing." },
    ],
  };
  assert.deepEqual(firstBuildBlockers(advisory, { findings: [] }), [], "medium/low never block, even for blockable rule ids");
  assert.deepEqual(
    firstBuildBlockers({ findings: [] }, { findings: [{ rule: "type.space.one-rhythm", severity: "medium" }] }),
    [],
    "a medium spacing finding never blocks",
  );
});

test("the pipeline refuses a first build missing required information — and creates nothing", async () => {
  const touched = [];
  const session = stubSession(touched);
  const registry = { jobs: new JobLedger() };
  const result = await designPipelineTool(session, registry, { brief: OVERFLOW_BRIEF });
  assert.equal(result.status, "refused", `expected a completeness refusal, got ${result.status}`);
  assert.equal(result.stage, "completeness");
  assert.ok(Array.isArray(result.problems) && result.problems.length > 0, "the refusal names every blocker");
  for (const problem of result.problems.slice(0, 3)) {
    assert.match(problem, /Fix:/, "every problem carries its fix");
  }
  assert.match(result.note, /Nothing was created/, "the refusal says nothing was created");
  assert.ok(!touched.includes("create_design"), `the apply must not run, contacted: ${touched.join(", ")}`);
  assert.ok(!touched.includes("modify_design"), `no repair may run either, contacted: ${touched.join(", ")}`);
});

test("the completeness gate lets a clean brief through to the apply", async () => {
  const { brief, plan, compiled, labels } = runOffline(CLEAN_BRIEF);
  const structure = verifyPlan(plan, brief, compiled, labels);
  assert.deepEqual(
    firstBuildBlockers(structure, { findings: [] }),
    [],
    "the clean brief must carry no completeness blocker",
  );
  const touched = [];
  const session = stubSession(touched, {
    create_design: () => ({
      status: "success",
      transactionId: "txn_clean",
      dryRun: false,
      createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
      applied: [],
    }),
    collect_metrics: () => {
      throw new Error("collect_metrics: plugin busy");
    },
    render_node: () => {
      throw new Error("render_node: plugin busy");
    },
  });
  const registry = { jobs: new JobLedger() };
  const result = await designPipelineTool(session, registry, { brief: CLEAN_BRIEF });
  assert.notEqual(result.status, "refused", "a clean brief must not be refused");
  assert.notEqual(result.stage, "completeness", "a clean brief must not stop at the completeness gate");
  assert.ok(touched.includes("create_design"), `a clean brief reaches the apply, contacted: ${touched.join(", ")}`);
});

/* -------------------------------------------------------------------------- */
/* 3. sub-11px labels enter the same gate                                        */
/* -------------------------------------------------------------------------- */

test("a 10px label blocks; 11px passes; a documented exception passes", () => {
  const tiny = auditTypeCriteria({
    ops: [{ type: "createText", id: "t1", content: "Tiny metadata", fontSize: 10 }],
  });
  const tinyFinding = tiny.findings.find((f) => f.rule === "type.space.readable-labels");
  assert.ok(tinyFinding, "10px must fail the readable-labels criterion");
  assert.equal(
    firstBuildBlockers({ findings: [] }, tiny).length,
    1,
    "an undocumented sub-floor label refuses the first build",
  );

  const floor = auditTypeCriteria({
    ops: [{ type: "createText", id: "t1", content: "Floor metadata", fontSize: 11 }],
  });
  assert.ok(!floor.findings.some((f) => f.rule === "type.space.readable-labels"), "11px is the floor, not below it");
  assert.deepEqual(firstBuildBlockers({ findings: [] }, floor), [], "the floor passes the gate");

  const excused = auditTypeCriteria({
    ops: [{ type: "createText", id: "t2", content: "Mono micro-label", fontSize: 10, exception: { reason: "tabular micro-label, confirmed legible on the rendered screenshot" } }],
  });
  assert.ok(!excused.findings.some((f) => f.rule === "type.space.readable-labels"), "a documented exception is not a failure");
  assert.deepEqual(firstBuildBlockers({ findings: [] }, excused), [], "a documented exception passes the gate");
});

/* -------------------------------------------------------------------------- */
/* 4. endpoint-invisible connectors fail verifyLive — controls pass             */
/* -------------------------------------------------------------------------- */

function livePlan() {
  return { regions: [{ id: "main" }] };
}

function liveMetrics(extraNodes = []) {
  const nodes = [{ id: "1:1", type: "FRAME", name: "Main" }, ...extraNodes];
  return {
    target: "1:1",
    scope: "live",
    nodes,
    nodeCount: nodes.length,
    truncated: false,
    scanBudget: 100,
    scan: { pageLoads: 0, pagesCached: true },
  };
}

const PROMISED = [{ id: "c1", from: "hub", to: "n1" }];

test("a promised connector with no route in the metrics is a fail, not a review", () => {
  const live = verifyLive(livePlan(), {
    createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
    metrics: liveMetrics(),
    promisedConnectors: PROMISED,
  });
  const check = live.checks.find((c) => c.id === "connector-endpoint-visible");
  assert.ok(check, "the connector-endpoint-visible check must run beside render-freshness");
  assert.equal(check.status, "fail", "no attached route is a fail, never a review");
  assert.equal(live.status, "fail");
  const finding = live.findings.find((f) => f.id.startsWith("connector-endpoint-invisible"));
  assert.ok(finding, "the missing endpoint is recorded as a finding");
  assert.ok(finding.severity === "high" || finding.severity === "critical", "the finding is severe enough to fail");
  assert.match(finding.fix, /render|route/i, "the finding says how to make the endpoint visible");
});

test("a promised connector with a route but a stale render still fails", () => {
  const live = verifyLive(livePlan(), {
    createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
    metrics: liveMetrics([{ id: "2:2", type: "VECTOR", name: "connector c1 route" }]),
    render: { revisionId: "rev-1", at: Date.now() },
    currentRevision: "rev-2",
    ruleFindings: [],
    promisedConnectors: PROMISED,
  });
  assert.equal(
    live.checks.find((c) => c.id === "connector-endpoint-visible")?.status,
    "fail",
    "a stale render cannot certify a visible endpoint",
  );
  assert.equal(live.status, "fail");
});

test("a promised connector with a missing render fails even when the route exists", () => {
  const live = verifyLive(livePlan(), {
    createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
    metrics: liveMetrics([{ id: "2:2", type: "VECTOR", name: "connector c1 route" }]),
    ruleFindings: [],
    promisedConnectors: PROMISED,
  });
  assert.equal(
    live.checks.find((c) => c.id === "connector-endpoint-visible")?.status,
    "fail",
    "no render means no endpoint could be seen",
  );
});

test("control: a routed connector on a fresh render passes", () => {
  const live = verifyLive(livePlan(), {
    createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
    metrics: liveMetrics([{ id: "2:2", type: "VECTOR", name: "connector c1 route" }]),
    render: { revisionId: "rev-9", at: Date.now() },
    currentRevision: "rev-9",
    ruleFindings: [],
    promisedConnectors: PROMISED,
  });
  assert.equal(live.checks.find((c) => c.id === "connector-endpoint-visible")?.status, "pass");
  assert.equal(live.status, "pass", `the control must pass clean, got: ${JSON.stringify(live.checks.map((c) => `${c.id}:${c.status}`))}`);
});

test("control: no promised connectors means no connector verdict either way", () => {
  const live = verifyLive(livePlan(), {
    createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
    metrics: liveMetrics(),
    promisedConnectors: [],
  });
  assert.equal(live.checks.find((c) => c.id === "connector-endpoint-visible")?.status, "pass");
  assert.ok(
    !live.findings.some((f) => f.id.startsWith("connector-endpoint-invisible")),
    "no promised connector means no connector finding",
  );
});
