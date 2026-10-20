/**
 * The verdict of a *review*: what the rules found, and whether they could
 * judge anything at all.
 *
 * "No findings" is not the same as "nothing was wrong". A scan that read no
 * nodes, or a scope too narrow to judge, produces no findings either — and
 * reading that as a clean bill of health is how a screen nobody looked at
 * gets approved.
 */
export type ReviewVerdict = "PASS" | "FAIL" | "REVIEW" | "INDETERMINATE";

export interface ReviewVerdictInput {
  /** How many nodes the scan read. */
  nodesExamined: number;
  /** How many rules could have produced a finding. */
  rulesEvaluated: number;
  /** Whether the scan was cut short. */
  truncated: boolean;
  /** The findings that were produced. */
  findings: Array<{ severity: string }>;
}

export interface ReviewVerdictResult {
  verdict: ReviewVerdict;
  reason: string;
}

export function reviewVerdict(input: ReviewVerdictInput): ReviewVerdictResult {
  const serious = input.findings.filter((f) => f.severity === "critical" || f.severity === "serious");
  if (input.nodesExamined === 0) {
    return {
      verdict: "INDETERMINATE",
      reason: `The scan examined no node(s) and ${input.rulesEvaluated} rule(s) could judge nothing, so this is not a pass.`,
    };
  }
  if (input.truncated) {
    return {
      verdict: "INDETERMINATE",
      reason: `The scan was truncated after ${input.nodesExamined} node(s), so the screen was not fully examined.`,
    };
  }
  if (serious.length > 0) {
    return { verdict: "FAIL", reason: `${serious.length} finding(s) need attention.` };
  }
  if (input.findings.length > 0) {
    return { verdict: "REVIEW", reason: `${input.findings.length} finding(s) are worth a human's eye.` };
  }
  return {
    verdict: "PASS",
    reason: `${input.rulesEvaluated} rule(s) ran over ${input.nodesExamined} node(s) and found nothing.`,
  };
}

/**
 * The verdict of a repair loop.
 *
 * ## Why a loop needs a verdict of its own
 *
 * "The tool call succeeded" is not "the screen is right". A `setFill` on the
 * wrong node, a repair that fixes one thing and breaks another, a re-check that
 * silently did not run — all of them look like progress from the outside.
 *
 * So every loop that changes the file ends with the same question, asked the
 * same way: **did the screen get better, and can we prove it?**
 *
 * - **PASS** — the re-check ran, no high-confidence finding that was repaired
 *   is still reported, and nothing new was reported.
 * - **FAIL** — a repaired finding is still there, or the repair introduced a
 *   new one.
 * - **INDETERMINATE** — the re-check could not run. A loop that could not
 *   look at the result has not verified anything, and saying "PASS" would be
 *   the exact false pass this exists to prevent.
 *
 * The evidence travels with the verdict: the before and after measurements for
 * every finding, and the list of what the loop touched.
 */
import type { MetricsReport } from "../../../shared/protocol";
import { runRules } from "./rules";

/** The shape the verdict works with, so both loops can feed it. */
export interface VerifiableFinding {
  /** A stable identity for the finding, so before and after can be paired. */
  key: string;
  rule: string;
  severity: string;
  confidence: string;
  title: string;
  nodeIds: string[];
  /** The measurement the finding carried. */
  evidence: Record<string, unknown>;
}

export type LoopVerdict = "PASS" | "FAIL" | "INDETERMINATE";

export interface RepairVerification {
  verdict: LoopVerdict;
  /** One line explaining the verdict. */
  reason: string;
  /** The findings that were repaired and are no longer reported. */
  fixed: string[];
  /** The findings that were repaired and are still reported. */
  unresolved: Array<{ key: string; rule: string; targets: string[]; reason: string }>;
  /** The findings that are new since the repair. */
  regressions: Array<{ key: string; rule: string; targets: string[]; title: string }>;
  /** The findings the loop chose not to touch, and why. */
  notAutoFixable: number;
  blocked: number;
  /** The before and after measurements, per finding. */
  evidence: Array<{ key: string; rule: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; resolved: boolean }>;
  /** How many findings the re-check measured. */
  measured: number;
}

/** A finding's identity: the rule, the nodes and the title. */
export function findingKey(finding: { rule: string; nodeIds: string[]; title: string }): string {
  return `${finding.rule}::${[...finding.nodeIds].sort().join(",")}::${finding.title}`;
}

/** Turns the review rules' findings into the shape the verdict works with. */
export function toVerifiable(findings: ReturnType<typeof runRules>): VerifiableFinding[] {
  return findings.map((f) => ({
    key: findingKey(f),
    rule: f.rule,
    severity: f.severity,
    confidence: f.confidence,
    title: f.title,
    nodeIds: [...f.nodeIds],
    evidence: { ...(f.evidence as Record<string, unknown>) },
  }));
}

/** Measures a file and returns the findings the verdict works with. */
export function measure(report: MetricsReport): VerifiableFinding[] {
  return toVerifiable(runRules(report, "review"));
}

export interface VerifyRepairsInput {
  /** The findings before the repair. */
  before: VerifiableFinding[];
  /** The findings after the repair. */
  after: VerifiableFinding[];
  /** The findings the loop applied a fix for. */
  applied: Array<{ key: string; rule: string; targets: string[] }>;
  /** Whether the re-check could run at all. */
  recheck: "ran" | "failed" | "not-run";
  recheckReason?: string;
  /** The findings the loop refused to touch. */
  notAutoFixable?: number;
  blocked?: number;
}

/**
 * Verifies a repair pass.
 *
 * The pairing is by finding identity, so a finding that moved but survived is
 * still the same finding — and a finding that is *new* is a regression, not a
 * repair.
 */
export function verifyRepairs(input: VerifyRepairsInput): RepairVerification {
  const afterByKey = new Map(input.after.map((f) => [f.key, f]));
  const beforeKeys = new Set(input.before.map((f) => f.key));

  const fixed: string[] = [];
  const unresolved: RepairVerification["unresolved"] = [];
  const evidence: RepairVerification["evidence"] = [];

  for (const applied of input.applied) {
    const before = input.before.find((f) => f.key === applied.key) ?? null;
    const after = afterByKey.get(applied.key) ?? null;
    const resolved = after === null;
    if (resolved) fixed.push(applied.key);
    else {
      unresolved.push({
        key: applied.key,
        rule: applied.rule,
        targets: applied.targets,
        reason: "the repair was applied and the finding is still reported on re-measurement",
      });
    }
    evidence.push({
      key: applied.key,
      rule: applied.rule,
      before: before?.evidence ?? null,
      after: after?.evidence ?? null,
      resolved,
    });
  }

  // A finding that is new since the repair is a regression: the screen got
  // worse, and a loop that reports that as progress is lying.
  const regressions = input.after
    .filter((f) => !beforeKeys.has(f.key))
    .filter((f) => f.confidence === "high" || f.severity === "serious" || f.severity === "critical")
    .map((f) => ({ key: f.key, rule: f.rule, targets: f.nodeIds, title: f.title }));

  const highConfidenceUnresolved = input.after.filter((f) => f.confidence === "high" && unresolved.some((u) => u.key === f.key)).length;

  let verdict: LoopVerdict;
  let reason: string;
  if (input.recheck !== "ran") {
    verdict = "INDETERMINATE";
    reason = `the re-check did not run (${input.recheckReason ?? "no reason recorded"}), so nothing about the screen has been verified.`;
  } else if (regressions.length > 0) {
    verdict = "FAIL";
    reason = `the repair introduced ${regressions.length} new finding(s): ${regressions.map((r) => r.rule).join(", ")}.`;
  } else if (unresolved.length > 0 || highConfidenceUnresolved > 0) {
    verdict = "FAIL";
    reason = `${unresolved.length} repaired finding(s) are still reported after the repair.`;
  } else {
    verdict = "PASS";
    reason = `${fixed.length} finding(s) were repaired and re-measured as gone, with no new finding reported.`;
  }

  return {
    verdict,
    reason,
    fixed,
    unresolved,
    regressions,
    notAutoFixable: input.notAutoFixable ?? 0,
    blocked: input.blocked ?? 0,
    evidence,
    measured: input.after.length,
  };
}
