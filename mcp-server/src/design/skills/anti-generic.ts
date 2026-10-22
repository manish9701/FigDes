/**
 * Skill: anti-generic design review (issue #22, skill G).
 *
 * ## What it does
 *
 * Reviews a composition plan for the tell-tale signs of template-driven
 * output: even card grids, metric shouting, uniform sectioning, no focal
 * point. It runs after the plan exists (plan-present input) and produces
 * findings in the same shape the pipeline's findings flow consumes.
 *
 * ## The honest boundary
 *
 * None of these patterns is banned outright (the issue is explicit about
 * that): a dashboard is right when the screen is genuinely a mixed-signal
 * overview, and the skill says so. The findings ask the plan to *earn* the
 * pattern — with a rationale in the plan's derivation or an asymmetry in the
 * regions — instead of falling into it. Findings are recorded with
 * confidence, never silently auto-applied as repairs.
 */
import type { SkillDecision, SkillEntry, SkillOutput, SkillSpec, SkillFinding } from "./contracts";
import type { NormalizedBrief, CompositionPlan, PipelineFinding } from "../../pipeline/contracts";

/** The window: equal sizes within this many px count as equal. */
const EQUAL_TOLERANCE_PX = 2;

/** Chrome roles: they may share size because chrome is structural. */
const CHROME_ROLES = new Set(["navigation", "header", "footer", "status-rail"]);

function findingId(rule: string): string {
  return `anti-generic.${rule}`;
}

/** Converts a skill finding into the pipeline finding flow's shape. */
export function toPipelineFinding(rule: string, f: SkillFinding, nodeIds: string[]): PipelineFinding {
  const severity: PipelineFinding["severity"] = f.severity === "serious" ? "high" : f.severity === "minor" ? "low" : "critical";
  return {
    id: findingId(rule),
    stage: "plan",
    severity,
    confidence: f.confidence === "high" ? 0.9 : f.confidence === "medium" ? 0.7 : 0.5,
    rule: findingId(rule),
    nodeIds,
    summary: f.summary,
    why: f.why,
    evidence: { kind: "plan", detail: f.evidence },
    fix: f.repair,
    automatable: false,
  };
}

/**
 * Reviews the plan and returns findings. Exported for direct use by the
 * compiler's review stage and tests.
 */
export function reviewPlan(plan: CompositionPlan): { findings: SkillFinding[]; notes: string[] } {
  const findings: SkillFinding[] = [];
  const notes: string[] = [];

  const content = plan.regions.filter((r) => !CHROME_ROLES.has(r.role));

  /* --- even card grid ------------------------------------------------------ */

  if (content.length >= 3) {
    const numeric = content.filter((r) => typeof r.sizing.width === "number");
    const equalWidth = numeric.filter((r) => Math.abs((r.sizing.width as number) - (numeric[0]!.sizing.width as number)) <= EQUAL_TOLERANCE_PX);
    const sameHeight = equalWidth.filter((r) => Math.abs((r.sizing.height as number) - (equalWidth[0]!.sizing.height as number)) <= EQUAL_TOLERANCE_PX);
    if (equalWidth.length >= 3 && sameHeight.length >= 3) {
      findings.push({
        rule: "even-card-grid",
        severity: "serious",
        confidence: "high",
        summary: `${equalWidth.length} content regions are one repeated equal tile; the screen reads as a template's card grid instead of a composition.`,
        why: "Even tiles make every element claim the same importance, so nothing is the thing the eye is for.",
        evidence: `Regions ${sameHeight
          .slice(0, 4)
          .map((r) => `'${r.id}'`)
          .join(", ")} share width ${sameHeight[0]!.sizing.width} and height ${sameHeight[0]!.sizing.height} (±${EQUAL_TOLERANCE_PX}px).`,
        repair:
          "Break the even split deliberately: give the payload region double the width, or switch the largest one to list-detail. If the grid is genuinely right (a settings table, a deck of equal tools), state so in the plan's derivation.",
      });
    }
  }

  /* --- no focal point ------------------------------------------------------- */

  if (plan.regions.length >= 3 && plan.focal === null) {
    findings.push({
      rule: "no-focal",
      severity: "serious",
      confidence: "high",
      summary: `No region is named as the thing the eye lands on first; the screen has hierarchy levels but no entry point.`,
      why: "Without a focal region the eye wanders, and hierarchy is only labelled — not composed.",
      evidence: `${plan.regions.length} regions, focal null.`,
      repair:
        "Name the highest-rank payload region as focal in the plan (or state why no focal is right: a deck's equal slides, a settings list).",
    });
  }

  /* --- metric shouting ------------------------------------------------------- */

  const metricSlots = plan.content.filter((s) => s.kind === "signal");
  if (metricSlots.length >= 5) {
    findings.push({
      rule: "metric-shouting",
      severity: "minor",
      confidence: "medium",
      summary: `${metricSlots.length} signal/metric slots on one screen compete at the same visual level.`,
      why: "Metrics matter only in as far as the decision needs them; an even wall of numbers hides the one that decides.",
      evidence: `Signal slots: ${metricSlots
        .slice(0, 5)
        .map((s) => `'${s.label}'`)
        .join(", ")}${metricSlots.length > 5 ? ", …" : ""}.`,
      repair:
        "Promote the one or two deciding metrics into a readout band and demote the rest into supporting rows with a stated order.",
    });
  }

  /* --- uniform sectioning ------------------------------------------------------- */

  if (content.length >= 4 && plan.focal !== null) {
    const withGrow = content.filter((r) => r.grow > 0);
    if (withGrow.length === content.length && new Set(content.map((r) => r.grow)).size === 1) {
      findings.push({
        rule: "uniform-sectioning",
        severity: "minor",
        confidence: "medium",
        summary: `All ${content.length} content regions absorb leftover space evenly; the screen sections uniformly.`,
        why: "Even growth flattens hierarchy — the composition contracts to tiles even when borders do not show them.",
        evidence: `grow=${content[0]!.grow} on every content region.`,
        repair: "Give the focal region a higher grow weight and let secondary context hug its content.",
      });
    }
  }

  notes.push(
    `Anti-generic review checked even-card-grid${content.length >= 3 ? "" : " (skipped: fewer than 3 content regions)"}, no-focal, metric-shouting and uniform-sectioning; ${findings.length} finding(s).`,
  );
  return { findings, notes };
}

const SPEC: SkillSpec = {
  id: "anti-generic-review",
  version: "v1",
  name: "Anti-generic design review",
  purpose:
    "Reviews the composition plan for template-driven tells — even card grids, missing focal point, metric shouting, uniform sectioning — and raises ranked findings against the plan before anything is built.",
  signals: ["many-regions", "card-grid-risk", "content-inventory"],
  whenToUse: "Plans with three or more regions, or briefs that ask for an overview/dashboard shape where template drift risk is highest.",
  whenNotToUse: "Very small compositions (fewer than three regions), where there is not enough structure for a template pattern to hide in.",
  expectedOutput:
    "Plan-stage findings (even-card-grid, no-focal, metric-shouting, uniform-sectioning) with evidence, why they matter and a stated repair; plus a note recording which checks ran.",
  requiredInputs: ["compositionPlan"],
  optionalContext: ["brief.antiGoals", "brief.desiredComposition"],
  decisionRules: [
    {
      id: "earn-the-pattern",
      dimension: "composition",
      rule: "No pattern is banned; every repeated-tile or uniform-section pattern must be earned by a rationale in the plan or broken by asymmetry.",
      why: "Dashboards are right for genuine mixed-signal overviews; the skill requires the reason to be stated, not assumed.",
    },
    {
      id: "finding-not-fix",
      dimension: "hierarchy",
      rule: "Findings are recorded with confidence and evidence; none is auto-applied as a repair.",
      why: "A template-tell finding is a judgement the caller can accept or override, not a mechanical defect.",
    },
    {
      id: "focal-is-compositional",
      dimension: "hierarchy",
      rule: "Hierarchy levels without a named focal region are labelled, not composed; a focus must exist or its absence must be justified.",
      why: "The issue names weak focal points as a sign of generated output.",
    },
  ],
  outputs: [
    {
      field: "plan-findings",
      description: "Pipeline-shaped findings against the plan, consumed by the review flow.",
      consumedBy: ["design/skills/intent-compiler.ts (review stage)", "pipeline/tools.ts (trace findings)"],
    },
    {
      field: "check-catalogue-note",
      description: "Which checks ran and were skipped, so a pass records absence of findings honestly.",
      consumedBy: ["pipeline/report.ts (trace stages)"],
    },
  ],
  qualityChecks: [
    {
      id: "even-grid-detected",
      dimension: "composition",
      criterion: "A plan with three equal content regions yields the even-card-grid finding naming them.",
    },
    {
      id: "focal-required",
      dimension: "hierarchy",
      criterion: "A three-region plan with focal null yields the no-focal finding.",
    },
    {
      id: "clean-plan-stays-clean",
      dimension: "composition",
      criterion: "An asymmetric plan with a named focal produces none of these findings.",
    },
  ],
  examples: [
    {
      summary: "An equal three-tile overview plan is challenged to state its pattern's reason",
      why: "The finding asks the plan to earn the pattern or break it; the caller decides.",
    },
  ],
  counterexamples: [
    {
      summary: "A settings list of equal tools is kept and recorded as justified",
      why: "Equal tools are genuinely equal; the finding would have been wrong to silence them.",
    },
  ],
  fixtures: ["issue-22-anti-generic-fixtures"],
};

export const antiGenericReview: SkillEntry = {
  spec: SPEC,

  apply({ plan }: { plan?: CompositionPlan; brief?: NormalizedBrief }): SkillOutput {
    const decisions: SkillDecision[] = [
      {
        skill: SPEC.id,
        dimension: "composition",
        key: "review-scope",
        value: "even-card-grid, no-focal, metric-shouting, uniform-sectioning",
        why: "The pattern catalogue this review pass checks, each requires-justification rather than banned.",
        hard: false,
      },
    ];
    if (plan === undefined) {
      return { skill: SPEC.id, decisions, notes: ["No plan supplied: nothing to review."] };
    }
    const { findings, notes } = reviewPlan(plan);
    decisions.push({
      skill: SPEC.id,
      dimension: "composition",
      key: "findings",
      value: findings.length,
      why: "Findings recorded; repairs are not auto-applied.",
      hard: false,
    });
    return { skill: SPEC.id, decisions, notes, findings };
  },
};
