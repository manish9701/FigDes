/**
 * Regression tests for the vertical-stack banding defect.
 *
 * Symptom: `layoutStack` never banded side-by-side splits. A shell like
 * `header(64) + map(grow 1, topology) + inspector(340)` rendered the map
 * full-width and the inspector as a squashed full-width bottom rail, dumping
 * canvas overflow when inspector content was taller than its row.
 *
 * Fix: consecutive non-rail regions band when at least one fill/grow member
 * sits among numeric-width members whose declared widths fit beside it. The
 * band shares one height (the tallest member's requirement), capped so the
 * band stays on the canvas; the fill member takes the remaining width.
 *
 * Each test drives the shipped path (executeRuntime + compileIR) with the
 * exact program from the report, so the geometry asserted here is what the
 * tool actually commits, not a unit stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";

const CANVAS = { width: 1280, height: 800, grid: 8 };

const NODE_IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const nodes = NODE_IDS.map((id, i) => ({ id, label: `Node ${i + 1}`, memory: "192 GB", health: i % 4 === 0 ? "degraded" : "healthy" }));
// Branching two-level tree — the graph fits the banded map area.
const treeEdges = [
  { from: "a", to: "b", latency: "8 us", bandwidth: "8 GB/s" },
  { from: "a", to: "c", latency: "8 us", bandwidth: "8 GB/s" },
  { from: "a", to: "d", latency: "8 us", bandwidth: "8 GB/s" },
  { from: "a", to: "e", latency: "8 us", bandwidth: "8 GB/s" },
  { from: "b", to: "f", latency: "8 us", bandwidth: "8 GB/s" },
  { from: "b", to: "g", latency: "8 us", bandwidth: "8 GB/s" },
  { from: "c", to: "h", latency: "8 us", bandwidth: "8 GB/s" },
];

const shell = (panels) => ({
  canvas: { name: "Topology split", ...CANVAS },
  regions: [
    { fn: "header", id: "head", args: { height: 64 } },
    { fn: "frame", id: "map", args: { grow: 1, composition: "topology", layout: "topology" } },
    { fn: "inspector", id: "inspector", args: { width: 340 } },
  ],
  content: [
    { fn: "topologyMap", id: "topo", parent: "map", args: { title: "Fleet", nodes, edges: treeEdges } },
    ...Array.from({ length: panels }, (_, i) => ({ fn: "panel", id: `ins-${i}`, parent: "inspector", args: { title: `Panel ${i + 1}` } })),
  ],
});

const compile = (program) => {
  const result = executeRuntime(program);
  return compileIR(result.ir);
};

const region = (compiled, id) => compiled.regions.find((r) => r.id === id);
const near = (actual, expected, name) =>
  assert.equal(
    Math.round(actual),
    expected,
    `${name}: expected ${expected}, got ${Math.round(actual)}`
  );

test("band: header(64) + map(grow) + inspector(340) renders map and inspector side by side", () => {
  const compiled = compile(shell(1));

  assert.equal(
    compiled.applicable,
    true,
    `the split view must apply: ${JSON.stringify(compiled.inapplicableReasons)}`
  );

  const head = region(compiled, "head");
  const map = region(compiled, "map");
  const inspector = region(compiled, "inspector");

  // Header spans the canvas on top.
  near(head.w, 1280, "header width");
  near(head.h, 64, "header height");
  near(head.x, 0, "header x");
  near(head.y, 0, "header y");

  // The map and the inspector share one band under the header: the inspector
  // keeps its declared 340px, the map takes the remaining content width
  // (1280 - 340 - 32 gutter = 908), and both stand at the same top edge.
  near(map.w, 908, "map band width");
  near(map.x, 0, "map x");
  near(inspector.x, 940, "inspector x (map right edge + gutter)");
  near(inspector.w, 340, "inspector declares its 340px");
  near(map.y, 96, "map y = header + gutter");
  near(inspector.y, 96, "inspector shares the map's band top");
  near(map.h, 704, "map band height");
  near(inspector.h, 704, "inspector shares the band height");

  // Every region stays on the 1280x800 canvas.
  for (const r of compiled.regions) {
    assert.ok(r.y + r.h <= CANVAS.height + 0.5, `${r.id} escapes the canvas bottom: y=${r.y} h=${r.h}`);
    assert.ok(r.x + r.w <= CANVAS.width + 0.5, `${r.id} escapes the canvas right: x=${r.x} w=${r.w}`);
    assert.ok(r.h > 0, `${r.id} collapsed to zero height`);
  }

  // No spill class findings: overflow like this must not reach the canvas.
  const hard = compiled.violations.filter((v) => v.rule !== "layout");
  assert.deepEqual(hard, [], `no containment/geometry violations expected: ${JSON.stringify(hard)}`);
});

test("band cap: inspector content taller than the band is capped, and the spillover is reported as containment, not canvas escape", () => {
  const compiled = compile(shell(8));

  const map = region(compiled, "map");
  const inspector = region(compiled, "inspector");

  // The band did not stretch to hug the tall content: map and inspector keep
  // the capped band geometry (704h), so the canvas bottom edge is respected.
  near(map.h, 704, "map keeps the capped band height");
  near(map.y + map.h, 800, "map band ends exactly at the canvas bottom");
  near(inspector.h, 704, "inspector keeps the capped band height");
  near(inspector.y + inspector.h, 800, "inspector band ends exactly at the canvas bottom");
  for (const r of compiled.regions) {
    assert.ok(r.y + r.h <= CANVAS.height + 0.5, `${r.id} escapes the canvas bottom: y=${r.y} h=${r.h}`);
  }

  // The honest report: the overflow surfaces as an in-region containment
  // finding, not as a region off-canvas and not as a silent squash.
  const containment = compiled.violations.filter((v) => v.rule === "containment");
  assert.ok(
    containment.some((v) => /ins-7/.test(v.message)),
    `the 8th panel's spill must be reported: ${JSON.stringify(containment)}`
  );
  const escaped = compiled.regions.filter((r) => r.y + r.h > 800);
  assert.deepEqual(escaped, [], "no region itself may leave the canvas");
});

test("control: numeric-width-only stacks keep their rows — banding does not fire without a fill member", () => {
  const compiled = compile({
    canvas: { name: "Control", ...CANVAS },
    regions: [
      { fn: "frame", id: "left", args: { width: 800, height: "fill" } },
      { fn: "frame", id: "right", args: { width: 400, height: "fill" } },
    ],
    content: [{ fn: "panel", id: "l", parent: "left", args: { title: "Left" } }, { fn: "panel", id: "r", parent: "right", args: { title: "Right" } }],
  });

  assert.equal(compiled.applicable, true);
  const left = region(compiled, "left");
  const right = region(compiled, "right");

  // Both keep their declared widths and the same full-width row behaviour as
  // before banding: left on top, right beneath it (the normal stack order).
  near(left.w, 800, "left keeps its declared 800px");
  near(left.h, 384, "left row height (canvas-fit reflowed)");
  near(left.x, 0, "left x");
  near(left.y, 0, "left y");
  near(right.w, 400, "right keeps its declared 400px");
  near(right.h, 384, "right row height");
  near(right.x, 0, "right x");
  near(right.y, 416, "right row starts after left's row + gutter");

  assert.deepEqual(compiled.violations, [], "a valid control layout reports no violations");
});

test("relations: a declared relation keeps the solver owning geometry — no banding", () => {
  const compiled = compile({
    canvas: { name: "R", ...CANVAS },
    regions: [
      { fn: "frame", id: "map", args: { grow: 1 } },
      { fn: "inspector", id: "side", args: { width: 320 } },
    ],
    relations: [{ id: "side", rightOf: "map", gap: 24, width: 320, height: 800, top: 0 }],
  });

  const map = region(compiled, "map");
  const side = region(compiled, "side");

  // The side region follows its declared relationship: right of the map with
  // the declared gap, not a shell-computed band column.
  assert.equal(side.x, map.x + map.w + 24, "the relation solver owns the side region's x");
  assert.equal(side.y, map.y, "and its top edge comes from the relation");

  // The declared relation cannot fit (map already takes the full width), so
  // the solver reports the spill honestly rather than silently rearranging.
  const rules = compiled.violations.map((v) => v.rule);
  assert.ok(rules.includes("relation"), `the impossible relation is named: ${JSON.stringify(compiled.violations)}`);
  assert.ok(rules.includes("geometry"), `the spill surfaces as resolved geometry: ${JSON.stringify(compiled.violations)}`);
});

test("IR-shaped sizing on a plan-dialect call folds into args and still bands", () => {
  const result = executeRuntime({
    canvas: { name: "Folded sizing", ...CANVAS },
    regions: [
      { fn: "frame", id: "map", width: "fill", height: "fill" },
      { fn: "inspector", id: "ins", width: 360 },
    ],
    content: [],
  });
  assert.ok(
    result.warnings.some((w) => /folded into args/.test(w) && /'map'/.test(w)),
    `region-level declarations are reported, not swallowed: ${JSON.stringify(result.warnings)}`
  );

  const compiled = compileIR(result.ir);
  assert.equal(compiled.applicable, true, `the program must apply: ${JSON.stringify(compiled.inapplicableReasons)}`);

  const map = region(compiled, "map");
  const ins = region(compiled, "ins");
  near(map.w, 888, "map takes the remainder beside the folded 360px inspector");
  near(ins.w, 360, "the inspector keeps its region-level declared width");
  near(ins.x, 920, "inspector sits in the band beside the map");
  near(map.y, ins.y, "band members share the top edge");
  for (const r of compiled.regions) {
    assert.ok(
      r.x + r.w <= CANVAS.width + 0.5 && r.y + r.h <= CANVAS.height + 0.5,
      `${r.id} escapes the canvas: x=${r.x} w=${r.w} y=${r.y} h=${r.h}`
    );
  }
});

test("an under-specified rightOf pin declines to own geometry and stays on-canvas", () => {
  const compiled = compile({
    canvas: { name: "Bare pin", ...CANVAS },
    regions: [
      { fn: "frame", id: "map", args: { width: "fill", height: "fill" } },
      { fn: "inspector", id: "ins", args: { width: 360 } },
    ],
    relations: [{ id: "ins", rightOf: "map" }],
  });

  const map = region(compiled, "map");
  const ins = region(compiled, "ins");

  // The bare pin does not own its width and height, so banding still runs:
  // the map bands beside the 360px inspector instead of eating the canvas.
  near(map.w, 888, "the fill region bands beside the 360px inspector");
  assert.ok(ins.x > map.x + map.w - 0.5, "the inspector sits to the right of the map");
  assert.ok(
    ins.x + ins.w <= CANVAS.width + 0.5,
    `the pin must not push the inspector off-canvas: ins.x=${ins.x} w=${ins.w}`
  );
  near(ins.y, map.y, "the pin keeps the shared top edge");
  const rules = compiled.violations.map((v) => v.rule);
  assert.ok(
    !rules.includes("relation") && !rules.includes("geometry"),
    `an on-canvas pin reports no solver violations: ${JSON.stringify(compiled.violations)}`
  );
});
