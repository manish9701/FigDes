/**
 * Professional design quality gate.
 *
 * The visual critic describes what is wrong; this module decides whether the
 * result is safe to call "done". It deliberately uses verdicts/evidence rather
 * than pretending a single aesthetic number can certify a design.
 */
import type { AestheticDimension, CritiqueReport } from "./critique";

export interface QualityGateReport {
  status: "PASS" | "REVIEW" | "FAIL";
  blockingIssues: string[];
  repairPlan: string[];
  renderRequired: boolean;
  reason: string;
}

const COMPOSITION_CRITICAL = new Set([
  "Focal clarity",
  "Hierarchy",
  "Composition",
  "Card-wall tendency",
  "Template feel",
]);

export function evaluateQualityGate(
  critique: Pick<CritiqueReport, "verdict" | "dimensions">,
  options: { compositionLed?: boolean; renderReviewed?: boolean } = {},
): QualityGateReport {
  const compositionLed = options.compositionLed ?? false;
  const renderReviewed = options.renderReviewed ?? false;

  const blockingIssues = critique.dimensions
    .filter((d) => d.verdict === "FAIL")
    .map((d) => `${d.dimension}: ${d.suggestion ?? d.evidence}`);

  if (compositionLed) {
    for (const d of critique.dimensions) {
      if (COMPOSITION_CRITICAL.has(d.dimension) && d.verdict === "WATCH") {
        blockingIssues.push(`${d.dimension}: ${d.suggestion ?? d.evidence}`);
      }
    }
  }

  const repairPlan = critique.dimensions
    .filter((d) => d.verdict !== "PASS")
    .map((d) => d.suggestion ?? d.evidence)
    .filter((v, i, all) => all.indexOf(v) === i)
    .slice(0, 8);

  const renderRequired = compositionLed && !renderReviewed;

  if (blockingIssues.length > 0) {
    return {
      status: "FAIL",
      blockingIssues,
      repairPlan,
      renderRequired,
      reason: "The composition has a blocking visual-quality issue and must be repaired before it is considered done.",
    };
  }

  if (renderRequired) {
    return {
      status: "REVIEW",
      blockingIssues: [],
      repairPlan,
      renderRequired: true,
      reason: "Composition-led work must be rendered and visually judged before the quality gate can pass.",
    };
  }

  if (critique.verdict === "WATCH") {
    return {
      status: "REVIEW",
      blockingIssues: [],
      repairPlan,
      renderRequired: false,
      reason: "The design is structurally acceptable but still has visual watch items worth resolving.",
    };
  }

  return {
    status: "PASS",
    blockingIssues: [],
    repairPlan: [],
    renderRequired: false,
    reason: "No blocking visual-quality findings remain.",
  };
}

/** Safe routing hint for an agent deciding how to repair a failed composition. */
export function repairPriority(dimension: AestheticDimension): "composition" | "hierarchy" | "density" | "polish" {
  if (dimension.verdict === "PASS") return "polish";
  if (dimension.dimension === "Composition" || dimension.dimension === "Template feel" || dimension.dimension === "Card-wall tendency") {
    return "composition";
  }
  if (dimension.dimension === "Focal clarity" || dimension.dimension === "Hierarchy") return "hierarchy";
  if (dimension.dimension === "Whitespace" || dimension.dimension === "Density" || dimension.dimension === "Visual balance") return "density";
  return "polish";
}
