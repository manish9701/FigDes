/**
 * System 9 — Native Screen Compiler, component resolution (spec §15).
 *
 * Resolves "which component instance goes where" from the composition plan:
 * existing native components first (via component intelligence ranking),
 * semantic rebuild only when nothing suitable exists.
 */
import { rankComponents, type ComponentKnowledge, type ComponentRole } from "../system/component-intelligence";

export interface ComponentInstancePlan {
  regionId: string;
  role: ComponentRole;
  /** Reuse: the existing component id to instance. */
  reuseComponentId?: string;
  reuseName?: string;
  /** Build: the semantic type to construct when no reuse candidate clears the bar. */
  buildType?: string;
  reason: string;
}

const ROLE_BUILD_TYPE: Record<ComponentRole, string> = {
  navigation: "navItem",
  input: "input",
  button: "button",
  status: "statusPill",
  data: "metric",
  container: "panel",
  inspector: "panel",
  command: "button",
  content: "text",
  visualization: "deviceNode",
  unknown: "panel",
};

/** Minimum score for reuse: weak matches rebuild rather than force a wrong part. */
const REUSE_BAR = 0.6;

export function resolveComponents(input: {
  known: ComponentKnowledge[];
  needs: Array<{ regionId: string; role: ComponentRole; query?: string }>;
}): ComponentInstancePlan[] {
  return input.needs.map((need) => {
    const [best] = rankComponents(input.known, { role: need.role, query: need.query, limit: 1 });
    if (best && best.score >= REUSE_BAR) {
      return {
        regionId: need.regionId,
        role: need.role,
        reuseComponentId: best.component.nodeId,
        reuseName: best.component.name,
        reason: `Reuse '${best.component.name}' (${best.reason}).`,
      };
    }
    return {
      regionId: need.regionId,
      role: need.role,
      buildType: ROLE_BUILD_TYPE[need.role],
      reason: best
        ? `No candidate clears the reuse bar (best '${best.component.name}' at ${best.score}). Build '${ROLE_BUILD_TYPE[need.role]}' semantically.`
        : `No known components. Build '${ROLE_BUILD_TYPE[need.role]}' semantically.`,
    };
  });
}
