/**
 * Visual IR compilation (FigDes visual layer).
 *
 * ## What this is
 *
 * Between art direction ("the topology is the hero") and the Design IR
 * ("frame at 264,96 sized 1176x780") sits a layer of semantic visual concepts:
 * focal, anchor, cluster, field, stage, lens, trace, layer, orbit, zone. None
 * of them names a coordinate. Each compiles to regions, content parenting,
 * relations or links in the Design IR — the same IR the layout engine already
 * solves, so no second geometry system exists.
 *
 * ## The rules that keep it honest
 *
 * - Every region-creating concept (stage, anchor, cluster, field, lens, layer,
 *   orbit, zone) makes a region named by the concept id. No host ambiguity, no
 *   silent sharing: visual concepts claim their members.
 * - Members are reparented into the concept region. An explicit parent on the
 *   content call loses with exactly one warning, so conflicts surface instead
 *   of silently winning.
 * - A concept naming an unknown id warns and is skipped, never invented.
 * - Traces become connectors; focal becomes intent. Neither draws anything.
 */
import type { Region } from "../../../shared/ir";
import type { RuntimeCall } from "./interpreter";

export interface VisualPlan {
  /** New regions to append (already resolved shapes, not calls). */
  regions: Region[];
  /** Content id -> region id reparenting. */
  reparents: Map<string, string>;
  /** Connector calls to append to the content stream. */
  connectors: RuntimeCall[];
  /** Focal content/region id, when a focal concept names one. */
  focal?: string;
  /** Region ids carrying depth, for elevation. */
  elevated: string[];
  warnings: string[];
}

const KNOWN: Record<string, { role: Region["role"]; composition: Region["composition"]; layout: Region["layout"]; width: Region["width"]; grow: number }> = {
  stage: { role: "primary-visual", composition: "canvas", layout: "flow", width: "fill", grow: 2 },
  anchor: { role: "navigation", composition: "instrument", layout: "flow", width: 240, grow: 0 },
  field: { role: "content", composition: "table", layout: "grid", width: "fill", grow: 1 },
  lens: { role: "inspector", composition: "split-view", layout: "flow", width: 360, grow: 0 },
};

export interface VisualInput {
  id: string;
  kind: string;
  target?: string;
  members?: string[];
  zone?: string;
  from?: string;
  to?: string;
  label?: string;
  title?: string;
}

/**
 * Compiles visual concepts against known region and content ids.
 *
 * Pure: ids and shapes in, regions and rewrites out. The caller owns
 * validation against the live program (which ids exist), passed in as sets.
 */
export function compileVisual(
  concepts: VisualInput[],
  knownRegions: Set<string>,
  knownContent: Set<string>,
): VisualPlan {
  const plan: VisualPlan = { regions: [], reparents: new Map(), connectors: [], elevated: [], warnings: [] };
  const claimed = new Set<string>();

  const claim = (id: string, regionId: string): void => {
    if (claimed.has(id)) {
      plan.warnings.push(`'${id}' is claimed by two visual concepts; the first claim wins.`);
      return;
    }
    claimed.add(id);
    plan.reparents.set(id, regionId);
  };

  for (const concept of concepts) {
    switch (concept.kind) {
      case "stage":
      case "anchor":
      case "field":
      case "lens": {
        const preset = KNOWN[concept.kind]!;
        if (knownRegions.has(concept.id)) {
          plan.warnings.push(`Visual ${concept.kind} '${concept.id}' collides with an existing region and was skipped.`);
          break;
        }
        knownRegions.add(concept.id);
        plan.regions.push({
          id: concept.id,
          role: preset.role,
          composition: preset.composition,
          layout: preset.layout,
          width: preset.width,
          height: "fill",
          grow: preset.grow,
          elevation: 0,
          children: [],
        });
        break;
      }

      case "cluster": {
        if (knownRegions.has(concept.id)) {
          plan.warnings.push(`Visual cluster '${concept.id}' collides with an existing region and was skipped.`);
          break;
        }
        const members = (concept.members ?? []).filter((m) => {
          if (!knownContent.has(m)) {
            plan.warnings.push(`Cluster '${concept.id}' names unknown member '${m}'; it was skipped.`);
            return false;
          }
          return true;
        });
        if (members.length === 0) {
          plan.warnings.push(`Cluster '${concept.id}' has no known members and was skipped.`);
          break;
        }
        knownRegions.add(concept.id);
        plan.regions.push({
          id: concept.id,
          role: "secondary",
          composition: "canvas",
          layout: "cluster",
          width: "fill",
          height: "fill",
          grow: 1,
          elevation: 0,
          children: [],
        });
        for (const member of members) claim(member, concept.id);
        break;
      }

      case "orbit": {
        if (knownRegions.has(concept.id)) {
          plan.warnings.push(`Visual orbit '${concept.id}' collides with an existing region and was skipped.`);
          break;
        }
        const members = (concept.members ?? []).filter((m) => {
          if (!knownContent.has(m)) {
            plan.warnings.push(`Orbit '${concept.id}' names unknown member '${m}'; it was skipped.`);
            return false;
          }
          return true;
        });
        if (members.length === 0) {
          plan.warnings.push(`Orbit '${concept.id}' has no known members and was skipped.`);
          break;
        }
        knownRegions.add(concept.id);
        plan.regions.push({
          id: concept.id,
          role: "primary-visual",
          composition: "canvas",
          layout: "radial",
          width: "fill",
          height: "fill",
          grow: 1,
          elevation: 0,
          children: [],
        });
        for (const member of members) claim(member, concept.id);
        break;
      }

      case "zone": {
        if (knownRegions.has(concept.id)) {
          plan.warnings.push(`Visual zone '${concept.id}' collides with an existing region and was skipped.`);
          break;
        }
        const members = (concept.members ?? []).filter((m) => {
          if (!knownContent.has(m)) {
            plan.warnings.push(`Zone '${concept.id}' names unknown member '${m}'; it was skipped.`);
            return false;
          }
          return true;
        });
        const comparison = concept.zone !== "context";
        knownRegions.add(concept.id);
        plan.regions.push({
          id: concept.id,
          role: comparison ? "content" : "inspector",
          composition: "split-view",
          layout: comparison ? "grid" : "flow",
          width: comparison ? "fill" : 360,
          height: "fill",
          grow: comparison ? 1 : 0,
          elevation: 0,
          ...(comparison ? { columns: 2 } : {}),
          children: [],
        });
        for (const member of members) claim(member, concept.id);
        break;
      }

      case "layer": {
        if (knownRegions.has(concept.id)) {
          plan.warnings.push(`Visual layer '${concept.id}' collides with an existing region and was skipped.`);
          break;
        }
        const members = (concept.members ?? []).filter((m) => {
          if (!knownContent.has(m)) {
            plan.warnings.push(`Layer '${concept.id}' names unknown member '${m}'; it was skipped.`);
            return false;
          }
          return true;
        });
        knownRegions.add(concept.id);
        plan.regions.push({
          id: concept.id,
          role: "secondary",
          composition: "canvas",
          layout: "flow",
          width: "fill",
          height: "fill",
          grow: 1,
          elevation: 1,
          children: [],
        });
        plan.elevated.push(concept.id);
        for (const member of members) claim(member, concept.id);
        break;
      }

      case "focal": {
        const target = concept.target;
        if (!target || (!knownRegions.has(target) && !knownContent.has(target))) {
          plan.warnings.push(`Focal concept '${concept.id}' names unknown target '${target ?? "(none)"}' and was skipped.`);
          break;
        }
        plan.focal = target;
        break;
      }

      case "trace": {
        if (!concept.from || !concept.to) {
          plan.warnings.push(`Trace '${concept.id}' needs both 'from' and 'to'.`);
          break;
        }
        if (!knownContent.has(concept.from) || !knownContent.has(concept.to)) {
          plan.warnings.push(`Trace '${concept.id}' names unknown endpoint(s) and was skipped.`);
          break;
        }
        plan.connectors.push({
          fn: "connector",
          id: concept.id,
          args: {
            from: concept.from,
            to: concept.to,
            ...(concept.label !== undefined ? { label: concept.label } : {}),
          },
        });
        break;
      }

      default: {
        plan.warnings.push(`Unknown visual concept kind '${concept.kind}' on '${concept.id}'; skipped.`);
        break;
      }
    }
  }

  return plan;
}