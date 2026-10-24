/**
 * Issue #29 — the plan registry: provenance is VERIFIED, not asserted.
 *
 * What is under test is a sentence about trust: a build tool's gate must
 * resolve provenance against plans the SERVER issued, and must never accept
 * what the calling model asserts about itself. Before this, `fromPlan:true`
 * or `intelligenceApplied:true` in the args was accepted as proof that
 * design intelligence ran — a weaker client that skipped plan_screen set the
 * flag, the gate opened, and a mediocre raw build went out labelled as
 * intelligent. Now:
 *
 * 1. plan_screen registers every plan it issues and stamps the planId on the
 *    payload and into the program skeleton.
 * 2. A planId that resolves opens the gate; an invented one does not; a plan
 *    issued for another file does not.
 * 3. An inline plan must be plan-shaped (real payloads carry `program` and
 *    `intelligence` receipts); a bare `{decision}` object does not stand in
 *    for a plan.
 * 4. A planless design_runtime build of a full screen (3+ regions) is
 *    refused with a needs-approval question instead of quietly built on the
 *    auto art-direction fallback. Dry runs stay open, one-region components
 *    keep the fallback, and an approved+reason waiver still dispatches the
 *    one call — counted in the metrics.
 *
 * All fixtures are offline: fake registry/session/ledger, no Figma, no
 * render. Imports point at the standard dist-test families. The registry and
 * the contract counters are process-global (symbol-keyed globals), so state
 * set through one bundle is visible through another.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_MAP, hasPlanProvenance } from "../mcp-server/dist-test/tools/tools.js";
import { registerPlan, resolvePlan, isPlanShaped, resetPlanRegistry } from "../mcp-server/dist-test/plan/registry.js";
import { runRuntimeTool } from "../mcp-server/dist-test/runtime/tools.js";
import { resetContractCounters, snapshot } from "../mcp-server/dist-test/reliability/metrics.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

const OPS = [
  { type: "createFrame", id: "root", name: "Registry Screen", width: 1440, height: 900, fill: "#F7F5EF" },
];

const SUCCESS = {
  status: "success",
  createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
  timings: { apply: 1, total: 2 },
  rollbackStatus: "none",
};

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

function fakeSession(onRequest = () => ({})) {
  const seen = [];
  return {
    seen,
    id: "s1",
    fileKey: "k1",
    fileName: "registry.fig",
    notify() {},
    requestIdFor() {
      return undefined;
    },
    request: async (tool, args) => {
      seen.push({ tool, args });
      return onRequest(tool, args);
    },
  };
}

function fakeRegistry(session, ledger = fakeLedger()) {
  return { jobs: ledger, resolve: () => session, ledger };
}

/** A planless program that builds a full screen: three top-level regions. */
const PLANLESS_SCREEN = {
  canvas: { name: "Gate", width: 1440, height: 900 },
  regions: [
    { fn: "navigation", id: "nav", args: { width: 240, role: "navigation" } },
    { fn: "header", id: "header", args: { role: "header" } },
    { fn: "frame", id: "main", args: { width: "fill", height: "fill", role: "content" } },
  ],
  content: [{ fn: "text", id: "t1", parent: "main", args: { text: "throughput now", role: "title" } }],
};

/* -------------------------------------------------------------------------- */
/* 1. The registry itself                                                        */
/* -------------------------------------------------------------------------- */

test("plan_screen registers the plan it issues and stamps the planId on the payload and program", async () => {
  resetPlanRegistry();
  const handler = TOOL_MAP.get("plan_screen").handler;
  const session = fakeSession();
  const out = await handler({ primaryDecision: "select a model", availableInformation: ["latency"] }, fakeRegistry(session));
  assert.match(String(out.status), /^planned/);
  assert.match(out.planId, /^plan-/, "the payload carries a server-issued planId");
  assert.equal(out.program.planId, out.planId, "the program skeleton carries the planId too");
  const registered = resolvePlan(out.planId, "k1");
  assert.ok(registered, "the registry remembers the plan");
  assert.equal(registered.primaryDecision, "select a model");
  assert.equal(resolvePlan(out.planId, "other-file"), null, "the plan does not prove another file");
  assert.equal(resolvePlan("plan-invented", "k1"), null, "an invented id resolves to nothing");
  resetPlanRegistry();
});

/* -------------------------------------------------------------------------- */
/* 2. hasPlanProvenance: verification replaces self-report                       */
/* -------------------------------------------------------------------------- */

test("self-asserted fromPlan/intelligenceApplied flags are no longer provenance", () => {
  assert.equal(hasPlanProvenance({ fromPlan: true }), false);
  assert.equal(hasPlanProvenance({ intelligenceApplied: true }), false);
  assert.equal(hasPlanProvenance({ fromPlan: true, intelligenceApplied: true }), false);
});

test("an unresolvable planId fails closed; a registered one opens the gate", () => {
  resetPlanRegistry();
  assert.equal(hasPlanProvenance({ planId: "plan-not-issued" }), false, "invented reference is not provenance");
  assert.equal(hasPlanProvenance({ planRef: "plan-not-issued" }), false);
  const { planId } = registerPlan({ fileKey: "k1", primaryDecision: "x", program: {} });
  assert.equal(hasPlanProvenance({ planId }), true);
  assert.equal(hasPlanProvenance({ planId, fileKey: "other" }, { fileKey: "other" }), false, "another file's plan is not this file's provenance");
  resetPlanRegistry();
});

test("an inline plan must be plan-shaped; a bare decision object is not a plan", () => {
  assert.equal(hasPlanProvenance({ plan: { decision: "show status" } }), false, "a bare object is improvised, not a plan");
  assert.equal(
    hasPlanProvenance({ plan: { program: {}, intelligence: { applied: true, basis: "plan-screen" } } }),
    true,
  );
});

test("the program channel: resolvable planId, plan-shaped plan, or declared style", () => {
  resetPlanRegistry();
  const { planId } = registerPlan({ fileKey: "k1", primaryDecision: "x", program: {} });
  assert.equal(hasPlanProvenance({ program: { planId } }), true);
  assert.equal(hasPlanProvenance({ program: { planId: "plan-not-issued" } }), false);
  assert.equal(hasPlanProvenance({ program: { plan: { program: {}, intelligence: { applied: true } } } }), true);
  assert.equal(hasPlanProvenance({ program: { visualIntent: { style: "quiet-instrument" } } }), true);
  assert.equal(hasPlanProvenance({ program: { regions: [] } }), false, "a bare program is raw");
  resetPlanRegistry();
});

test("isPlanShaped rejects the shapes a model improvises", () => {
  assert.equal(isPlanShaped(undefined), false);
  assert.equal(isPlanShaped("a plan"), false);
  assert.equal(isPlanShaped({ decision: "x" }), false);
  assert.equal(isPlanShaped({ program: {} }), false);
  assert.equal(isPlanShaped({ intelligence: { applied: false } }), false);
  assert.equal(isPlanShaped({ program: {}, intelligence: { applied: true } }), true);
});

/* -------------------------------------------------------------------------- */
/* 3. design_runtime: a planless screen is refused, not quietly fallback-built   */
/* -------------------------------------------------------------------------- */

test("a planless 3-region program is refused with a planless-screen gate, not built", async () => {
  resetPlanRegistry();
  resetContractCounters();
  const session = fakeSession();
  const out = await runRuntimeTool(session, { program: PLANLESS_SCREEN }, undefined);
  assert.equal(out.status, "needs-approval");
  assert.match(out.question + " " + out.instead, /plan_screen/, "the refusal names the mandatory first step");
  assert.equal(out.measured.regions, 3);
  assert.ok(!session.seen.some((s) => s.tool === "create_design"), "nothing was dispatched");
  assert.equal(snapshot().contract.planlessScreenRefusals >= 1, true, "the refusal is counted");
  resetPlanRegistry();
});

test("a dry run of the same program stays open (inspection needs no approval)", async () => {
  resetPlanRegistry();
  const session = fakeSession(() => ({}));
  const out = await runRuntimeTool(session, { program: PLANLESS_SCREEN, dryRun: true });
  assert.notEqual(out.status, "needs-approval", "a dry run needs no approval");
  assert.equal(out.intelligence.applied, false, "the dry run still discloses the bypass");
});

test("a registered planId passes the gate and the build is planned", async () => {
  resetPlanRegistry();
  const { planId } = registerPlan({ fileKey: "k1", primaryDecision: "monitor cluster health", program: {} });
  const session = fakeSession(() => ({}));
  const out = await runRuntimeTool(session, { program: { ...PLANLESS_SCREEN, planId }, dryRun: true });
  assert.equal(out.intelligence.applied, true, "the planId resolves, so intelligence counts");
  assert.equal(out.intelligence.basis, "plan");
  assert.equal(out.firstPassIneligible, false);
});

test("a plan issued for another file does not open this build's gate", async () => {
  resetPlanRegistry();
  const { planId } = registerPlan({ fileKey: "k-other", primaryDecision: "x", program: {} });
  const session = fakeSession(() => ({}));
  const out = await runRuntimeTool(session, { program: { ...PLANLESS_SCREEN, planId } }, undefined);
  assert.equal(out.status, "needs-approval", "file mismatch fails closed");
  resetPlanRegistry();
});

test("an approved+reason waiver dispatches the one planless build — and is counted", async () => {
  resetPlanRegistry();
  resetContractCounters();
  const before = snapshot().contract.intelligenceBypassWaivers;
  const session = fakeSession(() => ({}));
  // No registry: the waived build proceeds past the planless gate and stops
  // at the ledger-bound dispatch refusal, proving the gate — not the ledger —
  // was what the waiver cleared.
  const out = await runRuntimeTool(session, { program: PLANLESS_SCREEN, approved: true, reason: "intentional raw exploration" }, undefined);
  assert.notEqual(out.status, "needs-approval", "the waiver cleared the planless-screen gate");
  assert.equal(out.intelligence.applied, false, "the waived build still discloses the bypass");
  assert.equal(out.firstPassIneligible, true, "the waived build never counts as a first pass");
  assert.equal(snapshot().contract.intelligenceBypassWaivers, before + 1, "the waiver is counted");
  resetPlanRegistry();
});

test("a one-region planless program keeps the fallback (it is a component, not a screen)", async () => {
  resetPlanRegistry();
  const session = fakeSession(() => SUCCESS);
  const small = {
    canvas: { name: "Card", width: 400, height: 200 },
    regions: [{ fn: "frame", id: "card", args: { width: 400, height: 200 } }],
    content: [{ fn: "text", id: "t1", parent: "card", args: { text: "Hello", role: "title" } }],
  };
  const out = await runRuntimeTool(session, { program: small }, undefined);
  assert.equal(out.status, "refused", "no registry means the ledger refuses — not the planless-screen gate");
  assert.equal(out.refusedBy, "ledger");
  assert.equal(out.intelligence.applied, false, "the fallback is disclosed");
  resetPlanRegistry();
});

/* -------------------------------------------------------------------------- */
/* 4. create_design: a registered planId is provenance, no justification needed  */
/* -------------------------------------------------------------------------- */

test("create_design dispatches with a planId plan_screen issued for this file", async () => {
  resetPlanRegistry();
  const handler = TOOL_MAP.get("create_design").handler;
  const session = fakeSession(() => SUCCESS);
  const { planId } = registerPlan({ fileKey: "k1", primaryDecision: "x", program: {} });
  const out = await handler({ operations: OPS, planId }, fakeRegistry(session));
  assert.equal(out.status, "success");
  assert.ok(session.seen.some((s) => s.tool === "create_design"), "the planned build was dispatched");
  resetPlanRegistry();
});
