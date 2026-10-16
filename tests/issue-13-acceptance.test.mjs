/**
 * Issue #13 acceptance matrix — regression suite.
 *
 * Same contract as the #12 matrix:
 *   1. every case in `CASES` must report PASS;
 *   2. every case in `OPEN_CASES` must still report FAIL, so a silent fix fails
 *      CI and forces the issue to be closed deliberately;
 *   3. the live-gate cases must report BLOCKED and never PASS.
 *
 * Usage: npm run test:issue13
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CASES, LIVE_CASES, OPEN_CASES, ALL_CASES, runMatrix, summarise } from "./issue-13-matrix.mjs";

for (const c of CASES) {
  test(`${c.id} — ${c.title}`, () => {
    const outcome = c.run();
    assert.equal(outcome.status, "PASS", `${c.id} measured ${outcome.status}: ${outcome.detail}`);
  });
}

for (const c of LIVE_CASES) {
  test(`${c.id} — live evidence recorded: ${c.title}`, () => {
    const outcome = c.run();
    assert.equal(outcome.status, "PASS", `${c.id} measured ${outcome.status}: ${outcome.detail}`);
    assert.ok(outcome.raw && Object.keys(outcome.raw).length > 0, `${c.id} claims a live result with no evidence`);
  });
}

for (const c of OPEN_CASES) {
  test(`${c.id} — still open: ${c.title}`, () => {
    const outcome = c.run();
    assert.equal(outcome.status, "FAIL", `${c.id} now reports ${outcome.status}. Close it deliberately: move it from OPEN_CASES to CASES in tests/issue-13-matrix.mjs and regenerate the report.`);
  });
}

test("the whole acceptance gate is covered", () => {
  const ids = new Set(ALL_CASES.map((c) => c.id));
  // One case per acceptance-gate line in the issue, plus the review-engine and
  // control cases the gate also names.
  for (const id of ["L01","L02","L03","X01", "X02", "X03", "X04", "X05", "X06", "X07", "X08", "X12-right", "X13-resize", "X14-nav", "X15-endpoint", "X16-generated", "X17-autolayout", "X09-route", "X10-anchor", "X11-baseline"]) {
    assert.ok(ids.has(id), `the acceptance gate names ${id} and the matrix is missing it`);
  }
  assert.equal(ids.size, ALL_CASES.length, "duplicate case ids");
});

test("every case has a stable id and a stated requirement", () => {
  for (const c of ALL_CASES) {
    assert.match(c.id, /^(X|L)\d+(-[a-z0-9]+)?$/, `case id '${c.id}' is not a stable matrix id`);
    assert.ok(typeof c.requirement === "string" && c.requirement.length > 15, `${c.id} has no stated requirement`);
  }
});

test("every open case records the known issue it is carrying", () => {
  for (const c of OPEN_CASES) {
    assert.ok(typeof c.knownIssue === "string" && c.knownIssue.length > 20, `${c.id} is open without recording why`);
  }
});


test("a PASS case carries measured evidence in its raw payload", () => {
  for (const r of runMatrix().filter((x) => x.status === "PASS")) {
    assert.ok(r.raw && Object.keys(r.raw).length > 0, `${r.id} passed with an empty raw payload — that is an unevidenced pass`);
  }
});

test("the summary agrees with what the code actually does", () => {
  const s = summarise(runMatrix());
  assert.equal(s.pass + s.fail + s.blocked, s.total);
  assert.equal(s.fail, OPEN_CASES.length);
  assert.equal(s.pass, CASES.length + LIVE_CASES.length);
});
