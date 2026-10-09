/**
 * The read/context layer (spec §18, §19, §20, §21).
 *
 * The agent cannot reuse a design system it cannot see, and it cannot modify a
 * file safely without knowing what is already in it. These actions answer, in
 * one bounded round trip each:
 *
 *   getFileInfo            — robust file metadata (pages, counts, libraries)
 *   getDesignContext       — file metadata + top frames + design-system summary
 *   listLibraryCollections — enabled team-library variable collections
 *   getProperties          — full state of one node
 *
 * They are read-only, so they never open a transaction and never mutate.
 */
import { allPages } from "../cache";
import { extractDesignSystem, DEFAULT_EXTRACT } from "../design-system";
import { inspectTopLevelFrames } from "../inspector";
import { resolve, serialize } from "./utils";
import type { DesignSystemReport } from "../../../shared/protocol";

interface LibraryCollection {
  key?: string;
  name?: string;
  libraryName?: string;
}

/** Enabled team-library variable collections, with a best-effort variable count. */
async function libraryCollections(): Promise<Array<Record<string, unknown>>> {
  const team = (figma as unknown as {
    teamLibrary?: {
      getAvailableLibraryVariableCollectionsAsync?: () => Promise<LibraryCollection[]>;
      getVariablesInLibraryCollectionAsync?: (key: string) => Promise<unknown[]>;
    };
  }).teamLibrary;

  if (!team?.getAvailableLibraryVariableCollectionsAsync) return [];

  try {
    const collections = await team.getAvailableLibraryVariableCollectionsAsync();
    const out: Array<Record<string, unknown>> = [];
    for (const c of collections.slice(0, 40)) {
      let variableCount: number | undefined;
      if (c.key && team.getVariablesInLibraryCollectionAsync) {
        variableCount = await team
          .getVariablesInLibraryCollectionAsync(c.key)
          .then((v) => v.length)
          .catch(() => undefined);
      }
      out.push({ key: c.key, name: c.name, library: c.libraryName, variableCount });
    }
    return out;
  } catch {
    // Team library access can be unavailable (no library, offline). Empty is
    // honest; a thrown error here would fail a read that is otherwise useful.
    return [];
  }
}

/** Counts of the things a designer asks about first. */
async function localCounts(page: PageNode): Promise<Record<string, number>> {
  const counts: Record<string, number> = {
    frames: 0,
    components: 0,
    componentSets: 0,
    instances: 0,
    groups: 0,
    texts: 0,
    vectors: 0,
    images: 0,
  };
  for (const node of page.findAll(() => true)) {
    switch (node.type) {
      case "FRAME":
        counts.frames! += 1;
        break;
      case "COMPONENT":
        counts.components! += 1;
        break;
      case "COMPONENT_SET":
        counts.componentSets! += 1;
        break;
      case "INSTANCE":
        counts.instances! += 1;
        break;
      case "GROUP":
        counts.groups! += 1;
        break;
      case "TEXT":
        counts.texts! += 1;
        break;
      case "VECTOR":
        counts.vectors! += 1;
        break;
      default:
        break;
    }
    // IMAGE fills are assets worth reusing: count them while walking anyway.
    try {
      const fills = (node as unknown as { fills?: unknown }).fills;
      if (Array.isArray(fills) && fills.some((f) => (f as { type?: string }).type === "IMAGE")) {
        counts.images! += 1;
      }
    } catch {
      /* best-effort */
    }
  }
  const [variables, paintStyles, textStyles, effectStyles] = await Promise.all([
    figma.variables.getLocalVariablesAsync().then((v) => v.length).catch(() => 0),
    figma.getLocalPaintStylesAsync().then((s) => s.length).catch(() => 0),
    figma.getLocalTextStylesAsync().then((s) => s.length).catch(() => 0),
    figma.getLocalEffectStylesAsync().then((s) => s.length).catch(() => 0),
  ]);
  counts.variables = variables;
  counts.paintStyles = paintStyles;
  counts.textStyles = textStyles;
  counts.effectStyles = effectStyles;
  return counts;
}

export async function handleContext(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "getFileInfo": {
      const page = figma.currentPage;
      return {
        fileName: figma.root.name,
        editorType: figma.editorType,
        currentPage: { id: page.id, name: page.name },
        pages: figma.root.children.map((p) => ({ id: p.id, name: p.name, childCount: p.children.length })),
        selectionCount: page.selection.length,
        selection: page.selection.map((n) => ({ id: n.id, type: n.type, name: n.name })),
        counts: await localCounts(page),
        // Bounded screen list: the nearby context a new screen must be
        // consistent with (§7 phase 1). Full census lives in design-system.
        screens: page.children
          .filter((c) => c.type === "FRAME" || c.type === "COMPONENT" || c.type === "COMPONENT_SET" || c.type === "INSTANCE")
          .slice(0, 24)
          .map((c) => ({
            id: c.id,
            name: c.name,
            width: Math.round((c as SceneNode & { width: number }).width ?? 0),
            height: Math.round((c as SceneNode & { width: number; height: number }).height ?? 0),
            childCount: "children" in c ? (c.children as unknown[]).length : 0,
            page: page.name,
          })),
        libraryCollections: await libraryCollections(),
      };
    }

    case "getDesignContext": {
      const page = figma.currentPage;
      const maxNodes = typeof params.maxNodes === "number" ? params.maxNodes : DEFAULT_EXTRACT.maxNodes;
      const depth = typeof params.depth === "number" ? params.depth : 2;

      const [counts, libraries, report] = await Promise.all([
        localCounts(page),
        libraryCollections(),
        extractDesignSystem({ ...DEFAULT_EXTRACT, scope: "page", maxNodes, includeVariables: true, includeStyles: true }),
      ]);

      const frames = inspectTopLevelFrames(page, { depth, includeText: true, budget: 300 });

      return {
        fileName: figma.root.name,
        editorType: figma.editorType,
        currentPage: { id: page.id, name: page.name },
        pages: figma.root.children.map((p) => ({ id: p.id, name: p.name, childCount: p.children.length })),
        counts,
        libraryCollections: libraries,
        topFrames: frames.topLevelFrames,
        framesTruncated: frames.truncated,
        designSystem: summarizeDesignSystem(report),
        note: "This is a bounded summary. Call inspect_design_system for the full frequency-ranked report.",
      };
    }

    case "listLibraryCollections":
      return { libraryCollections: await libraryCollections() };

    case "getProperties": {
      if (!target) throw new Error("getProperties needs a target node id.");
      const node = await resolve(target);
      return serialize(node);
    }
  }
  return null;
}

/**
 * A compact design-system view for the context call.
 *
 * The full report is frequency-ranked and long; the context call keeps the top
 * entries so it stays cheap, and points at inspect_design_system for the rest.
 */
function summarizeDesignSystem(report: DesignSystemReport): Record<string, unknown> {
  return {
    nodesScanned: report.nodesScanned,
    truncated: report.truncated,
    colors: report.colors.slice(0, 8),
    colorsTotal: report.colorsTotal,
    typography: report.typography.slice(0, 8),
    radii: report.radii.slice(0, 6),
    spacing: report.spacing,
    styles: report.styles,
    styleNames: report.styleNames,
    styleDetails: report.styleDetails ?? { text: [] },
    components: report.components.slice(0, 12),
    variables: report.variables.slice(0, 20),
    variableValues: Object.fromEntries(Object.entries(report.variableValues ?? {}).slice(0, 40)),
    fonts: report.fonts ?? [],
    screens: report.screens ?? [],
    assets: report.assets ?? { images: 0, vectors: 0, imageNames: [] },
    patterns: report.patterns ?? [],
    naming: report.naming,
    health: report.health,
  };
}
