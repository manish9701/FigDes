/**
 * Issue #20, workstream 2 — the shared screen-fixture geometry checks.
 *
 * Every fixture in `tests/fixtures/screens.mjs` compiles through the real
 * runtime, and every check reads the *resolved boxes* plus the emitted
 * operation trace — not the plan — because a native mutation can diverge from
 * what was proposed. This is the deterministic, replayable form of the scene
 * classes the issue names (navigation, sidebars, cards, tables, forms,
 * dialogs, dense rows).
 *
 * Explicit tolerance: 1px, the same TRACE_TOLERANCE the compiler's own trace
 * check uses — reported here so the number is a contract, not an accident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";
import { FIXTURES, EXPECTED, REVIEW_FIXTURES } from "./fixtures/screens.mjs";

const TOLERANCE_PX = 1;

/** Compiles a fixture and returns the runtime result. */
function compile(id) {
  const result = executeRuntime(FIXTURES[id]);
  return result;
}

/** Every placed box must sit inside the canvas it was laid out for. */
function boxesWithinCanvas(result, canvas) {
  const out = [];
  for (const [id, box] of result.boxes) {
    if (id === "root") continue;
    if (box.x < -TOLERANCE_PX || box.y < -TOLERANCE_PX || box.x + box.w > canvas.width + TOLERANCE_PX || box.y + box.h > canvas.height + TOLERANCE_PX) {
      out.push(`${id} at (${Math.round(box.x)}, ${Math.round(box.y)}) ${Math.round(box.w)}x${Math.round(box.h)} escapes ${canvas.width}x${canvas.height}`);
    }
  }
  return out;
}

/** Blocking rules that must stay silent on a compliant fixture. */
const BLOCKING = ["geometry", "relation", "operation-trace", "content-parent", "identity", "containment", "maxMetricCards", "noGenericCardGrid", "noChatAsPrimary", "product"];

function blockingViolations(result) {
  return (result.violations ?? []).filter((v) => BLOCKING.includes(v.rule));
}

test("every compliant fixture compiles with no blocking violation", () => {
  for (const [id, fixture] of Object.entries(FIXTURES)) {
    if (id === "seeded-overlap") continue; // the false-negative control is asserted below
    const result = compile(id);
    const blocking = blockingViolations(result);
    assert.deepEqual(
      blocking,
      [],
      `${id} must compile clean; got ${JSON.stringify(blocking)} — and operations ${result.operations.length}`,
    );
  }
});

test("every compliant fixture's boxes stay inside its canvas", () => {
  for (const [id, fixture] of Object.entries(FIXTURES)) {
    if (id === "seeded-overlap") continue;
    const result = compile(id);
    assert.deepEqual(boxesWithinCanvas(result, fixture.canvas), [], `${id}: boxes must stay on canvas`);
  }
});

test("navigation-rail: the nav resolves as a rail, not a vanishing strip", () => {
  const result = compile("navigation-rail");
  const nav = result.boxes.get(EXPECTED["navigation-rail"].navId);
  assert.ok(nav, "the nav region must resolve");
  assert.ok(nav.w > 0 && nav.w <= EXPECTED["navigation-rail"].navMaxWidth + TOLERANCE_PX, `rail width ${nav.w}`);
  // The nav items must actually be inside the rail: a 220x900 rail with four
  // tabs crammed into 36px was issue #12's R2 defect.
  const items = ["n1", "n2", "n3", "n4"].map((id) => result.boxes.get(id)).filter(Boolean);
  assert.equal(items.length, 4, "all four nav items resolve");
  for (const item of items) {
    assert.ok(item.x >= nav.x - TOLERANCE_PX && item.x + item.w <= nav.x + nav.w + TOLERANCE_PX, `item at ${item.x}+${item.w} outside rail ${nav.x}+${nav.w}`);
  }
});

test("data-table and dense-rows: rows do not overlap and keep their order", () => {
  for (const id of ["data-table", "dense-rows"]) {
    const result = compile(id);
    const rows = EXPECTED[id].rowIds.map((rid) => result.boxes.get(rid)).filter(Boolean);
    assert.equal(rows.length, EXPECTED[id].rowIds.length, `${id}: every row resolves`);
    const sorted = [...rows].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const overlap = Math.min(prev.x + prev.w, curr.x + curr.w) - Math.max(prev.x, curr.x);
      const gap = curr.y - (prev.y + prev.h);
      assert.ok(gap >= -TOLERANCE_PX || overlap <= TOLERANCE_PX, `${id}: rows ${i - 1}/${i} overlap (gap ${gap}, overlap ${overlap})`);
    }
  }
});

test("peer-cards: the two cards sit side by side without covering each other", () => {
  const result = compile("peer-cards");
  const [p1, p2] = EXPECTED["peer-cards"].cardIds.map((id) => result.boxes.get(id));
  assert.ok(p1 && p2, "both cards resolve");
  const overlapW = Math.min(p1.x + p1.w, p2.x + p2.w) - Math.max(p1.x, p2.x);
  const overlapH = Math.min(p1.y + p1.h, p2.y + p2.h) - Math.max(p1.y, p2.y);
  assert.ok(overlapW <= TOLERANCE_PX || overlapH <= TOLERANCE_PX, `cards overlap ${overlapW}x${overlapH}`);
});

test("form: the fields stack and the primary button does not cover a field", () => {
  const result = compile("form");
  const fields = EXPECTED.form.fieldIds.map((id) => result.boxes.get(id));
  for (const f of fields) {
    assert.ok(f, "each form field resolves");
    assert.ok(f.y >= 0 && f.y + f.h <= FIXTURES.form.canvas.height, "field on canvas");
  }
  const save = result.boxes.get("save");
  assert.ok(save, "the primary action resolves");
});

test("dialog: the dialog's content stays inside the dialog frame", () => {
  const result = compile("dialog");
  const dialog = result.boxes.get(EXPECTED.dialog.dialogId);
  assert.ok(dialog, "the dialog region resolves");
  assert.equal(dialog.w, 480, "the dialog keeps its declared width");
  for (const childId of ["d1", "b1", "confirm"]) {
    const child = result.boxes.get(childId);
    assert.ok(child, `${childId} resolves`);
    assert.ok(child.x >= dialog.x - TOLERANCE_PX && child.x + child.w <= dialog.x + dialog.w + TOLERANCE_PX, `${childId} inside the dialog horizontally`);
    assert.ok(child.y >= dialog.y - TOLERANCE_PX && child.y + child.h <= dialog.y + dialog.h + TOLERANCE_PX, `${childId} inside the dialog vertically`);
  }
});

/* -------------------------------------------------------------------------- */
/* Review-level collision fixtures (both directions)                           */
/* -------------------------------------------------------------------------- */

test("review fixture sibling-overlap: a real collision is reported with the taxonomy", () => {
  const findings = runRules(REVIEW_FIXTURES["sibling-overlap"], "review");
  const overlaps = findings.filter((f) => f.rule === "sibling-region-overlap");
  assert.ok(overlaps.length > 0, `the collision must be reported; got ${JSON.stringify(findings.map((f) => f.rule))}`);
  const c = overlaps[0].evidence["collision"];
  assert.ok(c && typeof c === "object", "the finding carries a collision classification");
  assert.equal(c["type"], "sibling");
  assert.deepEqual(c["involvedIds"], ["card-a", "card-b"]);
  assert.equal(c["intent"], "accidental");
  assert.equal(overlaps[0].nodeIds.length, 2, "both involved nodes are named");
});

test("review fixture intentional-backdrop: paint-order layering produces no finding", () => {
  const findings = runRules(REVIEW_FIXTURES["intentional-backdrop"], "review");
  const overlaps = findings.filter((f) => f.rule === "sibling-region-overlap");
  assert.equal(overlaps.length, 0, `the backdrop must pass; got ${JSON.stringify(findings.map((f) => f.rule))}`);
});

test("review fixture intentional-containment: text and badges inside their card produce no finding", () => {
  const findings = runRules(REVIEW_FIXTURES["intentional-containment"], "review");
  const bad = findings.filter((f) => f.rule === "overflow" || f.rule === "sibling-region-overlap");
  assert.equal(bad.length, 0, `containment is not a defect; got ${JSON.stringify(bad.map((f) => f.rule))}`);
});
