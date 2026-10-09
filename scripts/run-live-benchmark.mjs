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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveDir = resolve(root, "artifacts/design-benchmark/live");
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

for (const file of files) {
  let parsed = null;
  try {
    parsed = JSON.parse(await readFile(resolve(liveDir, file), "utf8"));
  } catch (err) {
    cases.push({ file, caseId: null, status: "UNREADABLE", missing: REQUIRED_EVIDENCE, error: String(err?.message ?? err) });
    continue;
  }
  const caseId = typeof parsed.caseId === "string" ? parsed.caseId : null;
  const missing = REQUIRED_EVIDENCE.filter((key) => {
    const v = parsed[key];
    if (Array.isArray(v)) return v.length === 0 && key !== "unresolved" && key !== "structuralFindings" && key !== "repairs";
    return v === undefined || v === null || v === "";
  });
  const fixtureOk = Array.isArray(parsed.fixtures)
    ? parsed.fixtures.every((f) => f && f.fixture === true)
    : true;
  cases.push({
    file,
    caseId,
    status: missing.length === 0 && fixtureOk ? "COMPLETE" : "INCOMPLETE",
    missing,
    ...(fixtureOk ? {} : { fixtureViolation: "fixtures must be marked {fixture:true}; no real-looking invented data" }),
  });
}

const covered = new Set(cases.map((c) => c.caseId).filter(Boolean));
const missingCases = EXPECTED.filter((id) => !covered.has(id));
const complete = cases.filter((c) => c.status === "COMPLETE");
const liveBenchmarkComplete = missingCases.length === 0 && cases.length === EXPECTED.length && complete.length === EXPECTED.length;

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runner: "FigDes live benchmark validator",
  mode: "live-plugin",
  expectedCases: EXPECTED.length,
  foundCases: cases.length,
  completeCases: complete.length,
  missingCases,
  liveBenchmarkComplete,
  liveBenchmarkReason: liveBenchmarkComplete
    ? "All 9 live cases carry screenshot, visual scores, frame ID, operation manifest, findings, repairs and unresolved notes."
    : "Live Figma evidence is incomplete: run the 9 cases against a connected plugin (render → critique → repair → verify) and re-run this validator. Offline structural results must not be presented as visual approval.",
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
}, null, 2));

if (strict && !liveBenchmarkComplete) process.exitCode = 1;
