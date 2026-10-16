/**
 * Regressions for the product guard, made a mandatory part of every build.
 *
 * ## Why these exist
 *
 * The guard was reachable only through `design_guard`, a separate tool. The loop
 * this agent actually runs is compile → apply → review → render, and none of
 * those steps touched it. A screen with an invisible active nav label, a region
 * buried under its sibling and a connector with no endpoints all passed a guard
 * run that reported `PASS`.
 *
 * Worse, that PASS was not earned. Five of the thirteen EXO product truths were
 * manual-only, and a rule with nothing machine-checkable emitted
 * `verdict: "PASS"` and counted itself in `stats.passed`. So a real program
 * returned top-level PASS on the strength of eight structural checks while none
 * of the five encoding design judgement had been evaluated at all.
 *
 * Two things are pinned down here:
 *   1. a verdict cannot be PASS while any of its own checks are unevaluated
 *   2. the guard runs on every build, and a FAIL stops the build
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runGuard, snapshotFromIR } from "../mcp-server/dist-test/memory/guard.js";
import { EXO_RULES } from "../mcp-server/dist-test/memory/rules-exo.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

const guardOf = (content, extra = {}) =>
  runGuard(EXO_RULES, snapshotFromIR({
    regions: [
      { id: "nav", role: "navigation", composition: "auto" },
      { id: "main", role: "primary-visual", composition: "topology" },
    ],
    content,
    links: [],
    ...extra,
  }, { composition: "instrument" }));

const run = (content) => executeRuntime({
  canvas: { name: "X", width: 1440, height: 900, grid: 8 },
  regions: [
    { fn: "navigation", id: "nav", args: { width: 220 } },
    { fn: "frame", id: "main", args: { width: "fill", height: "fill" } },
  ],
  content,
});

/* -------------------------------------------------------------------------- */
/* The verdict may not lie                                                      */
/* -------------------------------------------------------------------------- */

test("a verdict is never PASS while the guard left checks unevaluated", () => {
  const result = guardOf([
    { kind: "component", id: "t1", type: "deviceNode", props: { label: "node-01" } },
    { kind: "text", id: "x", text: "Fleet overview" },
  ]);

  assert.ok(result.stats.manual > 0, "this ruleset leaves judgement calls open");
  assert.notEqual(result.verdict, "PASS", "unevaluated checks must not read as approval");
  assert.equal(result.verdict, "INDETERMINATE");
});

test("a manual-only rule reports INDETERMINATE, not PASS", () => {
  const result = guardOf([
    { kind: "text", id: "x", text: "Fleet" },
  ]);
  const manual = result.findings.filter((f) => f.verdict === "INDETERMINATE");
  assert.ok(manual.length > 0, "at least one EXO truth is a judgement call");
  for (const f of manual) {
    assert.notEqual(f.verdict, "PASS");
  }
});

test("a clean design still separates 'nothing wrong' from 'nothing checked'", () => {
  const result = guardOf([
    { kind: "component", id: "d", type: "deviceNode", props: { label: "mac-mini-01" } },
    { kind: "text", id: "t", text: "4 nodes discovered" },
  ]);
  assert.equal(result.stats.failures, 0, "a clean program should not fail a rule");
  assert.equal(result.verdict, "INDETERMINATE", "but it was not fully evaluated either");
});

/* -------------------------------------------------------------------------- */
/* Judgement the guard used to only ask about                                   */
/* -------------------------------------------------------------------------- */

test("machine data in a proportional face is measured, not asked about", () => {
  // `technical-typography` was manual-only and reported PASS. The rule names
  // addresses, latencies, hashes and identifiers — so those are the four shapes
  // it checks.
  const mono = guardOf([
    { kind: "component", id: "m", type: "metric", props: { label: "Latency", value: "240ms", valueStyle: "technical" } },
  ]);
  const proportional = guardOf([
    { kind: "component", id: "m", type: "metric", props: { label: "Latency", value: "240ms" } },
  ]);

  const monoRule = mono.findings.find((f) => f.rule === "exo.technical-typography");
  const badRule = proportional.findings.find((f) => f.rule === "exo.technical-typography");
  assert.equal(monoRule.verdict, "PASS");
  assert.notEqual(badRule.verdict, "PASS");
  assert.match(badRule.evidence ?? "", /machineDataInProportionalFace=1/);
});

test("the typography rule enforces what it states, not what I wished it stated", () => {
  // Byte quantities are not in the rule's wording. An earlier version matched
  // them and fired on the project's own example dashboard (`value: "1.8 TB"`) —
  // a check that enforces more than the rule it claims to enforce is the same
  // drift the rule exists to prevent.
  const result = guardOf([
    { kind: "component", id: "m", type: "metric", props: { label: "Memory", value: "1.8 TB" } },
  ]);
  const rule = result.findings.find((f) => f.rule === "exo.technical-typography");
  assert.equal(rule.verdict, "PASS", "1.8 TB is a defensible display value set in a proportional face");
});

test("two controls claiming to be primary is reported", () => {
  const one = guardOf([
    { kind: "component", id: "b", type: "button", props: { label: "Deploy", variant: "primary" } },
  ]);
  const two = guardOf([
    { kind: "component", id: "b1", type: "button", props: { label: "Deploy", variant: "primary" } },
    { kind: "component", id: "b2", type: "button", props: { label: "Cancel", emphasis: "primary" } },
  ]);
  assert.equal(one.findings.find((f) => f.rule === "exo.primary-action-dominant").verdict, "PASS");
  const bad = two.findings.find((f) => f.rule === "exo.primary-action-dominant");
  assert.notEqual(bad.verdict, "PASS", "two equal primaries is not a hierarchy");
  assert.match(bad.evidence ?? "", /dominantActions=2/);
});

test("selection carried by colour alone is reported", () => {
  const bare = guardOf([
    { kind: "component", id: "r", type: "modelRow", props: { label: "mac-mini-01", state: "active" } },
  ]);
  const signalled = guardOf([
    { kind: "component", id: "r", type: "modelRow", props: { label: "mac-mini-01", state: "active", indicator: "dot" } },
  ]);
  assert.notEqual(bare.findings.find((f) => f.rule === "exo.selected-unambiguous").verdict, "PASS");
  assert.equal(signalled.findings.find((f) => f.rule === "exo.selected-unambiguous").verdict, "PASS");
});

test("an active nav item is not flagged: its emitter already adds weight", () => {
  // Reading the program rather than the emitted result, the navItem emitter's
  // weight bump is invisible — it is a property of the component, not of
  // anything the program wrote. So it is accounted for explicitly.
  const result = guardOf([
    { kind: "component", id: "n", type: "navItem", props: { label: "Overview", state: "active" } },
  ]);
  assert.equal(result.findings.find((f) => f.rule === "exo.selected-unambiguous").verdict, "PASS");
});

/* -------------------------------------------------------------------------- */
/* The guard is part of the build, not a separate tool                          */
/* -------------------------------------------------------------------------- */

test("every build reports what the product guard concluded", () => {
  const built = run([
    { fn: "text", id: "t", parent: "main", args: { text: "Fleet overview", role: "title" } },
    { fn: "metric", id: "m", parent: "main", args: { label: "Memory", value: "1.8 TB" } },
  ]);

  assert.ok(built.productGuard, "a build that says nothing about the guard is the bug this pins down");
  assert.ok(built.productGuard.rulesChecked >= 13, "the whole EXO truth set runs on every build");
  assert.equal(typeof built.productGuard.verdict, "string");
});

test("a design contradicting a product truth does not ship", () => {
  const built = run([
    { fn: "text", id: "t", parent: "main", args: { text: "Connect device", role: "title" } },
    { fn: "metric", id: "m1", parent: "main", args: { label: "Online", value: "21 / 24" } },
    { fn: "metric", id: "m2", parent: "main", args: { label: "Errors", value: "0.4%" } },
    { fn: "metric", id: "m3", parent: "main", args: { label: "Nodes", value: "24" } },
  ]);

  assert.equal(built.productGuard.failures > 0, true);
  assert.equal(built.applicable, false, "a manual connect-device wizard is not applicable");
  const blocking = built.violations.filter((v) => v.rule === "product");
  assert.ok(blocking.length > 0, "the refusal is stated, not just implied by applicable=false");
  assert.ok(
    built.inapplicableReasons.some((r) => /connect device|SaaS|three-card/i.test(r)),
    `reasons should name the truth broken, got: ${JSON.stringify(built.inapplicableReasons)}`,
  );
});

test("a clean build is not polluted with standing 'unchecked' noise", () => {
  // Two truths are always manual, so an INDETERMINATE note on every build would
  // fire forever and train the reader to skip the warnings array. It belongs on
  // `productGuard`, not in `warnings`.
  const built = run([
    { fn: "text", id: "t", parent: "main", args: { text: "Fleet overview", role: "title" } },
    { fn: "metric", id: "m", parent: "main", args: { label: "Memory", value: "1.8 TB" } },
  ]);
  assert.deepEqual(built.warnings, []);
  assert.equal(built.applicable, true);
  assert.equal(built.productGuard.verdict, "INDETERMINATE", "the fact is still reported");
});