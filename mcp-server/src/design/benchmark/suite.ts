/**
 * Phase 10 — Benchmark suite (spec §22, §23).
 *
 * A fixed set of screens with 100-point scoring (hierarchy 15, composition 15,
 * product specificity 15, typography 10, spacing/rhythm 10, relationship
 * clarity 10, density 10, native/editable quality 5, distinctiveness 5,
 * readability 5) plus operational tracking (genericity, repairs, renders,
 * discovery calls, time, cost). The target is not merely a high score: the
 * system must show *why* it improved.
 */

export interface BenchmarkCase {
  id: string;
  brief: string;
  decisionKind: string;
  patternId: string;
}

export const BENCHMARKS: BenchmarkCase[] = [
  { id: "exo-compute-topology", brief: "EXO compute topology: where needs attention", decisionKind: "topology", patternId: "spatial-topology" },
  { id: "exo-model-detail", brief: "EXO model detail: understand this model", decisionKind: "inspect", patternId: "object-inspector" },
  { id: "exo-runtime-monitoring", brief: "EXO runtime monitoring: intervene or let run", decisionKind: "monitor", patternId: "monitoring-instrument" },
  { id: "exo-configuration", brief: "EXO configuration: approve this policy", decisionKind: "configure", patternId: "configuration-workbench" },
  { id: "exo-enterprise-workspace", brief: "EXO enterprise workspace: act on a subset", decisionKind: "explore", patternId: "data-workspace" },
  { id: "generic-saas-dashboard", brief: "Generic SaaS dashboard (negative control: must NOT look like this)", decisionKind: "monitor", patternId: "monitoring-instrument" },
  { id: "data-heavy-workspace", brief: "Data-heavy workspace: find what needs follow-up", decisionKind: "explore", patternId: "exploration-surface" },
  { id: "spatial-relationship", brief: "Spatial relationship interface: find the weak link", decisionKind: "topology", patternId: "relationship-graph" },
  { id: "editorial-product-page", brief: "Editorial product page: run vs change model", decisionKind: "compare", patternId: "editorial-focus" },
];

export const BENCHMARK_WEIGHTS: Record<string, number> = {
  hierarchy: 15,
  composition: 15,
  productSpecificity: 15,
  typography: 10,
  spacingRhythm: 10,
  relationshipClarity: 10,
  density: 10,
  nativeQuality: 5,
  distinctiveness: 5,
  readability: 5,
};

/**
 * What each number means (quality-reliability P1 — scales documented once).
 *
 * - Offline structural (`scoreBenchmark`, BENCHMARK_WEIGHTS): 0–100 from
 *   planner evidence only. No screenshots involved; never visual proof.
 * - Live visual (`scoreLiveBenchmark`, LIVE_SCORECARD_WEIGHTS): 0–100 from a
 *   human/vision-judged render. Critical failure overrides to 0.
 * - Program score (`score_design`): 0–10 per dimension with measured evidence.
 * - Critique/QA gate (PASS/WATCH/FAIL/REVIEW): threshold verdicts, never
 *   averages. Structural, heuristic, human-visual and gate outputs stay
 *   separate — a good average never clears a blocking finding.
 * - Consistency (`evaluateConsistency`): 0–100 token/type/radius discipline.
 *
 * Weights are pinned by test and change only after multiple screens are
 * independently human-rated. Tuning them to make any single run pass is
 * forbidden.
 */
export const SCORECARD_DOCS = {
  offline: "BENCHMARK_WEIGHTS: planner evidence, 0-100, no screenshots",
  live: "LIVE_SCORECARD_WEIGHTS: judged render, 0-100, critical overrides to 0",
  program: "score_design: 0-10 per dimension with evidence",
  gate: "PASS/WATCH/FAIL/REVIEW thresholds, never averages",
  consistency: "evaluateConsistency: 0-100 token/type/radius discipline",
} as const;

export interface BenchmarkResult {
  caseId: string;
  total: number;
  dimensions: Record<string, number>;
  genericity: number;
  repairs: number;
  renders: number;
  discoveryCalls: number;
  notes: string[];
}

/** Scores one benchmark from 0–10 dimension inputs. Deterministic. */
export function scoreBenchmark(input: {
  caseId: string;
  dimensions: Record<string, number>;
  genericity?: number;
  repairs?: number;
  renders?: number;
  discoveryCalls?: number;
}): BenchmarkResult {
  const dimensions: Record<string, number> = {};
  let total = 0;
  for (const [dim, weight] of Object.entries(BENCHMARK_WEIGHTS)) {
    const raw = Math.max(0, Math.min(10, input.dimensions[dim] ?? 0));
    dimensions[dim] = raw;
    total += (raw / 10) * weight;
  }
  return {
    caseId: input.caseId,
    total: Math.round(total * 10) / 10,
    dimensions,
    genericity: input.genericity ?? 0,
    repairs: input.repairs ?? 0,
    renders: input.renders ?? 0,
    discoveryCalls: input.discoveryCalls ?? 0,
    notes: [],
  };
}


export interface BenchmarkSuiteReport {
  expectedCases: number;
  completedCases: number;
  missingCases: string[];
  averageScore: number | null;
  lowestScore: number | null;
  readyForComparison: boolean;
}

/**
 * Handoff §9 live scorecard (starting weights, calibrate against human
 * ratings): composition/hierarchy 25, visual identity 20, typography 20,
 * geometry 15, detail/craft 10, brief fidelity 10. Kept separate from the
 * offline BENCHMARK_WEIGHTS so the structural runner and its tests are
 * untouched; the live runner uses this.
 */
export const LIVE_SCORECARD_WEIGHTS: Record<string, number> = {
  compositionHierarchy: 25,
  visualIdentity: 20,
  typography: 20,
  geometry: 15,
  detailCraft: 10,
  briefFidelity: 10,
};

export interface LiveBenchmarkResult {
  caseId: string;
  total: number;
  dimensions: Record<string, number>;
  criticalFailure: boolean;
}

/**
 * Scores one live case from 0–10 dimension inputs. A critical failure
 * overrides the total to 0 — a broken screen never averages its way to done.
 */
export function scoreLiveBenchmark(input: {
  caseId: string;
  dimensions: Record<string, number>;
  criticalFailure?: boolean;
}): LiveBenchmarkResult {
  const dimensions: Record<string, number> = {};
  let total = 0;
  for (const [dim, weight] of Object.entries(LIVE_SCORECARD_WEIGHTS)) {
    const raw = Math.max(0, Math.min(10, input.dimensions[dim] ?? 0));
    dimensions[dim] = raw;
    total += (raw / 10) * weight;
  }
  const criticalFailure = input.criticalFailure === true;
  return {
    caseId: input.caseId,
    total: criticalFailure ? 0 : Math.round(total * 10) / 10,
    dimensions,
    criticalFailure,
  };
}

/**
 * Summarizes a recorded benchmark run. This intentionally does not claim to
 * render Figma screens: the caller must first generate screens and record
 * evidence-backed scores for each case. The `cases` parameter defaults to the
 * pinned v1 baseline so existing callers are unaffected; the expanded suite
 * passes its own case list and version.
 */
export function summarizeBenchmarkRun(results: BenchmarkResult[], cases: readonly BenchmarkCase[] = BENCHMARKS): BenchmarkSuiteReport {
  const byCase = new Map<string, BenchmarkResult>();
  for (const result of results) {
    if (cases.some((benchmark) => benchmark.id === result.caseId)) byCase.set(result.caseId, result);
  }
  const completed = cases.filter((benchmark) => byCase.has(benchmark.id)).map((benchmark) => byCase.get(benchmark.id)!);
  const scores = completed.map((result) => result.total);
  const missingCases = cases.filter((benchmark) => !byCase.has(benchmark.id)).map((benchmark) => benchmark.id);
  return {
    expectedCases: cases.length,
    completedCases: completed.length,
    missingCases,
    averageScore: scores.length ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10 : null,
    lowestScore: scores.length ? Math.min(...scores) : null,
    readyForComparison: missingCases.length === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Baseline-vs-candidate comparison + regression tracking (blueprint §11)       */
/* -------------------------------------------------------------------------- */

/**
 * Challenge categories from the blueprint's §11 matrix that have no dedicated
 * benchmark case yet. Kept as data — not appended to BENCHMARKS, whose length
 * is pinned by test — so the gap is explicit and plannable rather than silent.
 */
export const UNCOVERED_CHALLENGE_CATEGORIES: readonly string[] = [
  "workflow-or-agent-builder",
  "empty-loading-error-states",
  "multi-screen-product-coherence",
  "existing-file-extension-with-component-reuse",
  "unfamiliar-domain-generalization",
  "spatial-canvas-challenge",
  "responsive-adaptation",
  "design-system-adherence-under-constraints",
];

/**
 * A positive control: an authored screen that must score well. The suite has
 * long had a negative control (generic-saas-dashboard, must NOT look like
 * this); without a positive control there is no proof the scorer can
 * recognise good work rather than merely punish bad work.
 */
export const POSITIVE_CONTROL_CASE: BenchmarkCase = {
  id: "authored-spatial-positive-control",
  brief: "Authored spatial screen (positive control: must score well)",
  decisionKind: "topology",
  patternId: "spatial-topology",
};

export interface BenchmarkComparison {
  caseId: string;
  baseline: number;
  candidate: number;
  delta: number;
  improved: boolean;
  regressed: boolean;
  /** A drop of at least this much counts as a regression, not noise. */
  regressionThreshold: number;
}

export interface BenchmarkComparisonReport {
  comparisons: BenchmarkComparison[];
  improvements: number;
  regressions: string[];
  regressionRate: number;
  /** True only when several categories improved and nothing regressed. */
  broadImprovement: boolean;
  summary: string;
}

/**
 * Compares two runs of the same cases. Dimensions are preserved per case by
 * the caller; this reports wins and regressions without collapsing them into
 * one number that could hide a failure.
 */
export function compareBenchmarkRuns(
  baseline: BenchmarkResult[],
  candidate: BenchmarkResult[],
  regressionThreshold = 5,
): BenchmarkComparisonReport {
  const baseByCase = new Map(baseline.map((r) => [r.caseId, r]));
  const comparisons: BenchmarkComparison[] = [];
  for (const next of candidate) {
    const prev = baseByCase.get(next.caseId);
    if (!prev) continue;
    const delta = Math.round((next.total - prev.total) * 10) / 10;
    comparisons.push({
      caseId: next.caseId,
      baseline: prev.total,
      candidate: next.total,
      delta,
      improved: delta > 0,
      regressed: delta <= -regressionThreshold,
      regressionThreshold,
    });
  }
  const improvements = comparisons.filter((c) => c.improved).length;
  const regressions = comparisons.filter((c) => c.regressed).map((c) => c.caseId);
  const broadImprovement = comparisons.length > 0 && improvements >= 2 && regressions.length === 0;
  return {
    comparisons,
    improvements,
    regressions,
    regressionRate: comparisons.length === 0 ? 0 : Math.round((regressions.length / comparisons.length) * 100) / 100,
    broadImprovement,
    summary:
      comparisons.length === 0
        ? "No shared cases between baseline and candidate runs."
        : `${improvements}/${comparisons.length} improved, ${regressions.length} regressed${regressions.length > 0 ? ` (${regressions.join(", ")})` : ""}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Expanded suite v2 (Phase 1.4): the uncovered categories, versioned apart    */
/* -------------------------------------------------------------------------- */

/**
 * The v1 baseline (BENCHMARKS, 9 cases) is frozen: existing tests pin its
 * length and its runner asserts its shape. The expanded suite covers the
 * eight §11 categories v1 never exercised, under its own version, so results
 * compare across suites without weakening the original tests.
 */
export const EXPANDED_SUITE_VERSION = "benchmark-v2";

export const EXPANDED_BENCHMARKS: BenchmarkCase[] = [
  { id: "agent-builder-workflow", brief: "Agent builder: compose a diagnose-then-act workflow", decisionKind: "author", patternId: "canvas-workspace" },
  { id: "empty-loading-error-states", brief: "Empty, loading and error states for a telemetry screen", decisionKind: "monitor", patternId: "monitoring-instrument" },
  { id: "multi-screen-coherence", brief: "Two screens, one journey: choose a model then watch it run", decisionKind: "compare", patternId: "editorial-focus" },
  { id: "existing-file-extension", brief: "Extend the file's own components instead of rebuilding", decisionKind: "inspect", patternId: "object-inspector" },
  { id: "unfamiliar-domain", brief: "Harbour logistics: berth congestion at a container terminal", decisionKind: "topology", patternId: "spatial-topology" },
  { id: "spatial-canvas-challenge", brief: "Free-form canvas: arrange a cluster upgrade plan", decisionKind: "topology", patternId: "relationship-graph" },
  { id: "responsive-adaptation", brief: "Find results on any viewport: the same explore screen at 1440 and 768 wide", decisionKind: "explore", patternId: "exploration-surface" },
  { id: "constrained-design-system", brief: "Build with only three tokens and one typeface", decisionKind: "configure", patternId: "configuration-workbench" },
];

/* -------------------------------------------------------------------------- */
/* Three-outcome challenge scoring (Phase 3)                                    */
/* -------------------------------------------------------------------------- */

/**
 * One challenge, three independent verdicts:
 * - structural: the plan and the Figma structure are valid;
 * - visual: the rendered design meets quality criteria;
 * - product: the design serves the intended task and preserves context.
 *
 * Each outcome is PASS, FAIL, PENDING or NOT_APPLICABLE with its own reasons.
 * Aggregation never hides a critical failure behind a good average: any FAIL
 * on a required outcome is an overall FAIL; a PENDING required outcome keeps
 * the whole challenge PENDING.
 */

export type ChallengeOutcome = "PASS" | "FAIL" | "PENDING" | "NOT_APPLICABLE";

export interface OutcomeInput {
  status: ChallengeOutcome;
  reasons?: string[];
  /** Finding or evidence ids backing this outcome. */
  evidenceIds?: string[];
}

export interface ChallengeScore {
  caseId: string;
  suiteVersion: string;
  structural: OutcomeInput & { required: true };
  visual: OutcomeInput & { required: true };
  product: OutcomeInput & { required: true };
  overall: ChallengeOutcome;
  reason: string;
  notVerified: string[];
}

export function scoreChallenge(input: {
  caseId: string;
  suiteVersion?: string;
  structural: OutcomeInput;
  visual: OutcomeInput;
  product: OutcomeInput;
  /** Outcomes that may be NOT_APPLICABLE without failing the challenge. */
  optionalOutcomes?: Array<"visual" | "product">;
}): ChallengeScore {
  const suiteVersion = input.suiteVersion ?? EXPANDED_SUITE_VERSION;
  const optional = new Set(input.optionalOutcomes ?? []);
  const outcomes = {
    structural: { ...input.structural, required: true as const },
    visual: { ...input.visual, required: true as const },
    product: { ...input.product, required: true as const },
  };
  const notVerified: string[] = [];
  for (const [name, outcome] of Object.entries(outcomes) as Array<[string, OutcomeInput]>) {
    if (outcome.status === "PENDING" || outcome.status === "NOT_APPLICABLE") {
      notVerified.push(`${name}: ${outcome.reasons?.[0] ?? "not evaluated"}`);
    }
  }

  const fail = (["structural", "visual", "product"] as const).find((name) => outcomes[name].status === "FAIL");
  if (fail) {
    return {
      caseId: input.caseId, suiteVersion,
      ...outcomes,
      overall: "FAIL",
      reason: `${fail} failed: ${outcomes[fail].reasons?.[0] ?? "see evidence"}. A good average never clears a failed outcome.`,
      notVerified,
    };
  }
  const pending = (["structural", "visual", "product"] as const).find(
    (name) => outcomes[name].status === "PENDING" && !optional.has(name as "visual" | "product"),
  );
  if (pending) {
    return {
      caseId: input.caseId, suiteVersion,
      ...outcomes,
      overall: "PENDING",
      reason: `${pending} is still pending: ${outcomes[pending].reasons?.[0] ?? "see evidence"}. Pending stays pending.`,
      notVerified,
    };
  }
  const naRequired = (["structural", "visual", "product"] as const).find(
    (name) => outcomes[name].status === "NOT_APPLICABLE" && !optional.has(name as "visual" | "product"),
  );
  if (naRequired) {
    return {
      caseId: input.caseId, suiteVersion,
      ...outcomes,
      overall: "PENDING",
      reason: `${naRequired} was marked not applicable but is required for this challenge. Evaluate it or declare it optional explicitly.`,
      notVerified,
    };
  }
  return {
    caseId: input.caseId, suiteVersion,
    ...outcomes,
    overall: "PASS",
    reason: "Structural, visual and product outcomes each passed on their own evidence.",
    notVerified,
  };
}
