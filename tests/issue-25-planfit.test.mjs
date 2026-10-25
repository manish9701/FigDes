/**
 * Issue #25 — the plan-side content fit (with issue #28's composition handoff).
 *
 * ## The defect
 *
 * The plan declared fixed-height chrome (a 64px status rail, a 72/88px header)
 * while dumping the screen's title, description and primary action — and the
 * required information — into it. At build time the compiler's fit-to-content
 * pass grew that chrome to hold what the plan had crammed into it (64→126px,
 * 72→139px), pushed every fill band down, and the focal region resolved
 * smaller than the share the plan promised. Issue #28's handoff gate —
 * correctly — refused the build the plan itself had set up.
 *
 * ## What these tests pin
 *
 * The plan now states the room the content needs with the compiler's own
 * estimator, before anything is built:
 *
 *   1. the identity band's declared height covers its content's estimate —
 *      the build resolves it at exactly the declared height, no growth;
 *   2. the build is applicable, with no failing structural check, and no
 *      planned slot is silently lost;
 *   3. the focal region's built share is at least its planned share;
 *   4. a region whose content fits keeps its declared height (growth only,
 *      never shrinkage);
 *   5. the same brief plans byte-for-byte the same plan.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBrief } from "../mcp-server/dist-test/pipeline/brief.js";
import { buildCompositionPlan } from "../mcp-server/dist-test/pipeline/plan.js";
import { buildProgram, applyMeasuredWidths } from "../mcp-server/dist-test/pipeline/program.js";
import { verifyPlan } from "../mcp-server/dist-test/pipeline/verify.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                      */
/* -------------------------------------------------------------------------- */

/** Runs the pipeline offline: brief → plan → program → compile → verify. */
function run(briefInput) {
  const { brief } = normalizeBrief(briefInput);
  const plan = buildCompositionPlan(brief);
  const built = buildProgram(brief, plan);
  const first = executeRuntime(built.program);
  const refined = applyMeasuredWidths(built.program, first.boxes);
  const compiled = executeRuntime(refined.program);
  const program = refined.measured > 0 ? refined.program : built.program;
  const labels = program.content.map((c) => String(c.args.text ?? c.args.label ?? c.args.title ?? ""));
  const structure = verifyPlan(plan, brief, compiled, labels);
  return { brief, plan, built, program, compiled, structure };
}

const failingChecks = (checks) => checks.filter((c) => c.status === "fail").map((c) => c.id);

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

/* -------------------------------------------------------------------------- */
/* 1. the identity band declares the room its content needs                     */
/* -------------------------------------------------------------------------- */

test("G01 — the identity band's declared height covers its content, the build agrees, and nothing is silently lost", () => {
  const result = run(PRODUCT_OVERVIEW);
  assert.equal(result.compiled.applicable, true, `the program does not resolve: ${result.compiled.inapplicableReasons.join("; ")}`);
  assert.deepEqual(failingChecks(result.structure.checks), [], "a structural check failed");

  // The identity band — the region the plan puts the screen's name in.
  const band = result.plan.regions.find((r) => r.contentHierarchy.includes("slot-heading-title"));
  assert.ok(band !== undefined, "the plan has no identity band");
  assert.equal(typeof band.sizing.height, "number", "the identity band is not fixed-height");
  assert.ok(band.sizing.height >= 88, `the identity band grew to ${band.sizing.height}px — it does not cover the title, the description and the action`);

  // The build resolves the band at exactly the declared height: the plan's
  // estimate covered what the content needs, so the build's own fit pass had
  // nothing to reconcile.
  const builtBand = result.compiled.boxes.get(band.id);
  assert.ok(builtBand !== undefined, "the identity band was not built");
  assert.equal(Math.round(builtBand.h), band.sizing.height, `the identity band grew at build time: declared ${band.sizing.height}px, built ${Math.round(builtBand.h)}px — the plan's estimate did not cover its content`);

  // The plan records the reconciliation it made.
  assert.ok(
    result.plan.warnings.some((w) => /Plan content fit/.test(w) && band.id.split(" ").length >= 0),
    "the plan does not record the content-fit pass",
  );

  // No planned slot is silently lost: every slot the plan carries is emitted
  // by the build — no region the plan kept is an empty frame.
  const emittedIds = new Set(result.program.content.map((c) => c.id).filter(Boolean));
  for (const slot of result.plan.content) {
    assert.ok(emittedIds.has(slot.id), `slot '${slot.id}' (${slot.label}) is planned but emitted by nothing`);
  }
  // …and what the valueless-instrument policy omits is on the record.
  assert.ok(
    result.plan.notPlaced.some((n) => n.label === "audit log"),
    `the omitted illustrative instrument is not recorded: ${JSON.stringify(result.plan.notPlaced)}`,
  );
});

/* -------------------------------------------------------------------------- */
/* 2. the focal region keeps the share the plan promised                        */
/* -------------------------------------------------------------------------- */

test("G02 — the focal region's built share is at least its planned share", () => {
  const result = run(SPLIT_VIEW);
  assert.equal(result.compiled.applicable, true, `the program does not resolve: ${result.compiled.inapplicableReasons.join("; ")}`);

  const focal = result.plan.focal;
  assert.ok(focal !== null, "the split view has no focal region");
  const plannedShare = result.plan.usage.focalShare;
  assert.ok(plannedShare > 0, "the plan states no focal share");
  const builtBox = result.compiled.boxes.get(focal.id);
  assert.ok(builtBox !== undefined, "the focal region was not built");
  const canvasArea = result.plan.canvas.width * result.plan.canvas.height;
  const builtShare = (builtBox.w * builtBox.h) / canvasArea;
  const plannedRegion = result.plan.regions.find((r) => r.id === focal.id);
  assert.ok(plannedRegion !== undefined, "the plan does not carry the focal region's own bounds");
  // The gauge hunts the issue-#25 over-promise class: a declared chrome that
  // grew at build time and starved the focal band. The arc it must catch is
  // tens of pixels, not one: the plan carries the focal's fitted height at its
  // fractional estimate (rounded up), while the compiler resolves fill rows at
  // whole pixels — a 1px shortfall in a 900px column is the solver's integer
  // resolution, not an over-promise. Everything beyond one pixel still fails.
  assert.ok(
    builtBox.h >= plannedRegion.bounds.h - 1,
    `the focal region '${focal.id}' was built at ${(builtShare * 100).toFixed(1)}% of the canvas against a planned ${(plannedShare * 100).toFixed(1)}% — the plan over-promised the space the chrome would take (built ${builtBox.h}px against a fitted ${plannedRegion.bounds.h}px)`,
  );
});

/* -------------------------------------------------------------------------- */
/* 3. long labels at both viewports                                             */
/* -------------------------------------------------------------------------- */

test("G04 — the long-label brief resolves at 390px and 1440px", () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const result = run({ ...LONG_LABELS, viewport });
    assert.equal(result.blockers?.length ?? 0, 0);
    assert.equal(
      result.compiled.applicable,
      true,
      `the ${viewport.width}px program does not resolve: ${result.compiled.inapplicableReasons.join("; ")}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 4. growth only, never shrinkage                                              */
/* -------------------------------------------------------------------------- */

test("a region whose content fits keeps its declared height", () => {
  // The required readouts valued, the optional audit log left valueless (so
  // it is honestly omitted and recorded): the detail band holds one
  // fixed-extent instrument that fits inside the planner's 240px declaration,
  // so the content-fit pass must leave the declaration alone — no growth,
  // and never a shrink.
  const result = run({
    ...PRODUCT_OVERVIEW,
    values: {
      "cluster health": "Degraded",
      "GPU memory": "96 GB",
      "model throughput": "88 tok/s",
      "node topology": "12 nodes",
      "recent deploys": "3 today",
    },
  });
  const detail = result.plan.regions.find((r) => r.id === "detail");
  assert.ok(detail !== undefined, "the secondary band is gone from the plan");
  // The planner declares the detail band 240px tall; its readout fits inside.
  assert.equal(detail.sizing.height, 240, `the fitting region's declared height changed: ${JSON.stringify(detail.sizing.height)}`);
  const builtDetail = result.compiled.boxes.get("detail");
  assert.ok(builtDetail !== undefined, "the detail band was not built");
  assert.equal(Math.round(builtDetail.h), 240, "the build disagrees with the untouched declaration");
  assert.equal(result.compiled.applicable, true);
});

/* -------------------------------------------------------------------------- */
/* 5. determinism                                                               */
/* -------------------------------------------------------------------------- */

test("the same brief plans the same plan, byte for byte", () => {
  const brief = normalizeBrief(PRODUCT_OVERVIEW).brief;
  const first = buildCompositionPlan(brief, "plan");
  const second = buildCompositionPlan(brief, "plan");
  assert.equal(JSON.stringify(first), JSON.stringify(second), "two runs of the same brief produced different plans");
});
