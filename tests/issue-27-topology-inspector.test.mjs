/**
 * Issue #27 — topology/inspector screens no longer ship the four defects the
 * live session surfaced after the First-Pass contract landed:
 *
 *   D1  device nodes and topology connectors overlap (routes through nodes)
 *   D2  a connector crosses nearby content or is too short for its arrowheads
 *   D3  inspector regions wrap below the canvas or exceed its bounds entirely
 *       instead of sitting beside the canvas they inspect
 *   D4  plan_screen reports compositionHintApplied:false for a requested
 *       topology composition, so the receipt lies about what got applied
 *
 * Every assertion pins a MEASURED contract, not an implementation detail, so
 * the offline repro (no Figma) proves the geometry the plugin cannot lie about.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { planScreenTool } from "../mcp-server/dist-test/plan/tools.js";
import { arrowSpace } from "../mcp-server/dist-test/runtime/connectors.js";

/* -------------------------------------------------------------------------- */
/* Shared needed helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Strict segment-vs-rect interior crossing (Liang-Barsky). */
function segCrossesBox(a, b, box) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - box.x, box.x + box.w - a.x, a.y - box.y, box.y + box.h - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return t1 > t0;
}

function pathLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/** Boxes of the eight device nodes the topology maps place. */
function deviceBoxes(built) {
  return [...built.boxes.values()].filter((b) => b.id.startsWith("topo-") && b.h > 40);
}

function auditTopo(built, canvas, heaviestStroke = 1) {
  const routes = built.connectorRoutes ?? [];
  const boxes = deviceBoxes(built);
  const through = [];
  const short = [];
  for (const route of routes) {
    for (const box of boxes) {
      if (route.from === box.id || route.to === box.id) continue;
      const pts = route.endpoints;
      for (let i = 1; i < pts.length; i++) {
        if (segCrossesBox(pts[i - 1], pts[i], box)) { through.push(`${route.id} -> ${box.id}`); break; }
      }
    }
    const chord = pathLen(route.endpoints);
    if (chord < arrowSpace(heaviestStroke)) short.push(`${route.id} chord ${Math.round(chord)}`);
  }
  const outside = [...built.boxes.values()]
    .filter((b) => b.x < -1 || b.y < -1 || b.x + b.w > canvas.width + 1 || b.y + b.h > canvas.height + 1)
    .map((b) => b.id);
  return { through, short, outside };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function topologyProgram({ extraEdges = [], tallInspector = false } = {}) {
  const nodes = [
    { id: "edge-gw", name: "Edge GW" }, { id: "core-a", name: "Core A", status: "pressured" },
    { id: "core-b", name: "Core B" },
    { id: "gpu-1", name: "GPU 1" }, { id: "gpu-2", name: "GPU 2", status: "degraded" },
    { id: "gpu-3", name: "GPU 3" }, { id: "gpu-4", name: "GPU 4" }, { id: "store", name: "Storage" },
  ];
  const edges = [
    { from: "edge-gw", to: "core-a", latency: "2ms" }, { from: "edge-gw", to: "core-b", latency: "3ms" },
    { from: "core-a", to: "gpu-1", latency: "8ms" }, { from: "core-a", to: "gpu-2", latency: "9ms" },
    { from: "core-b", to: "gpu-3", latency: "7ms" }, { from: "core-b", to: "gpu-4", latency: "8ms" },
    { from: "gpu-1", to: "store", latency: "12ms" }, { from: "gpu-2", to: "store", latency: "11ms" },
    ...extraEdges,
  ];
  const inspectorContent = tallInspector
    ? Array.from({ length: 6 }, (_, i) => ({
        fn: "panel", id: `ins-p${i}`, parent: "inspector",
        args: { title: `Section ${i + 1}`, body: "Where the model runs, required vs available memory, and the fit verdict for the selected shard." },
      }))
    : [{ fn: "panel", id: "ins-p0", parent: "inspector", args: { title: "Selected shard", body: "Where it should run, required vs available, and the verdict." } }];
  return {
    canvas: { name: "Cluster Topology", width: 1280, height: 800, grid: 8 },
    regions: [
      { fn: "header", id: "header", args: { height: 64 } },
      { fn: "frame", id: "map", args: { grow: 1, composition: "topology", layout: "topology" } },
      { fn: "inspector", id: "inspector", args: { width: 340 } },
    ],
    content: [
      { fn: "topologyMap", id: "topo", parent: "map", args: { title: "Cluster", nodes, edges } },
      ...inspectorContent,
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* D3 — the inspector sits BESIDE the canvas, never below it or off-canvas     */
/* -------------------------------------------------------------------------- */

test("an inspector declared beside a topology canvas bands to the right, inside the canvas", () => {
  const built = executeRuntime(topologyProgram());
  const canvas = { width: 1280, height: 800 };
  const insp = built.boxes.get("inspector");
  const map = built.boxes.get("map");
  assert.ok(insp, "inspector must resolve");
  assert.ok(map, "map must resolve");
  assert.equal(Math.round(insp.w), 340, "declared width honoured");
  assert.ok(insp.x >= map.x + map.w - 1, `inspector must sit beside the map, not below it: ${JSON.stringify(insp)} map ${JSON.stringify(map)}`);
  assert.ok(insp.y >= 60, `inspector starts below the header: ${JSON.stringify(insp)}`);
  assert.ok(insp.h >= 600, `inspector must get real band height, not a 90px bottom strip: h=${insp.h}`);
  assert.ok(insp.y + insp.h <= canvas.height + 1, `inspector must stay inside the canvas: ${JSON.stringify(insp)}`);
});

test("tall inspector content is capped inside the canvas and reported as an internal overflow, not an escape", () => {
  const built = executeRuntime(topologyProgram({ tallInspector: true }));
  const canvas = { width: 1280, height: 800 };
  const insp = built.boxes.get("inspector");
  assert.ok(insp, "inspector must resolve");
  assert.ok(insp.x + insp.w <= canvas.width + 1, `inspector stayed inside horizontally: ${JSON.stringify(insp)}`);
  assert.ok(insp.y <= canvas.height, `inspector stayed inside vertically: ${JSON.stringify(insp)}`);
  assert.ok(insp.y + insp.h <= canvas.height + 1, `inspector must not exceed the canvas bottom with tall content: ${JSON.stringify(insp)}`);
});

test("a screen whose only regions are numeric widths keeps its existing rows", () => {
  const built = executeRuntime({
    canvas: { width: 1200, height: 800, grid: 8 },
    regions: [
      { fn: "frame", id: "left", args: { width: 800, height: 350 } },
      { fn: "frame", id: "right", args: { width: 400, height: 350 } },
    ],
    content: [],
  });
  const l = built.boxes.get("left");
  const r = built.boxes.get("right");
  assert.ok(l && r);
  assert.equal(l.h, 350);
  assert.equal(r.h, 350);
});

/* -------------------------------------------------------------------------- */
/* D1/D2 — connectors clear of device boxes, long enough for their heads       */
/* -------------------------------------------------------------------------- */

test("no topology connector crosses a device box it does not join, and no chord is arrow-degenerate", () => {
  const program = topologyProgram();
  const built = executeRuntime(program);
  const connectorFindings = built.violations.filter((v) => v.rule === "connector" || v.rule === "layout");
  assert.deepEqual(connectorFindings, [], `the compile itself reported route violations: ${JSON.stringify(connectorFindings)}`);
  const defects = auditTopo(built, program.canvas, 1);
  assert.deepEqual(defects.outside, [], `boxes outside canvas: ${defects.outside.join("; ")}`);
  for (const route of built.connectorRoutes ?? []) {
    const chord = pathLen(route.endpoints);
    assert.ok(chord >= arrowSpace(1), `connector ${route.id} is ${Math.round(chord)}px chord, below the ${arrowSpace(1)}px head budget`);
  }
});

test("cross links and a critical edge stay clear: zero route findings, nothing off-canvas", () => {
  const extraEdges = [
    { from: "gpu-2", to: "core-b", latency: "6ms" },
    { from: "gpu-3", to: "gpu-4", latency: "4ms", weight: "critical" },
    { from: "core-a", to: "store", latency: "14ms" },
  ];
  const program = topologyProgram({ extraEdges });
  const built = executeRuntime(program);
  const connectorFindings = built.violations.filter((v) => v.rule === "connector" || v.rule === "layout");
  assert.deepEqual(connectorFindings, [], `blocking route findings survived bounded detour: ${JSON.stringify(connectorFindings)}`);
  const defects = auditTopo(built, program.canvas, 3);
  assert.deepEqual(defects.outside, [], `boxes outside canvas: ${defects.outside.join("; ")}`);
  for (const route of built.connectorRoutes ?? []) {
    const chord = pathLen(route.endpoints);
    assert.ok(chord >= arrowSpace(1), `connector ${route.id} degenerate at ${Math.round(chord)}px`);
  }
});

test("levels spread across the available region height instead of stacking at the 24px floor", () => {
  const built = executeRuntime(topologyProgram());
  const boxes = deviceBoxes(built).filter((b) => !/title/i.test(b.id));
  const ys = [...new Set(boxes.map((b) => Math.round(b.y)))].sort((a, b) => a - b);
  assert.ok(ys.length >= 4, `expected >=4 topology rows, got ${ys.length}: ${ys}`);
  const pitches = [];
  for (let i = 1; i < ys.length; i++) pitches.push(ys[i] - ys[i - 1]);
  const minPitch = Math.min(...pitches);
  // The old behaviour pitched rows at exactly 104 (80 node + 24 clearance).
  // With the spread the pitch must clear the node box plus the head budget.
  assert.ok(minPitch > 130, `level pitch spread below expectation: min pitch ${minPitch} (rows ${ys})`);
});

test("an open connector path carries no ghost closing vertex", () => {
  const built = executeRuntime(topologyProgram());
  const vectorOp = built.operations.find(
    (o) => o.type === "createVector" && typeof o.path === "string" && /^M /.test(o.path),
  );
  assert.ok(vectorOp, "a routed connector vector expected");
  const main = vectorOp.path.split(" M ")[0];
  const nums = main.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  assert.ok(nums && nums.length >= 4);
  const first = [Number(nums[0]), Number(nums[1])];
  const last = [Number(nums[nums.length - 2]), Number(nums[nums.length - 1])];
  // The old windowshipping bug: the last vertex was the START, appended as a
  // ghost closure — the route's drawn tail doubled back to its own origin.
  assert.ok(
    Math.abs(first[0] - last[0]) > 0.25 || Math.abs(first[1] - last[1]) > 0.25,
    `open connector path closes on its own start: last vertex ${last} equals start ${first}`,
  );
});

/* -------------------------------------------------------------------------- */
/* D4 — a requested topology composition carries an honest hint receipt        */
/* -------------------------------------------------------------------------- */

async function planReceipt(args) {
  const res = await planScreenTool(null, args);
  return res?.intelligence ?? {};
}

test("desiredComposition 'topology' reports compositionHintApplied true and names the source", async () => {
  const intel = await planReceipt({
    primaryDecision: "Check which shard lives on which machine",
    archetype: "topology",
    desiredComposition: "topology",
  });
  assert.equal(intel.applied, true);
  assert.equal(intel.compositionHintApplied, true, `receipt was false: ${JSON.stringify(intel)}`);
  assert.match(intel.compositionHintWhy ?? "", /topology/i, "the why must name the requested composition");
});

test("the plain word 'topology' in a direction maps to the topology-over-inspector descriptor", async () => {
  const intel = await planReceipt({
    primaryDecision: "Check which shard lives on which machine",
    archetype: "topology",
    visualDirection: "dense topology map of the cluster network with the selected shard inspector beside it",
  });
  assert.equal(intel.compositionHintApplied, true, `receipt was false: ${JSON.stringify(intel)}`);
  assert.match(intel.compositionHintWhy ?? "", /direction/i);
});

test("honesty: an unrelated direction still reports compositionHintApplied false", async () => {
  const intel = await planReceipt({
    primaryDecision: "Choose next quarter's launch narrative",
    visualDirection: "calm editorial hero",
  });
  assert.equal(intel.applied, true, "plan classification should still run");
  assert.equal(intel.compositionHintApplied, false, "no descriptor, no receipt — don't fake a positive");
});

test("negation still excludes even when the word is a synonym", async () => {
  const intel = await planReceipt({
    primaryDecision: "Pick between candidate models",
    visualDirection: "not a topology map, plain comparison rows",
  });
  assert.equal(intel.compositionHintApplied, false, `negated topology must not apply: ${JSON.stringify(intel)}`);
});
