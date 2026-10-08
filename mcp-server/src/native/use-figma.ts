/**
 * `figdes_use_figma` — controlled native execution (spec §4, §17, §18, §36, §37).
 *
 * The VM sandbox stays, but three things are now enforced that were not:
 *
 * 1. A **hard wall-clock timeout that covers async work**. `vm`'s own timeout
 *    only stops synchronous execution, so a script that awaits RPCs could run
 *    forever. The script now races a wall-clock timer, and every RPC is capped
 *    to the remaining budget.
 *
 * 2. A **per-session lock**, so two native scripts can never interleave their
 *    transactions on the same document (see lock.ts).
 *
 * 3. An **explicit transaction id** carried on every call. After a timeout the
 *    transaction is rolled back and closed; a late in-flight RPC from the
 *    aborted script is then rejected by the plugin instead of mutating a
 *    document that was just restored.
 *
 * Failures return a structured, classified error with a recovery step, never a
 * bare string.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { type Session } from "../sessions";
import { withSessionLock } from "./lock";

const MAX_SCRIPT_SIZE = 120_000;
const MAX_RPC_CALLS = 1_000;
/** Hard wall-clock budget for the whole script, including awaited RPCs. */
const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
/** Per-RPC cap; never longer than what remains of the script budget. */
const RPC_TIMEOUT_MS = 20_000;

/**
 * The script budget. Overridable so tests can prove the timeout path without
 * waiting thirty seconds; production always uses the default.
 */
function scriptTimeoutMs(): number {
  const raw = Number(process.env.DESIGN_AGENT_NATIVE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SCRIPT_TIMEOUT_MS;
}

/** The RPC budget, also overridable for tests. */
function maxRpcCalls(): number {
  const raw = Number(process.env.DESIGN_AGENT_NATIVE_MAX_RPC);
  return Number.isFinite(raw) && raw > 0 ? raw : MAX_RPC_CALLS;
}

export const UseFigmaArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    script: z
      .string()
      .max(MAX_SCRIPT_SIZE)
      .describe(
        "Controlled JavaScript executed against the FigDes native Figma API. Only the exposed fig API, Math, JSON, Date and console are available. All fig.* calls are async and must be awaited. Prefer fig.batch([...]) with $refs over N sequential awaits: one round-trip instead of N. Keep construction scripts render-free and run render/visual review only at checkpoints.",
      ),
    /**
     * Read-only inspection scripts skip the session lock and the native
     * transaction entirely, so they run concurrently with nothing to roll
     * back. The plugin refuses any mutating action in a readonly script rather
     * than landing it unprotected.
     */
    readonly: z.boolean().optional().describe("Inspection only: skip the lock and transaction so reads run concurrently. Mutations are refused."),
  })
  .strict();

export const InspectVisualArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    target: z.string().max(200).optional().describe("Figma node id to inspect visually. Omit to use a single selected scene node."),
  })
  .strict();

/**
 * The read/context layer (spec §18–§21).
 *
 * One tool, several scopes, so the agent can understand an existing file before
 * touching it: file metadata, a bounded design context, library collections,
 * local components, or one node's full state.
 */
export const ReadContextArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    scope: z
      .enum(["file", "design-system", "libraries", "components", "node"])
      .default("file")
      .describe("What to read: file metadata, design context, library collections, local components, or one node."),
    target: z.string().max(200).optional().describe("Node id. Required for scope 'node'."),
    maxNodes: z.number().int().min(50).max(6000).optional().describe("Scan budget for scope 'design-system'. Defaults to a lightweight 800; escalate only when the summary shows truncation."),
    depth: z.number().int().min(1).max(6).optional().describe("Frame depth for scope 'design-system'. Defaults to 2; deeper scans cost time."),
  })
  .strict();

const CONTEXT_SCOPE_ACTION: Record<string, string> = {
  file: "getFileInfo",
  "design-system": "getDesignContext",
  libraries: "listLibraryCollections",
  components: "listComponents",
  node: "getProperties",
};

export async function figdesReadContextHandler(session: Session, args: unknown): Promise<unknown> {
  const parsed = ReadContextArgs.parse(args ?? {});
  if (parsed.scope === "node" && !parsed.target) {
    throw new Error("figdes_read_context(scope:'node') needs a target node id.");
  }
  const action = CONTEXT_SCOPE_ACTION[parsed.scope]!;
  // Lightweight summaries by default: a bounded design-system snapshot first,
  // the full scan only when the caller names a bigger budget. Deep scans on
  // every pass are what make the agent feel slow before it draws anything.
  const data = await session.request("native_design", {
    action,
    ...(parsed.target !== undefined ? { target: parsed.target } : {}),
    ...(parsed.maxNodes !== undefined ? { maxNodes: parsed.maxNodes } : parsed.scope === "design-system" ? { maxNodes: 800 } : {}),
    ...(parsed.depth !== undefined ? { depth: parsed.depth } : parsed.scope === "design-system" ? { depth: 2 } : {}),
  });
  return { status: "ok", scope: parsed.scope, data };
}

/* -------------------------------------------------------------------------- */
/* Native script execution                                                     */
/* -------------------------------------------------------------------------- */

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type FigmaScriptResult = Record<string, unknown>;

/** Execute model-authored JavaScript against the real Figma Plugin API in the plugin main thread. */
async function runNativeScript(session: Session, script: string, opts: { readonly?: boolean } = {}): Promise<FigmaScriptResult> {
  const readonlyMode = opts.readonly === true;
  const transactionId = `ntx_${randomUUID()}`;
  const startedAt = Date.now();
  const budgetMs = scriptTimeoutMs();
  try {
    const result = await session.request("execute_figma_script", { script, transactionId, readonly: readonlyMode }, budgetMs);
    if (result && typeof result === "object") return { ...(result as Record<string, unknown>), transactionId, durationMs: Date.now() - startedAt };
    return { status: "success", transactionId, result, durationMs: Date.now() - startedAt };
  } catch (err) {
    return { status: "failed", transactionId, durationMs: Date.now() - startedAt, error: { code: "FIGMA_SCRIPT_ERROR", message: message(err), recovery: "Inspect the Figma error, fix the script, and retry. Do not repeat the unchanged script." } };
  }
}

export async function figdesUseFigmaHandler(session: Session, args: unknown): Promise<unknown> {
  const parsed = UseFigmaArgs.parse(args ?? {});
  if (parsed.readonly === true) {
    // Inspection runs free: no lock, no transaction, nothing to roll back.
    return runNativeScript(session, parsed.script, { readonly: true });
  }
  // Serialized per session: two mutating scripts must never interleave transactions.
  return withSessionLock(session.id, () => runNativeScript(session, parsed.script));
}

/* -------------------------------------------------------------------------- */
/* Visual inspection                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The subset of `NodeMetrics` this inspector reads.
 *
 * Mirrors the real plugin payload (fill is a hex string, text carries its own
 * object); an earlier version read `scan` and `style.fontSize`, neither of which
 * exists on the payload, so the focal and text analysis was silently empty.
 */
interface MetricsNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  background?: string;
  radius?: number;
  text?: {
    content?: string;
    size?: number | null;
    family?: string | null;
    style?: string | null;
    color?: string | null;
  };
}

export async function figdesInspectVisualHandler(session: Session, args: unknown): Promise<unknown> {
  const parsed = InspectVisualArgs.parse(args ?? {});

  // Resolve a render target: explicit, else a single selected scene node.
  let renderTarget = parsed.target;
  if (!renderTarget) {
    const selection = (await session.request("inspect_selection", { depth: 1, budget: 20 })) as {
      selection?: Array<{ id?: string }>;
    };
    const selected = selection?.selection ?? [];
    if (selected.length === 1 && selected[0]?.id) renderTarget = selected[0].id;
  }

  const render = async (nodeId: string): Promise<{ ok: boolean; image?: { data: string; mimeType: string }; error?: string; width?: number; height?: number; estimatedTokens?: number }> => {
    try {
      const res = (await session.request("render_node", { nodeId, maxWidth: 1024, detail: "low" })) as {
        data?: string;
        width?: number;
        height?: number;
        estimatedTokens?: number;
      };
      if (!res?.data) return { ok: false, error: "Render returned no image data." };
      return { ok: true, image: { data: res.data, mimeType: "image/png" }, width: res.width, height: res.height, estimatedTokens: res.estimatedTokens };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  };

  let metrics: { nodes?: MetricsNode[]; nodeCount?: number; truncated?: boolean; error?: string } | null = null;
  try {
    metrics = (await session.request("collect_metrics", parsed.target ? { target: parsed.target } : {})) as typeof metrics;
  } catch (err) {
    metrics = { error: message(err) };
  }

  // `scan` on a MetricsReport is a stats object ({pageLoads, pagesCached}),
  // not the node list. Reading nodes from it produced nothing useful.
  const nodes: MetricsNode[] = metrics?.nodes ?? [];
  const root = nodes[0] ?? ({ width: 1, height: 1, id: "unknown", name: "unknown", type: "FRAME", x: 0, y: 0, w: 1, h: 1 } as MetricsNode);
  const canvasWidth = Math.max(1, Number(root.w || 1));
  const canvasHeight = Math.max(1, Number(root.h || 1));

  const structure = summarizeVisual(nodes, root, canvasWidth, canvasHeight);

  const renderResult = renderTarget ? await render(renderTarget) : { ok: false, error: "No render target: pass a target id or select one node." };

  // Failure states are explicit. A missing screenshot is not a silent success.
  const failureState = !renderTarget
    ? "no-target"
    : renderResult.ok
      ? null
      : "render-failed";

  const payload: Record<string, unknown> = {
    ...structure,
    renderStatus: renderResult.ok ? "ok" : failureState,
    renderError: renderResult.ok ? undefined : renderResult.error,
    renderTarget: renderTarget ?? null,
    imageSize: renderResult.ok ? { width: renderResult.width, height: renderResult.height } : null,
    estimatedImageTokens: renderResult.ok ? renderResult.estimatedTokens : null,
    metricsError: metrics?.error ?? null,
    metricsTruncated: metrics?.truncated ?? null,
    nextActions: buildInspectNextActions(structure, failureState),
    note: renderResult.ok
      ? "Structural candidates are heuristics. Judge the image yourself: what you see first vs what should be first."
      : "No screenshot available. Treat structural evidence as provisional and fix the render failure before judging visual quality.",
  };

  const content: Array<Record<string, unknown>> = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
  if (renderResult.ok && renderResult.image) {
    content.push({ type: "text", text: "SCREENSHOT" });
    content.push({ type: "image", data: renderResult.image.data, mimeType: renderResult.image.mimeType });
  }
  return { content };
}

interface VisualSummary {
  canvas: { width: number; height: number };
  nodeCount: number;
  focalCandidates: Array<{ id: string; name: string; type: string; score: number; areaRatio: number; reason: string }>;
  textHierarchy: Array<{ id: string; text?: string; size: number | null; style: string | null }>;
  surfaceCount: number;
  cardLikeSurfaces: number;
  whitespaceRatio: number;
  componentUsage: number;
  colorCount: number;
}

function summarizeVisual(nodes: MetricsNode[], root: MetricsNode, canvasWidth: number, canvasHeight: number): VisualSummary {
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;
  const diag = Math.hypot(centerX, centerY) || 1;

  const focalCandidates = nodes
    .filter((n) => n.id !== root.id && n.w > 0 && n.h > 0)
    .map((n) => {
      const areaRatio = (n.w * n.h) / Math.max(1, canvasWidth * canvasHeight);
      const textScale = n.type === "TEXT" ? Math.min(1.5, (n.text?.size ?? 12) / 48) : 0;
      const name = String(n.name ?? "").toLowerCase();
      const semanticPriority = /primary|hero|focus|main|action|title|model|runtime|topology/.test(name) ? 1 : n.type === "INSTANCE" ? 0.7 : 0.3;
      const contrast = n.fill && n.background && n.fill !== n.background ? 0.9 : n.fill ? 0.5 : 0.2;
      const distance = Math.hypot(n.x + n.w / 2 - centerX, n.y + n.h / 2 - centerY);
      const positionFocus = 1 - Math.min(1, distance / diag);
      const score = areaRatio * 0.15 + contrast * 0.2 + semanticPriority * 0.25 + textScale * 0.1 + positionFocus * 0.1;
      const reasons: string[] = [];
      if (areaRatio > 0.15) reasons.push(`${Math.round(areaRatio * 100)}% of the canvas`);
      if (semanticPriority === 1) reasons.push("name reads as a primary object");
      if (textScale > 0.4) reasons.push("large type");
      return {
        id: n.id,
        name: n.name,
        type: n.type,
        score: Number(score.toFixed(4)),
        areaRatio: Number(areaRatio.toFixed(4)),
        reason: reasons.join("; ") || "measured area, contrast and position",
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 7);

  const textHierarchy = nodes
    .filter((n) => n.type === "TEXT")
    .sort((a, b) => (b.text?.size ?? 0) - (a.text?.size ?? 0))
    .slice(0, 12)
    .map((n) => ({ id: n.id, text: n.text?.content, size: n.text?.size ?? null, style: n.text?.style ?? null }));

  const surfaces = nodes.filter((n) => (n.type === "FRAME" || n.type === "RECTANGLE") && Boolean(n.fill));
  const filledArea = surfaces.reduce((sum, n) => sum + n.w * n.h, 0);
  const whitespaceRatio = Math.max(0, 1 - filledArea / Math.max(1, canvasWidth * canvasHeight));
  const colors = new Set(nodes.map((n) => n.fill).filter((c): c is string => typeof c === "string"));

  return {
    canvas: { width: canvasWidth, height: canvasHeight },
    nodeCount: nodes.length,
    focalCandidates,
    textHierarchy,
    surfaceCount: surfaces.length,
    cardLikeSurfaces: surfaces.filter((n) => (n.radius ?? 0) > 0).length,
    whitespaceRatio: Number(whitespaceRatio.toFixed(3)),
    componentUsage: nodes.filter((n) => n.type === "INSTANCE").length,
    colorCount: colors.size,
  };
}

function buildInspectNextActions(summary: VisualSummary, failureState: string | null): string[] {
  const actions: string[] = [];
  if (failureState === "no-target") {
    actions.push("Pass a `target` node id (a frame), or select exactly one node in Figma, then inspect again.");
  } else if (failureState === "render-failed") {
    actions.push("The screenshot failed. Check the node still exists and is a frame/component/instance, then retry.");
  }
  if (summary.cardLikeSurfaces >= 3 && summary.cardLikeSurfaces >= summary.surfaceCount - 1) {
    actions.push("Many equal card-like surfaces: consider whether the content wants a spatial or instrument composition instead of a card grid.");
  }
  if (summary.whitespaceRatio < 0.25) {
    actions.push(`Whitespace is low (${Math.round(summary.whitespaceRatio * 100)}%): check for density without relief.`);
  }
  if (summary.colorCount > 8) {
    actions.push(`${summary.colorCount} distinct fills: check whether a palette has drifted.`);
  }
  if (summary.focalCandidates.length > 1 && summary.focalCandidates[0]!.score - summary.focalCandidates[1]!.score < 0.05) {
    actions.push("The top two focal candidates are nearly tied: the eye has no single entry point.");
  }
  if (actions.length === 0) actions.push("Inspect the image, then run a targeted change and compare with compare_visuals.");
  return actions;
}
