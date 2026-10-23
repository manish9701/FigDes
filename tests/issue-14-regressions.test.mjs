/**
 * Regressions for the three defects the live render found on 16 Oct 2026.
 *
 * None of these was in an issue. All three were found by applying the stress
 * frame and looking at it, and the reviewer reported one finding across the
 * whole 57-node result — which is the reason two of these tests are about the
 * *reviewer* rather than the compiler.
 *
 * Two of the three were also misdiagnosed when first recorded, and the
 * corrections are part of what the tests lock down:
 *
 *   L05  Reported as "the active nav label takes the rail's colour". It took
 *        its own pill's colour — the same accent literal, typed twice.
 *   L06  Reported as a compiler bug in how `fill` measures from the left edge.
 *        The compiler is correct; the harness that produced the frame was not.
 *   L07  Reported as "the connector has no endpoints". It had endpoints and a
 *        real route; the route was 8px long and the arrowheads were longer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { routeConnector } from "../mcp-server/dist-test/runtime/connectors.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";
import { contrastRatio } from "../mcp-server/dist-test/shared/contrast.js";

const frame = (id, name, x, y, w, h, extra = {}) => ({
  id, type: "FRAME", name, parentId: "root", x, y, w, h, visible: true, ...extra,
});
const ROOT = { id: "root", type: "FRAME", name: "Screen", parentId: undefined, x: 0, y: 0, w: 1440, h: 900, visible: true };
const only = (nodes, rule) => runRules({ nodes }, "review").filter((f) => f.rule === rule);

/* -------------------------------------------------------------------------- */
/* L05 — an active nav label must read against its own pill                     */
/* -------------------------------------------------------------------------- */

const NAV_IR = {
  canvas: { name: "X", width: 1440, height: 900, grid: 8, newPage: false, deck: false },
  regions: [
    { id: "nav", role: "navigation", composition: "auto", layout: "flow", width: 220, height: "fill", grow: 0, elevation: 0, fill: "#111111", padding: 16, children: ["active", "idle"] },
  ],
  content: [
    { id: "active", kind: "component", type: "navItem", props: { label: "Overview", state: "active" } },
    { id: "idle", kind: "component", type: "navItem", props: { label: "Fleet" } },
  ],
  relations: [], tokens: [], links: [],
};

test("L05 — the active nav label is not drawn in its own pill's fill", () => {
  const ops = compileIR(NAV_IR).operations;
  const pill = ops.find((o) => o.type === "createFrame" && o.id === "active");
  const label = ops.find((o) => o.type === "createText" && o.parent === "active");
  const idle = ops.find((o) => o.type === "createText" && o.parent === "idle");

  assert.ok(pill && label, "the navItem emitter should produce a pill and a label");
  assert.notEqual(label.fill, pill.fill, "an active label drawn in its own pill's fill is invisible");

  // The measured requirement, not a "looks about right".
  const ratio = contrastRatio(label.fill, pill.fill);
  assert.ok(ratio !== null && ratio >= 4.5, `expected >= 4.5:1 on the pill, measured ${ratio}`);
});

test("L05 — the inactive nav label still follows the dark rail", () => {
  // The #14 fix for rail contrast must survive the L05 fix. The active item's
  // label follows the pill; an inactive one has no pill, so it follows the rail.
  const ops = compileIR(NAV_IR).operations;
  const idle = ops.find((o) => o.type === "createText" && o.parent === "idle");
  const ratio = contrastRatio(idle.fill, "#111111");
  assert.ok(ratio !== null && ratio >= 4.5, `expected >= 4.5:1 on the rail, measured ${ratio}`);
});

test("L05 — review reports a label drawn in its parent's own fill", () => {
  // The reviewer returning zero text-contrast findings on a 1.0:1 pair is the
  // more serious half of L05. `effectiveSurface` used to look only at siblings,
  // so a label sitting directly on its own painted parent found no backdrop and
  // fell through to compositing the ancestors — measuring against the rail
  // behind the pill instead of the pill itself.
  const nodes = [
    ROOT,
    frame("nav", "Nav", 0, 0, 220, 900, { fill: "#111111" }),
    { id: "pill", type: "FRAME", name: "Overview", parentId: "nav", x: 16, y: 16, w: 87, h: 36, visible: true, fill: "#F2C94C" },
    {
      id: "label", type: "TEXT", name: "Label", parentId: "pill",
      x: 28, y: 26, w: 63, h: 17, visible: true,
      text: { content: "Overview", color: "#F2C94C", size: 14, family: "Inter", style: "Semibold" },
    },
  ];
  const findings = only(nodes, "text-contrast");
  assert.equal(findings.length, 1, "a 1:1 pair must not be reported as clean");
  assert.equal(findings[0].severity, "critical");
});

test("L05 — review still reports contrast without a composited background", () => {
  // The rule used to return early when the client could not supply a
  // composited `background`, which threw away the parent fill that is still
  // measurable on its own.
  const nodes = [
    ROOT,
    frame("pill", "Overview", 16, 16, 87, 36, { fill: "#F2C94C" }),
    {
      id: "label", type: "TEXT", name: "Label", parentId: "pill",
      x: 28, y: 26, w: 63, h: 17, visible: true,
      text: { content: "Overview", color: "#F2C94C", size: 14, family: "Inter", style: "Semibold" },
    },
  ];
  assert.equal(only(nodes, "text-contrast").length, 1);
});

/* -------------------------------------------------------------------------- */
/* L06 — sibling regions must not cover each other                              */
/* -------------------------------------------------------------------------- */

/**
 * The full stress program from L04, which is what produced the live frame.
 * Compiling this is the control: if the compiler ever starts emitting the
 * overlapping geometry itself, this test is what notices.
 */
const STRESS_IR = {
  canvas: { name: "X", width: 1440, height: 900, grid: 8, newPage: false, deck: false },
  regions: [
    { id: "nav", role: "navigation", composition: "auto", layout: "flow", width: 220, height: "fill", grow: 0, elevation: 0, fill: "#111111", padding: 16, children: ["nav-label"] },
    { id: "header", role: "header", composition: "auto", layout: "flow", width: "fill", height: 72, grow: 0, elevation: 0, padding: 24, children: ["h-title"] },
    { id: "metrics", role: "secondary", composition: "auto", layout: "grid", columns: 4, width: "fill", height: "hug", grow: 0, elevation: 0, padding: 24, children: ["m0", "m1"] },
    { id: "topology", role: "primary-visual", composition: "topology", layout: "cluster", width: "fill", height: "fill", grow: 0, elevation: 0, padding: 24, children: ["n0", "n1"] },
    { id: "inspector", role: "inspector", composition: "auto", layout: "flow", width: 320, height: "fill", grow: 0, elevation: 0, padding: 24, children: ["i-title"] },
  ],
  content: [
    { id: "nav-label", kind: "text", text: "Fleet", role: "label" },
    { id: "h-title", kind: "text", text: "Fleet overview", role: "title" },
    { id: "m0", kind: "component", type: "metric", props: { label: "Online", value: "21 / 24" } },
    { id: "m1", kind: "component", type: "metric", props: { label: "Errors", value: "0.4%" } },
    { id: "n0", kind: "component", type: "deviceNode", props: { label: "mac-mini-01", health: "healthy", memory: "64 GB" } },
    { id: "n1", kind: "component", type: "deviceNode", props: { label: "mac-pro-02", health: "degraded", memory: "96 GB" } },
    { id: "i-title", kind: "text", text: "Diagnostics", role: "title" },
  ],
  relations: [
    { id: "header", width: "fill", right: 320 },
    { id: "metrics", width: "fill", right: 320 },
    { id: "topology", width: "fill", right: 320, height: "fill" },
    { id: "inspector", right: 0, top: 0, width: 320, height: "fill" },
  ],
  tokens: [], links: [],
};

const toMetrics = (out, ir) => {
  // The createFrame ops carry the shell's first guess at each region's size.
  // setPosition/setSize patch it afterwards, so reading the createFrame width
  // reports the pre-relation geometry and invents overlaps that are not there.
  const final = new Map();
  for (const o of out.operations) {
    if (o.type === "createFrame" && o.id !== "root") {
      final.set(o.id, { id: o.id, type: "FRAME", name: o.name, parentId: "root", x: o.x, y: o.y, w: o.width, h: o.height, visible: true });
    }
  }
  for (const o of out.operations) {
    if (o.type !== "setPosition" && o.type !== "setSize") continue;
    const box = final.get(o.target);
    if (!box) continue;
    if (o.type === "setPosition") {
      if (typeof o.x === "number") box.x = o.x;
      if (typeof o.y === "number") box.y = o.y;
    } else {
      if (typeof o.width === "number") box.w = o.width;
      if (typeof o.height === "number") box.h = o.h;
    }
  }
  // Content belongs to the region that declares it, not to the root. Parenting it
  // to the root makes a metric card and a nav rail look like siblings, which is
  // how this helper produced three phantom overlaps the first time.
  const home = new Map();
  for (const region of ir.regions) for (const child of region.children) home.set(child, region.id);
  for (const [id, box] of final) box.parentId = home.get(id) ?? "root";

  return [ROOT, ...final.values()];
};

test("L06 — the compiler lays the stress program out without overlapping regions", () => {
  // L06 was first recorded as a compiler bug: `fill` measures from wherever the
  // region sits, so a `fill` region and a 220px rail both resolve to x=0. That
  // was wrong. The compiler places topology clear of the rail, and the
  // overlapping frame came from a verification harness that recompiled the tail
  // operations from a reduced IR with the `nav` region missing.
  const out = compileIR(STRESS_IR);
  assert.deepEqual(out.violations, []);

  const nodes = toMetrics(out, STRESS_IR);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("nav").x, 0);
  assert.equal(byId.get("nav").w, 220);
  // The claim, stated as geometry rather than as an absence of complaints.
  assert.ok(byId.get("topology").x >= byId.get("nav").w, "topology must start clear of the rail");
  assert.equal(byId.get("topology").x + byId.get("topology").w, 1120, "topology must stop at the inspector");
  assert.equal(byId.get("inspector").x, 1120);

  const findings = only(nodes, "sibling-region-overlap");
  assert.equal(findings.length, 0, `unexpected overlap: ${findings.map((f) => f.title).join("; ")}`);
});

test("L06 — review reports sibling regions covering each other", () => {
  // The geometry that really was applied to the live frame, because the tail
  // operations were compiled from the reduced IR.
  const applied = [
    ROOT,
    frame("nav", "Nav", 0, 0, 220, 900, { fill: "#111111" }),
    frame("header", "Header", 0, 0, 1120, 129),
    frame("metrics", "Metrics", 0, 161, 1120, 138),
    frame("topology", "Topology", 0, 299, 1120, 601),
    frame("inspector", "Inspector", 1120, 0, 320, 900),
    { id: "n0", type: "FRAME", name: "mac-mini-01", parentId: "topology", x: 24, y: 112, w: 128, h: 80, visible: true },
  ];
  const findings = only(applied, "sibling-region-overlap");
  assert.ok(findings.length > 0, "a nav rail hidden under a 1120px region must be reported");
  const worst = findings.find((f) => f.title.includes("Nav") && f.title.includes("Topology"));
  assert.ok(worst, `expected the Nav/Topology occlusion, got: ${findings.map((f) => f.title).join("; ")}`);
  assert.equal(worst.severity, "serious");
  assert.ok(worst.evidence.overlapPx2 > 0 && worst.evidence.percentCovered > 0);
});

test("L06 — a backdrop painted first is not an overlap", () => {
  // The one legitimate version of this: a full-bleed surface the rest of the
  // screen sits on. Decided by paint order, not by geometry — and symmetrically,
  // so the same pair cannot pass or fail depending on which node the rule
  // happened to visit first.
  const backdropFirst = [ROOT, frame("surface", "Surface", 0, 0, 1440, 900), frame("panel", "Panel", 252, 0, 868, 601)];
  assert.equal(only(backdropFirst, "sibling-region-overlap").length, 0);

  // The same surface painted last really does hide everything under it.
  const backdropLast = [ROOT, frame("panel", "Panel", 252, 0, 868, 601), frame("surface", "Surface", 0, 0, 1440, 900)];
  assert.equal(only(backdropLast, "sibling-region-overlap").length, 1);
});

test("L06 — a card inside a panel is not a sibling overlap", () => {
  // Nesting is a parent/child relationship. Geometry containment alone must not
  // be mistaken for it, or every correct screen full of cards would fire.
  const nested = [
    ROOT,
    frame("topology", "Topology", 252, 331, 868, 569),
    { id: "card", type: "FRAME", name: "Card", parentId: "topology", x: 300, y: 400, w: 200, h: 120, visible: true },
  ];
  assert.equal(only(nested, "sibling-region-overlap").length, 0);
});

test("L06 — regions sharing an edge are not an overlap", () => {
  // Side-by-side panels touch by construction.
  const adjacent = [ROOT, frame("left", "Left", 0, 0, 600, 900), frame("right", "Right", 600, 0, 840, 900)];
  assert.equal(only(adjacent, "sibling-region-overlap").length, 0);
});

/* -------------------------------------------------------------------------- */
/* L07 — a connector between adjacent nodes is a line, not an arrowhead         */
/* -------------------------------------------------------------------------- */

const TOPO_IR = {
  canvas: { name: "X", width: 1440, height: 900, grid: 8, newPage: false, deck: false },
  regions: [
    { id: "topology", role: "primary-visual", composition: "topology", layout: "cluster", width: "fill", height: "fill", grow: 0, elevation: 0, padding: 24, children: ["n0", "n1", "n2"] },
  ],
  content: [
    { id: "n0", kind: "component", type: "deviceNode", props: { label: "mac-mini-01", health: "healthy", memory: "64 GB" } },
    { id: "n1", kind: "component", type: "deviceNode", props: { label: "mac-pro-02", health: "degraded", memory: "96 GB" } },
    { id: "n2", kind: "component", type: "deviceNode", props: { label: "rack-07", health: "healthy", memory: "512 GB" } },
    { id: "link-0", kind: "connector", from: "n0", to: "n1", routing: "orthogonal", strokeWeight: 1, arrowStart: false, arrowEnd: true, curvature: 0.2 },
  ],
  relations: [], tokens: [], links: [],
};

test("L07 — a connector between adjacent nodes is not swallowed by its arrowheads", () => {
  // Recorded first as "the connector has no endpoints". It had them, and the
  // route was real: a cluster stacked its nodes 8px apart, so the chord between
  // the two box edges is 8px while each arrowhead is 8px. The heads covered the
  // line completely and what reached Figma was a floating triangle.
  //
  // Superseded by the issue-24 clearance contract: device levels are now
  // pitched to clear the heaviest edge's arrowheads, so the layout no longer
  // produces the degenerate case this test froze. The degradation itself
  // (bare line + self-explaining name + advisory) is pinned at unit level in
  // issue-24-topology-quality ("a gap too short for heads stays a plain line
  // and says so") and end to end for explicit short connectors.
  const ops = compileIR(TOPO_IR).operations;
  const link = ops.find((o) => o.id === "link-0");
  assert.ok(link, "the connector should be emitted");

  const nodes = ops.filter((o) => o.type === "createFrame");
  const n0 = nodes.find((o) => o.id === "n0");
  const n1 = nodes.find((o) => o.id === "n1");
  // A cluster stacks its nodes, so the gap between the two facing edges is the
  // vertical one. Measuring the horizontal one reported 128px, which is the
  // node's own width — the assertion passed for the wrong reason until this.
  const gapX = Math.max(n0.x - (n1.x + n1.width), n1.x - (n0.x + n0.width), 0);
  const gapY = Math.max(n0.y - (n1.y + n1.height), n1.y - (n0.y + n0.height), 0);
  const chord = Math.max(gapX, gapY);
  assert.ok(chord >= 20, `levels must clear 1px arrowheads; got a ${chord}px gap`);

  // Heads fit, so the route keeps them: two subpaths, line plus triangle.
  const subpaths = link.path.match(/M/g) ?? [];
  assert.ok(subpaths.length > 1, `expected arrowheads on a cleared route, got: ${link.path}`);
  assert.ok(link.height >= chord - 1, "the line should still span the gap between the nodes");
});

test("L07 — a connector with room for arrowheads keeps them", () => {
  // The fix is conditional, and the condition has to be reachable in the other
  // direction or it is just "never draw arrowheads".
  const wide = {
    ...TOPO_IR,
    regions: [
      { ...TOPO_IR.regions[0], layout: "grid", columns: 2, children: ["n0", "n1", "n2"] },
    ],
  };
  const ops = compileIR(wide).operations;
  const link = ops.find((o) => o.id === "link-0");
  const subpaths = link.path.match(/M/g) ?? [];
  assert.ok(subpaths.length > 1, `expected an arrowhead on a long route, got: ${link.path}`);
});

test("L07 — a degenerate route explains itself in the layer name", () => {
  // "Why is this a bare line?" has to be answerable from the file, not from
  // whoever happened to be looking at it that afternoon.
  //
  // Pinned at unit level now: the cluster layout clears arrow space up front,
  // so the compile no longer produces this case. Two boxes 8px apart still
  // degrade to a bare line that owns the reason.
  const route = routeConnector(
    { id: "link-0", from: "n0", to: "n1", routing: "orthogonal" },
    { id: "n0", x: 0, y: 0, w: 128, h: 80 },
    { id: "n1", x: 0, y: 88, w: 128, h: 80 },
  );
  assert.ok(route, "adjacent nodes still route");
  assert.equal((route.path.match(/M/g) ?? []).length, 1, `expected a bare line, got: ${route.path}`);
  assert.match(route.summary, /arrowheads need|apart/);
  assert.equal(route.arrowheadsOmitted, true);
});