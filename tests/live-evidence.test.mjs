/**
 * Tests for the live-evidence validator.
 *
 * The validator is the mechanism behind issue #10's last acceptance criterion —
 * "the same 1600x1100 test is rendered and reviewed after the final mutation".
 * A gate nobody can trip is not a gate, so these tests feed it deliberately
 * broken evidence and assert it says so.
 *
 * The important case is the stale render: a screenshot taken *before* the fix
 * satisfies every "is this field present" check while proving nothing. That is
 * the exact way an acceptance criterion quietly stops meaning anything, so it
 * gets its own test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/run-live-benchmark.mjs");

const ALL_CASES = [
  "exo-compute-topology",
  "exo-model-detail",
  "exo-runtime-monitoring",
  "exo-configuration",
  "exo-enterprise-workspace",
  "generic-saas-dashboard",
  "data-heavy-workspace",
  "spatial-relationship",
  "editorial-product-page",
];

const MUST_RESOLVE = [
  "empty-guard-snapshot",
  "off-canvas-geometry",
  "unresolved-connectors",
  "arc-bounds",
  "contrast-repair",
  "review-semantics",
];

const baseCase = (caseId) => ({
  caseId,
  screenshotReference: `shots/${caseId}.png`,
  visualScores: { focal: 8, hierarchy: 8, density: 7 },
  nativeFrameId: `1:${caseId}`,
  operationManifest: { count: 12 },
  structuralFindings: [],
  repairs: [],
  unresolved: [],
  fixtures: [{ fixture: true, note: "no real-looking data" }],
});

const stressCase = (overrides = {}) => ({
  ...baseCase("hard-stress-test"),
  canvasWidth: 1600,
  canvasHeight: 1100,
  nativeFrameId: "279:1088",
  // Which builds measured the case. The server is deployed and Figma loads the
  // plugin bundle once, so a live measurement has to be able to name both.
  serverBuild: "abc123def456",
  pluginBuild: "abc123def456",
  mutations: [
    { revision: "rev-before", summary: "initial build" },
    { revision: "rev-after", summary: "issue #10 fixes" },
  ],
  postMutationRender: { revision: "rev-after", screenshotReference: "shots/stress-after.png" },
  postMutationReview: {
    revision: "rev-after",
    findings: [{ rule: "overflow", detail: "no region spills the canvas" }],
    resolved: MUST_RESOLVE,
    stillOpen: [],
  },
  ...overrides,
});

/** Runs the validator against a throwaway directory and returns its report. */
async function validate(files) {
  const dir = await mkdtemp(join(tmpdir(), "figdes-live-"));
  try {
    await mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), JSON.stringify(body, null, 2), "utf8");
    }
    const out = join(dir, "report.json");
    const { stdout } = await run(process.execPath, [script], {
      env: { ...process.env, FIGDES_LIVE_DIR: dir, FIGDES_LIVE_REPORT: out },
    });
    const report = JSON.parse(await readFile(out, "utf8"));
    return { report, stdout };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const allComplete = () => Object.fromEntries(ALL_CASES.map((id) => [`case-${id}.json`, baseCase(id)]));

const caseEntry = (report, caseId) => report.cases.find((c) => c.caseId === caseId);

test("live validator: a full evidence set, including a fresh stress render, passes", async () => {
  const { report } = await validate({ ...allComplete(), "case-hard-stress-test.json": stressCase() });
  const entry = caseEntry(report, "hard-stress-test");
  assert.equal(entry.status, "COMPLETE", JSON.stringify(entry));
  assert.equal(report.liveBenchmarkComplete, true, JSON.stringify(report.missingCases));
});

test("live validator: a stress case that cannot name its builds does not pass", async () => {
  // The server is deployed and Figma loads the plugin bundle once, so either
  // can be older than the repository. A case that cannot say which builds
  // measured it describes code that may no longer exist.
  const anonymous = stressCase({ serverBuild: undefined, pluginBuild: undefined });
  const { report } = await validate({ ...allComplete(), "case-hard-stress-test.json": anonymous });
  const entry = caseEntry(report, "hard-stress-test");
  assert.equal(entry.status, "INCOMPLETE");
  assert.ok(
    entry.missing.includes("serverBuild") || entry.missing.includes("pluginBuild"),
    `expected the missing builds to be reported, got ${JSON.stringify(entry.missing)}`,
  );
});

test("live validator: a render from before the final mutation does not pass", async () => {  // The screenshot exists and every key is populated — it is simply from the
  // wrong revision. A presence-only check would wave this through.
  const stale = stressCase({
    postMutationRender: { revision: "rev-before", screenshotReference: "shots/stress.png" },
  });
  const { report } = await validate({ ...allComplete(), "case-hard-stress-test.json": stale });
  const entry = caseEntry(report, "hard-stress-test");

  assert.equal(entry.status, "INCOMPLETE");
  assert.ok(
    entry.stressProblems.some((p) => /final mutation/i.test(p)),
    `expected a stale-render complaint, got ${JSON.stringify(entry.stressProblems)}`,
  );
});

test("live validator: a render with no revision at all does not pass", async () => {
  const unbound = stressCase({ postMutationRender: { screenshotReference: "shots/stress.png" } });
  const { report } = await validate({ ...allComplete(), "case-hard-stress-test.json": unbound });
  assert.equal(caseEntry(report, "hard-stress-test").status, "INCOMPLETE");
});

test("live validator: the wrong canvas size does not pass", async () => {
  const wrong = stressCase({ canvasWidth: 1440, canvasHeight: 900 });
  const { report } = await validate({ ...allComplete(), "case-hard-stress-test.json": wrong });
  const entry = caseEntry(report, "hard-stress-test");
  assert.equal(entry.status, "INCOMPLETE");
  assert.ok(entry.stressProblems.some((p) => /1600x1100/.test(p)), JSON.stringify(entry.stressProblems));
});

test("live validator: a defect left open does not pass", async () => {
  const open = stressCase({
    postMutationReview: {
      revision: "rev-after",
      findings: [{ rule: "arc-bounds", detail: "ring still 54x1" }],
      resolved: MUST_RESOLVE.filter((d) => d !== "arc-bounds"),
      stillOpen: ["arc-bounds"],
    },
  });
  const { report } = await validate({ ...allComplete(), "case-hard-stress-test.json": open });
  const entry = caseEntry(report, "hard-stress-test");
  assert.equal(entry.status, "INCOMPLETE");
  assert.ok(entry.stressProblems.some((p) => /arc-bounds.*still open/.test(p)), JSON.stringify(entry.stressProblems));
});

test("live validator: a review that stays silent about a defect does not pass", async () => {
  // Neither resolved nor still open: the review simply did not look.
  const silent = stressCase({
    postMutationReview: {
      revision: "rev-after",
      findings: [{ rule: "overflow", detail: "looked fine" }],
      resolved: MUST_RESOLVE.filter((d) => d !== "contrast-repair"),
      stillOpen: [],
    },
  });
  const { report } = await validate({ ...allComplete(), "case-hard-stress-test.json": silent });
  assert.equal(caseEntry(report, "hard-stress-test").status, "INCOMPLETE");
});

test("live validator: no mutations at all does not pass", async () => {
  const { report } = await validate({
    ...allComplete(),
    "case-hard-stress-test.json": stressCase({ mutations: [] }),
  });
  const entry = caseEntry(report, "hard-stress-test");
  assert.equal(entry.status, "INCOMPLETE");
  assert.ok(entry.missing.includes("mutations"), JSON.stringify(entry.missing));
});

test("live validator: the stress case is required, not optional", async () => {
  // Without it, the nine original cases still look complete. That is the state
  // the acceptance criterion was silently absent from.
  const { report } = await validate(allComplete());
  assert.equal(report.liveBenchmarkComplete, false);
  assert.ok(report.missingCases.includes("hard-stress-test"));
  assert.ok(report.expectedCases === 10);
});

test("live validator: --strict exits non-zero while live evidence is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "figdes-live-strict-"));
  try {
    const out = join(dir, "report.json");
    await assert.rejects(
      run(process.execPath, [script, "--strict"], {
        env: { ...process.env, FIGDES_LIVE_DIR: dir, FIGDES_LIVE_REPORT: out },
      }),
      (err) => {
        assert.equal(err.code, 1, "--strict must fail while the stress frame is unevidenced");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("live validator: the report publishes the evidence shape it demands", async () => {
  // A validator that rejects an artifact nobody can construct is a validator
  // that always reports incomplete. The expected shape is part of the contract.
  const dir = await mkdtemp(join(tmpdir(), "figdes-live-shape-"));
  try {
    const out = join(dir, "report.json");
    await run(process.execPath, [script], {
      env: { ...process.env, FIGDES_LIVE_DIR: dir, FIGDES_LIVE_REPORT: out },
    });
    const report = JSON.parse(await readFile(out, "utf8"));
    const shape = report.stressFrame.evidenceShape;
    assert.deepEqual(report.stressFrame.mustResolve, MUST_RESOLVE);
    assert.equal(shape.canvasWidth, 1600);
    assert.equal(shape.canvasHeight, 1100);
    assert.ok(shape.postMutationRender.revision.includes("last mutation"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});