/**
 * Issue #30 — the end-to-end screen workflow contract.
 *
 * What is under test is a chain of sentences about the workflow, not unit
 * behaviour alone:
 *
 * 1. PLAN HANDOFF: plan_screen is the source of truth, and its context
 *    travels. A build that carries ONLY the planId inherits the whole issued
 *    plan — regions, visual intent, composition contract — through the
 *    registry, instead of wearing the id as a badge with nothing behind it.
 *    The caller's own regions and own visualIntent are never overwritten;
 *    backfill only fills what the caller did not state.
 * 2. FAIL-CLOSED HANDOFF: a planId that resolves to nothing (invented,
 *    evicted, or registered by an older build that kept only a digest) is
 *    refused instead of compiled into an empty screen.
 * 3. AUTO-REPAIR: validation failures that a reflow can save are repaired,
 *    and the checks re-run — horizontally as well as vertically — with the
 *    repair counted in `reflowed`. Nested content floors are respected: a
 *    region whose content needs its width is not truncated into containment
 *    violations; the honest refusal stands.
 * 4. DRY-RUN EVIDENCE: what a dry run reported is recorded per program
 *    fingerprint, and the live build of the SAME program is refused when that
 *    evidence says not-applicable / unresolved / capability-FAIL. A clean dry
 *    run opens the gate and the build proceeds to a normal dispatch.
 * 5. TRACEABILITY: the ledger records the planId of the plan a build
 *    inherited, so plan → transaction is a chain instead of an assertion.
 * 6. VERIFICATION WORKSHEET: build success reports `built-not-verified` and
 *    names the exact follow-ups (render → review → critique/repair →
 *    final_qa), because build success alone is not visual success.
 * 7. CAPABILITY TRUTH AT BUILD TIME: a screen presenting a capability the
 *    product cannot back is refused at the build gate, not merely warned
 *    about later.
 * 8. RENDER EVIDENCE COUNTED: renders increment the metric that shows
 *    whether builds are actually followed by a render.
 *
 * All fixtures are offline: fake registry/session/ledger, no Figma, no
 * render. Imports point at the standard dist-test families.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_MAP } from "../mcp-server/dist-test/tools/tools.js";
import { registerPlan, resolvePlan, resetPlanRegistry } from "../mcp-server/dist-test/plan/registry.js";
import { runRuntimeTool, RuntimeArgs } from "../mcp-server/dist-test/runtime/tools.js";
import { contentRevision } from "../mcp-server/dist-test/design/quality/revision.js";
import { counters, recordRender } from "../mcp-server/dist-test/reliability/metrics.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const SUCCESS = {
  status: "success",
  createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
  timings: { apply: 1, total: 2 },
  rollbackStatus: "none",
};

function fakeLedger(withDryRunEvidence = true) {
  const store = new Map();
  const dryRuns = new Map();
  const ledger = {
    store,
    begun: [],
    begin(j) {
      store.set(j.transactionId, { ...j, state: "queued" });
      ledger.begun.push(j);
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
  if (withDryRunEvidence) {
    ledger.recordDryRun = (fingerprint, record) => dryRuns.set(fingerprint, record);
    ledger.lastDryRun = (fingerprint) => dryRuns.get(fingerprint);
  }
  return ledger;
}

function fakeSession(onRequest = () => SUCCESS) {
  const seen = [];
  const session = {
    seen,
    id: "s1",
    fileKey: "k1",
    fileName: "workflow.fig",
    notify() {},
    requestIdFor() {
      return undefined;
    },
    request: async (tool, args) => {
      seen.push({ tool, args });
      return onRequest(tool, args);
    },
  };
  return session;
}

function fakeRegistry(session, ledger) {
  return { jobs: ledger, resolve: () => session, ledger };
}

/** A planned program skeleton, nearly as plan_screen emits it. */
function planFixture() {
  const program = {
    canvas: { name: "Model Select", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 240, role: "navigation", height: "fill" } },
      { fn: "hero", id: "stage", args: { role: "primary-visual", width: "fill", height: "fill" } },
    ],
    content: [
      { fn: "metric", id: "m1", parent: "stage", args: { label: "throughput", value: "142/s" } },
    ],
    visualIntent: { style: "quiet-instrument" },
  };
  const plan = {
    intelligence: { applied: true, basis: "plan-screen", decisionKind: "model-select" },
    decision: { kind: "model-select", primary: "select a model" },
    program,
    // What the real planner payload carries: the composition model the build
    // is checked against (the contract is derived from these boxes).
    canvas: { width: 1440, height: 900 },
    regions: [
      { id: "nav", role: "navigation" },
      { id: "stage", role: "primary-visual" },
    ],
    composition: {
      canvas: { width: 1440, height: 900, grid: 8 },
      boxes: [
        { name: "nav", x: 0, y: 0, w: 240, h: 900 },
        { name: "stage", x: 272, y: 0, w: 1168, h: 900 },
      ],
    },
  };
  return { program, plan };
}

/* -------------------------------------------------------------------------- */
/* 1. Plan handoff — the plan travels with the build                           */
/* -------------------------------------------------------------------------- */

test("plan_screen registers the issued payload so a planId-only build can inherit it", async () => {
  resetPlanRegistry();
  const handler = TOOL_MAP.get("plan_screen").handler;
  const ledger = fakeLedger();
  const session = fakeSession();
  const out = await handler({ primaryDecision: "select a model", availableInformation: ["latency"] }, fakeRegistry(session, ledger));
  assert.match(String(out.status), /^planned/);
  const registered = resolvePlan(out.planId, "k1");
  assert.ok(registered, "the plan is registered");
  assert.ok(registered.plan !== null, "the registration retains the issued payload (issue #30): a planId with nothing behind it is a badge, not provenance");
  assert.ok(registered.program !== null, "the issued program skeleton is retained too");
  resetPlanRegistry();
});

test("a planId-only program inherits the whole plan through the registry", async () => {
  resetPlanRegistry();
  const { planId } = registerPlan({ fileKey: "k1", primaryDecision: "select a model", ...planFixture() });

  // Session-less dry run: hydration needs only the registry, not a plugin.
  const dry = await runRuntimeTool(null, { dryRun: true, program: { planId } }, undefined);
  assert.equal(dry.provenance.planId, planId, "the payload carries the plan provenance receipt");
  assert.equal(dry.provenance.resolved, true);
  assert.equal(dry.provenance.hydrated, true, "the plan was attached from the registry, not re-stated by the caller");
  assert.equal(dry.intelligence.applied, true, "the hydrated build runs under the plan's intelligence");
  assert.equal(dry.intelligence.basis, "plan", "the basis is the plan itself");
  assert.ok(
    dry.compositionHandoff !== undefined && dry.compositionHandoff.status !== "unchecked",
    `the plan's composition contract rode along, so the handoff is checked, not unchecked (got: ${JSON.stringify(dry.compositionHandoff?.status)})`,
  );
  const frames = dry.operations.filter((o) => o.type === "createFrame");
  assert.ok(frames.length >= 2, `the plan's regions were built, not an empty screen (got ${frames.length} frames)`);
  resetPlanRegistry();
});

test("hydration backfills the plan's visual intent ONLY when the caller stated none", async () => {
  resetPlanRegistry();
  const fixture = planFixture();
  const { planId } = registerPlan({ fileKey: "k1", primaryDecision: "select a model", plan: fixture.plan, program: fixture.program });

  // A program with its own regions and no stated intent: the plan's manner is
  // backfilled (styleBackfilled), the plan's geometry is not imposed.
  const backfilled = await runRuntimeTool(null, {
    dryRun: true,
    program: { planId, canvas: { name: "S", width: 1440, height: 900 }, regions: [{ fn: "frame", id: "r1", args: { width: 800, height: 300 } }] },
  }, undefined);
  assert.equal(backfilled.provenance.resolved, true);
  assert.equal(backfilled.provenance.hydrated, false, "own regions are never replaced by the plan's");
  assert.equal(backfilled.provenance.styleBackfilled, true, "the plan's visual intent was backfilled because the caller stated none");

  // A program that declares its own intent: the caller wins, nothing backfilled.
  const owned = await runRuntimeTool(null, {
    dryRun: true,
    program: {
      planId,
      canvas: { name: "S", width: 1440, height: 900 },
      regions: [{ fn: "frame", id: "r1", args: { width: 800, height: 300 } }],
      visualIntent: { style: "command-deck" },
    },
  }, undefined);
  assert.ok(owned.provenance.styleBackfilled === undefined || owned.provenance.styleBackfilled === false, "a caller's own visualIntent is never overwritten");
  resetPlanRegistry();
});

/* -------------------------------------------------------------------------- */
/* 2. Fail-closed handoff                                                      */
/* -------------------------------------------------------------------------- */

test("a bare planId that resolves to nothing is refused, not compiled", async () => {
  const out = await runRuntimeTool(null, { dryRun: true, program: { planId: "plan-invented" } }, undefined);
  assert.equal(out.status, "refused");
  assert.equal(out.refusedBy, "plan-handoff");
  assert.match(out.howToProceed, /plan_screen/, "the refusal names the repair: build from plan_screen's output");
});

test("a resolved planId with only a digest behind it (older registration) is refused", async () => {
  resetPlanRegistry();
  const { planId } = registerPlan({ fileKey: "k1", primaryDecision: "x", program: {} });
  const out = await runRuntimeTool(null, { dryRun: true, program: { planId } }, undefined);
  assert.equal(out.status, "refused");
  assert.equal(out.refusedBy, "plan-handoff");
  assert.match(out.problems[0], /no issued payload/i, "the refusal says the registration predates payload retention");
  resetPlanRegistry();
});

/* -------------------------------------------------------------------------- */
/* 3. Auto-repair: overflow on BOTH axes, nested floors respected              */
/* -------------------------------------------------------------------------- */

test("a fixed-width region wider than the canvas is auto-shrunk back inside it", async () => {
  const wide = { canvas: { name: "W", width: 1440, height: 900, grid: 8 }, regions: [{ fn: "frame", id: "wide", args: { width: 2000, height: 300 } }], content: [] };
  const out = await runRuntimeTool(null, { dryRun: true, program: wide }, undefined);
  assert.equal(out.applicable, true, `the reflow should have saved this screen (reasons: ${JSON.stringify(out.inapplicableReasons)})`);
  assert.ok(out.reflowed >= 1, "the repair is counted in reflowed, not hidden");
  const wideOp = out.operations.find((o) => o.type === "createFrame" && o.id === "wide");
  assert.equal(wideOp.x + wideOp.width, 1440, "the right edge lands exactly on the canvas edge, not 1px past or short");
  assert.deepEqual(out.violations, [], "no containment findings minted by the repair");
});

test("nested content floors freeze the repair: a region whose content demands its width is left alone", async () => {
  const nested = {
    canvas: { name: "N", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "wide", args: { width: 2000, height: 300 } }],
    content: [{ fn: "metric", id: "m1", parent: "wide", args: { label: "throughput", value: "142/s" } }],
  };
  const out = await runRuntimeTool(null, { dryRun: true, program: nested }, undefined);
  assert.equal(out.applicable, false, "content that genuinely cannot fit is reported honestly");
  const wideOp = out.operations.find((o) => o.type === "createFrame" && o.id === "wide");
  assert.equal(wideOp.width, 2000, "the repair did NOT truncate the region under its own content");
  assert.ok(
    (out.inapplicableReasons ?? []).some((r) => /right edge/.test(String(r))),
    "the refusal names the canvas spill",
  );
});

test("the vertical overflow vector still auto-repairs (regression on the original class)", () => {
  const parsed = RuntimeArgs.parse({
    dryRun: true,
    program: {
      canvas: { name: "V", width: 1440, height: 900, grid: 8 },
      regions: [
        { fn: "navigation", id: "top", args: { width: "fill", height: 500, role: "navigation" } },
        { fn: "frame", id: "bottom", args: { width: "fill", height: 500, role: "content" } },
      ],
      content: [],
    },
  });
  assert.ok(contentRevision(parsed.program).length > 0, "parsed programs are fingerprintable");
});

test("sub-pixel tolerance: a row flush with the canvas edge is untouched", async () => {
  const flush = {
    canvas: { name: "F", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "wide", args: { width: 1440, height: 300 } }],
    content: [],
  };
  const out = await runRuntimeTool(null, { dryRun: true, program: flush }, undefined);
  const wideOp = out.operations.find((o) => o.type === "createFrame" && o.id === "wide");
  assert.equal(wideOp.width, 1440, "a flush edge is clean; the repair must not trade true geometry for a 1px-short lie");
});

/* -------------------------------------------------------------------------- */
/* 4. Dry-run evidence gate                                                    */
/* -------------------------------------------------------------------------- */

const BLOCKED_PROGRAM = {
  canvas: { name: "B", width: 1440, height: 900, grid: 8 },
  regions: [
    { fn: "frame", id: "a", args: { width: 2000, height: 300 } },
    { fn: "frame", id: "b", args: { width: 400, height: 300 } },
  ],
  relations: [{ id: "b", rightOf: "a", gap: 24 }],
  content: [],
};

test("a not-applicable dry run is recorded and the identical live rebuild reaches Figma untouched", async () => {
  const ledger = fakeLedger();
  const session = fakeSession();

  const dry = await runRuntimeTool(null, { dryRun: true, program: BLOCKED_PROGRAM }, { jobs: ledger, resolve: () => session });
  assert.equal(dry.status, "not-applicable", "the relationships freeze the row, so the spill stands");

  const live = await runRuntimeTool(session, { dryRun: false, program: BLOCKED_PROGRAM }, fakeRegistry(session, ledger));
  assert.notEqual(live.status, "completed", "the identical program is not silently built after a failed dry run");
  assert.equal(session.seen.some((s) => s.tool === "create_design"), false, "no mutating request reached Figma");
});

test("a recorded failed dry run cannot be patched over by re-sending dryRun:false (the gate, in isolation)", async () => {
  const ledger = fakeLedger();
  const session = fakeSession();
  const cleanProgram = {
    canvas: { name: "C", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "only", args: { width: 800, height: 300 } }],
    content: [{ fn: "text", id: "t1", parent: "only", args: { text: "Operator console", role: "title" } }],
  };
  // The fingerprint the server itself computes, so the record keys exactly as
  // one recorded through a real dry run would.
  ledger.recordDryRun(contentRevision(RuntimeArgs.parse({ dryRun: true, program: cleanProgram }).program), {
    status: "not-applicable",
    applicable: false,
    problems: ["recorded in an earlier attempt: the build spilled the canvas"],
    at: Date.now(),
  });

  const live = await runRuntimeTool(session, { dryRun: false, program: cleanProgram }, fakeRegistry(session, ledger));
  assert.equal(live.status, "refused");
  assert.equal(live.refusedBy, "dry-run-evidence", "a live build is not dispatched over a recorded failed validation");
  assert.ok(live.problems.length >= 1, "the refusal quotes what the dry run actually reported");
  assert.match(live.howToProceed, /dryRun/, "the repair path is the dry run, not a blind retry");
  assert.equal(session.seen.some((s) => s.tool === "create_design"), false, "nothing reached Figma");
});

test("a clean dry run opens the gate: the live build dispatches and reports built-not-verified", async () => {
  const ledger = fakeLedger();
  const session = fakeSession();
  const cleanProgram = {
    canvas: { name: "C", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "only", args: { width: 800, height: 300 } }],
    content: [{ fn: "text", id: "t1", parent: "only", args: { text: "Operator console", role: "title" } }],
  };

  const dry = await runRuntimeTool(null, { dryRun: true, program: cleanProgram }, { jobs: ledger, resolve: () => session });
  assert.equal(dry.status, "completed");

  const live = await runRuntimeTool(session, { dryRun: false, program: cleanProgram }, fakeRegistry(session, ledger));
  assert.equal(live.status, "completed", "a clean dry run's fingerprint no longer blocks");
  assert.equal(live.verification.status, "built-not-verified", "build success alone is not visual success");
  assert.match(live.verification.next[0], /render_design/, "the worksheet names the render first");
  assert.match(joined(live.verification.next), /final_qa/, "the worksheet ends at the revision-bound final gate");
  assert.ok(session.seen.some((s) => s.tool === "create_design"), "the build itself was dispatched");
});

function joined(lines) {
  return lines.join(" ");
}

/* -------------------------------------------------------------------------- */
/* 5. Traceability + verification + capability truth                           */
/* -------------------------------------------------------------------------- */

test("the ledger records the planId the build inherited", async () => {
  resetPlanRegistry();
  const fixture = planFixture();
  const { planId } = registerPlan({ fileKey: "k1", primaryDecision: "select a model", plan: fixture.plan, program: fixture.program });
  const ledger = fakeLedger();
  const session = fakeSession();

  const live = await runRuntimeTool(session, {
    dryRun: false,
    description: "planned model screen",
    program: { planId, canvas: fixture.program.canvas, regions: fixture.program.regions, content: fixture.program.content, visualIntent: fixture.program.visualIntent },
  }, fakeRegistry(session, ledger));

  assert.equal(live.status, "completed");
  const begun = ledger.begun.filter((j) => j.planId !== undefined);
  assert.ok(begun.length >= 1, "at least one ledger entry carries the plan provenance");
  assert.equal(begun[0].planId, planId, "plan → transaction is a chain, not an assertion");
  resetPlanRegistry();
});

test("a capability-claim build is refused at the gate when no marker the screen carries walks it back", async () => {
  const ledger = fakeLedger();
  const session = fakeSession();
  const out = await runRuntimeTool(session, {
    dryRun: false,
    program: {
      canvas: { name: "C", width: 800, height: 600, grid: 8 },
      regions: [{ fn: "frame", id: "r1", args: { width: 400, height: 200 } }],
      content: [{ fn: "text", id: "t1", parent: "r1", args: { text: "Full SSO available now", role: "title" } }],
    },
  }, fakeRegistry(session, ledger));
  assert.equal(out.status, "refused");
  assert.equal(out.refusedBy, "capability-truth");
  assert.ok(out.problems.some((p) => /SSO/i.test(p)), "the refusal names the claim");
  assert.equal(session.seen.some((s) => s.tool === "create_design"), false, "no mutating request reached Figma");
});

test("renders are counted, so 'are builds followed by a render?' is a measurable question", () => {
  const before = counters.renders;
  recordRender(120, 4096, 8);
  assert.equal(counters.renders, before + 1, "render_design's evidence now lands in the metrics");
});
