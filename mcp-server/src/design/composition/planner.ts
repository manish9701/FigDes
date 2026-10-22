/**
 * System 7 — Composition Planner (spec §13).
 *
 * Moves the planner from "what UI components do I need?" to "what should the
 * viewer understand first, second and third?". The output is a `CompositionPlan`
 * with focal, relationships, supporting context, controls, polish, hierarchy,
 * density, geometry and negative space.
 *
 * Builds on the existing screen planner (`plan/planner.ts`) rather than
 * replacing it: the screen plan provides regions/geometry, the visual pattern
 * provides the grammar, and this module binds them into design intent.
 */
import type { VisualPattern } from "../grammar/patterns";

export interface FocalRegion {
  id: string;
  why: string;
}

export interface Relationship {
  from: string;
  to: string;
  meaning: string;
  /** Semantic weight from relationship analysis. Absent means unranked. */
  importance?: "critical" | "major" | "minor";
}

export interface Region {
  id: string;
  role: string;
  intent: string;
}

export interface HierarchyPlan {
  order: string[];
  rationale: string;
}

export interface DensityPlan {
  level: "sparse" | "balanced" | "dense";
  rationale: string;
}

export interface GeometryPlan {
  strategy: string;
  rules: string[];
}

export interface NegativeSpacePlan {
  strategy: string;
  focalBreathingRoom: number;
}

/**
 * A composition hint (issue #24, item 3): the compiled `visualIntent.composition`
 * descriptor, turned into the plan-level changes the composition planner owns.
 * The skills layer produces the hint; applying it is this planner's job, and
 * every override names the descriptor as provenance so the plan can be audited
 * against the words the brief used.
 */
export interface CompositionHint {
  /** The descriptor (or descriptors, joined with '+') the hint came from. */
  descriptor: string;
  /** Why the hint applies — provenance that rides into the plan's rationales. */
  why: string;
  /** VisualIntent-density values; 'airy'/'calm' map to the plan's 'sparse'. */
  density?: "airy" | "calm" | "balanced" | "dense";
  /** The whitespace rhythm the descriptor commits to. */
  rhythm?: "generous" | "tight" | "even";
  /** Snap alignment for the runtime's alignGrid (recorded on the plan's geometry). */
  alignment?: "strong" | "loose";
  geometryStrategy?: string;
  geometryRules?: string[];
  negativeSpaceStrategy?: string;
  /** Where the focal sits under this descriptor; recorded on the plan's focal. */
  focalPosture?: string;
}

/**
 * Applies a composition hint to a built plan. Overrides are additive and
 * provenance-bearing: nothing is replaced silently, the descriptor is named in
 * every touched plan tree. A hint with no effect fields returns the plan as it
 * was built.
 */
export function applyCompositionHint(plan: CompositionPlan, hint: CompositionHint): CompositionPlan {
  const provenance = `composition hint '${hint.descriptor}'`;
  const next: CompositionPlan = { ...plan };

  if (hint.geometryStrategy !== undefined || (hint.geometryRules && hint.geometryRules.length > 0)) {
    const provenanceRule = `${provenance}: ${hint.why}`;
    next.geometry = {
      strategy: hint.geometryStrategy ?? plan.geometry.strategy,
      rules: hint.geometryRules && hint.geometryRules.length > 0
        ? [...plan.geometry.rules, ...hint.geometryRules, provenanceRule]
        : [...plan.geometry.rules, provenanceRule],
    };
    if (hint.focalPosture !== undefined && plan.focal) {
      next.focal = {
        id: plan.focal.id,
        why: `${plan.focal.why} (${provenance}: ${hint.focalPosture})`,
      };
    }
  }

  if (hint.density !== undefined) {
    const level: DensityPlan["level"] = hint.density === "dense" ? "dense" : hint.density === "balanced" ? "balanced" : "sparse";
    if (level !== plan.density.level) {
      next.density = {
        level,
        rationale: `${plan.density.rationale} Overridden by ${provenance} (${hint.density}): ${hint.why}`,
      };
    }
  }

  const negativeSpaceParts: string[] = [];
  if (hint.negativeSpaceStrategy !== undefined) negativeSpaceParts.push(hint.negativeSpaceStrategy);
  if (hint.rhythm !== undefined) negativeSpaceParts.push(`whitespace rhythm '${hint.rhythm}'`);
  if (negativeSpaceParts.length > 0) {
    next.negativeSpace = {
      strategy: `${plan.negativeSpace.strategy} ${provenance} — ${negativeSpaceParts.join("; ")}`,
      focalBreathingRoom: plan.negativeSpace.focalBreathingRoom,
    };
  }

  return next;
}

export interface CompositionPlan {
  visualDirection: string;
  pattern: string;
  focal: FocalRegion | null;
  primaryRelationships: Relationship[];
  supportingContext: Region[];
  controls: Region[];
  polish: string[];
  hierarchy: HierarchyPlan;
  density: DensityPlan;
  geometry: GeometryPlan;
  negativeSpace: NegativeSpacePlan;
  buildOrder: string[];
}

/** Build order (§13): focal first, polish last. */
export const COMPOSITION_BUILD_ORDER = [
  "canvas-and-focal",
  "primary-relationships",
  "supporting-context",
  "controls-and-states",
  "typography",
  "polish",
] as const;

export function buildCompositionPlan(input: {
  pattern: VisualPattern | null;
  focalId: string | null;
  focalWhy?: string;
  hierarchy: string[];
  regions: Array<{ id: string; role: string; why?: string }>;
  visualDirection?: string;
  /**
   * Ranked relationship meanings from relationship analysis. When supplied,
   * primary relationships carry their importance into the build instead of
   * treating every edge as equal.
   */
  relationshipMeanings?: Array<{ from: string; to: string; meaning: string; importance?: "critical" | "major" | "minor" }>;
  /**
   * The compiled `visualIntent.composition` descriptor as a plan-level hint
   * (issue #24, item 3). Applied with named provenance via
   * `applyCompositionHint`; a brief-stated composition remains the hard
   * constraint the hint can never replace, so the caller passes the hint only
   * after that precedence is settled.
   */
  compositionHint?: CompositionHint;
}): CompositionPlan {
  const pattern = input.pattern;
  const focal: FocalRegion | null = input.focalId
    ? { id: input.focalId, why: input.focalWhy ?? pattern?.focalStrategy ?? "largest primary surface" }
    : null;
  const isControl = (role: string): boolean => ["navigation", "header", "footer"].includes(role);
  const isContext = (role: string): boolean => ["inspector", "secondary", "status-rail"].includes(role);
  const supportingContext: Region[] = input.regions
    .filter((r) => r.id !== input.focalId && isContext(r.role))
    .map((r) => ({ id: r.id, role: r.role, intent: r.why ?? "supporting state" }));
  const controls: Region[] = input.regions
    .filter((r) => r.id !== input.focalId && isControl(r.role))
    .map((r) => ({ id: r.id, role: r.role, intent: r.why ?? "orientation / command" }));
  const contentPeers = input.regions.filter((r) => r.id !== input.focalId && !isControl(r.role) && !isContext(r.role));
  const primaryRelationships: Relationship[] = focal
    ? (input.relationshipMeanings && input.relationshipMeanings.length > 0
      ? input.relationshipMeanings.slice(0, 5).map((m) => ({
          from: m.from,
          to: m.to,
          meaning: m.meaning,
          ...(m.importance !== undefined ? { importance: m.importance } : {}),
        }))
      : contentPeers.slice(0, 3).map((r) => ({
          from: focal.id,
          to: r.id,
          meaning: pattern?.relationshipRules[0] ?? "supporting evidence for the focal decision",
        })))
    : [];
  const base: CompositionPlan = {
    visualDirection: input.visualDirection ?? "technical-instrument",
    pattern: pattern?.id ?? "none",
    focal,
    primaryRelationships,
    supportingContext,
    controls,
    polish: ["spacing rhythm pass", "typography hierarchy pass", "state-colour restraint check"],
    hierarchy: {
      order: input.hierarchy,
      rationale: pattern ? `Hierarchy follows '${pattern.name}': ${pattern.hierarchyRules[0] ?? pattern.purpose}` : "Area-ordered hierarchy.",
    },
    density: {
      level: pattern?.density ?? "balanced",
      rationale: pattern ? `Pattern '${pattern.name}' prescribes ${pattern.density} density.` : "Default balanced density.",
    },
    geometry: {
      strategy: pattern?.geometryRules[0] ?? "resolved layout geometry",
      rules: pattern?.geometryRules ?? [],
    },
    negativeSpace: {
      strategy: pattern ? `Whitespace separates per '${pattern.name}': ${(pattern.spacingRules ?? []).join("; ")}` : "Deliberate whitespace around focal.",
      focalBreathingRoom: 32,
    },
    buildOrder: [...COMPOSITION_BUILD_ORDER],
  };
  return input.compositionHint !== undefined && input.compositionHint.descriptor.length > 0
    ? applyCompositionHint(base, input.compositionHint)
    : base;
}

/**
 * Understandability invariant (§13): the screen must remain understandable if
 * secondary details are removed. Fails when there is no focal or when every
 * region has equal weight.
 */
export function compositionHolds(plan: CompositionPlan): { holds: boolean; reason: string } {
  if (!plan.focal) return { holds: false, reason: "No focal region: everything has equal weight, so removing any detail removes meaning." };
  return { holds: true, reason: `Focal '${plan.focal.id}' carries the decision; supporting context can degrade without losing it.` };
}
