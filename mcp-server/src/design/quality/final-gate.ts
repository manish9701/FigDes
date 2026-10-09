/**
 * Visual Quality Gate + iteration/discovery budgets (spec §18, §19, §20).
 *
 * Extends the existing quality gate (`review/quality.ts`) into the final
 * `FinalQualityReport` with eight scored dimensions, and owns the loop budgets:
 * initial build (1) + major visual review (1) + repair passes (1–3) with a
 * maximum of 4 renders. Past the budget the screen is FAIL/REVIEW with a useful
 * reason — never an infinite loop.
 */
import type { GenericityReport } from "./genericity";

export interface FinalScores {
  hierarchy: number;
  composition: number;
  typography: number;
  readability: number;
  density: number;
  distinctiveness: number;
  genericity: number;
  productFit: number;
}

export interface FinalQualityReport {
  status: "PASS" | "REVIEW" | "FAIL";
  scores: FinalScores;
  blockingIssues: string[];
  repairHistory: string[];
  renderEvidence: Array<{ render: number; note: string }>;
  reason: string;
}

/** Phase 9 thresholds. Calibrate through benchmark tests, not vibes. */
export const FINAL_THRESHOLDS = {
  genericityFailAbove: 70,
  hierarchyReviewBelow: 60,
  readabilityFailBelow: 70,
  productFitReviewBelow: 60,
} as const;

export const ITERATION_BUDGET = {
  initialBuilds: 1,
  majorReviews: 1,
  minRepairPasses: 1,
  maxRepairPasses: 3,
  maxRenders: 4,
} as const;

export const DISCOVERY_BUDGET = {
  phases: ["current page + relevant context", "semantic component/style search", "expand only if confidence is low"] as const,
} as const;

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Evaluates the final gate from the extended critique + structural state.
 * All inputs are 0–100 evidence-backed numbers supplied by the caller (score
 * dimensions ×10, genericity inverted); this function only applies thresholds.
 */
export function evaluateFinalGate(input: {
  scores: Partial<FinalScores>;
  genericity?: GenericityReport | null;
  blockingIssues?: string[];
  repairHistory?: string[];
  renders?: number;
  renderNotes?: string[];
}): FinalQualityReport {
  const scores: FinalScores = {
    hierarchy: clamp(input.scores.hierarchy ?? 50),
    composition: clamp(input.scores.composition ?? 50),
    typography: clamp(input.scores.typography ?? 50),
    readability: clamp(input.scores.readability ?? 50),
    density: clamp(input.scores.density ?? 50),
    distinctiveness: clamp(input.scores.distinctiveness ?? 50),
    genericity: clamp(input.genericity ? 100 - input.genericity.score : (input.scores.genericity ?? 50)),
    productFit: clamp(input.scores.productFit ?? 50),
  };
  const blocking = [...(input.blockingIssues ?? [])];
  if (input.genericity && input.genericity.score > FINAL_THRESHOLDS.genericityFailAbove) {
    blocking.push(`Genericity ${input.genericity.score}/100 exceeds ${FINAL_THRESHOLDS.genericityFailAbove}: ${input.genericity.findings.map((f) => f.id).join(", ")}`);
  }
  if (scores.readability < FINAL_THRESHOLDS.readabilityFailBelow) {
    blocking.push(`Readability ${scores.readability} below ${FINAL_THRESHOLDS.readabilityFailBelow}.`);
  }
  const renders = input.renders ?? 0;
  if (renders > ITERATION_BUDGET.maxRenders) {
    blocking.push(`Render budget exhausted (${renders}/${ITERATION_BUDGET.maxRenders}). Stop and report.`);
  }
  if (blocking.length > 0) {
    return {
      status: "FAIL",
      scores,
      blockingIssues: blocking,
      repairHistory: input.repairHistory ?? [],
      renderEvidence: (input.renderNotes ?? []).map((note, i) => ({ render: i + 1, note })),
      reason: "Blocking visual-quality issues remain. Repair and re-render within budget.",
    };
  }
  const needsReview =
    scores.hierarchy < FINAL_THRESHOLDS.hierarchyReviewBelow || scores.productFit < FINAL_THRESHOLDS.productFitReviewBelow;
  if (needsReview) {
    return {
      status: "REVIEW",
      scores,
      blockingIssues: [],
      repairHistory: input.repairHistory ?? [],
      renderEvidence: (input.renderNotes ?? []).map((note, i) => ({ render: i + 1, note })),
      reason: "No blocking issues, but hierarchy or product fit needs a human look before done.",
    };
  }
  return {
    status: "PASS",
    scores,
    blockingIssues: [],
    repairHistory: input.repairHistory ?? [],
    renderEvidence: (input.renderNotes ?? []).map((note, i) => ({ render: i + 1, note })),
    reason: "No blocking issues; hierarchy and product fit hold.",
  };
}
