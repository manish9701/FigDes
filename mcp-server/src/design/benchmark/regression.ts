/**
 * Benchmark regression gate (issue #22 §6, phase 4).
 *
 * A benchmark is only a gate when a *candidate* run can be compared against a
 * recorded, reproducible *baseline* — and when the comparison tracks the
 * dimensions independently instead of collapsing them into one number, and
 * refuses to report a PASS for what was never evaluated.
 *
 * This module connects three things that previously never met:
 *
 *  1. `design/benchmark/suite.ts` — the versioned cases, the 100-point
 *     offline weights and `compareBenchmarkRuns`, which nobody fed real runs;
 *  2. the design pipeline's plan-mode output — a plan with resolved geometry,
 *     a code-audited program, and (issue #22) visual intelligence: the skill
 *     selection, the compiled intent, the anti-generic review, the composition
 *     alternatives, and the type-criteria audit. This is the offline
 *     *evidence* the offline score is defined to be built from;
 *  3. a persisted, versioned baseline — brief, recorded configuration, the
 *     case's evidence and its scored result — so a later run can be gated
 *     against it and a prior case can be reproduced from its brief, context
 *     and configuration.
 *
 * Every dimension score carries the deterministic mapping that produced it
 * (`dimensionEvidence`), anything the offline evidence cannot evaluate is
 * named in `notEvaluated` (and scored 0, like suite.ts's contract, with the
 * reason recorded) — a structural pass must never be presented as proof of
 * visual quality.
 */
import { z } from "zod";
import { BENCHMARKS, scoreBenchmark, compareBenchmarkRuns, type BenchmarkResult, type BenchmarkComparisonReport } from "./suite";
import { classifyInfoItem } from "../composition/derive";

/* -------------------------------------------------------------------------- */
/* Offline case evidence — what the pipeline's plan mode can actually measure  */
/* -------------------------------------------------------------------------- */

export interface OfflineCaseEvidence {
  caseId: string;
  /** Which decision class the case was scored under. */
  decisionKind: string;
  /** The brief's task, as stated. */
  primaryDecision: string;
  requiredInformation: string[];
  optionalInformation: string[];
  /** Plan geometry — the offline score's only geometry source. */
  focalRegionId: string | null;
  focalShare: number;
  coverage: number;
  largestEmptyBand: number;
  /** Issues #22 visual intelligence, in the narrow form the gate consumes. */
  compiledIntentFields: string[];
  alternatives: { candidateCount: number; distinct: boolean; selectedFamily: string | null } | null;
  reviewFindings: number;
  typeCriteria: { run: boolean; findings: number } | null;
  /** The structural verdict over the resolved geometry. */
  structureStatus: "pass" | "fail" | "review" | "indeterminate";
  /** Counts from the structure stage, for readability. */
  overflowFindings: number;
  geometryFindings: number;
  /** Plan mode never applies native nodes; recorded, never implied. */
  nativeApplied: boolean;
}

interface DimensionOutcome {
  score: number | null;
  evidence: string;
}

/**
 * Slots the pipeline's plan-mode evidence into the offline scorecard's
 * dimensions. Each dimension is scored only when its evidence exists, and
 * returns the mapping that produced it; `null` means not evaluated offline.
 */
export function mapOfflineDimensions(evidence: OfflineCaseEvidence): {
  dimensions: Record<string, DimensionOutcome>;
  notEvaluated: string[];
} {
  const dimensions: Record<string, DimensionOutcome> = {};

  /* --- hierarchy ------------------------------------------------------------ */
  if (evidence.focalRegionId === null) {
    dimensions["hierarchy"] = { score: null, evidence: "no focal region resolved — the plan has no first thing to look at" };
  } else if (evidence.focalShare > 0.55) {
    dimensions["hierarchy"] = { score: 7, evidence: `focal '${evidence.focalRegionId}' at ${Math.round(evidence.focalShare * 100)}% dominates instead of leading` };
  } else if (evidence.focalShare < 0.08) {
    dimensions["hierarchy"] = { score: 5, evidence: `focal '${evidence.focalRegionId}' at ${Math.round(evidence.focalShare * 100)}% is too small to lead` };
  } else {
    dimensions["hierarchy"] = {
      score: 9,
      evidence: `focal '${evidence.focalRegionId}' leads at ${Math.round(evidence.focalShare * 100)}% of the canvas`,
    };
  }

  /* --- composition ------------------------------------------------------------ */
  let composition = evidence.coverage >= 0.55 ? 8 : 5;
  const compositionEvidence = [`coverage ${Math.round(evidence.coverage * 100)}%`];
  if (evidence.largestEmptyBand > 0.25) {
    composition -= 3;
    compositionEvidence.push(`largest empty band ${Math.round(evidence.largestEmptyBand * 100)}% (−3)`);
  }
  if (alternativesAudited(evidence)) {
    composition += 1;
    compositionEvidence.push("alternatives audited distinct and one selected (+1)");
  }
  dimensions["composition"] = { score: Math.max(0, Math.min(10, composition)), evidence: compositionEvidence.join("; ") };

  /* --- typography and spacing: the type-criteria audit ---------------------- */
  if (evidence.typeCriteria === null) {
    dimensions["typography"] = { score: null, evidence: "the type-criteria audit did not run on this plan" };
    dimensions["spacingRhythm"] = { score: null, evidence: "the type-criteria audit did not run on this plan" };
  } else if (evidence.typeCriteria.findings === 0) {
    dimensions["typography"] = { score: 9, evidence: "declared type criteria audited clean offline (labels ≥11px, uppercase budget)" };
    dimensions["spacingRhythm"] = { score: 9, evidence: "one spacing rhythm across sibling regions, audited offline" };
  } else {
    dimensions["typography"] = { score: 4, evidence: `${evidence.typeCriteria.findings} declared type criterion/criteria failed at compile time` };
    dimensions["spacingRhythm"] = { score: 4, evidence: `${evidence.typeCriteria.findings} declared criterion/criteria failed at compile time` };
  }

  /* --- relationship clarity --------------------------------------------------- */
  const relationshipItems = [
    ...evidence.requiredInformation,
    ...evidence.optionalInformation,
  ].filter((i) => classifyInfoItem(i) === "relationship").length;
  if (relationshipItems === 0) {
    dimensions["relationshipClarity"] = { score: null, evidence: "no relationships named in the brief" };
  } else if (evidence.focalRegionId === null) {
    dimensions["relationshipClarity"] = { score: null, evidence: "relationships exist but no focal region concentrates them" };
  } else {
    dimensions["relationshipClarity"] = {
      score: 9,
      evidence: `${relationshipItems} relationship item(s) named; the plan resolves a focal region for them (draw offline proof: screenshot pass)`,
    };
  }

  /* --- product specificity: genuinely unmeasurable offline ------------------- */
  dimensions["productSpecificity"] = {
    score: null,
    evidence: "needs product-specific judgement (live/human pass) — offline evidence does not measure this; it is scored, at 0, to keep the calibration honest",
  };

  /* --- density ----------------------------------------------------------------- */
  if (evidence.compiledIntentFields.some((f) => f === "density" || f === "style")) {
    dimensions["density"] = {
      score: 8,
      evidence: `compiled intent carries [${evidence.compiledIntentFields.join(", ")}]; density decisions are consumed downstream (program/report)`,
    };
  } else {
    dimensions["density"] = { score: null, evidence: "the compiled intent carries no density manner" };
  }

  /* --- native quality: plan mode applies nothing -------------------------------- */
  if (evidence.structureStatus === "pass") {
    dimensions["nativeQuality"] = {
      score: 8,
      evidence: evidence.nativeApplied
        ? "structure passed on live evidence"
        : "structure passed on resolved-geometry evidence only (plan mode — nothing was applied to Figma)",
    };
  } else if (evidence.structureStatus === "review") {
    dimensions["nativeQuality"] = { score: 5, evidence: "structure is in review" };
  } else {
    dimensions["nativeQuality"] = { score: 2, evidence: `structure verdict: ${evidence.structureStatus}` };
  }

  /* --- distinctiveness: the alternatives + anti-generic review ------------------ */
  if ( evidence.alternatives === null) {
    dimensions["distinctiveness"] = { score: null, evidence: "no alternatives recorded for this run" };
  } else if (evidence.alternatives.distinct && evidence.alternatives.selectedFamily !== null) {
    const penalised = Math.max(1, 9 - (evidence.reviewFindings > 0 ? 2 : 0));
    dimensions["distinctiveness"] = {
      score: penalised,
      evidence: `${evidence.alternatives.candidateCount} pairwise-distinct candidates, selected family '${evidence.alternatives.selectedFamily}'${evidence.reviewFindings > 0 ? "; anti-generic review raised findings (−2)" : ""}`,
    };
  } else {
    dimensions["distinctiveness"] = { score: 4, evidence: "alternatives present but not genuinely distinct, or nothing selected" };
  }

  /* --- readability: the structure findings ------------------------------------- */
  if (evidence.overflowFindings === 0 && evidence.geometryFindings === 0 && evidence.structureStatus === "pass") {
    dimensions["readability"] = { score: 9, evidence: "no overflow or geometry findings in the resolved layout" };
  } else {
    const readable = Math.max(0, 9 - evidence.overflowFindings * 2 - evidence.geometryFindings);
    dimensions["readability"] = {
      score: readable,
      evidence: `${evidence.overflowFindings} overflow finding(s), ${evidence.geometryFindings} geometry finding(s) in the resolved layout`,
    };
  }

  const notEvaluated = Object.entries(dimensions)
    .filter(([, outcome]) => outcome.score === null)
    .map(([dim]) => dim);
  return { dimensions, notEvaluated };
}

/** The gate only credits composition when real alternatives were audited. */
function alternativesAudited(evidence: OfflineCaseEvidence): boolean {
  return evidence.alternatives !== null && evidence.alternatives.distinct && evidence.alternatives.selectedFamily !== null;
}

export interface ScoredOfflineCase {
  /** The suite-shaped result the case scored — the gate consumes this. */
  result: BenchmarkResult;
  /** Every dimension the offline evidence could not evaluate. */
  notEvaluated: string[];
  /** The mapping per dimension: why this number, in one sentence. */
  dimensionEvidence: Record<string, string>;
}

/**
 * Scores one case from plan-mode evidence via the suite's `scoreBenchmark`.
 * Dimensions without offline evidence score 0 *with the reason recorded* —
 * the suite's contract — so the total is never padded by unevaluated quality.
 */
export function scoreOfflineEvidence(evidence: OfflineCaseEvidence): ScoredOfflineCase {
  const { dimensions, notEvaluated } = mapOfflineDimensions(evidence);
  const numeric: Record<string, number> = {};
  const dimensionEvidence: Record<string, string> = {};
  for (const [dim, outcome] of Object.entries(dimensions)) {
    numeric[dim] = outcome.score ?? 0;
    dimensionEvidence[dim] = outcome.evidence;
  }
  const notes = [
    ...(evidence.nativeApplied ? [] : ["offline score: plan-mode run — no native nodes were applied to Figma"]),
    ...(notEvaluated.length > 0 ? [`not evaluated offline, scored 0: ${notEvaluated.join(", ")}`] : []),
  ];
  const result = scoreBenchmark({
    caseId: evidence.caseId,
    dimensions: numeric,
    genericity: evidence.reviewFindings,
    repairs: 0,
    renders: 0,
    discoveryCalls: 0,
  });
  // scoreBenchmark builds notes: [] by contract; the not-evaluated register is
  // attached after so the reason travels with the result.
  for (const note of notes) result.notes.push(note);
  return { result, notEvaluated, dimensionEvidence };
}

/* -------------------------------------------------------------------------- */
/* The baseline: versioned, reproducible from brief + config + evidence         */
/* -------------------------------------------------------------------------- */

export const BASELINE_SCHEMA = "figdes-benchmark-baseline-v1";

const NumberRange = z.number().min(0).max(1);

const EvidenceSchema = z
  .object({
    caseId: z.string().min(1),
    decisionKind: z.string().min(1),
    primaryDecision: z.string().min(1),
    requiredInformation: z.array(z.string()),
    optionalInformation: z.array(z.string()),
    focalRegionId: z.string().nullable(),
    focalShare: NumberRange,
    coverage: NumberRange,
    largestEmptyBand: NumberRange,
    compiledIntentFields: z.array(z.string()),
    alternatives: z
      .object({
        candidateCount: z.number().int().min(0),
        distinct: z.boolean(),
        selectedFamily: z.string().nullable(),
      })
      .nullable(),
    reviewFindings: z.number().int().min(0),
    typeCriteria: z
      .object({
        run: z.boolean(),
        findings: z.number().int().min(0),
      })
      .nullable(),
    structureStatus: z.enum(["pass", "fail", "review", "indeterminate"]),
    overflowFindings: z.number().int().min(0),
    geometryFindings: z.number().int().min(0),
    nativeApplied: z.boolean(),
  })
  .strict();

const ResultSchema = z.object({
  caseId: z.string(),
  total: z.number(),
  dimensions: z.record(z.string(), z.number()),
  genericity: z.number(),
  repairs: z.number(),
  renders: z.number(),
  discoveryCalls: z.number(),
  notes: z.array(z.string()),
});

export const BaselineCaseSchema = z
  .object({
    caseId: z.string().min(1),
    /** The brief — enough to reproduce the case end to end. */
    brief: z.object({
      screen: z.string().min(1),
      product: z.string().nullable(),
      purpose: z.string().min(1),
      primaryDecision: z.string().min(1),
      primaryAction: z.string().nullable(),
      requiredInformation: z.array(z.string()),
      optionalInformation: z.array(z.string()),
      desiredComposition: z.string().nullable(),
      viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
    }),
    /** The recorded pipeline configuration of the run being frozen. */
    config: z.object({
      mode: z.enum(["plan", "build"]),
      render: z.boolean(),
      repairBudget: z.number().int().min(0).max(5),
      maxRounds: z.number().int().min(1).max(3),
    }),
    evidence: EvidenceSchema,
    result: ResultSchema,
  })
  .strict();

export const BaselineDocumentSchema = z
  .object({
    schema: z.literal(BASELINE_SCHEMA),
    suite: z.string().min(1),
    recordedAt: z.string().min(1),
    cases: z.array(BaselineCaseSchema),
  })
  .strict();

export type BaselineCase = z.infer<typeof BaselineCaseSchema>;
export type BaselineDocument = z.infer<typeof BaselineDocumentSchema>;

/** Serializes a baseline document; the schema enforces the version field. */
export function serializeBaseline(document: BaselineDocument): string {
  if (document.schema !== BASELINE_SCHEMA) throw new Error(`refused: baseline schema must be "${BASELINE_SCHEMA}", got "${document.schema}"`);
  return JSON.stringify(document, null, 2);
}

/**
 * Parses and validates a baseline. A baseline that fails its own schema is
 * refused — a gate that accepts an unverifiable baseline is a gate that can
 * be defeated by an unverifiable baseline.
 */
export function parseBaseline(json: string): BaselineDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("refused: baseline document is not valid JSON");
  }
  const parsed = BaselineDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`refused: not a ${BASELINE_SCHEMA} document — ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                     */
/* -------------------------------------------------------------------------- */

export type RegressionVerdict = "PASS" | "REGRESSION" | "NOT_EVALUATED";

export interface RegressionGate {
  verdict: RegressionVerdict;
  reasons: string[];
  /** Case ids in the baseline that the candidate run did not reproduce. */
  missing: string[];
  comparison: BenchmarkComparisonReport;
}

/**
 * Gates a candidate run against a baseline. The verdict is deliberately
 * three-valued:
 *
 *  - REGRESSION — a shared case dropped by at least the recorded threshold;
 *  - NOT_EVALUATED — the candidate never reproduced a baseline case (or the
 *    two runs share nothing), so no claim is possible either way;
 *  - PASS — every baseline case was reproduced and none regressed.
 *
 * "Broad improvement" is reported by the comparison but never replaces the
 * gate's PASS: fewer than all cases is still NOT_EVALUATED for the missing
 * ones, whatever the average says.
 */
export function runRegressionGate(input: {
  candidate: BenchmarkResult[];
  baseline: BaselineDocument;
  /** A relative drop of at least this much is a regression. Suite default: 5. */
  threshold?: number;
}): RegressionGate {
  const threshold = input.threshold ?? 5;
  const candidateIds = new Set(input.candidate.map((r) => r.caseId));
  const missing = input.baseline.cases.filter((c) => !candidateIds.has(c.caseId)).map((c) => c.caseId);
  const comparison = compareBenchmarkRuns(
    input.baseline.cases.map((c) => c.result),
    input.candidate,
    threshold,
  );

  if (missing.length > 0 || comparison.comparisons.length === 0) {
    return {
      verdict: "NOT_EVALUATED",
      reasons: [
        missing.length > 0 ? `${missing.length} baseline case(s) not reproduced by the candidate run: ${missing.join(", ")}` : "the candidate run shares no cases with the baseline",
      ].filter(Boolean),
      missing,
      comparison,
    };
  }
  if (comparison.regressions.length > 0) {
    return {
      verdict: "REGRESSION",
      reasons: [
        `${comparison.regressions.length} case(s) regressed by ≥ ${threshold} points: ${comparison.regressions.join(", ")}.`,
        "Gate refusal: fix or record the regression before claiming the baseline still holds.",
      ],
      missing,
      comparison,
    };
  }
  const reasons = comparison.improvements > 0
    ? [comparison.summary, `${comparison.improvements} case(s) improved; no regression past the ${threshold} point threshold.`]
    : [comparison.summary];
  return { verdict: "PASS", reasons, missing, comparison };
}

/** The suite the baseline claims to freeze — used for the report header. */
export function baselineCaseIds(): string[] {
  return [...BENCHMARKS.map((b) => b.id)];
}
