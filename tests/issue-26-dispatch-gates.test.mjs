/**
 * Issue #26 — mandatory plan/intelligence/score gates on all mutating dispatch paths.
 *
 * What is under test is a sentence about provenance: every path that mutates
 * the document must either run under design intelligence (a plan_screen plan
 * or an explicit visual signal) or carry an explicit human justification —
 * and every dispatch must refuse a FAIL guard verdict (or critical score weak
 * spots) unless waived. Registry-less dispatches bypassed the ledger, so they
 * are refused instead of sent blind.
 *
 * All fixtures are offline: fake registry/session/ledger, no Figma, no
 * render. Imports point at the standard dist-test families.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_MAP } from "../mcp-server/dist-test/tools/tools.js";
import { dispatchTransaction } from "../mcp-server/dist-test/transaction.js";
import { runRuntimeTool, runChunked } from "../mcp-server/dist-test/runtime/tools.js";
import { refineScreenTool } from "../mcp-server/dist-test/review/workflow.js";

const OPS = [
  { type: "createFrame", id: "root", name: "Gate Screen", width: 1440, height: 900, fill: "#F7F5EF" },
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

/* -------------------------------------------------------------------------- */
/* 1. create_design / modify_design / figdes_use_figma need provenance or a     */
/*    justification; dryRun stays open                                          */
/* -------------------------------------------------------------------------- */

test("raw create_design without plan or justification is refused with a plan_screen fix", async () => {
  const handler = TOOL_MAP.get("create_design").handler;
  const out = await handler({ operations: OPS }, { resolve: () => ({}) });
  assert.equal(out.status, "needs-approval");
  assert.match(out.question + " " + out.instead, /plan_screen/, "the refusal names plan_screen");
  assert.match(out.instead, /design_runtime/, "the refusal names design_runtime as the plan-carrying path");
});

test("raw modify_design without plan or justification is refused", async () => {
  const handler = TOOL_MAP.get("modify_design").handler;
  const out = await handler(
    { operations: [{ type: "setFill", target: "1:1", fill: "#FFFFFF" }] },
    { resolve: () => ({}) },
  );
  assert.equal(out.status, "needs-approval");
  assert.match(out.instead, /plan_screen/);
});

test("figdes_use_figma without provenance is refused; readonly inspection stays open", async () => {
  const handler = TOOL_MAP.get("figdes_use_figma").handler;
  const refused = await handler({ script: "figma.createRectangle();" }, { resolve: () => ({}) });
  assert.equal(refused.status, "needs-approval");
  assert.match(refused.instead, /plan_screen/);
});

test("figdes_use_figma accepts an approved+reason justification as first-class args", async () => {
  const handler = TOOL_MAP.get("figdes_use_figma").handler;
  const session = fakeSession(() => ({}));
  const out = await handler(
    { script: "figma.createRectangle();", approved: true, reason: "intentional native repair" },
    { resolve: () => session },
  );
  assert.notEqual(out.status, "needs-approval", "the declared approval channel reaches the gate");
  assert.ok(
    session.seen.some((s) => s.tool === "execute_figma_script"),
    "the script was dispatched rather than refused",
  );
});

test("figdes_use_figma dryRun runs mutation-protected with the gate open", async () => {
  const handler = TOOL_MAP.get("figdes_use_figma").handler;
  const session = fakeSession(() => ({ status: "success", result: { rootId: "9:9" } }));
  const out = await handler({ script: "figma.createRectangle();", dryRun: true }, { resolve: () => session });
  assert.notEqual(out.status, "needs-approval", "a dry run needs no approval");
  assert.equal(out.dryRun, true, "the dry run is disclosed on the result");
  const sent = session.seen.find((s) => s.tool === "execute_figma_script");
  assert.equal(sent.args.readonly, true, "the script ran mutation-protected");
});

test("create_design dryRun is allowed without provenance and creates nothing", async () => {
  const handler = TOOL_MAP.get("create_design").handler;
  const session = fakeSession(() => SUCCESS);
  const out = await handler({ operations: OPS, dryRun: true }, { resolve: () => session });
  assert.equal(out.status, "success");
  assert.ok(
    session.seen.some((s) => s.tool === "create_design" && s.args.dryRun === true),
    "dryRun still validates through the plugin dry-run path",
  );
});

test("an explicit approved+reason justification waives the provenance gate", async () => {
  const handler = TOOL_MAP.get("create_design").handler;
  const session = fakeSession(() => SUCCESS);
  const registry = fakeRegistry(session);
  const out = await handler(
    { operations: OPS, approved: true, reason: "intentional raw exploration" },
    registry,
  );
  assert.equal(out.status, "success");
  assert.ok(session.seen.some((s) => s.tool === "create_design"));
});

test("an inline PLAN-SHAPED plan passes the provenance gate without justification", async () => {
  const handler = TOOL_MAP.get("create_design").handler;
  const session = fakeSession(() => SUCCESS);
  const registry = fakeRegistry(session);
  const out = await handler(
    {
      operations: OPS,
      // Issue #29: provenance is verified, not asserted. A real plan payload
      // carries the program skeleton and the intelligence receipt.
      plan: { program: {}, intelligence: { applied: true, basis: "plan-screen" } },
    },
    registry,
  );
  assert.equal(out.status, "success");
  assert.ok(session.seen.some((s) => s.tool === "create_design"));
});

test("a self-asserted intelligenceApplied flag no longer waives the gate (issue #29)", async () => {
  const handler = TOOL_MAP.get("create_design").handler;
  const session = fakeSession(() => SUCCESS);
  const registry = fakeRegistry(session);
  const out = await handler({ operations: OPS, intelligenceApplied: true }, registry);
  assert.equal(out.status, "needs-approval", "a flag the model sets itself is not provenance");
  assert.equal(session.seen.length, 0, "nothing was dispatched on a self-reported flag");
});

/* -------------------------------------------------------------------------- */
/* 2. dispatchTransaction score/guard evidence: FAIL blocks, waiver passes      */
/* -------------------------------------------------------------------------- */

test("a FAIL guardVerdict blocks dispatch before anything is sent", async () => {
  const session = fakeSession(() => SUCCESS);
  const registry = fakeRegistry(session);
  await assert.rejects(
    () =>
      dispatchTransaction(registry, session, "create_design", {
        operations: OPS,
        transactionId: "txn-26-fail",
        scoreGuard: { guardVerdict: "FAIL", scoreWeakSpots: [] },
      }),
    /score-guard.*FAIL/,
  );
  assert.equal(session.seen.length, 0, "refused before any socket contact");
  assert.equal(registry.jobs.get("txn-26-fail").state, "failed");
});

test("an explicit waiver passes a FAIL guardVerdict", async () => {
  const session = fakeSession(() => SUCCESS);
  const registry = fakeRegistry(session);
  const out = await dispatchTransaction(registry, session, "create_design", {
    operations: OPS,
    transactionId: "txn-26-waived",
    scoreGuard: { guardVerdict: "FAIL", scoreWeakSpots: [], approved: true, reason: "reviewed: fail is a stale truth" },
  });
  assert.equal(out.status, "success");
  assert.ok(session.seen.some((s) => s.tool === "create_design"));
});

test("critical weak spots block; advisory dimension names do not", async () => {
  const critical = fakeSession(() => SUCCESS);
  await assert.rejects(
    () =>
      dispatchTransaction(fakeRegistry(critical), critical, "create_design", {
        operations: OPS,
        transactionId: "txn-26-critical",
        scoreGuard: {
          guardVerdict: "WARNING",
          scoreWeakSpots: [{ dimension: "Composition", score: 2, severity: "critical" }],
        },
      }),
    /critical weak spot/,
  );
  assert.equal(critical.seen.length, 0);

  const advisory = fakeSession(() => SUCCESS);
  const out = await dispatchTransaction(fakeRegistry(advisory), advisory, "create_design", {
    operations: OPS,
    transactionId: "txn-26-advisory",
    scoreGuard: { guardVerdict: "WARNING", scoreWeakSpots: ["Composition"] },
  });
  assert.equal(out.status, "success");
});

/* -------------------------------------------------------------------------- */
/* 3. runRuntimeTool marks raw builds first-pass-ineligible and refuses        */
/*    registry-less dispatch instead of sending blind                           */
/* -------------------------------------------------------------------------- */

const RAW_PROGRAM = {
  canvas: { name: "Gate", width: 1440, height: 900 },
  regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
  content: [{ fn: "text", id: "t1", parent: "main", args: { text: "Hello", role: "title" } }],
};

test("raw runtime builds still work but are marked first-pass-ineligible", async () => {
  const session = fakeSession((tool) => {
    if (tool === "inspect_file") return { topLevelFrames: [] };
    return {};
  });
  const out = await runRuntimeTool(session, { program: RAW_PROGRAM }, undefined);
  assert.equal(out.status, "refused", "no registry means no blind send");
  assert.equal(out.refusedBy, "ledger");
  assert.equal(out.intelligence.applied, false, "raw program discloses the bypass");
  assert.equal(out.firstPassIneligible, true, "raw exploration never counts as a first pass");
  assert.equal(out.stats.firstPassIneligible, true, "the flag rides in stats where metrics reads it");
  assert.ok(!session.seen.some((s) => s.tool === "create_design"), "nothing was dispatched");
});

test("a planned runtime program is first-pass-eligible", async () => {
  const session = fakeSession((tool) => {
    if (tool === "inspect_file") return { topLevelFrames: [] };
    return {};
  });
  const out = await runRuntimeTool(
    session,
    {
      program: {
        ...RAW_PROGRAM,
        // Issue #29: provenance is verified, not asserted — the inline plan
        // must be plan-shaped.
        plan: { program: {}, intelligence: { applied: true, basis: "plan-screen" } },
      },
      dryRun: true,
    },
    undefined,
  );
  assert.equal(out.intelligence.applied, true);
  assert.equal(out.firstPassIneligible, false);
});

test("runChunked without a registry refuses instead of dispatching blind", async () => {
  const session = fakeSession(() => SUCCESS);
  const built = await runChunked(session, null, OPS, "issue 26 chunked");
  assert.equal(built.completed, false);
  assert.equal(built.refusal.refusedBy, "ledger");
  assert.match(built.refusal.howToProceed, /No registry was threaded/);
  assert.equal(session.seen.length, 0, "no chunk was sent");
});

/* -------------------------------------------------------------------------- */
/* 4. refine_screen without a registry refuses instead of sending blind        */
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

test("refine_screen without a registry refuses the fix instead of sending blind", async () => {
  const seen = [];
  const session = {
    request: async (tool, args) => {
      seen.push(tool);
      assert.equal(tool, "collect_metrics");
      return radiusMetrics();
    },
  };
  const out = await refineScreenTool(session, { nodeId: "1:1", maxIterations: 1 });
  assert.equal(out.status, "fix-failed");
  assert.match(out.error, /ledger/i, "the failure names the ledger-bound dispatcher");
  assert.deepEqual(seen, ["collect_metrics"], "the fix was never dispatched");
});
