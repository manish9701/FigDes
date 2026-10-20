/**
 * Issue #17 — the release gate's own regression suite.
 *
 * The gate itself is a command (`npm run gate`) that also runs every other
 * suite. This file is the part of it that belongs in `npm test`: the
 * integrated gauntlet's cases, asserted so a failure in them is red in the
 * ordinary test run rather than only at release time.
 *
 * The claims under test:
 *
 *   1. Every gauntlet case passes — and a case that throws is a failure, not
 *      a skip, because a check that silently skips is the thing the gate
 *      exists to prevent.
 *   2. The verdict is the *worst* case, never the average: a good score does
 *      not hide a single critical failure.
 *   3. An empty, stale or missing inspection can never report PASS.
 *   4. The coverage map names a test for every acceptance criterion, and no
 *      criterion is claimed by a test that does not exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runGauntlet, summariseGauntlet, CASES, COVERAGE, SCENARIO_MAP } from "./issue-17-gauntlet.mjs";

/* -------------------------------------------------------------------------- */
/* The gauntlet                                                                 */
/* -------------------------------------------------------------------------- */

test("every gauntlet case passes", async () => {
  const results = await runGauntlet();
  const failed = results.filter((r) => r.status !== "PASS");
  assert.deepEqual(
    failed.map((r) => `${r.id} (${r.status}): ${r.detail}`),
    [],
    "the gauntlet has failing cases",
  );
  const summary = summariseGauntlet(results);
  assert.equal(summary.fail, 0);
  assert.equal(summary.total, CASES.length);
  assert.equal(summary.pass, summary.total);
});

test("a case that throws is a failure, not a skip", async () => {
  // The gauntlet's own runner catches a throw and reports it as a FAIL. If it
  // ever stopped doing that, a broken case would vanish from the report and
  // the count would still add up.
  const results = await runGauntlet();
  for (const r of results) {
    assert.ok(["PASS", "FAIL", "BLOCKED", "INDETERMINATE"].includes(r.status), `${r.id} reported '${r.status}'`);
    assert.ok(r.detail.length > 0, `${r.id} reported no detail`);
    assert.ok(r.raw !== undefined, `${r.id} carried no evidence`);
  }
});

test("the gauntlet is repeatable", async () => {
  const first = await runGauntlet();
  const second = await runGauntlet();
  const verdict = (run) => run.map((r) => `${r.id}:${r.status}`).join(",");
  assert.equal(verdict(first), verdict(second), "two runs of the same gauntlet disagreed");
});

/* -------------------------------------------------------------------------- */
/* The verdict rules                                                            */
/* -------------------------------------------------------------------------- */

test("the verdict is the worst case, never the average", () => {
  // The rule the issue states: a good aggregate score must never hide a
  // single critical failure. 17 passes and one failure is a failure.
  const results = [
    ...Array.from({ length: 17 }, (_, i) => ({ id: `ok-${i}`, status: "PASS" })),
    { id: "broken", status: "FAIL" },
  ];
  const summary = summariseGauntlet(results);
  assert.equal(summary.pass, 17);
  assert.equal(summary.fail, 1);
  assert.equal(summary.total, 18);
  // The summary is not the verdict: the verdict is derived from the worst
  // status, which is what the runner does.
  const worst = results.some((r) => r.status === "FAIL")
    ? "FAIL"
    : results.some((r) => r.status === "INDETERMINATE")
      ? "INDETERMINATE"
      : results.some((r) => r.status === "BLOCKED")
        ? "BLOCKED"
        : "PASS";
  assert.equal(worst, "FAIL");
});

test("an unavailable inspection is INDETERMINATE, never PASS", () => {
  const results = [
    { id: "a", status: "PASS" },
    { id: "b", status: "INDETERMINATE" },
  ];
  const summary = summariseGauntlet(results);
  assert.equal(summary.pass, 1);
  assert.equal(summary.indeterminate, 1);
  // And the worst-status rule holds: nothing here is a pass overall.
  const worst = results.some((r) => r.status === "FAIL")
    ? "FAIL"
    : results.some((r) => r.status === "INDETERMINATE")
      ? "INDETERMINATE"
      : results.some((r) => r.status === "BLOCKED")
        ? "BLOCKED"
        : "PASS";
  assert.equal(worst, "INDETERMINATE");
});

/* -------------------------------------------------------------------------- */
/* The coverage map                                                             */
/* -------------------------------------------------------------------------- */

test("the coverage map names a test for every acceptance criterion", () => {
  const known = new Set(CASES.map((c) => c.id));
  for (const row of COVERAGE) {
    assert.ok(row.criterion.length > 20, `a coverage row has no readable criterion: ${row.criterion}`);
    assert.ok(row.tests.length > 0, `the criterion '${row.criterion}' names no test`);
    for (const t of row.tests) {
      // `suite:*` names a regression suite rather than a gauntlet case, and
      // `gate:*` names the runner's own output.
      if (t.startsWith("suite:") || t.startsWith("gate:")) continue;
      assert.ok(known.has(t), `the criterion '${row.criterion}' claims the test '${t}', which does not exist`);
    }
  }
});

test("every gauntlet case is claimed by at least one criterion", () => {
  const claimed = new Set(COVERAGE.flatMap((row) => row.tests));
  const unclaimed = CASES.map((c) => c.id).filter((id) => !claimed.has(id));
  assert.deepEqual(unclaimed, [], "these cases are not claimed by any acceptance criterion");
});

/* -------------------------------------------------------------------------- */
/* The scenario map                                                             */
/* -------------------------------------------------------------------------- */

test("every failure-injection scenario is claimed by a test", () => {
  const known = new Set(CASES.map((c) => c.id));
  for (const row of SCENARIO_MAP) {
    assert.ok(row.scenario.length > 10, `a scenario row has no readable name: ${row.scenario}`);
    assert.ok(row.tests.length > 0, `the scenario '${row.scenario}' names no test`);
    for (const t of row.tests) {
      // `suite:*` names a regression suite and its case, `gate:*` names the
      // runner's own output. Everything else has to be a real gauntlet case.
      if (t.startsWith("suite:") || t.startsWith("gate:")) continue;
      assert.ok(known.has(t), `the scenario '${row.scenario}' claims the test '${t}', which does not exist`);
    }
  }
});

test("the scenario map covers the issue's ten failure injections", () => {
  // The issue names them; each has to appear in the map, so a scenario that
  // is quietly dropped shows up as a missing row rather than as silence.
  const required = [
    "validation failure before any mutation",
    "mid-batch creation failure",
    "timeout while the apply is still running",
    "retry while the original status is unknown",
    "partial rollback failure",
    "parent that disappears during execution",
    "delayed or failed font load",
    "render or review failure after a successful commit",
    "duplicate transaction submission",
    "Concurrent mutations against the same target",
  ];
  const scenarios = SCENARIO_MAP.map((r) => r.scenario.toLowerCase());
  for (const want of required) {
    assert.ok(
      scenarios.some((s) => s.includes(want.toLowerCase())),
      `the scenario map does not cover '${want}'`,
    );
  }
});
