/**
 * Issue #23 — the blocking (not warn-only) pre-mutation preflight.
 *
 * The first preflight proved a transaction is well-formed; these tests pin the
 * program-level REJECTING checks added on top of it: every class the issue
 * demands blocks dispatch before the plugin is contacted, in a dry run as in
 * an apply, and a valid screen still walks through untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTransaction, preflightCheckTag } from "../mcp-server/dist-test/reliability/preflight.js";
import { dispatchTransaction } from "../mcp-server/dist-test/transaction.js";

/* -------------------------------------------------------------------------- */
/* fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const frame = (id, parent, x, y, w, h, extra = {}) => ({
  type: "createFrame",
  id,
  ...(parent !== undefined ? { parent } : {}),
  x,
  y,
  width: w,
  height: h,
  fill: "#FFFFFF",
  ...extra,
});

const rect = (id, parent, x, y, w, h, extra = {}) => ({
  type: "createRectangle",
  id,
  parent,
  x,
  y,
  width: w,
  height: h,
  fill: "#DDDDDD",
  ...extra,
});

const text = (id, parent, x, y, width, content, extra = {}) => ({
  type: "createText",
  id,
  parent,
  x,
  y,
  width,
  content,
  fill: "#242521",
  ...extra,
});

/** A tiny compiled-style stream: root, one region, one overlapped pill. */
const boundsOps = (pillX, pillW) => [
  frame("root", undefined, undefined, undefined, 1000, 900),
  frame("region", "root", 0, 0, 400, 300),
  rect("pill", "region", pillX, 0, pillW, 20),
];

/* -------------------------------------------------------------------------- */
/* 1. duplicate ids                                                            */
/* -------------------------------------------------------------------------- */

test("two create operations minting the same id stay blocking", () => {
  const result = validateTransaction([...boundsOps(0, 20), frame("pill", "region", 10, 40, 20, 20)]);
  assert.equal(result.ok, false, "an id declared twice must block");
  const dup = result.issues.find((i) => i.message.includes("Duplicate temporary id"));
  assert.ok(dup, `expected the duplicate-id issue, got: ${JSON.stringify(result.issues)}`);
  assert.equal(dup.index, 3, "the second declaration is the offending operation");
});

test("a program whose content ids repeat blocks even across op kinds", () => {
  const result = validateTransaction([
    frame("root", undefined, undefined, undefined, 600, 400),
    text("title", "root", 0, 0, 160, "Health"),
    frame("title", "root", 0, 30, 120, 40),
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.message.includes("Duplicate temporary id \"title\"")));
});

/* -------------------------------------------------------------------------- */
/* 2. dual parents                                                             */
/* -------------------------------------------------------------------------- */

test("a node assigned to two different parents inside one transaction is blocking", () => {
  const result = validateTransaction([
    frame("root", undefined, undefined, undefined, 800, 600),
    frame("rail", "root", 0, 0, 200, 600),
    frame("stage", "root", 200, 0, 600, 600),
    frame("card", "rail", 8, 8, 180, 90),
    { type: "appendChild", parent: "stage", child: "card" },
  ]);
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.message.startsWith("dup-parent"));
  assert.ok(issue, `expected a dual-parent issue, got: ${JSON.stringify(result.issues)}`);
  assert.ok(issue.message.includes("'rail'") && issue.message.includes("'stage'"), issue.message);
  assert.equal(issue.index, 4, "the second assignment is the offending operation");
});

test("two appendChild moves in one transaction are equally blocking", () => {
  const result = validateTransaction([
    frame("root", undefined, undefined, undefined, 800, 600),
    frame("a", "root", 0, 0, 100, 100),
    frame("b", "root", 100, 0, 100, 100),
    frame("c", "root", 200, 0, 100, 100),
    { type: "appendChild", parent: "b", child: "a" },
    { type: "appendChild", parent: "c", child: "a" },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.message.startsWith("dup-parent: node 'a'")));
});

test("grouping into a new container is a documented re-cluster, not an ambiguity", () => {
  const result = validateTransaction([
    frame("root", undefined, undefined, undefined, 800, 600),
    frame("a", "root", 0, 0, 100, 100),
    frame("b", "root", 100, 0, 100, 100),
    { type: "createGroup", id: "pair", children: ["a", "b"] },
  ]);
  assert.equal(result.ok, true, `grouping must not be read as dual-parent: ${JSON.stringify(result.issues)}`);
});

test("an identical parent re-assignment is idempotent, not ambiguous", () => {
  const result = validateTransaction([
    frame("root", undefined, undefined, undefined, 800, 600),
    frame("rail", "root", 0, 0, 200, 600),
    frame("card", "rail", 8, 8, 180, 90),
    { type: "appendChild", parent: "rail", child: "card" },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

/* -------------------------------------------------------------------------- */
/* 3. children outside their parent bounds                                     */
/* -------------------------------------------------------------------------- */

test("a child poking outside its parent blocks under clip / forbid / no permission", () => {
  for (const overflow of [{ region: "clip" }, { region: "forbid" }, {}]) {
    const result = validateTransaction(boundsOps(380, 40), {
      overflow,
      planBoxes: { region: { x: 0, y: 0, w: 400, h: 300 }, pill: { x: 380, y: 0, w: 40, h: 20 } },
    });
    const issue = result.issues.find((i) => i.message.startsWith("outside-bounds"));
    assert.ok(issue, `overflow=${JSON.stringify(overflow)} must block, got: ${JSON.stringify(result.issues)}`);
    assert.ok(issue.message.includes("'pill'") && issue.message.includes("(380, 0) 40x20"), issue.message);
  }
});

test("a missing overflow record fails closed, and allow-without-reason blocks too", () => {
  const noRecord = validateTransaction(boundsOps(380, 40), { overflow: {} });
  const issue = noRecord.issues.find((i) => i.message.startsWith("outside-bounds"));
  assert.ok(issue, "an unrecorded permission is not a permission");
  assert.ok(issue.message.includes("fails closed"), issue.message);

  const allowNoReason = validateTransaction(boundsOps(380, 40), { overflow: { region: "allow" } });
  const issueNoReason = allowNoReason.issues.find((i) => i.message.startsWith("outside-bounds"));
  assert.ok(issueNoReason, "'allow' with no recorded reason must still block");
  assert.ok(issueNoReason.message.includes("allow with no reason"), issueNoReason.message);

  const allowed = validateTransaction(boundsOps(380, 40), {
    overflow: { region: "allow" },
    overflowReasons: { region: "device health rings ride past the pill edge on purpose (recorded in the plan)" },
  });
  assert.equal(
    allowed.issues.filter((i) => i.message.startsWith("outside-bounds")).length,
    0,
    JSON.stringify(allowed.issues),
  );
});

test("a child fully inside its parent passes untouched", () => {
  const result = validateTransaction(boundsOps(360, 40), {
    planBoxes: { region: { x: 0, y: 0, w: 400, h: 300 }, pill: { x: 360, y: 0, w: 40, h: 20 } },
    overflow: { region: "forbid" },
  });
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

/* -------------------------------------------------------------------------- */
/* 4. text that cannot contain its measured content                            */
/* -------------------------------------------------------------------------- */

const textOps = (extra = {}) => [
  frame("root", undefined, undefined, undefined, 800, 600),
  frame("region", "root", 0, 0, 400, 300),
  text("body", "region", 10, 10, 200, "A model id with no break opportunities", extra),
];

test("measured text wider than its allocated box blocks", () => {
  const result = validateTransaction(textOps(), {
    textMeasurements: { body: { width: 240, height: 20 } },
  });
  const issue = result.issues.find((i) => i.message.startsWith("text-overflow"));
  assert.ok(issue, `expected text-overflow, got: ${JSON.stringify(result.issues)}`);
  assert.ok(issue.message.includes("240px") && issue.message.includes("200px"), issue.message);
  assert.ok(issue.message.includes("over by 40px"), issue.message);
  assert.equal(issue.index, 2, "the createText is the offending operation");
});

test("wrapping text cannot overflow its width, and auto-sized text has no violation", () => {
  const wrap = validateTransaction(textOps({ textAutoResize: "HEIGHT" }), {
    textMeasurements: { body: { width: 240, height: 20 } },
  });
  assert.equal(wrap.issues.filter((i) => i.message.startsWith("text-overflow")).length, 0, JSON.stringify(wrap.issues));

  const auto = validateTransaction(textOps({ textAutoResize: "WIDTH_AND_HEIGHT" }), {
    textMeasurements: { body: { width: 240, height: 20 } },
  });
  assert.equal(auto.issues.filter((i) => i.message.startsWith("text-overflow")).length, 0, JSON.stringify(auto.issues));
});

test("text inside its allocation passes, and text with no measurement is not judged", () => {
  const fits = validateTransaction(textOps(), { textMeasurements: { body: { width: 199, height: 20 } } });
  assert.equal(fits.ok, true, JSON.stringify(fits.issues));

  // No measurements at all: the check has no evidence, so it does not run
  // (and it must not invent a laptop-free pass either — it simply stays silent).
  const noEvidence = validateTransaction(textOps(), {});
  assert.equal(noEvidence.ok, true, JSON.stringify(noEvidence.issues));

  // Truncate is a deliberate clip, not containment: a string the box cannot
  // hold still blocks (the fix is to widen, shorten, or wrap).
  const truncate = validateTransaction(textOps({ textAutoResize: "TRUNCATE" }), {
    textMeasurements: { body: { width: 240, height: 20 } },
  });
  assert.ok(truncate.issues.some((i) => i.message.startsWith("text-overflow")), JSON.stringify(truncate.issues));
});

/* -------------------------------------------------------------------------- */
/* 5. connector endpoints and labels                                           */
/* -------------------------------------------------------------------------- */

const connectorOps = () => [
  frame("root", undefined, undefined, undefined, 1000, 600),
  frame("nodeA", "root", 0, 0, 120, 80),
  frame("nodeB", "root", 400, 0, 120, 80),
  {
    type: "createVector",
    id: "edge",
    parent: "root",
    x: 120,
    y: 40,
    width: 280,
    height: 2,
    path: "M 0 0 L 280 2",
    stroke: "#8A8C84",
  },
];

const connectorContext = (spec) => ({
  planBoxes: { nodeA: { x: 0, y: 0, w: 120, h: 80 }, nodeB: { x: 400, y: 0, w: 120, h: 80 } },
  connectors: [spec],
});

test("connector endpoints landing on their named nodes pass", () => {
  const spec = { id: "edge", from: "nodeA", to: "nodeB", endpoints: [{ x: 120, y: 40 }, { x: 400, y: 40 }] };
  const result = validateTransaction(connectorOps(), connectorContext(spec));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
});

test("an endpoint that does not touch its named node blocks, per end", () => {
  const startOff = validateTransaction(connectorOps(), connectorContext({
    id: "edge", from: "nodeA", to: "nodeB", endpoints: [{ x: 300, y: 300 }, { x: 400, y: 40 }],
  }));
  const issue = startOff.issues.find((i) => i.message.includes("does not touch 'nodeA'"));
  assert.ok(issue, `expected the start mismatch, got: ${JSON.stringify(startOff.issues)}`);
  assert.equal(issue.index, 3, "the createVector owning the connector is named");

  const endOff = validateTransaction(connectorOps(), connectorContext({
    id: "edge", from: "nodeA", to: "nodeB", endpoints: [{ x: 120, y: 40 }, { x: 380, y: 300 }],
  }));
  assert.ok(endOff.issues.some((i) => i.message.includes("does not touch 'nodeB'")), JSON.stringify(endOff.issues));
});

test("a label entirely off the connector's node hull blocks; on the hull it passes", () => {
  const off = validateTransaction(connectorOps(), connectorContext({
    id: "edge", from: "nodeA", to: "nodeB", endpoints: [{ x: 120, y: 40 }, { x: 400, y: 40 }], labelAt: { x: 900, y: 500 },
  }));
  assert.ok(off.issues.some((i) => i.message.includes("sits entirely outside the hull")), JSON.stringify(off.issues));

  const on = validateTransaction(connectorOps(), connectorContext({
    id: "edge", from: "nodeA", to: "nodeB", endpoints: [{ x: 120, y: 40 }, { x: 400, y: 40 }], labelAt: { x: 260, y: 40 },
  }));
  assert.equal(on.ok, true, JSON.stringify(on.issues));
});

test("a connector naming a node with no resolved box blocks", () => {
  const result = validateTransaction(connectorOps(), connectorContext({
    id: "edge", from: "ghost", to: "nodeB", endpoints: [{ x: 120, y: 40 }, { x: 400, y: 40 }],
  }));
  const issue = result.issues.find((i) => i.message.includes("no resolved box"));
  assert.ok(issue, `expected the missing-box issue, got: ${JSON.stringify(result.issues)}`);
  assert.ok(issue.message.includes("'ghost'"), issue.message);
});

/* -------------------------------------------------------------------------- */
/* 6. resolved geometry vs emitted geometry                                    */
/* -------------------------------------------------------------------------- */

const driftOps = (pillX, pillW) => [
  frame("root", undefined, undefined, undefined, 1000, 900),
  frame("region", "root", 0, 0, 400, 300),
  rect("pill", "region", pillX, 0, pillW, 20),
];

const driftContext = (extra = {}) => ({
  planBoxes: {
    region: { x: 0, y: 0, w: 400, h: 300 },
    pill: { x: 380, y: 0, w: 20, h: 20 },
  },
  ...extra,
});

test("emitted geometry far from the resolved plan blocks without a validated reason", () => {
  const drifted = validateTransaction(driftOps(200, 20), driftContext());
  const issue = drifted.issues.find((i) => i.message.startsWith("geometry-drift"));
  assert.ok(issue, `expected geometry-drift, got: ${JSON.stringify(drifted.issues)}`);
  assert.ok(issue.message.includes("(380, 0)") && issue.message.includes("(200, 0)"), issue.message);

  const justified = validateTransaction(driftOps(200, 20), driftContext({
    geometryReasons: { pill: "anchored under the incident's lane deliberately (trace records the validation)" },
  }));
  assert.equal(justified.issues.filter((i) => i.message.startsWith("geometry-drift")).length, 0, JSON.stringify(justified.issues));
});

test("a fixed override of a hug/fill axis is reported as the sizing contradiction it is", () => {
  // Position matches, size does not: 40px emitted vs 20px resolved.
  const result = validateTransaction(driftOps(380, 40), driftContext({
    sizing: { pill: { width: "hug", height: "fill" } },
  }));
  const issue = result.issues.find((i) => i.message.startsWith("geometry-drift"));
  assert.ok(issue, `expected the size contradiction, got: ${JSON.stringify(result.issues)}`);
  assert.ok(issue.message.includes("sizing contradiction") && issue.message.includes('as "hug"'), issue.message);
  assert.ok(issue.message.includes("20px wide") && issue.message.includes("40px"), issue.message);
});

test("deltas at or under the 1px grace pass, and a caller-side placement does not leak into the compare", () => {
  // 1px is inside the grace threshold (blocking needs > TRACE_EPS).
  const outcome = validateTransaction(driftOps(379.4, 20.4), driftContext());
  assert.equal(outcome.issues.filter((i) => i.message.startsWith("geometry-drift")).length, 0, JSON.stringify(outcome.issues));

  // placeRootInFreeCanvas shifts the ROOT to a free canvas spot and leaves
  // every local coordinate untouched (the old root sat at the origin, so the
  // conversion is a no-op in locals). The compare anchors on the root's own
  // replayed position, so the shift must cancel out exactly.
  const placed = [
    frame("root", undefined, 40, 0, 1000, 900),
    frame("region", "root", 0, 0, 400, 300),
    rect("pill", "region", 380, 0, 20, 20),
  ];
  const shifted = validateTransaction(placed, driftContext());
  assert.equal(shifted.issues.filter((i) => i.message.startsWith("geometry-drift")).length, 0, JSON.stringify(shifted.issues));
});

/* -------------------------------------------------------------------------- */
/* 7. brief blockers can never reach dispatch                                  */
/* -------------------------------------------------------------------------- */

function stubRegistry() {
  const records = new Map();
  const jobs = {
    records,
    begin(input) {
      const rec = { transactionId: input.transactionId, state: "queued", tool: input.tool, done: 0, updatedAt: Date.now() };
      records.set(input.transactionId, rec);
      return rec;
    },
    update(id, patch) {
      const rec = records.get(id);
      if (rec) Object.assign(rec, patch, { updatedAt: Date.now() });
      return rec;
    },
    complete(id, state, extra) {
      const rec = records.get(id);
      if (rec) Object.assign(rec, { state, ...extra }, { updatedAt: Date.now() });
      return rec;
    },
    get(id) {
      return records.get(id);
    },
    priorResult() {
      return undefined;
    },
  };
  return { jobs };
}

function stubSession() {
  const calls = [];
  return {
    calls,
    id: "s_issue23",
    fileKey: null,
    fileName: "Fixture file",
    requestIdFor: () => "req_issue23",
    request(tool, payload) {
      calls.push({ tool, payload });
      return Promise.resolve({
        status: "success",
        transactionId: payload.transactionId,
        dryRun: payload.dryRun === true,
        createdNodes: [{ temporaryId: "n1", figmaNodeId: "12:1", type: "FRAME", name: "n" }],
        applied: [],
      });
    },
  };
}

const oneOp = () => [frame("n1", undefined, undefined, undefined, 100, 100)];

test("dispatching a build whose brief carries blocking contradictions is refused server-side", async () => {
  const registry = stubRegistry();
  const session = stubSession();
  await assert.rejects(
    () =>
      dispatchTransaction(registry, session, "create_design", {
        description: "issue 23",
        operations: oneOp(),
        transactionId: "txn_brief23",
        preflight: {
          briefBlockers: [
            { id: "no-task", severity: "blocking", message: "The brief names no task: neither a purpose nor a primary decision.", fix: "State a purpose." },
          ],
        },
      }),
    (error) => {
      assert.match(error.message, /Refused before dispatch/);
      assert.match(error.message, /The brief names no task/);
      return true;
    },
  );
  // Nothing was sent to the plugin, and the ledger names the brief as the reason.
  assert.equal(session.calls.length, 0, "a brief-blocked build must never reach the plugin");
  const record = registry.jobs.records.get("txn_brief23");
  assert.ok(record, "the refusal leaves a reconcilable ledger record");
  assert.equal(record.state, "failed");
  assert.match(record.label, /brief carries 1 blocking contradiction/);
});

test("non-blocking brief advisories do not trigger the transaction-edge gate", async () => {
  const registry = stubRegistry();
  const session = stubSession();
  const result = await dispatchTransaction(registry, session, "create_design", {
    operations: oneOp(),
    dryRun: true,
    transactionId: "txn_brief_ok",
    preflight: {
      briefBlockers: [{ id: "screen-name", severity: "note", message: "The screen has no name yet." }],
    },
  });
  assert.equal(result.status, "success");
  assert.equal(session.calls.length, 1, "a clean brief dispatches");
});

/* -------------------------------------------------------------------------- */
/* 8. dry-run safety                                                           */
/* -------------------------------------------------------------------------- */

test("a dry run refuses a blocking program check and names it in the ledger", async () => {
  const registry = stubRegistry();
  const session = stubSession();
  await assert.rejects(
    () =>
      dispatchTransaction(registry, session, "create_design", {
        operations: boundsOps(380, 40),
        dryRun: true,
        transactionId: "txn_dry23",
        preflight: { overflow: { region: "clip" } },
      }),
    (error) => {
      assert.match(error.message, /Preflight rejected the plan/);
      assert.match(error.message, /outside-bounds/);
      return true;
    },
  );
  assert.equal(session.calls.length, 0, "no mutation anywhere, including under dryRun");
  const record = registry.jobs.records.get("txn_dry23");
  assert.match(record.label, /preflight \(outside-bounds\)/);
});

/* -------------------------------------------------------------------------- */
/* 9. the warn/block split for unresolvable ids                                */
/* -------------------------------------------------------------------------- */

test("a reference after its own removal is provably stale and blocks", () => {
  const result = validateTransaction([
    frame("n1", undefined, undefined, undefined, 100, 100),
    { type: "removeNode", target: "n1" },
    { type: "setPosition", target: "n1", x: 10 },
  ]);
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.message.startsWith("stale-ref"));
  assert.ok(issue, `expected stale-ref, got: ${JSON.stringify(result.issues)}`);
  assert.equal(issue.index, 2, "the operation after the removal is the offender");
});

test("a forward reference is merely suspicious: a warning, never a block", () => {
  const result = validateTransaction([
    { type: "setPosition", target: "late", x: 10 },
    frame("late", undefined, undefined, undefined, 100, 100),
  ]);
  assert.equal(result.ok, true, "a resolvable-in-order reference must not block");
  assert.equal(result.warnings.length, 1, JSON.stringify(result.warnings));
  assert.match(result.warnings[0].message, /created after this operation references it/);
});

test("an id no operation mints is provably unresolvable and blocks", () => {
  const result = validateTransaction([{ type: "setPosition", target: "ghost", x: 10 }]);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.message.includes("Unresolved reference \"ghost\"")));
});

/* -------------------------------------------------------------------------- */
/* 10. a valid compiled screen with full context walks through                 */
/* -------------------------------------------------------------------------- */

test("a healthy screen with plan boxes, permissions, measurements and connectors passes", () => {
  const ops = [
    frame("root", undefined, undefined, undefined, 1000, 600),
    frame("rail", "root", 0, 0, 240, 600),
    { ...text("heading", "rail", 12, 12, 200, "Fleet health", { textAutoResize: "HEIGHT" }) },
    {
      type: "createVector",
      id: "edge",
      parent: "root",
      x: 240,
      y: 40,
      width: 160,
      height: 2,
      path: "M 0 0 L 160 2",
      stroke: "#8A8C84",
    },
  ];
  const context = {
    planBoxes: {
      rail: { x: 0, y: 0, w: 240, h: 600 },
      heading: { x: 12, y: 12, w: 200, h: 40 },
      nodeB: { x: 400, y: 0, w: 120, h: 80 },
    },
    overflow: { rail: "forbid" },
    textMeasurements: { heading: { width: 200, height: 40 } },
    connectors: [
      { id: "edge", from: "rail", to: "nodeB", endpoints: [{ x: 240, y: 40 }, { x: 400, y: 40 }] },
    ],
  };
  const result = validateTransaction(ops, context);
  assert.equal(result.ok, true, JSON.stringify(result.issues));

  // ...but a connector that names a node missing from the plan boxes still
  // blocks, even on an otherwise healthy screen.
  const broken = validateTransaction(ops, {
    ...context,
    planBoxes: { rail: { x: 0, y: 0, w: 240, h: 600 }, heading: { x: 12, y: 12, w: 200, h: 40 } },
  });
  assert.equal(broken.ok, false, "the missing 'nodeB' box must block");
  assert.ok(broken.issues.some((i) => i.message.includes("no resolved box")), JSON.stringify(broken.issues));
});

/* -------------------------------------------------------------------------- */
/* the ledger tag that names the blocking check                                */
/* -------------------------------------------------------------------------- */

test("preflightCheckTag names the blocking check a message came from", () => {
  const tagged = preflightCheckTag({
    index: 4,
    opType: "appendChild",
    message: "dup-parent: node 'card' is assigned to two different parents",
    fix: "Assign the node once.",
  });
  assert.equal(tagged, "dup-parent");
  const legacy = preflightCheckTag({
    index: 0,
    opType: "createFrame",
    message: "Duplicate temporary id \"card\" (first at #1).",
    fix: "Give every create operation its own unique `id`.",
  });
  assert.equal(legacy, "createFrame");
});
