#!/usr/bin/env node
/**
 * Executable offline benchmark for the task-driven planner.
 *
 * This runner exercises real planning code for all nine benchmark briefs and
 * records structural evidence. It deliberately does not fabricate visual
 * scores: those require screenshots from a live Figma/plugin render.
 *
 * Usage: npm run benchmark:design
 *        npm run benchmark:design -- --expanded   (also run the v2 suite)
 * Output: artifacts/design-benchmark/latest.json
 *         artifacts/design-benchmark/expanded.json (with --expanded)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planScreen } from "../mcp-server/dist-test/plan/planner.js";
import { BENCHMARKS, EXPANDED_BENCHMARKS, EXPANDED_SUITE_VERSION } from "../mcp-server/dist-test/design/benchmark/suite.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(root, process.env.FIGDES_BENCHMARK_OUTPUT ?? "artifacts/design-benchmark/latest.json");
const runExpanded = process.argv.includes("--expanded");

const taskByCase = {
  "exo-compute-topology": "Find the weakest link in the EXO compute topology and identify which device needs attention",
  "exo-model-detail": "Inspect this AI model and decide whether it fits the available local hardware",
  "exo-runtime-monitoring": "Monitor live inference and decide whether to intervene or let it continue",
  "exo-configuration": "Configure and approve the runtime policy and its thresholds",
  "exo-enterprise-workspace": "Explore the enterprise device fleet and act on a subset of assigned devices",
  "generic-saas-dashboard": "Review a generic SaaS dashboard as a negative control; avoid copying its dashboard composition",
  "data-heavy-workspace": "Find events and incidents that need follow-up and identify the owner",
  "spatial-relationship": "Find the weak link in this dependency graph and understand the relationship flow",
  "editorial-product-page": "Compare model run cost, latency, quality, and fit before choosing what to run",
};

const informationByCase = {
  "exo-compute-topology": ["devices", "nodes", "links", "latency", "GPU health", "memory pressure"],
  "exo-model-detail": ["model name", "context length", "memory", "throughput", "supported devices", "fit state"],
  "exo-runtime-monitoring": ["GPU utilization", "memory pressure", "throughput", "error rate", "latency", "temperature"],
  "exo-configuration": ["current settings", "policy", "threshold", "schedule", "provider", "approval status"],
  "exo-enterprise-workspace": ["devices", "models", "team assignments", "deployments", "health", "access policy"],
  "generic-saas-dashboard": ["users", "revenue", "growth", "conversion", "activity", "settings"],
  "data-heavy-workspace": ["events", "incidents", "errors", "owner", "status", "last updated"],
  "spatial-relationship": ["nodes", "edges", "dependencies", "latency", "bandwidth", "weak link"],
  "editorial-product-page": ["model name", "run cost", "latency", "quality", "fit state", "recommendation"],
  // Expanded v2 tasks: unfamiliar domains and uncovered categories.
  "agent-builder-workflow": ["trigger event", "diagnosis steps", "actions", "approvals", "run history"],
  "empty-loading-error-states": ["telemetry stream", "loading state", "empty state", "error state", "retry action"],
  "multi-screen-coherence": ["model name", "fit state", "run status", "throughput", "shared selection"],
  "existing-file-extension": ["existing status pill", "existing inspector", "new telemetry", "component reuse"],
  "unfamiliar-domain": ["berth names", "vessel queue", "crane assignments", "congestion signals", "tide window"],
  "spatial-canvas-challenge": ["cluster nodes", "upgrade order", "dependencies", "risk flags", "rollback plan"],
  "responsive-adaptation": ["search filters", "result rows", "facets", "density at 768 wide", "density at 1440 wide"],
  "constrained-design-system": ["three tokens", "one typeface", "settings", "preview", "commit action"],
};

function inspectPlan(benchmark, plan) {
  const regions = Array.isArray(plan.regions) ? plan.regions : [];
  const ids = regions.map((region) => String(region.id ?? ""));
  const reasonsPresent = regions.every((region) => typeof region.because === "string" && region.because.trim().length > 10);
  const fallback = plan.derivation?.strategy === "shell-fallback";
  const metricCardWall = regions.filter((region) => /metric-card|stat-card|kpi-card/i.test(String(region.id) + " " + String(region.role))).length >= 3;
  const taskDerived = plan.derivation?.strategy === "task-derived";
  const checks = {
    hasRegions: regions.length > 0,
    uniqueRegionIds: new Set(ids).size === ids.length,
    regionRationales: reasonsPresent,
    taskDerived,
    noMetricCardWall: !metricCardWall,
    hasExplicitFallbackReason: !fallback || /name the data|information|fallback/i.test(String(plan.derivation?.note ?? "")),
  };
  return {
    caseId: benchmark.id,
    brief: benchmark.brief,
    requestedPattern: benchmark.patternId,
    decisionKind: benchmark.decisionKind,
    derivation: plan.derivation ?? null,
    intent: plan.intent ?? null,
    regions,
    warnings: plan.warnings ?? [],
    checks,
    passedChecks: Object.values(checks).filter(Boolean).length,
    totalChecks: Object.keys(checks).length,
    status: Object.values(checks).every(Boolean) ? "PASS" : "REVIEW",
    visualEvidence: "NOT_CAPTURED",
    note: "Planner/structure benchmark only; not a screenshot or rendered-design quality score.",
  };
}

const results = [];
for (const benchmark of BENCHMARKS) {
  const plan = planScreen({
    primaryDecision: taskByCase[benchmark.id] ?? benchmark.brief,
    availableInformation: informationByCase[benchmark.id] ?? [],
  });
  results.push(inspectPlan(benchmark, plan));
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runner: "FigDes executable planning benchmark",
  mode: "offline-planner-structural",
  expectedCases: BENCHMARKS.length,
  completedCases: results.length,
  passedCases: results.filter((result) => result.status === "PASS").length,
  reviewCases: results.filter((result) => result.status !== "PASS").map((result) => result.caseId),
  visualBenchmarkComplete: false,
  visualBenchmarkReason: "Live Figma screenshots are not captured by the offline planner runner; do not interpret structural checks as visual approval.",
  results,
};

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({
  output: outPath,
  expectedCases: report.expectedCases,
  completedCases: report.completedCases,
  passedCases: report.passedCases,
  reviewCases: report.reviewCases,
  visualBenchmarkComplete: report.visualBenchmarkComplete,
}, null, 2));

if (results.length !== BENCHMARKS.length) process.exitCode = 1;

// Expanded v2 suite: same structural checks, separate versioned output. The
// v1 baseline above is untouched — this file appends, never weakens.
if (runExpanded) {
  const expandedResults = [];
  for (const benchmark of EXPANDED_BENCHMARKS) {
    const plan = planScreen({
      primaryDecision: benchmark.brief,
      availableInformation: informationByCase[benchmark.id] ?? [],
    });
    expandedResults.push(inspectPlan(benchmark, plan));
  }
  const expandedReport = {
    schemaVersion: 1,
    suiteVersion: EXPANDED_SUITE_VERSION,
    generatedAt: new Date().toISOString(),
    runner: "FigDes executable planning benchmark (expanded)",
    mode: "offline-planner-structural",
    expectedCases: EXPANDED_BENCHMARKS.length,
    completedCases: expandedResults.length,
    passedCases: expandedResults.filter((result) => result.status === "PASS").length,
    reviewCases: expandedResults.filter((result) => result.status !== "PASS").map((result) => result.caseId),
    visualBenchmarkComplete: false,
    visualBenchmarkReason: "Live Figma screenshots are not captured by the offline planner runner; do not interpret structural checks as visual approval.",
    results: expandedResults,
  };
  const expandedPath = resolve(root, "artifacts/design-benchmark/expanded.json");
  await writeFile(expandedPath, JSON.stringify(expandedReport, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    output: expandedPath,
    suiteVersion: EXPANDED_SUITE_VERSION,
    expectedCases: expandedReport.expectedCases,
    completedCases: expandedReport.completedCases,
    passedCases: expandedReport.passedCases,
    reviewCases: expandedReport.reviewCases,
  }, null, 2));
  if (expandedResults.length !== EXPANDED_BENCHMARKS.length) process.exitCode = 1;
}
