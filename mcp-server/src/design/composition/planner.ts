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
    ? contentPeers.slice(0, 3).map((r) => ({
        from: focal.id,
        to: r.id,
        meaning: pattern?.relationshipRules[0] ?? "supporting evidence for the focal decision",
      }))
    : [];
  return {
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
