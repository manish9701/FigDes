/**
 * Regressions for the product guard, made a mandatory part of every build.
 *
 * ## Why these exist
 *
 * The guard was reachable only through `design_guard`, a separate tool. The loop
 * this agent actually runs is compile → apply → review → render, and none of
 * those steps touched it. A screen with an invisible active nav label, a region
 * buried under its sibling and a connector with no endpoints all passed a guard
 * run that reported `PASS`.
 *
 * Worse, that PASS was not earned. Five of the thirteen EXO product truths were
 * manual-only, and a rule with nothing machine-checkable emitted
 * `verdict: "PASS"` and counted itself in `stats.passed`. So a real program
 * returned top-level PASS on the strength of eight structural checks while none
 * of the five encoding design judgement had been evaluated at all.
 *
 * Two things are pinned down here:
 *   1. a verdict cannot be PASS while any of its own checks are unevaluated
 *   2. the guard runs on every build, and a FAIL stops the build
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runGuard, snapshotFromIR, metricsFromLiveNodes, decideGuardTarget } from "../mcp-server/dist-test/memory/guard.js";
import { resolveGuardTarget, resolveInspectSelection } from "../mcp-server/dist-test/memory/tools.js";
import { EXO_RULES } from "../mcp-server/dist-test/memory/rules-exo.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

const guardOf = (content, extra = {}) =>
  runGuard(EXO_RULES, snapshotFromIR({
    regions: [
      { id: "nav", role: "navigation", composition: "auto" },
      { id: "main", role: "primary-visual", composition: "topology" },
    ],
    content,
    links: [],
    ...extra,
  }, { composition: "instrument" }));

const run = (content) => executeRuntime({
  canvas: { name: "X", width: 1440, height: 900, grid: 8 },
  regions: [
    { fn: "navigation", id: "nav", args: { width: 220 } },
    { fn: "frame", id: "main", args: { width: "fill", height: "fill" } },
  ],
  content,
});

/* -------------------------------------------------------------------------- */
/* The verdict may not lie                                                      */
/* -------------------------------------------------------------------------- */

test("a verdict is never PASS while the guard left checks unevaluated", () => {
  const result = guardOf([
    { kind: "component", id: "t1", type: "deviceNode", props: { label: "node-01" } },
    { kind: "text", id: "x", text: "Fleet overview" },
  ]);

  assert.ok(result.stats.manual > 0, "this ruleset leaves judgement calls open");
  assert.notEqual(result.verdict, "PASS", "unevaluated checks must not read as approval");
  assert.equal(result.verdict, "INDETERMINATE");
});

test("a manual-only rule reports INDETERMINATE, not PASS", () => {
  const result = guardOf([
    { kind: "text", id: "x", text: "Fleet" },
  ]);
  const manual = result.findings.filter((f) => f.verdict === "INDETERMINATE");
  assert.ok(manual.length > 0, "at least one EXO truth is a judgement call");
  for (const f of manual) {
    assert.notEqual(f.verdict, "PASS");
  }
});

test("a clean design still separates 'nothing wrong' from 'nothing checked'", () => {
  const result = guardOf([
    { kind: "component", id: "d", type: "deviceNode", props: { label: "mac-mini-01" } },
    { kind: "text", id: "t", text: "4 nodes discovered" },
  ]);
  assert.equal(result.stats.failures, 0, "a clean program should not fail a rule");
  assert.equal(result.verdict, "INDETERMINATE", "but it was not fully evaluated either");
});

/* -------------------------------------------------------------------------- */
/* Judgement the guard used to only ask about                                   */
/* -------------------------------------------------------------------------- */

test("machine data in a proportional face is measured, not asked about", () => {
  // `technical-typography` was manual-only and reported PASS. The rule names
  // addresses, latencies, hashes and identifiers — so those are the four shapes
  // it checks.
  const mono = guardOf([
    { kind: "component", id: "m", type: "metric", props: { label: "Latency", value: "240ms", valueStyle: "technical" } },
  ]);
  const proportional = guardOf([
    { kind: "component", id: "m", type: "metric", props: { label: "Latency", value: "240ms" } },
  ]);

  const monoRule = mono.findings.find((f) => f.rule === "exo.technical-typography");
  const badRule = proportional.findings.find((f) => f.rule === "exo.technical-typography");
  assert.equal(monoRule.verdict, "PASS");
  assert.notEqual(badRule.verdict, "PASS");
  assert.match(badRule.evidence ?? "", /machineDataInProportionalFace=1/);
});

test("the typography rule enforces what it states, not what I wished it stated", () => {
  // Byte quantities are not in the rule's wording. An earlier version matched
  // them and fired on the project's own example dashboard (`value: "1.8 TB"`) —
  // a check that enforces more than the rule it claims to enforce is the same
  // drift the rule exists to prevent.
  const result = guardOf([
    { kind: "component", id: "m", type: "metric", props: { label: "Memory", value: "1.8 TB" } },
  ]);
  const rule = result.findings.find((f) => f.rule === "exo.technical-typography");
  assert.equal(rule.verdict, "PASS", "1.8 TB is a defensible display value set in a proportional face");
});

test("two controls claiming to be primary is reported", () => {
  const one = guardOf([
    { kind: "component", id: "b", type: "button", props: { label: "Deploy", variant: "primary" } },
  ]);
  const two = guardOf([
    { kind: "component", id: "b1", type: "button", props: { label: "Deploy", variant: "primary" } },
    { kind: "component", id: "b2", type: "button", props: { label: "Cancel", emphasis: "primary" } },
  ]);
  assert.equal(one.findings.find((f) => f.rule === "exo.primary-action-dominant").verdict, "PASS");
  const bad = two.findings.find((f) => f.rule === "exo.primary-action-dominant");
  assert.notEqual(bad.verdict, "PASS", "two equal primaries is not a hierarchy");
  assert.match(bad.evidence ?? "", /dominantActions=2/);
});

test("selection carried by colour alone is reported", () => {
  const bare = guardOf([
    { kind: "component", id: "r", type: "modelRow", props: { label: "mac-mini-01", state: "active" } },
  ]);
  const signalled = guardOf([
    { kind: "component", id: "r", type: "modelRow", props: { label: "mac-mini-01", state: "active", indicator: "dot" } },
  ]);
  assert.notEqual(bare.findings.find((f) => f.rule === "exo.selected-unambiguous").verdict, "PASS");
  assert.equal(signalled.findings.find((f) => f.rule === "exo.selected-unambiguous").verdict, "PASS");
});

test("an active nav item is not flagged: its emitter already adds weight", () => {
  // Reading the program rather than the emitted result, the navItem emitter's
  // weight bump is invisible — it is a property of the component, not of
  // anything the program wrote. So it is accounted for explicitly.
  const result = guardOf([
    { kind: "component", id: "n", type: "navItem", props: { label: "Overview", state: "active" } },
  ]);
  assert.equal(result.findings.find((f) => f.rule === "exo.selected-unambiguous").verdict, "PASS");
});

/* -------------------------------------------------------------------------- */
/* The guard is part of the build, not a separate tool                          */
/* -------------------------------------------------------------------------- */

test("every build reports what the product guard concluded", () => {
  const built = run([
    { fn: "text", id: "t", parent: "main", args: { text: "Fleet overview", role: "title" } },
    { fn: "metric", id: "m", parent: "main", args: { label: "Memory", value: "1.8 TB" } },
  ]);

  assert.ok(built.productGuard, "a build that says nothing about the guard is the bug this pins down");
  assert.ok(built.productGuard.rulesChecked >= 13, "the whole EXO truth set runs on every build");
  assert.equal(typeof built.productGuard.verdict, "string");
});

test("a design contradicting a product truth does not ship", () => {
  const built = run([
    { fn: "text", id: "t", parent: "main", args: { text: "Connect device", role: "title" } },
    { fn: "metric", id: "m1", parent: "main", args: { label: "Online", value: "21 / 24" } },
    { fn: "metric", id: "m2", parent: "main", args: { label: "Errors", value: "0.4%" } },
    { fn: "metric", id: "m3", parent: "main", args: { label: "Nodes", value: "24" } },
  ]);

  assert.equal(built.productGuard.failures > 0, true);
  assert.equal(built.applicable, false, "a manual connect-device wizard is not applicable");
  const blocking = built.violations.filter((v) => v.rule === "product");
  assert.ok(blocking.length > 0, "the refusal is stated, not just implied by applicable=false");
  assert.ok(
    built.inapplicableReasons.some((r) => /connect device|SaaS|three-card/i.test(r)),
    `reasons should name the truth broken, got: ${JSON.stringify(built.inapplicableReasons)}`,
  );
});

test("a clean build is not polluted with standing 'unchecked' noise", () => {
  // Two truths are always manual, so an INDETERMINATE note on every build would
  // fire forever and train the reader to skip the warnings array. It belongs on
  // `productGuard`, not in `warnings`.
  const built = run([
    { fn: "text", id: "t", parent: "main", args: { text: "Fleet overview", role: "title" } },
    { fn: "metric", id: "m", parent: "main", args: { label: "Memory", value: "1.8 TB" } },
  ]);
  assert.deepEqual(built.warnings, []);
  assert.equal(built.applicable, true);
  assert.equal(built.productGuard.verdict, "INDETERMINATE", "the fact is still reported");
});

/* -------------------------------------------------------------------------- */
/* Live frames: the guard measures instead of shrugging                        */
/* -------------------------------------------------------------------------- */

/**
 * A live snapshot previously carried no assert metrics at all, so five rules
 * reported INDETERMINATE on every live frame — even a fixed one. The metrics
 * below are measured from the same node facts the reviewer uses.
 */
let liveSeq = 0;
const liveNode = (over = {}) => ({
  id: over.id ?? `n${++liveSeq}`,
  parentId: "root",
  type: "FRAME",
  name: "layer",
  depth: 1,
  x: 0,
  y: 0,
  w: 100,
  h: 40,
  visible: true,
  defaultNamed: false,
  zIndex: 0,
  ...over,
});
const liveText = (content, over = {}) => liveNode({
  type: "TEXT",
  name: "label",
  w: 120,
  h: 15,
  text: { content, length: content.length, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#111111", styled: false },
  ...over,
});

const liveGuard = (nodes) => {
  const root = liveNode({ id: "root", parentId: null, type: "FRAME", name: "Screen", depth: 0, x: 0, y: 0, w: 1440, h: 960 });
  const all = [root, ...nodes];
  const texts = all.filter((n) => n.type === "TEXT").map((n) => n.text.content);
  return runGuard(EXO_RULES, {
    source: "live",
    resolved: true,
    nodeNames: all.map((n) => n.name),
    texts,
    components: [],
    metrics: { nodes: all.length, textNodes: texts.length, ...metricsFromLiveNodes(all) },
    scope: { nodeCount: all.length, textCount: texts.length, screenLevel: true },
  });
};

const ruleOf = (result, id) => result.findings.find((f) => f.rule === id);

test("live: a labelled row group and one primary action pass the assert rules", () => {
  // The shape of the fixed model-library frame: the accent lives in a group
  // that names its state, and the button carries its caption inside it.
  const result = liveGuard([
    liveNode({ id: "row", type: "GROUP", name: "Model row — Qwen2.5 Coder 7B", x: 264, y: 204, w: 1128, h: 118 }),
    liveNode({ id: "surface", parentId: "row", type: "RECTANGLE", name: "Square row surface", x: 0, y: 0, w: 1128, h: 118 }),
    liveNode({ id: "accent", parentId: "row", type: "RECTANGLE", name: "Row status accent", x: 0, y: 0, w: 4, h: 118 }),
    liveText("✓ Qwen2.5 Coder 7B", { id: "title", parentId: "row", x: 12, y: 24, w: 300, h: 19 }),
    liveText("✓ Installed", { id: "status", parentId: "row", x: 856, y: 43, w: 120, h: 15 }),
    liveNode({ id: "cta", type: "RECTANGLE", name: "Primary action", x: 1220, y: 46, w: 172, h: 44 }),
    liveText("Add model", { id: "ctalabel", x: 1235, y: 61, w: 140, h: 15 }),
  ]);

  assert.equal(ruleOf(result, "exo.critical-states-labeled").verdict, "PASS", "the accent's group names its state and the button carries its caption");
  assert.equal(ruleOf(result, "exo.technical-typography").verdict, "PASS");
  assert.equal(ruleOf(result, "exo.primary-action-dominant").verdict, "PASS", "one commit control");
  assert.equal(ruleOf(result, "exo.selected-unambiguous").verdict, "PASS", "nothing claims selection");
});

test("live: an anonymous button fails instead of passing by default", () => {
  const result = liveGuard([
    liveNode({ id: "side", type: "RECTANGLE", name: "Warm neutral sidebar", x: 0, y: 0, w: 228, h: 960 }),
    liveNode({ id: "b", type: "RECTANGLE", name: "Submit button", x: 400, y: 40, w: 120, h: 40 }),
  ]);
  const rule = ruleOf(result, "exo.critical-states-labeled");
  assert.equal(rule.verdict, "FAIL", "a button nothing names is anonymous");
  assert.match(rule.evidence ?? "", /unlabeledComponents=1/);
});

test("live: dividers and flat panels are not mistaken for controls", () => {
  // "Action divider" names an action but is a rule; the panel's heading sits
  // beside it as a sibling label, so neither may count.
  const result = liveGuard([
    liveNode({ id: "div", type: "RECTANGLE", name: "Action divider", x: 100, y: 100, w: 330, h: 1 }),
    liveNode({ id: "panel", type: "RECTANGLE", name: "Quick actions panel", x: 100, y: 200, w: 330, h: 300 }),
    liveText("QUICK ACTIONS", { id: "heading", x: 120, y: 218, w: 200, h: 12 }),
  ]);
  assert.equal(ruleOf(result, "exo.critical-states-labeled").verdict, "PASS");
  assert.equal(ruleOf(result, "exo.primary-action-dominant").verdict, "PASS", "a divider is not a primary claim");
});

test("live: two primary claims warn on dominance", () => {
  const result = liveGuard([
    liveNode({ id: "side", type: "RECTANGLE", name: "Warm neutral sidebar", x: 0, y: 0, w: 228, h: 960 }),
    liveNode({ id: "b1", type: "RECTANGLE", name: "Primary action", x: 400, y: 40, w: 172, h: 44 }),
    liveText("Add model", { id: "l1", x: 415, y: 55, w: 140, h: 15 }),
    liveNode({ id: "b2", type: "RECTANGLE", name: "Commit changes", x: 400, y: 120, w: 172, h: 44 }),
    liveText("Commit", { id: "l2", x: 415, y: 135, w: 140, h: 15 }),
  ]);
  const rule = ruleOf(result, "exo.primary-action-dominant");
  assert.equal(rule.verdict, "WARNING", "two equal primaries is not a hierarchy (warn severity)");
  assert.match(rule.evidence ?? "", /dominantActions=2/);
});

test("live: machine data in a proportional face fails; mono and display values pass", () => {
  const side = () => liveNode({ id: `side${++liveSeq}`, type: "RECTANGLE", name: "Warm neutral sidebar", x: 0, y: 0, w: 228, h: 960 });
  const bad = liveGuard([side(), liveText("p99 latency 240ms", { id: "t" })]);
  const badRule = ruleOf(bad, "exo.technical-typography");
  assert.equal(badRule.verdict, "WARNING", "warn severity reports WARNING, never silent");
  assert.match(badRule.evidence ?? "", /machineDataInProportionalFace=1/);

  const mono = liveGuard([
    side(),
    liveText("p99 latency 240ms", { id: "t", text: { content: "p99 latency 240ms", length: 17, truncated: false, size: 12, family: "JetBrains Mono", style: "Regular", color: "#111111", styled: false } }),
  ]);
  assert.equal(ruleOf(mono, "exo.technical-typography").verdict, "PASS", "mono is the designer's answer");

  const display = liveGuard([side(), liveText("4.4 GB · GGUF · Q4_K_M", { id: "t" })]);
  assert.equal(ruleOf(display, "exo.technical-typography").verdict, "PASS", "byte quantities are display values, not identifiers");
});

test("live: an explicitly active container needs a non-colour signal", () => {
  const side = () => liveNode({ id: `side${++liveSeq}`, type: "RECTANGLE", name: "Warm neutral sidebar", x: 0, y: 0, w: 228, h: 960 });
  const bare = liveGuard([
    side(),
    liveNode({ id: "card", type: "FRAME", name: "Device card active", x: 400, y: 40, w: 300, h: 120 }),
  ]);
  assert.equal(ruleOf(bare, "exo.selected-unambiguous").verdict, "WARNING", "active with nothing but fill (warn severity)");

  const signalled = liveGuard([
    liveNode({ id: "card", type: "FRAME", name: "Device card active", x: 40, y: 40, w: 300, h: 120 }),
    liveText("Mac mini", { id: "t", parentId: "card", x: 12, y: 12, w: 200, h: 15, text: { content: "Mac mini", length: 8, truncated: false, size: 13, family: "Inter", style: "Semi Bold", color: "#111111", styled: false } }),
  ]);
  assert.equal(ruleOf(signalled, "exo.selected-unambiguous").verdict, "PASS", "a weight change survives greyscale");
});

/* -------------------------------------------------------------------------- */
/* Target selection: ask, never guess or throw (#18 scope resolution)          */
/* -------------------------------------------------------------------------- */

test("guard target: a blank name asks instead of throwing", () => {
  // Live, `design_guard({target: ""})` threw a bare find_node transport
  // error. A blank target is a miss with the same INDETERMINATE shape as
  // every other miss — never an exception.
  for (const blank of ["", "   "]) {
    const decided = decideGuardTarget(blank, []);
    assert.equal(decided.kind, "not-found");
    assert.match(decided.message, /No target was named/);
  }
  const byId = decideGuardTarget("415:1487", []);
  assert.equal(byId.kind, "use-id");
});

test("guard target: a capped match window says it is capped", () => {
  // Live, "Row" matched 80 nodes while the guard reported "matches 10
  // nodes" — the find_node window presented as the exact count.
  const windowed = Array.from({ length: 10 }, (_, i) => ({ id: `3:${i}`, name: `Device row ${i}` }));
  const decided = decideGuardTarget("Row", windowed, 80);
  assert.equal(decided.kind, "ambiguous");
  assert.match(decided.message, /at least 80/);
  assert.match(decided.message, /first 10/);
  assert.equal(decided.candidates.length, 10);

  const exact = decideGuardTarget("Overview", [
    { id: "1:1", name: "Overview" },
    { id: "1:2", name: "Overview copy" },
  ]);
  assert.equal(exact.kind, "ambiguous");
  assert.match(exact.message, /matches 2 nodes/);
});

test("guard target: a match without an id never becomes an empty use-id", () => {
  // `use-id: ""` would resolve to whatever is selected — precisely the
  // silently-checked random selection #18 forbids.
  const decided = decideGuardTarget("Ghost", [{ name: "Ghost" }]);
  assert.equal(decided.kind, "not-found");
  assert.match(decided.message, /no usable node id/);
});

test("guard target resolution never calls find_node for a blank target", async () => {
  // Regression for the live defect: the blank check lived in
  // `decideGuardTarget`, which runs *after* the `find_node` lookup — so a
  // blank target threw before the pure function could refuse it.
  let findCalls = 0;
  const stubSession = {
    request: async (tool) => {
      if (tool === "find_node") {
        findCalls += 1;
        throw new Error("find_node must not be called for a blank target");
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
  for (const blank of ["", "   "]) {
    const resolved = await resolveGuardTarget(stubSession, blank);
    assert.ok("ambiguity" in resolved, "a blank target asks");
    assert.match(resolved.ambiguity, /No target was named/);
  }
  assert.equal(findCalls, 0, "no lookup was attempted");
});

test("guard target resolution reports a capped window honestly", async () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `3:${i}`, name: `Device row ${i}`, type: "FRAME" }));
  const stubSession = {
    request: async (tool) => {
      if (tool === "find_node") return { matches: ten, total: 80 };
      throw new Error(`collect_metrics must not run for an ambiguity, got ${tool}`);
    },
  };
  const resolved = await resolveGuardTarget(stubSession, "Row");
  assert.ok("ambiguity" in resolved);
  assert.match(resolved.ambiguity, /at least 80/);
  assert.equal(resolved.candidates.length, 10);
});

/* -------------------------------------------------------------------------- */
/* Inspect-selection: a leaf selection checks its screen, transparently (#18)  */
/* -------------------------------------------------------------------------- */

/**
 * Live, `design_guard({inspect: true})` with a "Row title" text selected
 * checked that one text layer and evaluated zero product rules. The
 * selection is the user's way of pointing at the screen — so a leaf
 * selection now resolves to its enclosing frame, and the response says
 * what was actually checked.
 */
const selectionStub = (selection, frames) => ({
  fileKey: null,
  fileName: "Guard Selection Test",
  request: async (tool, payload) => {
    if (tool === "inspect_selection") return { selection };
    if (tool === "collect_metrics") {
      const target = payload?.target;
      if (frames[target]) return frames[target];
      throw new Error(`unexpected metrics target ${target}`);
    }
    throw new Error(`unexpected tool ${tool}`);
  },
});

const frameMetrics = (id, name, texts = []) => ({
  target: id,
  scope: name,
  nodeCount: texts.length + 1,
  truncated: false,
  nodes: [
    { id, parentId: "0:1", type: "FRAME", name, depth: 0, x: 0, y: 0, w: 1440, h: 960, visible: true, defaultNamed: false, zIndex: 0 },
    ...texts.map((t, i) => ({
      id: t.id,
      parentId: id,
      type: "TEXT",
      name: t.name,
      depth: 1,
      x: 10,
      y: 10 + i * 20,
      w: 200,
      h: 15,
      visible: true,
      defaultNamed: false,
      zIndex: i,
      text: { content: t.content, length: t.content.length, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#111111", styled: false },
    })),
  ],
});

test("guard inspect: a single leaf selection checks its enclosing frame", async () => {
  const leaf = { id: "t1", type: "TEXT", name: "Row title" };
  const stub = selectionStub([leaf], {
    t1: { target: "t1", scope: "t1", nodeCount: 1, truncated: false, nodes: [{ id: "t1", parentId: "f1", type: "TEXT", name: "Row title", depth: 1, x: 12, y: 24, w: 100, h: 15, visible: true, defaultNamed: false, zIndex: 0 }] },
    f1: frameMetrics("f1", "Model library", [{ id: "t1", name: "Row title", content: "Hello" }]),
  });
  const resolved = await resolveInspectSelection(stub);
  assert.ok("snapshot" in resolved, "a leaf in a frame resolves");
  assert.equal(resolved.snapshot.scope.id, "f1");
  assert.match(resolved.escalation.checked, /f1/);
  assert.match(resolved.escalation.requested, /Row title/);
});

test("guard inspect: an instance child resolves through its instance to the frame", async () => {
  const leaf = { id: "I9:9;3:3", type: "TEXT", name: "Row title" };
  const stub = selectionStub([leaf], {
    "9:9": { target: "9:9", scope: "9:9", nodeCount: 1, truncated: false, nodes: [{ id: "9:9", parentId: "f1", type: "INSTANCE", name: "Model row", depth: 1, x: 0, y: 0, w: 100, h: 40, visible: true, defaultNamed: false, zIndex: 0 }] },
    f1: frameMetrics("f1", "Model library", [{ id: "t1", name: "Row title", content: "Hello" }]),
  });
  const resolved = await resolveInspectSelection(stub);
  assert.ok("snapshot" in resolved);
  assert.equal(resolved.snapshot.scope.id, "f1");
});

test("guard inspect: a selection spanning two frames asks", async () => {
  const stub = selectionStub(
    [
      { id: "t1", type: "TEXT", name: "A" },
      { id: "t2", type: "TEXT", name: "B" },
    ],
    {
      t1: { target: "t1", scope: "t1", nodeCount: 1, truncated: false, nodes: [{ id: "t1", parentId: "f1", type: "TEXT", name: "A", depth: 1, x: 0, y: 0, w: 10, h: 10, visible: true, defaultNamed: false, zIndex: 0 }] },
      f1: frameMetrics("f1", "One", []),
      t2: { target: "t2", scope: "t2", nodeCount: 1, truncated: false, nodes: [{ id: "t2", parentId: "f2", type: "TEXT", name: "B", depth: 1, x: 0, y: 0, w: 10, h: 10, visible: true, defaultNamed: false, zIndex: 0 }] },
      f2: frameMetrics("f2", "Two", []),
    },
  );
  const resolved = await resolveInspectSelection(stub);
  assert.ok("ambiguity" in resolved, "two screens is a question");
  assert.match(resolved.ambiguity, /2 screens/);
  assert.equal(resolved.candidates.length, 2);
});

test("guard inspect: a lone frame selection is unchanged", async () => {
  const frame = { id: "f1", type: "FRAME", name: "Model library", children: [] };
  const stub = selectionStub([frame], {});
  const resolved = await resolveInspectSelection(stub);
  assert.ok("snapshot" in resolved);
  assert.equal(resolved.snapshot.scope.id, "f1");
  assert.ok(!("escalation" in resolved) || resolved.escalation === undefined, "no escalation to report");
});