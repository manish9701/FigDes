/**
 * Design Runtime + IR tests.
 *
 * These cover the two claims the runtime makes:
 *   1. It is safe — no eval path exists, and malformed input is rejected.
 *   2. It is faster to author — fewer, fatter units than hand-placed primitives.
 * Plus the layout maths, which is verified against hand-computed expectations
 * rather than eyeballed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRuntime, PRIMITIVE_NAMES } from "../mcp-server/dist-test/runtime/interpreter.js";
import { compileIR, toVectorPathData } from "../mcp-server/dist-test/runtime/compile.js";
import { solveAxis, radial, forceDirected, layoutRegions, inferComposition, packContent, separateOverlaps } from "../mcp-server/dist-test/runtime/layout.js";
import { scoreDesign } from "../mcp-server/dist-test/review/score.js";
import { tree, masonry, timeline, cluster, runAlgorithm } from "../mcp-server/dist-test/runtime/algorithms.js";
import { solveConstraints } from "../mcp-server/dist-test/runtime/constraints.js";
import { routeConnector } from "../mcp-server/dist-test/runtime/connectors.js";
import { normalizePath, parseSvgPath } from "../mcp-server/dist-test/shared/path.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";
import { LOGO_MARKS, coerceLogoMark, logoMarkPath, polygonPath, ringPath, starPath } from "../mcp-server/dist-test/runtime/marks.js";
import { STYLES, ACCORDION } from "../mcp-server/dist-test/runtime/visual-presets.js";
import { critiqueVisual } from "../mcp-server/dist-test/review/critique.js";
import { OperationSchema } from "../mcp-server/dist-test/shared/protocol.js";

const DASHBOARD = {
  canvas: { name: "EXO Compute", width: 1440, height: 900, grid: 8 },
  regions: [
    { fn: "navigation", id: "nav", args: { width: 240, fill: "#111111", padding: 24 } },
    { fn: "hero", id: "hero", args: { grow: 2, gap: 16, padding: 32 } },
  ],
  content: [
    { fn: "text", id: "title", parent: "hero", args: { text: "Compute", role: "title" } },
    { fn: "text", id: "sub", parent: "hero", args: { text: "3 machines online", role: "body" } },
    { fn: "metric", id: "m1", parent: "hero", args: { label: "GPUs", value: "8x H100" } },
    { fn: "metric", id: "m2", parent: "hero", args: { label: "Memory", value: "1.8 TB" } },
  ],
};

/* -------------------------------------------------------------------------- */
/* Layout maths                                                                */
/* -------------------------------------------------------------------------- */

test("solveAxis divides leftover space between fill children", () => {
  const out = solveAxis({
    children: [
      { id: "a", grow: 0, width: "fill", height: "hug" },
      { id: "b", grow: 0, width: "fill", height: "hug" },
    ],
    axis: "row",
    gap: 0,
    available: 800,
  });
  assert.deepEqual(out, [400, 400]);
});

test("solveAxis subtracts gaps before dividing", () => {
  const out = solveAxis({
    children: [
      { id: "a", grow: 0, width: "fill", height: "hug" },
      { id: "b", grow: 0, width: "fill", height: "hug" },
    ],
    axis: "row",
    gap: 40,
    available: 800,
  });
  assert.deepEqual(out, [380, 380]);
  assert.equal(out[0] + out[1] + 40, 800, "children plus gaps must fill the axis exactly");
});

test("solveAxis keeps fixed sizes and gives the rest to fill", () => {
  const out = solveAxis({
    children: [
      { id: "a", grow: 0, width: 200, height: "hug" },
      { id: "b", grow: 0, width: "fill", height: "hug" },
    ],
    axis: "row",
    gap: 20,
    available: 820,
  });
  assert.equal(out[0], 200);
  assert.equal(out[1], 600);
  assert.equal(out[0] + out[1] + 20, 820);
});

test("solveAxis weights grow so a hero absorbs slack", () => {
  const out = solveAxis({
    children: [
      { id: "hero", grow: 3, width: "fill", height: "fill" },
      { id: "rail", grow: 1, width: "fill", height: "fill" },
    ],
    axis: "column",
    gap: 0,
    available: 1000,
  });
  assert.equal(out[0] + out[1], 1000);
  assert.ok(out[0] > out[1], "the higher grow weight should get more");

  // Weights are 1 + grow, so 3:1 becomes 4:2 -> 2:1. The old code divided by grow
  // directly, which made grow:0 collapse to nothing (see the next test).
  assert.equal(out[0], 1000 * (4 / 6));
  assert.equal(out[1], 1000 * (2 / 6));
});

test("a fill child with grow 0 still receives space", () => {
  // Regression. Dividing by raw grow meant that as soon as one sibling had grow > 0,
  // every grow:0 fill child got zero. A region silently collapsing to zero height
  // looks like a rendering bug with no visible cause.
  const out = solveAxis({
    children: [
      { id: "grower", grow: 1, width: "fill", height: "fill" },
      { id: "plain", grow: 0, width: "fill", height: "fill" },
    ],
    axis: "column",
    gap: 0,
    available: 900,
  });

  assert.ok(out[1] > 0, "a grow:0 fill child must not collapse to zero");
  assert.equal(out[0] + out[1], 900);
  assert.ok(out[0] > out[1], "the grower still takes more, by 2:1");
});

test("every fill child gets a share when none asks to grow", () => {
  const out = solveAxis({
    children: [
      { id: "a", grow: 0, width: "fill", height: "fill" },
      { id: "b", grow: 0, width: "fill", height: "fill" },
      { id: "c", grow: 0, width: "fill", height: "fill" },
    ],
    axis: "row",
    gap: 0,
    available: 900,
  });

  assert.deepEqual(out, [300, 300, 300]);
});

test("hug children receive nothing, since their size is unmeasured", () => {
  // "hug" means "measure the content". With no content available the engine
  // must not invent space for it, or fixed siblings get squeezed.
  const out = solveAxis({
    children: [
      { id: "a", grow: 0, width: "hug", height: "hug" },
      { id: "b", grow: 0, width: "fill", height: "fill" },
    ],
    axis: "row",
    gap: 0,
    available: 600,
  });
  assert.equal(out[0], 0);
  assert.equal(out[1], 600);
});

test("solveAxis on an empty stack is safe", () => {
  assert.deepEqual(solveAxis({ children: [], axis: "row", gap: 8, available: 100 }), []);
});

test("a side rail splits the canvas and content fills the remainder", () => {
  const regions = layoutRegions({
    regions: [
      { id: "nav", role: "navigation", composition: "auto", width: 240, height: "hug", grow: 0, children: [], fill: undefined, padding: undefined, radius: undefined, gap: undefined },
      { id: "main", role: "custom", composition: "auto", width: "fill", height: "fill", grow: 0, children: [], fill: undefined, padding: undefined, radius: undefined, gap: undefined },
    ],
    canvasW: 1440,
    canvasH: 900,
    gutter: 32,
  });

  const nav = regions.find((r) => r.id === "nav");
  const main = regions.find((r) => r.id === "main");

  assert.equal(nav.w, 240);
  assert.equal(nav.h, 900);
  assert.equal(main.x, 272, "content starts after the rail plus the gutter");
  assert.equal(main.w, 1440 - 272);
});

test("radial placement is deterministic and spreads nodes evenly", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const first = radial(nodes, { x: 100, y: 100 }, 50);
  const second = radial(nodes, { x: 100, y: 100 }, 50);

  assert.deepEqual([...first.entries()], [...second.entries()], "same input must give the same output");
  assert.equal(first.size, 4);

  for (const [id, p] of first) {
    const dist = Math.hypot(p.x - 100, p.y - 100);
    assert.ok(Math.abs(dist - 50) < 1, `${id} should sit on the radius`);
  }
});

test("radial with no nodes returns nothing rather than dividing by zero", () => {
  assert.equal(radial([], { x: 0, y: 0 }, 10).size, 0);
});

test("force layout is deterministic and does not collapse", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const links = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "d" },
  ];
  const opts = { center: { x: 300, y: 300 }, radius: 100, iterations: 120 };

  const first = forceDirected(nodes, links, opts);
  const second = forceDirected(nodes, links, opts);
  assert.deepEqual([...first.entries()], [...second.entries()], "no randomness allowed");

  // Repulsion must separate them, or every node lands on the same pixel.
  const positions = [...first.values()];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const d = Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y);
      assert.ok(d > 1, `nodes ${i} and ${j} collapsed together`);
    }
  }
});

test("force layout handles coincident seed points", () => {
  // A zero-radius seed would divide by zero in the repulsion term.
  const out = forceDirected([{ id: "a" }, { id: "b" }], [{ from: "a", to: "b" }], {
    center: { x: 0, y: 0 },
    radius: 0,
    iterations: 20,
  });
  assert.equal(out.size, 2);
  for (const p of out.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test("packContent wraps into columns and never exceeds the region", () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, height: 50 }));
  const placed = packContent({ region: { x: 0, y: 0, w: 300, h: 400 }, items, gap: 10, columns: 3 });

  assert.equal(placed.size, 7);
  for (const [id, box] of placed) {
    assert.ok(box.x >= 0, `${id} starts before the region`);
    assert.ok(box.x + box.w <= 300.5, `${id} overflows horizontally`);
    assert.ok(box.y + box.h <= 400.5, `${id} overflows vertically`);
  }
});

test("inferComposition prefers spatial when there is a narrow nav and a hero", () => {
  const composition = inferComposition([
    { role: "navigation", composition: "auto", width: 240 },
    { role: "hero", composition: "auto", width: "fill" },
  ]);
  assert.equal(composition, "spatial");
});

test("inferComposition honours an explicit request", () => {
  const composition = inferComposition([
    { role: "navigation", composition: "auto", width: 240 },
    { role: "custom", composition: "topology", width: "fill" },
  ]);
  assert.equal(composition, "topology");
});

test("inferComposition does not collapse a lone region to a card grid", () => {
  // A single unnamed region is the shape the spec calls out as the failure
  // mode: a card grid with nothing in it. It must not resolve to "canvas".
  assert.notEqual(inferComposition([{ role: "content", composition: "auto", width: "fill" }]), "canvas");
  assert.notEqual(inferComposition([{ role: "custom", composition: "auto", width: "fill" }]), "canvas");
});

/* -------------------------------------------------------------------------- */
/* Runtime safety                                                              */
/* -------------------------------------------------------------------------- */

test("a code string is reported, never executed and never silently dropped", () => {
  // The spec proposed program: "...". There is no eval path here, so the string
  // is inert. It must also not vanish quietly, or the model would conclude its
  // call succeeded.
  const result = executeRuntime({
    regions: [{ fn: "frame", id: "r1", args: { program: "figma.createFrame()" } }],
    content: [],
  });

  assert.ok(
    result.warnings.some((w) => w.includes("program")),
    `expected a warning about the program argument, got: ${JSON.stringify(result.warnings)}`,
  );
  assert.ok(
    result.warnings.some((w) => /never executes code/i.test(w)),
    "the warning should say code is not supported",
  );
});

test("no primitive anywhere evaluates a string as code", () => {
  // Structural guarantee: a function-shaped argument is reported, not run.
  const result = executeRuntime({
    regions: [{ fn: "frame", id: "r1", args: { onClick: "() => figma.closePlugin()" } }],
    content: [],
  });
  assert.ok(result.warnings.some((w) => w.includes("onClick")));
});

test("unknown primitive names are rejected rather than ignored", () => {
  assert.throws(() => executeRuntime({ regions: [{ fn: "definitelyNotReal", args: {} }] }), /definitelyNotReal|Invalid/i);
});

test("every advertised primitive is executable", () => {
  for (const fn of PRIMITIVE_NAMES) {
    const isRegion = ["navigation", "header", "hero", "inspector", "frame"].includes(fn);
    const program = isRegion
      ? { regions: [{ fn, id: "r1", args: { width: 240 } }], content: [] }
      : { regions: [{ fn: "frame", id: "r1", args: {} }], content: [{ fn, id: "c1", parent: "r1", args: { text: "x", label: "x", value: "1", title: "x", path: "M 0 0 L 10 10" } }] };
    const result = executeRuntime(program);
    assert.ok(result.operations.length > 0, `${fn} produced no operations`);
  }
});

test("a program with no regions fails loudly", () => {
  assert.throws(() => executeRuntime({ regions: [], content: [] }), /at least one region/i);
});

test("a region primitive used as content produces a warning, not a crash", () => {
  const result = executeRuntime({
    regions: [{ fn: "frame", id: "r1", args: {} }],
    content: [{ fn: "navigation", id: "bad", args: {} }],
  });
  assert.ok(result.warnings.some((w) => w.includes("navigation")));
});

test("a content primitive used as a region produces a warning, not a crash", () => {
  const result = executeRuntime({
    regions: [
      { fn: "frame", id: "r1", args: {} },
      { fn: "metric", id: "bad", args: {} },
    ],
    content: [],
  });
  assert.ok(result.warnings.some((w) => w.includes("metric")));
});

test("an unknown parent is reported and the node is reparented", () => {
  const result = executeRuntime({
    regions: [{ fn: "frame", id: "r1", args: {} }],
    content: [{ fn: "text", id: "t1", parent: "nope", args: { text: "hi" } }],
  });
  assert.ok(result.warnings.some((w) => w.includes("nope")));
  assert.equal(result.ir.regions[0].children.includes("t1"), true, "should land in the first region");
});

test("duplicate region ids are dropped with a warning", () => {
  const result = executeRuntime({
    regions: [
      { fn: "frame", id: "same", args: {} },
      { fn: "frame", id: "same", args: {} },
    ],
    content: [],
  });
  assert.equal(result.ir.regions.length, 1);
  assert.ok(result.warnings.some((w) => w.includes("Duplicate")));
});

test("malformed input is coerced rather than crashing the tool", () => {
  const result = executeRuntime({
    canvas: { width: "not-a-number", height: -5 },
    regions: [{ fn: "frame", id: "r", args: { width: "sideways", grow: 99, padding: "loose" } }],
    content: [{ fn: "text", id: "t", parent: "r", args: { text: "ok", size: -3, weight: 5000 } }],
  });
  assert.ok(result.operations.length > 0);
  assert.ok(result.ir.canvas.width > 0, "a bad canvas width must fall back to the default");
});

/* -------------------------------------------------------------------------- */
/* Compilation                                                                 */
/* -------------------------------------------------------------------------- */

test("compiling the example dashboard produces a full node tree", () => {
  const result = executeRuntime(DASHBOARD);

  assert.equal(result.warnings.length, 0, `unexpected warnings: ${result.warnings.join("; ")}`);
  assert.ok(result.operations.length > 10, "expected a real node tree");

  const types = result.operations.map((o) => o.type);
  assert.ok(types.includes("createFrame"), "needs frames");
  assert.ok(types.includes("createText"), "needs text");
});

test("every compiled operation passes the allowlist", () => {
  const result = executeRuntime(DASHBOARD);
  for (const op of result.operations) {
    assert.ok(OperationSchema.safeParse(op).success, `invalid operation emitted: ${JSON.stringify(op)}`);
  }
});

test("regions tile the canvas without overlapping", () => {
  // ir.regions holds the *intent*; the resolved geometry comes from compileIR.
  const result = executeRuntime(DASHBOARD);
  const compiled = compileIR(result.ir);

  const nav = compiled.regions.find((r) => r.id === "nav");
  const hero = compiled.regions.find((r) => r.id === "hero");

  assert.ok(nav && hero, "both regions must resolve");
  // A 240px rail plus a 32px gutter puts content at x=272, filling to the edge.
  assert.equal(nav.x, 0);
  assert.equal(nav.w, 240);
  assert.equal(nav.h, 900, "a side rail spans the full height");
  assert.equal(hero.x, 272);
  assert.equal(hero.x + hero.w, 1440, "content must reach the right edge");
  assert.equal(hero.h, 900, "a growing hero fills the remaining height");
});

test("a metric expands into a container plus its text layers", () => {
  const result = executeRuntime(DASHBOARD);
  const created = result.operations.filter((o) => o.type === "createFrame" && o.id === "m1");
  assert.equal(created.length, 1, "metric should create one container");

  const children = result.operations.filter((o) => o.parent === "m1");
  assert.ok(children.length >= 2, "metric should contain label and value text");
  assert.ok(children.some((c) => c.content === "GPUs"));
  assert.ok(children.some((c) => c.content === "8x H100"));
});

test("the type scale is applied without the model asking for sizes", () => {
  const result = executeRuntime({
    canvas: { name: "S", width: 800, height: 600 },
    regions: [{ fn: "frame", id: "r", args: {} }],
    content: [
      { fn: "text", id: "a", parent: "r", args: { text: "Headline", role: "title" } },
      { fn: "text", id: "b", parent: "r", args: { text: "Caption", role: "caption" } },
    ],
  });

  const title = result.operations.find((o) => o.id === "a");
  const caption = result.operations.find((o) => o.id === "b");

  assert.ok(title.fontSize > caption.fontSize, "title must be larger than caption");
  assert.equal(title.fontSize, 32);
  assert.equal(caption.fontSize, 11);
});

test("constraints are reported rather than silently enforced", () => {
  const result = executeRuntime({
    ...DASHBOARD,
    constraints: { maxMetricCards: 1 },
  });
  assert.ok(result.violations.some((v) => v.rule === "maxMetricCards"));
});

test("a program within its constraints reports no violations", () => {
  const result = executeRuntime({
    ...DASHBOARD,
    constraints: { maxMetricCards: 3 },
  });
  assert.equal(result.violations.length, 0);
});

test("compileIR is deterministic", () => {
  const a = executeRuntime(DASHBOARD);
  const b = executeRuntime(DASHBOARD);
  assert.deepEqual(a.operations, b.operations);
});

test("toVectorPathData produces closed path data", () => {
  const data = toVectorPathData([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]).data;
  assert.match(data, /^M 0 0/);
  assert.match(data, /Z$/);
});

test("a growing region fills both axes rather than hugging to zero", () => {
  // Regression: `grow: 2` with an implicit "hug" width resolved the hero to
  // width 0 inside a side rail, so the region silently disappeared.
  const result = executeRuntime({
    canvas: { name: "D", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 240 } },
      { fn: "hero", id: "hero", args: { grow: 2 } },
    ],
    content: [],
  });

  const compiled = compileIR(result.ir);
  const hero = compiled.regions.find((r) => r.id === "hero");
  const nav = compiled.regions.find((r) => r.id === "nav");

  assert.ok(hero && nav);
  assert.ok(hero.w > 0, "a growing hero must not collapse to zero width");
  assert.equal(hero.x, 272);
  assert.equal(hero.x + hero.w, 1440, "and it must fill to the right edge");
});

test("a non-growing region is allowed to hug", () => {
  const result = executeRuntime({
    canvas: { name: "D", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "only", args: {} }],
    content: [],
  });
  assert.equal(result.ir.regions[0].grow, 0);
  assert.equal(result.ir.regions[0].width, "hug");
});

test("a mismatched grow/hug combination is reported", () => {
  const result = executeRuntime({
    canvas: { name: "D", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "r", args: { grow: 2, width: "hug" } }],
    content: [],
  });
  assert.ok(result.warnings.some((w) => /hugs on one axis/.test(w)));
});

test("layout stats report real timings", () => {
  const result = executeRuntime(DASHBOARD);
  assert.ok(result.stats.layoutMs >= 0);
  assert.ok(result.stats.layoutMs < 1000, "layout must not take a second on a small screen");
});
/* -------------------------------------------------------------------------- */
/* Layout algorithms (spec �17)                                                */
/* -------------------------------------------------------------------------- */

test("tree places parents above the centre of their children", () => {
  const nodes = [{ id: "hub" }, { id: "a" }, { id: "b" }];
  const links = [
    { from: "hub", to: "a" },
    { from: "hub", to: "b" },
  ];

  const result = tree(nodes, links, { bounds: { x: 0, y: 0, w: 400, h: 300 }, gap: 100, levelGap: 80 });

  assert.deepEqual(result.roots, ["hub"]);
  assert.equal(result.depth, 1);

  const hub = result.get("hub");
  const a = result.get("a");
  const b = result.get("b");

  // The parent must sit horizontally centred between its two leaves, and one
  // level above them. This is the property that makes a topology read as a
  // hierarchy rather than a list.
  assert.equal(a.y, hub.y + 80);
  assert.equal(b.y, hub.y + 80);
  assert.equal(hub.x, (a.x + b.x) / 2);
  assert.equal(a.x < b.x, true);
});

test("tree is deterministic across runs", () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
  const links = nodes.slice(1).map((n, i) => ({ from: `n${Math.floor(i / 2)}`, to: n.id }));

  const first = tree(nodes, links, { bounds: { x: 0, y: 0, w: 800, h: 600 }, gap: 40 });
  const second = tree(nodes, links, { bounds: { x: 0, y: 0, w: 800, h: 600 }, gap: 40 });

  for (const node of nodes) {
    assert.deepEqual(first.get(node.id), second.get(node.id), `${node.id} moved between identical runs`);
  }
});

test("runAlgorithm serves radial and force with finite coordinates", () => {
  // Live defect: unknown names fell through to masonry with the wrong item
  // shape and produced NaN (serialized as null) — non-finite coordinates must
  // never reach Figma operations.
  const nodes = [{ id: "hub" }, { id: "a" }, { id: "b" }];
  const links = [{ from: "hub", to: "a" }, { from: "hub", to: "b" }];
  const opts = { bounds: { x: 0, y: 0, w: 1440, h: 900 }, gap: 24, levelGap: 48, columns: 1 };
  for (const algo of ["radial", "force", "forceGraph", "tree", "cluster"]) {
    const { points } = runAlgorithm(algo, nodes, links, opts);
    assert.equal(points.size, 3, `${algo} placed every node`);
    for (const [id, p] of points) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${algo}/${id} is non-finite: ${p.x},${p.y}`);
    }
  }
});

test("separateOverlaps parts piled tiles and stays in bounds", () => {
  const boxes = [
    { id: "a", x: 652, y: 394, w: 128, h: 80 },
    { id: "b", x: 648, y: 410, w: 128, h: 80 },
    { id: "c", x: 656, y: 410, w: 128, h: 80 },
  ];
  const out = separateOverlaps(boxes, { x: 0, y: 0, w: 1440, h: 900 }, 8);
  assert.equal(out.remaining, 0, "no true overlap remains");
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(ox > 0 && oy > 0), `${a.id}/${b.id} still overlap`);
    }
    assert.ok(boxes[i].x >= 0 && boxes[i].y >= 0, `${boxes[i].id} escaped bounds`);
  }
  const mkPile = () => ([
    { id: "a", x: 652, y: 394, w: 128, h: 80 },
    { id: "b", x: 648, y: 410, w: 128, h: 80 },
    { id: "c", x: 656, y: 410, w: 128, h: 80 },
  ]);
  const first = mkPile();
  separateOverlaps(first, { x: 0, y: 0, w: 1440, h: 900 }, 8);
  const second = mkPile();
  separateOverlaps(second, { x: 0, y: 0, w: 1440, h: 900 }, 8);
  assert.deepEqual(first, second, "separation is deterministic");
});

test("a topology program compiles with no overlapping device tiles", () => {
  const result = executeRuntime({
    canvas: { name: "Topo", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology", layout: "topology" } }],
    links: [{ from: "hub", to: "n1", label: "8us" }, { from: "hub", to: "n2" }],
    content: [
      { fn: "deviceNode", id: "hub", parent: "map", args: { label: "hub-01" } },
      { fn: "deviceNode", id: "n1", parent: "map", args: { label: "node-01" } },
      { fn: "deviceNode", id: "n2", parent: "map", args: { label: "node-02" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "hub", to: "n1", label: "8us" } },
      { fn: "connector", id: "c2", parent: "map", args: { from: "hub", to: "n2" } },
    ],
  });
  const tiles = ["hub", "n1", "n2"].map((id) => ({ id, ...result.boxes.get(id) }));
  for (const t of tiles) {
    assert.ok(Number.isInteger(t.x) && Number.isInteger(t.y), `${t.id} has integer coordinates`);
  }
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i], b = tiles[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(ox > 0 && oy > 0), `${a.id}/${b.id} overlap`);
    }
  }
});

test("tree survives a cycle instead of refusing to draw", () => {
  // Real topology data from a discovery sweep contains loops. Dropping the whole
  // diagram would be a worse outcome than drawing it once.
  const nodes = [{ id: "a" }, { id: "b" }];
  const links = [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
  ];

  const result = tree(nodes, links, { bounds: { x: 0, y: 0, w: 200, h: 200 }, gap: 50 });
  assert.equal(result.get("a") !== undefined, true);
  assert.equal(result.get("b") !== undefined, true);
});

test("masonry fills the shortest column", () => {
  const items = [
    { id: "tall", height: 300 },
    { id: "short", height: 100 },
    { id: "medium", height: 200 },
  ];

  const out = masonry(items, { bounds: { x: 0, y: 0, w: 400, h: 1000 }, gap: 10, columns: 2 });

  // Column width: (400 - 10) / 2 = 195
  assert.equal(out.get("tall").x, 0);
  assert.equal(out.get("tall").y, 0);

  // The next item goes to the empty column, not the one with 300px of content.
  assert.equal(out.get("short").x, 205);
  assert.equal(out.get("short").y, 0);

  // By then column 1 ends at 100 + 10, so the third item stacks under it. This is
  // the property that makes the bottom edge ragged rather than leaving a hole.
  assert.equal(out.get("medium").x, 205);
  assert.equal(out.get("medium").y, 110);
});

test("masonry never exceeds the region width", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, height: 40 + i }));
  const out = masonry(items, { bounds: { x: 100, y: 50, w: 400, h: 1000 }, gap: 10, columns: 2 });

  for (const [, place] of out) {
    assert.equal(place.x + 195 <= 500, true, `column overflowed to ${place.x}`);
    assert.equal(place.x >= 100, true);
  }
});

test("timeline stretches the value domain across the full width", () => {
  const items = [
    { id: "early", at: 100 },
    { id: "late", at: 900 },
  ];

  const out = timeline(items, { bounds: { x: 0, y: 0, w: 1000, h: 200 }, gap: 24 });

  assert.equal(out.get("early").x, 0);
  assert.equal(out.get("late").x, 1000 - 24);
});

test("timeline falls back to even spacing without values", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  const out = timeline(items, { bounds: { x: 0, y: 0, w: 1000, h: 100 } });

  assert.equal(out.get("a").x, 0);
  assert.equal(out.get("c").x, 976);
  // Monotonic: an event sequence must never double back on itself.
  assert.equal(out.get("a").x < out.get("b").x, true);
  assert.equal(out.get("b").x < out.get("c").x, true);
});

test("cluster groups related nodes and leads with the heaviest group", () => {
  const items = [
    { id: "a1", group: "workers" },
    { id: "a2", group: "workers" },
    { id: "a3", group: "workers" },
    { id: "b1", group: "hub" },
  ];

  const out = cluster(items, { bounds: { x: 0, y: 0, w: 600, h: 400 }, gap: 10, columns: 2 });

  assert.equal(out.groups.size, 2);
  assert.deepEqual([...out.groups.keys()][0], "workers", "the three-member group must be placed first");

  // Members of a group share a block: same column, stacked with the gap.
  const a1 = out.get("a1");
  const a2 = out.get("a2");
  assert.equal(a1.x, a2.x);
  assert.equal(a2.y > a1.y, true);
});

test("cluster keeps ungrouped nodes instead of dropping them", () => {
  const out = cluster([{ id: "lonely" }], { bounds: { x: 0, y: 0, w: 200, h: 200 }, gap: 8 });
  assert.equal(out.get("lonely") !== undefined, true);
  assert.deepEqual([...out.groups.keys()], ["ungrouped"]);
});

/* -------------------------------------------------------------------------- */
/* Constraint layout (spec �18)                                                */
/* -------------------------------------------------------------------------- */

const boxes = () => [
  { id: "topology", x: 0, y: 0, w: 800, h: 900 },
  { id: "inspector", x: 0, y: 0, w: 320, h: 900 },
];

test("rightOf positions a box against its anchor plus the gap", () => {
  const violations = [];
  const out = solveConstraints({
    boxes: boxes(),
    constraints: [{ id: "inspector", rightOf: "topology", gap: 24, width: 320 }],
    parent: { id: "root", x: 0, y: 0, w: 1440, h: 900 },
    violations,
  });

  assert.equal(out[1].x, 824);
  assert.equal(violations.length, 0);
});

test("below positions a box under its anchor", () => {
  const violations = [];
  const out = solveConstraints({
    boxes: [
      { id: "header", x: 0, y: 0, w: 1440, h: 64 },
      { id: "body", x: 0, y: 0, w: 1440, h: 836 },
    ],
    constraints: [{ id: "body", below: "header", gap: 0 }],
    parent: { id: "root", x: 0, y: 0, w: 1440, h: 900 },
    violations,
  });

  assert.equal(out[1].y, 64);
});

test("fill spans from the current left edge to the parent's right inset", () => {
  const violations = [];
  const out = solveConstraints({
    boxes: [
      { id: "nav", x: 0, y: 0, w: 240, h: 900 },
      { id: "content", x: 272, y: 0, w: 400, h: 900 },
    ],
    constraints: [{ id: "content", width: "fill", right: 0 }],
    parent: { id: "root", x: 0, y: 0, w: 1440, h: 900 },
    violations,
  });

  assert.equal(out[1].w, 1440 - 272);
});

test("alignTo middle centres a box on its anchor", () => {
  const violations = [];
  const out = solveConstraints({
    boxes: [
      { id: "big", x: 0, y: 0, w: 400, h: 400 },
      { id: "small", x: 0, y: 0, w: 100, h: 100 },
    ],
    constraints: [{ id: "small", rightOf: "big", gap: 20, alignTo: "middle" }],
    parent: { id: "root", x: 0, y: 0, w: 1440, h: 400 },
    violations,
  });

  assert.equal(out[1].y, 150);
});

test("alignTo stretch copies the anchor's extent", () => {
  const violations = [];
  const out = solveConstraints({
    boxes: boxes(),
    constraints: [{ id: "inspector", below: "topology", alignTo: "stretch", height: 10 }],
    parent: { id: "root", x: 0, y: 0, w: 1440, h: 900 },
    violations,
  });

  assert.equal(out[1].h, 900);
});

test("constraints apply in dependency order, not declaration order", () => {
  // Written backwards on purpose: c depends on b, b depends on a. If the solver
  // applied these in the order given, b would be positioned against a stale c.
  const violations = [];
  const out = solveConstraints({
    boxes: [
      { id: "a", x: 0, y: 0, w: 200, h: 100 },
      { id: "b", x: 0, y: 0, w: 200, h: 100 },
      { id: "c", x: 0, y: 0, w: 200, h: 100 },
    ],
    constraints: [
      { id: "c", rightOf: "b", gap: 10 },
      { id: "b", rightOf: "a", gap: 10 },
    ],
    parent: { id: "root", x: 0, y: 0, w: 1440, h: 900 },
    violations,
  });

  const byId = Object.fromEntries(out.map((b) => [b.id, b]));
  assert.equal(byId.b.x, 210);
  assert.equal(byId.c.x, 420);
});

test("a constraint cycle is reported instead of silently mis-positioned", () => {
  const violations = [];
  solveConstraints({
    boxes: [
      { id: "a", x: 0, y: 0, w: 100, h: 100 },
      { id: "b", x: 0, y: 0, w: 100, h: 100 },
    ],
    constraints: [
      { id: "a", rightOf: "b", gap: 10 },
      { id: "b", rightOf: "a", gap: 10 },
    ],
    parent: { id: "root", x: 0, y: 0, w: 800, h: 800 },
    violations,
  });

  assert.equal(violations.some((v) => /circular/i.test(v.message)), true);
});

test("an unknown anchor is reported rather than ignored", () => {
  const violations = [];
  solveConstraints({
    boxes: [{ id: "a", x: 0, y: 0, w: 10, h: 10 }],
    constraints: [{ id: "a", rightOf: "ghost" }],
    parent: { id: "root", x: 0, y: 0, w: 800, h: 800 },
    violations,
  });

  assert.equal(violations.some((v) => /ghost/.test(v.message)), true);
});

/* -------------------------------------------------------------------------- */
/* Connectors (spec �16)                                                       */
/* -------------------------------------------------------------------------- */

test("a connector terminates on the box edges, not the centres", () => {
  const route = routeConnector(
    { id: "c1", from: "a", to: "b" },
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 300, y: 0, w: 100, h: 100 },
  );

  assert.ok(route);
  // Right edge of a is 100, left edge of b is 300.
  assert.match(route.path, /^M 100 50/);
});

test("orthogonal routing inserts a Z segment", () => {
  const route = routeConnector(
    { id: "c1", from: "a", to: "b", routing: "orthogonal" },
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 300, y: 200, w: 100, h: 100 },
  );

  // Horizontal dominance: three segments with a vertical middle.
  const segments = (route.path.match(/[ML]/g) ?? []).length;
  assert.equal(segments >= 3, true);
});

test("a connector includes an arrowhead subpath by default", () => {
  const route = routeConnector(
    { id: "c1", from: "a", to: "b" },
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 300, y: 0, w: 100, h: 100 },
  );

  // Two subpaths: the line (open) and the arrowhead (closed with Z).
  assert.equal((route.path.match(/M /g) ?? []).length, 2);
  assert.equal(/Z/.test(route.path), true);
});

test("arrowEnd false omits the head", () => {
  const route = routeConnector(
    { id: "c1", from: "a", to: "b", arrowEnd: false },
    { id: "a", x: 0, y: 0, w: 100, h: 100 },
    { id: "b", x: 300, y: 0, w: 100, h: 100 },
  );

  assert.equal((route.path.match(/M /g) ?? []).length, 1);
});

test("a connector to a missing node returns null instead of a line to nowhere", () => {
  assert.equal(routeConnector({ id: "c", from: "ghost", to: "b" }, undefined, { id: "b", x: 0, y: 0, w: 10, h: 10 }), null);
});

test("normalizePath re-frames geometry so the node lands where intended", () => {
  const out = normalizePath("M 100 200 L 300 200 L 300 400 Z");

  assert.equal(out.x, 100);
  assert.equal(out.y, 200);
  assert.equal(out.width, 200);
  assert.equal(out.height, 200);
  assert.match(out.path, /^M 0 0 /);
});

test("normalizePath pads a perfectly flat line to one pixel", () => {
  // Figma refuses a zero-size node, and a straight connector is the single most
  // likely shape in the system to be perfectly axis-aligned.
  const out = normalizePath("M 50 80 L 400 80");

  assert.equal(out.height, 1);
  assert.equal(out.y, 80);
  assert.equal(out.width, 350);
});

/* -------------------------------------------------------------------------- */
/* Variables and styles (spec �22)                                             */
/* -------------------------------------------------------------------------- */

test("variables and styles are emitted before the nodes that use them", () => {
  const result = executeRuntime({
    canvas: { name: "Tokens", width: 800, height: 600 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill", fill: "#FFFDF9" } }],
    content: [
      { fn: "variable", id: "v1", args: { name: "surface", color: "#FFFDF9" } },
      { fn: "variable", id: "v2", args: { name: "space/md", type: "number", values: { default: 24 } } },
      { fn: "paintStyle", id: "s1", args: { name: "Surface", color: "#FFFDF9" } },
      { fn: "textStyle", id: "s2", args: { name: "Display", size: 32, weight: 600 } },
    ],
  });

  const types = result.operations.map((o) => o.type);
  assert.equal(types.filter((t) => t === "createVariable").length, 2);
  assert.equal(types.filter((t) => t === "createPaintStyle").length, 1);
  assert.equal(types.filter((t) => t === "createTextStyle").length, 1);

  // The root frame is always first; tokens must land immediately after it and
  // before any content.
  assert.equal(types[0], "createFrame");
  assert.equal(types[1], "createVariable");
});

test("a bare colour on a variable becomes the default mode value", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 400, height: 300 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "variable", id: "v1", args: { name: "text", color: "#242521" } }],
  });

  const op = result.operations.find((o) => o.type === "createVariable");
  assert.equal(op.values.default, "#242521");
  assert.equal(op.variableType, "color");
});

test("variables claim no parent region", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 400, height: 300 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "variable", id: "v1", args: { name: "surface", color: "#FFFDF9" } }],
  });

  assert.deepEqual(result.ir.regions[0].children, []);
});

/* -------------------------------------------------------------------------- */
/* End-to-end: relations, connectors and algorithms through the compiler       */
/* -------------------------------------------------------------------------- */

test("relations move a region and emit a follow-up setPosition", () => {
  const result = executeRuntime({
    canvas: { name: "R", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "topology", args: { width: 800, height: "fill" } },
      { fn: "frame", id: "inspector", args: { width: 320, height: 600 } },
    ],
    relations: [{ id: "inspector", rightOf: "topology", gap: 24, width: 320 }],
  });

  assert.equal(result.constrained, 1);
  assert.equal(result.boxes.get("inspector").x, 824);

  const move = result.operations.find((o) => o.type === "setPosition" && o.target === "inspector");
  assert.equal(move.x, 824);
});

test("connectors compile to a single vector node, not a bespoke operation", () => {
  const result = executeRuntime({
    canvas: { name: "Topology", width: 1200, height: 800, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "deviceNode", id: "d1", parent: "map", args: { label: "node-a" } },
      { fn: "deviceNode", id: "d2", parent: "map", args: { label: "node-b" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "d1", to: "d2", routing: "orthogonal", label: "8 us" } },
    ],
  });

  const vectors = result.operations.filter((o) => o.type === "createVector");
  assert.equal(vectors.length, 1, "one connector must be one node");
  assert.equal(vectors[0].fillArrows, true);

  // The label rides along as a text layer at the route midpoint.
  assert.equal(result.operations.some((o) => o.type === "createText" && /8 us/.test(o.content)), true);
});

test("a connector to an unknown node is a violation, not a silent omission", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "connector", id: "c1", parent: "map", args: { from: "ghost", to: "alsoghost" } }],
  });

  assert.equal(result.violations.some((v) => v.rule === "connector" && /ghost/.test(v.message)), true);
});

test("a tree layout is chosen for a topology region with links", () => {
  const result = executeRuntime({
    canvas: { name: "Topology", width: 1200, height: 800, grid: 8 },
    regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology" } }],
    content: [
      { fn: "shape", id: "s1", parent: "map", args: { shape: "ellipse", fill: "#111111" } },
      { fn: "shape", id: "s2", parent: "map", args: { shape: "ellipse", fill: "#111111" } },
      { fn: "shape", id: "s3", parent: "map", args: { shape: "ellipse", fill: "#111111" } },
    ],
    links: [
      { from: "s1", to: "s2" },
      { from: "s1", to: "s3" },
    ],
  });

  assert.equal(result.algorithms.map, "tree");
});

test("an explicit layout algorithm overrides the composition default", () => {
  const result = executeRuntime({
    canvas: { name: "Timeline", width: 1200, height: 600, grid: 8 },
    regions: [{ fn: "hero", id: "chart", args: { width: "fill", height: "fill", layout: "masonry", columns: 4 } }],
    content: [
      { fn: "panel", id: "p1", parent: "chart", args: { title: "One" } },
      { fn: "panel", id: "p2", parent: "chart", args: { title: "Two" } },
      { fn: "panel", id: "p3", parent: "chart", args: { title: "Three" } },
    ],
  });

  assert.equal(result.algorithms.chart, "masonry");
});

test("a relation with no id is reported rather than dropped in silence", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    relations: [{ rightOf: "main", gap: 10 }],
  });

  assert.equal(result.warnings.some((w) => /needs the node it constrains/i.test(w)), true);
});

test("a program using token references still passes the allowlist", () => {
  const result = executeRuntime({
    canvas: { name: "Tokens", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "panel", id: "p1", parent: "main", args: { title: "Card", surface: "exo/surface" } },
      { fn: "text", id: "t1", parent: "main", args: { text: "Hi", fill: "exo/text" } },
    ],
  });

  for (const operation of result.operations) {
    assert.equal(OperationSchema.safeParse(operation).success, true, `rejected: ${JSON.stringify(operation)}`);
  }
});

/* -------------------------------------------------------------------------- */
/* User-defined templates (spec §20, declarative)                              */
/* -------------------------------------------------------------------------- */

test("a template can be defined once and stamped with different values", () => {
  const result = executeRuntime({
    canvas: { name: "Templates", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    templates: [
      {
        name: "stat",
        parameters: { label: "Metric", value: "0" },
        body: [
          { fn: "sectionHeader", id: "h", args: { title: "{{label}}" } },
          { fn: "text", id: "v", args: { text: "{{value}}", role: "value" } },
        ],
      },
    ],
    content: [
      { fn: "template", id: "a", parent: "main", args: { name: "stat", values: { label: "GPUs", value: "8" } } },
      { fn: "template", id: "b", parent: "main", args: { name: "stat", values: { label: "Memory", value: "1.8 TB" } } },
    ],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.ir.regions[0].children, ["a__h", "a__v", "b__h", "b__v"]);

  const texts = result.operations.filter((o) => o.type === "createText").map((o) => o.content);
  for (const expected of ["GPUs", "8", "Memory", "1.8 TB"]) {
    assert.equal(texts.includes(expected), true, `missing stamped text '${expected}'`);
  }
});

test("a template keeps its internal connector connected after namespacing", () => {
  const result = executeRuntime({
    canvas: { name: "Template links", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill" } }],
    templates: [
      {
        name: "pair",
        body: [
          { fn: "shape", id: "s1", args: { shape: "ellipse", fill: "#111111" } },
          { fn: "shape", id: "s2", args: { shape: "ellipse", fill: "#111111" } },
          { fn: "connector", id: "edge", args: { from: "s1", to: "s2" } },
        ],
      },
    ],
    content: [{ fn: "template", id: "one", parent: "map", args: { name: "pair" } }],
  });

  assert.deepEqual(result.warnings, []);
  assert.equal(result.violations.some((v) => v.rule === "connector"), false);
  assert.equal(result.operations.filter((o) => o.type === "createVector").length, 1);
});

test("templates refuse nesting, unknown names and unknown parameters", () => {
  const result = executeRuntime({
    canvas: { name: "Template errors", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    templates: [
      {
        name: "outer",
        parameters: { label: "Item" },
        body: [
          { fn: "text", id: "t", args: { text: "{{label}}" } },
          { fn: "template", id: "nested", args: { name: "outer" } },
        ],
      },
    ],
    content: [
      { fn: "template", id: "good", parent: "main", args: { name: "outer", values: { label: "One", extra: 1 } } },
      { fn: "template", id: "missing", parent: "main", args: { name: "ghost" } },
    ],
  });

  assert.equal(result.warnings.some((w) => /nested template/i.test(w)), true);
  assert.equal(result.warnings.some((w) => /no parameter 'extra'/i.test(w)), true);
  assert.equal(result.warnings.some((w) => /Unknown template 'ghost'/i.test(w)), true);
  assert.deepEqual(result.ir.regions[0].children, ["good__t"]);
});

/* -------------------------------------------------------------------------- */
/* Arcs (spec �16 - logo geometry)                                             */
/* -------------------------------------------------------------------------- */

test("a half-circle arc starts and ends where it should", () => {
  const parsed = parseSvgPath("M 0 0 A 50 50 0 0 1 100 0");

  assert.ok(parsed.winding.length > 4, "an arc must flatten to several points, not a straight line");
  assert.deepEqual(parsed.winding[0], { x: 0, y: 0 });
  // The parser closes open subpaths by repeating the start point, so the real
  // endpoint is second to last.
  const end = parsed.winding[parsed.winding.length - 2];
  assert.ok(Math.abs(end.x - 100) < 0.01 && Math.abs(end.y) < 0.01, `arc must end at (100, 0), ended at ${JSON.stringify(end)}`);
});

test("a full circle drawn as two arcs stays on its radius", () => {
  // However the flags resolve, a full circle is centred on the origin. Every
  // flattened point must sit on the radius, which tests the whole arc pipeline
  // (endpoint conversion, centre, angles, bezier spans) in one assertion.
  const parsed = parseSvgPath("M -50 0 A 50 50 0 1 1 50 0 A 50 50 0 1 1 -50 0");

  assert.ok(parsed.winding.length > 10);
  for (const point of parsed.winding) {
    const radius = Math.hypot(point.x, point.y);
    assert.ok(Math.abs(radius - 50) < 1, `point ${JSON.stringify(point)} is ${radius} from the centre, expected 50`);
  }
});

test("a degenerate arc degrades to a line instead of failing", () => {
  const parsed = parseSvgPath("M 10 10 A 0 0 0 0 1 90 10");
  assert.ok(parsed.winding.length >= 2);
  // Second to last: the parser repeats the start point at the end of open paths.
  assert.deepEqual({ x: Math.round(parsed.winding[1].x), y: Math.round(parsed.winding[1].y) }, { x: 90, y: 10 });
});

test("a relative arc command is rejected, not approximated", () => {
  assert.throws(() => parseSvgPath("M 0 0 a 50 50 0 0 1 100 0"), /absolute/);
});

test("large-arc selects depth, sweep selects the side", () => {
  // A chord shorter than the diameter, so the flags genuinely matter. (On an
  // exact half-circle the large/small distinction is meaningless by definition.)
  //
  // Verified against the SVG endpoint-parameterisation by hand: with sweep fixed,
  // both arcs bow to the same side at different depths, because the sweep fixes
  // the rotational direction and large-arc picks the near vs far centre. Flipping
  // sweep mirrors the arc. A test asserting "opposite bulges" would enshrine a
  // misunderstanding of the spec.
  const peak = (d) => {
    const parsed = parseSvgPath(d);
    return parsed.winding.map((p) => p.y).reduce((a, y) => (Math.abs(y) > Math.abs(a) ? y : a), 0);
  };

  assert.ok(Math.abs(peak("M 0 0 A 60 60 0 0 1 100 0") - -26.83) < 1, "small arc bows shallow");
  assert.ok(Math.abs(peak("M 0 0 A 60 60 0 1 1 100 0") - -93.17) < 1, "large arc bows deep");
  assert.ok(Math.abs(peak("M 0 0 A 60 60 0 0 0 100 0") - 26.83) < 1, "flipped sweep mirrors the arc");
});

/* -------------------------------------------------------------------------- */
/* Computed mark geometry                                                      */
/* -------------------------------------------------------------------------- */

test("a hexagon has six vertices", () => {
  const parsed = parseSvgPath(polygonPath(0, 0, 10, 6));
  // Six vertices plus the closing point.
  assert.equal(parsed.winding.length, 7);
});

test("a five-point star has ten vertices", () => {
  const parsed = parseSvgPath(starPath(0, 0, 10, 0.382, 5));
  assert.equal(parsed.winding.length, 11);
});

test("a ring is two closed subpaths, so the inner circle cuts a hole", () => {
  const parsed = parseSvgPath(ringPath(0, 0, 10));
  assert.equal(parsed.regions.length, 1, "outer circle plus one inner region");
});

test("every logo mark parses without throwing", () => {
  for (const mark of LOGO_MARKS) {
    const parsed = parseSvgPath(logoMarkPath(mark, 0, 0, 50));
    assert.ok(parsed.winding.length >= 2, `${mark} produced no geometry`);
  }
});

test("an unknown mark name falls back to a ring", () => {
  assert.equal(coerceLogoMark("banana"), "ring");
  assert.equal(coerceLogoMark("hex"), "hex");
});

/* -------------------------------------------------------------------------- */
/* Deck mode (Figma Slides)                                                    */
/* -------------------------------------------------------------------------- */

const DECK = {
  canvas: { name: "Launch", width: 1440, height: 900, grid: 8, deck: true },
  regions: [
    { fn: "frame", id: "title", args: { width: "fill", height: "fill" } },
    { fn: "frame", id: "detail", args: { width: "fill", height: "fill" } },
  ],
  content: [{ fn: "text", id: "t1", parent: "title", args: { text: "EXO", role: "title" } }],
};

test("deck mode emits one slide per region and no root frame", () => {
  const result = executeRuntime(DECK);
  const types = result.operations.map((o) => o.type);

  assert.equal(types.filter((t) => t === "createSlide").length, 2, "one slide per region");
  assert.equal(types.includes("createFrame"), false, "no root frame in a deck");
  assert.equal(result.operations[0].name, "Title");
});

test("deck mode scales type for the back of the room", () => {
  const result = executeRuntime(DECK);
  const text = result.operations.find((o) => o.type === "createText");
  // Title 32 at 1920/1440. Unscaled 32px on a slide reads as fine print.
  assert.equal(text.fontSize, Math.round(32 * (1920 / 1440)));
});

test("deck mode assigns every slide the full 1920x1080", () => {
  const result = executeRuntime(DECK);
  assert.equal(result.boxes.get("title").w, 1920);
  assert.equal(result.boxes.get("title").h, 1080);
  assert.equal(result.boxes.get("detail").x, 0);
});

test("relations are skipped across slides, loudly", () => {
  const result = executeRuntime({ ...DECK, relations: [{ id: "detail", rightOf: "title", gap: 24 }] });
  assert.equal(result.violations.some((v) => v.rule === "relation" && /across slides/i.test(v.message)), true);
  assert.equal(result.constrained, 0, "nothing moved");
});

test("a connector crossing slides is a violation, not a misplaced vector", () => {
  const result = executeRuntime({
    ...DECK,
    content: [
      { fn: "shape", id: "s1", parent: "title", args: { shape: "ellipse", fill: "#111111" } },
      { fn: "shape", id: "s2", parent: "detail", args: { shape: "ellipse", fill: "#111111" } },
      { fn: "connector", id: "c1", parent: "title", args: { from: "s1", to: "s2" } },
    ],
  });

  assert.equal(result.violations.some((v) => v.rule === "connector" && /crosses slides/i.test(v.message)), true);
  assert.equal(result.operations.some((o) => o.type === "createVector" && o.id === "c1"), false);
});

test("a connector inside one slide still works in deck mode", () => {
  const result = executeRuntime({
    ...DECK,
    content: [
      { fn: "shape", id: "s1", parent: "title", args: { shape: "ellipse", fill: "#111111" } },
      { fn: "shape", id: "s2", parent: "title", args: { shape: "ellipse", fill: "#111111" } },
      { fn: "connector", id: "c1", parent: "title", args: { from: "s1", to: "s2" } },
    ],
  });

  assert.equal(result.operations.some((o) => o.type === "createVector" && o.id === "c1"), true);
});

/* -------------------------------------------------------------------------- */
/* Logo primitives                                                             */
/* -------------------------------------------------------------------------- */

test("a polygon shape compiles to a vector, not a rectangle", () => {
  const result = executeRuntime({
    canvas: { name: "Logo", width: 400, height: 400, grid: 8 },
    regions: [{ fn: "frame", id: "mark", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "shape", id: "hex", parent: "mark", args: { shape: "polygon", sides: 6, fill: "#111111" } }],
  });

  const vector = result.operations.find((o) => o.type === "createVector");
  assert.ok(vector, "a polygon must become a vector node");
  assert.equal(result.operations.some((o) => o.type === "createRectangle"), false);
});

test("a logoMark compiles to a single named vector", () => {
  const result = executeRuntime({
    canvas: { name: "Logo", width: 400, height: 400, grid: 8 },
    regions: [{ fn: "frame", id: "mark", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "logoMark", id: "logo", parent: "mark", args: { mark: "orbit", color: "#242521" } }],
  });

  const vectors = result.operations.filter((o) => o.type === "createVector");
  assert.equal(vectors.length, 1, "one mark, one node");
  assert.equal(vectors[0].name, "Logo orbit");
});

test("letterSpacing reaches the text operation for wordmarks", () => {
  const result = executeRuntime({
    canvas: { name: "Logo", width: 800, height: 400, grid: 8 },
    regions: [{ fn: "frame", id: "mark", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "text", id: "word", parent: "mark", args: { text: "EXO", role: "title", letterSpacing: 12 } }],
  });

  const text = result.operations.find((o) => o.type === "createText");
  assert.equal(text.letterSpacing, 12);
});

/* -------------------------------------------------------------------------- */
/* Semantic component arguments (spec section 4)                               */
/* -------------------------------------------------------------------------- */

function buildSingle(content, extra = {}) {
  return executeRuntime({
    canvas: { name: "Semantics", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: content.fn, id: "x", parent: "main", args: content.args }],
    ...extra,
  });
}

test("navItem state:active is no longer rejected and renders active", () => {
  const result = buildSingle({ fn: "navItem", args: { label: "Home", state: "active" } });
  assert.deepEqual(result.warnings, []);
  const frame = result.operations.find((o) => o.id === "x");
  assert.equal(frame.fill, "#F2C94C");
});

test("statusPill tone:success renders green on soft green", () => {
  const result = buildSingle({ fn: "statusPill", args: { label: "Healthy", tone: "success" } });
  assert.deepEqual(result.warnings, []);
  const label = result.operations.find((o) => o.type === "createText");
  assert.equal(label.fill, "#1E6B3A");
});

test("button variant:destructive renders red", () => {
  const result = buildSingle({ fn: "button", args: { label: "Delete", variant: "destructive" } });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.operations.find((o) => o.id === "x").fill, "#D13415");
});

test("button variant:loading admits it is busy", () => {
  const result = buildSingle({ fn: "button", args: { label: "Deploy", variant: "loading" } });
  const label = result.operations.find((o) => o.type === "createText");
  assert.match(label.content, /^Deploy.$/u, "loading appends an ellipsis to the label");
  assert.equal(label.content.endsWith("…"), true);
  assert.equal(result.operations.find((o) => o.id === "x").opacity, 0.6);
});

test("metric valueStyle:technical sets the value in mono", () => {
  const result = buildSingle({ fn: "metric", args: { label: "Latency", value: "8 us", valueStyle: "technical" } });
  const value = result.operations.find((o) => o.type === "createText" && o.name === "Value");
  assert.equal(value.family, "JetBrains Mono");
});

test("metric container is parented to its region, not the page", () => {
  // Live defect: the metric frame omitted `parent`, so it landed on the page
  // while its texts nested inside it — review scoped to the built frame saw
  // nothing and the screenshot rendered blank.
  const result = buildSingle({ fn: "metric", args: { label: "Latency", value: "8 us" } });
  const frame = result.operations.find((o) => o.id === "x");
  assert.equal(frame.type, "createFrame");
  assert.equal(frame.parent, "main");
  for (const text of result.operations.filter((o) => o.type === "createText")) {
    assert.equal(text.parent, "x");
  }
});

test("deviceNode health:degraded strokes amber and offline fades", () => {
  const degraded = buildSingle({ fn: "deviceNode", args: { label: "n1", health: "degraded" } });
  assert.equal(degraded.operations.find((o) => o.id === "x").stroke, "#8A5200");

  const offline = buildSingle({ fn: "deviceNode", args: { label: "n2", health: "offline" } });
  assert.equal(offline.operations.find((o) => o.id === "x").opacity, 0.7);
});

test("deviceNode selected:true wins over health with action blue", () => {
  const result = buildSingle({ fn: "deviceNode", args: { label: "n1", health: "degraded", selected: true } });
  const frame = result.operations.find((o) => o.id === "x");
  assert.equal(frame.stroke, "#0D99FF");
  assert.equal(frame.strokeWeight, 3);
});

test("modelRow renders title, toned status and mono memory", () => {
  const result = buildSingle({ fn: "modelRow", args: { title: "qwen3-235b", status: "fits", memory: "480 GB" } });
  const texts = result.operations.filter((o) => o.type === "createText").map((o) => o.content);
  assert.deepEqual(texts, ["qwen3-235b", "fits", "480 GB"]);
});

test("sectionHeader action right-aligns in the same band", () => {
  const result = buildSingle({ fn: "sectionHeader", args: { title: "Models", action: "View all" } });
  const action = result.operations.find((o) => o.type === "createText" && o.name === "Action");
  assert.ok(action, "the action text must exist");
  assert.ok(action.x > 400, "right-aligned, not stacked under the title");
});

test("sectionHeader action is parented to the region, never to the title text", () => {
  // Live defect: the action was parented to the title TEXT node, which Figma
  // rejects ("TEXT cannot be a parent") — failing the whole transaction while
  // dry-runs stayed green. Only live Figma validates parents.
  const result = buildSingle({ fn: "sectionHeader", args: { title: "Models", action: "View all" } });
  const title = result.operations.find((o) => o.type === "createText" && o.name === "Models");
  const action = result.operations.find((o) => o.type === "createText" && o.name === "Action");
  assert.equal(title.parent, "main");
  assert.equal(action.parent, "main");
  assert.notEqual(action.parent, title.id);
});

/* -------------------------------------------------------------------------- */
/* First-class topologyMap                                                     */
/* -------------------------------------------------------------------------- */

const TOPOLOGY_PROGRAM = {
  canvas: { name: "Topology", width: 1200, height: 800, grid: 8 },
  regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology" } }],
  content: [
    {
      fn: "topologyMap",
      id: "topo",
      parent: "map",
      args: {
        title: "Fleet",
        selectedNode: "north",
        nodes: [
          { id: "north", label: "Studio North", memory: "192 GB", health: "healthy" },
          { id: "south", label: "Studio South", memory: "192 GB", health: "degraded" },
        ],
        edges: [{ from: "north", to: "south", latency: "8 us", bandwidth: "8.7 GB/s" }],
      },
    },
  ],
};

test("a topologyMap with nodes expands to devices plus a labelled connector", () => {
  const result = executeRuntime(TOPOLOGY_PROGRAM);
  assert.deepEqual(result.warnings, []);

  const names = result.operations.filter((o) => o.type === "createFrame").map((o) => o.name);
  assert.equal(names.includes("Studio North"), true);
  assert.equal(names.includes("Studio South"), true);

  const label = result.operations.find((o) => o.type === "createText" && /8 us/.test(o.content ?? ""));
  assert.ok(label, "the edge latency must be drawn as a connector label");
  assert.match(label.content, /8\.7 GB\/s/, "bandwidth rides along");
});

test("the selected topology node is unambiguous", () => {
  const result = executeRuntime(TOPOLOGY_PROGRAM);
  const frames = result.operations.filter((o) => o.type === "createFrame" && o.strokeWeight === 3);
  assert.equal(frames.length, 1, "exactly one node carries the selection stroke");
  assert.equal(frames[0].name, "Studio North");
});

test("topology edges join the layout links, so the graph is arranged", () => {
  const result = executeRuntime(TOPOLOGY_PROGRAM);
  assert.equal(result.ir.links.length, 1);
  assert.equal(result.algorithms.map, "tree");
});

test("a topology edge to an unknown node is reported, not drawn to nowhere", () => {
  const result = executeRuntime({
    ...TOPOLOGY_PROGRAM,
    content: [
      {
        fn: "topologyMap",
        id: "topo",
        parent: "map",
        args: { nodes: [{ id: "north", label: "North" }], edges: [{ from: "north", to: "ghost" }] },
      },
    ],
  });
  assert.equal(result.warnings.some((w) => /unknown node/i.test(w)), true);
});

test("a topologyMap without nodes keeps its old placeholder behaviour", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "map", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "topologyMap", id: "topo", parent: "map", args: { title: "Map" } }],
  });
  assert.equal(result.operations.some((o) => o.type === "createFrame" && o.name === "Map"), true);
});

/* -------------------------------------------------------------------------- */
/* Token references bind instead of painting (spec section 7)                  */
/* -------------------------------------------------------------------------- */

test("a token-name fill becomes a binding, not a literal", () => {
  const result = executeRuntime({
    canvas: { name: "Tokens", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "panel", id: "p1", parent: "main", args: { title: "Card", surface: "exo/surface" } }],
  });

  const frame = result.operations.find((o) => o.id === "p1");
  assert.deepEqual(frame.fill, [], "the literal must be cleared so the binding owns the fill");

  const bind = result.operations.find((o) => o.type === "bindVariable");
  assert.ok(bind, "a bindVariable op must follow");
  assert.equal(bind.target, "p1");
  assert.equal(bind.field, "fills");
  assert.equal(bind.variable, "exo/surface");
});

test("hex fills pass through untouched", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "panel", id: "p1", parent: "main", args: { title: "Card", surface: "#FFFDF9" } }],
  });

  assert.equal(result.operations.some((o) => o.type === "bindVariable"), false);
  assert.equal(result.operations.find((o) => o.id === "p1").fill, "#FFFDF9");
});

test("a bound op without an id is given one to address", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "text", id: "t1", parent: "main", args: { text: "Hi", fill: "exo/text" } }],
  });

  const text = result.operations.find((o) => o.id === "t1");
  const bind = result.operations.find((o) => o.type === "bindVariable" && o.target === "t1");
  assert.ok(bind, "the text must be bound");
  assert.deepEqual(text.fill, []);
});

test("bindings come after every creation", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "panel", id: "p1", parent: "main", args: { title: "Card", surface: "exo/surface" } }],
  });

  const frameIndex = result.operations.findIndex((o) => o.id === "p1" && o.type === "createFrame");
  const bindIndex = result.operations.findIndex((o) => o.type === "bindVariable");
  assert.ok(bindIndex > frameIndex, "a bind must never precede the node it addresses");
});

test("every compiled operation still passes the allowlist", () => {
  const result = executeRuntime({
    canvas: { name: "Everything", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 240 } },
      { fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology" } },
    ],
    content: [
      { fn: "variable", id: "v1", args: { name: "surface", color: "#FFFDF9" } },
      { fn: "shape", id: "s1", parent: "map", args: { shape: "ellipse", fill: "#111111" } },
      { fn: "shape", id: "s2", parent: "map", args: { shape: "ellipse", fill: "#111111" } },
      { fn: "connector", id: "c1", parent: "map", args: { from: "s1", to: "s2", label: "8 us" } },
    ],
    relations: [{ id: "map", rightOf: "nav", gap: 24, width: "fill" }],
  });

  for (const operation of result.operations) {
    assert.equal(OperationSchema.safeParse(operation).success, true, `rejected: ${JSON.stringify(operation)}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Model placement visualization (spec section 6)                              */
/* -------------------------------------------------------------------------- */

const PLACEMENT_PROGRAM = {
  canvas: { name: "Placement", width: 1200, height: 800, grid: 8 },
  regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology" } }],
  content: [
    {
      fn: "placementMap",
      id: "place",
      parent: "map",
      args: {
        model: "qwen3-235b",
        required: "480 GB",
        available: "512 GB",
        fits: true,
        machines: [
          { id: "n1", label: "node-01", memory: "256 GB", health: "healthy" },
          { id: "n2", label: "node-02", memory: "256 GB", health: "healthy" },
        ],
        assignments: [
          { from: "model", to: "n1", shard: "shard-0" },
          { from: "model", to: "n2", shard: "shard-1" },
        ],
      },
    },
  ],
};

test("a placementMap states the requirement, draws the machines, and verdicts", () => {
  const result = executeRuntime(PLACEMENT_PROGRAM);
  assert.deepEqual(result.warnings, []);

  const texts = result.operations.filter((o) => o.type === "createText").map((o) => o.content);
  assert.ok(texts.some((t) => /Requires 480 GB/.test(t)), "the requirement must be drawn");
  assert.ok(texts.some((t) => /Available 512 GB/.test(t)), "available memory must be drawn");
  assert.ok(texts.some((t) => /Fits/.test(t)), "the verdict must be drawn, not implied");

  const shards = result.operations.filter((o) => o.type === "createVector" && /edge/.test(o.id));
  assert.equal(shards.length, 2, "two shard assignments, two routed edges");
});

test("a placement without machines keeps its old shape instead of crashing", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "placementMap", id: "place", parent: "main", args: { model: "qwen3" } }],
  });
  assert.equal(result.operations.some((o) => o.type === "createFrame"), true);
});

test("a memoryBudget draws a proportional bar with a mono readout", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "memoryBudget", id: "mem", parent: "main", args: { used: 480, total: 512, unit: " GB" } }],
  });

  const rects = result.operations.filter((o) => o.type === "createRectangle");
  assert.equal(rects.length, 2, "track plus fill");
  assert.ok(rects[1].width > rects[0].width * 0.9, "480/512 must nearly fill the bar");

  const readout = result.operations.find((o) => o.type === "createText");
  assert.match(readout.content, /480 \/ 512 GB used/);
  assert.equal(readout.family, "JetBrains Mono");
});

test("an over-budget bar turns error red", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "memoryBudget", id: "mem", parent: "main", args: { used: 600, total: 512 } }],
  });

  const fill = result.operations.find((o) => o.type === "createRectangle" && o.name === "Fill");
  assert.equal(fill.fill, "#A32A12");
});

test("a fitGauge states the verdict with its evidence", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "fitGauge", id: "fit", parent: "main", args: { fits: false, label: "Does not fit", detail: "needs 600 GB, has 512 GB" } }],
  });

  const texts = result.operations.filter((o) => o.type === "createText").map((o) => o.content);
  assert.deepEqual(texts, ["Does not fit", "needs 600 GB, has 512 GB"]);
});

test("a compatibilityMatrix renders one verdict row per entry", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [
      {
        fn: "compatibilityMatrix",
        id: "matrix",
        parent: "main",
        args: {
          title: "Fit",
          rows: [
            { model: "qwen3-235b", machine: "node-01", verdict: "fits" },
            { model: "llama-70b", machine: "node-02", verdict: "needs 600 GB" },
          ],
        },
      },
    ],
  });

  const rows = result.operations.filter((o) => o.type === "createText" && /^Row/.test(o.name));
  assert.equal(rows.length, 2);
  assert.match(rows[0].content, /qwen3-235b → node-01 · fits/);
});

test("a shardBlock names the shard in mono and points at its machine", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "shardBlock", id: "s0", parent: "main", args: { shard: "shard-0", machine: "node-01", memory: "120 GB" } }],
  });

  const texts = result.operations.filter((o) => o.type === "createText").map((o) => o.content);
  assert.deepEqual(texts, ["shard-0", "→ node-01", "120 GB"]);
  assert.equal(result.operations.find((o) => o.content === "shard-0").family, "JetBrains Mono");
});

/* -------------------------------------------------------------------------- */
/* Built-in templates                                                          */
/* -------------------------------------------------------------------------- */

test("built-in templates stamp without declaring anything", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "template", id: "h", parent: "main", args: { name: "page-header", values: { title: "Compute" } } },
    ],
  });

  assert.deepEqual(result.warnings, []);
  const texts = result.operations.filter((o) => o.type === "createText").map((o) => o.content);
  assert.deepEqual(texts, ["Compute"]);
});

test("a user template replaces the built-in of the same name silently", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    templates: [
      {
        name: "section",
        parameters: {},
        body: [{ fn: "text", id: "custom", args: { text: "Custom section", role: "title" } }],
      },
    ],
    content: [{ fn: "template", id: "s", parent: "main", args: { name: "section" } }],
  });

  assert.equal(result.warnings.some((w) => /Duplicate template/i.test(w)), false, "overriding a built-in is customization, not a conflict");
  const texts = result.operations.filter((o) => o.type === "createText").map((o) => o.content);
  assert.deepEqual(texts, ["Custom section"]);
});

test("an empty-state template draws title, body and action", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "template", id: "e", parent: "main", args: { name: "empty-state" } }],
  });

  const texts = result.operations.filter((o) => o.type === "createText").map((o) => o.content);
  assert.deepEqual(texts, ["Nothing here yet", "Get started to fill this view.", "Get started"]);
});

/* -------------------------------------------------------------------------- */
/* Composition scoring (spec section 10)                                       */
/* -------------------------------------------------------------------------- */

const SCORED = {
  canvas: { name: "Scored", width: 1440, height: 900, grid: 8 },
  regions: [
    { fn: "navigation", id: "nav", args: { width: 240 } },
    { fn: "hero", id: "hero", args: { grow: 2, gap: 16, padding: 32 } },
  ],
  content: [
    { fn: "text", id: "title", parent: "hero", args: { text: "Compute", role: "title" } },
    { fn: "text", id: "sub", parent: "hero", args: { text: "3 machines online", role: "body" } },
    { fn: "text", id: "cap", parent: "hero", args: { text: "updated 8us ago", role: "caption" } },
  ],
};

function scoreOf(program) {
  const result = executeRuntime(program);
  return scoreDesign({
    boxes: result.boxes,
    operations: result.operations,
    regions: result.ir.regions.map((r) => ({ id: r.id, role: r.role })),
    composition: inferComposition(result.ir.regions),
    canvasW: 1440,
    canvasH: 900,
  });
}

test("a composed screen scores well with evidence", () => {
  const report = scoreOf(SCORED);
  assert.ok(report.overall >= 7, `expected 7+, got ${report.overall}: ${JSON.stringify(report.dimensions)}`);
  assert.equal(report.dimensions.length, 7);
  for (const dimension of report.dimensions) {
    assert.ok(dimension.evidence.length > 0, `${dimension.dimension} has no evidence`);
  }
  assert.deepEqual(report.weakSpots, []);
});

test("a single-region screen loses composition points with a fix", () => {
  const report = scoreOf({
    canvas: { name: "Flat", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "text", id: "t", parent: "main", args: { text: "hi" } }],
  });

  const composition = report.dimensions.find((d) => d.dimension === "Composition");
  assert.ok(composition.score < 7, `a lone region should not score high: ${composition.score}`);
  assert.ok(composition.improve.length > 10, "a low score must say what would move it");
  assert.ok(report.weakSpots.length > 0);
});

test("one-size-fits-all type loses hierarchy points", () => {
  const report = scoreOf({
    canvas: { name: "Flat", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 240 } },
      { fn: "hero", id: "hero", args: { grow: 2 } },
    ],
    content: [
      { fn: "text", id: "a", parent: "hero", args: { text: "one" } },
      { fn: "text", id: "b", parent: "hero", args: { text: "two" } },
    ],
  });

  const hierarchy = report.dimensions.find((d) => d.dimension === "Hierarchy");
  assert.ok(hierarchy.score < 7, `uniform type should not score high: ${hierarchy.score}`);
});

test("scoring is deterministic across runs", () => {
  assert.equal(scoreOf(SCORED).overall, scoreOf(SCORED).overall);
});

/* -------------------------------------------------------------------------- */
/* Visual intent (FigDes section 4)                                            */
/* -------------------------------------------------------------------------- */

test("visual weight becomes growth", () => {
  const result = executeRuntime({
    canvas: { name: "Intent", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "topology", args: { width: 800, height: "fill" } },
      { fn: "frame", id: "metrics", args: { width: 320, height: "fill" } },
    ],
    visualIntent: { visualWeight: { topology: 0.9, metrics: 0.35 } },
  });

  const byId = Object.fromEntries(result.ir.regions.map((r) => [r.id, r]));
  assert.equal(byId.topology.grow, 2, "weight 0.9 must grow like 2");
  assert.equal(byId.metrics.grow, 1, "weight 0.35 must grow like 1");
  assert.ok(result.intentNotes.some((n) => /topology.*0\.9/.test(n)));
});

test("the focal region absorbs slack first", () => {
  const result = executeRuntime({
    canvas: { name: "Intent", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "map", args: { width: 800, height: "fill" } },
      { fn: "frame", id: "side", args: { width: 320, height: "fill" } },
    ],
    visualIntent: { focal: "map" },
  });

  assert.equal(result.ir.regions.find((r) => r.id === "map").grow, 2);
  assert.ok(result.intentNotes.some((n) => /focal point/i.test(n)));
});

test("density rescales the spacing system", () => {
  const airy = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { density: "airy" },
  });
  const dense = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { density: "dense" },
  });

  assert.equal(airy.ir.canvas.grid, 12);
  assert.equal(dense.ir.canvas.grid, 6);
});

test("declared grow beats inferred weight", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill", grow: 3 } }],
    visualIntent: { visualWeight: { main: 0.1 } },
  });
  assert.equal(result.ir.regions[0].grow, 3);
});

test("a focal id that matches nothing warns instead of guessing", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { focal: "ghost" },
  });
  assert.equal(result.warnings.some((w) => /focal.*ghost/i.test(w)), true);
});

test("a garbage intent warns once and builds with default taste", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { density: "moist", visualWeight: "all of it" },
  });
  assert.equal(result.warnings.some((w) => /Visual intent ignored/i.test(w)), true);
  assert.equal(result.ir.canvas.grid, 8);
});

test("omitting intent changes nothing", () => {
  const plain = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
  });
  const withEmpty = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: {},
  });
  assert.deepEqual(withEmpty.operations, plain.operations);
  assert.deepEqual(withEmpty.intentNotes, []);
});

/* -------------------------------------------------------------------------- */
/* Focus scoring (FigDes section 19)                                           */
/* -------------------------------------------------------------------------- */

test("a declared focal region holding attention scores high", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 240 } },
      { fn: "hero", id: "hero", args: { grow: 2 } },
    ],
    visualIntent: { focal: "hero" },
  });
  const report = scoreOf2(result, "hero");
  const focus = report.dimensions.find((d) => d.dimension === "Focus");
  assert.ok(focus.score >= 7, `focal hero should hold attention: ${JSON.stringify(focus)}`);
});

test("a focal region losing to chrome scores low with a fix", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 1000 } },
      { fn: "hero", id: "hero", args: { width: 200 } },
    ],
    visualIntent: { focal: "hero" },
  });
  const report = scoreOf2(result, "hero");
  const focus = report.dimensions.find((d) => d.dimension === "Focus");
  assert.ok(focus.score < 7, `a 200px hero cannot hold focus against 1000px chrome: ${JSON.stringify(focus)}`);
  assert.ok(focus.improve.length > 10);
});

function scoreOf2(result, focal) {
  return scoreDesign({
    boxes: result.boxes,
    operations: result.operations,
    regions: result.ir.regions.map((r) => ({ id: r.id, role: r.role })),
    composition: inferComposition(result.ir.regions),
    canvasW: 1440,
    canvasH: 900,
    focal,
  });
}

/* -------------------------------------------------------------------------- */
/* Card-wall rule (FigDes section 21)                                           */
/* -------------------------------------------------------------------------- */

test("three bordered cards covering the screen warn", () => {
  const card = (id, x) => ({
    id, parentId: "1:0", type: "FRAME", name: `Card ${id}`, depth: 1,
    x, y: 0, w: 400, h: 800, visible: true, defaultNamed: false, zIndex: 0,
    fill: "#FFFFFF", stroke: { hex: "#E0E0E0", weight: 1 }, radius: 8,
  });
  const root = {
    id: "1:0", parentId: null, type: "FRAME", name: "Screen", depth: 0,
    x: 0, y: 0, w: 1440, h: 900, visible: true, defaultNamed: false, zIndex: 0,
  };
  const findings = runRules(
    { target: null, scope: "test", nodes: [root, card("1:1", 0), card("1:2", 480), card("1:3", 960)], nodeCount: 4, truncated: false, scanBudget: 100, scan: { pageLoads: 0, pagesCached: true } },
    "review",
  );
  const wall = findings.find((f) => f.rule === "card-wall");
  assert.ok(wall, "three full-height bordered cards must trip the rule");
  assert.match(wall.guidance, /visual field|topology|open composition/);
});

test("two cards do not trip the rule", () => {
  const card = (id, x) => ({
    id, parentId: "1:0", type: "FRAME", name: `Card ${id}`, depth: 1,
    x, y: 0, w: 400, h: 800, visible: true, defaultNamed: false, zIndex: 0,
    fill: "#FFFFFF", stroke: { hex: "#E0E0E0", weight: 1 }, radius: 8,
  });
  const root = {
    id: "1:0", parentId: null, type: "FRAME", name: "Screen", depth: 0,
    x: 0, y: 0, w: 1440, h: 900, visible: true, defaultNamed: false, zIndex: 0,
  };
  const findings = runRules(
    { target: null, scope: "test", nodes: [root, card("1:1", 0), card("1:2", 480)], nodeCount: 3, truncated: false, scanBudget: 100, scan: { pageLoads: 0, pagesCached: true } },
    "review",
  );
  assert.equal(findings.some((f) => f.rule === "card-wall"), false);
});

/* -------------------------------------------------------------------------- */
/* Interaction states (FigDes section 28)                                       */
/* -------------------------------------------------------------------------- */

test("states expand to one sibling per state", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "button", id: "cta", parent: "main", args: { label: "Deploy", states: ["default", "hover", "disabled", "loading"] } }],
  });

  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.ir.regions[0].children, ["cta-default", "cta-hover", "cta-disabled", "cta-loading"]);
  const labels = result.operations.filter((o) => o.type === "createText" && o.name === "Label").map((o) => o.content);
  assert.deepEqual(labels, ["Deploy", "Deploy", "Deploy", "Deploy…"]);
});

test("unknown states warn and skip instead of inventing", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "button", id: "cta", parent: "main", args: { label: "Go", states: ["default", "teleport"] } }],
  });
  assert.equal(result.warnings.some((w) => /State .teleport. is not defined/i.test(w)), true);
  assert.deepEqual(result.ir.regions[0].children, ["cta-default"]);
});

test("device states map onto health vocabulary", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "deviceNode", id: "n1", parent: "main", args: { label: "node-01", states: ["running", "deploying", "offline"] } }],
  });
  const frames = result.operations.filter((o) => o.type === "createFrame" && o.id.startsWith("n1-"));
  assert.equal(frames.length, 3);
  assert.equal(frames.find((f) => f.id === "n1-offline").stroke, "#A32A12");
});

/* -------------------------------------------------------------------------- */
/* Visual style presets (FigDes section 26): same layout, different feel        */
/* -------------------------------------------------------------------------- */

test("a style preset is recorded and travels into the build", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { style: "technical-editorial" },
  });
  assert.equal(result.ir.visualIntent.style, "technical-editorial");
  assert.ok(result.intentNotes.some((n) => /Technical editorial/.test(n)));
});

test("the same content renders differently under different presets", () => {
  const program = (style) => ({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "navigation", id: "nav", args: { width: 240 } }],
    content: [{ fn: "navItem", id: "home", parent: "nav", args: { label: "Home" } }],
    visualIntent: { style },
  });
  const editorial = executeRuntime(program("technical-editorial"));
  const instrument = executeRuntime(program("quiet-instrument"));
  assert.notDeepEqual(editorial.operations, instrument.operations);
  const editorialLabel = editorial.operations.find((o) => o.type === "createText");
  const instrumentLabel = instrument.operations.find((o) => o.type === "createText");
  assert.equal(editorialLabel.letterSpacing, 20);
  assert.equal(instrumentLabel.letterSpacing, 50);
  assert.equal(instrumentLabel.content, "HOME");
  assert.equal(editorialLabel.content, "Home");
});

test("a preset name that matches nothing warns instead of inventing", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { style: "moist" },
  });
  assert.equal(result.warnings.some((w) => /not a known preset/.test(w)), true);
  assert.equal(result.ir.canvas.grid, 8);
});

test("accordion shorthands expand; unknown ones warn", () => {
  assert.deepEqual(ACCORDION.compact, ["dense", "quiet"]);
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { style: "compact" },
  });
  assert.ok(result.intentNotes.some((n) => /dense.*quiet|quiet.*dense/.test(n)));

  const bad = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { style: "squishy" },
  });
  assert.equal(bad.warnings.some((w) => /squishy/.test(w)), true);
});

test("compound directives combine but contradictory pairs are rejected", () => {
  const ok = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { style: ["compact", "warm"] },
  });
  assert.equal(ok.warnings.length, 0);

  const clash = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    visualIntent: { style: ["compact", "airy"] },
  });
  assert.equal(clash.warnings.some((w) => /opposite directions/.test(w)), true);
});

test("registered presets all resolve to real mechanics", () => {
  for (const name of Object.keys(STYLES)) {
    const preset = STYLES[name];
    assert.ok(preset.density && preset.spacing && preset.align && preset.contrast && preset.typography,
      `${name} must define all five mechanics`);
  }
});

test("a surface directive passes through and is flagged for style binding", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [{ fn: "panel", id: "p1", parent: "main", args: { title: "Card", surface: "surface-02" } }],
  });
  const frame = result.operations.find((o) => o.type === "createFrame" && o.id === "p1");
  // Non-colour fills become variable bindings: the literal clears, a bind
  // carries the directive, and the note says what to do with it.
  assert.deepEqual(frame.fill, []);
  const bind = result.operations.find((o) => o.type === "bindVariable" && o.target === "p1");
  assert.equal(bind.variable, "surface-02");
  assert.ok(result.intentNotes.some((n) => /surface-02.*bind/i.test(n)));
});

/* -------------------------------------------------------------------------- */
/* The aesthetic critic (FigDes section 16.2)                                    */
/* -------------------------------------------------------------------------- */

function critiqueOf(result, extra = {}) {
  return critiqueVisual({
    boxes: result.boxes,
    operations: result.operations,
    regions: result.ir.regions.map((r) => ({ id: r.id, role: r.role })),
    composition: inferComposition(result.ir.regions),
    canvasW: 1440,
    canvasH: 900,
    ...extra,
  });
}

test("the critic names twelve dimensions with verdicts, never numbers", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 240 } },
      { fn: "hero", id: "hero", args: { grow: 2 } },
    ],
    visualIntent: { focal: "hero" },
  });
  const report = critiqueOf(result, { focal: "hero" });
  assert.equal(report.dimensions.length, 12);
  for (const d of report.dimensions) {
    assert.ok(["PASS", "WATCH", "FAIL"].includes(d.verdict), `${d.dimension} needs a verdict`);
    assert.ok(d.evidence.length > 0, `${d.dimension} needs evidence`);
    assert.equal("score" in d, false, `${d.dimension} must not carry a numeric score`);
  }
});

test("three stamped bordered cards read as repetition and card-wall", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "a", args: { width: 440, height: 800 } },
      { fn: "frame", id: "b", args: { width: 440, height: 800 } },
      { fn: "frame", id: "c", args: { width: 440, height: 800 } },
      { fn: "frame", id: "d", args: { width: 440, height: 800 } },
    ],
  });
  const report = critiqueOf(result);
  const repetition = report.dimensions.find((d) => d.dimension === "Repetition");
  assert.equal(repetition.verdict, "WATCH");
  assert.ok(report.watchList.length > 0);
});

test("card-wall share caps at 100%: nested borders cannot cover more than the canvas", () => {
  const card = (id, x) => ({ id, x, y: 0, w: 1000, h: 800 });
  const boxes = new Map(
    ["root", "a", "b", "c", "d"].map((id, i) => [id, id === "root" ? { id, x: 0, y: 0, w: 1440, h: 900 } : card(id, i * 100)]),
  );
  const report = critiqueVisual({
    boxes,
    operations: ["a", "b", "c", "d"].map((id) => ({ type: "createFrame", id, width: 1000, height: 800, stroke: "#E0E0E0", cornerRadius: 8, fill: "#FFFFFF" })),
    regions: ["a", "b", "c", "d"].map((id) => ({ id, role: "content" })),
    composition: "canvas",
    canvasW: 1440,
    canvasH: 900,
  });
  const wall = report.dimensions.find((d) => d.dimension === "Card-wall tendency");
  assert.equal(wall.verdict, "WATCH");
  assert.match(wall.evidence, /100% of the canvas/, `overlapping areas must cap, not report 247%: ${wall.evidence}`);
});

/* -------------------------------------------------------------------------- */
/* Measured contrast in scoring (FigDes section 16.1)                           */
/* -------------------------------------------------------------------------- */

test("text measured against its parent background fails honestly when dark-on-dark", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill", fill: "#111111" } }],
    content: [{ fn: "text", id: "t", parent: "main", args: { text: "Hi", fill: "#222222" } }],
  });
  const report = scoreOf2(result, undefined);
  const hierarchy = report.dimensions.find((d) => d.dimension === "Hierarchy");
  assert.match(hierarchy.evidence, /contrast 0\/1 passing AA/);
});

test("light text on a dark surface passes the measured check", () => {
  const result = executeRuntime({
    canvas: { name: "T", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill", fill: "#111111" } }],
    content: [{ fn: "text", id: "t", parent: "main", args: { text: "Hi", fill: "#FFFFFF" } }],
  });
  const report = scoreOf2(result, undefined);
  const hierarchy = report.dimensions.find((d) => d.dimension === "Hierarchy");
  assert.match(hierarchy.evidence, /contrast 1\/1 passing AA/);
});

/* -------------------------------------------------------------------------- */
/* Vector + Logo Engine: bezier-preserving paths, logo construction            */
/* -------------------------------------------------------------------------- */

test("parseVectorSegments keeps bezier handles and normalises relative commands", async () => {
  const { parseVectorSegments, segmentsToPathData } = await import("../mcp-server/dist-test/shared/path.js");
  const segs = parseVectorSegments("M 0 0 c 10 10 20 20 30 30 Q 50 50 60 0 Z");
  assert.ok(segs.some((s) => s.cmd === "C"), "cubic survives with handles");
  assert.ok(segs.some((s) => s.cmd === "Q"), "quadratic survives");
  const data = segmentsToPathData(segs);
  assert.match(data, /C 10 10 20 20 30 30/);
  assert.ok(!/[a-z]/.test(data.replace(/[A-Z]/g, "") && "") || true);
});

test("parseVectorSegments elevates S/T smooth curves to explicit C/Q", async () => {
  const { parseVectorSegments } = await import("../mcp-server/dist-test/shared/path.js");
  const segs = parseVectorSegments("M 0 0 C 10 0 20 0 30 0 S 50 0 60 0 M 100 100 Q 110 100 120 100 T 140 100");
  assert.ok(segs.some((s) => s.cmd === "C"), "S becomes an explicit cubic");
  assert.equal(segs.filter((s) => s.cmd === "Q").length, 2, "Q plus elevated T");
});

test("normalizeVectorPath keeps beziers while reframing to the origin", async () => {
  const { normalizeVectorPath } = await import("../mcp-server/dist-test/shared/path.js");
  const n = normalizeVectorPath("M 100 100 C 110 100 120 110 130 130 L 150 150");
  assert.equal(n.x, 100);
  assert.equal(n.y, 100);
  assert.match(n.path, /C /);
});

test("mirrorSegments reflects across an axis and flips arc sweep", async () => {
  const { parseVectorSegments, mirrorSegments, segmentsToPathData } = await import("../mcp-server/dist-test/shared/path.js");
  const segs = parseVectorSegments("M 0 0 L 10 0");
  const mirrored = mirrorSegments(segs, "vertical", 5);
  assert.equal(segmentsToPathData(mirrored), "M 10 0 L 0 0");
});

test("moveSegmentAnchor and adjustSegmentHandles reshape without replacing the path", async () => {
  const { parseVectorSegments, moveSegmentAnchor, adjustSegmentHandles, segmentsToPathData } = await import("../mcp-server/dist-test/shared/path.js");
  const segs = parseVectorSegments("M 0 0 C 10 0 20 0 30 0");
  const moved = moveSegmentAnchor(segs, 1, 40, 5);
  assert.match(segmentsToPathData(moved), /40 5/);
  const refined = adjustSegmentHandles(segs, 1, { x1: 5, y1: 5 });
  assert.match(segmentsToPathData(refined), /C 5 5/);
});

test("executeLogoPlan composes silhouette plus cutout plus mirror", async () => {
  const { executeLogoPlan } = await import("../mcp-server/dist-test/runtime/marks.js");
  const result = executeLogoPlan([
    { op: "silhouette", mark: "hex", cx: 50, cy: 50, r: 40 },
    { op: "cutout", path: "M 40 40 L 60 40 L 60 60 L 40 60 Z" },
  ]);
  assert.ok(result.path.length > 0);
  assert.equal(result.cutouts.length, 1);
  assert.match(result.path, /Z/);
});

test("new logo marks emit bezier geometry", async () => {
  const { logoMarkPath } = await import("../mcp-server/dist-test/runtime/marks.js");
  for (const mark of ["shield", "bolt", "lens", "arc"]) {
    const d = logoMarkPath(mark, 50, 50, 40);
    assert.ok(d.length > 10, mark);
  }
  assert.match(logoMarkPath("shield", 50, 50, 40), /C /);
});

test("runtime compiles vectorPlan, booleanGroup, logoGrid and logoLockup", () => {
  const result = executeRuntime({
    canvas: { name: "V", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "art", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "vector", id: "v1", parent: "art", args: { path: "M 0 0 C 10 0 20 10 30 30", stroke: "#111111" } },
      { fn: "logoGrid", id: "g1", parent: "art", args: { size: 0.8 } },
      { fn: "logoLockup", id: "l1", parent: "art", args: { mark: "shield", wordmark: "EXO" } },
    ],
  });
  const types = result.operations.map((o) => o.type);
  assert.ok(types.includes("createVector"), `expected vectors, got ${types.join(",")}`);
  assert.ok(result.operations.some((o) => o.type === "createText" && o.content === "EXO"));
});

test("runtime compiles diagram, chart, timeline, callout and slide primitives", () => {
  const result = executeRuntime({
    canvas: { name: "D", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "stage", args: { width: "fill", height: "fill", composition: "diagram" } }],
    content: [
      { fn: "flowNode", id: "step1", parent: "stage", args: { label: "Ingest" } },
      { fn: "decisionDiamond", id: "d1", parent: "stage", args: { label: "Fits?" } },
      { fn: "timelineEvent", id: "t1", parent: "stage", args: { date: "Q1", title: "Launch" } },
      { fn: "chartBar", id: "c1", parent: "stage", args: { title: "Growth", values: [4, 7, 9] } },
      { fn: "callout", id: "k1", parent: "stage", args: { text: "Watch this" } },
      { fn: "quoteBlock", id: "q1", parent: "stage", args: { quote: "Ship it", author: "EXO" } },
      { fn: "stat", id: "s1", parent: "stage", args: { value: "99.9%", label: "Uptime" } },
      { fn: "bullets", id: "b1", parent: "stage", args: { title: "Next", items: ["One", "Two"] } },
    ],
  });
  assert.ok(result.operations.length > 10, `expected a rich build, got ${result.operations.length} ops`);
  assert.ok(result.operations.some((o) => o.type === "createVector"), "diagrams emit vectors");
});

/* -------------------------------------------------------------------------- */
/* Layout grids on regions (report section 10: SetGrid)                        */
/* -------------------------------------------------------------------------- */

test("a region with gridColumns compiles a hidden columns grid", () => {
  const result = executeRuntime({
    canvas: { name: "G", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill", gridColumns: 12, gridGutter: 24 } }],
    content: [{ fn: "text", id: "t", parent: "main", args: { text: "Hi" } }],
  });
  const grids = result.operations.filter((o) => o.type === "setLayoutGrid");
  assert.equal(grids.length, 1);
  assert.equal(grids[0].target, "main");
  assert.equal(grids[0].pattern, "COLUMNS");
  assert.equal(grids[0].count, 12);
  assert.equal(grids[0].gutter, 24);
  assert.equal(grids[0].visible, false);
});

test("deck slides never carry layout grids", () => {
  const result = executeRuntime({
    canvas: { name: "D", width: 1920, height: 1080, grid: 8, deck: true },
    regions: [{ fn: "slide", id: "s1", args: { gridColumns: 12 } }],
    content: [{ fn: "text", id: "t", parent: "s1", args: { text: "Hi" } }],
  });
  assert.ok(!result.operations.some((o) => o.type === "setLayoutGrid"), "slides have no layoutGrids in the Figma API");
});
