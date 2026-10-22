#!/usr/bin/env node
/**
 * Offline pipeline-level benchmark and regression gate (issue #22 §6, phase "offline runner").
 *
 * Unlike `run-design-benchmark.mjs`, which drives the bare planner directly,
 * this runner exercises the *whole* plan-mode pipeline for all nine v1 briefs:
 * the brief normalizer, the skill layer, the composition alternatives engine,
 * the anti-generic review, the declared type/spacing criteria audit and the
 * structural verification. It then:
 *
 *   1. scores every case offline (productSpecificity honestly not evaluated —
 *      it scores 0 with its reason recorded);
 *   2. freezes a versioned baseline on first run — the artifact gets committed;
 *   3. on every later run, gates the fresh results against that frozen
 *      baseline; REGRESSION means fix or refuse, improvements still PASS;
 *   4. builds each case's design decision record (§7) — brief, hard
 *      constraints, direction, skills, discoveries, rejected alternatives,
 *      outstanding issues — and persists it next to the run.
 *
 * Output: artifacts/benchmark/issue22-baseline-v1.json (frozen; exit 0 on first freeze)
 *         artifacts/benchmark/decision-records/<caseId>.json
 *         artifacts/benchmark/latest.json           (this run's evidence + verdict)
 *
 * Usage: npm run benchmark:issue22
 *        npm run benchmark:issue22 -- --force   (deliberately re-freeze the baseline)
 *        npm run benchmark:issue22 -- --runs    (also persist per-case run artifacts)
 * Exit:  0 on PASS or first freeze, 1 on REGRESSION or NOT_EVALUATED.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";
import { OFFLINE_BRIEFS, evidenceFromResponse } from "../mcp-server/dist-test/design/benchmark/offline-briefs.js";
import { BASELINE_SCHEMA, serializeBaseline, parseBaseline, runRegressionGate, scoreOfflineEvidence } from "../mcp-server/dist-test/design/benchmark/regression.js";
import { BENCHMARKS } from "../mcp-server/dist-test/design/benchmark/suite.js";
import { buildDecisionRecord, serializeDecisionRecord } from "../mcp-server/dist-test/design/decision-record.js";
import { persistRunArtifact, freezeBaseline, loadFrozenBaseline } from "../mcp-server/dist-test/design/benchmark/artifacts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "artifacts/benchmark");
const decisionDir = resolve(outDir, "decision-records");
const force = process.argv.includes("--force");
const alsoRuns = process.argv.includes("--runs");
const THRESHOLD = 5;

/** The configuration every plan-mode case in this run is executed under. */
const CONFIG = { mode: "plan", render: false, repairBudget: 2, maxRounds: 1 };

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Structure/type/review findings → the record's outstanding-issue shape. */
function issueOf(f, fallbackRule) {
  return {
    rule: String(f?.ruleId ?? f?.rule ?? f?.id ?? fallbackRule ?? "unknown"),
    summary: String(f?.summary ?? f?.why ?? f?.detail ?? ""),
    severity: String(f?.severity ?? "critical"), // findings block by default; the record names which
  };
}

async function runCase(fixture) {
  const resp = await designPipelineTool(null, null, { brief: fixture.brief, mode: "plan" });
  if (resp?.status !== "planned") {
    fail(`case ${fixture.caseId}: unexpected pipeline status "${resp?.status ?? "?"}" (expecting plan mode to plan, not to ${resp?.status ?? "?"})`);
  }

  const evidence = evidenceFromResponse(resp, fixture.caseId);
  const { result, notEvaluated, dimensionEvidence } = scoreOfflineEvidence(evidence);
  const alternatives = resp.visualIntelligence?.alternatives ?? null;
  const rejected = Array.isArray(alternatives?.rejected) ? alternatives.rejected : [];

  const outstandingIssues = [
    ...(resp.structure?.findings ?? []).map((f) => issueOf(f, "structure")),
    ...(resp.typeCriteria?.findings ?? []).map((f) => issueOf(f, "type-criteria")),
    ...(resp.visualIntelligence?.review?.findings ?? []).map((f) => issueOf(f, "anti-generic")),
  ];

  const record = buildDecisionRecord({
    caseId: fixture.caseId,
    brief: fixture.brief,
    intent: resp.visualIntelligence?.intent ?? null,
    steeredComposition: alternatives?.steeredComposition ?? null,
    directionRationale:
      Array.isArray(alternatives?.provenance) && alternatives.provenance.length > 0
        ? alternatives.provenance.join(" | ")
        : "The plan composed freely; no composition was steered.",
    decisions: resp.visualIntelligence?.decisions ?? [],
    discoveries: [
      ...(resp.visualIntelligence?.notes ?? []),
      ...((resp.assumptions ?? []).map((a) => a?.statement).filter((s) => typeof s === "string" && s.length > 0)),
    ],
    rejectedAlternatives: rejected.map((r) => ({
      family: String(r?.family ?? r?.id ?? "unknown"),
      reason: String(r?.reason ?? ""),
      ...(typeof r?.total === "number" ? { total: r.total } : {}),
    })),
    outstandingIssues,
  });

  return { fixture, resp, evidence, result, notEvaluated, dimensionEvidence, record, outstandingIssues };
}

/* -------------------------------------------------------------------------- */

const suiteIds = BENCHMARKS.map((b) => b.id);
const briefIds = OFFLINE_BRIEFS.map((b) => b.caseId);
const missingIds = suiteIds.filter((id) => !briefIds.includes(id));
const extraIds = briefIds.filter((id) => !suiteIds.includes(id));
if (missingIds.length > 0 || extraIds.length > 0) {
  fail(`brief/suite drift: missing ${JSON.stringify(missingIds)}, extra ${JSON.stringify(extraIds)} — fix offline-briefs.ts or suite.ts before measuring.`);
}

console.log(`Running ${briefIds.length} offline benchmark case(s) through the plan-mode pipeline…`);
const runs = [];
for (const fixture of OFFLINE_BRIEFS) {
  const t0 = performance.now();
  const run = await runCase(fixture);
  const ms = Math.round(performance.now() - t0);
  console.log(
    `  ${fixture.caseId}: total ${run.result.total}, dims {${Object.entries(run.result.dimensions)
      .map(([d, s]) => `${d} ${s}`)
      .join(", ")}} [${ms}ms]`,
  );
  console.log(`    not evaluated offline, scored 0: ${run.notEvaluated.length > 0 ? run.notEvaluated.join(", ") : "none"}`);
  runs.push(run);
}

/* --- the baseline --------------------------------------------------------- */

const baselineDoc = {
  schema: BASELINE_SCHEMA,
  suite: "v1-offline-pipeline",
  recordedAt: new Date().toISOString(),
  cases: runs.map((r) => ({
    caseId: r.fixture.caseId,
    brief: {
      screen: r.fixture.brief.screen,
      product: r.fixture.brief.product,
      purpose: r.fixture.brief.purpose,
      primaryDecision: r.fixture.brief.primaryDecision,
      primaryAction: r.fixture.brief.primaryAction,
      requiredInformation: [...r.fixture.brief.requiredInformation],
      optionalInformation: [...r.fixture.brief.optionalInformation],
      desiredComposition: null,
      viewport: { ...r.fixture.brief.viewport },
    },
    config: { ...CONFIG },
    evidence: r.evidence,
    result: r.result,
  })),
};
parseBaseline(serializeBaseline(baselineDoc)); // a baseline that fails its own schema never freezes

/* --- artifacts, every run -------------------------------------------------- */

await mkdir(decisionDir, { recursive: true });
for (const r of runs) {
  await writeFile(resolve(decisionDir, `${r.fixture.caseId}.json`), serializeDecisionRecord(r.record), "utf8");
}
if (alsoRuns) {
  for (const r of runs) {
    const runId = `${new Date().toISOString().slice(0, 10)}_${r.fixture.caseId}`;
    await persistRunArtifact(outDir, {
      schema: "figdes-benchmark-run-v1",
      runId,
      caseId: r.fixture.caseId,
      brief: r.fixture.brief,
      config: { ...CONFIG },
      evidence: r.evidence,
      result: r.result,
      decisionRecord: r.record,
      render: null,
    });
  }
}

const frozen = await loadFrozenBaseline(outDir);
let gate = null;
if (frozen !== null) {
  gate = runRegressionGate({ candidate: runs.map((r) => r.result), baseline: frozen.doc, threshold: THRESHOLD });
}

const latest = {
  recordedAt: baselineDoc.recordedAt,
  suite: baselineDoc.suite,
  gate:
    gate === null
      ? { verdict: "FROZEN", reasons: ["first run — baseline frozen; commit it"], threshold: THRESHOLD }
      : { verdict: gate.verdict, reasons: gate.reasons, threshold: THRESHOLD },
  baselinePath: frozen?.path.replace(root, "").replace(/^[\\/]/, "") ?? "artifacts/benchmark/issue22-baseline-v1.json",
  cases: runs.map((r) => ({
    caseId: r.fixture.caseId,
    total: r.result.total,
    dimensions: r.result.dimensions,
    notes: r.result.notes,
    notEvaluated: r.notEvaluated,
    dimensionEvidence: r.dimensionEvidence,
    outstandingIssues: r.outstandingIssues,
  })),
};
const latestFile = resolve(outDir, "latest.json");
await mkdir(dirname(latestFile), { recursive: true });
await writeFile(latestFile, JSON.stringify(latest, null, 2), "utf8");

/* --- verdict ----------------------------------------------------------------- */

if (gate === null) {
  const path = await freezeBaseline(outDir, baselineDoc, force);
  console.log(`\nFROZEN baseline v1: ${path} (${runs.length} cases). Commit this artifact — future runs gate against it.`);
  process.exit(0);
}

if (gate.verdict === "REGRESSION") {
  console.error(`\nGATE: REGRESSION against ${frozen.path}`);
  for (const reason of gate.reasons) console.error(`  - ${reason}`);
  for (const c of gate.comparison.comparisons) {
    if (c.regressed) {
      console.error(`  ${c.caseId}: baseline ${c.baseline} → candidate ${c.candidate} (${c.delta})`);
    }
  }
  console.error("Fix the regression, or re-freeze with --force and a recorded reason for the new bar.");
  process.exit(1);
}
if (gate.verdict === "NOT_EVALUATED") {
  console.error(`\nGATE: NOT_EVALUATED — ${gate.reasons.join(" ")}`);
  process.exit(1);
}
console.log(`\nGATE: PASS against ${frozen.path}`);
for (const reason of gate.reasons) console.log(`  - ${reason}`);
console.log(`latest.json: ${latestFile}`);
