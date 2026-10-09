/**
 * Canonical geometry contract tests (quality-reliability P0).
 *
 * Every comparison happens inside one coordinate space. The live defect: a
 * rotated LINE reported absolute page coordinates (x=1935) compared against
 * parent-local dimensions (w=824) — a guaranteed false positive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toParentLocal, spillSides, isFiniteBox } from "../mcp-server/dist-test/shared/geometry.js";

test("absolute child inside parent converts to parent-local", () => {
  // Live shape: root at page x=1560, map at root x=256, line center rel 119.
  const rel = toParentLocal({ x: 1935, y: 412, w: 306, h: 0 }, { x: 1816, y: 112, w: 824, h: 600 });
  assert.deepEqual({ ...rel }, { x: 119, y: 300, w: 306, h: 0, space: "parent-local" });
  // Converted: 119+306=425 < 824, so the false-positive "right" spill is gone.
  assert.deepEqual(spillSides(rel, { w: 824, h: 600 }), []);
});

test("line outside in document coordinates but inside its parent does not spill", () => {
  const rel = toParentLocal({ x: 1700, y: 300, w: 200, h: 10 }, { x: 1560, y: 0, w: 1440, h: 900 });
  assert.deepEqual(spillSides(rel, { w: 1440, h: 900 }), []);
});

test("a truly overflowing line still spills", () => {
  const rel = toParentLocal({ x: 800, y: 100, w: 200, h: 10 }, { x: 0, y: 0, w: 500, h: 500 });
  assert.deepEqual(spillSides(rel, { w: 500, h: 500 }), ["right"]);
});

test("nested frames accumulate through two conversions", () => {
  const page = { x: 0, y: 0, w: 3000, h: 2000 };
  const root = toParentLocal({ x: 1560, y: 0, w: 1440, h: 900 }, page);
  const map = toParentLocal({ x: 1816, y: 112, w: 824, h: 600 }, { x: 1560, y: 0, w: 1440, h: 900 });
  assert.equal(root.x, 1560);
  assert.deepEqual({ x: map.x, y: map.y }, { x: 256, y: 112 });
  assert.deepEqual(spillSides(map, { w: 1440, h: 900 }), []);
});

test("negative local coordinates spill left/top", () => {
  assert.deepEqual(spillSides({ x: -3, y: 10, w: 50, h: 50 }, { w: 500, h: 500 }), ["left"]);
  assert.deepEqual(spillSides({ x: 10, y: -2, w: 50, h: 50 }, { w: 500, h: 500 }), ["top"]);
});

test("zero-size lines compare by position only", () => {
  assert.deepEqual(spillSides({ x: 100, y: 100, w: 0, h: 0 }, { w: 500, h: 500 }), []);
  assert.deepEqual(spillSides({ x: 600, y: 100, w: 0, h: 0 }, { w: 500, h: 500 }), ["right"]);
});

test("boundary tolerance absorbs rounding without hiding real spills", () => {
  assert.deepEqual(spillSides({ x: 0, y: 0, w: 500.4, h: 100 }, { w: 500, h: 500 }), []);
  assert.deepEqual(spillSides({ x: 0, y: 0, w: 502, h: 100 }, { w: 500, h: 500 }), ["right"]);
});

test("non-finite boxes never convert", () => {
  assert.equal(toParentLocal({ x: NaN, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 100 }), null);
  assert.equal(toParentLocal({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: Infinity, h: 100 }), null);
  assert.equal(isFiniteBox({ x: 0, y: 0, w: 10, h: 10 }), true);
  assert.equal(isFiniteBox({ x: 0, y: 0, w: -1, h: 10 }), false);
});
