/**
 * Issue #25 — environment/version integrity.
 *
 * Before this work, the build stamps existed and were compared for
 * *reporting* only: a live run could measure a screen while the server and
 * plugin were different builds (or could not name their builds at all), and
 * every verdict below that looked ordinary.
 *
 * The claims under test:
 *
 *   1. `tools.buildCompatibility` keeps its unit behaviour (light re-assert —
 *      issue #17 already covers it fully).
 *   2. The release gate's `build-integrity` group (shared with the gate as one
 *      pure implementation in `scripts/lib/live-client.mjs`): FAIL on a
 *      different-commit pair, FAIL on missing/"unknown" builds, FAIL when a
 *      stamp does not name HEAD, BLOCKED — never PASS — when evidence is
 *      absent, PASS when every record ties to HEAD.
 *   3. The live benchmark's `mismatchCases` semantics (same helper).
 *   4. The final gate refuses on a mismatched build: "different-commit"
 *      FAILs, "unverifiable" BLOCKEDs, a missing measurement leaves the
 *      verdict reachable (unchanged behaviour).
 *   5. `PipelineReport` accepts and echoes the optional builds/stamp block —
 *      and stays absent for runs that never measured a live file.
 *
 * Deterministic stamps throughout: the tests never read the real repository
 * HEAD, so a re-run on another commit cannot go green for the wrong reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompatibility } from "../mcp-server/dist-test/tools/tools.js";
import { evaluateFinalGate, compatibilityOfBuilds } from "../mcp-server/dist-test/design/quality/final-gate.js";
import { buildReport } from "../mcp-server/dist-test/pipeline/report.js";
import { caseBuildStamps, evaluateBuildIntegrityEvidence } from "../scripts/lib/live-client.mjs";

/** A deterministic 12-char SHA standing in for the repository HEAD. */
const HEAD = "aaa111bbb222";
const OTHER = "bbb222ccc333";

/* -------------------------------------------------------------------------- */
/* buildCompatibility — unit behaviour unchanged                                */
/* -------------------------------------------------------------------------- */

test("tools.buildCompatibility keeps its behaviour (light re-assert of issue #17)", () => {
  assert.equal(buildCompatibility(HEAD, HEAD), "same-commit");
  assert.equal(buildCompatibility(HEAD, `${HEAD}-dirty`), "same-commit");
  assert.equal(buildCompatibility(HEAD, OTHER), "different-commit");
  assert.equal(buildCompatibility(HEAD, undefined), "unverifiable");
  assert.equal(buildCompatibility(HEAD, "unknown"), "unverifiable");
});

test("compatibilityOfBuilds (the review-side copy) matches the same comparison", () => {
  assert.equal(compatibilityOfBuilds(HEAD, HEAD), "same-commit");
  assert.equal(compatibilityOfBuilds(HEAD, `${HEAD}-dirty`), "same-commit");
  assert.equal(compatibilityOfBuilds(HEAD, OTHER), "different-commit");
  assert.equal(compatibilityOfBuilds(HEAD, null), "unverifiable");
  assert.equal(compatibilityOfBuilds(HEAD, "unknown"), "unverifiable");
});

/* -------------------------------------------------------------------------- */
/* The release gate's build-integrity group                                     */
/* -------------------------------------------------------------------------- */

const nativeRecord = (serverBuild, pluginBuild) => ({
  caseId: "native-path-check",
  serverBuild,
  pluginBuild,
});
const caseRecord = (serverBuild, pluginBuild) => ({
  caseId: "case-a",
  build: { serverBuild, pluginBuild, commit: serverBuild ?? null, note: null },
});

test("the build-integrity group is BLOCKED — never PASS — when no evidence exists", () => {
  const blocked = evaluateBuildIntegrityEvidence({ report: null, native: null }, { repoHead: HEAD });
  assert.equal(blocked.status, "BLOCKED", "no evidence cannot be a pass");
  assert.notEqual(blocked.status, "PASS");
  assert.equal(blocked.exitCode, 1, "the gate must exit nonzero, not silently green");
  assert.match(blocked.detail, /no live build evidence exists/);
  assert.ok(!("compatibility" in blocked.extra) || blocked.extra.compatibility === undefined, "nothing was verified, so no stamps are claimed");
});

test("the build-integrity group is BLOCKED when HEAD is unreadable", () => {
  // Without HEAD no stamp can be tied to a commit — the group can verify nothing.
  const blocked = evaluateBuildIntegrityEvidence(
    { report: { cases: [caseRecord(HEAD, HEAD)] }, native: null },
    { repoHead: null },
  );
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.exitCode, 1);
});

test("the build-integrity group FAILs on a different-commit pair", () => {
  const result = evaluateBuildIntegrityEvidence(
    { report: { cases: [caseRecord(HEAD, OTHER)] }, native: null },
    { repoHead: HEAD },
  );
  assert.equal(result.status, "FAIL");
  assert.equal(result.exitCode, 1);
  assert.ok(result.extra.problems.some((p) => p.includes("not the same commit")), result.extra.problems.join(" | "));
});

test("the build-integrity group FAILs on missing or 'unknown' builds", () => {
  for (const [serverBuild, pluginBuild] of [
    [undefined, HEAD],
    [HEAD, "unknown"],
    ["unknown", "unknown"],
  ]) {
    const result = evaluateBuildIntegrityEvidence(
      { report: { cases: [caseRecord(serverBuild, pluginBuild)] }, native: null },
      { repoHead: HEAD },
    );
    assert.equal(result.status, "FAIL", `${serverBuild}/${pluginBuild}: missing or unknown builds cannot pass`);
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.extra.problems.some((p) => /missing or 'unknown'/.test(p)),
      `the reason names the missing stamp: ${result.extra.problems.join(" | ")}`,
    );
  }
});

test("the build-integrity group FAILs when a stamp does not name HEAD", () => {
  const result = evaluateBuildIntegrityEvidence(
    { report: { cases: [caseRecord(OTHER, OTHER)] }, native: null },
    { repoHead: HEAD },
  );
  assert.equal(result.status, "FAIL", "an older commit's stamps are evidence about other code");
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.extra.problems.some((p) => p.includes("does not name this repository's HEAD")),
    result.extra.problems.join(" | "),
  );
  assert.equal(result.extra.compatibility, "different-commit");
});

test("the build-integrity group PASSes when every record ties to HEAD (dirty marker tolerated)", () => {
  const result = evaluateBuildIntegrityEvidence(
    {
      report: { cases: [caseRecord(HEAD, `${HEAD}-dirty`), caseRecord(`${HEAD}-dirty`, HEAD)] },
      native: nativeRecord(HEAD, HEAD),
    },
    { repoHead: HEAD },
  );
  assert.equal(result.status, "PASS");
  assert.equal(result.exitCode, 0);
  assert.equal(result.extra.compatibility, "same-commit");
  assert.equal(result.extra.checked, 3, "two cases plus the native record were checked");
  assert.deepEqual(result.extra.problems, []);
});

test("the build-integrity group FAILs when the native record's stamps mismatch", () => {
  const result = evaluateBuildIntegrityEvidence(
    { report: { cases: [caseRecord(HEAD, HEAD)] }, native: nativeRecord(HEAD, OTHER) },
    { repoHead: HEAD },
  );
  assert.equal(result.status, "FAIL");
  assert.ok(result.extra.problems.some((p) => p.startsWith("native-path-check:")), result.extra.problems.join(" | "));
});

test("an empty (but existing) live report is BLOCKED, not PASS", () => {
  // A report file that parsed but carries no case records is still no evidence.
  const result = evaluateBuildIntegrityEvidence({ report: { cases: [] }, native: null }, { repoHead: HEAD });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.exitCode, 1);
});

/* -------------------------------------------------------------------------- */
/* The live benchmark's mismatchCases (caseBuildStamps)                         */
/* -------------------------------------------------------------------------- */

test("caseBuildStamps: missing and 'unknown' stamps are mismatches", () => {
  assert.equal(caseBuildStamps({ serverBuild: undefined, pluginBuild: HEAD, repoHead: HEAD }).ok, false);
  assert.equal(caseBuildStamps({ serverBuild: HEAD, pluginBuild: "unknown", repoHead: HEAD }).ok, false);
  assert.equal(caseBuildStamps({ serverBuild: null, pluginBuild: null, repoHead: HEAD }).ok, false);
  const missing = caseBuildStamps({ serverBuild: HEAD, pluginBuild: undefined, repoHead: HEAD });
  assert.match(missing.reasons.join(" "), /plugin build stamp is missing/);
});

test("caseBuildStamps: server and plugin builds that are not the same commit mismatch", () => {
  const result = caseBuildStamps({ serverBuild: HEAD, pluginBuild: OTHER, repoHead: HEAD });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /not the same commit/);
});

test("caseBuildStamps: a stamp that is not HEAD mismatches, per side", () => {
  const server = caseBuildStamps({ serverBuild: OTHER, pluginBuild: OTHER, repoHead: HEAD });
  assert.equal(server.ok, false);
  assert.match(server.reasons.join(" "), /serverBuild.*does not name/);
  const plugin = caseBuildStamps({ serverBuild: HEAD, pluginBuild: OTHER, repoHead: HEAD });
  assert.equal(plugin.ok, false);
  assert.match(plugin.reasons.join(" "), /pluginBuild.*does not name/);
});

test("caseBuildStamps: same commit with dirty markers, and HEAD matching, is ok", () => {
  assert.equal(caseBuildStamps({ serverBuild: `${HEAD}-dirty`, pluginBuild: HEAD, repoHead: HEAD }).ok, true);
  assert.equal(caseBuildStamps({ serverBuild: HEAD, pluginBuild: HEAD, repoHead: HEAD }).ok, true);
});

test("caseBuildStamps: a supplied compatibility that is not same-commit is a mismatch", () => {
  // The stamps can look fine while the server itself refuses the pair; the
  // caller passes `builds.compatibility` through so that refusal counts.
  const result = caseBuildStamps({
    serverBuild: HEAD,
    pluginBuild: HEAD,
    repoHead: HEAD,
    compatibility: "different-commit",
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /'different-commit', not 'same-commit'/);
});

test("caseBuildStamps: an unreadable HEAD checks nothing about HEAD but still checks the pair", () => {
  const result = caseBuildStamps({ serverBuild: HEAD, pluginBuild: HEAD, repoHead: null });
  assert.equal(result.ok, true, "pair agreement is still verified; HEAD cannot be, so no claim is made");
  assert.equal(caseBuildStamps({ serverBuild: HEAD, pluginBuild: OTHER, repoHead: null }).ok, false);
});

/* -------------------------------------------------------------------------- */
/* The final gate: buildCompatibility refuses PASS                              */
/* -------------------------------------------------------------------------- */

/** The same shape issue #23 uses; verified to PASS before the build dimension. */
const GOOD_GATE_INPUT = {
  scores: { hierarchy: 88, composition: 85, typography: 82, readability: 88, density: 80, distinctiveness: 76, genericity: 85, productFit: 88 },
  blockingIssues: [],
  visualEvidenceVerified: true,
  states: { declared: 2 },
  accessibility: { findings: 0, notChecked: [] },
  stamp: { pluginBuild: HEAD, transactionId: "tx-42" },
};

test("the control: a fully-evidenced gate without a build measurement is still PASS", () => {
  const report = evaluateFinalGate(GOOD_GATE_INPUT);
  assert.equal(report.status, "PASS");
  assert.equal(report.verdict, "PASS", "missing buildCompatibility input leaves the old behaviour unchanged");
});

test("final gate: buildCompatibility 'different-commit' makes the verdict FAIL", () => {
  const report = evaluateFinalGate({ ...GOOD_GATE_INPUT, buildCompatibility: "different-commit" });
  assert.equal(report.verdict, "FAIL", "a verdict measured under another build is not a verdict about this repository");
  assert.equal(report.status, "PASS", "the coarse status keeps its pinned semantics");
  assert.ok(report.verdictReasons.some((r) => r.startsWith("build-compatibility:")));
  const gate = report.gates.find((g) => g.name === "build-compatibility");
  assert.ok(gate, "the build-compatibility gate is enumerated");
  assert.equal(gate.status, "failed");
  assert.equal(gate.required, true);
});

test("final gate: buildCompatibility 'unverifiable' makes the verdict BLOCKED", () => {
  const report = evaluateFinalGate({ ...GOOD_GATE_INPUT, buildCompatibility: "unverifiable" });
  assert.equal(report.verdict, "BLOCKED", "nothing ties the run to a commit");
  assert.ok(report.verdictReasons.some((r) => r.startsWith("build-compatibility:")));
  assert.equal(report.gates.find((g) => g.name === "build-compatibility").status, "skipped");
});

test("final gate: buildCompatibility 'same-commit' stays reachable", () => {
  const report = evaluateFinalGate({ ...GOOD_GATE_INPUT, buildCompatibility: "same-commit" });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.gates.find((g) => g.name === "build-compatibility").status, "ran");
});

test("final gate: the stamp carries commitSha, pluginVersion and dirty (additive)", () => {
  const report = evaluateFinalGate({ ...GOOD_GATE_INPUT, buildCompatibility: "same-commit" });
  // Offline test bundle: SERVER_BUILD is "dev", so the derived commit is null
  // rather than a fake SHA, the version is the hand-maintained semver, and
  // nothing is dirty.
  assert.equal(report.stamp.commitSha, null);
  assert.equal(report.stamp.dirty, false);
  assert.match(report.stamp.pluginVersion ?? "", /^\d+\.\d+\.\d+$/, "pluginVersion names a semver");
  // The pre-existing required fields are untouched.
  assert.equal(report.stamp.pluginBuild, HEAD);
  assert.equal(report.stamp.transactionId, "tx-42");
});

/* -------------------------------------------------------------------------- */
/* PipelineReport accepts and echoes the builds/stamp block                     */
/* -------------------------------------------------------------------------- */

const MINIMAL_REPORT_INPUT = {
  planned: false,
  applied: false,
  operations: 0,
  nodeIds: [],
  transactionId: null,
  structure: { status: "not-run", checks: [], detail: "nothing ran" },
  live: null,
  visual: { status: "not-run", detail: "nothing was rendered", renderRevision: null },
  repairs: [],
  findings: [],
  blocked: [],
  trace: { briefId: "b", planId: "p", stages: [], operations: [], nodeIds: [], checks: [], findings: [], repairs: [], render: null },
};

test("PipelineReport echoes the builds/stamp block when the caller supplies it", () => {
  const builds = {
    serverBuild: HEAD,
    pluginBuild: HEAD,
    compatibility: "same-commit",
    commitSha: HEAD,
    pluginVersion: "0.3.5",
  };
  const report = buildReport({ ...MINIMAL_REPORT_INPUT, buildCompatibility: "same-commit", builds });
  assert.deepEqual(report.builds, builds, "the provenance is echoed verbatim, never synthesised");
});

test("PipelineReport carries no builds block for runs that never measured a live file", () => {
  const report = buildReport(MINIMAL_REPORT_INPUT);
  assert.equal("builds" in report, false, "absent input stays absent — the report invents nothing");
  // And the old shape is otherwise intact.
  assert.equal(report.status, "incomplete");
  assert.equal(report.visuallyReviewed.status, "not-run");
});

test("PipelineReport: a different-commit builds block still records provenance alongside the refusal", () => {
  const builds = {
    serverBuild: HEAD,
    pluginBuild: OTHER,
    compatibility: "different-commit",
    commitSha: HEAD,
    pluginVersion: "0.3.5",
  };
  const report = buildReport({
    ...MINIMAL_REPORT_INPUT,
    applied: true,
    structure: { status: "pass", checks: [], detail: "offline checks" },
    visual: { status: "pass", detail: "rendered and reviewed", renderRevision: "rev-1" },
    buildCompatibility: "different-commit",
    builds,
  });
  // The verdict must NOT be `verified`, and the mismatch must be readable both
  // in the status-refusal and in the echoed stamps.
  assert.equal(report.status, "built", "verified is refused: the pair is not the same commit");
  assert.match(report.summary, /verified refused/);
  assert.deepEqual(report.builds, builds);
});
