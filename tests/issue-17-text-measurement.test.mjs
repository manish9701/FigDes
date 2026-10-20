/**
 * Issue #17 — the text measurement round-trip.
 *
 * The compiler lays a screen out from estimates: a character-count heuristic
 * for how many lines a string takes. That is close enough to place a screen
 * and nowhere near close enough to be the truth, and the difference shows up
 * as a dry run that disagrees with the screen Figma builds.
 *
 * These tests prove the round-trip works:
 *
 * 1. The plugin measures a string the way the renderer will draw it, and
 *    leaves nothing behind.
 * 2. The compiler uses the measurement rather than its own estimate — the mock
 *    wraps with a deliberately different ratio, so the two numbers differ and
 *    the test can tell which one was used.
 * 3. A layout that overflows because of a wrong height is caught, not shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { loadPlugin, ask, makeDocument } from "./plugin-harness.mjs";

const text = (id, o = {}) => ({ id, kind: "text", text: "Label", role: "body", ...o });

test("the plugin measures a string and leaves nothing behind", async () => {
  const { figma, doc } = loadPlugin(makeDocument());
  const before = doc.page.children.length;
  const reply = await ask(figma, "measure_text", {
    specs: [{ key: "a", text: "A string long enough to need more than one line at fourteen pixels", family: "Inter", style: "Regular", size: 14, width: 120 }],
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const measured = reply.data.measurements ?? [];
  assert.equal(measured.length, 1, JSON.stringify(reply.data));
  assert.ok(measured[0].height > 0, "the measurement carried no height");
  assert.ok(measured[0].height >= 14, "a measured line is at least one line tall");
  // The measurement is a read: it leaves nothing in the document.
  assert.equal(doc.page.children.length, before, "the measurement left a node behind");
});

test("the compiler uses the measurement rather than its own estimate", () => {
  const ir = {
    canvas: { name: "Measured", width: 400, height: 600, grid: 8, newPage: false, deck: false },
    regions: [
      {
        id: "main",
        role: "content",
        composition: "auto",
        layout: "flow",
        width: "fill",
        height: "fill",
        grow: 0,
        children: ["t1", "t2"],
        elevation: 0,
      },
    ],
    content: [
      text("t1", { text: "One", role: "body" }),
      text("t2", { text: "Two", role: "body" }),
    ],
    relations: [],
    tokens: [],
    links: [],
  };

  const estimated = compileIR(ir);
  const measured = compileIR(
    ir,
    new Map([
      ["t1", { width: 360, height: 200 }],
      ["t2", { width: 360, height: 200 }],
    ]),
  );

  // The estimate places the second text right after the first; the
  // measurement says the first one is much taller, so the second one moves.
  const estimatedSecond = estimated.boxes.get("t2");
  const measuredSecond = measured.boxes.get("t2");
  assert.ok(estimatedSecond && measuredSecond, "a text node had no resolved box");
  assert.notEqual(
    Math.round(estimatedSecond.y),
    Math.round(measuredSecond.y),
    "the measured height did not move the text that follows it",
  );
  assert.ok(
    Math.round(measuredSecond.y) > Math.round(estimatedSecond.y),
    "the measured height moved the following text the wrong way",
  );
});

test("a text that overflows its region is refused, not shipped", () => {
  // The region's height cannot hold the content, and the content is not
  // allowed to leave: the build has to fail rather than produce a screen whose
  // text hangs outside its frame.
  const ir = {
    canvas: { name: "Overflow", width: 400, height: 200, grid: 8, newPage: false, deck: false },
    regions: [
      {
        id: "main",
        role: "content",
        composition: "auto",
        layout: "flow",
        width: "fill",
        height: 120,
        grow: 0,
        children: ["t1"],
        elevation: 0,
        overflow: "forbid",
      },
    ],
    content: [text("t1", { text: "A string that will not fit in a hundred and twenty pixels of height at fourteen pixels a line, not even close", role: "body" })],
    relations: [],
    tokens: [],
    links: [],
  };
  const result = compileIR(ir, new Map([["t1", { width: 380, height: 400 }]]));
  // The content cannot fit the region, so the region grows to hold it — and
  // then the region runs past the canvas. Either way the build is refused:
  // what must not happen is a screen whose text hangs outside its frame.
  const refusal = result.violations.filter(
    (v) => v.rule === "containment" || v.rule === "containment-allowed" || v.rule === "geometry",
  );
  assert.ok(refusal.length > 0, `the overflow was not reported: ${JSON.stringify(result.violations)}`);
  assert.equal(result.applicable, false, "a build whose content escapes its region was still applicable");
});
