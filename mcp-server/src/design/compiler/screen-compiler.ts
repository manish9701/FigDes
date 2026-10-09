/**
 * System 9 — Native Screen Compiler (spec §15).
 *
 * Translates DesignContext + CompositionPlan + VisualPattern + component
 * knowledge into a `NativeScreenPlan`: what to build, in what order, with which
 * primitives — reusing existing components, preserving semantic names and
 * editability, and never emitting arbitrary primitive spam.
 */
import type { CompositionPlan } from "../composition/planner";
import type { DesignContext } from "../context/design-context";
import type { VisualPattern } from "../grammar/patterns";
import type { ComponentKnowledge } from "../system/component-intelligence";
import { resolveComponents, type ComponentInstancePlan } from "./component-resolver";

export interface NativeNodePlan {
  id: string;
  kind: "frame" | "text" | "geometry" | "instance" | "connector";
  name: string;
  regionId: string;
  detail: string;
}

export interface RelationshipPlan {
  from: string;
  to: string;
  meaning: string;
  labelled: boolean;
}

export interface TextPlan {
  regionId: string;
  role: "display" | "heading" | "body" | "label" | "caption" | "technical";
  content: string;
}

export interface ValidationTarget {
  check: string;
  regionId?: string;
}

export interface NativeScreenPlan {
  nodes: NativeNodePlan[];
  relationships: RelationshipPlan[];
  components: ComponentInstancePlan[];
  text: TextPlan[];
  geometry: string[];
  validationTargets: ValidationTarget[];
  buildOrder: string[];
}

function roleForRegion(role: string): ComponentKnowledge["role"] {
  switch (role) {
    case "navigation": return "navigation";
    case "header": return "content";
    case "status-rail": return "status";
    case "primary-visual": return "visualization";
    case "inspector": return "inspector";
    case "content": return "content";
    case "secondary": return "data";
    default: return "unknown";
  }
}

export function compileScreen(input: {
  context: DesignContext;
  composition: CompositionPlan;
  pattern: VisualPattern | null;
  components: ComponentKnowledge[];
  regions: Array<{ id: string; role: string }>;
  headline: string;
}): NativeScreenPlan {
  const nodes: NativeNodePlan[] = [];
  const text: TextPlan[] = [];
  const geometry: string[] = [];

  for (const region of input.regions) {
    const isFocal = input.composition.focal?.id === region.id;
    nodes.push({
      id: `node-${region.id}`,
      kind: "frame",
      name: semanticName(region.id, region.role, isFocal),
      regionId: region.id,
      detail: isFocal
        ? `Focal surface: largest uninterrupted area, pattern '${input.pattern?.name ?? "none"}'.`
        : `Supporting surface for '${region.id}' (${region.role}). Auto-layout structural container.`,
    });
  }
  if (input.composition.focal) {
    geometry.push(`focal geometry for '${input.composition.focal.id}': native vectors/ellipses per pattern geometry rules`);
    text.push({ regionId: input.composition.focal.id, role: "display", content: input.headline });
  }
  for (const rel of input.composition.primaryRelationships) {
    geometry.push(`connector ${rel.from} -> ${rel.to} (${rel.meaning})`);
  }
  const components = resolveComponents({
    known: input.components,
    needs: input.regions.map((r) => ({ regionId: r.id, role: roleForRegion(r.role), query: r.id })),
  });
  return {
    nodes,
    relationships: input.composition.primaryRelationships.map((r) => ({ ...r, labelled: true })),
    components,
    text,
    geometry,
    validationTargets: [
      { check: "focal-readable", regionId: input.composition.focal?.id },
      { check: "relationships-labelled" },
      { check: "product-font", },
      { check: "no-card-wall" },
    ],
    buildOrder: input.composition.buildOrder,
  };
}

/**
 * Compiler principles (§15), enforced as names: semantic, hierarchical,
 * editable. A name like "Frame 12" is a compiler bug, not a cosmetic issue.
 */
function semanticName(id: string, role: string, focal: boolean): string {
  const prefix = focal ? "Focal" : role.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `${prefix} — ${id}`;
}
