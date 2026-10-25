/**
 * The EXO restrained-accent rule (issue #30, phase 2).
 *
 * ## What was missing
 *
 * The exo rule set already blocked *external* colours, so the palette discipline
 * only ever gated what came in from outside. Nothing measured what the program
 * itself resolved: a screen could carry red, green, blue and orange accents it
 * authored by hand, and the guard saw nothing to count. "An exo screen reads as
 * one system" was a taste, not a checkable fact.
 *
 * This pins down:
 *   1. the `hueFamilies` metric the snapshot now carries (distinct non-neutral
 *      hue families across the resolved style colours)
 *   2. `exo.restrained-accent` fires as a WARNING — advice, not a hard FAIL —
 *      with the measured count in its evidence, when the screen spans more
 *      than three hue families
 *   3. what must not count: near-greys in any quantity, repeats of one family,
 *      and colours the snapshot cannot resolve (token names, semantic words)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runGuard, snapshotFromIR } from "../mcp-server/dist-test/memory/guard.js";
import { EXO_RULES } from "../mcp-server/dist-test/memory/rules-exo.js";

const snapshotOf = (content, extra = {}) =>
  snapshotFromIR({
    regions: [{ id: "main", role: "primary-visual", composition: "spatial" }],
    content,
    links: [],
    ...extra,
  }, { composition: "spatial" });

const guardOf = (content) => runGuard(EXO_RULES, snapshotOf(content));

/** The finding a rule id left, whatever its verdict. */
const findingOf = (result, id) => result.findings.find((f) => f.rule === id);

/** One text node keeps the fixture screen-shaped (and forbiddenText-benign). */
const NODE = { kind: "text", id: "t", text: "Cluster — llama3 70B" };

/* panels: not in the labelled-set nor card-wall counts, so the rest of the
   EXO rules stay quiet and the palette is the only thing under test */
const panel = (id, colours) => ({ kind: "component", id, type: "panel", props: { label: id, ...colours } });

/* -------------------------------------------------------------------------- */
/* the rule does not fire on a restrained palette                              */
/* -------------------------------------------------------------------------- */

test("three distinct hue families (with repeats) do not fire the rule", () => {
  const content = [
    NODE,
    panel("a", { color: "#E5484D" }), //  red
    panel("b", { color: "#1C7ED6" }), //  blue
    panel("c", { color: "#2EA043" }), //  green
    panel("d", { color: "#B3261E" }), //  red again — same family, darker
    panel("e", { surface: "#2FA350" }), // green again — same family, lighter
  ];
  const snap = snapshotOf(content);
  assert.equal(snap.metrics?.hueFamilies, 3, "red+blue+green is three families, repeats not counted");

  const f = findingOf(guardOf(content), "exo.restrained-accent");
  assert.ok(f, "the rule is evaluated");
  assert.equal(f.verdict, "PASS", "three families is within the exo restraint");
});

/* -------------------------------------------------------------------------- */
/* the rule fires as advice, not as a build failure                            */
/* -------------------------------------------------------------------------- */

test("four distinct hue families fire exo.restrained-accent as a WARNING with the measured count", () => {
  const content = [
    NODE,
    panel("a", { color: "#FF0000" }), //  h≈0     red
    panel("b", { color: "#FF7A00" }), //  h≈29    orange
    panel("c", { color: "#009F00" }), //  h≈120   green
    panel("d", { color: "#0033CC" }), //  h≈225   blue
  ];
  const snap = snapshotOf(content);
  assert.equal(snap.metrics?.hueFamilies, 4);

  const result = guardOf(content);
  const f = findingOf(result, "exo.restrained-accent");
  assert.ok(f, "the fourth family trips the rule");
  assert.equal(f.verdict, "WARNING", "severity is warn: advice, never a hard FAIL");
  assert.match(f.evidence ?? "", /hueFamilies=4\b/, "the finding shows the measured hueFamilies count");
  assert.match(f.message, /accent hue families/, "the message states the restraint being crossed");

  assert.equal(result.stats.failures, 0, "a warn rule must not turn the run into a FAIL");
  assert.notEqual(result.verdict, "FAIL");
});

/* -------------------------------------------------------------------------- */
/* neutrals never count, exactly as the rule says                              */
/* -------------------------------------------------------------------------- */

test("a screen of greys plus one accent counts exactly one family", () => {
  const content = [
    NODE,
    panel("g1", { color: "#F4F4F5", surface: "#18181B", background: "#E4E4E7" }),
    panel("g2", { color: "#71717A", surface: "#FAFAFA" }),
    panel("g3", { color: "#000000" }),
    panel("a1", { color: "#E5484D" }), //  the one accent
  ];
  const snap = snapshotOf(content);
  assert.equal(snap.metrics?.hueFamilies, 1, "near-greys in any quantity contribute nothing");

  const f = findingOf(guardOf(content), "exo.restrained-accent");
  assert.equal(f?.verdict, "PASS", "neutrals plus one accent is exactly what the exo surface aspires to");
});

/* -------------------------------------------------------------------------- */
/* family repeats are not families                                             */
/* -------------------------------------------------------------------------- */

test("every shade and duplicate of one hue is still one family", () => {
  const content = [
    NODE,
    panel("r1", { color: "#FF0000" }),
    panel("r2", { color: "#CC0000" }),
    panel("r3", { color: "#990000" }),
    panel("r4", { color: "#FF4D4D" }),
    panel("r5", { surface: "#FF0000", background: "#B30000" }), // literal repeat prop-side
  ];
  const snap = snapshotOf(content);
  assert.equal(snap.metrics?.hueFamilies, 1);

  const f = findingOf(guardOf(content), "exo.restrained-accent");
  assert.equal(f?.verdict, "PASS");
});

/* -------------------------------------------------------------------------- */
/* the metric has a name in the snapshot, and honesty about the unmeasurable   */
/* -------------------------------------------------------------------------- */

test("the snapshot's metrics expose hueFamilies as a number (0 with nothing resolvable)", () => {
  const snap = snapshotOf([NODE, panel("plain", { label: "plain" })]);
  assert.ok(Object.hasOwn(snap.metrics ?? {}, "hueFamilies"), "the metric is named hueFamilies");
  assert.equal(typeof snap.metrics?.hueFamilies, "number");
  assert.equal(snap.metrics?.hueFamilies, 0, "no resolvable colour counts as zero families, not absence");
});

test("a value the snapshot cannot resolve as a colour is not counted as a family", () => {
  const content = [
    NODE,
    panel("tok", { accent: "exo/action", color: "error" }), //   token name / semantic word
    panel("grad", { surface: "linear-gradient(90deg, red, blue)" }), // not a flat colour
  ];
  const snap = snapshotOf(content);
  assert.equal(snap.metrics?.hueFamilies, 0, "unmeasurable colour strings are skipped, never guessed");
  const f = findingOf(guardOf(content), "exo.restrained-accent");
  assert.equal(f?.verdict, "PASS");
});
