/**
 * Issue #24 follow-up: topology / connector quality.
 *
 * Labels avoid nodes and each other (free-side placement with lane
 * reservation), edges keep clearance from third-party nodes (fallback routing,
 * then an advisory warning that names the node), short gaps fall back to a
 * plain line with a warning instead of a floating triangle, connectors parent
 * to the stage that owns both endpoints, and vectors sit below labels in
 * z-order while staying kind-distinct from decoration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import {
  CONNECTOR_CLEARANCE_MIN,
  edgeClearanceViolations,
  labelBoxAt,
  labelTangent,
  pickLabelPosition,
  routeConnector,
} from "../mcp-server/dist-test/runtime/connectors.js";

/** Point-in-box with tolerance, matching the dispatch preflight's touch rule. */
function touches(p, box, eps = 2) {
  return (
    p.x >= box.x - eps &&
    p.x <= box.x + box.w + eps &&
    p.y >= box.y - eps &&
    p.y <= box.y + box.h + eps
  );
}

function labelOpBox(op) {
  return labelBoxAt(op.x, op.y, op.content);
}

/* -------------------------------------------------------------------------- */
/* Attached endpoints after reposition                                          */
/* -------------------------------------------------------------------------- */

test("endpoints stay attached to their nodes after a relation moves a region", () => {
  const result = executeRuntime({
    canvas: { name: "R", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "map", args: { width: 800, height: "fill" } },
      { fn: "frame", id: "side", args: { width: 320, height: 600 } },
    ],
    content: [
      { fn: "deviceNode", id: "d1", parent: "map", args: { label: "a" } },
      { fn: "deviceNode", id: "d2", parent: "side", args: { label: "b" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "d1", to: "d2", label: "sync" } },
    ],
    relations: [{ id: "side", rightOf: "map", gap: 24 }],
  });

  // The relation really moved the region: the endpoint proof is vacuous if
  // nothing moved.
  assert.ok(result.boxes.get("side").x > 800, "side must have moved right of map");
  assert.equal(result.violations.filter((v) => v.rule === "connector").length, 0);

  const route = result.connectorRoutes.find((r) => r.id === "c1");
  assert.ok(route, "the connector route must be reported");
  const from = result.boxes.get("d1");
  const to = result.boxes.get("d2");
  assert.ok(touches(route.endpoints[0], from), `start ${JSON.stringify(route.endpoints[0])} must touch d1`);
  assert.ok(touches(route.endpoints[1], to), `end ${JSON.stringify(route.endpoints[1])} must touch d2`);
});

/* -------------------------------------------------------------------------- */
/* Label placement: free side + lane reservation                               */
/* -------------------------------------------------------------------------- */

test("pickLabelPosition routes around a node covering the preferred side", () => {
  const anchor = { x: 100, y: 100 };
  const tangent = { x: 1, y: 0 };
  // A node sitting exactly where the above-first candidate would land.
  const first = labelBoxAt(100 + 6, 100 - 10 - 20, "link");
  const obstacles = [{ x: first.x - 2, y: first.y - 2, w: first.w + 4, h: first.h + 4 }];
  const at = pickLabelPosition(anchor, tangent, "link", obstacles, []);
  const box = labelBoxAt(at.x, at.y, "link");
  const hit = obstacles.some(
    (o) => box.x < o.x + o.w && box.x + box.w > o.x && box.y < o.y + o.h && box.y + box.h > o.y,
  );
  assert.equal(hit, false, `placed label ${JSON.stringify(box)} must clear the node`);
  // Deterministic: the same inputs always pick the same side.
  assert.deepEqual(pickLabelPosition(anchor, tangent, "link", obstacles, []), at);
});

test("labels prefer the side above the edge", () => {
  const at = pickLabelPosition({ x: 100, y: 100 }, { x: 1, y: 0 }, "link", [], []);
  assert.ok(at.y < 100, `label ${JSON.stringify(at)} must sit above the anchor`);
});

test("two edges sharing a midpoint do not stack their captions", () => {
  // Cross-region pair: the midpoint sits mid-canvas with room around it, so a
  // free lane exists and the reservation has to find it. (An 8px stacked gap
  // physically cannot host two 14px captions — that case warns on clearance
  // instead, and is covered above.)
  const result = executeRuntime({
    canvas: { name: "R", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "map", args: { width: 800, height: "fill" } },
      { fn: "frame", id: "side", args: { width: 320, height: 600 } },
    ],
    content: [
      { fn: "deviceNode", id: "d1", parent: "map", args: { label: "a" } },
      { fn: "deviceNode", id: "d2", parent: "side", args: { label: "b" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "d1", to: "d2", label: "forward" } },
      { fn: "connector", id: "c2", parent: "map", args: { from: "d2", to: "d1", label: "back" } },
    ],
    relations: [{ id: "side", rightOf: "map", gap: 24 }],
  });

  const labels = result.operations.filter((o) => o.type === "createText" && /^(forward|back)$/.test(o.content ?? ""));
  assert.equal(labels.length, 2, "both captions must be emitted");
  const boxes = labels.map(labelOpBox);
  const stacked =
    boxes[0].x < boxes[1].x + boxes[1].w &&
    boxes[0].x + boxes[0].w > boxes[1].x &&
    boxes[0].y < boxes[1].y + boxes[1].h &&
    boxes[0].y + boxes[0].h > boxes[1].y;
  assert.equal(stacked, false, `reserved lanes must not overlap: ${JSON.stringify(boxes)}`);
});

test("an emitted label clears the nodes it sits between", () => {
  const result = executeRuntime({
    canvas: { name: "R", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "map", args: { width: 800, height: "fill" } },
      { fn: "frame", id: "side", args: { width: 320, height: 600 } },
    ],
    content: [
      { fn: "deviceNode", id: "d1", parent: "map", args: { label: "a" } },
      { fn: "deviceNode", id: "d2", parent: "side", args: { label: "b" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "d1", to: "d2", label: "sync" } },
    ],
    relations: [{ id: "side", rightOf: "map", gap: 24 }],
  });

  const label = result.operations.find((o) => o.id === "c1-label");
  assert.ok(label, "the caption must be emitted");
  const box = labelOpBox(label);
  for (const id of ["d1", "d2"]) {
    const node = result.boxes.get(id);
    const hit =
      box.x < node.x + node.w && box.x + box.w > node.x && box.y < node.y + node.h && box.y + box.h > node.y;
    assert.equal(hit, false, `caption must not sit on '${id}'`);
  }
});

/* -------------------------------------------------------------------------- */
/* Clearance: reroute, then name the node                                      */
/* -------------------------------------------------------------------------- */

test("edgeClearanceViolations names a node the edge passes over", () => {
  const boxes = new Map([
    ["a", { x: 0, y: 0, w: 100, h: 100 }],
    ["mid", { x: 200, y: -50, w: 100, h: 100 }],
    ["b", { x: 400, y: 0, w: 100, h: 100 }],
  ]);
  const hit = edgeClearanceViolations(
    [
      { x: 100, y: 50 },
      { x: 400, y: 50 },
    ],
    boxes,
    "a",
    "b",
  );
  assert.deepEqual(hit, ["mid"]);
  // Endpoints are allowed to touch their own nodes: with only the two endpoint
  // boxes present, the same route is clean.
  assert.deepEqual(
    edgeClearanceViolations(
      [
        { x: 100, y: 50 },
        { x: 400, y: 50 },
      ],
      new Map([
        ["a", { x: 0, y: 0, w: 100, h: 100 }],
        ["b", { x: 400, y: 0, w: 100, h: 100 }],
      ]),
      "a",
      "b",
    ),
    [],
  );
});

test("a blocked edge warns and names the node instead of failing the build", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1200, height: 800, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "deviceNode", id: "d1", parent: "map", args: { label: "a" } },
      { fn: "deviceNode", id: "blocker", parent: "map", args: { label: "mid" } },
      { fn: "deviceNode", id: "d2", parent: "map", args: { label: "b" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "d1", to: "d2", label: "link" } },
    ],
  });

  const warning = result.violations.find((v) => v.rule === "layout" && /passes within/.test(v.message));
  assert.ok(warning, "a blocked edge must produce a clearance warning");
  assert.ok(/'blocker'/.test(warning.message), `warning must name the node: ${warning.message}`);
  assert.equal(/'map'/.test(warning.message), false, "the owning region is never an offender");
  assert.ok(warning.message.includes(String(CONNECTOR_CLEARANCE_MIN)), "warning states the clearance");
  assert.equal(result.applicable, true, "clearance is advisory, never blocking");
});

/* -------------------------------------------------------------------------- */
/* Arrow fallback: plain line + warning, never a silent triangle loss          */
/* -------------------------------------------------------------------------- */

test("a gap too short for heads stays a plain line and says so", () => {
  const route = routeConnector(
    { id: "c1", from: "a", to: "b" },
    { x: 0, y: 0, w: 128, h: 80 },
    { x: 0, y: 88, w: 128, h: 80 },
  );
  assert.ok(route, "adjacent nodes still route");
  assert.equal(route.arrowheadsOmitted, true, "heads wanted but not fittable");
  assert.equal((route.path.match(/M /g) ?? []).length, 1, "one subpath: the line, no triangle");
  assert.equal(/Z/.test(route.path), false, "no closed head subpath");
  assert.ok(/without one/.test(route.summary), "the summary owns the plain line");
});

test("the short-gap fallback is surfaced as an advisory warning end to end", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1200, height: 800, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "deviceNode", id: "d1", parent: "map", args: { label: "a" } },
      { fn: "deviceNode", id: "d2", parent: "map", args: { label: "b" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "d1", to: "d2" } },
    ],
  });
  const warning = result.violations.find((v) => v.rule === "layout" && /plain line/.test(v.message));
  assert.ok(warning, "the plain-line fallback must be visible, not silent");
  assert.equal(result.applicable, true, "a short gap is advisory, never blocking");
});

test("an explicitly plain edge owns its style with no warning", () => {
  const route = routeConnector(
    { id: "c1", from: "a", to: "b", arrowEnd: false },
    { x: 0, y: 0, w: 128, h: 80 },
    { x: 0, y: 88, w: 128, h: 80 },
  );
  assert.equal(route.arrowheadsOmitted, false, "nothing was wanted, nothing was lost");
});

/* -------------------------------------------------------------------------- */
/* Parenting: child of the stage that owns both endpoints                      */
/* -------------------------------------------------------------------------- */

test("a single-region connector is a child of the stage, with parent-local geometry", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1200, height: 800, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "deviceNode", id: "d1", parent: "map", args: { label: "a" } },
      { fn: "deviceNode", id: "d2", parent: "map", args: { label: "b" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "d1", to: "d2", label: "8 us" } },
    ],
  });

  const vector = result.operations.find((o) => o.type === "createVector" && o.id === "c1");
  const label = result.operations.find((o) => o.id === "c1-label");
  assert.equal(vector.parent, "map", "the edge must live with its endpoints");
  assert.equal(label.parent, "map", "the caption must live with its edge");
  // Parent-local: adding the stage origin must recover the reported route.
  const stage = result.boxes.get("map");
  const route = result.connectorRoutes.find((r) => r.id === "c1");
  const opCX = vector.x + vector.width / 2 + stage.x;
  const routeCX = (route.endpoints[0].x + route.endpoints[1].x) / 2;
  assert.ok(Math.abs(opCX - routeCX) < vector.width / 2 + 1, "vector geometry must agree with the route");
});

test("a cross-region connector stays at the root instead of picking a side", () => {
  const result = executeRuntime({
    canvas: { name: "R", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "map", args: { width: 800, height: "fill" } },
      { fn: "frame", id: "side", args: { width: 320, height: 600 } },
    ],
    content: [
      { fn: "deviceNode", id: "d1", parent: "map", args: { label: "a" } },
      { fn: "deviceNode", id: "d2", parent: "side", args: { label: "b" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "d1", to: "d2" } },
    ],
    relations: [{ id: "side", rightOf: "map", gap: 24 }],
  });
  assert.equal(result.operations.find((o) => o.id === "c1").parent, "root");
});

/* -------------------------------------------------------------------------- */
/* Z-order: edges below captions, edges distinct from decoration               */
/* -------------------------------------------------------------------------- */

test("vectors emit below their captions and read as edges, not decoration", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1200, height: 800, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "deviceNode", id: "d1", parent: "map", args: { label: "a" } },
      { fn: "deviceNode", id: "d2", parent: "map", args: { label: "b" } },
      { fn: "shape", id: "deco", parent: "map", args: { shape: "ellipse", fill: "#EEEEEE" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "d1", to: "d2", label: "8 us" } },
    ],
  });

  const order = result.operations.map((o) => o.id ?? o.target);
  const vectorAt = order.indexOf("c1");
  const labelAt = order.indexOf("c1-label");
  assert.ok(vectorAt !== -1 && labelAt !== -1, "both the edge and its caption must exist");
  assert.ok(vectorAt < labelAt, "the caption paints above its line");

  const vector = result.operations[vectorAt];
  assert.equal(vector.fillArrows, true, "a headed edge carries its head as fill");
  assert.ok(/connector d1 -> d2/.test(vector.name), `the edge names itself: ${vector.name}`);

  const deco = result.operations.find((o) => o.id === "deco");
  assert.ok(deco, "decoration must still emit");
  assert.equal(deco.fillArrows ?? false, false, "decoration must never read as an edge");
});

test("labelTangents follow the middle segment of a Z route", () => {
  const t = labelTangent([
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 100 },
    { x: 100, y: 100 },
  ]);
  assert.ok(Math.abs(t.x) < 1e-6 && t.y !== 0, `middle segment is vertical: ${JSON.stringify(t)}`);
});
