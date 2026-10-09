/**
 * Task-driven region derivation (point A).
 *
 * The planner used to map a decision kind straight to a predefined region
 * shell. Shells are a useful foundation, but applied blindly they replace one
 * generic template with several specialized ones. This module derives regions
 * from the actual task instead:
 *
 *   1. every available-information item is classified into an information role
 *      (option, attribute, signal, relationship, setting, event, detail);
 *   2. regions are assembled to serve those roles for the stated decision, with
 *      each region's `because` citing the items it serves;
 *   3. the matched visual pattern is applied as *guidance* (density, focal
 *      emphasis, anti-pattern guards) and every applied rule is recorded;
 *   4. known components are resolved per region, so the plan reflects what will
 *      be reused rather than rebuilt.
 *
 * When the information is absent or unclassifiable, derivation returns null
 * and the caller falls back to the kind shells explicitly (provenance
 * `shell-fallback`) instead of pretending a guess was derived.
 */
import type { VisualPattern } from "../grammar/patterns";
import type { Composition } from "../../runtime/layout";
import type { Region } from "../../../../shared/ir";
import { rankComponents, type ComponentKnowledge, type ComponentRole } from "../system/component-intelligence";

export type InfoKind =
  | "option"
  | "attribute"
  | "signal"
  | "relationship"
  | "setting"
  | "event"
  | "detail"
  | "unknown";

export interface ClassifiedInfo {
  text: string;
  kind: InfoKind;
}

const KIND_PATTERNS: Array<{ kind: InfoKind; pattern: RegExp }> = [
  { kind: "relationship", pattern: /\bnodes?\b|links?|edges?|topolog|connect|latency|flow|assign|route|dependen|cluster-field|bandwidth/i },
  { kind: "setting", pattern: /setting|config|parameter|polic|preference|tune|threshold|schedule/i },
  { kind: "event", pattern: /event|log|activit|deploy|audit|history|incident|alert stream/i },
  { kind: "signal", pattern: /utili[sz]ation|errors?|health|status|pressure|cpu|signal|throughput|alerts?|live|watt|temp|disk|network|gpu|storage|load/i },
  { kind: "option", pattern: /model name|device|machine|provider|endpoint|option|choice|candidate|variant|running models|filter|facet|\bresults?\b|\brows?\b|listing/i },
  { kind: "attribute", pattern: /memory|vram|fit|throughput|version|size|spec|benchmark|score|statistic/i },
  { kind: "detail", pattern: /descri|document|sample|snippet|endpoint detail|credential/i },
];

/** Classifies one information item. Deterministic; unknown is an honest answer. */
export function classifyInfoItem(text: string): InfoKind {
  for (const { kind, pattern } of KIND_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return "unknown";
}

export function classifyInformation(items: string[]): ClassifiedInfo[] {
  return items.map((text) => ({ text, kind: classifyInfoItem(text) }));
}

export interface DerivedRegion {
  id: string;
  role: Region["role"];
  composition: Composition;
  width: Region["width"];
  height: Region["height"];
  grow: number;
  gap?: number;
  padding?: number;
  /** Cites the information this region serves. Never generic. */
  because: string;
  reuse?: { componentId: string; name: string };
  infoKinds: InfoKind[];
}

export interface Derivation {
  strategy: "task-derived" | "shell-fallback";
  pattern: string | null;
  infoKinds: InfoKind[];
  /**
   * Every classified item with its raw text preserved.
   *
   * Previously only `infoKinds` survived and the raw strings were lost, so
   * nothing downstream could verify what the plan was actually built from.
   * The raw text is the evidence; the kind is the interpretation.
   */
  information: ClassifiedInfo[];
  /** Items that matched nothing. Named so the caller can ask for better data. */
  unclassified: string[];
  /** Every pattern rule actually applied, so guidance is auditable. */
  appliedGuidance: string[];
  note: string;
}

function cite(items: ClassifiedInfo[], kinds: InfoKind[]): string {
  const names = items.filter((i) => kinds.includes(i.kind)).map((i) => i.text);
  if (names.length === 0) return "the stated decision";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} (+${names.length - 3} more)`;
}

function resolveReuse(
  components: ComponentKnowledge[],
  regionId: string,
  role: ComponentRole,
): DerivedRegion["reuse"] {
  if (components.length === 0) return undefined;
  const [best] = rankComponents(components, { role, query: regionId, limit: 1 });
  if (best && best.score >= 0.6) return { componentId: best.component.nodeId, name: best.component.name };
  return undefined;
}

/**
 * Applies the pattern as constraints on derived regions and records each one.
 * Guidance never reorders regions and never changes grow: emphasis flows
 * through the art director, so a pattern cannot silently restructure the plan.
 */
export function applyPatternGuidance(
  regions: DerivedRegion[],
  pattern: VisualPattern | null,
): string[] {
  if (!pattern) return [];
  const applied: string[] = [];
  const gapByDensity = pattern.density === "sparse" ? 32 : pattern.density === "dense" ? 12 : 24;
  for (const region of regions) {
    if (region.gap === undefined) {
      region.gap = gapByDensity;
      applied.push(`'${region.id}' gap ${gapByDensity}px from '${pattern.name}' ${pattern.density} density.`);
    }
  }
  if (pattern.antiPatterns.some((a) => /equal|card/i.test(a))) {
    const grows = new Set(regions.map((r) => r.grow));
    if (regions.length >= 3 && grows.size === 1) {
      applied.push(`'${pattern.name}' forbids equal-weight surfaces: focal emphasis left to the art director, flagged here so it is not lost.`);
    }
  }
  if (pattern.relationshipRules.length > 0) {
    applied.push(`Relationship rule carried into build: ${pattern.relationshipRules[0]}.`);
  }
  return applied;
}

/**
 * Derives regions from the task. Returns null when there is nothing to derive
 * from (no items, or none classifiable) so the caller falls back explicitly.
 *
 * The region *vocabulary* (nav, header, map, inspector…) is product convention
 * and intentionally stable; what is task-driven is which regions exist, what
 * each one serves, how it is justified, and what gets reused.
 */
export function deriveRegions(input: {
  decisionKind: string;
  primaryDecision: string;
  info: string[];
  existingPatterns?: string[];
  pattern?: VisualPattern | null;
  components?: ComponentKnowledge[];
}): { regions: DerivedRegion[]; derivation: Derivation } | null {
  const classified = classifyInformation(input.info);
  const known = classified.filter((i) => i.kind !== "unknown");
  if (known.length === 0) return null;

  const kinds = new Set(known.map((i) => i.kind));
  const has = (...ks: InfoKind[]): boolean => ks.some((k) => kinds.has(k));
  const components = input.components ?? [];
  const regions: DerivedRegion[] = [];
  const kind = input.decisionKind;

  if (kind === "topology") {
    regions.push({
      id: "rail", role: "status-rail", composition: "instrument", width: "fill", height: 56, grow: 0, padding: 16,
      because: `fleet summary for the relationship field (${cite(classified, ["signal", "attribute", "option"])}), read without focusing`,
      infoKinds: ["signal", "attribute"],
    });
    regions.push({
      id: "map", role: "primary-visual", composition: "topology", width: "fill", height: "fill", grow: 1, gap: 32, padding: 24,
      because: `the relationships themselves (${cite(classified, ["relationship", "option", "attribute"])}): ${cite(classified, ["relationship"])}, which are the content`,
      infoKinds: ["relationship", "option"],
    });
    // No inspector without a focus item: a topology has no single subject.
    // An option/focus item earns one; anything else would be a template reflex.
    const focus = known.find((i) => i.kind === "option" && /select|focus|detail/i.test(i.text));
    if (focus) {
      regions.push({
        id: "inspector", role: "inspector", composition: "split-view", width: 360, height: "fill", grow: 0, gap: 24,
        because: `detail for the focused subject '${focus.text}', subordinate to the field`,
        infoKinds: ["option"],
      });
    }
  } else if (kind === "select" || kind === "compare") {
    regions.push({
      id: "nav", role: "navigation", composition: "instrument", width: 240, height: "fill", grow: 0,
      because: "orientation: where am I in the product",
      infoKinds: [],
    });
    regions.push({
      id: "header", role: "header", composition: "editorial", width: "fill", height: 72, grow: 0, padding: 24,
      because: `the decision, stated: "${input.primaryDecision}"`,
      infoKinds: [],
    });
    regions.push({
      id: "content", role: "content", composition: "table", width: "fill", height: "fill", grow: 1, gap: 16, padding: 24,
      because: `the options (${cite(classified, ["option"])}) compared across ${cite(classified, ["attribute"])} — alignment does the comparing, not decoration`,
      infoKinds: ["option", "attribute"],
    });
    regions.push({
      id: "inspector", role: "inspector", composition: "split-view", width: 360, height: "fill", grow: 0, gap: 24,
      because: `detail for the currently focused option (${cite(classified, ["detail", "attribute"])})`,
      infoKinds: ["detail", "attribute"],
    });
  } else if (kind === "monitor") {
    const metricHeavy = known.filter((i) => i.kind === "signal" || i.kind === "attribute").length >= 4;
    regions.push({
      id: "rail", role: "status-rail", composition: "instrument", width: "fill", height: 64, grow: 0, padding: 16,
      because: `state at a glance (${cite(classified, ["signal"])}), read without focusing`,
      infoKinds: ["signal"],
    });
    regions.push({
      id: "primary-visual", role: "primary-visual", composition: "instrument", width: "fill", height: "fill", grow: 2, gap: 24, padding: 24,
      because: metricHeavy
        ? `one continuous signal surface for ${cite(classified, ["signal", "attribute"])} — grouped into a single instrument, never ${known.length} cards`
        : `the primary signal (${cite(classified, ["signal", "attribute"])}), given the most space`,
      infoKinds: ["signal", "attribute"],
    });
    regions.push({
      id: "detail", role: "secondary", composition: "split-view", width: "fill", height: 240, grow: 0, gap: 16, padding: 24,
      because: `the underlying data behind the signal (${cite(classified, ["event", "detail", "attribute"])})`,
      infoKinds: ["event", "detail"],
    });
  } else if (kind === "configure") {
    regions.push({
      id: "nav", role: "navigation", composition: "instrument", width: 240, height: "fill", grow: 0,
      because: "orientation",
      infoKinds: [],
    });
    regions.push({
      id: "form", role: "content", composition: "editorial", width: 480, height: "fill", grow: 0, gap: 16, padding: 24,
      because: `the controls (${cite(classified, ["setting"])}), in one column so their order reads as a sequence`,
      infoKinds: ["setting"],
    });
    regions.push({
      id: "preview", role: "primary-visual", composition: "canvas", width: "fill", height: "fill", grow: 1, gap: 24, padding: 24,
      because: "the effect of the settings, so a change is never a leap of faith",
      infoKinds: [],
    });
  } else if (kind === "integration") {
    // Provider/endpoint/profile concepts, not generic settings: a provider
    // list beside an endpoint detail pane, with connection state visible. A
    // form would hide which provider each value belongs to.
    regions.push({
      id: "nav", role: "navigation", composition: "instrument", width: 240, height: "fill", grow: 0,
      because: "orientation",
      infoKinds: [],
    });
    regions.push({
      id: "providers", role: "content", composition: "table", width: 420, height: "fill", grow: 0, gap: 12, padding: 24,
      because: `the providers (${cite(classified, ["option"])}), each showing connection state at a glance`,
      infoKinds: ["option"],
    });
    regions.push({
      id: "endpoint", role: "inspector", composition: "split-view", width: "fill", height: "fill", grow: 1, gap: 24, padding: 24,
      because: `endpoint, profile and credentials for the selected provider (${cite(classified, ["detail", "setting", "attribute"])})`,
      infoKinds: ["detail", "setting"],
    });
  } else if (kind === "explore") {
    regions.push({
      id: "nav", role: "navigation", composition: "instrument", width: 240, height: "fill", grow: 0,
      because: "orientation",
      infoKinds: [],
    });
    regions.push({
      id: "filters", role: "header", composition: "editorial", width: "fill", height: 64, grow: 0, padding: 16,
      because: `narrowing (${cite(classified, ["attribute", "option"])}) before listing`,
      infoKinds: ["attribute"],
    });
    regions.push({
      id: "results", role: "content", composition: "table", width: "fill", height: "fill", grow: 1, gap: 12, padding: 24,
      because: `the results (${cite(classified, ["option", "event", "detail"])}), dense enough to scan`,
      infoKinds: ["option", "event"],
    });
  } else {
    // inspect / author and anything else: subject first, context beside it.
    regions.push({
      id: "nav", role: "navigation", composition: "instrument", width: 208, height: "fill", grow: 0,
      because: "orientation",
      infoKinds: [],
    });
    regions.push({
      id: "subject", role: "primary-visual", composition: "canvas", width: "fill", height: "fill", grow: 2, gap: 24, padding: 32,
      because: `the thing being understood (${cite(classified, ["option", "detail", "attribute"])}), given the most room`,
      infoKinds: ["option", "detail"],
    });
    regions.push({
      id: "context", role: "inspector", composition: "split-view", width: 360, height: "fill", grow: 0, gap: 24,
      because: `surrounding state that gives the subject meaning (${cite(classified, ["signal", "event", "attribute"])})`,
      infoKinds: ["signal", "event"],
    });
  }

  const roleForReuse = (role: string): ComponentRole => {
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
  };
  for (const region of regions) {
    const reuse = resolveReuse(components, region.id, roleForReuse(region.role));
    if (reuse) region.reuse = reuse;
  }

  const appliedGuidance = applyPatternGuidance(regions, input.pattern ?? null);
  return {
    regions,
    derivation: {
      strategy: "task-derived",
      pattern: input.pattern?.id ?? null,
      infoKinds: [...kinds],
      information: classified,
      unclassified: classified.filter((i) => i.kind === "unknown").map((i) => i.text),
      appliedGuidance,
      note: `Derived from ${known.length} classified information item(s) for the '${kind}' decision; pattern '${input.pattern?.name ?? "none"}' applied as guidance, not structure.`,
    },
  };
}
