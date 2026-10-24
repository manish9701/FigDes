/**
 * Issue #25 — sparse-band vertical redistribution.
 *
 * Phase B vision evidence (artifacts/design-benchmark/live/vision-phase-b-fresh.json)
 * recorded every live fixture screen structurally clean but SPARSE: content
 * hugs the top-left of its band and 60-90% of the canvas below stays one empty
 * band. The layout pipeline was one-directional — regions are sized, content
 * packs from the region's top, and the fit passes only grow or shrink the
 * frame — so nothing ever asked where the content should sit inside the final
 * band.
 *
 * The two mechanisms pinned here:
 *
 *   1. Vertical redistribution inside content bands: a band whose content
 *      fills at most 60% of it gets the leftover split around the content
 *      block (centred), per the intent — `alignment: "strong"` keeps the
 *      top-anchored placement it declared. Boxes and emitted operations move
 *      together, so the trace check keeps proving them.
 *   2. Hug-height bands: a band whose height is no member's declaration (no
 *      `fill`, no fixed height) hugs its content instead of pinning it against
 *      the shell's 1px floor; the fit passes hand the freed structure to the
 *      bands that do own content.
 *
 * Honesty guardrails pinned: nothing is stretched or scaled to fill, no
 * content is invented, declared fill/hug band semantics are untouched, and
 * every refusal is reported on the payload rather than done silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";

const text = (id, str, o = {}) => ({ id, kind: "text", text: str, role: "body", ...o });
const component = (id, type, props = {}) => ({ id, kind: "component", type, props });

/**
 * The exo-model-detail fixture shape: one full-canvas band on 1440x900 holding
 * a headline, two instrument readouts and a status pill — 3-4 content items
 * that measured ~250px against a 900px band in the recorded evidence.
 */
function sparseIR({ alignment } = {}) {
  return {
    canvas: { name: "Model detail", width: 1440, height: 900, grid: 8, newPage: false, deck: false },
    regions: [
      {
        id: "detail",
        role: "inspector",
        composition: "auto",
        layout: "flow",
        width: "fill",
        height: "fill",
        grow: 0,
        children: ["t", "m1", "m2", "st"],
        elevation: 0,
      },
    ],
    content: [
      text("t", "atlas-7b [fixture]", { role: "title" }),
      component("m1", "metric", { label: "Memory", value: "41 GB" }),
      component("m2", "metric", { label: "Throughput", value: "88 tok/s" }),
      component("st", "statusPill", { label: "fits [fixture]", tone: "success" }),
    ],
    relations: [],
    tokens: [],
    links: [],
    ...(alignment !== undefined ? { visualIntent: { alignment } } : {}),
  };
}

/** Text metrics matching the fixture headline, so the block is fully measured. */
const MEASURED = new Map([["t", { width: 360, height: 32 }]]);

const block = (compiled, ids) => {
  const boxes = ids.map((id) => compiled.boxes.get(id));
  assert.ok(boxes.every(Boolean), "a content box is missing from the resolved geometry");
  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { boxes, top, bottom, h: bottom - top };
};

test("sparse content in a fill band is centred, not left hugging the top", () => {
  const compiled = compileIR(sparseIR(), MEASURED);

  assert.equal(compiled.applicable, true, `the build is not applicable: ${JSON.stringify(compiled.inapplicableReasons)}`);
  // The trace check runs inside the compile: zero violations means every moved
  // box still agrees with its emitted operation.
  assert.deepEqual(
    compiled.violations.filter((v) => v.rule !== "product"),
    [],
    `no violations expected: ${JSON.stringify(compiled.violations)}`,
  );

  const region = compiled.boxes.get("detail");
  assert.ok(region, "the band region has no resolved box");
  // The band keeps the whole canvas: redistribution moves content INSIDE it.
  assert.equal(Math.round(region.h), 900, "the fill band gave up canvas height");
  assert.equal(Math.round(region.w), 1440, "the fill band gave up canvas width");

  const inner = { top: region.y, bottom: region.y + region.h };
  const content = block(compiled, ["t", "m1", "m2", "st"]);
  // Sparse by construction: ~250px of content in a 900px band.
  assert.ok(content.h <= 0.6 * region.h, "the fixture is not sparse — the test fixture drifted");
  const topGap = content.top - inner.top;
  const bottomGap = inner.bottom - content.bottom;
  assert.ok(
    Math.abs(topGap - bottomGap) <= 4,
    `the content block is not vertically balanced in its band: top gap ${Math.round(topGap)}px vs bottom gap ${Math.round(bottomGap)}px`,
  );

  // The payload reports the redistribution in the intentNotes style.
  const stats = compiled.stats;
  assert.ok(stats.redistribution, "the payload does not record the redistribution");
  assert.ok(stats.redistribution.pixels > 0, "the redistribution records no redistributed pixels");
  assert.equal(stats.redistribution.bands, 1, "the redistribution did not count the band");
  assert.match(
    stats.redistribution.note ?? "",
    /canvas redistribution: \d+px/,
    `the note is missing or malformed: ${JSON.stringify(stats.redistribution)}`,
  );
});

test("redistribution moves boxes and emitted operations together (parent-local)", () => {
  const compiled = compileIR(sparseIR(), MEASURED);
  const regionY = compiled.boxes.get("detail")?.y ?? 0;

  for (const id of ["t", "m1", "m2", "st"]) {
    const box = compiled.boxes.get(id);
    const op = compiled.operations.find((o) => (o.type === "createFrame" || o.type === "createText") && o.id === id);
    assert.ok(op, `'${id}' has no create operation`);
    // Content ops are parented to the region: the emitted position is local.
    assert.ok(
      Math.abs(op.y + regionY - box.y) <= 1,
      `'${id}' is emitted at canvas y=${Math.round(op.y + regionY)} but resolved to y=${Math.round(box.y)} — the trace disagrees`,
    );
    // Only position moves; nothing is stretched to fill.
    assert.equal(Math.round(op.width), Math.round(box.w), `'${id}' was resized by redistribution`);
  }
});

test("alignment 'strong' keeps the declared top-anchored flow and says so", () => {
  const compiled = compileIR(sparseIR({ alignment: "strong" }), MEASURED);

  assert.equal(compiled.applicable, true, `the build is not applicable: ${JSON.stringify(compiled.inapplicableReasons)}`);
  const region = compiled.boxes.get("detail");
  const content = block(compiled, ["t", "m1", "m2", "st"]);
  const topGap = content.top - region.y;
  const bottomGap = region.y + region.h - content.bottom;
  assert.ok(
    topGap <= 8 && bottomGap > topGap * 4,
    `strong alignment was not honoured: top gap ${Math.round(topGap)}px vs bottom gap ${Math.round(bottomGap)}px`,
  );
  const stats = compiled.stats;
  assert.ok(stats.redistribution, "the payload does not record the refusal");
  assert.equal(stats.redistribution.bands, 0, "a strong-alignment band was redistributed anyway");
  assert.ok(
    (stats.redistribution.notes ?? []).some((n) => n.includes("alignment")),
    `the refusal does not say why: ${JSON.stringify(stats.redistribution?.notes)}`,
  );
});

test("a program with declared fill/hug band semantics is not distorted", () => {
  // The issue-11 shape: header 64, then a fill map beside a fixed-width
  // inspector — every band height here is a declaration (fill or numeric).
  const ir = {
    canvas: { name: "Split", width: 1280, height: 800, grid: 8, newPage: false, deck: false },
    regions: [
      { id: "head", role: "header", composition: "auto", layout: "flow", width: "hug", height: 64, grow: 0, children: ["h-title"], elevation: 0 },
      { id: "map", role: "primary-visual", composition: "topology", layout: "topology", width: "fill", height: "fill", grow: 1, children: ["topo"], elevation: 0, overflow: "allow" },
      { id: "insp", role: "inspector", composition: "auto", layout: "flow", width: 340, height: 220, grow: 0, children: ["ins-0"], elevation: 0 },
    ],
    content: [
      text("h-title", "Fleet"),
      component("topo", "topologyMap", {
        title: "Fleet",
        nodes: [
          { id: "a", label: "hub", memory: "1.8 TB" },
          { id: "b", label: "n1", memory: "96 GB" },
          { id: "c", label: "n2" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "c" },
        ],
      }),
      component("ins-0", "panel", { title: "Panel 1" }),
    ],
    relations: [],
    tokens: [],
    links: [],
  };
  const compiled = compileIR(ir, new Map([["h-title", { width: 200, height: 32 }]]));

  assert.equal(compiled.applicable, true, `the build is not applicable: ${JSON.stringify(compiled.inapplicableReasons)}`);
  assert.deepEqual(
    compiled.violations.filter((v) => v.rule !== "product"),
    [],
    `no violations expected: ${JSON.stringify(compiled.violations)}`,
  );

  const region = (id) => compiled.boxes.get(id);
  const head = region("head");
  const map = region("map");
  const insp = region("insp");
  // The declared band semantics survive untouched: header 64, the fill band
  // takes the leftover (800 - 64 - 32 gutter = 704), the inspector shares the
  // band height — no region is stretched, shrunk or re-anchored to fake fullness.
  assert.equal(Math.round(head.h), 64, "the declared header height was changed");
  assert.equal(Math.round(map.h), 704, "the fill band's canvas-leftover height was changed");
  assert.equal(Math.round(map.w), 908, "the fill member's band width was changed");
  assert.equal(Math.round(insp.w), 340, "the declared inspector width was changed");
  assert.equal(Math.round(insp.h), 704, "the band-cohesive inspector height was changed");
  assert.equal(Math.round(insp.y), Math.round(map.y), "the band members no longer share a top edge");
  // The canvas-fit reflow did not run (no overflow): nothing was "given back"
  // by distorting declared bands.
  for (const r of compiled.regions ?? [head, map, insp]) {
    assert.ok(r.y + r.h <= 800 + 0.5, `${r.id} escapes the canvas bottom`);
  }
});

test("a content-only (hug) band hugs its content instead of collapsing", () => {
  // Both members state no height: the band's height is no one's declaration.
  const ir = {
    canvas: { name: "Hug band", width: 1280, height: 800, grid: 8, newPage: false, deck: false },
    regions: [
      { id: "board", role: "content", composition: "auto", layout: "flow", width: "fill", height: "hug", grow: 0, children: ["b-title"], elevation: 0 },
      { id: "insp", role: "inspector", composition: "auto", layout: "flow", width: 340, height: "hug", grow: 0, children: ["ins-0"], elevation: 0 },
    ],
    content: [
      text("b-title", "Board [fixture]"),
      component("ins-0", "panel", { title: "Panel 1" }),
    ],
    relations: [],
    tokens: [],
    links: [],
  };
  const compiled = compileIR(ir, new Map([["b-title", { width: 400, height: 24 }]]));

  // Before the repair this collapsed to 1px bands with the content outside
  // them (containment findings, build refused). The band now hugs its content.
  assert.equal(compiled.applicable, true, `the hug band still refuses: ${JSON.stringify(compiled.inapplicableReasons)}`);
  assert.deepEqual(
    compiled.violations.filter((v) => v.rule !== "product"),
    [],
    `no violations expected: ${JSON.stringify(compiled.violations)}`,
  );

  const board = compiled.boxes.get("board");
  const insp = compiled.boxes.get("insp");
  const ins0 = compiled.boxes.get("ins-0");
  const bTitle = compiled.boxes.get("b-title");
  // Hug means content-sized: the tallest member's content (the 90px panel)
  // sets the band, and no member holds empty canvas it cannot fill.
  assert.ok(Math.round(insp.h) >= 90, `the hug band did not grow to its content: ${Math.round(insp.h)}px`);
  assert.ok(
    Math.abs(ins0.y + ins0.h - (insp.y + insp.h)) <= 2 || ins0.y + ins0.h <= insp.y + insp.h,
    "the hug band grew past its content",
  );
  assert.ok(bTitle.y + bTitle.h <= board.y + board.h, "the board's content escapes its hugged band");
  // Declared semantics untouched: widths are exactly what was declared.
  assert.equal(Math.round(board.w), 908, "the fill-width member's width was changed");
  assert.equal(Math.round(insp.w), 340, "the declared inspector width was changed");
});

test("the shipped path (executeRuntime) balances the same sparse fixture", () => {
  const program = {
    canvas: { name: "FigDes Live — exo-model-detail", width: 1440, height: 900, grid: 8, fill: "#FFFDF9" },
    regions: [{ fn: "inspector", id: "detail", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "text", id: "t", parent: "detail", args: { text: "atlas-7b [fixture]", fontSize: 28 } },
      { fn: "metric", id: "m1", parent: "detail", args: { label: "Memory", value: "41 GB [fixture]", valueStyle: "technical" } },
      { fn: "metric", id: "m2", parent: "detail", args: { label: "Throughput", value: "88 tok/s [fixture]", valueStyle: "technical" } },
      { fn: "statusPill", id: "st", parent: "detail", args: { label: "fits [fixture]", tone: "success" } },
    ],
  };
  // The shipped path measures text between two compile passes; the second pass
  // carries the measurements, so redistribution balances on exact heights. The
  // measured height matches what a plugin measure pass would return for a
  // 28px title line.
  const runtime = executeRuntime(program);
  const compiled = compileIR(runtime.ir, new Map([["t", { width: 360, height: 32 }]]));

  assert.equal(compiled.applicable, true, `the shipped path refuses: ${JSON.stringify(compiled.inapplicableReasons)}`);
  const region = compiled.boxes.get("detail");
  const content = block(compiled, ["t", "m1", "m2", "st"]);
  const topGap = content.top - region.y;
  const bottomGap = region.y + region.h - content.bottom;
  assert.ok(
    Math.abs(topGap - bottomGap) <= 4,
    `the shipped path leaves the content top-hugging: top gap ${Math.round(topGap)}px vs bottom gap ${Math.round(bottomGap)}px`,
  );
  assert.ok(compiled.stats.redistribution, "the shipped payload does not record the redistribution");
});
