#!/usr/bin/env node
/**
 * Executable offline benchmark for the task-driven planner.
 *
 * This runner exercises real planning code for all nine benchmark briefs and
 * records structural evidence. It deliberately does not fabricate visual
 * scores: those require screenshots from a live Figma/plugin render.
 *
 * Usage: npm run benchmark:design
 * Output: artifacts/design-benchmark/latest.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planScreen } from "../mcp-server/dist-test/plan/planner.js";
import { BENCHMARKS } from "../mcp-server/dist-test/design/benchmark/suite.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = resolve(root, process.env.FIGDES_BENCHMARK_OUTPUT ?? "artifacts/design-benchmark/latest.json");

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
};

function inspectPlan(benchmark, plan) {
  const regions = Array.isArray(plan.regions) ? plan.regions : [];
  const ids = regions.map((region) => String(region.id ?? ""));
  const reasonsPresent = regions.every((region) => typeof region.because === "string" && region.because.trim().length > 10);
  const fallback = plan.derivation?.strategy === "shell-fallback";
  const metricCardWall = regions.filter((region) => /metric-card|stat-card|kpi-card/i.test(String(region.id) + " " + String(region.role))).length >= 3;
  const taskDerived = plan.derivation?.strategy === "task-derived";
  const hasWarnings = Array.isArray(plan.warnings) && plan.warnings.length > 0;
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
    status: Object.values(checks).every(Boolean) && !hasWarnings ? "PASS" : "REVIEW",
    visualEvidence: "NOT_CAPTURED",
    note: "Planner/structure benchmark only; not a screenshot or rendered-design quality score.",
  };
}

const results = [];
for (const benchmark of BENCHMARKS) {
  const plan = planScreen({
    primaryDecision: benchmark.brief,
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
