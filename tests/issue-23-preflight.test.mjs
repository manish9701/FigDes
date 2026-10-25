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

/* -------------------------------------------------------------------------- */
/* 11. chunked builds: the whole-list preflight, and ledger-parity dispatch    */
/*                                                                            */
/* The compile keeps duplicate content ids out of an applicable result (its   */
/* identity rule is compile-blocking), so the cross-chunk duplicate a         */
/* chunked build must refuse is exercised at the seam that actually faces it  */
/* — the exported runChunked, called with the same compiled-shaped op list    */
/* and the same assembled PreflightContext the tool threads into it. That is  */
/* the tiny harness the exported tool-function path sanctions, and it is      */
/* where a >120-op compiled list with a duplicate id can exist offline.       */
/* -------------------------------------------------------------------------- */

const { runChunked, CHUNK_SIZE } = await import("../mcp-server/dist-test/runtime/tools.js");

/** One region child text, parent-local, like the compiler emits. */
const regionText = (region, j) => text(`t_${region}_${j}`, region, 10, 6 + j * 8, 300, `row ${region}.${j}`);

/**
 * A compiled-shaped op list: root, six declared regions, 180 region children —
 * 187 ops, so a chunked build splits into 60/60/60/7 (chunking above 120 ops).
 * Regions are inside the root's declared box and are the ids the plan
 * evidence is keyed by, so the only blocker a doctored copy can add is the
 * collision it carries.
 */
const compiledShapedOps = () => {
  const ops = [frame("root", undefined, undefined, undefined, 1200, 1800)];
  for (let i = 0; i < 6; i++) ops.push(frame(`r${i}`, "root", 0, i * 300, 1200, 280));
  for (let i = 0; i < 6; i++) for (let j = 0; j < 30; j++) ops.push(regionText(`r${i}`, j));
  return ops;
};

/** The plan evidence the runtime tool assembles once, above its chunk branch. */
const planEvidenceFor = (ops) => {
  const planBoxes = {};
  for (const op of ops) {
    if (op.type === "createFrame" && op.parent === "root") {
      planBoxes[op.id] = { x: op.x, y: op.y, w: op.width, h: op.height };
    }
  }
  const overflow = {};
  const sizing = {};
  for (const id of Object.keys(planBoxes)) {
    overflow[id] = "forbid";
    sizing[id] = { width: planBoxes[id].w, height: planBoxes[id].h };
  }
  return { planBoxes, overflow, sizing };
};

/** A fake registry that records every dispatcher call it is asked to make. */
function recordingRegistry() {
  const records = new Map();
  const dispatcherCalls = [];
  const jobs = {
    records,
    dispatcherCalls,
    begin(input) {
      dispatcherCalls.push({ kind: "begin", transactionId: input.transactionId, tool: input.tool, operationCount: input.operationCount });
      const rec = { transactionId: input.transactionId, state: "queued", tool: input.tool, done: 0, updatedAt: Date.now() };
      records.set(input.transactionId, rec);
      return rec;
    },
    update(id, patch) {
      dispatcherCalls.push({ kind: "update", transactionId: id });
      const rec = records.get(id);
      if (rec) Object.assign(rec, patch, { updatedAt: Date.now() });
      return rec;
    },
    complete(id, state, extra) {
      dispatcherCalls.push({ kind: "complete", transactionId: id, state });
      const rec = records.get(id);
      if (rec) Object.assign(rec, { state, ...extra }, { updatedAt: Date.now() });
      return rec;
    },
    get(id) {
      dispatcherCalls.push({ kind: "get", transactionId: id });
      return records.get(id);
    },
    priorResult(id) {
      dispatcherCalls.push({ kind: "priorResult", transactionId: id });
      return undefined;
    },
  };
  return { jobs, dispatcherCalls };
}

/** A fake plugin session: records every request and mints real-looking ids. */
function chunkedSession() {
  const requestCalls = [];
  let figmaSeq = 900;
  return {
    requestCalls,
    id: "s_chunked",
    fileKey: null,
    fileName: "Fixture file",
    notify() {},
    requestIdFor: () => "req_chunked",
    request(tool, payload) {
      if (tool === "inspect_file") return { topLevelFrames: [] };
      if (tool === "measure_text") return {};
      if (tool !== "create_design") throw new Error(`unexpected tool ${tool}`);
      const createdNodes = (payload.operations ?? [])
        .filter((op) => String(op.type).startsWith("create"))
        .map((op) => ({ temporaryId: op.id, figmaNodeId: `24:${++figmaSeq}`, type: "FRAME", name: op.name ?? "n" }));
      const response = {
        status: "success",
        transactionId: payload.transactionId,
        dryRun: false,
        createdNodes,
        applied: payload.operations.map((op) => op.type),
      };
      requestCalls.push({ tool, payload, response });
      return response;
    },
  };
}

test("a >120-op compiled list with a cross-chunk duplicate id is refused before ANY chunk is sent", async () => {
  const ops = compiledShapedOps();
  // Per-chunk validation can never see this collision: each slice carries its
  // copy exactly once. Only the whole-list pass reads them together — which is
  // why the refusal belongs above the first chunk, not inside one.
  const early = 20; // chunk 1 window (0..59)
  const late = ops.length - 5; // last chunk window (180..186)
  ops.splice(early, 0, text("dupe", "r0", 10, 10, 300, "dupe early"));
  ops.splice(late, 0, text("dupe", "r5", 10, 10, 300, "dupe late"));
  assert.ok(early < CHUNK_SIZE && late >= 3 * CHUNK_SIZE, "fixture: the two copies must live in different chunk windows");

  const session = chunkedSession();
  const registry = recordingRegistry();
  const built = await runChunked(session, registry, ops, "issue 23 chunked dup", planEvidenceFor(ops));

  assert.equal(built.chunks.length, 0, "the refusal is whole-list: nothing was chunked");
  assert.equal(built.completed, false);
  assert.notEqual(built.refusal, undefined, "a blocking verdict surfaces as a structured refusal");
  assert.equal(built.refusal.status, "refused");
  const problems = built.refusal.problems.join("\n");
  assert.match(problems, /Duplicate temporary id "dupe"/);
  assert.ok(problems.includes(`first at #${early}`), `the refusal names the duplicate id and its first declaration: ${problems}`);

  assert.equal(
    session.requestCalls.filter((c) => c.tool === "create_design").length,
    0,
    "zero sends: every blocking verdict holds before any plugin contact",
  );
  assert.equal(registry.dispatcherCalls.length, 0, "the dispatcher was never contacted, so the ledger holds no transaction");
});

test("a valid >120-op chunked build dispatches per-chunk transactionIds and validates the whole list exactly once", async () => {
  const ops = compiledShapedOps(); // 187 clean ops
  const session = chunkedSession();
  const registry = recordingRegistry();
  const built = await runChunked(session, registry, ops, "issue 23 chunks", planEvidenceFor(ops));

  const totalChunks = Math.ceil(ops.length / CHUNK_SIZE); // 4
  const expectedSizes = Array.from({ length: totalChunks }, (_, c) => Math.min(CHUNK_SIZE, ops.length - c * CHUNK_SIZE));
  assert.equal(built.completed, true);
  assert.equal(built.refusal, undefined);
  assert.deepEqual(
    built.chunks.map((c) => c.operations),
    expectedSizes,
    "per-chunk op counts follow the existing slicing scheme exactly",
  );
  assert.ok(built.chunks.every((c) => c.status === "success" && c.createdNodes.length > 0), "every chunk commits progressively with its own result");

  const sends = session.requestCalls.filter((c) => c.tool === "create_design");
  const sentSizes = sends.map((s) => s.payload.operations.length);
  assert.equal(sends.length, totalChunks, "one dispatch per chunk, and nothing else");
  assert.deepEqual(sentSizes, built.chunks.map((c) => c.operations));
  assert.ok(sentSizes.every((n) => n <= CHUNK_SIZE));
  assert.equal(sentSizes.reduce((a, b) => a + b, 0), ops.length, "every compiled op is dispatched exactly once");

  // Issue #14 parity: each chunk carries its own transactionId, derived from
  // the whole-program fingerprint and the slice number, and the ledger and the
  // wire agree on it because both go through dispatchTransaction.
  const wireIds = sends.map((s) => s.payload.transactionId);
  wireIds.forEach((id, i) => assert.match(id, new RegExp(`_c${i + 1}of${totalChunks}$`)));
  assert.equal(new Set(wireIds).size, totalChunks, "per-chunk ids are stable and distinct");
  const begins = registry.dispatcherCalls.filter((c) => c.kind === "begin");
  assert.deepEqual(
    begins.map((b) => b.transactionId),
    wireIds,
    "every chunk landed in the ledger under the id the dispatcher sent",
  );
  assert.ok(
    begins.every((b) => b.operationCount <= CHUNK_SIZE),
    "no ledger record ever carried the whole list — per (a), the whole-list pass ran once at the gate, before chunk 1",
  );

  // The one program-level pass is the whole-list gate; chunks carry only the
  // evidence a chunk can re-check offline: brief blockers (which gate at the
  // dispatch edge per chunk), and NOTHING else — a geometry-bearing context on
  // a chunk-local replay would fail closed on overflow permissions it cannot
  // re-derive across the boundary (issue #30), so the chunk context is absent
  // rather than an empty shell that would activate the geometry classes.
  assert.ok(
    sends.every(
      (s) =>
        s.payload.preflight === undefined ||
        (s.payload.preflight.planBoxes === undefined &&
          s.payload.preflight.overflow === undefined &&
          s.payload.preflight.overflowReasons === undefined &&
          s.payload.preflight.textMeasurements === undefined &&
          s.payload.preflight.connectors === undefined &&
          s.payload.preflight.sizing === undefined),
    ),
    "page-absolute plan evidence is not re-sent per chunk: exactly one full-list validate, at the gate",
  );

  // Progressive commit and the cross-chunk remap are unchanged: chunk 2+ ops
  // referencing chunk 1 ids go out as the real figma ids chunk 1 minted.
  const chunk1Response = sends[0].response;
  const r2RealId = chunk1Response.createdNodes.find((n) => n.temporaryId === "r2")?.figmaNodeId;
  assert.ok(r2RealId, "chunk 1 minted the regions");
  const chunk2TextParent = sends[1].payload.operations.find((op) => op.id === "t_r2_0")?.parent;
  assert.equal(chunk2TextParent, r2RealId, `cross-chunk parent refs remap to the committed id: ${chunk2TextParent}`);
});

/* -------------------------------------------------------------------------- */
/* The runtime build path threads the evidence the blocking checks need       */
/* (text measurements and connector routes), so checkTextOverflow and         */
/* checkConnectors actually run for design_runtime — they used to no-op.     */
/* -------------------------------------------------------------------------- */

test("runtimePreflightContext carries measured text so overflow blocks on the runtime path", async () => {
  const { runtimePreflightContext } = await import("../mcp-server/dist-test/runtime/tools.js");
  const { executeRuntime } = await import("../mcp-server/dist-test/runtime/interpreter.js");
  const compiled = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "r1", args: { width: 400, height: 300 } }],
    content: [{ fn: "text", id: "body", parent: "r1", args: { text: "filler", maxWidth: 200 } }],
  });
  const measured = new Map([["body", { width: 640, height: 24 }]]);
  const context = runtimePreflightContext(compiled, measured);
  assert.ok(context.textMeasurements && context.textMeasurements.body.width === 640, "measured widths travel with the context");
  // Through that context, an overflow that used to slip past silently now surfaces.
  const ops = [
    { type: "createFrame", id: "r1", x: 0, y: 0, width: 400, height: 300, fill: "#FFFFFF" },
    { type: "createText", id: "body", parent: "r1", x: 0, y: 0, content: "too long", width: 200, fontSize: 14 },
  ];
  const refused = validateTransaction(ops, context);
  const overflowIssue = refused.issues.find((i) => i.message.startsWith("text-overflow"));
  assert.ok(overflowIssue, `expected a text-overflow issue, got: ${JSON.stringify(refused.issues)}`);
  assert.ok(overflowIssue.message.includes("640px") && overflowIssue.message.includes("200px"), overflowIssue.message);
});

test("runtimePreflightContext carries connector routes so endpoint checks run", async () => {
  const { runtimePreflightContext } = await import("../mcp-server/dist-test/runtime/tools.js");
  const { executeRuntime } = await import("../mcp-server/dist-test/runtime/interpreter.js");
  const compiled = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "stage", id: "map", args: { width: 600, height: 400, layout: "cluster" } }],
    content: [
      { fn: "deviceNode", id: "node-a", parent: "map", args: { label: "node-a", health: "healthy" } },
      { fn: "deviceNode", id: "node-b", parent: "map", args: { label: "node-b", health: "degraded" } },
      { fn: "connector", id: "link-1", parent: "map", args: { from: "node-a", to: "node-b", label: "24us" } },
    ],
  });
  const context = runtimePreflightContext(compiled, new Map());
  assert.ok(context.connectors && context.connectors.length > 0, `connector routes travel with the context, got: ${JSON.stringify(context.connectors)}`);
  assert.ok(context.connectors.some((c) => c.id === "link-1"), "the declared connector is threaded through");
});
