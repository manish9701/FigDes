/**
 * System 1 — Design Discovery Engine (spec §7).
 *
 * Before generating a screen, FigDes must understand the environment the design
 * will live in: current page, relevant screens, components, variables, styles,
 * fonts, assets and existing visual patterns.
 *
 * This module is the *normalization* layer, not the transport layer. The Figma
 * plugin already returns raw payloads (inspect_design_system,
 * figdes_read_context, find_component); those payloads are large, frequency-
 * ranked and shaped for transport. This module turns them into one compact,
 * bounded `DesignDiscovery` object with a purpose per field.
 *
 * Bounded by construction (§20):
 *   Phase 1 — current page + nearby frames (always).
 *   Phase 2 — semantic component/style search (on demand).
 *   Phase 3 — expand only when confidence is low (explicit).
 * The budget is carried on the result so callers can see what was spent.
 */

export interface FileContext {
  fileName: string;
  currentPage: { id: string; name: string };
  pages: Array<{ id: string; name: string; childCount: number }>;
}

export interface PageContext {
  pageId: string;
  pageName: string;
  topFrames: number;
  truncated: boolean;
}

export interface ScreenSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  childCount: number;
  page: string;
}

export interface ComponentSummary {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  instanceCount: number;
}

export interface VariableSummary {
  name: string;
  type: string;
  value?: string | number | boolean | null;
}

export interface StyleSummary {
  kind: "paint" | "text" | "effect";
  name: string;
  detail?: string;
}

export interface FontSummary {
  family: string;
  styles: string[];
  textNodes: number;
}

export interface AssetSummary {
  images: number;
  vectors: number;
  imageNames: string[];
}

export interface PatternSummary {
  signature: string;
  count: number;
}

export interface DiscoveryBudget {
  phase: 1 | 2 | 3;
  nodesScanned: number;
  truncated: boolean;
  purpose: string;
}

export interface DesignDiscovery {
  file: FileContext;
  page: PageContext;
  screens: ScreenSummary[];
  components: ComponentSummary[];
  variables: VariableSummary[];
  styles: StyleSummary[];
  fonts: FontSummary[];
  assets: AssetSummary;
  patterns: PatternSummary[];
  budget: DiscoveryBudget;
}

/** Raw shapes accepted from the plugin side. All fields optional: absence is normal. */
export interface RawDiscoveryInput {
  file?: {
    fileName?: string;
    currentPage?: { id?: string; name?: string };
    pages?: Array<{ id?: string; name?: string; childCount?: number }>;
  } | null;
  designSystem?: {
    nodesScanned?: number;
    truncated?: boolean;
    components?: Array<{ name?: string; count?: number }>;
    variables?: Array<{ name?: string; type?: string; id?: string; value?: unknown }>;
    styles?: { paint?: number; text?: number; effect?: number };
    styleNames?: { paint?: string[]; text?: string[] };
    typography?: Array<{ label?: string; count?: number }>;
    layoutPatterns?: Array<{ signature?: string; count?: number }>;
  } | null;
  context?: {
    topFrames?: Array<{ id?: string; name?: string; width?: number; height?: number; childCount?: number }>;
    framesTruncated?: boolean;
    counts?: { images?: number; vectors?: number };
  } | null;
  foundComponents?: Array<{
    component?: { id?: string; name?: string; type?: string; width?: number; height?: number; instanceCount?: number };
  }> | null;
  fonts?: Array<{ family?: string; style?: string }> | null;
}

/**
 * Assembles a compact semantic description of the design environment.
 *
 * Pure: no Figma access, no session. Every list is capped; truncation is
 * reported on `budget` rather than silently applied.
 */
export function assembleDiscovery(input: RawDiscoveryInput): DesignDiscovery {
  const file: FileContext = {
    fileName: input.file?.fileName ?? "unknown",
    currentPage: {
      id: input.file?.currentPage?.id ?? "",
      name: input.file?.currentPage?.name ?? "unknown",
    },
    pages: (input.file?.pages ?? []).slice(0, 20).map((p) => ({
      id: p.id ?? "",
      name: p.name ?? "untitled",
      childCount: p.childCount ?? 0,
    })),
  };

  const topFrames = input.context?.topFrames ?? [];
  const page: PageContext = {
    pageId: file.currentPage.id,
    pageName: file.currentPage.name,
    topFrames: topFrames.length,
    truncated: input.context?.framesTruncated ?? false,
  };

  // Screens are top-level frames: the nearby context the next screen must be
  // consistent with. Capped at 12 — relevance beats completeness.
  const screens: ScreenSummary[] = topFrames.slice(0, 12).map((f) => ({
    id: f.id ?? "",
    name: f.name ?? "untitled",
    width: Math.round(f.width ?? 0),
    height: Math.round(f.height ?? 0),
    childCount: f.childCount ?? 0,
    page: file.currentPage.name,
  }));

  const seenComponents = new Map<string, ComponentSummary>();
  for (const entry of input.designSystem?.components ?? []) {
    if (!entry.name) continue;
    seenComponents.set(entry.name, {
      id: "",
      name: entry.name,
      type: "SUMMARY",
      width: 0,
      height: 0,
      instanceCount: entry.count ?? 0,
    });
  }
  for (const match of input.foundComponents ?? []) {
    const c = match.component;
    if (!c?.name || !c.id) continue;
    seenComponents.set(c.name, {
      id: c.id,
      name: c.name,
      type: c.type ?? "COMPONENT",
      width: c.width ?? 0,
      height: c.height ?? 0,
      instanceCount: c.instanceCount ?? 0,
    });
  }
  const components = [...seenComponents.values()]
    .sort((a, b) => b.instanceCount - a.instanceCount)
    .slice(0, 40);

  const variables: VariableSummary[] = (input.designSystem?.variables ?? [])
    .slice(0, 60)
    .filter((v) => v.name)
    .map((v) => ({
      name: v.name as string,
      type: v.type ?? "unknown",
      ...(v.value !== undefined ? { value: v.value as string | number | boolean | null } : {}),
    }));

  const styles: StyleSummary[] = [
    ...(input.designSystem?.styleNames?.paint ?? []).slice(0, 20).map((n) => ({ kind: "paint" as const, name: n })),
    ...(input.designSystem?.styleNames?.text ?? []).slice(0, 20).map((n) => ({ kind: "text" as const, name: n })),
  ];

  const fonts = summarizeFonts(input.designSystem?.typography ?? [], input.fonts ?? []);

  const assets: AssetSummary = {
    images: input.context?.counts?.images ?? 0,
    vectors: input.context?.counts?.vectors ?? 0,
    imageNames: [],
  };

  const patterns: PatternSummary[] = (input.designSystem?.layoutPatterns ?? [])
    .slice(0, 12)
    .filter((p) => p.signature)
    .map((p) => ({ signature: p.signature as string, count: p.count ?? 0 }));

  const nodesScanned = input.designSystem?.nodesScanned ?? 0;
  return {
    file,
    page,
    screens,
    components,
    variables,
    styles,
    fonts,
    assets,
    patterns,
    budget: {
      phase: 1,
      nodesScanned,
      truncated: input.designSystem?.truncated ?? page.truncated,
      purpose: "current page + nearby frames. Escalate to phase 2 (semantic search) or 3 (expansion) only when confidence is low.",
    },
  };
}

function summarizeFonts(
  typography: Array<{ label?: string; count?: number }>,
  available: Array<{ family?: string; style?: string }>,
): FontSummary[] {
  const byFamily = new Map<string, { styles: Set<string>; textNodes: number }>();
  for (const t of typography) {
    // Labels look like "Inter SemiBold @16" — family is everything but the
    // trailing style token and size. "Inter" alone stays "Inter".
    const label = t.label ?? "";
    const sizeMatch = label.match(/@([\d.]+)\s*$/);
    const withoutSize = label.replace(/\s*@[\d.]+\s*$/, "").trim();
    const parts = withoutSize.split(/\s+/).filter(Boolean);
    const style = parts.length > 1 ? parts[parts.length - 1]! : "Regular";
    const family = parts.length > 1 ? parts.slice(0, -1).join(" ") : withoutSize || "unknown";
    const entry = byFamily.get(family) ?? { styles: new Set<string>(), textNodes: 0 };
    if (style && style !== family) entry.styles.add(style);
    entry.textNodes += t.count ?? 0;
    byFamily.set(family, entry);
  }
  for (const f of available) {
    if (!f.family) continue;
    const entry = byFamily.get(f.family) ?? { styles: new Set<string>(), textNodes: 0 };
    if (f.style) entry.styles.add(f.style);
    byFamily.set(f.family, entry);
  }
  return [...byFamily.entries()]
    .map(([family, v]) => ({ family, styles: [...v.styles].slice(0, 12), textNodes: v.textNodes }))
    .sort((a, b) => b.textNodes - a.textNodes)
    .slice(0, 10);
}

/**
 * One-paragraph brief of the environment, for prompts and reports.
 * Compact by design: a screen plan needs the shape of the file, not its census.
 */
export function discoveryBrief(d: DesignDiscovery): string {
  const parts = [
    `${d.screens.length} nearby screen(s) on '${d.page.pageName}'`,
    `${d.components.length} known component(s)`,
    `${d.variables.length} variable(s)`,
    `${d.fonts.length > 0 ? d.fonts.map((f) => f.family).slice(0, 3).join(", ") : "no fonts observed"}`,
  ];
  return `Design environment (${d.file.fileName}): ${parts.join("; ")}.` + (d.budget.truncated ? " Discovery truncated: expand only if confidence is low." : "");
}

/** Phase escalation: every expansion must state its purpose (§20). */
export function nextDiscoveryPhase(current: DiscoveryBudget, purpose: string): DiscoveryBudget {
  const phase = current.phase >= 3 ? 3 : ((current.phase + 1) as 1 | 2 | 3);
  return { ...current, phase, purpose };
}
