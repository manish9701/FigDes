/**
 * One finding shape for the whole system (blueprint §7.6).
 *
 * The repository grew three mutually incompatible finding formats — the
 * protocol `Finding` (structural rules), `VisualFinding` (image-grounded) and
 * `contracts.CritiqueFinding` (declared, never constructed). The blueprint is
 * explicit: *adapt existing types rather than creating incompatible parallel
 * formats*, so this module does not replace any of them. It defines the
 * canonical `DesignFinding` and adapts each existing shape into it, so the
 * gate, the benchmark and the evidence package can speak one language while
 * every producer keeps working.
 *
 * What this buys, concretely:
 * - a real `category` (structural | visual | product | accessibility |
 *   consistency) instead of a free-form string;
 * - one severity vocabulary (`critical|high|medium|low|info`) with a
 *   documented mapping from the three legacy vocabularies;
 * - evidence as a list of typed, *revision-bound* references — evidence that
 *   cannot name the revision it came from is downgraded, not trusted;
 * - a lifecycle (`open|fixed|adjudicated|accepted-risk`) so an unresolved
 *   finding can never quietly disappear.
 */
import type { Finding as ProtocolFinding } from "../../../../shared/protocol";
import type { VisualFinding } from "./visual-findings";
import type { FindingAdjudication } from "./visual-findings";
import { EVALUATOR_VERSION } from "./revision";

export type FindingCategory = "structural" | "visual" | "product" | "accessibility" | "consistency";
export const FINDING_CATEGORIES: readonly FindingCategory[] = ["structural", "visual", "product", "accessibility", "consistency"];

/** One severity scale. `critical` blocks; `info` never does. */
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export type FindingStatus = "open" | "fixed" | "adjudicated" | "accepted-risk";

export type EvidenceType = "screenshot-region" | "node" | "geometry" | "token" | "requirement" | "test";

export interface DesignEvidence {
  type: EvidenceType;
  /** The exact revision this observation was made against. */
  revisionId: string;
  /** Node id, region name, crop, token name, requirement id or test name. */
  reference: string;
  details?: string;
}

export interface DesignFinding {
  id: string;
  ruleId: string;
  category: FindingCategory;
  severity: FindingSeverity;
  /** 0–1. Reduced automatically when the evidence is too thin to confirm. */
  confidence: number;
  summary: string;
  rationale: string;
  evidence: DesignEvidence[];
  affectedNodeIds: string[];
  suggestedFix?: string;
  /** What must be re-checked, and how, to believe the fix. */
  verification: string;
  status: FindingStatus;
  evaluatorVersion?: string;
}

/* -------------------------------------------------------------------------- */
/* Severity + confidence normalisation                                          */
/* -------------------------------------------------------------------------- */

/**
 * Legacy vocabularies → canonical severity. Deliberately conservative:
 * "serious"/"major" both become `high` rather than inflating to critical,
 * because inflation is how blocking counts get gamed.
 */
export function normalizeSeverity(value: string): FindingSeverity {
  switch (value.toLowerCase()) {
    case "critical":
    case "blocker":
    case "fatal":
      return "critical";
    case "serious":
    case "major":
    case "high":
      return "high";
    case "medium":
    case "moderate":
    case "warn":
    case "warning":
      return "medium";
    case "minor":
    case "low":
    case "polish":
      return "low";
    default:
      return "info";
  }
}

/** `review/rules.ts` already downgrades unverified coordinate spaces to low. */
export function confidenceToNumber(value: string | undefined, defaultIfMissing = 0.5): number {
  switch ((value ?? "").toLowerCase()) {
    case "high":
      return 0.9;
    case "medium":
      return 0.6;
    case "low":
      return 0.3;
    default:
      return defaultIfMissing;
  }
}

/**
 * Evidence sufficiency (blueprint §7.6): "findings without adequate evidence
 * should have reduced confidence and must not be presented as confirmed
 * defects." A finding with no evidence, or evidence that names no revision, is
 * a hypothesis.
 */
export function evidenceConfidence(evidence: readonly DesignEvidence[], base: number): number {
  if (evidence.length === 0) return Math.min(base, 0.35);
  const solid = evidence.filter((e) => e.type !== "test" && e.reference.length > 0);
  const revisionBound = solid.filter((e) => e.revisionId.length > 0);
  if (revisionBound.length === 0) return Math.min(base, 0.4);
  if (solid.length === 0) return Math.min(base, 0.45);
  return base;
}

/** djb2 — stable ids so tracking survives a re-render. */
export function findingId(ruleId: string, reference: string): string {
  const s = `${ruleId}|${reference}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `df-${h.toString(16)}`;
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                     */
/* -------------------------------------------------------------------------- */

export interface FindingInput {
  ruleId: string;
  category: FindingCategory;
  severity: string;
  confidence?: number;
  summary: string;
  rationale: string;
  evidence: DesignEvidence[];
  affectedNodeIds?: string[];
  suggestedFix?: string;
  verification: string;
  /** Overrides the derived id. */
  id?: string;
  status?: FindingStatus;
}

/** The single construction path, so normalisation can never be skipped. */
export function makeFinding(input: FindingInput): DesignFinding {
  const confidence = evidenceConfidence(input.evidence, clamp01(input.confidence ?? 0.7));
  const finding: DesignFinding = {
    id: input.id ?? findingId(input.ruleId, input.evidence[0]?.reference ?? input.summary),
    ruleId: input.ruleId,
    category: input.category,
    severity: normalizeSeverity(input.severity),
    confidence,
    summary: input.summary,
    rationale: input.rationale,
    evidence: input.evidence,
    affectedNodeIds: input.affectedNodeIds ?? [],
    verification: input.verification,
    status: input.status ?? "open",
    evaluatorVersion: EVALUATOR_VERSION,
  };
  if (input.suggestedFix !== undefined) finding.suggestedFix = input.suggestedFix;
  return finding;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/* -------------------------------------------------------------------------- */
/* Adapters — existing shapes into the canonical one                            */
/* -------------------------------------------------------------------------- */

const PROTOCOL_EVIDENCE_TYPE: Record<string, EvidenceType> = {
  geometry: "geometry",
  screenshot: "screenshot-region",
  "screenshot-crop": "screenshot-region",
  accessibility: "geometry",
  "design-system": "token",
  heuristic: "requirement",
  structural: "geometry",
  token: "token",
  test: "test",
  requirement: "requirement",
};

/**
 * Structural rule output → canonical finding. Geometry measurements become
 * `geometry` evidence carrying the rule version, so a stale rule set is
 * detectable rather than indistinguishable from a current one.
 */
export function fromProtocolFinding(finding: ProtocolFinding, revisionId: string): DesignFinding {
  const evidence: DesignEvidence[] = finding.nodeIds.slice(0, 8).map((nodeId) => ({
    type: "node" as const,
    revisionId,
    reference: nodeId,
    details: describeEvidence(finding.evidence),
  }));
  if (evidence.length === 0) {
    evidence.push({
      type: PROTOCOL_EVIDENCE_TYPE[finding.evidenceType ?? "geometry"] ?? "geometry",
      revisionId,
      reference: finding.rule,
      details: describeEvidence(finding.evidence),
    });
  }
  return makeFinding({
    id: findingId(finding.rule, finding.nodeIds[0] ?? finding.title),
    ruleId: finding.rule,
    category: "structural",
    severity: normalizeSeverity(finding.severity),
    confidence: confidenceToNumber(finding.confidence),
    summary: finding.title,
    rationale: finding.guidance ?? `Structural rule "${finding.rule}" measured this and reported it.`,
    evidence,
    affectedNodeIds: finding.nodeIds,
    ...(finding.guidance !== undefined ? { suggestedFix: finding.guidance } : {}),
    verification: `Re-run the "${finding.rule}" check on a fresh render of the affected nodes and confirm the finding no longer fires.`,
  });
}

/** Image-grounded finding → canonical finding, bound to the rendered revision. */
export function fromVisualFinding(v: VisualFinding, revisionId: string, screenshotReference?: string): DesignFinding {
  const evidence: DesignEvidence[] = [
    {
      type: "screenshot-region",
      revisionId,
      reference: screenshotReference ? `${screenshotReference}#${v.area}` : v.area,
      details: v.defect,
    },
  ];
  return makeFinding({
    id: v.id,
    ruleId: "visual.critique",
    category: "visual",
    severity: normalizeSeverity(v.severity),
    confidence: v.nodeIds.length > 0 ? 0.75 : 0.5,
    summary: `${v.area}: ${v.defect}`,
    rationale:
      v.nodeIds.length > 0
        ? `Seen in the rendered image and localized to ${v.nodeIds.length} measured layer(s).`
        : "Seen in the rendered image but not localized to measured layers — inspect before repairing.",
    evidence,
    affectedNodeIds: v.nodeIds,
    suggestedFix: v.repair,
    verification: `Re-render after the repair and confirm ${v.id} is gone from the visual critique.`,
  });
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                    */
/* -------------------------------------------------------------------------- */

export type Disposition = "confirmed" | "false-positive" | "intentional" | "unresolved";

export interface AcceptedRisk {
  findingId: string;
  reason: string;
  /** Evidence the risk was judged against — never an empty list. */
  evidence: DesignEvidence[];
  owner: string;
  /** The condition under which this stops being acceptable. */
  correctionConditions: string;
}

/**
 * Applies a reviewer's ruling. The original finding text is always retained in
 * `rationale`; only `status` moves. A ruling that names an unknown finding is
 * refused here (see `applyAdjudications`).
 */
export function applyAdjudication(finding: DesignFinding, adjudication: FindingAdjudication): DesignFinding {
  const note = `Adjudicated ${adjudication.disposition} by ${adjudication.reviewer}: ${adjudication.rationale}`;
  const status: FindingStatus =
    adjudication.disposition === "false-positive" || adjudication.disposition === "intentional"
      ? "adjudicated"
      : "open";
  return {
    ...finding,
    status,
    rationale: `${finding.rationale}\n${note}`,
  };
}

/**
 * Accepted risk (blueprint §10): the only way a confirmed finding stops
 * blocking, and it demands a reason, evidence, an owner and the conditions
 * under which the decision expires. Anything missing ⇒ the risk is refused and
 * the finding keeps its status.
 */
export function applyAcceptedRisk(finding: DesignFinding, risk: AcceptedRisk): DesignFinding | null {
  if (risk.findingId !== finding.id) return null;
  if (risk.reason.trim().length === 0) return null;
  if (risk.evidence.length === 0) return null;
  if (risk.owner.trim().length === 0) return null;
  if (risk.correctionConditions.trim().length === 0) return null;
  return {
    ...finding,
    status: "accepted-risk",
    rationale: `${finding.rationale}\nAccepted risk by ${risk.owner}: ${risk.reason} [expires when: ${risk.correctionConditions}]`,
  };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                      */
/* -------------------------------------------------------------------------- */

/** Only `critical` blocks. `high` is must-fix, not a gate veto by itself. */
export function isBlocking(finding: DesignFinding): boolean {
  return finding.severity === "critical" && finding.status !== "adjudicated" && finding.status !== "accepted-risk";
}

/**
 * A "confirmed" defect needs critical/high severity *and* evidence good enough
 * to act on. Low-confidence heuristics are hypotheses, never defects.
 */
export function isConfirmedDefect(finding: DesignFinding): boolean {
  if (finding.status === "accepted-risk" || finding.status === "adjudicated") return false;
  if (finding.severity !== "critical" && finding.severity !== "high") return false;
  return finding.confidence >= 0.6 && finding.evidence.length > 0 && finding.evidence.every((e) => e.revisionId.length > 0);
}

export interface FindingTally {
  total: number;
  blocking: number;
  byCategory: Record<FindingCategory, { open: number; fixed: number; adjudicated: number; acceptedRisk: number }>;
  unresolved: DesignFinding[];
}

/** Per-category lifecycle counts. Never a single collapsed score. */
export function tallyFindings(findings: readonly DesignFinding[]): FindingTally {
  const byCategory = {
    structural: { open: 0, fixed: 0, adjudicated: 0, acceptedRisk: 0 },
    visual: { open: 0, fixed: 0, adjudicated: 0, acceptedRisk: 0 },
    product: { open: 0, fixed: 0, adjudicated: 0, acceptedRisk: 0 },
    accessibility: { open: 0, fixed: 0, adjudicated: 0, acceptedRisk: 0 },
    consistency: { open: 0, fixed: 0, adjudicated: 0, acceptedRisk: 0 },
  } satisfies FindingTally["byCategory"];
  let blocking = 0;
  for (const f of findings) {
    const bucket = byCategory[f.category];
    if (f.status === "fixed") bucket.fixed++;
    else if (f.status === "adjudicated") bucket.adjudicated++;
    else if (f.status === "accepted-risk") bucket.acceptedRisk++;
    else bucket.open++;
    if (isBlocking(f)) blocking++;
  }
  return {
    total: findings.length,
    blocking,
    byCategory,
    unresolved: findings.filter((f) => f.status === "open" && (f.severity === "critical" || f.severity === "high")),
  };
}

/** Applies rulings to a finding set; unknown ids are reported, never dropped. */
export function applyAdjudications(
  findings: readonly DesignFinding[],
  adjudications: readonly FindingAdjudication[],
): { findings: DesignFinding[]; applied: FindingAdjudication[]; orphaned: FindingAdjudication[] } {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const applied: FindingAdjudication[] = [];
  const orphaned: FindingAdjudication[] = [];
  const out = findings.map((f) => {
    const ruling = adjudications.find((a) => a.findingId === f.id);
    if (!ruling) return f;
    applied.push(ruling);
    return applyAdjudication(f, ruling);
  });
  for (const a of adjudications) if (!byId.has(a.findingId)) orphaned.push(a);
  return { findings: out, applied, orphaned };
}

function describeEvidence(evidence: Record<string, string | number | boolean | null>): string {
  const parts = Object.entries(evidence)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 6)
    .map(([k, v]) => `${k}=${String(v)}`);
  return parts.join(" ");
}
