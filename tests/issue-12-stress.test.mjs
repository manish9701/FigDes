/**
 * Issue #12 stress matrix — regression suite.
 *
 * Two kinds of assertion, both intentional:
 *
 *  1. Every case in `CASES` must report PASS. If the compiler or the reviewer
 *     regresses, a case flips to FAIL and this file fails.
 *  2. Every case in `OPEN_CASES` must still report FAIL. This is the part that
 *     usually goes wrong in a suite like this: open failures get deleted once
 *     they are embarrassing, and the report then claims a clean run. Asserting
 *     the failure means a *silent* fix — one nobody edits this file for — fails
 *     CI, and forces the issue to be closed deliberately.
 *
 * Usage: npm run test:issue12
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { CASES, BLOCKED_CASES, OPEN_CASES, ALL_CASES, runMatrix, summarise } from "./issue-12-matrix.mjs";

/* ---- 1. Every declared case must pass ------------------------------------ */

for (const c of CASES) {
  test(`${c.id} — ${c.title}`, () => {
    const outcome = c.run();
    assert.equal(outcome.status, "PASS", `${c.id} measured ${outcome.status}: ${outcome.detail}`);
  });
}

/* ---- 1b. Live-gate cases must report BLOCKED, never PASS ---------------- */

for (const c of BLOCKED_CASES) {
  test(`${c.id} — blocked, not silently passed: ${c.title}`, () => {
    const outcome = c.run();
    assert.equal(outcome.status, "BLOCKED", `${c.id} reported ${outcome.status}. A live-render case cannot be satisfied offline, and reporting PASS would claim render evidence that does not exist.`);
  });
}

/* ---- 2. Known-open cases must still fail --------------------------------- */

for (const c of OPEN_CASES) {
  test(`${c.id} — still open: ${c.title}`, () => {
    const outcome = c.run();
    assert.equal(outcome.status, "FAIL", `${c.id} now reports ${outcome.status}. If that is a real fix, close the issue deliberately: move it from OPEN_CASES to CASES in tests/issue-12-matrix.mjs and update docs/issue-12-report.md.`);
  });
}

/* ---- 3. The matrix itself is well formed --------------------------------- */

test("every case has a stable id, a requirement and an explicit status", () => {
  const ids = ALL_CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate case ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(", ")}`);
  for (const c of ALL_CASES) {
    assert.match(c.id, /^[A-Z]\d+(-[a-z0-9]+)?$/, `case id '${c.id}' is not a stable matrix id`);
    assert.ok(typeof c.requirement === "string" && c.requirement.length > 10, `${c.id} has no stated requirement`);
  }
});

test("every open case records the known issue it is carrying", () => {
  for (const c of OPEN_CASES) {
    assert.ok(typeof c.knownIssue === "string" && c.knownIssue.length > 20, `${c.id} is listed as open without recording why, so the report cannot explain the failure`);
  }
});

test("a status is one of PASS, FAIL or BLOCKED — never anything else", () => {
  for (const r of runMatrix()) {
    assert.ok(["PASS", "FAIL", "BLOCKED"].includes(r.status), `${r.id} reported an undeclared status '${r.status}'`);
    assert.ok(typeof r.detail === "string" && r.detail.length > 0, `${r.id} returned no detail`);
    assert.ok(r.raw !== undefined, `${r.id} returned no raw evidence`);
  }
});

test("a BLOCKED case states what would unblock it and claims no evidence", () => {
  for (const r of runMatrix().filter((x) => x.status === "BLOCKED")) {
    assert.match(r.detail, /requires|cannot/i, `${r.id} is BLOCKED without saying why`);
    assert.match(JSON.stringify(r.raw), /none/i, `${r.id} is BLOCKED but its raw payload implies evidence was gathered`);
  }
});

test("a PASS case carries measured evidence in its raw payload", () => {
  for (const r of runMatrix().filter((x) => x.status === "PASS")) {
    assert.ok(r.raw && Object.keys(r.raw).length > 0, `${r.id} passed with an empty raw payload — that is an unevidenced pass`);
  }
});

test("the matrix covers the full A1-A10 and B1-B6 grid", () => {
  const required = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "B1", "B2", "B3", "B4", "B5", "B6", "C1", "C2", "C3", "C4"];
  const ids = new Set(ALL_CASES.map((c) => c.id));
  for (const id of required) assert.ok(ids.has(id), `matrix is missing case ${id}`);
});

test("the summary counts add up and are reported honestly", () => {
  const results = runMatrix();
  const s = summarise(results);
  assert.equal(s.pass + s.fail + s.blocked, s.total);
  assert.equal(s.total, ALL_CASES.length);
  // Everything in CASES really does pass, and everything in OPEN_CASES really
  // does fail — the two lists cannot disagree with what the code does.
  assert.equal(s.pass, CASES.length);
  assert.equal(s.fail, OPEN_CASES.length);
  assert.equal(s.blocked, BLOCKED_CASES.length);
  assert.equal(s.blocked, 4, "C1-C4 need a live plugin and must report BLOCKED");
});
