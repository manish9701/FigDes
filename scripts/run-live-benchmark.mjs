#!/usr/bin/env node
/**
 * Live Figma benchmark validator (handoff §9).
 *
 * Separate from the offline structural runner: this mode checks the
 * agent-driven live artifacts in artifacts/design-benchmark/live/ against the
 * required evidence schema (brief/fixtures, candidate direction, IR/operation
 * manifest, native frame ID, screenshot, structural + visual findings/scores,
 * repairs, unresolved, runtime, commit).
 *
 * It never fabricates screenshots or scores. When no live session ran, it
 * reports liveBenchmarkComplete:false with the exact reason and exits 0 —
 * a missing live run is a blocker to report, not a CI failure.
 *
 * Usage: npm run benchmark:live [-- --strict]
 * Output: artifacts/design-benchmark/live-report.json
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { compareImages, IMAGE_POLICY } from "./lib/image-diff.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveDir = resolve(process.env.FIGDES_LIVE_DIR ?? resolve(root, "artifacts/design-benchmark/live"));
const outPath = resolve(root, process.env.FIGDES_LIVE_REPORT ?? "artifacts/design-benchmark/live-report.json");
const strict = process.argv.includes("--strict");

const EXPECTED = [
  "exo-compute-topology",
  "exo-model-detail",
  "exo-runtime-monitoring",
  "exo-configuration",
  "exo-enterprise-workspace",
  "generic-saas-dashboard",
  "data-heavy-workspace",
  "spatial-relationship",
  "editorial-product-page",
  // Issue #10's hard stress frame. Carried here rather than left as a note in
  // the issue because an acceptance criterion nobody can run is not a criterion.
  "hard-stress-test",
];

/**
 * The stress frame (issue #10) has to prove something the other nine cannot:
 * that the *same* 1600x1100 frame still renders and reviews clean **after** the
 * final mutation that fixed the reported defects.
 *
 * A screenshot that merely exists is not that proof — a render taken before the
 * fix passes the same check while proving nothing. So the render is bound to a
 * revision, and the revision must equal the last recorded mutation's. That turns
 * "rendered and reviewed after the final mutation" into something a validator
 * can check rather than something a human must be trusted to remember.
 */
const STRESS_CASE_ID = "hard-stress-test";
const STRESS_REQUIRED_EVIDENCE = [
  "canvasWidth",
  "canvasHeight",
  "nativeFrameId",
  "mutations",
  "postMutationRender",
  "postMutationReview",
  "unresolved",
  // Which builds produced the evidence. The server is deployed and Figma
  // loads the plugin bundle once, so either can be older than the repository,
  // and a measurement that cannot name them describes code that may no longer
  // exist.
  "serverBuild",
  "pluginBuild",
];
const STRESS_CANVAS = { width: 1600, height: 1100 };

/** Issues #10 fixed; the review must show these are actually gone. */
const STRESS_MUST_RESOLVE = [
  "empty-guard-snapshot",
  "off-canvas-geometry",
  "unresolved-connectors",
  "arc-bounds",
  "contrast-repair",
  "review-semantics",
];

/** Handoff §9 required evidence per live case. */
const REQUIRED_EVIDENCE = [
  "screenshotReference",
  "visualScores",
  "nativeFrameId",
  "operationManifest",
  "structuralFindings",
  "repairs",
  "unresolved",
];

const cases = [];
let files = [];
try {
  files = (await readdir(liveDir)).filter((f) => f.startsWith("case-") && f.endsWith(".json")).sort();
} catch {
  files = [];
}

/**
 * Checks the stress frame's post-mutation evidence.
 *
 * Returns a list of problems, empty when the evidence actually proves the claim.
 * Three things must hold: the canvas is the one the issue named, the render is
 * bound to the last mutation (not a pre-fix screenshot), and the review shows
 * each reported defect resolved rather than merely re-listed.
 */
function validateStressFrame(parsed) {
  const problems = [];

  if (parsed.canvasWidth !== STRESS_CANVAS.width || parsed.canvasHeight !== STRESS_CANVAS.height) {
    problems.push(
      `canvas is ${parsed.canvasWidth}x${parsed.canvasHeight}, but issue #10 fixed a ${STRESS_CANVAS.width}x${STRESS_CANVAS.height} frame. Rendering a different size proves nothing about that fix.`,
    );
  }

  const mutations = Array.isArray(parsed.mutations) ? parsed.mutations : [];
  if (mutations.length === 0) {
    problems.push("no mutations recorded: there is no 'final mutation' for the render to follow.");
  } else {
    const last = mutations[mutations.length - 1];
    const render = parsed.postMutationRender ?? {};
    if (!render.revision) {
      problems.push("postMutationRender carries no revision, so it cannot be shown to follow the final mutation.");
    } else if (last && last.revision && render.revision !== last.revision) {
      problems.push(
        `postMutationRender is revision '${render.revision}' but the final mutation is '${last.revision}'. A render taken before the last change proves nothing about it.`,
      );
    }
  }

  const review = parsed.postMutationReview ?? {};
  const resolved = new Set(Array.isArray(review.resolved) ? review.resolved : []);
  const stillOpen = new Set(Array.isArray(review.stillOpen) ? review.stillOpen : []);
  for (const defect of STRESS_MUST_RESOLVE) {
    if (stillOpen.has(defect)) {
      problems.push(`'${defect}' is still open after the final mutation.`);
    } else if (!resolved.has(defect)) {
      problems.push(`'${defect}' is neither resolved nor still open: the review did not say.`);
    }
  }
  if (!Array.isArray(review.findings) || review.findings.length === 0) {
    problems.push("postMutationReview carries no findings: a review that found nothing must still say it looked.");
  }

  return problems;
}

for (const file of files) {
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(resolve(liveDir, file), "utf8"));
  } catch (err) {
    cases.push({ file, caseId: null, status: "UNREADABLE", missing: REQUIRED_EVIDENCE, error: String(err?.message ?? err) });
    continue;
  }
  const caseId = typeof parsed.caseId === "string" ? parsed.caseId : null;
  const required = caseId === STRESS_CASE_ID ? [...REQUIRED_EVIDENCE, ...STRESS_REQUIRED_EVIDENCE] : REQUIRED_EVIDENCE;
  const missing = required.filter((key) => {
    const v = parsed[key];
    // An empty array is legitimate for the evidence keys that describe an
    // absence (no findings, no repairs, nothing unresolved). It is *not*
    // legitimate for `mutations`: the whole point of the stress case is that
    // there was a final mutation for the render to follow.
    if (Array.isArray(v)) return v.length === 0 && !["unresolved", "structuralFindings", "repairs", "resolved", "findings"].includes(key);
    return v === undefined || v === null || v === "";
  });
  const fixtureOk = Array.isArray(parsed.fixtures)
    ? parsed.fixtures.every((f) => f && f.fixture === true)
    : true;

  // The stress frame additionally has to prove it was rendered *after* the fix
  // and that the fix held, so a plain "keys are present" check is not enough.
  const stressProblems = caseId === STRESS_CASE_ID ? validateStressFrame(parsed) : [];
  const unresolvedStress = Array.isArray(parsed.unresolved)
    ? parsed.unresolved.filter((u) => typeof u === "string" && STRESS_MUST_RESOLVE.includes(u))
    : [];

  cases.push({
    file,
    caseId,
    status: missing.length === 0 && fixtureOk && stressProblems.length === 0 && unresolvedStress.length === 0 ? "COMPLETE" : "INCOMPLETE",
    missing,
    // Which builds measured this case, so a reader can tell a fresh
    // measurement from one taken against a deployment that has since moved on.
    build: {
      commit: parsed.commit ?? null,
      serverBuild: parsed.serverBuild ?? null,
      pluginBuild: parsed.pluginBuild ?? null,
      note:
        parsed.serverBuild === undefined && parsed.pluginBuild === undefined
          ? "This case was measured before the build stamps existed, so it cannot be tied to a commit."
          : null,
    },
    ...(stressProblems.length > 0 ? { stressProblems } : {}),
    ...(unresolvedStress.length > 0
      ? { unresolvedDefects: unresolvedStress, note: "a defect from issue #10 is listed as still unresolved" }
      : {}),
    ...(fixtureOk ? {} : { fixtureViolation: "fixtures must be marked {fixture:true}; no real-looking invented data" }),
  });
}

/**
 * The native path's own evidence.
 *
 * The semantic runtime and the plugin's `create_design` transaction are one
 * path; `figdes_use_figma` — model-authored JavaScript against the real Plugin
 * API — is another, with its own rules. It is checked here rather than in the
 * semantic cases, because a check that cannot fail is not a check.
 */
const nativePathPath = resolve(liveDir, "native-check.json");
let nativePath = { status: "MISSING", reason: "no native-path check has been run" };
if (existsSync(nativePathPath)) {
  try {
    const body = JSON.parse(await readFile(nativePathPath, "utf8"));
    // The native path is only proven if the frame it created was removed
    // again: a check that leaves debris behind is not a check, it is a change.
    const cleanupVerified = body.cleanup?.remainingMatches === 0;
    nativePath = {
      status: body.status === "COMPLETE" && cleanupVerified ? "COMPLETE" : "INCOMPLETE",
      reportedStatus: body.status ?? "UNKNOWN",
      cleanupVerified,
      rootId: body.rootId ?? null,
      createdNodes: Array.isArray(body.createdNodeIds) ? body.createdNodeIds.length : 0,
      measured: body.measured ?? null,
      cleanup: body.cleanup ?? null,
      serverBuild: body.serverBuild ?? null,
      pluginBuild: body.pluginBuild ?? null,
      note: body.note ?? null,
    };
  } catch (err) {
    nativePath = { status: "UNREADABLE", reason: String(err?.message ?? err) };
  }
}

const covered = new Set(cases.map((c) => c.caseId).filter(Boolean));
const missingCases = EXPECTED.filter((id) => !covered.has(id));
const complete = cases.filter((c) => c.status === "COMPLETE");
const liveBenchmarkComplete =
  missingCases.length === 0 &&
  cases.length === EXPECTED.length &&
  complete.length === EXPECTED.length &&
  nativePath.status === "COMPLETE";

/**
 * Which commit each case was measured against, and whether that is the
 * repository now.
 *
 * A live measurement is only evidence about the code it ran. The cases were
 * taken over several sessions, so some of them describe an older commit — and
 * the deployment the plugin talks to is not the repository until it is
 * redeployed. Saying so is the difference between evidence and a claim.
 */
let repoHead = null;
try {
  repoHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  repoHead = null;
}
const buildDrift = cases.map((c) => {
  const measured = c.build?.commit ?? null;
  return {
    caseId: c.caseId,
    measuredAtCommit: measured,
    repoHead,
    stale: measured !== null && repoHead !== null && !measured.startsWith(repoHead.slice(0, 12)),
    serverBuild: c.build?.serverBuild ?? null,
    pluginBuild: c.build?.pluginBuild ?? null,
    // A case that names a commit but not the build that produced it is
    // claiming more than it can back: the commit is the repository's, and the
    // deployment is not the repository until it is redeployed.
    buildNamed: Boolean(c.build?.serverBuild) && c.build.serverBuild !== "unknown",
    note: c.build?.note ?? null,
  };
});
const staleCases = buildDrift.filter((d) => d.stale);
const casesWithoutBuild = buildDrift.filter((d) => !d.buildNamed);

/**
 * The visual regression: every case against its reviewed golden.
 *
 * Two axes, and both have to agree — the structure (what the screen is) and the
 * pixels (how it looks). A difference in either is reported; neither decides
 * alone, and a case with no golden says so rather than passing quietly.
 */
const goldensDir = resolve(liveDir, "goldens");
const visualRegression = [];
for (const c of cases) {
  if (!c.caseId) continue;
  const casePath = resolve(liveDir, `case-${c.caseId}.json`);
  const goldenPath = resolve(goldensDir, `${c.caseId}.png`);
  const goldenMetaPath = resolve(goldensDir, `${c.caseId}.json`);
  if (!existsSync(casePath) || !existsSync(goldenPath)) {
    visualRegression.push({ caseId: c.caseId, verdict: "no-golden", reason: "no reviewed golden for this case" });
    continue;
  }
  const body = JSON.parse(await readFile(casePath, "utf8"));
  const currentPath = resolve(root, body.screenshotReference ?? "");
  if (!existsSync(currentPath)) {
    visualRegression.push({ caseId: c.caseId, verdict: "no-render", reason: "the case has no screenshot to compare" });
    continue;
  }
  const pixels = compareImages(await readFile(currentPath), await readFile(goldenPath));
  const signature = {
    reviewedNodes: body.reviewedNodes ?? null,
    findingCount: Array.isArray(body.structuralFindings) ? body.structuralFindings.length : null,
    regionNames: Array.isArray(body.plan?.regions) ? body.plan.regions.map((r) => r.id) : [],
  };
  const goldenSignature = existsSync(goldenMetaPath)
    ? (JSON.parse(await readFile(goldenMetaPath, "utf8")).signature ?? null)
    : null;
  const structureChanged =
    goldenSignature !== null && JSON.stringify(goldenSignature) !== JSON.stringify(signature);
  visualRegression.push({
    caseId: c.caseId,
    verdict: pixels.verdict === "match" && !structureChanged ? "match" : "differs",
    pixels: pixels.verdict,
    structureChanged,
    measured: pixels.measured,
    reason: pixels.reason ?? (structureChanged ? "the structure changed since the golden was reviewed" : null),
  });
}
const regressionDiffs = visualRegression.filter((v) => v.verdict === "differs");
const regressionUncovered = visualRegression.filter((v) => v.verdict === "no-golden" || v.verdict === "no-render");

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  runner: "FigDes live benchmark validator",
  mode: "live-plugin",
  expectedCases: EXPECTED.length,
  foundCases: cases.length,
  completeCases: complete.length,
  missingCases,
  liveBenchmarkComplete,
  liveBenchmarkReason: liveBenchmarkComplete
    ? `All ${EXPECTED.length} live cases carry screenshot, visual scores, frame ID, operation manifest, findings, repairs and unresolved notes; the ${STRESS_CANVAS.width}x${STRESS_CANVAS.height} stress frame was rendered and reviewed after its final mutation with every issue #10 defect resolved; and the native path was exercised against the real Plugin API and cleaned up afterwards.`
    : "Live Figma evidence is incomplete: run the cases against a connected plugin (render → critique → repair → verify) and the native-path check, then re-run this validator. The stress frame additionally needs a render and a review bound to its final mutation. Offline structural results must not be presented as visual approval.",
  buildDrift,
  staleCases: staleCases.map((d) => d.caseId),
  casesWithoutBuild: casesWithoutBuild.map((d) => d.caseId),
  nativePath,
  visualRegression: {
    policy: IMAGE_POLICY,
    cases: visualRegression,
    differing: regressionDiffs.map((v) => v.caseId),
    uncovered: regressionUncovered.map((v) => v.caseId),
    note:
      "A golden is a regression reference, not an approval: the review rules judge the screen, and the golden records what it looked like when a human looked at it.",
  },
  stressFrame: {    caseId: STRESS_CASE_ID,
    canvas: STRESS_CANVAS,
    mustResolve: STRESS_MUST_RESOLVE,
    evidenceShape: {
      canvasWidth: STRESS_CANVAS.width,
      canvasHeight: STRESS_CANVAS.height,
      nativeFrameId: "<figma node id of the 1600x1100 frame>",
      mutations: [{ revision: "<revision hash>", summary: "<what changed>" }],
      postMutationRender: { revision: "<must equal the last mutation's revision>", screenshotReference: "<png path>" },
      postMutationReview: {
        revision: "<same revision>",
        findings: [{ rule: "<id>", detail: "<what was seen in the render>" }],
        resolved: STRESS_MUST_RESOLVE,
        stillOpen: [],
      },
      unresolved: [],
    },
  },
  cases,
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  output: outPath,
  expectedCases: report.expectedCases,
  foundCases: report.foundCases,
  completeCases: report.completeCases,
  missingCases: report.missingCases,
  liveBenchmarkComplete: report.liveBenchmarkComplete,
  repoHead: repoHead ? repoHead.slice(0, 12) : null,
  staleCases: report.staleCases,
  casesWithoutBuild: report.casesWithoutBuild,
  visualRegression: {
    differing: report.visualRegression.differing,
    uncovered: report.visualRegression.uncovered,
  },
  nativePath: { status: report.nativePath.status, createdNodes: report.nativePath.createdNodes },
}, null, 2));

if (strict && !liveBenchmarkComplete) process.exitCode = 1;
