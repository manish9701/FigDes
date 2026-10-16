/**
 * Regressions for GitHub issue #11.
 *
 * Written from the reported symptoms. Where an issue item was already satisfied
 * by an earlier fix (#5 guard, #8 semantic grouping, #11 primitive schemas), the
 * test asserts it stays satisfied rather than being skipped — the point of this
 * file is that the whole issue is re-verified by one command.
 *
 * Issue: https://github.com/manish9701/FigDes/issues/11
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";
import { runtimeCatalogue } from "../mcp-server/dist-test/runtime/tools.js";
import { contrastRatio } from "../mcp-server/dist-test/shared/contrast.js";

/* -------------------------------------------------------------------------- */
/* A1 — runtime layout must satisfy spatial intent                             */
/* -------------------------------------------------------------------------- */

/** The three canvas sizes the issue asks to be covered. */
const CANVASES = [
  { width: 1440, height: 900 },
  { width: 1600, height: 1000 },
  { width: 1600, height: 1100 },
];

const shell = (canvas) => ({
  canvas: { name: "Shell", ...canvas, grid: 8 },
  regions: [
    { fn: "navigation", id: "nav", args: { width: 200 } },
    { fn: "frame", id: "body", args: { width: Math.round(canvas.width * 0.58) } },
    { fn: "inspector", id: "side", args: { width: 320 } },
  ],
  content: [{ fn: "text", id: "t", parent: "body", args: { text: "Compute" } }],
  relations: [{ id: "side", rightOf: "body", gap: 24, width: 320, height: canvas.height, top: 0 }],
});

for (const canvas of CANVASES) {
  test(`A1: ${canvas.width}x${canvas.height} nav + body + inspector resolves side-by-side`, () => {
    const result = executeRuntime(shell(canvas));
    const compiled = compileIR(result.ir);

    assert.equal(
      compiled.applicable,
      true,
      `plan should be applicable: ${JSON.stringify(compiled.inapplicableReasons)}`,
    );
    assert.deepEqual(compiled.violations, [], "a valid layout must report no violations");

    const nav = compiled.regions.find((r) => r.id === "nav");
    const body = compiled.regions.find((r) => r.id === "body");
    const side = compiled.regions.find((r) => r.id === "side");

    // The declared relationship is what the geometry actually shows.
    assert.equal(side.x, body.x + body.w + 24, "inspector must sit right of body with the declared gap");
    assert.equal(side.y, body.y, "and share its top edge");
    assert.ok(side.x + side.w <= canvas.width, "and end inside the canvas");

    // Regions must not overlap.
    const overlaps = (a, b) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    assert.ok(!overlaps(nav, body), "nav and body must not overlap");
    assert.ok(!overlaps(body, side), "body and inspector must not overlap");

    for (const r of compiled.regions) {
      assert.ok(r.x >= -1 && r.y >= -1, `${r.id} starts off-canvas`);
      assert.ok(r.x + r.w <= canvas.width + 1 && r.y + r.h <= canvas.height + 1, `${r.id} ends off-canvas`);
    }
  });
}

test("A1: an inspector that cannot fit is refused rather than drawn off-canvas", () => {
  // The reported symptom: inspector below the canvas, overflow, no warning.
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "body", args: { grow: 1 } },
      { fn: "inspector", id: "side", args: { width: 320 } },
    ],
    relations: [{ id: "side", rightOf: "body", gap: 24, width: 320, height: 900, top: 0 }],
  });
  const compiled = compileIR(result.ir);

  assert.equal(compiled.applicable, false);
  assert.ok(compiled.inapplicableReasons.length > 0);
  assert.ok(
    compiled.inapplicableReasons.some((m) => /canvas|off-canvas/i.test(m)),
    JSON.stringify(compiled.inapplicableReasons),
  );
  // The operations are still returned so the plan stays inspectable.
  assert.ok(compiled.operations.length > 0);
});

test("A1: height:'fill' beside rightOf fills the canvas instead of collapsing", () => {
  // `fill` used to be measured before positioning, so it filled from wherever
  // the shell layout parked the box: a 1px-tall panel at the far right.
  const result = executeRuntime({
    canvas: { name: "T", width: 1600, height: 1000, grid: 8 },
    regions: [
      { fn: "frame", id: "body", args: { width: 900 } },
      { fn: "inspector", id: "side", args: { width: 320 } },
    ],
    relations: [{ id: "side", rightOf: "body", gap: 24, width: 320, height: "fill", top: 0 }],
  });
  const side = compileIR(result.ir).regions.find((r) => r.id === "side");
  assert.ok(side.h > 500, `inspector should fill the canvas height, got ${side.h}`);
});

test("A1: a declared width survives a navigation rail", () => {
  // layoutSideRail used to force every region to the full content width while
  // layoutStack honoured the declared value, so the same program behaved
  // differently depending on whether a rail happened to be present.
  const result = executeRuntime({
    canvas: { name: "T", width: 1600, height: 900, grid: 8 },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 200 } },
      { fn: "frame", id: "body", args: { width: 600 } },
    ],
  });
  const body = compileIR(result.ir).regions.find((r) => r.id === "body");
  assert.equal(body.w, 600, "a declared width must not be expanded to the content width");
});

test("A1: an over-wide region is clamped to the canvas rather than pushed off it", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 200 } },
      { fn: "frame", id: "body", args: { width: 4000 } },
    ],
  });
  const compiled = compileIR(result.ir);
  const body = compiled.regions.find((r) => r.id === "body");
  assert.ok(body.x + body.w <= 1441, `clamped into the canvas, got ${body.x}+${body.w}`);
});

/* -------------------------------------------------------------------------- */
/* A2 — resolved boxes and emitted operations must match                      */
/* -------------------------------------------------------------------------- */

/** Folds a parent-local emitted coordinate into canvas space. */
function canvasOrigin(boxes, parentId) {
  if (parentId === undefined || parentId === "root") return { x: 0, y: 0 };
  const b = boxes.get(parentId);
  return b ? { x: b.x, y: b.y } : { x: 0, y: 0 };
}

test("A2: every created operation agrees with its resolved box in both spaces", () => {
  const result = executeRuntime(shell({ width: 1600, height: 1000 }));
  const compiled = compileIR(result.ir);

  assert.equal(compiled.stats.traceMismatches, 0, JSON.stringify(compiled.violations));
  assert.deepEqual(compiled.violations.filter((v) => v.rule === "operation-trace"), []);

  // Golden comparison, not just the count: replay the trace and check every
  // create op against the resolved geometry in canvas space.
  const final = new Map();
  for (const op of compiled.operations) {
    if (typeof op.type !== "string") continue;
    const o = op;
    if (op.type.startsWith("create") && typeof o.id === "string") {
      final.set(o.id, { parent: o.parent, x: o.x, y: o.y, w: o.width, h: o.height });
    } else if (op.type === "setPosition" || op.type === "setSize") {
      const s = final.get(o.target);
      if (!s) continue;
      if (typeof o.x === "number") s.x = o.x;
      if (typeof o.y === "number") s.y = o.y;
      if (typeof o.width === "number") s.w = o.width;
      if (typeof o.height === "number") s.h = o.height;
    }
  }

  let checked = 0;
  for (const [id, state] of final) {
    if (id === "root") continue;
    const box = compiled.boxes.get(id);
    if (!box) continue;
    checked++;
    const origin = canvasOrigin(compiled.boxes, state.parent);
    if (typeof state.x === "number" && typeof state.y === "number") {
      assert.ok(
        Math.abs(state.x + origin.x - box.x) <= 1 && Math.abs(state.y + origin.y - box.y) <= 1,
        `${id}: emitted (${state.x},${state.y}) rel to '${String(state.parent)}' = canvas (${state.x + origin.x},${state.y + origin.y}), resolved box is (${box.x},${box.y})`,
      );
    }
    if (typeof state.w === "number") {
      assert.ok(Math.abs(state.w - box.w) <= 1, `${id}: emitted ${state.w} wide, resolved ${box.w}`);
    }
    if (typeof state.h === "number") {
      assert.ok(Math.abs(state.h - box.h) <= 1, `${id}: emitted ${state.h} tall, resolved ${box.h}`);
    }
  }
  assert.ok(checked >= 3, `expected several comparable operations, checked ${checked}`);
});

test("A2: a moved region's content moves with it and stays inside it", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1600, height: 1000, grid: 8 },
    regions: [
      { fn: "frame", id: "body", args: { width: 900 } },
      { fn: "inspector", id: "side", args: { width: 320 } },
    ],
    content: [
      { fn: "statusPill", id: "pill", parent: "side", args: { label: "Online", tone: "healthy" } },
      { fn: "text", id: "lbl", parent: "side", args: { text: "Selected" } },
    ],
    relations: [{ id: "side", rightOf: "body", gap: 24, width: 320, height: "fill", top: 0 }],
  });
  const compiled = compileIR(result.ir);
  const side = compiled.regions.find((r) => r.id === "side");

  for (const id of ["pill", "lbl"]) {
    const box = compiled.boxes.get(id);
    assert.ok(box, `${id} should be placed`);
    assert.ok(
      box.x >= side.x - 1 && box.y >= side.y - 1 && box.x + box.w <= side.x + side.w + 1,
      `${id} at (${box.x},${box.y}) ${box.w}x${box.h} escaped region '${side.id}' at (${side.x},${side.y}) ${side.w}x${side.h}`,
    );
  }
  assert.deepEqual(compiled.violations.filter((v) => v.rule === "containment"), []);
});

/* -------------------------------------------------------------------------- */
/* A4 — connector references and endpoints                                     */
/* -------------------------------------------------------------------------- */

test("A4: connectors resolve regardless of declaration order", () => {
  // The connector is declared first and its endpoints after: resolution must be
  // by id against a symbol table, not by position in the content list.
  const ir = {
    canvas: { name: "T", width: 1600, height: 1100, grid: 8 },
    regions: [{ id: "map", role: "primary-visual", composition: "topology", layout: "topology", children: ["a", "b", "e"] }],
    content: [
      { kind: "connector", id: "e", from: "a", to: "b", label: "serves" },
      { kind: "component", id: "b", type: "deviceNode", props: { label: "B" } },
      { kind: "component", id: "a", type: "deviceNode", props: { label: "A" } },
    ],
    tokens: [],
    relations: [],
  };
  const compiled = compileIR(ir);
  assert.deepEqual(compiled.violations.filter((v) => v.rule === "connector"), []);
  assert.ok(compiled.boxes.has("a") && compiled.boxes.has("b"));
});

test("A4: connector endpoints land on the nodes they connect", () => {
  const compiled = compileIR({
    canvas: { name: "T", width: 1600, height: 1100, grid: 8 },
    regions: [{ id: "map", role: "primary-visual", composition: "topology", layout: "topology", children: ["a", "b", "e"] }],
    content: [
      { kind: "component", id: "a", type: "deviceNode", props: { label: "A" } },
      { kind: "component", id: "b", type: "deviceNode", props: { label: "B" } },
      { kind: "connector", id: "e", from: "a", to: "b", label: "serves" },
    ],
    tokens: [],
    relations: [],
  });

  const a = compiled.boxes.get("a");
  const b = compiled.boxes.get("b");
  const vector = compiled.operations.find((o) => o.type === "createVector" && o.id === "e");
  assert.ok(vector, "the connector must be emitted");

  // Every coordinate in the route sits within the hull of the two nodes, so the
  // line cannot have been solved against stale geometry.
  const numbers = String(vector.path).match(/-?(?:\d+\.?\d*|\.\d+)/g).map(Number);
  const xs = numbers.filter((_, i) => i % 2 === 0);
  const ys = numbers.filter((_, i) => i % 2 === 1);
  const left = Math.min(a.x, b.x) - 2;
  const right = Math.max(a.x + a.w, b.x + b.w) + 2;
  const top = Math.min(a.y, b.y) - 2;
  const bottom = Math.max(a.y + a.h, b.y + b.h) + 2;
  for (const x of xs) assert.ok(x >= left && x <= right, `route x=${x} outside the node hull`);
  for (const y of ys) assert.ok(y >= top && y <= bottom, `route y=${y} outside the node hull`);
});

/* -------------------------------------------------------------------------- */
/* A5 — guard cannot pass on unresolved evidence (stays fixed)                 */
/* -------------------------------------------------------------------------- */

test("A5: an empty snapshot still cannot PASS (stays fixed)", async () => {
  const { runGuard } = await import("../mcp-server/dist-test/memory/guard.js");
  const rules = [{ id: "r", rule: "x", therefore: "y", severity: "fail", evidence: [{ kind: "forbiddenText", pattern: "chat" }] }];

  for (const snapshot of [
    { nodeNames: [], texts: [], metrics: { nodes: 0, textNodes: 0 } },
    { resolved: false, nodeNames: ["a"], texts: ["b"], metrics: { nodes: 1, textNodes: 1 } },
    { source: "live", resolved: false, unresolvedReason: "plugin disconnected" },
  ]) {
    assert.notEqual(runGuard(rules, snapshot).verdict, "PASS", JSON.stringify(snapshot));
  }
});

/* -------------------------------------------------------------------------- */
/* B6 — context-aware contrast analysis                                       */
/* -------------------------------------------------------------------------- */

const node = (over) => ({ name: "Layer", visible: true, depth: 1, parentId: "root", x: 0, y: 0, w: 100, h: 40, ...over });

/** The screen frame. It is its own root, so it has no parent. */
const rootNode = (over) => node({ id: "root", parentId: null, type: "FRAME", depth: 0, x: 0, y: 0, w: 1440, h: 1000, ...over });

const buttonPair = (extra = {}) => ({
  target: "root",
  scope: "root",
  nodeCount: 4,
  nodes: [
    rootNode({ name: "Screen", fill: "#FAF6EF", zIndex: 0 }),
    node({ id: "btn", name: "Deploy Button", type: "FRAME", zIndex: 1, x: 40, y: 40, w: 140, h: 40, fill: "#242521" }),
    node({
      id: "btnlabel",
      name: "Deploy",
      type: "TEXT",
      zIndex: 2,
      x: 52,
      y: 53,
      w: 76,
      h: 18,
      background: "#FAF6EF",
      text: { content: "Deploy", color: "#FFFFFF", size: 13, style: "Bold", family: "Inter", styled: true, length: 6 },
    }),
    ...(extra.nodes ?? []),
  ],
});

test("B6: white text on a dark button surface is not a contrast failure", () => {
  // The reported false positive: 1.06:1 because the label was measured against
  // the warm-white page instead of the button it sits on.
  const findings = runRules(buttonPair(), "review").filter((f) => f.rule === "text-contrast");
  assert.deepEqual(findings, [], "white on #242521 is 15.9:1 and must pass");
});

test("B6: the measured surface is reported as evidence", () => {
  // Low-contrast text on white must still fail, with an accurate ratio.
  const metrics = buttonPair({
    nodes: [
      node({ id: "btn2", name: "Quiet Button", type: "FRAME", zIndex: 1, x: 40, y: 100, w: 140, h: 40, fill: "#F5F4EF" }),
      node({
        id: "btn2label",
        name: "Quiet",
        type: "TEXT",
        zIndex: 2,
        x: 52,
        y: 113,
        w: 76,
        h: 18,
        background: "#FAF6EF",
        text: { content: "Quiet", color: "#8A8C84", size: 13, style: "Regular", family: "Inter", styled: true, length: 5 },
      }),
    ],
  });
  const findings = runRules(metrics, "review").filter((f) => f.rule === "text-contrast" && f.nodeIds.includes("btn2label"));
  assert.equal(findings.length, 1, "low contrast on a light button must still fail");

  const f = findings[0];
  assert.match(f.evidence.surfaceSource, /sibling surface/, "the finding must say which surface it used");
  assert.equal(f.evidence.background, "#F5F4EF", "measured against the button, not the page");
  const actual = contrastRatio("#8A8C84", "#F5F4EF");
  assert.ok(Math.abs(f.evidence.ratio - Math.round(actual * 100) / 100) < 0.02, `reported ${f.evidence.ratio}, actual ${actual}`);
  assert.ok(actual < 4.5, "and the real pair genuinely fails");
});

test("B6: a surface painted over the text is not treated as its backdrop", () => {
  // A later zIndex means painted after the text, so it covers the label rather
  // than sitting behind it. The overlay here is white, so a reviewer that picked
  // it as the backdrop would report white-on-white at 1:1 and fail a button that
  // is correct. Measuring against the dark button must still pass.
  const findings = runRules(
    buttonPair({
      nodes: [node({ id: "over", name: "Overlay", type: "FRAME", zIndex: 9, x: 0, y: 0, w: 1440, h: 1000, fill: "#FFFFFF" })],
    }),
    "review",
  ).filter((f) => f.rule === "text-contrast" && f.nodeIds.includes("btnlabel"));
  assert.deepEqual(findings, [], "a white overlay painted above the label must not become its backdrop");
});

test("B6: a surface painted below the text does win, even when lighter", () => {
  // The mirror image: painted before the label, so it really is behind it, and
  // white label text on a white panel genuinely fails.
  const metrics = {
    target: "root",
    scope: "root",
    nodeCount: 3,
    nodes: [
      rootNode({ name: "Screen", fill: "#FAF6EF", zIndex: 0 }),
      node({ id: "panel", name: "Panel", type: "FRAME", zIndex: 1, x: 40, y: 40, w: 200, h: 60, fill: "#FFFFFF" }),
      node({
        id: "caption",
        name: "Caption",
        type: "TEXT",
        zIndex: 2,
        x: 56,
        y: 60,
        w: 120,
        h: 18,
        background: "#FAF6EF",
        text: { content: "Deployed", color: "#FFFFFF", size: 13, style: "Regular", family: "Inter", styled: true, length: 8 },
      }),
    ],
  };
  const findings = runRules(metrics, "review").filter((f) => f.rule === "text-contrast" && f.nodeIds.includes("caption"));
  assert.equal(findings.length, 1, "white text on a white panel is a real failure and must still be reported");
  assert.equal(findings[0].evidence.background, "#FFFFFF");
});

test("B6: the contrast repair still targets the text, not the surface", () => {
  const metrics = buttonPair({
    nodes: [
      node({ id: "btn2", name: "Quiet Button", type: "FRAME", zIndex: 1, x: 40, y: 100, w: 140, h: 40, fill: "#F5F4EF" }),
      node({
        id: "btn2label",
        name: "Quiet",
        type: "TEXT",
        zIndex: 2,
        x: 52,
        y: 113,
        w: 76,
        h: 18,
        background: "#FAF6EF",
        text: { content: "Quiet", color: "#8A8C84", size: 13, style: "Regular", family: "Inter", styled: true, length: 5 },
      }),
    ],
  });
  const finding = runRules(metrics, "review").find((f) => f.rule === "text-contrast");
  assert.ok(finding?.suggestedOperations?.length > 0, "still repairable");
  const op = finding.suggestedOperations[0];
  assert.equal(op.type, "setFill");
  assert.equal(op.target, "btn2label", "the text is changed, never the button surface");
  assert.ok(contrastRatio(op.fill, "#F5F4EF") >= 4.5, "and the repair passes against the real surface");
});

/* -------------------------------------------------------------------------- */
/* B8 / B11 — already fixed, must stay fixed                                  */
/* -------------------------------------------------------------------------- */

test("B8: semantic grouping still suppresses the named false positives", () => {
  const metrics = {
    target: "p",
    scope: "p",
    nodeCount: 3,
    nodes: [
      rootNode({ id: "p", name: "Device Panel", w: 300, h: 40 }),
      node({ id: "dot", name: "Health Dot", type: "RECTANGLE", zIndex: 1, x: 16, y: 13, w: 12, h: 12, fill: "#2D7A4D" }),
      node({
        id: "state",
        name: "ONLINE",
        type: "TEXT",
        zIndex: 2,
        x: 36,
        y: 12,
        w: 60,
        h: 14,
        text: { content: "ONLINE", color: "#242521", size: 11, style: "Regular", family: "Inter", styled: true, length: 6 },
      }),
    ],
  };
  const ids = runRules(metrics, "review").filter((f) => f.rule === "color-only-state").flatMap((f) => f.nodeIds);
  assert.ok(!ids.includes("dot"), "a dot labelled ONLINE is not colour-only");
});

test("B11: every advertised primitive still publishes its argument schema", () => {
  for (const primitive of runtimeCatalogue()) {
    assert.ok(Array.isArray(primitive.args) && primitive.args.length > 0, `${primitive.name} published no args`);
    for (const arg of primitive.args) assert.ok(arg.description.length > 0, `${primitive.name}.${arg.name} undocumented`);
  }
});

/* -------------------------------------------------------------------------- */
/* Applicability is a gate, not a message                                      */
/* -------------------------------------------------------------------------- */

test("a non-applicable plan is refused before it can be applied", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "body", args: { grow: 1 } },
      { fn: "inspector", id: "side", args: { width: 320 } },
    ],
    relations: [{ id: "side", rightOf: "body", gap: 24, width: 320, height: 900, top: 0 }],
  });
  assert.equal(result.applicable, false);
  assert.ok(result.inapplicableReasons.length > 0);
  // Structural problems gate; product judgements do not.
  assert.ok(result.inapplicableReasons.every((m) => typeof m === "string" && m.length > 0));
});