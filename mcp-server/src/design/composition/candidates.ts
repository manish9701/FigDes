/**
 * Composition candidates: generate, score, choose (blueprint §4.1–§4.3).
 *
 * The previous planner produced one recommended composition plus, for three of
 * nine decision kinds, **zero** alternatives — and even when alternatives
 * existed they were the same regions with a different label, which is exactly
 * what §4.1 forbids ("changing only colour, corner radius or card count does
 * not count as a distinct composition").
 *
 * This module fixes both halves:
 *
 * - A `CompositionHypothesis` carries the six axes §4.1 names (information
 *   architecture, spatial arrangement, interaction pattern, relative
 *   emphasis, navigation model, treatment of the main object), so
 *   distinctness is measurable rather than rhetorical.
 * - Candidates are scored on the ten dimensions §4.3 lists, with configurable,
 *   versioned weights. Raw dimensions and the written rationale are always
 *   retained, and a single strong score can never hide a serious failure in
 *   one dimension — a candidate with a disqualifying dimension is rejected on
 *   that dimension and the reason is recorded.
 */
import { hashContent } from "../quality/revision";

/* -------------------------------------------------------------------------- */
/* Dimensions and weights                                                       */
/* -------------------------------------------------------------------------- */

export const CANDIDATE_DIMENSIONS = [
  "taskFit",
  "informationHierarchy",
  "relationshipClarity",
  "densityScanability",
  "interactionEfficiency",
  "productIdentity",
  "designSystemFit",
  "responsiveFeasibility",
  "accessibility",
  "implementationFeasibility",
] as const;

export type CandidateDimension = (typeof CANDIDATE_DIMENSIONS)[number];

/**
 * Weights per task category, versioned (blueprint §4.3: "weights should be
 * configurable per task category and versioned"). Kept frozen so a run cannot
 * quietly re-weight itself toward the answer it already prefers.
 */
export const CANDIDATE_WEIGHTS: Readonly<{ version: string; byTaskCategory: Record<string, Readonly<Record<CandidateDimension, number>>> }> = Object.freeze({
  version: "cand-v1",
  byTaskCategory: Object.freeze({
    topology: Object.freeze({ taskFit: 20, informationHierarchy: 10, relationshipClarity: 22, densityScanability: 6, interactionEfficiency: 8, productIdentity: 10, designSystemFit: 6, responsiveFeasibility: 4, accessibility: 6, implementationFeasibility: 8 }),
    monitor: Object.freeze({ taskFit: 18, informationHierarchy: 12, relationshipClarity: 8, densityScanability: 14, interactionEfficiency: 8, productIdentity: 10, designSystemFit: 8, responsiveFeasibility: 6, accessibility: 8, implementationFeasibility: 8 }),
    compare: Object.freeze({ taskFit: 18, informationHierarchy: 14, relationshipClarity: 10, densityScanability: 14, interactionEfficiency: 10, productIdentity: 8, designSystemFit: 8, responsiveFeasibility: 6, accessibility: 8, implementationFeasibility: 4 }),
    configure: Object.freeze({ taskFit: 20, informationHierarchy: 14, relationshipClarity: 6, densityScanability: 10, interactionEfficiency: 14, productIdentity: 8, designSystemFit: 8, responsiveFeasibility: 8, accessibility: 8, implementationFeasibility: 4 }),
    inspect: Object.freeze({ taskFit: 18, informationHierarchy: 14, relationshipClarity: 12, densityScanability: 10, interactionEfficiency: 8, productIdentity: 10, designSystemFit: 8, responsiveFeasibility: 6, accessibility: 8, implementationFeasibility: 6 }),
    explore: Object.freeze({ taskFit: 16, informationHierarchy: 12, relationshipClarity: 8, densityScanability: 16, interactionEfficiency: 10, productIdentity: 10, designSystemFit: 8, responsiveFeasibility: 6, accessibility: 8, implementationFeasibility: 6 }),
    /** Unfamiliar domains get the same weights as the core categories. */
    default: Object.freeze({ taskFit: 18, informationHierarchy: 12, relationshipClarity: 10, densityScanability: 10, interactionEfficiency: 10, productIdentity: 10, designSystemFit: 8, responsiveFeasibility: 8, accessibility: 8, implementationFeasibility: 6 }),
  }) as Record<string, Record<CandidateDimension, number>>,
});

export const MIN_CANDIDATES = 3;

/** A dimension at or below this score disqualifies a candidate outright. */
export const DISQUALIFYING_DIMENSION_SCORE = 3;

/* -------------------------------------------------------------------------- */
/* Hypotheses                                                                   */
/* -------------------------------------------------------------------------- */

export interface CompositionHypothesis {
  id: string;
  /** Composition family, from the §4.2 vocabulary or an invented one. */
  family: string;
  /** §4.1 axis 1: the regions and what each one carries. */
  informationArchitecture: string[];
  /** §4.1 axis 2: how space is divided. */
  spatialArrangement: string;
  /** §4.1 axis 3: canvas / table / graph / inspector / form / timeline. */
  interactionPattern: string;
  /** §4.1 axis 4: which region dominates. */
  emphasis: string;
  /** §4.1 axis 5. */
  navigationModel: string;
  /** §4.1 axis 6: how the main object is treated. */
  treatmentOfMainObject: string;
  /** Written argument for this direction. */
  rationale: string;
  /** Task-category specific raw dimension scores, 0–10. */
  scores?: Partial<Record<CandidateDimension, number>>;
}

const DISTINCT_AXES = [
  "informationArchitecture",
  "spatialArrangement",
  "interactionPattern",
  "emphasis",
  "navigationModel",
  "treatmentOfMainObject",
] as const;

export type DistinctAxis = (typeof DISTINCT_AXES)[number];

/** Stable signature of the hypothesis' structural shape. */
export function hypothesisSignature(h: CompositionHypothesis): string {
  return hashContent(DISTINCT_AXES.map((axis) => `${axis}=${String(h[axis]).toLowerCase().trim()}`).join("|"));
}

export interface DistinctnessAssessment {
  distinct: boolean;
  /** Axes that actually differ between the two hypotheses. */
  differingAxes: DistinctAxis[];
  /** Axes that are identical — the ones that make a pair cosmetic. */
  sharedAxes: DistinctAxis[];
  reason: string;
}

/**
 * §4.1: candidates must differ in at least one *structural* axis. Colour,
 * radius and card count are not axes at all, so a pair that differs only there
 * is reported as not distinct.
 */
export function assessDistinctness(a: CompositionHypothesis, b: CompositionHypothesis): DistinctnessAssessment {
  const differing = DISTINCT_AXES.filter((axis) => String(a[axis]).toLowerCase().trim() !== String(b[axis]).toLowerCase().trim());
  const shared = DISTINCT_AXES.filter((axis) => !differing.includes(axis));
  return {
    distinct: differing.length > 0,
    differingAxes: differing,
    sharedAxes: shared,
    reason:
      differing.length > 0
        ? `Distinct on ${differing.join(", ")}.`
        : `Identical on every structural axis (${shared.join(", ")}) — only cosmetic differences remain, which §4.1 does not count.`,
  };
}

export interface CandidateSetAudit {
  candidateCount: number;
  distinct: boolean;
  duplicateSignatures: string[][];
  /** Pairs that are not genuinely distinct. */
  cosmeticPairs: Array<{ a: string; b: string; reason: string }>;
  warnings: string[];
}

/** §4.1: at least three candidates, pairwise genuinely distinct. */
export function auditCandidateSet(candidates: readonly CompositionHypothesis[]): CandidateSetAudit {
  const warnings: string[] = [];
  if (candidates.length < MIN_CANDIDATES) {
    warnings.push(`Only ${candidates.length} composition candidate(s); §4.1 requires at least ${MIN_CANDIDATES}.`);
  }
  const bySignature = new Map<string, string[]>();
  for (const candidate of candidates) {
    const sig = hypothesisSignature(candidate);
    bySignature.set(sig, [...(bySignature.get(sig) ?? []), candidate.id]);
  }
  const duplicateSignatures = [...bySignature.values()].filter((ids) => ids.length > 1);
  const cosmeticPairs: CandidateSetAudit["cosmeticPairs"] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      const assessment = assessDistinctness(a, b);
      if (!assessment.distinct) cosmeticPairs.push({ a: a.id, b: b.id, reason: assessment.reason });
    }
  }
  if (duplicateSignatures.length > 0) {
    warnings.push(`Duplicate composition shapes: ${duplicateSignatures.map((ids) => ids.join("=")).join(", ")}.`);
  }
  if (cosmeticPairs.length > 0) {
    warnings.push(`${cosmeticPairs.length} candidate pair(s) differ only cosmetically.`);
  }
  return {
    candidateCount: candidates.length,
    distinct: duplicateSignatures.length === 0 && cosmeticPairs.length === 0,
    duplicateSignatures,
    cosmeticPairs,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                      */
/* -------------------------------------------------------------------------- */

export interface ScoredCandidate {
  candidate: CompositionHypothesis;
  /** Raw per-dimension scores, always retained — never collapsed away. */
  dimensions: Record<CandidateDimension, number>;
  /** Weighted 0–100 total, for ranking only. */
  total: number;
  weightsVersion: string;
  /** Dimensions at/below the disqualifying floor. */
  disqualifiedBy: CandidateDimension[];
}

export function weightsFor(taskCategory: string): Record<CandidateDimension, number> {
  const table = CANDIDATE_WEIGHTS.byTaskCategory;
  return { ...(table[taskCategory] ?? table["default"]!) };
}

/**
 * Scores one candidate. Dimensions the hypothesis did not assert default to a
 * neutral 5 — never to a flattering 8, because an unmeasured strength is not
 * a strength. A low dimension disqualifies regardless of the total.
 */
export function scoreCandidate(candidate: CompositionHypothesis, taskCategory = "default"): ScoredCandidate {
  const weights = weightsFor(taskCategory);
  const dimensions = {} as Record<CandidateDimension, number>;
  let total = 0;
  let weightSum = 0;
  for (const dimension of CANDIDATE_DIMENSIONS) {
    const raw = candidate.scores?.[dimension];
    const score = raw === undefined ? 5 : Math.max(0, Math.min(10, raw));
    dimensions[dimension] = score;
    const weight = weights[dimension];
    total += score * weight;
    weightSum += weight;
  }
  const disqualifiedBy = CANDIDATE_DIMENSIONS.filter((d) => dimensions[d] <= DISQUALIFYING_DIMENSION_SCORE);
  return {
    candidate,
    dimensions,
    total: weightSum === 0 ? 0 : Math.round((total / weightSum) * 100) / 100,
    weightsVersion: CANDIDATE_WEIGHTS.version,
    disqualifiedBy,
  };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                    */
/* -------------------------------------------------------------------------- */

export interface RejectedCandidate {
  id: string;
  family: string;
  reason: string;
  /** The dimension that decided it, when one dimension decided it. */
  decidedBy?: CandidateDimension;
  total: number;
}

export interface CompositionSelection {
  selected: ScoredCandidate | null;
  /** Every candidate with its raw dimensions, so the choice is auditable. */
  considered: ScoredCandidate[];
  tradeoffs: string[];
  rejected: RejectedCandidate[];
  audit: CandidateSetAudit;
  reason: string;
  weightsVersion: string;
  /** Set when the set failed §4.1 — the caller must generate more options. */
  insufficientAlternatives: boolean;
}

/**
 * Selects a direction, keeping every raw dimension and writing down why the
 * losers lost. An empty result is a legitimate outcome: §4.3 forbids using a
 * single score to hide a serious failure, so if the best candidate is
 * disqualified the selector returns `null` and says why.
 */
export function selectComposition(
  candidates: readonly CompositionHypothesis[],
  context: { taskCategory?: string; preferredFamily?: string } = {},
): CompositionSelection {
  const taskCategory = context.taskCategory ?? "default";
  const scored = candidates.map((c) => scoreCandidate(c, taskCategory));
  const audit = auditCandidateSet(candidates);
  const considered = [...scored].sort((a, b) => {
    if (a.disqualifiedBy.length !== b.disqualifiedBy.length) return a.disqualifiedBy.length - b.disqualifiedBy.length;
    return b.total - a.total;
  });

  const eligible = considered.filter((s) => s.disqualifiedBy.length === 0);
  const preferred =
    context.preferredFamily !== undefined ? eligible.find((s) => s.candidate.family === context.preferredFamily) : undefined;
  const selected = preferred ?? eligible[0] ?? null;

  const rejected: RejectedCandidate[] = [];
  for (const s of considered) {
    if (selected !== null && s.candidate.id === selected.candidate.id) continue;
    const decided = s.disqualifiedBy[0];
    rejected.push({
      id: s.candidate.id,
      family: s.candidate.family,
      total: s.total,
      reason: decided
        ? `Disqualified: ${decided} scored ${s.dimensions[decided]}/10, at or below the ${DISQUALIFYING_DIMENSION_SCORE}/10 floor. ${s.candidate.rationale}`
        : preferred !== undefined && s.candidate.family === context.preferredFamily
          ? `Not selected: the stated preference honoured ${preferred.candidate.id}, which outranks on task fit. ${s.candidate.rationale}`
          : `Outranked on the weighted total (${s.total} vs ${selected?.total ?? 0}). ${s.candidate.rationale}`,
      ...(decided !== undefined ? { decidedBy: decided } : {}),
    });
  }

  const tradeoffs: string[] = [];
  if (selected) {
    const runnerUp = considered.find((s) => s.candidate.id !== selected.candidate.id);
    if (runnerUp) {
      const weaker = CANDIDATE_DIMENSIONS.filter((d) => selected.dimensions[d] < runnerUp.dimensions[d]);
      const stronger = CANDIDATE_DIMENSIONS.filter((d) => selected.dimensions[d] > runnerUp.dimensions[d]);
      tradeoffs.push(
        `Chose "${selected.candidate.family}" over "${runnerUp.candidate.family}" (${selected.total} vs ${runnerUp.total}). Gains: ${stronger.join(", ") || "none"}. Gives up: ${weaker.join(", ") || "none"}.`,
      );
    }
  }

  const insufficientAlternatives = candidates.length < MIN_CANDIDATES;
  return {
    selected,
    considered,
    tradeoffs,
    rejected,
    audit,
    reason:
      selected === null
        ? "No candidate is eligible: every hypothesis is disqualified on at least one dimension. Generate new directions rather than shipping the least-bad one."
        : `Selected "${selected.candidate.family}" (${selected.total}/100, weights ${selected.weightsVersion}). ${selected.candidate.rationale}`,
    weightsVersion: CANDIDATE_WEIGHTS.version,
    insufficientAlternatives,
  };
}

/**
 * Guarantees §4.1's minimum by topping up from a supplied pool, keeping only
 * candidates that are genuinely distinct from what is already there. Returns
 * the original set untouched when it already satisfies the rule.
 */
export function ensureCandidateMinimum(
  existing: readonly CompositionHypothesis[],
  pool: readonly CompositionHypothesis[],
): { candidates: CompositionHypothesis[]; added: CompositionHypothesis[]; stillShort: boolean } {
  const candidates = [...existing];
  const added: CompositionHypothesis[] = [];
  for (const candidate of pool) {
    if (candidates.length >= MIN_CANDIDATES) break;
    if (candidates.some((c) => c.id === candidate.id)) continue;
    if (candidates.some((c) => !assessDistinctness(c, candidate).distinct)) continue;
    candidates.push(candidate);
    added.push(candidate);
  }
  return { candidates, added, stillShort: candidates.length < MIN_CANDIDATES };
}
