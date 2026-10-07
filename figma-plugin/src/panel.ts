/**
 * Panel summary.
 *
 * Everything the plugin panel shows is computed here from the Figma API
 * directly, with no round trip to the Design Agent server. That is deliberate:
 * the panel must stay useful while the server is down, and a glanceable health
 * check has no business depending on a network call.
 *
 * The contrast figures come from `shared/contrast.ts`, the same module the
 * server-side critic uses, so the panel cannot disagree with the reviewer about
 * whether a colour pair passes.
 */
import { evaluateTextContrast, isBoldStyle } from "../../shared/contrast";
import { effectiveFill, isDefaultName, primaryFill } from "./resolve";
import { allPages } from "./cache";
import { DEFAULT_EXTRACT, extractDesignSystem } from "./design-system";
import { PLUGIN_VERSION, type PanelSummary } from "../../shared/protocol";

/** Reported through the main thread's log channel. */
function log(level: "info" | "warn" | "error", message: string): void {
  figma.ui.postMessage({ kind: "log", level, message });
}

/** Bounds chosen so the panel stays responsive on a large file. */
const PANEL_SCAN_NODES = 1200;
const PANEL_CONTRAST_NODES = 300;
const PANEL_CONTRAST_FINDINGS = 5;
const PANEL_SWATCHES = 14;
const PANEL_TYPE_STEPS = 6;

export async function buildPanelSummary(): Promise<PanelSummary> {
  const page = figma.currentPage;
  const selection = page.selection;

  // Selection first: it is what the user is looking at right now, and it must
  // render even if the broader scan is slow.
  const selectionRows = selection.slice(0, 8).map((n) => ({
    id: n.id,
    type: n.type,
    name: n.name,
    width: Math.round(n.width),
    height: Math.round(n.height),
    childCount: "children" in n ? n.children.length : 0,
  }));

  const { contrast, checked, unmeasurable } = await contrastForSelection();

  let system: PanelSummary["system"] = {
    colors: [],
    colorCount: 0,
    spacingBase: 0,
    typeRamp: [],
    componentCount: 0,
    variableCount: 0,
    defaultNamed: 0,
  };
  let pageCount = 1;
  let truncated = false;

  try {
    pageCount = (await allPages()).length;
  } catch {
    /* keep the default */
  }

  try {
    const ds = await extractDesignSystem({
      ...DEFAULT_EXTRACT,
      maxNodes: PANEL_SCAN_NODES,
      includeVariables: true,
      includeStyles: false,
    });

    system = {
      colors: ds.colors.slice(0, PANEL_SWATCHES).map((c) => c.hex),
      colorCount: ds.colorsTotal,
      spacingBase: ds.spacing.inferredBase,
      // Just the size, so the panel reads "10, 11, 12, 13" rather than
      // repeating "Inter Regular" on every row.
      typeRamp: ds.typography
        .slice(0, PANEL_TYPE_STEPS)
        .map((t) => (t.label.match(/@([\d.]+)/)?.[1] ?? "?").replace(/\.0$/, ""))
        .filter((v, i, a) => a.indexOf(v) === i),
      componentCount: ds.components.length,
      variableCount: ds.variables.length,
      defaultNamed: ds.naming.defaultNamed,
    };
    truncated = ds.truncated;
  } catch (err) {
    // A failed system scan must not blank the panel; the selection readout is
    // the part the user actually needs.
    log("warn", `Panel system scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    fileName: figma.root.name,
    pageName: page.name,
    pageCount,
    pluginVersion: PLUGIN_VERSION,
    selection: selectionRows,
    selectionCount: selection.length,
    system,
    contrast,
    contrastChecked: checked,
    contrastUnmeasurable: unmeasurable,
    truncated,
  };
}

/* -------------------------------------------------------------------------- */
/* Contrast within the selection                                               */
/* -------------------------------------------------------------------------- */

async function contrastForSelection(): Promise<{
  contrast: PanelSummary["contrast"];
  checked: number;
  unmeasurable: number;
}> {
  const roots = figma.currentPage.selection;
  if (roots.length === 0) return { contrast: [], checked: 0, unmeasurable: 0 };

  const findings: PanelSummary["contrast"] = [];
  let checked = 0;
  let unmeasurable = 0;
  let budget = PANEL_CONTRAST_NODES;

  const stack: BaseNode[] = [...roots].reverse();

  while (stack.length > 0 && budget > 0 && findings.length < PANEL_CONTRAST_FINDINGS) {
    const node = stack.pop()!;
    budget -= 1;

    if (node.type === "TEXT") {
      const verdict = contrastOf(node as TextNode);
      if ("unmeasurable" in verdict) {
        unmeasurable += 1;
      } else {
        checked += 1;
        if (!verdict.passes) {
          findings.push({
            nodeId: node.id,
            nodeName: node.name,
            ratio: verdict.ratio,
            required: verdict.required,
          });
        }
      }
    }

    if ("children" in node && node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!);
    }
  }

  return { contrast: findings, checked, unmeasurable };
}

/**
 * Contrast for one text node.
 *
 * skipSelf matters: a text node's own fill is its text colour, so folding that
 * into the background would make every ratio exactly 1:1.
 */
function contrastOf(node: TextNode) {
  const color = primaryFill(node)?.hex ?? null;
  const background = effectiveFill(node, { skipSelf: true })?.hex ?? null;

  return evaluateTextContrast({
    color,
    background,
    fontSize: typeof node.fontSize === "number" ? node.fontSize : null,
    bold: isBoldStyle(typeof node.fontName === "object" ? node.fontName.style : null),
  });
}

/* -------------------------------------------------------------------------- */
/* Selection helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Selects a node and scrolls the viewport to it.
 *
 * Used when a contrast finding is clicked in the panel: the user should land on
 * the offending layer rather than hunting for it in a large file.
 */
export async function focusNode(nodeId: string): Promise<boolean> {
  const node = await figma.getNodeByIdAsync(nodeId).catch(() => null);
  if (!node || node.removed) return false;

  // getNodeByIdAsync can return a PageNode for a page id, which cannot be
  // selected or scrolled to.
  if (node.type === "PAGE" || node.type === "DOCUMENT") return false;

  const scene = node as SceneNode;
  figma.currentPage.selection = [scene];

  // scrollAndZoomIntoView is the only viewport API that both frames the node and
  // is present on the documented ViewportAPI surface.
  try {
    figma.viewport.scrollAndZoomIntoView([scene]);
  } catch {
    // Selection alone is still useful if the viewport call is unavailable.
  }
  return true;
}

/** Exposed for tests. */
export function isDefaultNamedNode(name: string): boolean {
  return isDefaultName(name);
}