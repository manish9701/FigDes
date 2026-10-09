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
