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
  /**
   * Adjudicated issues (quality-reliability P1): moved out of blocking with
   * rationale retained, never erased. Only false-positive/intentional rulings
   * WITH a tested rule correction stop blocking; anything else stays.
   */
  adjudicated: string[];
}

export interface GateAdjudication {
  /** Case-insensitive substring matched against blocking-issue text. */
  key: string;
  disposition: "false-positive" | "intentional" | "confirmed" | "unresolved";
  rationale: string;
  reviewer: string;
  /** Tested rule correction for this class. Required to stop blocking. */
  ruleCorrection?: string;
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
 *
 * Honesty rules (handoff §8):
 * - missing evidence-backed scores (including genericity) never PASS — FAIL.
 * - a stale/mismatched screenshot revision never PASS — FAIL.
 * - critical blockers override aggregate scores.
 * - budget exhaustion never converts REVIEW to PASS — FAIL.
 */
export function evaluateFinalGate(input: {
  scores: Partial<FinalScores>;
  genericity?: GenericityReport | null;
  blockingIssues?: string[];
  repairHistory?: string[];
  renders?: number;
  renderNotes?: string[];
  /** True only when a fresh rendered screenshot was inspected after the final repair. */
  visualEvidenceVerified?: boolean;
  /**
   * Revision binding (handoff §8): the IR revision the gate is judging vs the
   * revision the screenshot evidence actually depicts. A mismatch or a missing
   * evidence revision is a stale screenshot and FAILs — a caller-attested
   * boolean alone is not enough to PASS.
   */
  expectedRevision?: string;
  evidenceRevision?: string | null;
  /**
   * Interaction-state evidence (general-use quality lift), opt-in by shape.
   *
   * A screen with zero declared states (one hover, one selected, one
   * non-default tone) reads as unfinished even when every structural check
   * passes. When the caller measures state signals and reports
   * `states.declared === 0`, the gate refuses PASS — it downgrades to REVIEW
   * with the reason named, never FAIL, because a stateless screen can still
   * be genuinely complete (a static slide, a placeholder).
   */
  states?: { declared: number };
  /**
   * Accessibility coverage (issue #20, workstream 7), opt-in by shape.
   *
   * The blueprint's accessibility evaluator produces findings and a list of
   * what was NOT checked — and the gate that actually runs (this one) had no
   * accessibility dimension at all, so contrast and target-size failures
   * never blocked. Now: one or more accessibility findings blocks PASS, and
   * outstanding (notChecked) accessibility checks also refuse a clean PASS —
   * evaluating nothing is not the same as passing everything.
   */
  accessibility?: { findings: number; notChecked: string[] };
  /**
   * Adjudicated issues stop blocking only as false-positive/intentional WITH
   * a tested rule correction and retained rationale. Confirmed, unresolved,
   * or correction-less rulings keep blocking. The moved issues land in
   * `report.adjudicated`, never vanish.
   */
  adjudications?: GateAdjudication[];
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
  const requiredScoreKeys: Array<keyof FinalScores> = ["hierarchy", "composition", "typography", "readability", "density", "distinctiveness", "genericity", "productFit"];
  const missingScores = requiredScoreKeys.filter((key) => {
    if (key === "genericity") return input.genericity == null && typeof input.scores.genericity !== "number";
    return typeof input.scores[key] !== "number";
  });
  if (missingScores.length > 0) blocking.push(`Missing evidence-backed scores: ${missingScores.join(", ")}.`);
  // Revision binding: PASS requires evidence depicting the judged revision.
  if (input.expectedRevision !== undefined) {
    if (input.evidenceRevision == null || input.evidenceRevision === "") {
      blocking.push(`Stale screenshot: no evidence revision for expected revision "${input.expectedRevision}".`);
    } else if (input.evidenceRevision !== input.expectedRevision) {
      blocking.push(`Stale screenshot: evidence revision "${input.evidenceRevision}" does not match expected revision "${input.expectedRevision}".`);
    }
  }
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
  const adjudicated: string[] = [];
  const remaining = blocking.filter((issue) => {
    const ruling = (input.adjudications ?? []).find(
      (a) =>
        (a.disposition === "false-positive" || a.disposition === "intentional") &&
        a.ruleCorrection !== undefined &&
        a.ruleCorrection.length > 0 &&
        issue.toLowerCase().includes(a.key.toLowerCase()),
    );
    if (ruling) {
      adjudicated.push(`${issue} — adjudicated ${ruling.disposition} by ${ruling.reviewer}: ${ruling.rationale} [correction: ${ruling.ruleCorrection}]`);
      return false;
    }
    return true;
  });
  const a11yFailures = input.accessibility?.findings ?? 0;
  const a11yBlocking = a11yFailures > 0 ? [`Accessibility: ${a11yFailures} finding(s) below WCAG thresholds.`] : [];
  if (remaining.length > 0 || a11yBlocking.length > 0) {
    return {
      status: "FAIL",
      scores,
      blockingIssues: [...remaining, ...a11yBlocking],
      repairHistory: input.repairHistory ?? [],
      renderEvidence: (input.renderNotes ?? []).map((note, i) => ({ render: i + 1, note })),
      reason: a11yBlocking.length > 0
        ? "Blocking issues remain, including accessibility findings below WCAG thresholds. Repair and re-render within budget."
        : "Blocking visual-quality issues remain. Repair and re-render within budget.",
      adjudicated,
    };
  }
  const a11yNotChecked = input.accessibility?.notChecked ?? [];
  const needsReview =
    input.visualEvidenceVerified !== true ||
    scores.hierarchy < FINAL_THRESHOLDS.hierarchyReviewBelow ||
    scores.productFit < FINAL_THRESHOLDS.productFitReviewBelow;
  const stateless = input.states !== undefined && input.states.declared === 0;
  if (needsReview || stateless || a11yNotChecked.length > 0) {
    return {
      status: "REVIEW",
      scores,
      blockingIssues: [],
      repairHistory: input.repairHistory ?? [],
      renderEvidence: (input.renderNotes ?? []).map((note, i) => ({ render: i + 1, note })),
      reason: a11yNotChecked.length > 0
        ? `Accessibility could not be fully verified (not checked: ${a11yNotChecked.join("; ")}), so a clean PASS is not available — verify those manually.`
        : input.visualEvidenceVerified !== true
          ? "Structural checks are incomplete as final evidence: inspect a fresh rendered screenshot before marking PASS."
          : stateless
            ? "No interaction states declared: add at least one hover, selected or non-default state so the screen reads as finished."
            : "No blocking issues, but hierarchy or product fit needs a human look before done.",
      adjudicated,
    };
  }
  return {
    status: "PASS",
    scores,
    blockingIssues: [],
    repairHistory: input.repairHistory ?? [],
    renderEvidence: (input.renderNotes ?? []).map((note, i) => ({ render: i + 1, note })),
    reason: "No blocking issues; hierarchy and product fit hold.",
    adjudicated,
  };
}
