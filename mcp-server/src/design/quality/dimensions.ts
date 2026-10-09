/**
 * Multi-dimension evidence gate (blueprint §10).
 *
 * The previous gate answered a yes/no question from one blended verdict. The
 * blueprint is explicit that this is the failure mode to avoid: *"the gate
 * should report independent statuses, not a single misleading green badge"*,
 * and *"a checklist passing must not override a failed visual or product
 * critique"*.
 *
 * This module owns:
 * - the eight named dimensions, each with its own explicit state;
 * - the documented aggregation policy that turns eight states into one honest
 *   overall status (PASS / PASS WITH LIMITATIONS / MIXED / FAIL / PENDING);
 * - the accepted-risk record, which is the *only* way a confirmed finding
 *   stops blocking and which demands a reason, evidence, an owner and
 *   correction conditions;
 * - frozen, versioned thresholds plus a snapshot guard, so a run cannot quietly
 *   lower its own bar to reach PASS.
 */
import type { AcceptedRisk, DesignFinding } from "./finding";

export const GATE_DIMENSIONS = [
  "structure",
  "visual",
  "product",
  "accessibility",
  "consistency",
  "evidence_freshness",
  "live_validation",
  "benchmark_regression",
] as const;

export type GateDimension = (typeof GATE_DIMENSIONS)[number];

/**
 * Dimensions that must hold for an overall PASS. `live_validation` and
 * `benchmark_regression` are reported but do not veto, because they are not
 * knowable from a single design task — they are surfaced so their absence is
 * explicit rather than invisible.
 */
export const REQUIRED_DIMENSIONS: readonly GateDimension[] = [
  "structure",
  "visual",
  "product",
  "accessibility",
  "consistency",
  "evidence_freshness",
];

export type DimensionStatus = "PASS" | "FAIL" | "PENDING" | "NOT_APPLICABLE";

export type OverallStatus = "PASS" | "PASS_WITH_LIMITATIONS" | "MIXED" | "FAIL" | "PENDING";

export interface DimensionInput {
  dimension: GateDimension;
  status: DimensionStatus;
  /** Why this status. A FAIL or PENDING without a reason is not a report. */
  reasons?: string[];
  /** Finding ids backing this dimension. */
  findingIds?: string[];
}

export interface DimensionReport extends Required<DimensionInput> {
  required: boolean;
}

export interface GateReport {
  status: OverallStatus;
  dimensions: DimensionReport[];
  /** Accepted, non-blocking limitations still standing. */
  acceptedRisks: AcceptedRisk[];
  /** Why the overall status is what it is, in plain words. */
  reason: string;
  /** Anything that could not be verified at all. Never hidden. */
  notVerified: string[];
}

export interface GateInput {
  dimensions: DimensionInput[];
  acceptedRisks?: AcceptedRisk[];
  /**
   * Force a dimension to be treated as required regardless of the default
   * policy (e.g. a benchmark release requires `benchmark_regression`).
   */
  additionallyRequired?: GateDimension[];
}

/**
 * Aggregation policy — written down so the verdict is auditable, not felt:
 *
 *  1. Any REQUIRED dimension FAIL                → FAIL.
 *  2. No failures, but a REQUIRED dimension PENDING → PENDING (pending stays
 *     pending; it is never rounded to a pass).
 *  3. All required PASS, accepted risks remain     → PASS WITH LIMITATIONS.
 *  4. All required PASS, a NON-required dimension
 *     FAILs (live validation / benchmark regression)
 *                                                     → MIXED.
 *  5. All required PASS, nothing outstanding        → PASS.
 *
 * A NOT_APPLICABLE required dimension is a policy error and downgrades the
 * overall status to MIXED, so "I didn't check this" cannot read as "fine".
 */
export function evaluateGate(input: GateInput): GateReport {
  const extraRequired = new Set<GateDimension>(input.additionallyRequired ?? []);
  const seen = new Set<GateDimension>();
  const dimensions: DimensionReport[] = [];

  for (const d of input.dimensions) {
    if (seen.has(d.dimension)) continue;
    seen.add(d.dimension);
    dimensions.push({
      dimension: d.dimension,
      status: d.status,
      reasons: d.reasons ?? [],
      findingIds: d.findingIds ?? [],
      required: REQUIRED_DIMENSIONS.includes(d.dimension) || extraRequired.has(d.dimension),
    });
  }
  for (const missing of GATE_DIMENSIONS) {
    if (seen.has(missing)) continue;
    const required = REQUIRED_DIMENSIONS.includes(missing) || extraRequired.has(missing);
    dimensions.push({
      dimension: missing,
      status: required ? "PENDING" : "NOT_APPLICABLE",
      reasons: [required ? "Required dimension was never evaluated." : "Not evaluated for this run."],
      findingIds: [],
      required,
    });
  }

  const acceptedRisks = input.acceptedRisks ?? [];
  const notVerified = dimensions
    .filter((d) => d.status === "PENDING" || d.status === "NOT_APPLICABLE")
    .map((d) => `${d.dimension}: ${d.reasons[0] ?? "not evaluated"}`);

  const failedRequired = dimensions.filter((d) => d.required && d.status === "FAIL");
  if (failedRequired.length > 0) {
    return {
      status: "FAIL",
      dimensions,
      acceptedRisks,
      reason: `Required ${failedRequired.map((d) => d.dimension).join(", ")} failed. ${failedRequired[0]?.reasons[0] ?? ""}`.trim(),
      notVerified,
    };
  }

  const pendingRequired = dimensions.filter((d) => d.required && d.status === "PENDING");
  if (pendingRequired.length > 0) {
    return {
      status: "PENDING",
      dimensions,
      acceptedRisks,
      reason: `Required evidence is outstanding: ${pendingRequired.map((d) => d.dimension).join(", ")}. Pending stays pending.`,
      notVerified,
    };
  }

  const naRequired = dimensions.filter((d) => d.required && d.status === "NOT_APPLICABLE");
  if (naRequired.length > 0) {
    return {
      status: "MIXED",
      dimensions,
      acceptedRisks,
      reason: `Required dimension(s) ${naRequired.map((d) => d.dimension).join(", ")} were marked not applicable. Declare them non-required explicitly if that is intended.`,
      notVerified,
    };
  }

  const failedOptional = dimensions.filter((d) => !d.required && d.status === "FAIL");
  if (acceptedRisks.length > 0) {
    return {
      status: "PASS_WITH_LIMITATIONS",
      dimensions,
      acceptedRisks,
      reason: `All required dimensions pass with ${acceptedRisks.length} explicitly accepted, non-blocking limitation(s): ${acceptedRisks.map((r) => r.findingId).join(", ")}.`,
      notVerified,
    };
  }
  if (failedOptional.length > 0) {
    return {
      status: "MIXED",
      dimensions,
      acceptedRisks,
      reason: `All required dimensions pass, but ${failedOptional.map((d) => d.dimension).join(", ")} failed and is non-blocking for this release.`,
      notVerified,
    };
  }
  return {
    status: "PASS",
    dimensions,
    acceptedRisks,
    reason: "Every required dimension passed on revision-bound evidence, with no outstanding findings or accepted risks.",
    notVerified,
  };
}

/* -------------------------------------------------------------------------- */
/* Thresholds — versioned, frozen, and guarded                                  */
/* -------------------------------------------------------------------------- */

export interface GateThresholds {
  version: string;
  /** Max open critical findings per required dimension. */
  maxCriticalPerDimension: number;
  /** Min confidence for a finding to count as a confirmed defect. */
  minConfirmedConfidence: number;
  /** Min score (0–100) for a scored dimension to PASS. */
  minPassScore: number;
}

export const GATE_THRESHOLDS: GateThresholds = Object.freeze({
  version: "gate-v1",
  maxCriticalPerDimension: 0,
  minConfirmedConfidence: 0.6,
  minPassScore: 70,
});

/** Snapshot used to prove a run did not weaken its own bar mid-flight. */
export function thresholdSnapshot(): GateThresholds {
  return { ...GATE_THRESHOLDS };
}

export interface ThresholdDrift {
  stable: boolean;
  changes: string[];
}

export function detectThresholdDrift(before: GateThresholds): ThresholdDrift {
  const changes: string[] = [];
  for (const key of Object.keys(before) as Array<keyof GateThresholds>) {
    if (GATE_THRESHOLDS[key] !== before[key]) changes.push(`${key}: ${String(before[key])} → ${String(GATE_THRESHOLDS[key])}`);
  }
  return { stable: changes.length === 0, changes };
}

/* -------------------------------------------------------------------------- */
/* Building a dimension from findings                                           */
/* -------------------------------------------------------------------------- */

/**
 * Derives a dimension's status from its findings plus an optional score.
 *
 * Deliberately conservative, and deliberately *not* a weighted average: one
 * confirmed critical finding fails the dimension regardless of how good the
 * score looks, and a missing score is PENDING rather than an assumed pass.
 */
export function dimensionFromFindings(input: {
  dimension: GateDimension;
  findings: readonly DesignFinding[];
  score?: number | null;
  /** When true, an empty finding set without a score is NOT_APPLICABLE, not PENDING. */
  scoreOptional?: boolean;
}): DimensionInput {
  const open = input.findings.filter((f) => f.status === "open");
  const critical = open.filter((f) => f.severity === "critical");
  const confirmed = open.filter((f) => f.severity === "critical" || (f.severity === "high" && f.confidence >= GATE_THRESHOLDS.minConfirmedConfidence));
  const reasons: string[] = [];

  if (critical.length > 0) {
    return {
      dimension: input.dimension,
      status: "FAIL",
      reasons: [`${critical.length} open critical finding(s): ${critical.map((f) => `${f.ruleId}@${f.evidence[0]?.reference ?? f.id}`).join(", ")}`],
      findingIds: open.map((f) => f.id),
    };
  }
  if (typeof input.score === "number") {
    if (input.score < GATE_THRESHOLDS.minPassScore) {
      reasons.push(`score ${Math.round(input.score)} below ${GATE_THRESHOLDS.minPassScore}`);
    }
    if (reasons.length > 0) {
      return { dimension: input.dimension, status: "FAIL", reasons, findingIds: confirmed.map((f) => f.id) };
    }
    if (confirmed.length > 0) {
      return {
        dimension: input.dimension,
        status: "FAIL",
        reasons: [`${confirmed.length} confirmed finding(s) remain: ${confirmed.map((f) => f.ruleId).join(", ")}`],
        findingIds: confirmed.map((f) => f.id),
      };
    }
    return {
      dimension: input.dimension,
      status: "PASS",
      reasons: [`score ${Math.round(input.score)} ≥ ${GATE_THRESHOLDS.minPassScore}, no open critical or confirmed findings`],
      findingIds: [],
    };
  }
  if (input.scoreOptional && input.findings.length === 0) {
    return { dimension: input.dimension, status: "NOT_APPLICABLE", reasons: ["No findings raised and no score applies to this dimension."], findingIds: [] };
  }
  if (confirmed.length > 0) {
    return {
      dimension: input.dimension,
      status: "FAIL",
      reasons: [`${confirmed.length} confirmed finding(s) remain: ${confirmed.map((f) => f.ruleId).join(", ")}`],
      findingIds: confirmed.map((f) => f.id),
    };
  }
  return {
    dimension: input.dimension,
    status: "PENDING",
    reasons: [input.findings.length > 0 ? "Only low-severity or low-confidence findings remain; a human must judge." : "No evidence-backed score was produced for this dimension."],
    findingIds: open.map((f) => f.id),
  };
}
