/**
 * Regressions for the three design-tool issues found in the live homepage retest
 * on 16 Oct 2026 (issue #11 comment, "Design-only retest after the 16 Oct push").
 *
 * All three are false positives or false passes found against a real 86-node
 * frame, so each test reproduces the measured situation rather than a schematic
 * one. The retest frame is `EXO_HOMEPAGE_EXPLORATION_V01` (287:1173).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runRules } from "../mcp-server/dist-test/review/rules.js";
import { runGuard } from "../mcp-server/dist-test/memory/guard.js";
import { isOnRadiusScale, nearestRadiusStep, RADIUS_SCALE } from "../mcp-server/dist-test/shared/protocol.js";

const node = (o) => ({ visible: true, depth: 1, parentId: "root", x: 0, y: 0, w: 100, h: 40, name: "Layer", ...o });
const report = (nodes) => ({ target: "root", scope: "root", nodeCount: nodes.length, nodes });
const find = (findings, rule) => findings.filter((f) => f.rule === rule);

/* -------------------------------------------------------------------------- */
/* 1. Radius: the repair must never move a value off the documented scale      */
/* -------------------------------------------------------------------------- */

test("retest-1: an off-scale majority never becomes the repair target", () => {
  // Measured: the prompt/action radii were set to the documented 4px token and
  // the rule still reported sibling divergence, proposing to move 4px back to a
  // 5px majority — onto the very value the scale forbids.
  const findings = runRules(
    report([
      node({ id: "row", name: "Action Row", type: "FRAME", depth: 0, x: 0, y: 0, w: 600, h: 80 }),
      node({ id: "a", parentId: "row", depth: 1, name: "Button A", type: "FRAME", x: 0, y: 0, w: 120, h: 40, radius: 4, fill: "#FFFFFF" }),
      node({ id: "b", parentId: "row", depth: 1, name: "Button B", type: "FRAME", x: 140, y: 0, w: 120, h: 40, radius: 5, fill: "#FFFFFF" }),
      node({ id: "c", parentId: "row", depth: 1, name: "Button C", type: "FRAME", x: 280, y: 0, w: 120, h: 40, radius: 5, fill: "#FFFFFF" }),
      node({ id: "d", parentId: "row", depth: 1, name: "Button D", type: "FRAME", x: 420, y: 0, w: 120, h: 40, radius: 5, fill: "#FFFFFF" }),
    ]),
    "review",
  );

  const radii = find(findings, "radius-inconsistency");
  assert.equal(radii.length, 1, "the off-scale 5px values should still be reported");
  assert.equal(radii[0].evidence.kind, "off-scale", "an off-scale value in the group makes this drift, not divergence");
  assert.equal(radii[0].evidence.majorityOnScale, false);

  // The point of the fix: the only node touched is the off-scale one, and what it
  // is moved to is a documented step. The correct 4px node is never touched.
  assert.deepEqual(radii[0].nodeIds, ["b", "c", "d"]);
  for (const op of radii[0].suggestedOperations) {
    assert.ok(isOnRadiusScale(op.radius), `repair proposes an off-scale radius of ${op.radius}`);
  }
  assert.equal(radii[0].suggestedOperations[0].radius, 4);
});

test("retest-1: an on-scale majority is still the target when nothing has drifted", () => {
  const findings = runRules(
    report([
      node({ id: "row", name: "Action Row", type: "FRAME", depth: 0, x: 0, y: 0, w: 600, h: 80 }),
      node({ id: "a", parentId: "row", depth: 1, name: "Button A", type: "FRAME", x: 0, y: 0, w: 120, h: 40, radius: 8, fill: "#FFF" }),
      node({ id: "b", parentId: "row", depth: 1, name: "Button B", type: "FRAME", x: 140, y: 0, w: 120, h: 40, radius: 8, fill: "#FFF" }),
      node({ id: "c", parentId: "row", depth: 1, name: "Button C", type: "FRAME", x: 280, y: 0, w: 120, h: 40, radius: 4, fill: "#FFF" }),
    ]),
    "review",
  );
  const radii = find(findings, "radius-inconsistency");
  assert.equal(radii.length, 1);
  assert.equal(radii[0].evidence.kind, "sibling-divergence");
  assert.equal(radii[0].suggestedOperations[0].radius, 8, "matching an on-scale majority is still the right advice");
});

test("retest-1: the scale itself is the documented one", () => {
  assert.deepEqual(RADIUS_SCALE.slice(0, 4), [0, 4, 8, 12]);
  assert.equal(isOnRadiusScale(4), true);
  assert.equal(isOnRadiusScale(5), false);
  assert.equal(nearestRadiusStep(5), 4);
  assert.equal(nearestRadiusStep(6), 8);
  assert.equal(nearestRadiusStep(3), 4);
});

/* -------------------------------------------------------------------------- */
/* 2. Repeated row furniture is not duplication                               */
/* -------------------------------------------------------------------------- */

test("retest-2: repeated device status indicators are not duplicate siblings", () => {
  // Measured: two duplicate-sibling groups on the homepage, both intentional —
  // the green status dot and the ONLINE label repeating once per device row.
  const dot = (id, y) => node({ id, parentId: "list", depth: 1, name: "Status Dot", type: "ELLIPSE", x: 12, y, w: 10, h: 10, fill: "#2D7A4D" });
  const label = (id, y) =>
    node({
      id,
      parentId: "list",
      depth: 1,
      name: "ONLINE",
      type: "TEXT",
      x: 30,
      y,
      w: 52,
      h: 12,
      text: { content: "ONLINE", color: "#1E6B3A", size: 11, style: "Regular", family: "Inter", styled: true, length: 6 },
    });

  const findings = runRules(
    report([
      node({ id: "list", name: "Machine List", type: "FRAME", depth: 0, x: 0, y: 0, w: 720, h: 400 }),
      ...[0, 1, 2, 3, 4].map((i) => dot(`dot-${i}`, 20 + i * 72)),
      ...[0, 1, 2, 3, 4].map((i) => label(`label-${i}`, 18 + i * 72)),
    ]),
    "review",
  );

  const dups = find(findings, "duplicate-siblings");
  assert.deepEqual(dups, [], "repeating a status dot and its label once per row is the design");
});

test("retest-2: genuinely duplicated content is still reported", () => {
  // The exemption must not swallow real findings: three identical cards are not
  // row furniture, even though they repeat on a regular pitch.
  const card = (id, y) =>
    node({
      id,
      parentId: "row",
      depth: 1,
      name: "Metric Card",
      type: "FRAME",
      x: 0,
      y,
      w: 240,
      h: 120,
      fill: "#FFFFFF",
      stroke: { hex: "#D9D8D0", weight: 1 },
    });
  const findings = runRules(
    report([
      node({ id: "row", name: "Metric Row", type: "FRAME", depth: 0, x: 0, y: 0, w: 800, h: 400 }),
      card("c1", 0),
      card("c2", 140),
      card("c3", 280),
    ]),
    "review",
  );
  assert.equal(find(findings, "duplicate-siblings").length, 1);
});

test("retest-2: one real card among three indicators is still a finding", () => {
  // The exemption is per-group: furniture is exempt, a content object among them
  // is not. Otherwise the fix would hide duplication inside a list.
  const dot = (id, y) => node({ id, parentId: "row", depth: 1, name: "Status Dot", type: "ELLIPSE", x: 12, y, w: 10, h: 10, fill: "#2D7A4D" });
  const card = (id, y) =>
    node({ id, parentId: "row", depth: 1, name: "Metric Card", type: "FRAME", x: 40, y, w: 240, h: 120, fill: "#FFFFFF", stroke: { hex: "#D9D8D0", weight: 1 } });

  const findings = runRules(
    report([
      node({ id: "row", name: "Metric Row", type: "FRAME", depth: 0, x: 0, y: 0, w: 800, h: 400 }),
      dot("d1", 0),
      dot("d2", 140),
      dot("d3", 280),
      card("c1", 0),
      card("c2", 140),
      card("c3", 280),
    ]),
    "review",
  );
  const dups = find(findings, "duplicate-siblings");
  assert.equal(dups.length, 1, "the cards are duplicates");
  assert.equal(dups[0].nodeIds.length, 3);
});

/* -------------------------------------------------------------------------- */
/* 3. The guard must report its scope and not PASS a single text node          */
/* -------------------------------------------------------------------------- */

const RULES = [
  { id: "no-chat", rule: "chat is not primary", therefore: "remove chat", severity: "fail", evidence: [{ kind: "forbiddenText", pattern: "chat" }] },
  { id: "no-wall", rule: "no card wall", therefore: "replace the cluster", severity: "fail", evidence: [{ kind: "maxNodes", namePattern: "Card", max: 3 }] },
];

test("retest-3: a single text layer cannot produce a screen-level PASS", () => {
  // Measured: after editing the 86-node homepage frame, design_guard(inspect)
  // resolved the current selection — one text node — and returned PASS for all
  // 13 rules, which read as the homepage being validated.
  const result = runGuard(RULES, {
    source: "live",
    resolved: true,
    scope: { id: "287:1200", name: "Section Label", type: "TEXT", nodeCount: 1, textCount: 1, screenLevel: false },
    nodeNames: ["Section Label"],
    texts: ["Machine list"],
    composition: undefined,
    components: [],
    metrics: { nodes: 1, textNodes: 1 },
  });

  assert.equal(result.verdict, "INDETERMINATE", "a leaf node is not a screen");
  assert.notEqual(result.verdict, "PASS");
  assert.equal(result.stats.rulesChecked, 0);
  assert.match(result.findings[0].message, /not a screen or frame/);
  assert.match(result.findings[0].nextStep, /not a verdict about the screen/);
});

test("retest-3: a container holding almost nothing is also too narrow", () => {
  const result = runGuard(RULES, {
    source: "live",
    resolved: true,
    scope: { id: "1:2", name: "Row", type: "FRAME", nodeCount: 2, textCount: 1, screenLevel: true },
    nodeNames: ["Row", "Label"],
    texts: ["Online"],
    components: [],
    metrics: { nodes: 2, textNodes: 1 },
  });
  assert.equal(result.verdict, "INDETERMINATE");
  assert.match(result.findings[0].message, /2 nodes/);
});

test("retest-3: a real frame still passes, and says what it checked", () => {
  // The counterpart: the scope check must not stop the guard doing its job on an
  // actual screen.
  const scope = { id: "287:1173", name: "EXO_HOMEPAGE_EXPLORATION_V01", type: "FRAME", nodeCount: 86, textCount: 64, screenLevel: true };
  const result = runGuard(RULES, {
    source: "live",
    resolved: true,
    scope,
    nodeNames: Array.from({ length: 86 }, (_, i) => `Layer ${i}`),
    texts: Array.from({ length: 64 }, (_, i) => `Text ${i}`),
    components: [{ type: "deviceNode", count: 3 }],
    composition: "spatial",
    metrics: { nodes: 86, textNodes: 64 },
  });

  assert.equal(result.verdict, "PASS");
  assert.equal(result.stats.rulesChecked, 2);
  assert.equal(scope.nodeCount, 86, "the scope travels with the verdict");
});

test("retest-3: a genuinely bad frame still FAILs", () => {
  const result = runGuard(RULES, {
    source: "live",
    resolved: true,
    scope: { id: "1:9", name: "Screen", type: "FRAME", nodeCount: 40, textCount: 20, screenLevel: true },
    nodeNames: ["Card 1", "Card 2", "Card 3", "Card 4"],
    texts: ["Open chat"],
    components: [],
    composition: "canvas",
    metrics: { nodes: 40, textNodes: 20 },
  });
  assert.equal(result.verdict, "FAIL");
  assert.ok(result.findings.some((f) => f.verdict === "FAIL"));
});

test("retest-3: a snapshot with no recorded scope is unaffected", () => {
  // Program snapshots carry no scope; the screen-level check must not fire on
  // them or every program-based guard would return INDETERMINATE.
  const result = runGuard(RULES, {
    source: "program",
    resolved: true,
    nodeNames: ["hero", "inspector"],
    texts: ["Compute"],
    components: [],
    composition: "spatial",
    metrics: { regions: 2, textNodes: 1 },
  });
  assert.equal(result.verdict, "PASS");
});