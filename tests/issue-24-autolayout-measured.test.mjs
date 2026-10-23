/**
 * Issue #24 follow-up — native auto-layout with measured text.
 *
 * The compiler used to refuse every text-holding region a native auto-layout
 * container, because text height was a character-count estimate and handing an
 * estimate to Figma's own layout moves every sibling below it. The runtime
 * already measures text through the plugin between two compile passes, so a
 * region whose text is ALL measured can be handed over: measured means exact,
 * estimates stay refused.
 *
 * These tests prove the gate, the emission and the reflow behaviour offline:
 *
 *   1. Measured text unlocks the container (layoutMode VERTICAL + spacing +
 *      padding on the frame, HEIGHT resize on the text, stats to prove it).
 *   2. Estimates-only text keeps absolute placement, and says why.
 *   3. A long wrapping label pushes the rows below it (measured, not guessed).
 *   4. Added and removed rows reflow: siblings stack in order with the gap.
 *   5. Partially measured text is still refused.
 *   6. The interpreter path honours measured text end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

const text = (id, str, o = {}) => ({ id, kind: "text", text: str, role: "body", ...o });

function listIR(children, { autoLayout = "vertical", layout = "flow" } = {}) {
  return {
    canvas: { name: "Auto", width: 400, height: 900, grid: 8, newPage: false, deck: false },
    regions: [
      {
        id: "list",
        role: "content",
        composition: "auto",
        layout,
        width: "fill",
        height: "fill",
        grow: 0,
        gap: 12,
        padding: 16,
        children: children.map((c) => c.id),
        elevation: 0,
        ...(autoLayout ? { autoLayout } : {}),
      },
    ],
    content: children,
    relations: [],
    tokens: [],
    links: [],
  };
}

const SHORT = "Short label";
const LONG =
  "A much longer label that wraps onto several lines once it is drawn at the width of the column, which is the whole point of measuring it";

const frameOp = (result, id) => result.operations.find((o) => o.type === "createFrame" && o.id === id);
const textOp = (result, id) => result.operations.find((o) => o.type === "createText" && o.id === id);
const autoViolations = (result) => result.violations.filter((v) => v.rule === "auto-layout");

test("measured text unlocks the native auto-layout container", () => {
  const ir = listIR([text("t1", SHORT), text("t2", LONG)]);
  const metrics = new Map([
    ["t1", { width: 336, height: 20 }],
    ["t2", { width: 336, height: 80 }],
  ]);
  const result = compileIR(ir, metrics);

  assert.equal(autoViolations(result).length, 0, JSON.stringify(autoViolations(result)));
  const frame = frameOp(result, "list");
  assert.ok(frame, "the region frame was not emitted");
  assert.equal(frame.layoutMode, "VERTICAL", "the frame is not a native auto-layout container");
  assert.equal(frame.itemSpacing, 12, "the container lost the region gap");
  assert.deepEqual(frame.padding, { top: 16, right: 16, bottom: 16, left: 16 }, "the container lost the region padding");
  assert.equal(frame.primaryAxisAlignItems, "MIN", "the container does not top-align its stack");
  assert.equal(frame.counterAxisAlignItems, "MIN", "the container does not left-align its stack");

  for (const id of ["t1", "t2"]) {
    const op = textOp(result, id);
    assert.ok(op, `text '${id}' was not emitted`);
    assert.equal(op.textAutoResize, "HEIGHT", `text '${id}' does not let the container size it`);
  }

  assert.equal(result.stats.nativeLayoutApplied, true, "the stats do not record the applied container");
  assert.equal(result.stats.measuredTextUsed, 2, "the stats do not count the measured text");
  assert.equal(result.applicable, true, `the measured build is not applicable: ${JSON.stringify(result.inapplicableReasons)}`);
});

test("estimates-only text keeps absolute placement, and says why", () => {
  const ir = listIR([text("t1", SHORT), text("t2", LONG)]);
  const result = compileIR(ir);

  const violations = autoViolations(result);
  assert.equal(violations.length, 1, "the declined container was not reported");
  assert.match(violations[0].message, /'list'/, "the violation does not name the region");
  assert.match(violations[0].message, /estimated/, "the violation does not say the heights are estimates");

  const frame = frameOp(result, "list");
  assert.ok(frame, "the region frame was not emitted");
  assert.equal(frame.layoutMode, undefined, "an estimates-only region was handed to Figma's own layout");
  assert.equal(result.stats.nativeLayoutApplied, false, "the stats do not record the declined container");
  assert.equal(result.stats.measuredTextUsed ?? 0, 0, "unmeasured text was counted as measured");

  for (const id of ["t1", "t2"]) {
    assert.equal(textOp(result, id)?.textAutoResize, undefined, `text '${id}' resizes for a container that does not exist`);
  }
});

test("a long wrapping label pushes the rows below it", () => {
  const children = [text("t1", SHORT), text("t2", LONG), text("t3", SHORT)];
  const estimated = compileIR(listIR(children));
  const measured = compileIR(
    listIR(children),
    new Map([
      ["t1", { width: 336, height: 20 }],
      // The measurement says the long label wraps to four lines.
      ["t2", { width: 336, height: 80 }],
      ["t3", { width: 336, height: 20 }],
    ]),
  );

  const estimatedThird = estimated.boxes.get("t3");
  const measuredThird = measured.boxes.get("t3");
  assert.ok(estimatedThird && measuredThird, "a row had no resolved box");
  assert.ok(
    Math.round(measuredThird.y) > Math.round(estimatedThird.y),
    "the measured wrap did not push the row below it down",
  );
  // The rows still stack in declaration order with the region gap.
  const b1 = measured.boxes.get("t1");
  const b2 = measured.boxes.get("t2");
  assert.ok(b1 && b2, "a row had no resolved box");
  assert.ok(Math.round(b2.y) >= Math.round(b1.y + b1.h + 12), "the second row overlaps the first");
  assert.ok(Math.round(measuredThird.y) >= Math.round(b2.y + b2.h + 12), "the third row overlaps the second");
});

test("added and removed rows reflow the stack", () => {
  const row = (id) => text(id, SHORT);
  const metricsFor = (ids) => new Map(ids.map((id) => [id, { width: 336, height: 20 }]));

  const two = compileIR(listIR([row("r1"), row("r2")]), metricsFor(["r1", "r2"]));
  const three = compileIR(listIR([row("r1"), row("r2"), row("r3")]), metricsFor(["r1", "r2", "r3"]));

  for (const result of [two, three]) {
    assert.equal(frameOp(result, "list")?.layoutMode, "VERTICAL", "the container was not applied");
  }

  const y = (result, id) => Math.round(result.boxes.get(id)?.y ?? NaN);
  // Even spacing: each row sits one measured height plus the gap below the last.
  assert.equal(y(two, "r2") - y(two, "r1"), 20 + 12, "the two-row stack is uneven");
  assert.equal(y(three, "r2") - y(three, "r1"), 20 + 12, "the three-row stack is uneven");
  assert.equal(y(three, "r3") - y(three, "r2"), 20 + 12, "the added row did not land below the second");
  // Removing the middle row pulls the last row up to where the second was.
  const removed = compileIR(listIR([row("r1"), row("r3")]), metricsFor(["r1", "r3"]));
  assert.equal(y(removed, "r3") - y(removed, "r1"), 20 + 12, "removing a row did not close the gap");
  assert.equal(y(removed, "r3"), y(two, "r2"), "the surviving row did not reflow into the freed slot");
});

test("partially measured text is still refused", () => {
  const ir = listIR([text("t1", SHORT), text("t2", LONG)]);
  const result = compileIR(ir, new Map([["t1", { width: 336, height: 20 }]]));

  const violations = autoViolations(result);
  assert.equal(violations.length, 1, "a half-measured region was handed to Figma's own layout");
  assert.match(violations[0].message, /'t2'/, "the violation does not name the unmeasured text");
  assert.equal(frameOp(result, "list")?.layoutMode, undefined, "the frame is an auto-layout container on estimates");
  assert.equal(result.stats.nativeLayoutApplied, false, "the stats claim a container that was declined");
});

test("mixed measured text and components apply as one container", () => {
  const ir = listIR([
    text("t1", SHORT),
    { id: "pill", kind: "component", type: "statusPill", props: { label: "Live" } },
  ]);
  const result = compileIR(ir, new Map([["t1", { width: 336, height: 20 }]]));

  assert.equal(autoViolations(result).length, 0, JSON.stringify(autoViolations(result)));
  assert.equal(frameOp(result, "list")?.layoutMode, "VERTICAL", "the mixed region was not handed to Figma's layout");
  assert.equal(textOp(result, "t1")?.textAutoResize, "HEIGHT", "the text does not let the container size it");
  assert.equal(result.stats.measuredTextUsed, 1, "the stats miscount the measured text");
});

test("a region with a non-flow layout still keeps absolute placement", () => {
  const ir = listIR([text("t1", SHORT)], { layout: "grid" });
  const result = compileIR(ir, new Map([["t1", { width: 336, height: 20 }]]));

  assert.equal(autoViolations(result).length, 1, "the non-flow container was not declined");
  assert.equal(frameOp(result, "list")?.layoutMode, undefined, "a grid region was built as a vertical stack");
});

test("the interpreter honours measured text end to end", () => {
  const program = {
    canvas: { name: "Measured", width: 400, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "list", args: { width: "fill", height: "fill", autoLayout: "vertical" } }],
    content: [
      { fn: "text", id: "t1", parent: "list", args: { text: SHORT } },
      { fn: "text", id: "t2", parent: "list", args: { text: LONG } },
    ],
  };
  const metrics = new Map([
    ["t1", { width: 336, height: 20 }],
    ["t2", { width: 336, height: 80 }],
  ]);

  const measured = executeRuntime(program, { textMetrics: metrics });
  assert.equal(measured.stats.nativeLayoutApplied, true, "the interpreter declined measured text");
  assert.equal(measured.stats.measuredTextUsed, 2, "the interpreter did not forward the measured count");
  const frame = measured.operations.find((o) => o.type === "createFrame" && o.id === "list");
  assert.equal(frame?.layoutMode, "VERTICAL", "the interpreter path did not build the container");

  const estimated = executeRuntime(program);
  assert.equal(estimated.stats.nativeLayoutApplied, false, "the interpreter applied a container on estimates");
  assert.ok(
    estimated.violations.some((v) => v.rule === "auto-layout"),
    "the interpreter did not report the declined container",
  );
});
