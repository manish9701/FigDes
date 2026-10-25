/**
 * Issue #30: refine_screen consumes critique_visual findings structurally.
 *
 * `fromCritique` maps visual findings into the refine loop's bookkeeping:
 * finding nodeIds that intersect a rule finding tag that disposition with
 * `[vf-*]`; findings that intersect nothing are needs-human; findings on
 * preserve[] nodes are blocked; defect texts seed visualGoals behind the
 * caller's own goals (cap 10 held). None of it may move the convergence
 * arithmetic or fabricate an escalation, and the mapping must be
 * deterministic for approval replay (ids are stable djb2 hashes).
 *
 * Fixtures copy the style of tests/review.test.mjs (metrics stubs) and the
 * issue-26 gates tests (ledger session for the fix transaction).
 */
import test from "node:test";
import assert from "node:assert/strict";

const { refineScreenTool } = await import("../mcp-server/dist-test/review/workflow.js");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

function box(over = {}) {
  return {
    parentId: null,
    type: "FRAME",
    name: "Frame",
    depth: 0,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    visible: true,
    defaultNamed: false,
    zIndex: 0,
    ...over,
  };
}

/** Two sibling cards disagreeing on corner radius: the rule loop's one defect. */
function radiusMetrics() {
  const node = (id, parentId, name, x, y, w, h, extra = {}) =>
    box({
      id,
      parentId,
      type: parentId === null ? "FRAME" : "RECTANGLE",
      name,
      depth: parentId === null ? 0 : 1,
      x,
      y,
      w,
      h,
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

/** The same cards matching (radius 12) after the fix lands. */
function fixedMetrics() {
  const m = radiusMetrics();
  m.nodes[1].radius = 12;
  return m;
}

const SUCCESS = { status: "success", createdNodes: [{ temporaryId: "x", figmaNodeId: "1:9" }], timings: { apply: 1, total: 2 }, rollbackStatus: "none" };

/** A session that reports the radius defect once, then the fixed tree. */
function convergingSession() {
  let measurements = 0;
  const session = {
    notify() {},
    requestIdFor() {
      return undefined;
    },
    request: async (tool) => (tool === "collect_metrics" ? (measurements++ === 0 ? radiusMetrics() : fixedMetrics()) : SUCCESS),
  };
  return session;
}

function ledgerRegistry(session) {
  const store = new Map();
  return {
    jobs: {
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
    },
    resolve() {
      return session;
    },
  };
}

function vfItem(over = {}) {
  return {
    id: "vf-test",
    area: "top-left",
    defect: "hero reads quiet",
    severity: "major",
    nodeIds: [],
    repair: "look again after render",
    status: "open",
    ...over,
  };
}

/** A clean screen (both radii equal) and a fresh registry for an isolated run. */
function quietSession() {
  const session = {
    notify() {},
    requestIdFor() {
      return undefined;
    },
    request: async (tool) => (tool === "collect_metrics" ? fixedMetrics() : SUCCESS),
  };
  return { session, registry: ledgerRegistry(session) };
}

/* -------------------------------------------------------------------------- */
/* 1. visualGoals seeding                                                       */
/* -------------------------------------------------------------------------- */

test("fromCritique defect texts seed visualGoals behind the caller's own goals, capped at 10", async () => {
  const { session, registry } = quietSession();
  const findings = [];
  for (let i = 0; i < 12; i++) {
    findings.push(vfItem({ id: `vf-goal-${i}`, defect: `visual goal ${i}`, nodeIds: ["1:1"] }));
  }
  const out = await refineScreenTool(
    session,
    { maxIterations: 3, visualGoals: ["caller goal one", "caller goal two"], fromCritique: { findings } },
    registry,
  );
  assert.equal(out.status, "converged", "a clean screen still converges with seeded goals");
  assert.equal(out.visualGoals.length, 10, "the 10-goal cap holds");
  assert.equal(out.visualGoals[0], "caller goal one", "user goals keep priority");
  assert.equal(out.visualGoals[1], "caller goal two");
  assert.equal(out.visualGoals[2], "visual goal 0", "defect texts follow behind them");
  assert.equal(out.visualGoals[9], "visual goal 7");
  assert.equal(out.visualFindings.goalsSeeded, 8);

  // Replay with no user goals: everything seeded, still capped.
  const out2 = await refineScreenTool(quietSession().session, { maxIterations: 3, fromCritique: { findings } }, quietSession().registry);
  assert.equal(out2.visualGoals.length, 10);
  assert.equal(out2.visualGoals[0], "visual goal 0");
  assert.equal(out2.visualFindings.goalsSeeded, 10);
});

/* -------------------------------------------------------------------------- */
/* 2. intersecting nodeIds get [vf-*]-tagged dispositions                       */
/* -------------------------------------------------------------------------- */

test("a visual finding sharing a rule finding's nodes tags that disposition with [vf-*]", async () => {
  const session = convergingSession();
  const out = await refineScreenTool(
    session,
    { nodeId: "1:1", maxIterations: 3, fromCritique: { findings: [vfItem({ id: "vf-test-a", defect: "card corners disagree", nodeIds: ["1:3"] })] } },
    ledgerRegistry(session),
  );
  assert.equal(out.status, "converged");
  const radius = out.dispositions.find((d) => d.rule === "radius-inconsistency");
  assert.ok(radius, "the radius finding is in the disposition ledger");
  assert.deepEqual(radius.tags, ["[vf-test-a]"], "the overlap is tagged with the stable vf id");
  assert.deepEqual(radius.note, "[vf-test-a] major: card corners disagree");

  const item = out.visualFindings.items[0];
  assert.equal(item.disposition, "addressed");
  assert.equal(item.linkedFindings.length, 1);
  assert.deepEqual(item.linkedFindings[0].rule, "radius-inconsistency");
  assert.equal(item.linkedFindings[0].disposition, "fixed", "the linked rule finding was repaired and verified");
  assert.equal(item.verified, false, "the visual defect itself is not verified by this loop");
});

/* -------------------------------------------------------------------------- */
/* 3. non-intersecting findings are needs-human, off the arithmetic             */
/* -------------------------------------------------------------------------- */

test("a visual finding on a node no rule finding reports is needs-human and inflates nothing", async () => {
  const session = convergingSession();
  const out = await refineScreenTool(
    session,
    { nodeId: "1:1", maxIterations: 3, fromCritique: { findings: [vfItem({ id: "vf-test-nh", defect: "screen feels inert", nodeIds: ["1:1"] })] } },
    ledgerRegistry(session),
  );
  const item = out.visualFindings.items[0];
  assert.equal(item.disposition, "needs-human");
  assert.match(item.reason, /\[vf-test-nh\]/, "the disposition cites the finding id");
  assert.equal(item.linkedFindings.length, 0);
  assert.equal(item.verified, false);

  // ...and it never entered the loop's own arithmetic or escalation:
  assert.equal(out.status, "converged");
  assert.equal(out.verdict, "PASS");
  assert.equal(out.compositionReviewRequired, undefined, "no new escalation trigger fired");
  assert.equal(out.summary.highConfidenceRemaining, 0);
  assert.equal(out.dispositionCounts["needs-human"], undefined, "needs-human stays out of the rule-finding counts");
});

/* -------------------------------------------------------------------------- */
/* 4. preserve-listed nodes are blocked                                         */
/* -------------------------------------------------------------------------- */

test("a visual finding on a preserve-listed node is blocked and the loop left it alone", async () => {
  const session = convergingSession();
  const out = await refineScreenTool(
    session,
    { nodeId: "1:1", maxIterations: 3, preserve: ["1:2"], fromCritique: { findings: [vfItem({ id: "vf-test-p", defect: "card a feels crowded", nodeIds: ["1:2"] })] } },
    ledgerRegistry(session),
  );
  const item = out.visualFindings.items[0];
  assert.equal(item.disposition, "blocked");
  assert.match(item.reason, /preserve/, "the blocked disposition names why");
  // The rule loop itself converged: the radius finding lives on 1:3.
  assert.equal(out.status, "converged");
  assert.equal(out.verdict, "PASS");
});

/* -------------------------------------------------------------------------- */
/* 5. convergence arithmetic unaffected                                         */
/* -------------------------------------------------------------------------- */

test("fromCritique does not move the convergence result the rule loop alone would give", async () => {
  const args = { nodeId: "1:1", maxIterations: 3 };
  const plainSession = convergingSession();
  const plain = await refineScreenTool(plainSession, args, ledgerRegistry(plainSession));
  const vfSession = convergingSession();
  const withVf = await refineScreenTool(
    vfSession,
    {
      ...args,
      fromCritique: {
        findings: [
          vfItem({ id: "vf-a", defect: "card corners disagree", nodeIds: ["1:3"] }),
          vfItem({ id: "vf-b", defect: "screen feels inert", nodeIds: ["1:1"] }),
        ],
      },
    },
    ledgerRegistry(vfSession),
  );
  for (const key of ["status", "verdict", "verdictReason", "verification", "summary", "dispositionCounts"]) {
    assert.deepEqual(withVf[key], plain[key], `${key} must be identical with and without fromCritique`);
  }
});

/* -------------------------------------------------------------------------- */
/* 6. the return payload exposes the visualFindings section                     */
/* -------------------------------------------------------------------------- */

test("the return payload exposes the visualFindings ledger with dispositions and counts", async () => {
  const session = convergingSession();
  const out = await refineScreenTool(
    session,
    {
      nodeId: "1:1",
      maxIterations: 3,
      fromCritique: {
        findings: [
          vfItem({ id: "vf-addr", defect: "card corners disagree", nodeIds: ["1:3"] }),
          vfItem({ id: "vf-nh", defect: "screen feels inert", nodeIds: ["1:1"] }),
        ],
      },
    },
    ledgerRegistry(session),
  );
  assert.ok(out.visualFindings, "the section exists");
  assert.equal(out.visualFindings.source, "fromCritique");
  assert.equal(out.visualFindings.structuralVerdict, out.verdict, "the section states the structural verdict");
  assert.match(out.visualFindings.structuralReason, /repaired/);
  assert.equal(out.visualFindings.visualVerdict, "unverified", "visual items are marked unverified");
  assert.deepEqual(out.visualFindings.counts, { addressed: 1, needsHuman: 1, blocked: 0 });
  assert.equal(out.visualFindings.goalsSeeded, 2);
  assert.match(out.visualFindings.note, /renderReviewed/, "the note names how to actually verify the visual truth");
  const addr = out.visualFindings.items.find((i) => i.id === "vf-addr");
  assert.equal(addr.disposition, "addressed");
  const nh = out.visualFindings.items.find((i) => i.id === "vf-nh");
  assert.equal(nh.disposition, "needs-human");
  assert.ok(out.visualFindings.items.every((i) => ["targets", "area", "defect", "severity"].every((k) => k in i)));
});

/* -------------------------------------------------------------------------- */
/* 7. replay determinism                                                        */
/* -------------------------------------------------------------------------- */

test("running the same refine twice yields identical vf dispositions and tags", async () => {
  const run = () => {
    const session = convergingSession();
    return refineScreenTool(
      session,
      {
        nodeId: "1:1",
        maxIterations: 3,
        visualGoals: ["caller goal"],
        fromCritique: {
          findings: [
            vfItem({ id: "vf-a", defect: "card corners disagree", nodeIds: ["1:3"] }),
            vfItem({ id: "vf-b", defect: "screen feels inert", nodeIds: ["1:1"] }),
            // Input-shaped: no id, no nodeIds — minted id + zone localization both deterministic.
            { area: "bottom-left", defect: "rail spacing drifts" },
          ],
        },
      },
      ledgerRegistry(session),
    );
  };
  const first = await run();
  const second = await run();
  assert.deepEqual(first.visualFindings, second.visualFindings, "identical args must produce an identical ledger");
  assert.deepEqual(first.dispositions, second.dispositions, "including the [vf-*] tags on the rule findings");
  // The minted input-shaped finding keeps a stable id and matches nothing.
  const minted = first.visualFindings.items.find((i) => i.area === "bottom-left");
  assert.ok(minted, "the input-shaped finding is in the ledger");
  assert.match(minted.id, /^vf-/);
  assert.deepEqual(minted.targets, [], "an empty zone-localized area targets nothing rather than guessing");
  assert.equal(minted.disposition, "needs-human");
  assert.equal(minted.id, second.visualFindings.items.find((i) => i.area === "bottom-left").id, "the minted id replays");
});

/* -------------------------------------------------------------------------- */
/* 8. priorFindings reconciliation                                              */
/* -------------------------------------------------------------------------- */

test("priorFindings are reconciled through trackFindings as resolved / persisting / introduced", async () => {
  const session = convergingSession();
  const out = await refineScreenTool(
    session,
    {
      nodeId: "1:1",
      maxIterations: 3,
      fromCritique: {
        findings: [vfItem({ id: "vf-still", defect: "card corners disagree", nodeIds: ["1:3"] })],
        priorFindings: [{ id: "vf-still" }, { id: "vf-gone" }],
      },
    },
    ledgerRegistry(session),
  );
  const r = out.visualFindings.reconciliation;
  assert.ok(r, "the reconciliation runs when priorFindings are supplied");
  assert.deepEqual(r.resolved, ["vf-gone"]);
  assert.deepEqual(r.persisting, ["vf-still"]);
  assert.deepEqual(r.introduced, []);
  assert.ok(typeof r.summary === "string" && r.summary.length > 0);
});
