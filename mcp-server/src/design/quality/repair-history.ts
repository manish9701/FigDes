/**
 * Causal repair engine + history (blueprint §8).
 *
 * Two things were missing and both are integrity problems rather than
 * features:
 *
 * 1. **No repair record.** `RepairTraceSchema` was declared and never
 *    constructed. Repairs left no trace of what was diagnosed, why the change
 *    should work, or whether it was accepted, rejected or rolled back — so
 *    there was nothing to learn from and nothing to be accountable to.
 *
 * 2. **No anti-suppression guard.** A gate issue could be cleared by an
 *    adjudication matched on a substring of the issue text, with no check that
 *    the ruling was about the thing the repair actually touched. The blueprint
 *    forbids exactly this: *"do not suppress a finding or weaken a threshold
 *    solely to achieve PASS"*.
 *
 * `assessRepairIntegrity` closes that loop: a repair that closes a finding
 * whose dimension still fails, or that lowers a threshold, or that is a byte
 * -for-byte repeat of an already-failed attempt, is reported as suppressed
 * rather than quietly counted as progress.
 */
import type { DesignFinding } from "./finding";
import { GATE_THRESHOLDS, thresholdSnapshot, detectThresholdDrift, type GateThresholds } from "./dimensions";

/** Where the fix belongs. Shared defects are fixed at the source, not per node. */
export type RepairScope = "token" | "component" | "local" | "structural";

export type CauseClass =
  | "shared-semantic-style"
  | "repeated-component-instance"
  | "layout-misplaced"
  | "geometry-invalid"
  | "missing-content"
  | "wrong-composition"
  | "unlabelled-or-undifferentiated";

export interface RepairDiagnosis {
  cause: CauseClass;
  scope: RepairScope;
  /** Smallest set of node ids that must change for the fix to be causal. */
  minimalTargets: string[];
  /** Why this scope and not a broader one. */
  whyThisScope: string;
  /** Why the change should work, stated before it is tried. */
  whyItShouldWork: string;
  /** Checks that must be re-run, plus what would falsify the diagnosis. */
  falsifiesIf: string[];
  /** Side effects predicted up front, so a regression is not a surprise. */
  predictedSideEffects: string[];
}

/** Shared defects get fixed at the shared source; local defects stay local. */
export function chooseScope(input: {
  affectedNodeIds: readonly string[];
  /** True when the same rule has fired on more than one screen/region. */
  isSharedDefect?: boolean;
  /** True when several affected nodes are instances of one component. */
  isComponentInstance?: boolean;
  /** True when every affected node is driven by one semantic token. */
  isTokenDriven?: boolean;
  severity: DesignFinding["severity"];
}): RepairScope {
  if (input.severity === "critical" && input.isSharedDefect) return "structural";
  if (input.isTokenDriven) return "token";
  if (input.isComponentInstance) return "component";
  return "local";
}

/**
 * Infers a cause from the evidence rather than guessing. The mapping is
 * explicit so a wrong diagnosis is visible in the record instead of hidden in
 * an undocumented heuristic.
 */
export function diagnose(finding: DesignFinding, context: {
  isSharedDefect?: boolean;
  isComponentInstance?: boolean;
  isTokenDriven?: boolean;
} = {}): RepairDiagnosis {
  const scope = chooseScope({ ...context, affectedNodeIds: finding.affectedNodeIds, severity: finding.severity });
  const rule = finding.ruleId;
  const base = {
    minimalTargets: [...finding.affectedNodeIds],
    falsifiesIf: [] as string[],
    predictedSideEffects: [] as string[],
  };

  if (/token|palette|contrast|semantic/i.test(rule) && context.isTokenDriven) {
    return {
      ...base,
      cause: "shared-semantic-style",
      scope: "token",
      whyThisScope: "The defect is driven by one semantic token, so the token is the smallest correct place to change it. Patching individual fills would leave the next node to drift.",
      whyItShouldWork: "Rebinding every affected node to a corrected semantic token fixes the root style in one edit and cannot drift per node.",
      falsifiesIf: ["Contrast or token adherence is still measured on the re-render."],
      predictedSideEffects: ["Any other node bound to the same token changes too — that is intended, but verify the neighbours."],
    };
  }
  if (context.isComponentInstance && finding.affectedNodeIds.length > 0) {
    return {
      ...base,
      cause: "repeated-component-instance",
      scope: "component",
      whyThisScope: "The affected nodes are instances of one component, so the master variant is the correct single point of repair.",
      whyItShouldWork: "Fixing the master updates every instance at once and keeps them consistent, which per-instance patches cannot guarantee.",
      falsifiesIf: ["Instances still diverge after the master edit."],
      predictedSideEffects: ["All instances of the component change; unrelated components are untouched."],
    };
  }
  if (/overflow|clip|truncat|overlap|bound|geometry|collision/i.test(rule)) {
    return {
      ...base,
      cause: finding.category === "structural" ? "geometry-invalid" : "layout-misplaced",
      scope: "local",
      whyThisScope: "The finding is confined to specific measured nodes, so a local geometry change is the smallest reliable repair.",
      whyItShouldWork: "Correcting the offending bounds at their source removes the overlap or overflow rather than hiding it.",
      falsifiesIf: ["The same rule still fires on the re-render, which means the cause is upstream of these nodes."],
      predictedSideEffects: ["Sibling spacing around the repaired nodes may shift."],
    };
  }
  if (/content|missing|required|absent|state/i.test(rule)) {
    return {
      ...base,
      cause: "missing-content",
      scope: "local",
      whyThisScope: "Something required is absent; adding it is additive and cannot regress what is already correct.",
      whyItShouldWork: "Adding the required content or state removes the finding's premise directly.",
      falsifiesIf: ["The content appears but the finding persists, which means the finding was about placement or wording."],
      predictedSideEffects: ["Available space for peers shrinks; re-check the density dimension after adding."],
    };
  }
  if (/genericity|template|distinctiv|composition|card-wall|authentic/i.test(rule)) {
    return {
      ...base,
      cause: "wrong-composition",
      scope: "structural",
      whyThisScope: "The defect is the shape of the composition, not a property of any node. Only a structural change addresses it.",
      whyItShouldWork: "Re-composing around the task's own grammar removes the template resemblance that triggered the rule.",
      falsifiesIf: ["Genericity does not fall after a structural change, which means the shared shell is being read as the task region."],
      predictedSideEffects: ["Large area changes; hierarchy, density and relationship-clarity dimensions must be re-evaluated."],
    };
  }
  if (/colour|color|state|label|distinguish|differentiate/i.test(rule)) {
    return {
      ...base,
      cause: "unlabelled-or-undifferentiated",
      scope: "local",
      whyThisScope: "The problem is that two things look the same, or a state is carried by one cue; both are local changes.",
      whyItShouldWork: "Adding a redundant cue (text, icon or shape) preserves the semantic colour encoding while making the state perceivable without colour.",
      falsifiesIf: ["The state is still indistinguishable in greyscale."],
      predictedSideEffects: ["Additional width/space taken by the redundant cue."],
    };
  }
  return {
    ...base,
    cause: "layout-misplaced",
    scope,
    whyThisScope: "No more specific cause class matched, so the repair is scoped to the reported nodes and re-evaluated after re-rendering.",
    whyItShouldWork: "The rule named a measured defect on specific nodes; correcting those nodes and re-checking the same rule is the falsifiable path.",
    falsifiesIf: ["The same rule still fires, in which case the diagnosis was wrong and must be revisited rather than retried."],
    predictedSideEffects: ["Unknown — re-measure the affected regions after the change."],
  };
}

export type RepairOutcome = "accepted" | "rejected" | "rolled-back";

export interface RepairTrace {
  id: string;
  findingIds: string[];
  /** Revision the finding was measured on. */
  revisionBefore: string;
  /** Revision after the mutation. */
  revisionAfter?: string;
  diagnosis: RepairDiagnosis;
  mutations: Array<{ kind: "operation" | "component" | "token" | "manual"; description: string; targetIds: string[] }>;
  /** Rendered result after the mutation. */
  afterRender?: { revisionId: string; inspectedBy?: string; note?: string };
  result: "resolved" | "improved" | "unchanged" | "regressed";
  regressions: string[];
  outcome: RepairOutcome;
  decidedBy?: string;
  notes: string[];
  thresholdsAtDecision: GateThresholds;
}

export interface RepairRecordInput {
  id: string;
  finding: DesignFinding;
  revisionBefore: string;
  /** Revision after the mutation, when the mutation has been applied. */
  revisionAfter?: string;
  mutations: RepairTrace["mutations"];
  diagnosis?: RepairDiagnosis;
  afterRender?: RepairTrace["afterRender"];
  result: RepairTrace["result"];
  regressions?: string[];
  outcome?: RepairOutcome;
  decidedBy?: string;
  notes?: string[];
}

/** Builds a trace, snapshotting the thresholds that were in force at decision time. */
export function recordRepair(input: RepairRecordInput): RepairTrace {
  const trace: RepairTrace = {
    id: input.id,
    findingIds: [input.finding.id],
    revisionBefore: input.revisionBefore,
    diagnosis: input.diagnosis ?? diagnose(input.finding),
    mutations: input.mutations,
    result: input.result,
    regressions: input.regressions ?? [],
    outcome: input.outcome ?? (input.result === "regressed" ? "rolled-back" : input.result === "unchanged" ? "rejected" : "accepted"),
    thresholdsAtDecision: thresholdSnapshot(),
    notes: input.notes ?? [],
  };
  if (input.revisionAfter !== undefined) trace.revisionAfter = input.revisionAfter;
  if (input.afterRender !== undefined) trace.afterRender = input.afterRender;
  if (input.decidedBy !== undefined) trace.decidedBy = input.decidedBy;
  return trace;
}

/* -------------------------------------------------------------------------- */
/* Integrity: a repair may not buy a PASS                                       */
/* -------------------------------------------------------------------------- */

export type IntegrityViolation =
  | "finding-closed-without-verification"
  | "dimension-still-failing"
  | "threshold-weakened"
  | "repeated-failed-attempt"
  | "adjudication-without-rule-correction"
  | "evidence-not-revision-bound";

export interface RepairIntegrity {
  clean: boolean;
  violations: IntegrityViolation[];
  reasons: string[];
}

/**
 * The anti-suppression check.
 *
 * A repair is only allowed to move a dimension to PASS if (a) it was verified
 * on the post-repair revision, (b) the dimension genuinely improved, (c) the
 * thresholds did not move, and (d) the same mutation has not already failed.
 */
export function assessRepairIntegrity(input: {
  trace: RepairTrace;
  /** Dimension status before the repair. */
  dimensionBefore: string;
  /** Dimension status after the repair — what the gate would now report. */
  dimensionAfter: string;
  /** Prior traces for the same finding, oldest first. */
  history?: RepairTrace[];
  /** Ruling used to clear the blocking issue, if any. */
  adjudication?: { disposition: string; ruleCorrection?: string };
}): RepairIntegrity {
  const violations: IntegrityViolation[] = [];
  const reasons: string[] = [];

  const improved = input.dimensionAfter === "PASS" && input.dimensionBefore !== "PASS";
  if (improved) {
    if (!input.trace.afterRender) {
      violations.push("finding-closed-without-verification");
      reasons.push("The finding was closed without a post-repair render. An unverified repair may not move a dimension to PASS.");
    } else if (input.trace.afterRender.revisionId !== input.trace.revisionAfter && input.trace.revisionAfter !== undefined) {
      violations.push("finding-closed-without-verification");
      reasons.push(`The verification render depicts revision "${input.trace.afterRender.revisionId}" but the repair produced "${input.trace.revisionAfter}".`);
    }
  }

  if (input.dimensionAfter === "PASS" && input.dimensionBefore === "FAIL" && input.trace.result === "unchanged") {
    violations.push("dimension-still-failing");
    reasons.push("The dimension flipped to PASS while the repair itself changed nothing. That is a suppressed failure, not a fix.");
  }

  const drift = detectThresholdDrift(input.trace.thresholdsAtDecision);
  if (!drift.stable) {
    violations.push("threshold-weakened");
    reasons.push(`Thresholds changed during the run: ${drift.changes.join("; ")}. Weakening a bar to reach PASS is forbidden.`);
  }

  const failedAttempts = (input.history ?? []).filter(
    (h) => h.findingIds.some((id) => input.trace.findingIds.includes(id)) && (h.result === "unchanged" || h.result === "regressed"),
  );
  if (failedAttempts.length > 0) {
    const identical = failedAttempts.filter((h) => sameMutations(h, input.trace));
    if (identical.length > 0) {
      violations.push("repeated-failed-attempt");
      reasons.push(`The same mutation has already failed ${identical.length} time(s). Revise the diagnosis before retrying.`);
    }
  }

  if (input.adjudication && input.dimensionAfter === "PASS" && input.dimensionBefore !== "PASS") {
    const clears = input.adjudication.disposition === "false-positive" || input.adjudication.disposition === "intentional";
    if (clears && (!input.adjudication.ruleCorrection || input.adjudication.ruleCorrection.trim().length === 0)) {
      violations.push("adjudication-without-rule-correction");
      reasons.push("An adjudication cleared a blocking issue without a tested rule correction.");
    }
  }

  for (const id of input.trace.findingIds) {
    if (id.length === 0) {
      violations.push("evidence-not-revision-bound");
      reasons.push("A repair was recorded against an unidentified finding.");
      break;
    }
  }

  return { clean: violations.length === 0, violations, reasons };
}

function sameMutations(a: RepairTrace, b: RepairTrace): boolean {
  if (a.mutations.length !== b.mutations.length) return false;
  return a.mutations.every((m, i) => {
    const other = b.mutations[i];
    return !!other && m.kind === other.kind && m.description === other.description;
  });
}

/* -------------------------------------------------------------------------- */
/* History                                                                      */
/* -------------------------------------------------------------------------- */

export interface RepairHistorySummary {
  traces: number;
  accepted: number;
  rejected: number;
  rolledBack: number;
  resolved: number;
  unresolved: number;
  /** Findings that were tried and never fixed. Reuse these as a warning. */
  chronicallyUnfixed: string[];
  byScope: Record<RepairScope, number>;
  repairSuccessRate: number;
  /** Repairs that introduced new problems / repairs applied. */
  regressionRate: number;
}

export function summarizeRepairs(traces: readonly RepairTrace[]): RepairHistorySummary {
  const byScope: Record<RepairScope, number> = { token: 0, component: 0, local: 0, structural: 0 };
  const unfixedAttempts = new Map<string, number>();
  let accepted = 0;
  let rejected = 0;
  let rolledBack = 0;
  let resolved = 0;
  let regressed = 0;

  for (const trace of traces) {
    byScope[trace.diagnosis.scope]++;
    if (trace.outcome === "accepted") accepted++;
    else if (trace.outcome === "rejected") rejected++;
    else rolledBack++;
    if (trace.result === "resolved") resolved++;
    if (trace.result === "regressed") regressed++;
    if (trace.result !== "resolved") for (const id of trace.findingIds) unfixedAttempts.set(id, (unfixedAttempts.get(id) ?? 0) + 1);
  }

  return {
    traces: traces.length,
    accepted,
    rejected,
    rolledBack,
    resolved,
    unresolved: traces.length - resolved,
    chronicallyUnfixed: [...unfixedAttempts.entries()].filter(([, n]) => n >= 2).map(([id]) => id),
    byScope,
    repairSuccessRate: traces.length === 0 ? 0 : Math.round((resolved / traces.length) * 100) / 100,
    regressionRate: traces.length === 0 ? 0 : Math.round((regressed / traces.length) * 100) / 100,
  };
}

/**
 * Guard used before a repair loop retries: after two failed attempts on the
 * same finding, a new diagnosis is required — not the same mutation again.
 */
export function requiresNewDiagnosis(history: readonly RepairTrace[], findingId: string, maxAttempts = 2): boolean {
  const attempts = history.filter((t) => t.findingIds.includes(findingId));
  if (attempts.length < maxAttempts) return false;
  const last = attempts[attempts.length - 1];
  return last?.result !== "resolved";
}

/** Exposed so callers can assert the live thresholds are the ones in force. */
export const CURRENT_THRESHOLDS = GATE_THRESHOLDS;
