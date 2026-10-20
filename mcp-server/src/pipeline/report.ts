/**
 * Stage 8 — the completion report (issue #16, §Stage 8).
 *
 * ## The sentence this module exists to prevent
 *
 * "Done." — said after a build that was never rendered, a render that was
 * never reviewed, a review that found three high-severity defects, and a
 * repair loop that ran out of budget.
 *
 * So the report has six buckets, and each one can only say what it actually
 * knows:
 *
 *   - **generated and applied** — what was created, and whether it landed;
 *   - **structurally verified** — the checks that ran, and their verdicts;
 *   - **rendered and visually reviewed** — whether a render of *this* revision
 *     was looked at;
 *   - **automatically repaired** — what was changed, and what it fixed;
 *   - **remaining findings** — what is still wrong;
 *   - **blocked or unverified** — what could not be checked, and why.
 *
 * A bucket that was never filled says so. It never borrows a verdict from
 * another bucket.
 */
import type { PipelineCheck, PipelineFinding, PipelineReport, PipelineTrace } from "./contracts";

export interface ReportInput {
  /** Whether the plan was produced. */
  planned: boolean;
  /** Whether the build was applied to Figma. */
  applied: boolean;
  operations: number;
  nodeIds: string[];
  transactionId: string | null;
  /** The offline structural checks. */
  structure: { status: "pass" | "fail" | "review" | "indeterminate" | "not-run"; checks: PipelineCheck[]; detail: string };
  /** The live checks, after the build. */
  live: { status: "pass" | "fail" | "review" | "indeterminate" | "not-run"; checks: PipelineCheck[]; detail: string } | null;
  /** The visual check. */
  visual: { status: "pass" | "fail" | "review" | "indeterminate" | "not-run"; detail: string; renderRevision: string | null };
  /** The repairs that were applied. */
  repairs: Array<{ findingId: string; operations: number; result: "applied" | "skipped" | "failed"; detail: string }>;
  /**
   * The repair pass's own verdict.
   *
   * "The transaction committed" is not "the defect is gone". The pass
   * re-measures and compares, and this says what it found: no unresolved
   * high-confidence finding, no regression, or a screen that could not be
   * re-measured at all.
   */
  repairVerification?: {
    verdict: "PASS" | "FAIL" | "INDETERMINATE";
    reason: string;
    fixed: string[];
    unresolved: Array<{ key: string; rule: string; targets: string[]; reason: string }>;
    regressions: Array<{ key: string; rule: string; targets: string[]; title: string }>;
  };
  /** Everything still open. */
  findings: PipelineFinding[];
  /** The checks that could not run. */
  blocked: Array<{ check: string; why: string }>;
  trace: PipelineTrace;
}

export function buildReport(input: ReportInput): PipelineReport {
  const structureStatus = input.live?.status ?? input.structure.status;
  const visualStatus = input.visual.status;

  const status: PipelineReport["status"] = input.blocked.length > 0 && !input.applied
    ? "blocked"
    : input.findings.some((f) => f.severity === "critical" || f.severity === "high")
      ? "incomplete"
      : structureStatus === "fail" || visualStatus === "fail"
        ? "incomplete"
        : visualStatus === "pass" && structureStatus === "pass"
          ? "verified"
          : input.applied
            ? "built"
            : input.planned
              ? "planned"
              : "incomplete";

  const summary = summarize(status, input, structureStatus, visualStatus);

  return {
    status,
    summary,
    generated: {
      brief: input.planned,
      plan: input.planned,
      applied: input.applied,
      operations: input.operations,
      nodeIds: input.nodeIds,
      transactionId: input.transactionId,
    },
    structurallyVerified: {
      status: structureStatus,
      checks: [...input.structure.checks, ...(input.live?.checks ?? [])],
      detail: input.live?.detail ?? input.structure.detail,
    },
    visuallyReviewed: {
      status: visualStatus,
      detail: input.visual.detail,
      renderRevision: input.visual.renderRevision,
    },
    automaticallyRepaired: {
      count: input.repairs.filter((r) => r.result === "applied").length,
      findings: input.repairs.filter((r) => r.result === "applied").map((r) => r.findingId),
      detail:
        input.repairs.length === 0
          ? "No repair was attempted."
          : `${input.repairs.filter((r) => r.result === "applied").length} of ${input.repairs.length} repair(s) applied; ${input.repairs.filter((r) => r.result === "skipped").length} skipped, ${input.repairs.filter((r) => r.result === "failed").length} failed.` +
            (input.repairVerification
              ? ` The pass then re-measured the screen: ${input.repairVerification.verdict} — ${input.repairVerification.reason}`
              : ""),
    },
    ...(input.repairVerification
      ? {
          repairVerification: {
            verdict: input.repairVerification.verdict,
            reason: input.repairVerification.reason,
            fixed: input.repairVerification.fixed.length,            unresolved: input.repairVerification.unresolved,
            regressions: input.repairVerification.regressions,
          },
        }
      : {}),
    remainingFindings: input.findings,
    blocked: input.blocked,
    trace: input.trace,
  };
}

function summarize(
  status: PipelineReport["status"],
  input: ReportInput,
  structureStatus: string,
  visualStatus: string,
): string {
  const applied = input.applied ? `applied ${input.operations} operation(s)` : "not applied";
  const structure = structureStatus === "not-run" ? "structure not verified" : `structure ${structureStatus}`;
  const visual = visualStatus === "not-run" ? "not rendered or reviewed" : `visual ${visualStatus}`;
  const open = input.findings.length === 0 ? "no open findings" : `${input.findings.length} open finding(s)`;
  const blocked = input.blocked.length === 0 ? "" : `, ${input.blocked.length} check(s) blocked`;
  return `${status}: ${applied}, ${structure}, ${visual}, ${open}${blocked}.`;
}
