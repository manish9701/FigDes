/**
 * Template-collapse detection (blueprint §4.5).
 *
 * Section 1's first non-negotiable is "design the task, not the template", and
 * §4.5 asks for composition-level similarity tracking to enforce it. Nothing
 * in the repository measured this, so a planner could emit the same
 * navigation-rail + header + panel grammar for every task and no check would
 * notice.
 *
 * Two things make this usable rather than pedantic:
 *
 * 1. **Features are structural, not cosmetic.** Region bounds, column counts,
 *    the dominant region, where text/data/actions sit, the interaction model
 *    and the topology kind. Colour and radius are deliberately not features.
 * 2. **The shell is separated from the task region.** A product is allowed to
 *    reuse its own navigation shell. Punishing that would push toward
 *    sameness *between* screens that share a shell but differ in what the
 *    screen is for. So each signature carries a shell part and a task part, and
 *    collapse is judged on the task part.
 */
import { hashContent } from "../quality/revision";

export type InteractionModel =
  | "canvas"
  | "table"
  | "graph"
  | "editor"
  | "inspector"
  | "timeline"
  | "form"
  | "feed"
  | "command-surface"
  | "document"
  | "mixed";

export type TopologyKind = "graph" | "table" | "chart" | "list" | "form" | "document" | "none";

export type NavigationPattern = "rail" | "sidebar" | "topbar" | "tabs" | "none";

/** Regions belonging to the product's global shell (safe to reuse). */
export const SHELL_ROLES: readonly string[] = ["navigation", "header", "footer", "toolbar", "breadcrumb"];

export interface RegionBox {
  id: string;
  role: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Content mix of this region. */
  textNodes?: number;
  dataNodes?: number;
  actionNodes?: number;
}

export interface CompositionSignature {
  screenId: string;
  /** 0–1 similarity key of the global shell only. */
  shellKey: string;
  /** 0–1 similarity key of the task-specific main region. */
  taskKey: string;
  /** Bins of relative region bounds, quantised so small drift is not a difference. */
  relativeBounds: string[];
  columnCount: number;
  dominantRegionId: string | null;
  dominantShare: number;
  navigation: NavigationPattern;
  interactionModel: InteractionModel;
  topology: TopologyKind;
  /** Share of the frame given to canvas / table / inspector roles. */
  canvasShare: number;
  tableShare: number;
  inspectorShare: number;
  /** Where text, data and actions cluster, as fractions of frame area. */
  textShare: number;
  dataShare: number;
  actionShare: number;
}

export interface SignatureInput {
  screenId: string;
  frame: { width: number; height: number };
  regions: RegionBox[];
  navigation?: NavigationPattern;
  interactionModel?: InteractionModel;
  topology?: TopologyKind;
  /** Number of distinct column bands in the task region. */
  columnCount?: number;
}

function q(value: number, bins = 6): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(bins, Math.round(value * bins)));
}

function regionArea(r: RegionBox): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

function inferNavigation(regions: RegionBox[]): NavigationPattern {
  const roles = new Set(regions.map((r) => r.role));
  if (roles.has("rail") || roles.has("nav-rail")) return "rail";
  if (roles.has("sidebar") || roles.has("navigation") && regions.some((r) => r.role === "navigation" && r.width < 260 && r.height > regions[0]!.height * 0.7)) return "sidebar";
  if (roles.has("header") || roles.has("topbar") || roles.has("toolbar")) return "topbar";
  return "none";
}

function inferTopology(regions: RegionBox[], interaction: InteractionModel): TopologyKind {
  const roleText = regions.map((r) => `${r.role} ${r.id}`).join(" ").toLowerCase();
  if (/graph|topology|node|canvas|device/.test(roleText)) return "graph";
  if (/table|grid|row|column/.test(roleText)) return "table";
  if (/chart|series|plot|sparkline|histogram/.test(roleText)) return "chart";
  if (/list|feed|queue|inbox/.test(roleText)) return "list";
  if (/form|field|input|config/.test(roleText)) return "form";
  if (/doc|article|editor|prose/.test(roleText)) return "document";
  if (interaction === "canvas" || interaction === "graph") return "graph";
  if (interaction === "table") return "table";
  if (interaction === "editor" || interaction === "document") return "document";
  return "none";
}

function inferInteraction(regions: RegionBox[], explicit?: InteractionModel): InteractionModel {
  if (explicit) return explicit;
  const roleText = regions.map((r) => `${r.role} ${r.id}`).join(" ").toLowerCase();
  if (/graph|topology/.test(roleText)) return "graph";
  if (/canvas|board|surface/.test(roleText)) return "canvas";
  if (/table|grid/.test(roleText)) return "table";
  if (/timeline|event/.test(roleText)) return "timeline";
  if (/inspector|details|properties/.test(roleText)) return "inspector";
  if (/editor|document|prose/.test(roleText)) return "editor";
  if (/form|field|config/.test(roleText)) return "form";
  if (/feed|queue|inbox/.test(roleText)) return "feed";
  if (/palette|command/.test(roleText)) return "command-surface";
  return "mixed";
}

/** Builds the structural signature of one screen. */
export function compositionSignature(input: SignatureInput): CompositionSignature {
  const frameArea = Math.max(1, input.frame.width * input.frame.height);
  const shell = input.regions.filter((r) => SHELL_ROLES.includes(r.role));
  const task = input.regions.filter((r) => !SHELL_ROLES.includes(r.role));

  const dominant = task.reduce<RegionBox | null>((best, r) => (best === null || regionArea(r) > regionArea(best) ? r : best), null);
  const dominantShare = dominant ? regionArea(dominant) / frameArea : 0;

  const share = (match: RegExp): number =>
    task.filter((r) => match.test(`${r.role} ${r.id}`.toLowerCase())).reduce((sum, r) => sum + regionArea(r), 0) / frameArea;

  const totals = input.regions.reduce(
    (acc, r) => ({ text: acc.text + (r.textNodes ?? 0), data: acc.data + (r.dataNodes ?? 0), action: acc.action + (r.actionNodes ?? 0) }),
    { text: 0, data: 0, action: 0 },
  );
  const nodeSum = Math.max(1, totals.text + totals.data + totals.action);

  const relativeBounds = input.regions.map((r) => `${r.role}:${q(r.width / Math.max(1, input.frame.width))}/${q(r.height / Math.max(1, input.frame.height))}/${q(r.x / Math.max(1, input.frame.width))}/${q(r.y / Math.max(1, input.frame.height))}`);

  const interactionModel = inferInteraction(input.regions, input.interactionModel);
  const columnCount = input.columnCount ?? inferColumns(task, input.frame);

  const shellKey = hashContent(shell.map((r) => `${r.role}:${q(r.width / Math.max(1, input.frame.width))}/${q(r.height / Math.max(1, input.frame.height))}`).join("|"));
  const taskKey = hashContent(
    [
      ...task.map((r) => `${r.role}:${q(r.width / Math.max(1, input.frame.width))}/${q(r.height / Math.max(1, input.frame.height))}`),
      `cols=${columnCount}`,
      `dom=${dominant?.role ?? "none"}`,
      `interaction=${interactionModel}`,
      `topology=${inferTopology(input.regions, interactionModel)}`,
    ].join("|"),
  );

  return {
    screenId: input.screenId,
    shellKey,
    taskKey,
    relativeBounds,
    columnCount,
    dominantRegionId: dominant?.id ?? null,
    dominantShare: Math.round(dominantShare * 100) / 100,
    navigation: input.navigation ?? inferNavigation(input.regions),
    interactionModel,
    topology: inferTopology(input.regions, interactionModel),
    canvasShare: Math.round(share(/canvas|graph|topology|node|device|board|surface/) * 100) / 100,
    tableShare: Math.round(share(/table|grid|row|column|list/) * 100) / 100,
    inspectorShare: Math.round(share(/inspector|details|properties|sidebar/) * 100) / 100,
    textShare: Math.round((totals.text / nodeSum) * 100) / 100,
    dataShare: Math.round((totals.data / nodeSum) * 100) / 100,
    actionShare: Math.round((totals.action / nodeSum) * 100) / 100,
  };
}

function inferColumns(task: RegionBox[], frame: { width: number; height: number }): number {
  const wide = task.filter((r) => r.height < frame.height * 0.7 && r.width > frame.width * 0.12).length;
  return Math.max(1, Math.min(6, wide || 1));
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                   */
/* -------------------------------------------------------------------------- */

export interface SignatureComparison {
  similarity: number;
  shellIdentical: boolean;
  taskIdentical: boolean;
  differingFeatures: string[];
}

/** Weighted structural similarity. Task features dominate, deliberately. */
export function compareSignatures(a: CompositionSignature, b: CompositionSignature): SignatureComparison {
  const differing: string[] = [];
  let score = 0;
  let weight = 0;

  const add = (name: string, equal: boolean, w: number, tolerance = 0): void => {
    weight += w;
    if (equal) score += w;
    else if (tolerance > 0 && w * (1 - tolerance) > 0) {
      score += w * (1 - tolerance);
      // Tolerant differences are noted but do not fully count as equal.
    }
    if (!equal) differing.push(name);
  };

  if (a.taskKey === b.taskKey) {
    add("task-structure", true, 40);
  } else {
    const shared = a.relativeBounds.filter((x) => b.relativeBounds.includes(x)).length;
    const overlap = a.relativeBounds.length + b.relativeBounds.length === 0 ? 1 : (2 * shared) / (a.relativeBounds.length + b.relativeBounds.length);
    add("region-bounds", overlap > 0.85, 40);
  }
  add("column-count", a.columnCount === b.columnCount, 10);
  add("dominant-region", a.dominantRegionId === b.dominantRegionId, 10);
  add("interaction-model", a.interactionModel === b.interactionModel, 12);
  add("topology", a.topology === b.topology, 12);
  add("navigation", a.navigation === b.navigation, 6);
  add("content-mix", Math.abs(a.textShare - b.textShare) < 0.12 && Math.abs(a.dataShare - b.dataShare) < 0.12, 6);
  add("canvas/table/inspector-areas", Math.abs(a.canvasShare - b.canvasShare) < 0.1 && Math.abs(a.tableShare - b.tableShare) < 0.1, 4);

  return {
    similarity: weight === 0 ? 0 : Math.round((score / weight) * 1000) / 1000,
    shellIdentical: a.shellKey === b.shellKey,
    taskIdentical: a.taskKey === b.taskKey,
    differingFeatures: differing,
  };
}

/* -------------------------------------------------------------------------- */
/* Collapse detection                                                           */
/* -------------------------------------------------------------------------- */

/** Similarity at or above this on the task region triggers a composition review. */
export const TEMPLATE_COLLAPSE_THRESHOLD = 0.82;

export interface TemplateCollapsePair {
  a: string;
  b: string;
  similarity: number;
  differingFeatures: string[];
  /** True when the two screens genuinely share one product shell. */
  sharedShell: boolean;
  verdict: string;
}

export interface TemplateCollapseReport {
  collapsed: boolean;
  pairs: TemplateCollapsePair[];
  /** Screens that share a shell but differ in their task region — expected, not a defect. */
  sharedShellClusters: string[][];
  /** Explicit instruction, or null when there is nothing to do. */
  action: string | null;
  summary: string;
}

export interface ScreenUnderReview {
  screenId: string;
  /** What this screen is for. Screens with different goals should differ. */
  taskKey: string;
  signature: CompositionSignature;
}

/**
 * §4.5: if two screens serving different tasks have near-identical structure,
 * trigger a composition review. Screens serving the *same* task are allowed
 * to match — that is consistency, not collapse.
 */
export function detectTemplateCollapse(
  screens: readonly ScreenUnderReview[],
  threshold = TEMPLATE_COLLAPSE_THRESHOLD,
): TemplateCollapseReport {
  const pairs: TemplateCollapsePair[] = [];
  for (let i = 0; i < screens.length; i++) {
    for (let j = i + 1; j < screens.length; j++) {
      const a = screens[i]!;
      const b = screens[j]!;
      const comparison = compareSignatures(a.signature, b.signature);
      if (a.taskKey === b.taskKey) continue;
      if (comparison.similarity < threshold) continue;
      pairs.push({
        a: a.screenId,
        b: b.screenId,
        similarity: comparison.similarity,
        differingFeatures: comparison.differingFeatures,
        sharedShell: comparison.shellIdentical,
        verdict:
          comparison.taskIdentical
            ? `Identical task-region structure for different tasks ("${a.taskKey}" vs "${b.taskKey}").`
            : `Near-identical task-region structure (${comparison.similarity}) for different tasks; only ${comparison.differingFeatures.join(", ") || "nothing"} differ.`,
      });
    }
  }

  // Cluster screens by shell purely to report shared shells, not to judge them.
  const byShell = new Map<string, string[]>();
  for (const screen of screens) {
    const key = screen.signature.shellKey;
    byShell.set(key, [...(byShell.get(key) ?? []), screen.screenId]);
  }
  const sharedShellClusters = [...byShell.values()].filter((ids) => ids.length > 1);

  const action =
    pairs.length === 0
      ? null
      : `Review composition for ${pairs.map((p) => `${p.a} vs ${p.b}`).join("; ")}. Regenerate at least one genuinely different layout grammar for its task; do not restyle the existing one.`;

  return {
    collapsed: pairs.length > 0,
    pairs,
    sharedShellClusters,
    action,
    summary:
      pairs.length === 0
        ? `No template collapse across ${screens.length} screen(s). ${sharedShellClusters.length} shared product shell(s) — allowed, since the task regions differ.`
        : `${pairs.length} pair(s) of screens serving different tasks share near-identical structure (threshold ${threshold}).`,
  };
}
