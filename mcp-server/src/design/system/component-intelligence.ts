/**
 * System 2 — Component Intelligence (spec §8).
 *
 * Knowing a component exists is not enough; FigDes must understand its semantic
 * role. This module normalizes raw component summaries into `ComponentKnowledge`
 * and ranks candidates for a requested role, so the planner asks "what existing
 * component fits this role?" and reuses instead of rebuilding.
 *
 * Rule: prefer an existing native component over reconstructing the same UI
 * from rectangles and text.
 */

export type ComponentRole =
  | "navigation"
  | "input"
  | "button"
  | "status"
  | "data"
  | "container"
  | "inspector"
  | "command"
  | "content"
  | "visualization"
  | "unknown";

export interface VariantKnowledge {
  name: string;
}

export interface ComponentKnowledge {
  nodeId: string;
  name: string;
  description?: string;
  role: ComponentRole;
  variants: VariantKnowledge[];
  dimensions: { minWidth?: number; maxWidth?: number; height?: number };
  spacing?: { gap?: number; padding?: number };
  typography?: { family?: string; size?: number };
  states?: string[];
  usageExamples?: string[];
  visualWeight?: "low" | "medium" | "high";
}

export interface RankedComponent {
  component: ComponentKnowledge;
  score: number;
  reason: string;
}

const ROLE_PATTERNS: Array<{ role: ComponentRole; pattern: RegExp }> = [
  { role: "navigation", pattern: /nav|sidebar|rail|menu|tab|breadcrumb|header/i },
  { role: "input", pattern: /input|field|search|filter|select|dropdown|textarea|checkbox|radio|toggle|slider/i },
  { role: "button", pattern: /button|btn|cta|action|primary|fab/i },
  { role: "status", pattern: /status|badge|pill|chip|health|alert|indicator|toast|banner/i },
  { role: "data", pattern: /metric|kpi|stat|table|row|list|grid|chart|graph|telemetry|signal/i },
  { role: "inspector", pattern: /inspector|detail|panel-right|drawer|properties|context/i },
  { role: "command", pattern: /command|toolbar|actionbar|palette|deploy|run|commit/i },
  { role: "visualization", pattern: /topolog|device-?node|\bmap\b|diagram|graph-view|canvas-viz|trace/i },
  { role: "container", pattern: /card|panel|modal|dialog|sheet|section|container|frame/i },
  { role: "content", pattern: /hero|title|heading|body|copy|empty-state|placeholder/i },
];

/** Infers the semantic role from name + description. Pure and deterministic. */
export function inferComponentRole(name: string, description = ""): ComponentRole {
  const hay = `${name} ${description}`;
  for (const { role, pattern } of ROLE_PATTERNS) {
    if (pattern.test(hay)) return role;
  }
  return "unknown";
}

export function toKnowledge(raw: {
  id: string;
  name: string;
  description?: string;
  width?: number;
  height?: number;
  instanceCount?: number;
  variantCount?: number;
  properties?: string[];
}): ComponentKnowledge {
  const role = inferComponentRole(raw.name, raw.description ?? "");
  const instances = raw.instanceCount ?? 0;
  return {
    nodeId: raw.id,
    name: raw.name,
    ...(raw.description ? { description: raw.description } : {}),
    role,
    variants: (raw.properties ?? []).map((name) => ({ name })),
    dimensions: {
      ...(raw.width ? { minWidth: raw.width, maxWidth: raw.width } : {}),
      ...(raw.height ? { height: raw.height } : {}),
    },
    ...(raw.properties && raw.properties.length > 0 ? { states: raw.properties } : {}),
    ...(instances > 0 ? { usageExamples: [`reused ${instances}x`] } : {}),
    visualWeight: instances >= 10 ? "high" : instances >= 3 ? "medium" : "low",
  };
}

/**
 * Ranks known components for a requested role.
 * Considers: semantic role, context (name match), existing usage, dimensions,
 * variants. Reuse signal (instanceCount) breaks ties toward load-bearing parts.
 */
export function rankComponents(
  known: ComponentKnowledge[],
  request: { role: ComponentRole; query?: string; maxWidth?: number; maxHeight?: number; limit?: number },
): RankedComponent[] {
  const limit = request.limit ?? 5;
  const terms = (request.query ?? "").toLowerCase().split(/[\s/_-]+/).filter(Boolean);
  const scored: RankedComponent[] = known.map((component) => {
    let score = 0;
    const reasons: string[] = [];
    if (component.role === request.role) {
      score += 1;
      reasons.push(`role matches '${request.role}'`);
    } else if (component.role === "unknown" || request.role === "unknown") {
      score += 0.2;
    }
    const hay = component.name.toLowerCase();
    for (const term of terms) {
      if (hay === term) { score += 0.8; reasons.push(`name is '${term}'`); }
      else if (hay.includes(term)) { score += 0.4; reasons.push(`name contains '${term}'`); }
    }
    if (request.maxWidth !== undefined && component.dimensions.maxWidth !== undefined) {
      if (component.dimensions.maxWidth <= request.maxWidth) { score += 0.2; reasons.push("fits width"); }
      else { score -= 0.3; reasons.push("exceeds width"); }
    }
    if (component.variants.length > 0) { score += 0.15; reasons.push(`${component.variants.length} variant(s)`); }
    if (component.visualWeight === "high") { score += 0.25; reasons.push("load-bearing (high reuse)"); }
    else if (component.visualWeight === "medium") { score += 0.1; reasons.push("reused"); }
    return { component, score: Math.round(score * 100) / 100, reason: reasons.join("; ") || "no strong signal" };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.component.name.localeCompare(b.component.name))
    .slice(0, limit);
}
