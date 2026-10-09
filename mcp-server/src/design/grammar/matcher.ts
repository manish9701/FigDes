/**
 * Visual grammar matcher (spec §12): chooses a composition pattern from the
 * user's actual design problem instead of defaulting to a dashboard/card layout.
 */
import { VISUAL_PATTERNS, type VisualPattern } from "./patterns";

export type DecisionKind =
  | "select" | "monitor" | "configure" | "explore" | "inspect"
  | "compare" | "topology" | "integration" | "author";

const KIND_PATTERNS: Record<DecisionKind, string[]> = {
  topology: ["spatial-topology", "relationship-graph"],
  monitor: ["monitoring-instrument", "object-detail"],
  select: ["comparison-field", "exploration-surface"],
  compare: ["comparison-field", "editorial-focus"],
  inspect: ["object-inspector", "object-detail", "editorial-focus"],
  configure: ["configuration-workbench", "canvas-workspace"],
  explore: ["exploration-surface", "data-workspace", "timeline-flow"],
  integration: ["data-workspace", "object-inspector"],
  author: ["canvas-workspace", "configuration-workbench"],
};

export interface PatternMatch {
  pattern: VisualPattern;
  score: number;
  why: string;
}

/** Ranks patterns for a decision kind + goal text. Deterministic. */
export function matchPattern(kind: string, goal = ""): PatternMatch[] {
  const kinds = KIND_PATTERNS[kind as DecisionKind] ?? ["object-inspector", "exploration-surface"];
  const terms = goal.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const out: PatternMatch[] = VISUAL_PATTERNS.map((pattern) => {
    let score = 0;
    const reasons: string[] = [];
    const kindIndex = kinds.indexOf(pattern.id);
    if (kindIndex === 0) { score += 2; reasons.push(`primary pattern for '${kind}'`); }
    else if (kindIndex > 0) { score += 1.2 - kindIndex * 0.2; reasons.push(`supports '${kind}'`); }
    const hay = `${pattern.name} ${pattern.purpose} ${pattern.suitableFor.join(" ")}`.toLowerCase();
    for (const term of terms) {
      if (hay.includes(term)) { score += 0.3; reasons.push(`matches '${term}'`); }
    }
    return { pattern, score: Math.round(score * 100) / 100, why: reasons.join("; ") || "weak match — defaults apply" };
  });
  return out
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

/** The single best pattern, or null when nothing matches (caller falls back). */
export function bestPattern(kind: string, goal = ""): VisualPattern | null {
  return matchPattern(kind, goal)[0]?.pattern ?? null;
}
