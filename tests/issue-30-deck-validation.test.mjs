/**
 * Issue #30, phase 2: deck-bound geometry validation.
 *
 * ## Why this file exists
 *
 * For deck:true compiles, every post-layout geometry assertion was skipped: no
 * `assertResolvedGeometry`, no `checkTextFit`, no `verifyOperationTrace`. That
 * exemption made sense for layout and text (the slides engine recomputes slide
 * geometry at render time), but it also skipped the *bounds*, which are decided
 * at compile time — every slide region is assigned a fixed 1920x1080 box before
 * anything is placed — so a slide child resolved past the slide edge or at
 * negative coordinates compiled silently and rendered as invisible content.
 *
 * `assertSlideBounds` (beside `assertResolvedGeometry` in compile.ts) closes that
 * hole without touching the render-time exemptions: it checks each slide
 * region's resolved geometry and every child's absolute box against the slide
 * bounds, and records violations in the same vocabulary (rule "containment",
 * gated by the BLOCKING set; `overflow: "allow"` maps to the advisory
 * `containment-allowed`) so deck compiles gate exactly like canvas compiles do.
 *
 * These tests run `compileIR` directly (the invariant-fixture style) so the
 * assertions measure the compiler alone, plus one end-to-end pass through the
 * runtime interpreter to prove the gate survives the whole pipeline. Fully
 * offline: no fixtures, no network, no Figma.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** In-bounds yet arbitrary canvas: the deck branch overrides it to 1920x1080. */
const DECK_CANVAS = { name: "Slides", width: 1440, height: 900, grid: 8, deck: true };

/** A plain deck program (invariants.test.mjs fixture style), overridable. */
function deckIR({ canvas = DECK_CANVAS, regions, content } = {}) {
  return {
    canvas: { ...canvas },
    regions,
    content,
    tokens: [],
    relations: [],
  };
}

const isBoundsRule = (rule) => rule === "containment" || rule === "containment-allowed" || rule === "geometry";
const boundsViolations = (compiled) => compiled.violations.filter((v) => isBoundsRule(v.rule));
/** Violations whose message names the node id the way the compiler names ids. */
const naming = (compiled, id) => compiled.violations.filter((v) => v.message.includes(`'${id}'`));

/* -------------------------------------------------------------------------- */
/* In-bounds decks stay clean                                                  */
/* -------------------------------------------------------------------------- */

test("a deck child fully inside the 1920x1080 slide compiles with no bounds violations", () => {
  const compiled = compileIR(
    deckIR({
      regions: [{ id: "s1", role: "slide", width: "fill", height: "fill", children: ["t1"] }],
      content: [{ kind: "text", id: "t1", text: "Section one", role: "title" }],
    }),
  );

  assert.deepEqual(
    boundsViolations(compiled),
    [],
    `in-bounds slide content must not raise containment/geometry findings: ${JSON.stringify(compiled.violations)}`,
  );
  assert.equal(compiled.applicable, true, "the in-bounds deck still compiles applicable");
});

/* -------------------------------------------------------------------------- */
/* Out-of-bounds decks are caught                                              */
/* -------------------------------------------------------------------------- */

test("a deck child past the right/bottom slide edge is a containment violation naming the node", () => {
  const compiled = compileIR(
    deckIR({
      regions: [{ id: "s1", role: "slide", width: "fill", height: "fill", children: ["t1", "wide"] }],
      content: [
        { kind: "text", id: "t1", text: "Section one", role: "title" },
        // Explicit extents are the one content kind the offline layout cannot
        // shrink to fit: a 2400px-wide instance on a 1920px slide.
        { kind: "instance", id: "wide", componentId: "EXO-chart", width: 2400, height: 1200 },
      ],
    }),
  );
  const found = naming(compiled, "wide").filter((v) => isBoundsRule(v.rule));

  assert.ok(found.length >= 1, `the off-slide child must be named: ${JSON.stringify(compiled.violations)}`);
  assert.equal(found[0].rule, "containment", "an off-slide child gates as containment, not as advice");
  assert.match(found[0].message, /outside its slide 's1'/, `the violation must name the slide: ${found[0].message}`);
});

test("negative coordinates on a slide raise the same containment violation", () => {
  const compiled = compileIR(
    deckIR({
      regions: [
        {
          id: "s1",
          role: "slide",
          width: "fill",
          height: "fill",
          // Schema-legal negative padding pushes the slide's inner box off the
          // slide origin, so children place at negative slide coordinates.
          padding: { top: -1400, right: 0, bottom: 0, left: -1200 },
          children: ["t1"],
        },
      ],
      content: [{ kind: "text", id: "t1", text: "Section one", role: "title" }],
    }),
  );
  const found = naming(compiled, "t1").filter((v) => isBoundsRule(v.rule));

  assert.ok(found.length >= 1, `negative placement must be named: ${JSON.stringify(compiled.violations)}`);
  assert.equal(found[0].rule, "containment");
  assert.match(found[0].message, /outside its slide 's1'/, `the violation must name the slide: ${found[0].message}`);
});

/* -------------------------------------------------------------------------- */
/* Non-deck behaviour is unchanged                                             */
/* -------------------------------------------------------------------------- */

test("a canvas program with the equivalent out-of-bounds child behaves exactly as before", () => {
  const compiled = compileIR({
    canvas: { name: "Screen", width: 1440, height: 900, grid: 8, deck: false },
    regions: [{ id: "body", role: "content", width: "fill", height: "fill", children: ["big"] }],
    content: [{ kind: "instance", id: "big", componentId: "EXO-chart", width: 2400, height: 1200 }],
    tokens: [],
    relations: [],
  });
  const found = naming(compiled, "big").filter((v) => isBoundsRule(v.rule));

  // assertResolvedGeometry's canvas containment was already catching this
  // class; the deck wiring must not have weakened it.
  assert.ok(found.length >= 1, "an out-of-bounds canvas child is still caught");
  assert.equal(found[0].rule, "containment");
  // And its wording is the canvas one, not the deck one.
  assert.match(found[0].message, /outside its region 'body'/, `unchanged canvas wording: ${found[0].message}`);
  assert.doesNotMatch(found[0].message, /slide/, "the deck wording must not leak into canvas builds");
});

test("a clean canvas program stays clean and applied", () => {
  const compiled = compileIR({
    canvas: { name: "Generated", width: 1600, height: 1000, grid: 8 },
    regions: [
      { id: "nav", role: "navigation", width: 240, height: "fill", children: ["t1", "m1"] },
      { id: "body", role: "content", width: "fill", height: "fill", children: ["t2"] },
    ],
    content: [
      { kind: "text", id: "t1", text: "Machines" },
      { kind: "component", id: "m1", type: "metric", props: { label: "GPUs", value: "8" } },
      { kind: "text", id: "t2", text: "Topology" },
    ],
    tokens: [],
    relations: [],
  });

  assert.deepEqual(
    boundsViolations(compiled),
    [],
    `a clean canvas program must still compile clean: ${JSON.stringify(compiled.violations)}`,
  );
  assert.equal(compiled.applicable, true);
});

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

test("the deck bounds violation carries the same shape the blocking gate reads", () => {
  const compiled = compileIR(
    deckIR({
      regions: [{ id: "s1", role: "slide", width: "fill", height: "fill", children: ["wide"] }],
      content: [{ kind: "instance", id: "wide", componentId: "EXO-chart", width: 2400, height: 1200 }],
    }),
  );
  const containment = compiled.violations.filter((v) => v.rule === "containment");

  assert.ok(containment.length >= 1, `expected a containment violation: ${JSON.stringify(compiled.violations)}`);
  // assertResolvedGeometry records {rule, message} and nothing else; the deck
  // bounds check must match that shape exactly.
  assert.deepEqual(Object.keys(containment[0]).sort(), ["message", "rule"]);
  // The BLOCKING gate (compile.ts) refuses the screen on those messages.
  assert.equal(compiled.applicable, false, "an out-of-bounds deck must not present as applicable");
  for (const v of containment) {
    assert.ok(
      compiled.inapplicableReasons.includes(v.message),
      `the message must gate: ${v.message}`,
    );
  }
});

test("the render-time exemptions are preserved for decks", () => {
  const compiled = compileIR(
    deckIR({
      regions: [{ id: "s1", role: "slide", width: "fill", height: "fill", children: ["wide"] }],
      content: [{ kind: "instance", id: "wide", componentId: "EXO-chart", width: 2400, height: 1200 }],
    }),
  );

  // Slide geometry is recomputed by the slides engine at render time, so text
  // fit and the operation trace stay unchecked for decks even now that bounds
  // are asserted at compile time.
  const forbidden = compiled.violations.filter((v) => v.rule === "operation-trace" || v.rule === "text-bounds");
  assert.deepEqual(forbidden, [], "deck builds must stay exempt from trace and text-fit findings");
  assert.equal(compiled.stats.traceMismatches, 0, "the trace recount stays zero for decks");
});

test("the gate holds end to end through the runtime interpreter", () => {
  const result = executeRuntime({
    canvas: { name: "Slides", width: 1440, height: 900, grid: 8, deck: true },
    regions: [{ fn: "frame", id: "s1", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "text", id: "t1", parent: "s1", args: { text: "Section one", role: "title" } },
      { fn: "instance", id: "wide", parent: "s1", args: { componentId: "EXO-chart", width: 2400, height: 1200 } },
    ],
  });

  assert.ok(
    result.violations.some((v) => v.rule === "containment" && v.message.includes("'wide'")),
    `the deck bounds violation must survive the interpreter: ${JSON.stringify(result.violations)}`,
  );
  assert.equal(result.applicable, false, "an out-of-bounds deck is refused by the interpreter's applicability gate");
});
