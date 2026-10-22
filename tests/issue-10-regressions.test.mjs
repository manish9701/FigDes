/**
 * Regressions for GitHub issue #10 — the hard stress test.
 *
 * Each test maps to one acceptance criterion in the issue, and each was written
 * from the observed failure rather than from the fix. The defects were all
 * "the system reported success while measuring nothing", so the tests are
 * mostly assertions that a verdict cannot be produced without evidence.
 *
 * Issue: https://github.com/manish9701/FigDes/issues/10
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { runtimeCatalogue } from "../mcp-server/dist-test/runtime/tools.js";
import { validatePrimitiveArgs } from "../mcp-server/dist-test/runtime/primitive-schema.js";
import { runGuard, snapshotFromIR } from "../mcp-server/dist-test/memory/guard.js";
import { normalizeVectorPath, normalizePath, segmentsBounds, parseVectorSegments } from "../mcp-server/dist-test/shared/path.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";
import { repairTextColour, contrastRatio, rgbToHex, parseHex } from "../mcp-server/dist-test/shared/contrast.js";

/* -------------------------------------------------------------------------- */
/* P0 #1 — an empty guard snapshot can never PASS                             */
/* -------------------------------------------------------------------------- */

const RULES = [
  {
    id: "no-chat",
    rule: "chat is not the primary interaction",
    therefore: "remove the chat composer",
    severity: "fail",
    evidence: [{ kind: "forbiddenText", pattern: "chat" }],
  },
  {
    id: "no-card-wall",
    rule: "no generic SaaS card wall",
    therefore: "replace the cluster with one composition",
    severity: "fail",
    evidence: [{ kind: "maxNodes", namePattern: "Card", max: 3 }],
  },
];

test("P0-1: a guard over an empty snapshot is INDETERMINATE, never PASS", () => {
  // The live failure: PASS for 13 rules while the snapshot said nodes: 0.
  const empty = {
    composition: undefined,
    components: [],
    nodeNames: [],
    texts: [],
    metrics: { nodes: 0, textNodes: 0 },
  };
  const result = runGuard(RULES, empty);
  assert.equal(result.verdict, "INDETERMINATE");
  assert.notEqual(result.verdict, "PASS");
  assert.equal(result.stats.rulesChecked, 0);
  assert.equal(result.stats.passed, 0);
  assert.match(result.findings[0].message, /nothing to measure/);
  assert.match(result.findings[0].nextStep, /never be read as approval/);
});

test("P0-1: an explicitly unresolved target cannot PASS", () => {
  const result = runGuard(RULES, {
    source: "live",
    resolved: false,
    unresolvedReason: "The plugin returned an empty selection.",
    nodeNames: ["Frame 1"],
    texts: ["Cluster"],
    metrics: { nodes: 1, textNodes: 1 },
  });
  assert.equal(result.verdict, "INDETERMINATE");
  assert.match(result.findings[0].evidence, /empty selection/);
});

test("P0-1: a real screen still passes, so the guard is not merely refusing", () => {
  const result = runGuard(RULES, {
    source: "live",
    resolved: true,
    nodeNames: ["Header", "Cluster Field"],
    texts: ["Compute topology"],
    components: [{ type: "deviceNode", count: 3 }],
    composition: "spatial",
    metrics: { nodes: 2, textNodes: 1 },
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.stats.rulesChecked, 2);
});

test("P0-1: a program snapshot reports its own source and resolution", () => {
  const ir = {
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [{ id: "hero", role: "content", children: ["t"] }],
    content: [{ kind: "text", id: "t", text: "hello" }],
    tokens: [],
    relations: [],
  };
  const snapshot = snapshotFromIR(ir, { composition: "editorial" });
  assert.equal(snapshot.source, "program");
  assert.equal(snapshot.resolved, true);
  assert.equal(runGuard(RULES, snapshot).verdict, "PASS");

  const emptyIr = { ...ir, regions: [] };
  const emptySnapshot = snapshotFromIR(emptyIr, { composition: "editorial" });
  assert.equal(emptySnapshot.resolved, false);
  assert.equal(runGuard(RULES, emptySnapshot).verdict, "INDETERMINATE");
});

/* -------------------------------------------------------------------------- */
/* P0 #2 — resolved geometry must fit the canvas and honour its relations     */
/* -------------------------------------------------------------------------- */

/** Every violation of a given rule. */
const violationsFor = (result, rule) => result.violations.filter((v) => v.rule === rule);

test("P0-2: a region pushed past the canvas edge is reported, not silently drawn", () => {
  // The live failure: inspector at y=1239 on a 1100px canvas, zero violations.
  const result = executeRuntime({
    canvas: { name: "T", width: 1600, height: 1100, grid: 8 },
    regions: [
      { fn: "frame", id: "topology", args: { grow: 2 } },
      { fn: "inspector", id: "side", args: { width: 320 } },
    ],
    content: [{ fn: "text", id: "t", parent: "topology", args: { text: "hi" } }],
    relations: [{ id: "side", rightOf: "topology", gap: 24, width: 320 }],
  });
  const compiled = compileIR(result.ir);

  const geometry = violationsFor(compiled, "geometry");
  assert.ok(geometry.length > 0, "expected a geometry violation");
  assert.match(geometry.map((v) => v.message).join(" "), /canvas/);
});

test("P0-2: stacked regions that overflow the canvas are reported", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1600, height: 1100, grid: 8 },
    regions: [
      { fn: "frame", id: "a", args: { height: 700 } },
      { fn: "frame", id: "b", args: { height: 700 } },
      { fn: "frame", id: "c", args: { height: 700 } },
    ],
  });
  const compiled = compileIR(result.ir);
  const geometry = violationsFor(compiled, "geometry");
  assert.ok(geometry.length >= 2, `expected the overflowing regions to be reported, got ${JSON.stringify(geometry)}`);
  assert.match(geometry.map((v) => v.message).join(" "), /bottom edge/);
});

test("P0-2: a zero-extent region names the cause rather than reporting '0x0'", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1600, height: 1100, grid: 8 },
    regions: [
      { fn: "frame", id: "a", args: { height: 700 } },
      { fn: "frame", id: "b", args: { height: 700 } },
    ],
  });
  const compiled = compileIR(result.ir);
  const zero = compiled.regions.filter((r) => r.w <= 0 || r.h <= 0);
  for (const region of zero) {
    const reported = violationsFor(compiled, "geometry").some((v) => v.message.includes(`'${region.id}'`));
    assert.ok(reported, `region ${region.id} collapsed and was not reported`);
  }
});

test("P0-2: a relation that resolved correctly raises no relation violation", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1600, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "body", args: { width: 1000, height: 900 } },
      { fn: "inspector", id: "side", args: { width: 320, height: 900 } },
    ],
    relations: [{ id: "side", rightOf: "body", gap: 24, width: 320, top: 0 }],
  });
  const compiled = compileIR(result.ir);
  assert.deepEqual(violationsFor(compiled, "relation"), [], "a satisfied relation must not be reported");
  assert.deepEqual(violationsFor(compiled, "geometry"), [], "and the geometry it produced must fit");
  const side = compiled.regions.find((r) => r.id === "side");
  const body = compiled.regions.find((r) => r.id === "body");
  assert.equal(side.x, body.x + body.w + 24);
  assert.ok(side.x + side.w <= 1600, "the side panel must end inside the canvas");
});

test("P0-2: a satisfied `below` relation is measured the same way", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "header", id: "head", args: { height: 80 } },
      { fn: "frame", id: "body", args: { height: 820 } },
    ],
    relations: [{ id: "body", below: "head", top: 0, height: 820 }],
  });
  const compiled = compileIR(result.ir);
  assert.deepEqual(violationsFor(compiled, "relation"), []);
  assert.deepEqual(violationsFor(compiled, "geometry"), []);
  assert.equal(compiled.regions.find((r) => r.id === "body").y, 0);
});

test("P0-2: the same holds when every region fits — the assertions are not noisy", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "header", id: "head", args: { height: 80 } },
      { fn: "frame", id: "body", args: { height: "fill" } },
    ],
    content: [{ fn: "text", id: "t", parent: "body", args: { text: "Compute" } }],
  });
  const compiled = compileIR(result.ir);
  assert.deepEqual(violationsFor(compiled, "geometry"), []);
  assert.deepEqual(violationsFor(compiled, "relation"), []);
});

/* -------------------------------------------------------------------------- */
/* P0 #3 — connectors resolve against every declared native node              */
/* -------------------------------------------------------------------------- */

test("P0-3: connectors resolve against nodes declared in content", () => {
  // compile_ir takes a hand-written IR, where RegionSchema.children defaults to
  // []. The nodes were declared; they were simply never parented.
  const compiled = compileIR({
    canvas: { name: "Cluster", width: 1600, height: 1100, grid: 8 },
    regions: [{ id: "map", role: "primary-visual", composition: "topology", children: [] }],
    content: [
      { kind: "component", id: "device-a", type: "deviceNode", props: { label: "A" } },
      { kind: "component", id: "model", type: "modelRow", props: { title: "M" } },
      { kind: "connector", id: "c1", from: "device-a", to: "model", label: "serves" },
    ],
    tokens: [],
    relations: [],
  });

  const connectorViolations = violationsFor(compiled, "connector");
  assert.deepEqual(connectorViolations, [], "a connector between declared nodes must resolve");
  assert.ok(compiled.boxes.has("device-a"));
  assert.ok(compiled.boxes.has("model"));
  assert.equal(compiled.operations.filter((o) => o.type === "createVector").length, 1, "the edge must actually be drawn");
});

test("P0-3: the adoption is reported, never silent", () => {
  const compiled = compileIR({
    canvas: { name: "Cluster", width: 1600, height: 1100, grid: 8 },
    regions: [{ id: "map", role: "content", children: [] }],
    content: [{ kind: "component", id: "device-a", type: "deviceNode", props: {} }],
    tokens: [],
    relations: [],
  });
  const adoption = violationsFor(compiled, "content-parent");
  assert.equal(adoption.length, 1);
  assert.match(adoption[0].message, /device-a/);
  assert.match(adoption[0].message, /without a parent region/);
});

test("P0-3: a genuinely undeclared node says so, instead of blaming a declared one", () => {
  const compiled = compileIR({
    canvas: { name: "Cluster", width: 1600, height: 1100, grid: 8 },
    regions: [{ id: "map", role: "content", children: ["a"] }],
    content: [
      { kind: "component", id: "a", type: "deviceNode", props: {} },
      { kind: "connector", id: "c1", from: "a", to: "ghost" },
    ],
    tokens: [],
    relations: [],
  });
  const message = violationsFor(compiled, "connector").map((v) => v.message).join(" ");
  assert.match(message, /'ghost' \(not declared anywhere in this IR\)/);
});

/* -------------------------------------------------------------------------- */
/* P0 #4 — arc and bezier bounds enclose the rendered geometry                */
/* -------------------------------------------------------------------------- */

test("P0-4: an arc-based ring is bounded by its full extent, not its endpoints", () => {
  // The live failure: a two-arc ring emitted as width 54, height 1.
  const ring = "M 0 27 A 27 27 0 1 1 54 27 A 27 27 0 1 1 0 27 Z";
  const normalized = normalizeVectorPath(ring);
  assert.equal(Math.round(normalized.width), 54);
  assert.equal(Math.round(normalized.height), 54, "a 54px-diameter ring is 54px tall");
  assert.equal(normalized.x, 0);
  assert.equal(normalized.y, 0);
});

test("P0-4: a half-circle arc contributes its true bulge", () => {
  // A 40-radius semicircle from (0,0) to (80,0) arcs 40px above the chord.
  const bounds = segmentsBounds(parseVectorSegments("M 0 0 A 40 40 0 0 1 80 0"));
  assert.equal(Math.round(bounds.width), 80);
  assert.ok(Math.abs(bounds.height - 40) < 0.01, `expected 40px of bulge, got ${bounds.height}`);
});

test("P0-4: a quarter arc is not inflated to the whole ellipse", () => {
  // From (40,0) to (0,40): the true box is 40x40, not the 40x20 of the chord.
  const bounds = segmentsBounds(parseVectorSegments("M 40 0 A 40 40 0 0 1 0 40"));
  assert.equal(Math.round(bounds.width), 40);
  assert.equal(Math.round(bounds.height), 40);
});

test("P0-4: bezier bounds use curve extrema, not the control-point hull", () => {
  // Control points reach y=-100, but the curve itself only reaches y=-75.
  // The curve is monotonic in X, so this also proves the Y extrema are sampled
  // even when the X polynomial has no interior root.
  const curve = "M 0 0 C 0 -100 100 -100 100 0";
  const bounds = segmentsBounds(parseVectorSegments(curve));
  assert.equal(bounds.width, 100);
  assert.ok(
    Math.abs(bounds.minY - -75) < 0.5,
    `expected the curve's true extreme near -75, got the control hull at ${bounds.minY}`,
  );
});

test("P0-4: a cubic's box is neither under- nor over-estimated", () => {
  // Every extreme must be inside the box, and the box must not exceed the
  // control hull. Over-estimation would crop nothing but would misplace the node.
  const curve = "M 10 0 C 10 120 90 -40 90 0";
  const bounds = segmentsBounds(parseVectorSegments(curve));
  assert.ok(bounds.height > 0 && bounds.height <= 120, `height ${bounds.height} should be positive and within the hull`);
  assert.ok(bounds.height > 20, "a curve bulging 120 above its controls must report a real height");
});

test("P0-4: the flattening path agrees with the preserving path", () => {
  const ring = "M 0 27 A 27 27 0 1 1 54 27 A 27 27 0 1 1 0 27 Z";
  const flattened = normalizePath(ring);
  assert.equal(Math.round(flattened.width), 54);
  assert.equal(Math.round(flattened.height), 54);
});

/* -------------------------------------------------------------------------- */
/* P1 #5 — runtime primitive schemas are discoverable                         */
/* -------------------------------------------------------------------------- */

test("P1-5: the catalogue publishes an argument schema for every primitive", () => {
  const catalogue = runtimeCatalogue();
  assert.ok(catalogue.length > 40);

  for (const primitive of catalogue) {
    assert.ok(Array.isArray(primitive.args), `${primitive.name} published no args array`);
    for (const arg of primitive.args) {
      assert.equal(typeof arg.name, "string");
      assert.equal(typeof arg.type, "string", `${primitive.name}.${arg.name} has no type`);
      assert.ok(arg.description.length > 0, `${primitive.name}.${arg.name} has no description`);
    }
  }
});

test("P1-5: the three primitives that were undiscoverable now document their keys", () => {
  const byName = new Map(runtimeCatalogue().map((p) => [p.name, p]));

  // logoGrid takes `divisions`, which was read by the compiler and rejected as
  // an unknown argument, so it could never be passed successfully.
  const logoGrid = byName.get("logoGrid");
  assert.ok(logoGrid.args.some((a) => a.name === "divisions"), "logoGrid must document `divisions`");
  assert.ok(logoGrid.args.some((a) => a.name === "size"), "logoGrid must document `size`");
  assert.ok(typeof logoGrid.example === "string");

  const logoLockup = byName.get("logoLockup");
  assert.ok(logoLockup.args.some((a) => a.name === "wordmark"));
  assert.ok(logoLockup.args.some((a) => a.name === "mark"));
  const mark = logoLockup.args.find((a) => a.name === "mark");
  assert.ok(Array.isArray(mark.values) && mark.values.includes("ring"), "mark must publish its accepted values");

  const vectorPlan = byName.get("vectorPlan");
  assert.ok(vectorPlan.args.some((a) => a.name === "steps"));
  assert.ok(typeof vectorPlan.example === "string");
});

test("P1-5: enum arguments publish the closed value list", () => {
  const byName = new Map(runtimeCatalogue().map((p) => [p.name, p]));
  const routing = byName.get("connector").args.find((a) => a.name === "routing");
  assert.deepEqual(routing.values, ["straight", "orthogonal", "curved"]);
});

test("P1-5: `divisions` is accepted at runtime instead of rejected", () => {
  const result = executeRuntime({
    canvas: { name: "Logo", width: 400, height: 400, grid: 8 },
    regions: [{ fn: "frame", id: "stage" }],
    content: [{ fn: "logoGrid", id: "guides", parent: "stage", args: { size: 0.8, divisions: 6, color: "#0D99FF" } }],
  });
  assert.deepEqual(result.warnings, [], `divisions was rejected: ${JSON.stringify(result.warnings)}`);
  assert.equal(result.operations.filter((o) => o.type === "createVector").length, 1);
});

test("P1-5: a wrong argument type names the expected shape before layout", () => {
  const issues = validatePrimitiveArgs("connector", { from: "a", to: "b", routing: "wobbly" });
  const routing = issues.find((i) => i.arg === "routing");
  assert.ok(routing, "an invalid enum value must be reported");
  assert.equal(routing.problem, "wrong-type");
  assert.match(routing.message, /must be one of "straight", "orthogonal", "curved"/);
});

test("P1-5: a misspelled argument suggests the accepted key", () => {
  const issues = validatePrimitiveArgs("connector", { from: "a", too: "b" });
  const typo = issues.find((i) => i.arg === "too");
  assert.ok(typo);
  assert.equal(typo.problem, "unknown");
  assert.equal(typo.suggestion, "to");
  assert.match(typo.message, /Did you mean 'to'\?/);
});

test("P1-5: an unrelated argument is reported without a bogus suggestion", () => {
  const issues = validatePrimitiveArgs("connector", { programme: "run(this)" });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].suggestion, undefined, "an unrelated key must not be 'corrected' into one");
});

/* -------------------------------------------------------------------------- */
/* P1 #6 — the contrast repair is applied and verifiable                      */
/* -------------------------------------------------------------------------- */

const textNode = (id, name, color, background, size = 12, style = "Regular") => ({
  id,
  name,
  type: "TEXT",
  visible: true,
  depth: 1,
  parentId: "panel",
  x: 0,
  y: 0,
  w: 120,
  h: 16,
  background,
  text: { content: "Online", color, size, style, family: "Inter", styled: true, length: 6 },
});

const report = (nodes) => ({ target: "panel", scope: "panel", nodeCount: nodes.length, nodes });

test("P1-6: the repair reaches the required ratio while holding the hue", () => {
  // The live failure: eight #777777 labels on white at 4.48:1.
  const repair = repairTextColour("#777777", "#FFFFFF", 4.5);
  assert.ok(repair, "a grey on white is repairable by lightness alone");
  assert.ok(repair.ratio >= 4.5, `repair must pass, got ${repair.ratio}`);
  assert.ok(repair.ratio < 5.5, "the repair should be the smallest shift that passes, not a jump to black");
  assert.ok(repair.hex !== "#777777");

  // Same hue: both are neutral greys, so R === G === B.
  const rgb = parseHex(repair.hex);
  assert.ok(Math.abs(rgb.r - rgb.g) < 0.02 && Math.abs(rgb.g - rgb.b) < 0.02, "a grey must stay a grey");

  // The claimed ratio is the real ratio (the reported one is rounded).
  assert.ok(Math.abs(contrastRatio(repair.hex, "#FFFFFF") - repair.ratio) < 0.01);
});

test("P1-6: a coloured text colour keeps its hue when repaired", () => {
  const repair = repairTextColour("#7A90B5", "#FFFFFF", 4.5);
  assert.ok(repair);
  assert.ok(repair.ratio >= 4.5);

  const hue = (hex) => {
    const { r, g, b } = parseHex(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - g) / d + 2 : (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  };
  const before = hue("#7A90B5");
  const after = hue(repair.hex);
  assert.ok(Math.abs(before - after) < 12, `hue drifted from ${before} to ${after}: the repair left the palette`);
});

test("P1-6: the text-contrast finding now carries an applicable operation", () => {
  const metrics = report([textNode("t1", "Label", "#777777", "#FFFFFF")]);
  const finding = runRules(metrics, "review").find((f) => f.rule === "text-contrast");
  assert.ok(finding, "the finding must still be raised");
  assert.ok(finding.suggestedOperations?.length > 0, "and must now be repairable");

  const op = finding.suggestedOperations[0];
  assert.equal(op.type, "setFill");
  assert.equal(op.target, "t1");
  assert.ok(contrastRatio(op.fill, "#FFFFFF") >= 4.5, "the proposed fill must actually pass");
});

test("P1-6: the finding verifies the ratio it claims", () => {
  const finding = runRules(report([textNode("t1", "Label", "#777777", "#FFFFFF")]), "review").find((f) => f.rule === "text-contrast");
  assert.equal(finding.evidence.repairVerified, true);
  assert.ok(finding.evidence.proposedRatio >= finding.evidence.required);
  assert.match(finding.guidance, /holding the hue/);
});

test("P1-6: a surface no text colour can reach is reported as such, not repaired", () => {
  // At the AA threshold of 4.5:1 some text colour always exists (black and
  // white straddle every background at 4.58:1 or better), so the unrepairable
  // branch is exercised at AAA, where it is genuinely reachable.
  const surface = "#767676";
  assert.ok(contrastRatio("#000000", surface) < 7, "black must genuinely fail at AAA on this surface");
  assert.ok(contrastRatio("#FFFFFF", surface) < 7, "white must genuinely fail at AAA on this surface");
  assert.equal(repairTextColour("#777777", surface, 7), null, "must not invent a colour that still fails");

  // At AA the same pair is repairable, which is what the rule actually requests.
  assert.ok(repairTextColour("#777777", surface, 4.5) !== null);
});

test("P1-6: the AA threshold is always repairable, so the rule never ships a dead end", () => {
  // Guards the contract the rule relies on: `requiredRatio` only ever returns 3
  // or 4.5, and for both of those some text colour always clears the bar. If
  // that stopped being true the rule would report findings it cannot fix.
  for (const surface of ["#FFFFFF", "#F0F3F5", "#767676", "#242521", "#000000", "#0D99FF"]) {
    for (const required of [3, 4.5]) {
      const repair = repairTextColour("#777777", surface, required);
      assert.ok(repair, `${surface} at ${required}:1 should be repairable`);
      assert.ok(contrastRatio(repair.hex, surface) >= required, `${repair.hex} on ${surface} must reach ${required}:1`);
    }
  }
});

test("P1-6: rgbToHex round-trips", () => {
  assert.equal(rgbToHex({ r: 1, g: 0, b: 0 }), "#FF0000");
  assert.equal(rgbToHex({ r: 0, g: 0, b: 0 }), "#000000");
  // Clamped, not wrapped: a channel outside 0..1 must not produce a short hex.
  assert.equal(rgbToHex({ r: 1.5, g: -0.2, b: 0.5 }), "#FF0080");
});

/* -------------------------------------------------------------------------- */
/* P1 #7 — semantic grouping suppresses the false positives                   */
/* -------------------------------------------------------------------------- */

const rect = (id, name, x, y, w, h, extra = {}) => ({
  id,
  name,
  type: "RECTANGLE",
  visible: true,
  depth: 2,
  parentId: "panel",
  x,
  y,
  w,
  h,
  fill: "#2D7A4D",
  ...extra,
});

const label = (id, x, y, w, content) => ({
  id,
  name: content,
  type: "TEXT",
  visible: true,
  depth: 2,
  parentId: "panel",
  x,
  y,
  w,
  h: 14,
  text: { content, color: "#242521", size: 11, style: "Regular", family: "Inter", styled: true, length: content.length },
});

const colourOnlyFor = (nodes) =>
  runRules(report(nodes), "review")
    .filter((f) => f.rule === "color-only-state")
    .flatMap((f) => f.nodeIds);

test("P1-7: a green dot with an adjacent ONLINE label is not colour-only state", () => {
  const metrics = report([
    { id: "panel", name: "Device Panel", type: "FRAME", visible: true, depth: 1, x: 0, y: 0, w: 300, h: 40 },
    rect("dot", "Health Dot", 16, 13, 12, 12),
    label("state", 36, 12, 60, "ONLINE"),
  ]);
  assert.ok(!colourOnlyFor(metrics.nodes).includes("dot"), "a dot labelled ONLINE communicates its state in words");
});

test("P1-7: a genuinely colour-only indicator is still reported", () => {
  const metrics = report([
    { id: "panel", name: "Device Panel", type: "FRAME", visible: true, depth: 1, x: 0, y: 0, w: 300, h: 40 },
    rect("dot", "Health Dot", 16, 13, 12, 12),
  ]);
  assert.ok(colourOnlyFor(metrics.nodes).includes("dot"), "the real finding must survive the grouping fix");
});

test("P1-7: a label in a different row does not excuse a colour-only indicator", () => {
  const metrics = report([
    { id: "panel", name: "Device Panel", type: "FRAME", visible: true, depth: 1, x: 0, y: 0, w: 300, h: 80 },
    rect("dot", "Health Dot", 16, 8, 12, 12),
    label("state", 16, 50, 60, "ONLINE"),
  ]);
  assert.ok(colourOnlyFor(metrics.nodes).includes("dot"), "a caption in another row is not this dot's label");
});

test("P1-7: a labelled control background is not an icon-only control", () => {
  const metrics = report([
    { id: "panel", name: "Panel", type: "FRAME", visible: true, depth: 1, x: 0, y: 0, w: 400, h: 120 },
    rect("bg", "Deploy Button", 20, 40, 140, 40, { fill: "#242521" }),
    label("cap", 52, 53, 76, "Deploy"),
  ]);
  assert.deepEqual(runRules(metrics, "review").filter((f) => f.rule === "icon-only-control"), []);
});

test("P1-7: an unlabelled control is still reported", () => {
  const metrics = report([
    { id: "panel", name: "Panel", type: "FRAME", visible: true, depth: 1, x: 0, y: 0, w: 400, h: 120 },
    rect("bg", "Deploy Button", 20, 40, 140, 40, { fill: "#242521" }),
  ]);
  assert.equal(runRules(metrics, "review").filter((f) => f.rule === "icon-only-control").length, 1);
});

test("P1-7: repeated table separators are not duplicate siblings", () => {
  const metrics = report([
    { id: "table", name: "Model Table", type: "FRAME", visible: true, depth: 1, x: 0, y: 0, w: 600, h: 200 },
    ...[0, 1, 2, 3].map((i) => ({
      id: `rule-${i}`,
      name: "Divider",
      type: "RECTANGLE",
      visible: true,
      depth: 2,
      parentId: "table",
      x: 0,
      y: 40 + i * 40,
      w: 600,
      h: 1,
      fill: "#D9D8D0",
    })),
  ]);
  assert.deepEqual(runRules(metrics, "review").filter((f) => f.rule === "duplicate-siblings"), []);
});

test("P1-7: three identical content nodes are still reported as duplicates", () => {
  const metrics = report([
    { id: "row", name: "Row", type: "FRAME", visible: true, depth: 1, x: 0, y: 0, w: 600, h: 200 },
    ...[0, 1, 2].map((i) => ({
      id: `card-${i}`,
      name: "Card",
      type: "FRAME",
      visible: true,
      depth: 2,
      parentId: "row",
      x: 0,
      y: i * 60,
      w: 200,
      h: 50,
      fill: "#FFFFFF",
      stroke: { hex: "#D9D8D0", weight: 1 },
    })),
  ]);
  assert.equal(runRules(metrics, "review").filter((f) => f.rule === "duplicate-siblings").length, 1);
});

/* -------------------------------------------------------------------------- */
/* P1 #6 — refine_screen iteration accounting                                 */
/* -------------------------------------------------------------------------- */

test("P1-6: the iteration summary counts iterations that actually ran", async () => {
  // The live failure: one visible iteration, reported as three. This drives the
  // real tool with a stub plugin, so the accounting is the shipped code path.
  const { refineScreenTool } = await import("../mcp-server/dist-test/review/workflow.js");

  const panel = () => ({ id: "panel", name: "Device Panel", type: "FRAME", visible: true, depth: 0, x: 0, y: 0, w: 400, h: 200 });
  const withLabel = (colour) => [panel(), textNode("12:34", "Label", colour, "#FFFFFF")];

  const calls = { collect: 0, modify: 0 };
  const session = {
    async request(kind) {
      if (kind === "collect_metrics") {
        calls.collect += 1;
        // First read shows the contrast defect; the re-read after the fix is clean.
        return report(calls.collect === 1 ? withLabel("#777777") : withLabel("#666666"));
      }
      if (kind === "modify_design") {
        calls.modify += 1;
        return { status: "success", createdNodes: [], error: { message: "" } };
      }
      throw new Error(`unexpected request ${kind}`);
    },
  };

  const result = await refineScreenTool(session, { maxIterations: 3 });
  assert.equal(result.status, "converged", `expected convergence, got ${result.status}: ${JSON.stringify(result.whyNothingWasApplied ?? [])}`);
  assert.equal(result.summary.iterationsRun, result.iterations.length, "the summary must match the trace");
  assert.equal(result.summary.iterationBudget, 3);
  assert.equal(result.summary.highConfidenceRemaining, 0);
});

test("P1-6: refine_screen actually applies the contrast repair", async () => {
  const { refineScreenTool } = await import("../mcp-server/dist-test/review/workflow.js");

  const panel = () => ({ id: "panel", name: "Device Panel", type: "FRAME", visible: true, depth: 0, x: 0, y: 0, w: 400, h: 200 });
  const withLabel = (colour) => [panel(), textNode("12:34", "Label", colour, "#FFFFFF")];

  const sent = [];
  const session = {
    async request(kind, args) {
      if (kind === "collect_metrics") {
        // Only the first read is defective; everything after the fix is clean.
        return report(sent.length === 0 ? withLabel("#777777") : withLabel("#666666"));
      }
      if (kind === "modify_design") {
        sent.push(...args.operations);
        return { status: "success", createdNodes: [], error: { message: "" } };
      }
      throw new Error(`unexpected request ${kind}`);
    },
  };

  const result = await refineScreenTool(session, { maxIterations: 3 });
  assert.equal(sent.length, 1, `exactly one fix should have been applied, got ${JSON.stringify(sent)}`);
  assert.equal(sent[0].type, "setFill");
  assert.equal(sent[0].target, "12:34");
  assert.ok(contrastRatio(sent[0].fill, "#FFFFFF") >= 4.5, "the applied patch must actually pass the check");
  assert.equal(result.status, "converged");
});

test("P1-6: an unfixable finding is skipped with a stated reason, and the count is honest", async () => {
  const { refineScreenTool } = await import("../mcp-server/dist-test/review/workflow.js");

  // A finding with no suggestedOperations (a default layer name has none) is
  // the exact shape that made refine_screen silently apply nothing.
  const node = {
    id: "screen",
    name: "Rectangle 12",
    type: "FRAME",
    visible: true,
    depth: 0,
    x: 0,
    y: 0,
    w: 800,
    h: 600,
  };
  const session = {
    async request(kind) {
      if (kind === "collect_metrics") return { target: "screen", scope: "screen", nodeCount: 1, nodes: [node] };
      throw new Error(`unexpected request ${kind}`);
    },
  };

  const result = await refineScreenTool(session, { maxIterations: 3 });
  assert.equal(result.status, "budget-exhausted");
  assert.equal(result.summary.iterationsRun, 1, "the loop broke after one iteration, so one is reported");
  assert.equal(result.summary.iterationBudget, 3);
  assert.ok(result.summary.skippedFixes > 0);
  assert.ok(Array.isArray(result.whyNothingWasApplied), "every skip must state its reason");
  assert.match(result.whyNothingWasApplied.join(" "), /proposes no operation/);
  assert.match(result.howToProceed, /after 1 iteration/, "the message must not claim iterations that never ran");
});