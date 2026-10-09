/**
 * Release gate: compose the independent evaluators into one honest verdict
 * (blueprint §10, §17).
 *
 * This is the wiring the blueprint asks for and the codebase lacked. The five
 * evaluators used to be *scores* folded into one number, and two of them —
 * product fit and accessibility — were aliases of other dimensions rather than
 * evaluations. Here each dimension is computed by the module that owns it and
 * then reported with its own state, so a strong composition score can no longer
 * speak for product completeness.
 *
 * It also emits the §17 handoff record, because the blueprint's final
 * requirement is honesty about what exists: a high-fidelity visual prototype
 * is not a production-ready product, and the report must say which one this is.
 */
import type { Finding as ProtocolFinding } from "../../../../shared/protocol";
import type { FindingAdjudication, VisualFinding } from "./visual-findings";
import type { ConsistencyReport } from "./consistency";
import type { ProductCriticInput } from "./product-critic";
import type { AccessibilityInput } from "./accessibility";
import { evaluateProductCritic } from "./product-critic";
import { evaluateAccessibility } from "./accessibility";
import { evaluateFreshness, type RenderEvidenceRecord } from "./revision";
import {
  applyAdjudications,
  applyAcceptedRisk,
  fromProtocolFinding,
  fromVisualFinding,
  makeFinding,
  tallyFindings,
  type AcceptedRisk,
  type DesignFinding,
} from "./finding";
import {
  dimensionFromFindings,
  evaluateGate,
  type DimensionInput,
  type GateReport,
} from "./dimensions";
import { summarizeRepairs, type RepairTrace, type RepairHistorySummary } from "./repair-history";

export interface ReleaseGateInput {
  /** Revision under judgement. */
  revisionId: string;
  /** Structural rule output from the live file (or the compiled program). */
  structuralFindings?: ProtocolFinding[];
  /** Image-grounded findings from the rendered critique. */
  visualFindings?: VisualFinding[];
  product?: ProductCriticInput;
  accessibility?: AccessibilityInput;
  consistency?: ConsistencyReport | null;
  /** Render evidence for the final revision. */
  evidence?: RenderEvidenceRecord | null;
  /** Any mutation applied after the last render. Non-empty ⇒ not the final state. */
  postRenderMutations?: string[];
  liveValidation?: { performed: boolean; passed?: boolean; reasons?: string[] };
  benchmarkRegression?: { performed: boolean; regressions?: string[]; notes?: string[] };
  /** Optional explicit 0–100 scores; `null` means "not measured", never "fine". */
  scores?: Partial<Record<"structure" | "visual" | "product" | "accessibility" | "consistency", number | null>>;
  acceptedRisks?: AcceptedRisk[];
  adjudications?: FindingAdjudication[];
  repairs?: RepairTrace[];
  snapshotReference?: string;
  /** What was actually built. Drives the §17 honesty wording. */
  deliverable?: "visual-prototype" | "design-system-artifact" | "unclear";
}

export interface HandoffRecord {
  deliverable: "high-fidelity visual prototype" | "design-system artifact" | "unclear";
  /** What the numbers on screen represent. */
  dataStatus: "live" | "mock-labelled" | "mock-unlabelled" | "unknown";
  /** What exists that the artifact cannot prove. */
  notVerified: string[];
  /** The precise wording the report is allowed to use. */
  wording: string;
}

export interface ReleaseGateReport extends GateReport {
  findings: DesignFinding[];
  tally: ReturnType<typeof tallyFindings>;
  repairHistory: RepairHistorySummary | null;
  /** Every reason a dimension could not be measured, from every evaluator. */
  notVerified: string[];
  handoff: HandoffRecord;
  /** Evaluator outputs retained verbatim, so a reader can disagree. */
  evidenceDetail: {
    product: { checked: string[]; notChecked: string[]; summary: string };
    accessibility: { checked: string[]; notChecked: string[]; summary: string };
    consistency: { score: number; blocking: boolean; evidence: string[] } | null;
    freshness: { status: string; reasons: string[]; limitations: string[] };
  };
}

export function buildReleaseGate(input: ReleaseGateInput): ReleaseGateReport {
  const revisionId = input.revisionId;

  /* ---- Findings from every evaluator, unified ----------------------------- */
  const structural: DesignFinding[] = (input.structuralFindings ?? []).map((f) => fromProtocolFinding(f, revisionId));
  const visual: DesignFinding[] = (input.visualFindings ?? []).map((v) => fromVisualFinding(v, revisionId, input.snapshotReference));
  const product = input.product ? evaluateProductCritic({ ...input.product, revisionId }) : null;
  const a11y = input.accessibility ? evaluateAccessibility({ ...input.accessibility, revisionId }) : null;

  const dimensions: DimensionInput[] = [];

  /* ---- structure --------------------------------------------------------- */
  dimensions.push(
    dimensionFromFindings({
      dimension: "structure",
      findings: structural,
      score: input.scores?.structure ?? null,
      ...(input.scores?.structure === null || input.scores?.structure === undefined ? {} : {}),
    }),
  );

  /* ---- visual ----------------------------------------------------------- */
  const visualScore = input.scores?.visual ?? null;
  dimensions.push(
    dimensionFromFindings({
      dimension: "visual",
      findings: visual,
      score: visualScore ?? null,
      scoreOptional: visual.length === 0 && visualScore === null,
    }),
  );

  /* ---- product ---------------------------------------------------------- */
  dimensions.push(
    dimensionFromFindings({
      dimension: "product",
      findings: product?.findings ?? [],
      score: input.scores?.product ?? null,
      scoreOptional: input.product === undefined,
    }),
  );

  /* ---- accessibility --------------------------------------------------- */
  const a11yScore = input.scores?.accessibility ?? null;
  const a11yDimension = dimensionFromFindings({
    dimension: "accessibility",
    findings: a11y?.findings ?? [],
    score: a11yScore ?? null,
    scoreOptional: input.accessibility === undefined && a11yScore === null,
  });
  // A run with accessibility checks outstanding is never a clean PASS, even
  // when nothing failed: an unmeasured accessibility dimension is PENDING.
  if (
    input.accessibility !== undefined &&
    a11y !== null &&
    a11yDimension.status === "PASS" &&
    a11y.notChecked.length > 0 &&
    (a11yScore === null || a11yScore === undefined)
  ) {
    dimensions.push({
      dimension: "accessibility",
      status: "PENDING",
      reasons: [`${a11y.notChecked.length} accessibility check(s) not verifiable from a static frame: ${a11y.notChecked.slice(0, 3).join("; ")}`],
      findingIds: a11y.findings.map((f) => f.id),
    });
  } else {
    dimensions.push(a11yDimension);
  }

  /* ---- consistency ------------------------------------------------------ */
  const consistencyDimension: DimensionInput = (() => {
    if (!input.consistency) {
      return { dimension: "consistency", status: "NOT_APPLICABLE", reasons: ["No consistency measurement was supplied."], findingIds: [] };
    }
    const report = input.consistency;
    if (report.blocking) {
      return {
        dimension: "consistency",
        status: "FAIL",
        reasons: report.evidence.filter((e) => e.startsWith("BLOCKING") || e.includes("outside the approved set")),
        findingIds: [],
      };
    }
    return dimensionFromFindings({ dimension: "consistency", findings: [], score: report.score });
  })();
  dimensions.push(consistencyDimension);

  /* ---- evidence freshness ---------------------------------------------- */
  const freshness = evaluateFreshness({
    evidence: input.evidence ?? null,
    expectedRevision: input.revisionId,
    postRenderMutations: input.postRenderMutations ?? [],
  });
  dimensions.push({
    dimension: "evidence_freshness",
    status: freshness.status,
    reasons: freshness.reasons,
    findingIds: [],
  });

  /* ---- live validation (reported, non-blocking by default) -------------- */
  dimensions.push(
    (() => {
      if (!input.liveValidation) {
        return { dimension: "live_validation" as const, status: "NOT_APPLICABLE" as const, reasons: ["Live validation was not attempted for this run."], findingIds: [] };
      }
      if (!input.liveValidation.performed) {
        return { dimension: "live_validation" as const, status: "PENDING" as const, reasons: ["Live validation was required but not performed."], findingIds: [] };
      }
      if (input.liveValidation.passed !== true) {
        return {
          dimension: "live_validation" as const,
          status: "FAIL" as const,
          reasons: input.liveValidation.reasons ?? ["Live validation failed."],
          findingIds: [],
        };
      }
      return { dimension: "live_validation" as const, status: "PASS" as const, reasons: ["Live validation passed."], findingIds: [] };
    })(),
  );

  /* ---- benchmark regression (reported, non-blocking by default) --------- */
  dimensions.push(
    (() => {
      if (!input.benchmarkRegression) {
        return { dimension: "benchmark_regression" as const, status: "NOT_APPLICABLE" as const, reasons: ["No benchmark comparison was run."], findingIds: [] };
      }
      if (!input.benchmarkRegression.performed) {
        return { dimension: "benchmark_regression" as const, status: "PENDING" as const, reasons: ["A benchmark comparison was expected but not run."], findingIds: [] };
      }
      const regressions = input.benchmarkRegression.regressions ?? [];
      if (regressions.length > 0) {
        return {
          dimension: "benchmark_regression" as const,
          status: "FAIL" as const,
          reasons: [`${regressions.length} regression(s): ${regressions.slice(0, 3).join("; ")}`],
          findingIds: [],
        };
      }
      return { dimension: "benchmark_regression" as const, status: "PASS" as const, reasons: ["No regressions against the baseline."], findingIds: [] };
    })(),
  );

  /* ---- Assemble, adjudicate, accept risks ------------------------------ */
  const acceptedRisks = input.acceptedRisks ?? [];
  let allFindings: DesignFinding[] = [...structural, ...visual, ...(product?.findings ?? []), ...(a11y?.findings ?? [])];
  if (input.adjudications && input.adjudications.length > 0) {
    const applied = applyAdjudications(allFindings, input.adjudications);
    allFindings = applied.findings;
  }
  for (const risk of acceptedRisks) {
    const target = allFindings.find((f) => f.id === risk.findingId);
    if (!target) continue;
    const updated = applyAcceptedRisk(target, risk);
    if (updated) allFindings = allFindings.map((f) => (f.id === updated.id ? updated : f));
  }

  const gate = evaluateGate({ dimensions, acceptedRisks });

  const notVerified = [
    ...gate.notVerified,
    ...(product?.notChecked ?? []).map((c) => `product: ${c}`),
    ...(a11y?.notChecked ?? []).map((c) => `accessibility: ${c}`),
    ...freshness.limitations.map((l) => `evidence: ${l}`),
  ];

  return {
    ...gate,
    findings: allFindings,
    tally: tallyFindings(allFindings),
    repairHistory: input.repairs && input.repairs.length > 0 ? summarizeRepairs(input.repairs) : null,
    notVerified,
    handoff: buildHandoff(input, allFindings, notVerified),
    evidenceDetail: {
      product: product
        ? { checked: product.checked, notChecked: product.notChecked, summary: product.summary }
        : { checked: [], notChecked: ["product evaluation was not supplied"], summary: "Product evaluation was not supplied." },
      accessibility: a11y
        ? { checked: a11y.checked, notChecked: a11y.notChecked, summary: a11y.summary }
        : { checked: [], notChecked: ["accessibility evaluation was not supplied"], summary: "Accessibility evaluation was not supplied." },
      consistency: input.consistency ? { score: input.consistency.score, blocking: input.consistency.blocking, evidence: input.consistency.evidence } : null,
      freshness: { status: freshness.status, reasons: freshness.reasons, limitations: freshness.limitations },
    },
  };
}

/**
 * §17 wording. "Production-ready" is only available when the evidence actually
 * supports it; otherwise the report must say what this is — a high-fidelity
 * visual prototype with named limitations.
 */
function buildHandoff(input: ReleaseGateInput, findings: readonly DesignFinding[], notVerified: readonly string[]): HandoffRecord {
  const claimsLive = findings.some((f) => f.ruleId === "product.claims-live-data-without-source" && f.status === "open");
  const dataStatus: HandoffRecord["dataStatus"] = input.product?.liveDataConnected === true
    ? "live"
    : input.product?.liveDataConnected === false
      ? claimsLive
        ? "mock-unlabelled"
        : "mock-labelled"
      : "unknown";

  const openHigh = findings.filter((f) => f.status === "open" && (f.severity === "critical" || f.severity === "high"));
  const deliverable =
    input.deliverable === "design-system-artifact" ? "design-system artifact" : input.deliverable === "unclear" ? "unclear" : "high-fidelity visual prototype";

  const limitations = [...notVerified];
  if (dataStatus !== "live") limitations.push("No live data source is connected; on-screen values are fixtures or illustrative.");
  if (openHigh.length > 0) limitations.push(`${openHigh.length} open high/critical finding(s).`);

  return {
    deliverable,
    dataStatus,
    notVerified: limitations,
    wording:
      deliverable === "unclear"
        ? "State what was built before describing its quality."
        : `This is a ${deliverable}. It is not production-ready: interaction, data integration, responsive behaviour and engineering handoff are not proven by this artifact.`,
  };
}

/**
 * Convenience for callers that only have protocol findings and a freshness
 * record — the minimum a live run can supply.
 */
export function gateFromLiveRun(input: {
  revisionId: string;
  structuralFindings: ProtocolFinding[];
  visualFindings?: VisualFinding[];
  evidence?: RenderEvidenceRecord | null;
  postRenderMutations?: string[];
  liveValidation?: ReleaseGateInput["liveValidation"];
}): ReleaseGateReport {
  return buildReleaseGate(input);
}

/** Re-exported so a caller can add its own evidence-backed finding without importing two modules. */
export { makeFinding };
export type { DesignFinding, AcceptedRisk };
