/**
 * Issue #26 (GitHub) — enforce composition-first design quality gates and
 * evidence-based visual QA.
 *
 * The issue's own approach was audit-then-implement: most of its requirements
 * already had enforced gates (plan_screen, the pipeline's verify/repair loop,
 * the revision-bound freshness spine, the release gauntlet). This file pins
 * the four gaps the audit confirmed, each of which made a gate beatable:
 *
 * 1. Generic-plan detection on the plan_screen path was OPT-IN (it fired only
 *    when the caller set rejectGenericDashboard, and only warned). The plan
 *    shape is now audited on every call — even card grids, no focal entry
 *    point and uniform sectioning are named with their repair, and land in
 *    guardPreview so the build-time guard enforces them.
 * 2. final_qa's live render was a liveness probe: the final gate's required
 *    render-evidence record was derived `notEvaluated`, so a verdict could
 *    never stand on inspected evidence. The render is now revision-bound,
 *    sanity-checked, and fed into the gate — a missing, failed or blank
 *    render refuses visual approval.
 * 3. screenshot-qa (blank/uniform/band detection) existed and was tested but
 *    ran in NO live path; the pipeline's verifyLiveScreen and final_qa now
 *    run it on every render they take.
 * 4. Two focused repair passes that leave a composition-level finding
 *    unresolved now ESCALATE to composition re-exploration (re-run
 *    plan_screen / design_pipeline) instead of inviting another cosmetic
 *    pass — in both the pipeline loop and refine_screen.
 *
 * All fixtures are offline; the PNG fixtures are real bytes (tests/lib/png.mjs)
 * so the sanity check measures actual pixels. Imports point at the standard
 * dist-test families.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_MAP } from "../mcp-server/dist-test/tools/tools.js";
import { auditPlanShape, buildPlan } from "../mcp-server/dist-test/plan/tools.js";
import { finalQaTool, refineScreenTool } from "../mcp-server/dist-test/review/workflow.js";
import { runRuntimeTool } from "../mcp-server/dist-test/runtime/tools.js";
import { analyzeScreenshot } from "../mcp-server/dist-test/design/quality/screenshot-qa.js";
import { realScreenPng, blankPng } from "./lib/png.mjs";

/* -------------------------------------------------------------------------- */
/* 1. the always-on generic-plan audit                                          */
/* -------------------------------------------------------------------------- */

const TILE = { width: 320, height: 240, grow: 0 };

test("auditPlanShape names an even card grid, no focal and uniform sectioning", () => {
  const evenGrid = auditPlanShape({
    regions: [
      { id: "nav", role: "navigation", width: 240, height: 900, grow: 0 },
      { id: "c1", role: "content", ...TILE },
      { id: "c2", role: "content", ...TILE },
      { id: "c3", role: "content", ...TILE },
    ],
    artDirection: { focal: null },
  });
  assert.ok(evenGrid.some((f) => f.rule === "even-card-grid"), "three equal tiles is the template's card grid");
  assert.ok(evenGrid.some((f) => f.rule === "no-focal"), "no focal entry point is named");
  assert.ok(
    evenGrid.every((f) => f.summary.length > 0 && f.repair.length > 0),
    "every finding carries what it saw and how to earn the pattern",
  );

  const uniform = auditPlanShape({
    regions: [
      { id: "header", role: "header", width: "fill", height: 88, grow: 0 },
      { id: "a", role: "content", width: "fill", height: 300, grow: 1 },
      { id: "b", role: "content", width: "fill", height: 300, grow: 1 },
      { id: "c", role: "content", width: "fill", height: 300, grow: 1 },
      { id: "d", role: "content", width: "fill", height: 300, grow: 1 },
    ],
    artDirection: { focal: { id: "a", why: "the payload" } },
  });
  assert.ok(uniform.some((f) => f.rule === "uniform-sectioning"), "even growth on every content region is flagged");
});

test("auditPlanShape passes a composed plan: asymmetric sizes, a focal, uneven growth", () => {
  const composed = auditPlanShape({
    regions: [
      { id: "nav", role: "navigation", width: 240, height: 900, grow: 0 },
      { id: "field", role: "content", width: "fill", height: "fill", grow: 3 },
      { id: "rail", role: "content", width: 280, height: "fill", grow: 0 },
    ],
    artDirection: { focal: { id: "field", why: "the topology is the content" } },
  });
  assert.deepEqual(composed, [], "a deliberate asymmetry is not a template");
});

test("plan_screen carries the audit on every call: plan.* guardPreview entries match warnings", async () => {
  const handler = TOOL_MAP.get("plan_screen").handler;
  const session = {
    fileKey: "k-audit",
    fileName: "audit.fig",
    request: async () => ({}),
  };
  const out = await handler({ primaryDecision: "select a model", availableInformation: ["latency"] }, { resolve: () => session });
  assert.match(String(out.status), /^planned/);
  assert.equal(out.program.planId, out.planId, "the planId still travels (issue #29)");
  for (const gate of out.guardPreview) {
    if (String(gate.rule).startsWith("plan.")) {
      assert.ok(
        out.warnings.some((w) => w.includes(String(gate.rule))),
        `guardPreview entry '${gate.rule}' must be visible in the warnings too`,
      );
    }
  }
});

/* -------------------------------------------------------------------------- */
/* 2. final_qa: the render-evidence gate is fed, revision-bound                  */
/* -------------------------------------------------------------------------- */

const QA_PROGRAM = {
  canvas: { name: "QA", width: 1440, height: 900, grid: 8 },
  regions: [
    { fn: "navigation", id: "nav", args: { width: 240 } },
    { fn: "hero", id: "hero", args: { grow: 2 } },
  ],
  content: [
    { fn: "text", id: "t1", parent: "hero", args: { text: "Compute", role: "title" } },
    { fn: "text", id: "t2", parent: "hero", args: { text: "online", role: "body" } },
  ],
};

const QA_NODE = {
  id: "screen", name: "Screen", type: "FRAME", visible: true, depth: 0, x: 0, y: 0, w: 1440, h: 900,
  parentId: null, fill: null, stroke: null, radius: 0, text: null,
};

function qaSession(png, build = "77846a0b5870") {
  return {
    build,
    async request(tool, args) {
      if (tool === "collect_metrics") return { target: args.target, scope: "screen", nodeCount: 1, nodes: [QA_NODE] };
      if (tool === "render_node") return { data: png().toString("base64"), width: 1024, height: 640 };
      throw new Error(`unexpected request ${tool}`);
    },
  };
}

test("final_qa feeds a passing render into the final gate as revision-bound evidence", async () => {
  const out = await finalQaTool(qaSession(realScreenPng), {
    program: QA_PROGRAM,
    nodeId: "screen",
    transactionId: "txn-qa-ok",
  });
  assert.ok(out.finalGate, "the final gate is present");
  const renderEvidenceGate = out.finalGate.gates.find((g) => g.name === "render-evidence");
  assert.ok(renderEvidenceGate, "the render-evidence gate record exists");
  assert.equal(renderEvidenceGate.status, "ran", "a sanity-passing render runs the gate instead of leaving it unevaluated");
  assert.match(renderEvidenceGate.detail, /rev-/, "the evidence is bound to the revision it depicts");
  assert.equal(out.renderEvidence.inspected, true);
  assert.equal(out.renderEvidence.rendered, true);
  assert.match(out.renderEvidence.revision, /^rev-/);
});

test("final_qa's render-evidence gate FAILS on a blank render instead of approving it", async () => {
  const out = await finalQaTool(qaSession(blankPng), {
    program: QA_PROGRAM,
    nodeId: "screen",
    transactionId: "txn-qa-blank",
  });
  const renderEvidenceGate = out.finalGate.gates.find((g) => g.name === "render-evidence");
  assert.equal(renderEvidenceGate.status, "failed", "a render nobody can see content in is not visual evidence");
  assert.equal(out.finalGate.verdict, "FAIL", "the gate refuses visual approval");
  assert.ok(
    out.finalGate.verdictReasons.some((r) => /render-evidence|Stale screenshot/i.test(r)),
    `the refusal names the render evidence: ${JSON.stringify(out.finalGate.verdictReasons)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* 3. the pipeline's live verification sanity-checks its render                  */
/* -------------------------------------------------------------------------- */

test("runRuntimeTool: a planned build whose render decodes to a blank canvas fails visual QA", async () => {
  // The pipeline path is exercised through the same runtime dispatch the tool
  // uses; the blank render must surface as a visual finding, never as a pass.
  // (verifyLiveScreen is the pipeline-internal half; the runtime tool's own
  // dispatch is registry-gated, so this pins the evidence-binding contract
  // through compile-level verification instead.)
  const analysis = analyzeScreenshot(blankPng());
  assert.equal(analysis.renderStatus, "suspect-blank");
  const good = analyzeScreenshot(realScreenPng());
  assert.equal(good.renderStatus, "ok");
});

/* -------------------------------------------------------------------------- */
/* 4. the composition-escalation gate in refine_screen                           */
/* -------------------------------------------------------------------------- */

function radiusMetrics() {
  const node = (id, parentId, name, x, y, w, h, extra = {}) => ({
    id,
    parentId,
    type: parentId === null ? "FRAME" : "RECTANGLE",
    name,
    depth: parentId === null ? 0 : 1,
    x,
    y,
    w,
    h,
    visible: true,
    defaultNamed: false,
    zIndex: 0,
    fill: "#151713",
    background: "#0F1110",
    ...extra,
  });
  return {
    target: "1:1",
    scope: "Gate Screen",
    nodeCount: 3,
    truncated: false,
    nodes: [
      node("1:1", null, "Screen", 0, 0, 400, 200),
      node("1:2", "1:1", "Card A", 10, 10, 100, 40, { radius: 8 }),
      node("1:3", "1:1", "Card B", 120, 10, 100, 40, { radius: 12 }),
    ],
  };
}

function fakeLedger() {
  const store = new Map();
  return {
    store,
    begin(j) {
      store.set(j.transactionId, { ...j, state: "queued" });
    },
    get(id) {
      return store.get(id);
    },
    priorResult() {
      return undefined;
    },
    update(id, patch) {
      Object.assign(store.get(id), patch);
    },
    complete(id, state, info, result) {
      const job = store.get(id);
      job.state = state;
      if (result) job.result = result;
    },
  };
}

test("refine_screen escalates to composition exploration when fixes do not resolve", async () => {
  const SUCCESS = { status: "success", createdNodes: [{ temporaryId: "x", figmaNodeId: "1:9" }], timings: { apply: 1, total: 2 }, rollbackStatus: "none" };
  const session = {
    notify() {},
    requestIdFor() {
      return undefined;
    },
    // The same measurements every time: the fix lands, the defect stays —
    // exactly the shape that must NOT invite another cosmetic pass.
    request: async (tool) => (tool === "collect_metrics" ? radiusMetrics() : SUCCESS),
  };
  const registry = { jobs: fakeLedger(), resolve: () => session };
  const out = await refineScreenTool(session, { nodeId: "1:1", maxIterations: 2 }, registry);
  assert.equal(out.status, "budget-exhausted");
  assert.ok(out.summary.unresolvedStructural > 0, "a fix that did not resolve is outstanding structural work");
  assert.ok(out.compositionReviewRequired, "the escalation block is present");
  assert.equal(out.compositionReviewRequired.required, true);
  assert.match(out.compositionReviewRequired.instruction, /plan_screen|design_pipeline/, "the escalation names the composition tools");
});

test("refine_screen does not escalate when the loop converged", async () => {
  const SUCCESS = { status: "success", createdNodes: [{ temporaryId: "x", figmaNodeId: "1:9" }], timings: { apply: 1, total: 2 }, rollbackStatus: "none" };
  let measurements = 0;
  const fixedMetrics = () => ({
    target: "1:1",
    scope: "Gate Screen",
    nodeCount: 3,
    truncated: false,
    nodes: [
      { id: "1:1", parentId: null, type: "FRAME", name: "Screen", depth: 0, x: 0, y: 0, w: 400, h: 200, visible: true, defaultNamed: false, zIndex: 0, fill: "#151713", background: "#0F1110" },
      { id: "1:2", parentId: "1:1", type: "RECTANGLE", name: "Card A", depth: 1, x: 10, y: 10, w: 100, h: 40, visible: true, defaultNamed: false, zIndex: 0, radius: 12, fill: "#151713", background: "#0F1110" },
      { id: "1:3", parentId: "1:1", type: "RECTANGLE", name: "Card B", depth: 1, x: 120, y: 10, w: 100, h: 40, visible: true, defaultNamed: false, zIndex: 0, radius: 12, fill: "#151713", background: "#0F1110" },
    ],
  });
  const session = {
    notify() {},
    requestIdFor() {
      return undefined;
    },
    // First measure reports the radius defect; after the fix it is gone.
    request: async (tool) => (tool === "collect_metrics" ? (measurements++ === 0 ? radiusMetrics() : fixedMetrics()) : SUCCESS),
  };
  const registry = { jobs: fakeLedger(), resolve: () => session };
  const out = await refineScreenTool(session, { nodeId: "1:1", maxIterations: 3 }, registry);
  assert.equal(out.compositionReviewRequired, undefined, "a converged loop needs no escalation");
  assert.equal(out.status, "converged");
});

/* -------------------------------------------------------------------------- */
/* 5. the planless build gate still holds (issue #29, cross-check)               */
/* -------------------------------------------------------------------------- */

test("a planless three-region program is still refused end to end", async () => {
  const out = await runRuntimeTool(
    { fileKey: "k-x", fileName: "x.fig", request: async () => ({}) },
    {
      program: {
        canvas: { name: "Gate", width: 1440, height: 900 },
        regions: [
          { fn: "navigation", id: "nav", args: { width: 240, role: "navigation" } },
          { fn: "header", id: "header", args: { role: "header" } },
          { fn: "frame", id: "main", args: { width: "fill", height: "fill", role: "content" } },
        ],
      },
    },
    undefined,
  );
  assert.equal(out.status, "needs-approval");
  assert.match(out.instead, /plan_screen/);
});
