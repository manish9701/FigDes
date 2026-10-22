/**
 * System 9 — Native Screen Compiler, component resolution (spec §15).
 *
 * Resolves "which component instance goes where" from the composition plan:
 * existing native components first (via component intelligence ranking),
 * semantic rebuild only when nothing suitable exists.
 *
 * Variant intelligence (issue #24, item 9): when the discovered system holds a
 * component *set* and the intended content has distinguishing properties
 * (state, size, on/off), the resolvers pick the best-matching VARIANT instead
 * of instancing the default blindly. Variant reads stay small and explainable:
 * a candidate is scored against the requested properties with named reasons,
 * and only a match above a stated bar is applied — otherwise the default
 * variant is instanced with the requested properties listed for manual edits,
 * with the fallback reason recorded as evidence.
 */
import { rankComponents, type ComponentKnowledge, type ComponentRole } from "../system/component-intelligence";

export interface ComponentInstancePlan {
  regionId: string;
  role: ComponentRole;
  /** Reuse: the existing component id to instance. */
  reuseComponentId?: string;
  reuseName?: string;
  /**
   * The selected variant of a component set, when a set existed and a variant
   * matched the requested properties above the bar. Absent means the default
   * variant is instanced (possibly with `manualVariantProps` to apply).
   */
  variant?: ComponentVariantPlan;
  /**
   * Requested properties no variant covers: the caller applies them as manual
   * property edits on the default variant instead of a silent drop.
   */
  manualVariantProps?: Record<string, string>;
  /** Build: the semantic type to construct when no reuse candidate clears the bar. */
  buildType?: string;
  reason: string;
}

/** One resolved variant, with the explainable score behind the choice. */
export interface ComponentVariantPlan {
  name: string;
  /** The parsed `key=value` properties of the variant name. */
  props: Record<string, string>;
  /** Fraction of requested properties matched exactly, 0-1. */
  score: number;
  /** Named match reasons, in the codestyle of component intelligence. */
  reasons: string[];
}

/** Requested distinguishing properties for a region, e.g. `{ state: "selected" }`. */
export type VariantProps = Record<string, string | boolean | number>;

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

/**
 * Minimum fraction of requested properties a variant must match exactly before
 * it is selected over the default. Stated, not hidden: the fallback reason names it.
 */
const VARIANT_MATCH_BAR = 0.6;

/**
 * True when a component's variant list reads like a component set: at least two
 * variants, or a single variant already carrying `key=value` properties. The
 * MCP layer creates component sets with property-bearing variant names, so
 * names without properties cannot distinguish a set from orientation variants.
 */
export function isVariantSet(component: ComponentKnowledge): boolean {
  if (component.variants.length === 0) return false;
  if (component.variants.length >= 2) return true;
  return component.variants[0]!.name.includes("=");
}

/**
 * Parses a Figma variant name (`state=selected, size=md`) into properties.
 * Lower-cased keys and values so matching is case-insensitive; a variant whose
 * name carries no properties at all counts as one unnamed variant property.
 */
export function parseVariantProps(name: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const part of name.split(/[,/]+/)) {
    const piece = part.trim();
    if (piece.length === 0) continue;
    const eq = piece.indexOf("=");
    if (eq === -1) {
      props["variant"] = piece.toLowerCase();
      continue;
    }
    props[piece.slice(0, eq).trim().toLowerCase()] = piece.slice(eq + 1).trim().toLowerCase();
  }
  return props;
}

export interface VariantMatch {
  selected: boolean;
  best: ComponentVariantPlan | null;
  /** All considered candidates with their scores, kept for the fallback evidence. */
  considered: ComponentVariantPlan[];
}

/**
 * Matches requested properties against a component set's variant names.
 * Scoring is fraction-of-requested-exact: an exact key/value match adds 1, a
 * variant that carries the key with a *different* value is disqualified (it is
 * the wrong state, reason recorded), a key the variant does not model is
 * neutral but reported. The best candidate is selected only above the stated bar.
 */
export function matchVariant(variantNames: readonly string[], requested: VariantProps): VariantMatch {
  const requestedEntries = Object.entries(requested).map(([key, value]) => [key, String(value).toLowerCase()] as const);
  const considered: ComponentVariantPlan[] = [];
  const disqualified = new Map<ComponentVariantPlan, string>();
  for (const name of variantNames) {
    const parsed = parseVariantProps(name);
    let exact = 0;
    let wrongKey: string | null = null;
    const reasons: string[] = [];
    for (const [key, want] of requestedEntries) {
      const have = parsed[key];
      if (have === undefined) {
        reasons.push(`'${key}=${want}' not modelled by this variant name`);
        continue;
      }
      if (have === want) {
        exact += 1;
        reasons.push(`${key}='${want}' exact match`);
      } else if (wrongKey === null) {
        wrongKey = key;
        reasons.push(`${key} is '${have}', wanted '${want}' — wrong ${key}`);
      }
    }
    const plan: ComponentVariantPlan = {
      name,
      props: parsed,
      score: requestedEntries.length > 0 ? exact / requestedEntries.length : 0,
      reasons,
    };
    considered.push(plan);
    if (wrongKey !== null) disqualified.set(plan, wrongKey);
  }
  const eligible = [...considered].filter((c) => !disqualified.has(c));
  eligible.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const best = eligible[0] ?? null;
  const selected = best !== null && best.score >= VARIANT_MATCH_BAR;
  return { selected, best, considered };
}

export function resolveComponents(input: {
  known: ComponentKnowledge[];
  needs: Array<{ regionId: string; role: ComponentRole; query?: string; props?: VariantProps }>;
}): ComponentInstancePlan[] {
  return input.needs.map((need) => {
    const requestedProps = normalizeProps(need.props);
    const [best] = rankComponents(input.known, { role: need.role, query: need.query, limit: 1 });
    if (best && best.score >= REUSE_BAR) {
      const plan: ComponentInstancePlan = {
        regionId: need.regionId,
        role: need.role,
        reuseComponentId: best.component.nodeId,
        reuseName: best.component.name,
        reason: `Reuse '${best.component.name}' (${best.reason}).`,
      };
      if (requestedProps === undefined) return plan;

      if (isVariantSet(best.component)) {
        /* Variant intelligence: pick the best-matching variant of the set
           instead of instancing the default blindly (issue #24, item 9). */
        const match = matchVariant(best.component.variants.map((v) => v.name), requestedProps);
        if (match.selected && match.best !== null) {
          plan.variant = { name: match.best.name, props: match.best.props, score: match.best.score, reasons: match.best.reasons };
          plan.reason += ` Variant '${match.best.name}' selected (${match.best.reasons.join("; ")}; score ${match.best.score} ≥ bar ${VARIANT_MATCH_BAR}).`;
        } else {
          const bestLine = match.best
            ? `best '${match.best.name}' at ${match.best.score} (${match.best.reasons.join("; ")})`
            : "no candidate carried the requested keys";
          plan.manualVariantProps = requestedProps;
          plan.reason += ` No variant of the set matches the requested properties above the ${VARIANT_MATCH_BAR} bar (${bestLine}); the default variant is instanced and the properties are left as manual edits: ${describeProps(requestedProps)}.`;
        }
        return plan;
      }

      plan.manualVariantProps = requestedProps;
      plan.reason += ` '${best.component.name}' exposes no variant properties, so there is no variant to select; the requested properties become manual edits on the default instance: ${describeProps(requestedProps)}.`;
      return plan;
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

/** Normalizes requested props to lower-cased string keys/values. */
function normalizeProps(props?: VariantProps): Record<string, string> | undefined {
  if (props === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    out[key.toLowerCase()] = String(value).toLowerCase();
  }
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

function describeProps(props: Record<string, string>): string {
  return Object.entries(props).map(([k, v]) => `${k}='${v}'`).join(", ");
}
