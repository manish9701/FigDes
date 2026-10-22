/**
 * Benchmark brief fixtures, in pipeline-brief form (issue #22 §6, phase "offline runner").
 *
 * The v1 suite in `suite.ts` names nine cases; this module gives each case the
 * *full brief* the pipeline's plan mode plans from — product, purpose, the
 * decision, the inventory — so the offline runner, the frozen baseline and the
 * regression-gate tests all measure with identical inputs. A benchmark whose
 * brief lives in a script cannot be reproduced from the library alone; these
 * are library data, not script data.
 *
 * The negative control (`generic-saas-dashboard`) stays a *brief* here: its
 * anti-generic expectations live with `quality/genericity.ts` and the
 * anti-generic review, which run against this brief inside the pipeline. And
 * none of these briefs carry a `desiredComposition`: the alternatives engine
 * (issue #22 §3) is part of what the benchmark measures, and a stated
 * composition would be a hard constraint the engine may rank against but
 * never replace.
 */
import type { AlternativesInput } from "../skills/alternatives";
import type { OfflineCaseEvidence } from "./regression";

/**
 * The brief as the benchmark freezes it for reproduction — this mirrors the
 * pipeline's normalized brief (`pipeline/contracts.ts`) closely enough that
 * the fixture passes `BriefInputSchema` as-is, and carries the exact subset
 * the v1 baseline schema records per case.
 */
export interface OfflineBrief {
  product: string;
  screen: string;
  purpose: string;
  primaryDecision: string;
  primaryAction: string;
  requiredInformation: string[];
  optionalInformation: string[];
  viewport: { width: number; height: number };
  visualDirection?: string;
  antiGoals?: string[];
  states?: string[];
}

export interface OfflineCaseBrief {
  caseId: string;
  brief: OfflineBrief;
}

export const OFFLINE_VIEWPORT: { width: number; height: number } = { width: 1440, height: 900 };

export const OFFLINE_BRIEFS: OfflineCaseBrief[] = [
  {
    caseId: "exo-compute-topology",
    brief: {
      product: "fenek-clusters",
      screen: "Cluster routing",
      purpose: "see how traffic moves between shards and clusters, and act on the pressured link",
      primaryDecision: "which pressured resource needs attention",
      primaryAction: "rebalance the shard",
      requiredInformation: [
        "shard links between clusters",
        "bandwidth per link",
        "drop rate per path",
        "node pressure by resource",
        "route healthy vs struggling",
        "cluster traffic share",
      ],
      optionalInformation: ["last rebalance on each cluster"],
      viewport: OFFLINE_VIEWPORT,
      visualDirection: "premium technical control-room",
      antiGoals: ["no grid of KPI cards", "route topology is the evidence, not a list"],
      states: ["degraded route", "recovering route"],
    },
  },
  {
    caseId: "exo-model-detail",
    brief: {
      product: "fenek-clusters",
      screen: "Model detail",
      purpose: "understand this model and decide whether it fits the selected local hardware",
      primaryDecision: "does this model fit the device",
      primaryAction: "assign model to device",
      requiredInformation: [
        "model name and family",
        "context length",
        "memory footprint",
        "tokens per second on target device",
        "devices it runs on",
        "fit verdict for the selected device",
      ],
      optionalInformation: ["model version", "who assigned it last"],
      viewport: OFFLINE_VIEWPORT,
      visualDirection: "premium technical spec-sheet",
    },
  },
  {
    caseId: "exo-runtime-monitoring",
    brief: {
      product: "fenek-clusters",
      screen: "Runtime monitor",
      purpose: "watch a live inference run and intervene when one node endangers the stream",
      primaryDecision: "intervene or let the run continue",
      primaryAction: "drain the pressured node",
      requiredInformation: [
        "throughput now",
        "latency p99 now",
        "error rate trend",
        "per-node pressure by resource",
        "stream queue depth",
        "shard health now",
      ],
      optionalInformation: ["recent interventions"],
      viewport: OFFLINE_VIEWPORT,
      visualDirection: "premium technical control-room",
      antiGoals: ["no grid of KPI cards", "per-node detail leads; summary follows"],
      states: ["degraded node", "recovering node", "saturated stream"],
    },
  },
  {
    caseId: "exo-configuration",
    brief: {
      product: "fenek-clusters",
      screen: "Policy approval",
      purpose: "approve the runtime policy and its thresholds before the cluster runs it",
      primaryDecision: "approve this policy",
      primaryAction: "approve policy",
      requiredInformation: [
        "settings the policy changes",
        "approval thresholds",
        "rebalance schedule",
        "provider and model covered",
        "who approved the last change",
        "approval state",
      ],
      optionalInformation: ["change history"],
      viewport: OFFLINE_VIEWPORT,
      states: ["pending approval", "approved"],
    },
  },
  {
    caseId: "exo-enterprise-workspace",
    brief: {
      product: "fenek-fleet",
      screen: "Enterprise workspace",
      purpose: "explore the enterprise device fleet and act on a chosen subset of devices",
      primaryDecision: "act on this subset of devices",
      primaryAction: "assign devices to deployment",
      requiredInformation: [
        "devices with model and serial",
        "device state",
        "team each device is assigned to",
        "deployments running on each",
        "device health",
        "access policy per team",
      ],
      optionalInformation: ["recent activity per device"],
      viewport: OFFLINE_VIEWPORT,
    },
  },
  {
    caseId: "generic-saas-dashboard",
    brief: {
      product: "generic-saas",
      screen: "Dashboard",
      purpose: "review this generic dashboard as a negative control and its templates",
      primaryDecision: "which metric needs attention",
      primaryAction: "open report",
      requiredInformation: [
        "total users",
        "monthly revenue",
        "growth percentage",
        "conversion rate",
        "active sessions",
        "quick settings links",
      ],
      optionalInformation: ["changelog feed"],
      viewport: OFFLINE_VIEWPORT,
    },
  },
  {
    caseId: "data-heavy-workspace",
    brief: {
      product: "ops-ledger",
      screen: "Follow-up queue",
      purpose: "find the events and incidents that need follow-up and move them to an owner",
      primaryDecision: "which incident needs follow-up first",
      primaryAction: "assign owner",
      requiredInformation: [
        "incident captions",
        "event stream by source",
        "error category",
        "open vs escalated",
        "owner per incident",
        "last activity per incident",
      ],
      optionalInformation: ["escalation policy per category"],
      viewport: OFFLINE_VIEWPORT,
      states: ["open", "escalated"],
    },
  },
  {
    caseId: "spatial-relationship",
    brief: {
      product: "graph-controller",
      screen: "Dependency graph",
      purpose: "find the weak link in this dependency graph and trace the relationships around it",
      primaryDecision: "find the failing dependency",
      primaryAction: "open failing service",
      requiredInformation: [
        "service links",
        "replication status per node",
        "dependency depth",
        "downtime",
        "requests per hour",
        "load balance quota",
      ],
      optionalInformation: ["history of the last failure"],
      viewport: OFFLINE_VIEWPORT,
      antiGoals: ["the dependency graph is the evidence, not a list"],
    },
  },
  {
    caseId: "editorial-product-page",
    brief: {
      product: "fenek-models",
      screen: "Run versus change",
      purpose: "compare the model's run cost, latency, quality and fit before choosing what to run",
      primaryDecision: "run this model or change models",
      primaryAction: "run model",
      requiredInformation: [
        "model name and publisher",
        "run cost per task",
        "latency p99",
        "quality verdict",
        "fit state on target device",
        "recommended last mile",
      ],
      optionalInformation: ["alternative models ranked"],
      viewport: OFFLINE_VIEWPORT,
      visualDirection: "premium editorial",
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Issue #23 EXO regression fixtures — new versioned arrays; frozen lists stay */
/* -------------------------------------------------------------------------- */

/**
 * The canonical failure classes the EXO regressions pin (issue #23). Fixture
 * `failureTargets` reference these by exact string, and the regression tests
 * prove each class is detectable through the mechanism that actually reports
 * it — the runtime's real violation rules ("identity", "containment",
 * "operation-trace", "connector"), the type-criteria audit, the accessibility
 * evaluator, and (for caller-owned policy stages) the final gate's gate
 * records. The five fixtures together cover all eight; renaming a string here
 * means moving the tests with it.
 */
export const EXO_REGRESSION_FAILURE_CLASSES = [
  "duplicate-content-or-component-ids",
  "node-assigned-to-two-parents",
  "child-outside-overflow-forbidden-region",
  "connector-endpoints-not-aligned",
  "text-emitted-width-vs-resolved-bounds",
  "sub-11px-technical-labels",
  "sub-wcag-aa-contrast",
  "repeated-illustrative-sample-disclosures",
] as const;

export type ExoRegressionFailureClass = (typeof EXO_REGRESSION_FAILURE_CLASSES)[number];

/**
 * An EXO regression fixture: the brief the pipeline plans from, plus the
 * failure classes the case exists to catch. This is benchmark data like
 * `OfflineCaseBrief`, but it lives in its own versioned arrays because
 * `OFFLINE_BRIEFS`, `BENCHMARKS` and `EXPANDED_BENCHMARKS` are frozen and
 * length-pinned by test — regression fixtures append here, never there.
 */
export interface ExoRegressionFixture {
  caseId: string;
  brief: OfflineBrief;
  /** The failure classes this fixture's programs are expected to surface. */
  failureTargets: ExoRegressionFailureClass[];
}

/**
 * The v1 negative control is referenced by id and its brief reused by
 * reference — duplicating it would fork the anti-generic measurement.
 */
export const EXO_REGRESSION_NEGATIVE_CONTROL_ID = "generic-saas-dashboard";

/** The four new regression briefs (issue #23), one unioned partition each. */
export const EXO_REGRESSION_BRIEFS: ExoRegressionFixture[] = [
  {
    caseId: "exo-regression-topology",
    brief: {
      product: "fenek-clusters",
      screen: "Compute operations",
      purpose: "watch compute pressure across nodes and act on the node that endangers the fleet",
      primaryDecision: "which compute node needs attention",
      primaryAction: "drain the pressured node",
      requiredInformation: [
        "compute nodes and their links",
        "bandwidth per link",
        "drop rate per path",
        "node pressure by resource",
        "route healthy vs struggling",
        "node traffic share",
      ],
      optionalInformation: ["last drained on each node"],
      viewport: OFFLINE_VIEWPORT,
      visualDirection: "premium technical control-room",
      antiGoals: ["no grid of KPI cards", "the node graph is the evidence, not a list"],
      states: ["degraded node", "recovering node"],
    },
    failureTargets: [
      "duplicate-content-or-component-ids",
      "connector-endpoints-not-aligned",
      "child-outside-overflow-forbidden-region",
    ],
  },
  {
    caseId: "exo-regression-model-selection",
    brief: {
      product: "fenek-clusters",
      screen: "Model selection and configuration",
      purpose: "pick the model that fits the selected device and confirm the configuration before it runs",
      primaryDecision: "which model fits the selected device",
      primaryAction: "assign model to device",
      requiredInformation: [
        "model name and family",
        "context length",
        "memory footprint",
        "tokens per second on target device",
        "devices it runs on",
        "fit verdict for the selected device",
      ],
      optionalInformation: ["model version", "who assigned it last"],
      viewport: OFFLINE_VIEWPORT,
      visualDirection: "premium technical spec-sheet",
    },
    failureTargets: ["node-assigned-to-two-parents", "sub-11px-technical-labels"],
  },
  {
    caseId: "exo-regression-dense-table",
    brief: {
      product: "ops-ledger",
      screen: "Audit table",
      purpose: "scan the dense audit rows and route the row that needs follow-up to an owner",
      primaryDecision: "which audit row needs follow-up first",
      primaryAction: "assign owner",
      requiredInformation: [
        "row captions",
        "event stream by source",
        "error category",
        "open vs escalated",
        "owner per row",
        "last activity per row",
      ],
      optionalInformation: ["escalation policy per category"],
      viewport: OFFLINE_VIEWPORT,
      states: ["open", "escalated", "focused row"],
    },
    failureTargets: ["text-emitted-width-vs-resolved-bounds", "duplicate-content-or-component-ids"],
  },
  {
    caseId: "exo-regression-empty-error",
    brief: {
      product: "fenek-clusters",
      screen: "Telemetry recovery",
      purpose: "show the stream's empty, loading and error states and the way back to telemetry",
      primaryDecision: "whether telemetry recovered or needs intervention",
      primaryAction: "retry the stream",
      requiredInformation: [
        "empty state before telemetry exists",
        "loading state while the stream connects",
        "error state naming the failing source",
        "recovery action and its result",
        "stream queue depth",
        "shard health now",
      ],
      optionalInformation: ["recent interventions"],
      viewport: OFFLINE_VIEWPORT,
      visualDirection: "premium technical control-room",
      antiGoals: ["no grid of KPI cards", "states are first-class evidence, not a demo"],
      states: ["empty", "loading", "error", "recovering"],
    },
    failureTargets: ["sub-wcag-aa-contrast", "repeated-illustrative-sample-disclosures"],
  },
];

/**
 * All five fixtures: the four new briefs plus the referenced negative control
 * (no failure targets — it is the anti-generic control, not a detector case).
 * Assembling the reference at module load fails loudly if the pinned v1 id
 * ever drifts out of `OFFLINE_BRIEFS`, rather than silently nulling it.
 */
export const EXO_REGRESSION_FIXTURES: ExoRegressionFixture[] = (() => {
  const control = OFFLINE_BRIEFS.find((entry) => entry.caseId === EXO_REGRESSION_NEGATIVE_CONTROL_ID);
  if (!control) {
    throw new Error(`EXO regression negative control '${EXO_REGRESSION_NEGATIVE_CONTROL_ID}' is missing from OFFLINE_BRIEFS — the fixture set cannot be assembled truthfully.`);
  }
  return [...EXO_REGRESSION_BRIEFS, { caseId: control.caseId, brief: control.brief, failureTargets: [] }];
})();

/**
 * The pipeline response → `OfflineCaseEvidence`. One implementation for the
 * runner, the frozen baseline and the gate tests, so they can never measure
 * the same case two ways. `overrides` exists for the gate tests' absent-variation
 * probes (and for nothing else: the runner and the baseline never pass it).
 */
export function evidenceFromResponse(
  resp:
    | {
        brief?: { primaryDecision?: string | null; requiredInformation?: string[]; optionalInformation?: string[] } | null;
        plan?: {
          focal?: { id: string } | null;
          usage?: { focalShare: number; coverage: number; largestEmptyBand: number } | null;
        } | null;
        visualIntelligence?:
          | {
              intent?: Record<string, unknown> | null;
              alternatives?: { taskKind: string; candidateCount: number; distinct: boolean; selectedFamily: string | null } | null;
              review?: { findings: Array<{ rule?: string }> } | null;
            }
          | null;
        typeCriteria?: { findings: Array<unknown> | [] } | null;
        structure?: { status?: string; findings?: Array<{ summary?: string; rule?: string }> | [] } | null;
      }
    | null,
  caseId: string,
  overrides: Partial<OfflineCaseEvidence> = {},
): OfflineCaseEvidence {
  const structureFindings = resp?.structure?.findings ?? [];
  const alternatives = resp?.visualIntelligence?.alternatives ?? null;
  const evidence: OfflineCaseEvidence = {
    caseId,
    decisionKind: alternatives?.taskKind ?? "inspect",
    primaryDecision: resp?.brief?.primaryDecision ?? "",
    requiredInformation: resp?.brief?.requiredInformation ?? [],
    optionalInformation: resp?.brief?.optionalInformation ?? [],
    focalRegionId: resp?.plan?.focal?.id ?? null,
    focalShare: resp?.plan?.usage?.focalShare ?? 0,
    coverage: resp?.plan?.usage?.coverage ?? 0,
    largestEmptyBand: resp?.plan?.usage?.largestEmptyBand ?? 0,
    compiledIntentFields: Object.keys(resp?.visualIntelligence?.intent ?? {}),
    alternatives:
      alternatives === null
        ? null
        : {
            candidateCount: alternatives.candidateCount,
            distinct: alternatives.distinct,
            selectedFamily: alternatives.selectedFamily,
          },
    reviewFindings: (resp?.visualIntelligence?.review?.findings ?? []).length,
    typeCriteria: { run: true, findings: (resp?.typeCriteria?.findings ?? []).length },
    structureStatus: (resp?.structure?.status as OfflineCaseEvidence["structureStatus"]) ?? "indeterminate",
    overflowFindings: structureFindings.filter((f) => /overflow/i.test(String(f.summary ?? f.rule ?? ""))).length,
    geometryFindings: structureFindings.filter((f) => /geometry|size/i.test(String(f.summary ?? f.rule ?? ""))).length,
    nativeApplied: false,
  };
  return { ...evidence, ...overrides };
}

/** Narrow view of the alternatives engine's input used by the decision record. */
export type DecisionBriefInput = AlternativesInput;
