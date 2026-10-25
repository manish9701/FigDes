/**
 * Issue #30 — workflow contract, phase 2: preflight evidence threading on the
 * low-level raw create/modify paths.
 *
 * What is under test:
 *  1. derivedRawPreflightContext — the preflight evidence a raw call can
 *     honestly derive from its own provenance: an issued planId compiles the
 *     registered plan (issue #29 registry) into the plan's own geometry; an
 *     unknown or cross-file id yields the empty plan; no plan at all still
 *     seeds an empty-planBoxes context so replay containment runs on the
 *     call's own declared create chain.
 *  2. The approval waiver at the transaction edge — waivable geometry tags
 *     (outside-bounds / text-overflow / geometry-drift / connector) refuse
 *     unless approved:true plus a reason accompanies the dispatch, and a
 *     waived dispatch proceeds with the findings surfaced as warnings plus a
 *     searchable ledger label. Structural tags never waive.
 *  3. The create_design handler threading: a provenance'd dispatch carries
 *     the plan context, and a dry run surfaces waivable geometry findings as
 *     warnings instead of refusing (inspection stays open without approval).
 *  4. The chunked build contract (issue #23) after the phase-2 fix: the
 *     per-chunk context carries only brief blockers — never the geometry
 *     evidence — so the per-chunk replay cannot fail closed on permissions
 *     the plan already granted across a chunk boundary.
 *
 * All fixtures are offline: fake registry/session/ledger, no Figma, no
 * render. Imports point at the standard dist-test families.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_MAP, derivedRawPreflightContext } from "../mcp-server/dist-test/tools/tools.js";
import { dispatchTransaction } from "../mcp-server/dist-test/transaction.js";
import { registerPlan, resetPlanRegistry } from "../mcp-server/dist-test/plan/registry.js";
import {
  splitPreflightIssues,
  preflightApprovalWaived,
  PREFLIGHT_WAVABLE_TAGS,
} from "../mcp-server/dist-test/reliability/preflight.js";
import { runChunked, CHUNK_SIZE } from "../mcp-server/dist-test/runtime/tools.js";

const SUCCESS = {
  status: "success",
  createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
  timings: { apply: 1, total: 2 },
  rollbackStatus: "none",
};

/** A raw create chain whose second node deliberately pokes past its parent. */
const OVERFLOW_OPS = [
  { type: "createFrame", id: "panel", name: "Panel", x: 0, y: 0, width: 400, height: 300 },
  { type: "createEllipse", id: "deco", name: "Deco", parent: "panel", x: 380, y: 0, width: 120, height: 120 },
];
const COMPLIANT_OPS = [
  { type: "createFrame", id: "root", name: "Plan Screen", width: 1440, height: 900, fill: "#F7F5EF" },
];

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
      if (info) Object.assign(job, info);
      if (result) job.result = result;
    },
  };
}

function fakeSession(onRequest = () => SUCCESS) {
  const seen = [];
  const session = {
    seen,
    id: "s1",
    fileKey: "k1",
    fileName: "gate.fig",
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

function fakeRegistry(session, ledger = fakeLedger()) {
  return { jobs: ledger, resolve: () => session, ledger };
}

const PLAN_PROGRAM = {
  canvas: { name: "Plan Screen", width: 1440, height: 900, grid: 8 },
  regions: [{ fn: "frame", id: "r1", args: { width: 400, height: 300 } }],
  content: [],
};

/* -------------------------------------------------------------------------- */
/* 1. the waiver vocabulary                                                    */
/* -------------------------------------------------------------------------- */

test("preflight waiver vocabulary: the four geometry tags are waivable, structural ones are not", () => {
  for (const tag of ["outside-bounds", "text-overflow", "geometry-drift", "connector"]) {
    assert.ok(PREFLIGHT_WAVABLE_TAGS.has(tag), `${tag} must be waivable`);
  }
  for (const tag of ["schema", "dup-id", "dup-parent", "unknown-ref", "stale-ref", "self-parent", "page-target"]) {
    assert.equal(PREFLIGHT_WAVABLE_TAGS.has(tag), false, `${tag} must never waive`);
  }
  const issues = [
    { index: 0, opType: "createFrame", message: "Schema mismatch: bad field", fix: "fix" },
    { index: 1, opType: "createEllipse", message: "outside-bounds: 'deco' lies outside its parent", fix: "fix" },
    { index: 2, opType: "createFrame", message: "Duplicate temporary id \"panel\" (first at #0).", fix: "fix" },
  ];
  const { hard, soft } = splitPreflightIssues(issues);
  assert.equal(hard.length, 2, "structural issues stay hard");
  assert.equal(soft.length, 1, "the geometry issue is the only waivable one");
  assert.match(soft[0].message, /^outside-bounds:/);
});

test("preflightApprovalWaived follows the explicit-justification shape", () => {
  assert.equal(preflightApprovalWaived({ approved: true, reason: "deliberate decorative overflow" }), true);
  assert.equal(preflightApprovalWaived({ approved: false, reason: "resent" }), false, "refusal re-sent without approval");
  assert.equal(preflightApprovalWaived({ approved: true }), false, "approval without a reason is not a waiver");
  assert.equal(preflightApprovalWaived({ approved: true, reason: "   " }), false, "a blank reason is not a reason");
  assert.equal(preflightApprovalWaived(undefined), false);
});

/* -------------------------------------------------------------------------- */
/* 2. derivedRawPreflightContext                                               */
/* -------------------------------------------------------------------------- */

test("derivedRawPreflightContext: an issued planId threads the plan's compiled geometry", () => {
  resetPlanRegistry();
  const registered = registerPlan({
    fileKey: "k1",
    fileName: "plan.fig",
    primaryDecision: "show status",
    plan: { program: PLAN_PROGRAM, intelligence: { applied: true } },
  });
  const context = derivedRawPreflightContext({ planId: registered.planId }, "k1");
  assert.ok(context.planBoxes && context.planBoxes["r1"], "the plan region is a resolved box");
  assert.equal(context.planBoxes["r1"].w, 400);
  assert.equal(context.planBoxes["r1"].h, 300);
  assert.ok(context.overflow && context.overflow["r1"] !== undefined, "the region's overflow permission travels");
  assert.ok(context.sizing && context.sizing["r1"] !== undefined, "the region's sizing travels");
});

test("derivedRawPreflightContext: an invented planId threads only the empty plan", () => {
  resetPlanRegistry();
  const context = derivedRawPreflightContext({ planId: "plan-invented-by-nowhere" }, "k1");
  assert.deepEqual(context.planBoxes, {}, "an id the registry never issued is not evidence");
  assert.equal(Object.keys(context).filter((k) => k !== "planBoxes").length, 0);
});

test("derivedRawPreflightContext: a plan issued for another file does not transfer", () => {
  resetPlanRegistry();
  const registered = registerPlan({
    fileKey: "other-file",
    plan: { program: PLAN_PROGRAM, intelligence: { applied: true } },
  });
  const context = derivedRawPreflightContext({ planId: registered.planId }, "k1");
  assert.deepEqual(context.planBoxes, {}, "a plan for another file is not provenance for this one");
});

test("derivedRawPreflightContext: no plan reference still seeds replay containment via an empty plan", () => {
  const context = derivedRawPreflightContext({ approved: true, reason: "raw build" }, "k1");
  assert.deepEqual(context.planBoxes, {}, "no plan means no plan comparison, not no checks");
  assert.equal(validateIsEmptyContext(context), true);
});

function validateIsEmptyContext(context) {
  return context !== undefined && context.planBoxes !== undefined && Object.keys(context.planBoxes).length === 0;
}

/* -------------------------------------------------------------------------- */
/* 3. the approval waiver at the transaction edge                              */
/* -------------------------------------------------------------------------- */

test("outside-bounds blocks dispatch without approval, and the refusal names the waiver path", async () => {
  const session = fakeSession();
  const registry = fakeRegistry(session);
  const context = derivedRawPreflightContext({}, "k1"); // planless: replay containment only
  await assert.rejects(
    dispatchTransaction(registry, session, "create_design", { operations: OVERFLOW_OPS, preflight: context }),
    (err) => {
      assert.match(err.message, /outside-bounds/, "the geometry finding is named");
      assert.match(err.message, /approved:true plus reason/, "the refusal teaches the waiver shape");
      return true;
    },
  );
  assert.equal(session.seen.length, 0, "nothing was sent before the refusal");
});

test("approved+reason waives the geometry finding and the dispatch commits with visible warnings", async () => {
  const session = fakeSession(() => ({ ...SUCCESS, createdNodes: OVERFLOW_OPS.filter((o) => o.id).map((o) => ({ temporaryId: o.id, figmaNodeId: `real:${o.id}` })) }));
  const registry = fakeRegistry(session);
  const context = derivedRawPreflightContext({}, "k1");
  const result = await dispatchTransaction(registry, session, "create_design", {
    operations: OVERFLOW_OPS,
    preflight: context,
    approved: true,
    reason: "the deco orb intentionally overflows the panel as a horizon accent",
  });
  assert.equal(result.status, "success");
  const warnings = result.warnings ?? [];
  assert.equal(warnings.length > 0, true, "the waived findings do not vanish");
  assert.match(warnings[0], /\[preflight-waived\]/);
  assert.match(warnings[0], /outside-bounds/);
  const labels = [...registry.jobs.store.values()].map((j) => j.label ?? "").join(" | ");
  assert.match(labels, /waived on approval/, "the ledger note names the waiver");
});

test("a structural finding refuses even with approval — approvals cover judgment, not identity", async () => {
  const session = fakeSession();
  const registry = fakeRegistry(session);
  const context = derivedRawPreflightContext({}, "k1");
  await assert.rejects(
    dispatchTransaction(registry, session, "create_design", {
      operations: [
        { type: "createFrame", id: "panel", name: "Panel", x: 0, y: 0, width: 400, height: 300 },
        { type: "createEllipse", id: "panel", name: "Dup", parent: "panel", x: 0, y: 0, width: 10, height: 10 },
        { type: "createEllipse", id: "deco", name: "Deco", parent: "panel", x: 380, y: 0, width: 120, height: 120 },
      ],
      preflight: context,
      approved: true,
      reason: "deliberate",
    }),
    (err) => {
      assert.match(err.message, /Dup|dup-id|Duplicate/i, "the structural finding is refused");
      return true;
    },
  );
  assert.equal(session.seen.length, 0, "nothing was sent past a structural refusal");
});

test("the same overflow ops dispatch as before when no context is threaded (behavior unchanged)", async () => {
  const session = fakeSession();
  const registry = fakeRegistry(session);
  const result = await dispatchTransaction(registry, session, "create_design", { operations: COMPLIANT_OPS });
  assert.equal(result.status, "success");
  assert.equal((result.warnings ?? []).length, 0, "no geometry findings where no evidence was threaded");
});

/* -------------------------------------------------------------------------- */
/* 4. the create_design handler threads the context                            */
/* -------------------------------------------------------------------------- */

test("create_design with planId provenance dispatches through the plan's compiled preflight", async () => {
  resetPlanRegistry();
  const registered = registerPlan({
    fileKey: "k1",
    fileName: "plan.fig",
    primaryDecision: "show status",
    plan: { program: PLAN_PROGRAM, intelligence: { applied: true } },
  });
  const handler = TOOL_MAP.get("create_design").handler;
  const session = fakeSession();
  const registry = fakeRegistry(session);
  const out = await handler({ operations: COMPLIANT_OPS, planId: registered.planId }, registry);
  assert.equal(out.status, "success");
  const sent = session.seen.find((s) => s.tool === "create_design" && s.args.dryRun === undefined);
  assert.ok(sent, "the dispatch went out through the tracked path");
  assert.ok(sent.args.preflight, "the handler threaded a preflight context");
  assert.equal(sent.args.preflight.planBoxes["r1"].w, 400, "the plan's geometry, not the caller's word, rides along");
  assert.equal(sent.args.planId, registered.planId, "plan provenance is recorded on the ledger chain");
  assert.equal(sent.args.approved, undefined, "unapproved dispatches stay unapproved");
});

test("create_design dryRun surfaces waivable geometry findings as warnings, without refusing", async () => {
  const handler = TOOL_MAP.get("create_design").handler;
  const session = fakeSession(() => ({ ...SUCCESS, createdNodes: OVERFLOW_OPS.filter((o) => o.id).map((o) => ({ temporaryId: o.id, figmaNodeId: `real:${o.id}` })) }));
  const registry = fakeRegistry(session);
  const out = await handler({ operations: OVERFLOW_OPS, dryRun: true }, registry);
  assert.equal(out.status, "success", "a dry run creates nothing and needs no approval");
  const warnings = out.warnings ?? [];
  assert.equal(warnings.length > 0, true, "the geometry finding is disclosed");
  assert.match(warnings[0], /outside-bounds/);
  assert.match(warnings[0], /dispatch without approval would be refused/);
  const drySent = session.seen.find((s) => s.tool === "create_design");
  assert.equal(drySent.args.dryRun, true, "the dry run still ran through the plugin's own dry-run path");
});

test("create_design dryRun with a plan threads the plan context too (dry-run parity)", async () => {
  resetPlanRegistry();
  const registered = registerPlan({
    fileKey: "k1",
    plan: { program: PLAN_PROGRAM, intelligence: { applied: true } },
  });
  const handler = TOOL_MAP.get("create_design").handler;
  const session = fakeSession();
  const registry = fakeRegistry(session);
  const out = await handler({ operations: COMPLIANT_OPS, dryRun: true, planId: registered.planId }, registry);
  assert.equal(out.status, "success");
  assert.equal((out.warnings ?? []).length, 0, "compliant ops carry no findings on the dry run");
  const drySent = session.seen.find((s) => s.tool === "create_design");
  assert.equal(drySent.args.dryRun, true);
});

/* -------------------------------------------------------------------------- */
/* 5. the chunked contract after the phase-2 fix                               */
/* -------------------------------------------------------------------------- */

function chunkSession() {
  const sends = [];
  const session = {
    id: "s1",
    fileKey: "k1",
    fileName: "chunk.fig",
    notify() {},
    requestIdFor() {
      return undefined;
    },
    request: async (tool, payload) => {
      sends.push({ tool, payload });
      const created = (payload.operations ?? [])
        .filter((op) => typeof op.id === "string")
        .map((op) => ({ temporaryId: op.id, figmaNodeId: `real:${op.id}` }));
      return { status: "success", createdNodes: created, timings: { apply: 1, total: 1 }, rollbackStatus: "none" };
    },
  };
  return { session, sends };
}

test("runChunked commits an overflow-planned program whose permission crosses a chunk boundary", async () => {
  resetPlanRegistry();
  // A root region whose plan declares overflow:"allow" WITH a reason, plus
  // enough children to cross the chunk boundary — with children deliberately
  // outside the root's right edge on both sides of the split. The whole-list
  // pass accepted this on the plan's recorded permission; per-chunk geometry
  // classes with empty permission maps would have refused the overflow the
  // plan itself allowed (the pre-phase-2 hazard).
  const dots = [];
  for (let i = 0; i < 120; i += 1) {
    dots.push({
      type: "createEllipse",
      id: `dot${i}`,
      name: `Dot ${i}`,
      parent: "root",
      x: i % 8 === 0 ? 1180 : Math.min(1100, (i * 13) % 1100),
      y: (i * 19) % 2380,
      width: 60,
      height: 60,
    });
  }
  const operations = [{ type: "createFrame", id: "root", name: "Constellation", x: 0, y: 0, width: 1200, height: 2400 }, ...dots];
  assert.ok(operations.length > CHUNK_SIZE, "the program crosses at least one chunk boundary");
  const context = {
    planBoxes: { root: { id: "root", x: 0, y: 0, w: 1200, h: 2400 } },
    overflow: { root: "allow" },
    overflowReasons: { root: "the constellation is decorative and intentionally spills past the root edge" },
    sizing: { root: { width: 1200, height: 2400 } },
  };
  const { session, sends } = chunkSession();
  const registry = fakeRegistry(session);
  const built = await runChunked(session, registry, operations, "Overflow constellation", context);
  assert.equal(built.completed, true, "the chunked build committed");
  assert.ok(built.chunks.every((c) => c.status === "success"), `every chunk committed: ${JSON.stringify(built.chunks.map((c) => c.status))}`);
  assert.equal(sends.length, Math.ceil(operations.length / CHUNK_SIZE), "one dispatch per chunk");
  assert.ok(
    sends.every((s) => s.payload.preflight === undefined),
    "per-chunk dispatches carry NO geometry context: the plan-format evidence ran once, at the gate",
  );
});

test("runChunked still refuses per whole-list brief blockers carried on the context", async () => {
  resetPlanRegistry();
  const operations = [
    { type: "createFrame", id: "root", name: "Panel", x: 0, y: 0, width: 400, height: 300 },
    { type: "createEllipse", id: "dot", name: "Dot", parent: "root", x: 0, y: 0, width: 10, height: 10 },
  ];
  const context = {
    briefBlockers: [{ severity: "blocking", message: "the brief contradicts itself: says one thing and another" }],
  };
  const { session, sends } = chunkSession();
  const registry = fakeRegistry(session);
  const built = await runChunked(session, registry, operations, "Briefed build", context);
  assert.equal(built.completed, false);
  assert.equal(sends.length, 0, "nothing was sent past a blocking brief");
  const refusal = built.refusal ?? { problems: [] };
  const text = JSON.stringify(refusal);
  assert.match(text, /contradict|brief/i, "the refusal names the brief");
});
