/**
 * Issue #24 live-topology hotfix (reported against the running server):
 *
 * 1. A selected device node was emitted 128x80 while its resolved box was
 *    130x82 (the selection-ring placement expansion), tripping the
 *    operation-trace check on every topology with a selection.
 * 2. Three stacked device nodes landed 16px apart, so both connectors were
 *    shorter than the 20px their arrowheads need and degraded to plain lines.
 *
 * Both are layout-contract defects: the emitter must draw the recorded box,
 * and device levels must clear the heaviest edge's arrowheads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

const TOPO = (nodes, edges, extra = {}) => ({
  canvas: { width: 900, height: 700, grid: 8 },
  regions: [{ fn: "frame", id: "stage", args: { grow: 1, layout: "topology", padding: 24 } }],
  content: [{
    fn: "topologyMap", id: "topo", parent: "stage", args: { nodes, edges, ...extra },
  }],
});

const NODES = [
  { id: "a", label: "A", health: "healthy" },
  { id: "b", label: "B", health: "healthy" },
  { id: "c", label: "C", health: "healthy" },
];
const EDGES = [{ from: "a", to: "b" }, { from: "b", to: "c" }];

test("selected node: emitted dimensions equal resolved dimensions, no trace violation", () => {
  const r = executeRuntime(TOPO(NODES, EDGES, { selectedNode: "b" }));
  assert.equal(r.applicable, true);
  const box = r.boxes.get("topo-b");
  const op = r.operations.find((o) => o.id === "topo-b");
  assert.ok(box && op, "selected node has a box and an operation");
  assert.equal(op.width, Math.round(box.w), `emitted ${op.width} vs resolved ${Math.round(box.w)}`);
  assert.equal(op.height, Math.round(box.h), `emitted ${op.height} vs resolved ${Math.round(box.h)}`);
  assert.ok(!r.violations.some((v) => v.rule === "operation-trace"), JSON.stringify(r.violations));
});

test("unselected nodes still draw at the 128x80 intrinsic", () => {
  const r = executeRuntime(TOPO(NODES, EDGES));
  for (const id of ["topo-a", "topo-b", "topo-c"]) {
    const op = r.operations.find((o) => o.id === id);
    assert.equal(op.width, 128, `${id} width`);
    assert.equal(op.height, 80, `${id} height`);
  }
});

test("three-node stack: connectors keep their arrowheads, no short-edge violation", () => {
  const r = executeRuntime(TOPO(NODES, EDGES));
  assert.equal(r.applicable, true);
  assert.ok(!r.violations.some((v) => v.rule === "connector"), JSON.stringify(r.violations));
  const boxes = new Map([...r.boxes].filter(([id]) => id.startsWith("topo-") && !id.includes("edge") && !id.includes("label")));
  const gapAB = boxes.get("topo-b").y - (boxes.get("topo-a").y + boxes.get("topo-a").h);
  assert.ok(gapAB >= 20, `inter-node clearance ${gapAB} must clear 1px arrowheads (20px)`);
});

test("critical (3px) edges pitch nodes far enough to keep 50px arrow space", () => {
  const r = executeRuntime(TOPO(NODES, [
    { from: "a", to: "b", weight: "critical" },
    { from: "b", to: "c", weight: "critical" },
  ]));
  assert.equal(r.applicable, true);
  assert.ok(!r.violations.some((v) => v.rule === "connector"), JSON.stringify(r.violations));
  const boxes = new Map([...r.boxes].filter(([id]) => id.startsWith("topo-") && !id.includes("edge") && !id.includes("label")));
  const gapAB = boxes.get("topo-b").y - (boxes.get("topo-a").y + boxes.get("topo-a").h);
  assert.ok(gapAB >= 50, `clearance ${gapAB} must clear 3px arrowheads (50px)`);
});

test("full run: selected topology has no connector, trace, or layout violations", () => {
  const r = executeRuntime(TOPO(NODES, EDGES, { selectedNode: "b" }));
  const bad = r.violations.filter((v) => ["connector", "operation-trace", "layout"].includes(v.rule));
  assert.deepEqual(bad, [], JSON.stringify(bad));
});
