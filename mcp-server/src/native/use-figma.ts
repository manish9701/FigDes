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
import vm from "vm";
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
        "Controlled JavaScript executed against the FigDes native Figma API. Only the exposed fig API, Math, JSON, Date and console are available. All fig.* calls are async and must be awaited.",
      ),
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
    maxNodes: z.number().int().min(50).max(6000).optional().describe("Scan budget for scope 'design-system'."),
    depth: z.number().int().min(1).max(6).optional().describe("Frame depth for scope 'design-system'."),
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
  const data = await session.request("native_design", {
    action,
    ...(parsed.target !== undefined ? { target: parsed.target } : {}),
    ...(parsed.maxNodes !== undefined ? { maxNodes: parsed.maxNodes } : {}),
    ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}),
  });
  return { status: "ok", scope: parsed.scope, data };
}

/* -------------------------------------------------------------------------- */
/* Native script execution                                                     */
/* -------------------------------------------------------------------------- */

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Rpc = (action: string, payload?: Record<string, unknown>) => Promise<unknown>;

/** Turns an object-or-id argument into a node id string. */
const ref = (value: unknown): unknown => {
  if (value && typeof value === "object" && "id" in (value as Record<string, unknown>)) {
    return (value as { id: unknown }).id;
  }
  return value;
};

function createFigApi(rpc: Rpc): Record<string, unknown> {
  return {
    /* document / inspection */
    page: () => rpc("getNode", { target: "page" }),
    currentPage: () => rpc("getNode", { target: "page" }),
    getPages: () => rpc("getPages"),
    createPage: (params: Record<string, unknown> = {}) => rpc("createPage", params),
    setCurrentPage: (target: unknown) => rpc("setCurrentPage", { target: ref(target) }),
    getFileInfo: () => rpc("getFileInfo"),
    getDesignContext: (params: Record<string, unknown> = {}) => rpc("getDesignContext", params),
    listLibraryCollections: () => rpc("listLibraryCollections"),
    getProperties: (target: unknown) => rpc("getProperties", { target: ref(target) }),
    inspect: (target: unknown, options: Record<string, unknown> = {}) => rpc("inspect", { target: ref(target), ...options }),

    /* creation */
    createFrame: (params: Record<string, unknown>) => rpc("createFrame", params),
    createRectangle: (params: Record<string, unknown>) => rpc("createRectangle", params),
    createEllipse: (params: Record<string, unknown>) => rpc("createEllipse", params),
    createPolygon: (params: Record<string, unknown>) => rpc("createPolygon", params),
    createStar: (params: Record<string, unknown>) => rpc("createStar", params),
    createLine: (params: Record<string, unknown>) => rpc("createLine", params),
    createText: (params: Record<string, unknown>) => rpc("createText", params),
    createVector: (params: Record<string, unknown>) => rpc("createVector", params),
    createGroup: (params: Record<string, unknown>) => rpc("createGroup", params),
    createComponent: (params: Record<string, unknown>) => rpc("createComponent", params),
    createInstance: (params: Record<string, unknown>) => rpc("createInstance", params),

    /* components */
    listComponents: () => rpc("listComponents"),
    getComponentProperties: (target: unknown) => rpc("getComponentProperties", { target: ref(target) }),
    setVariant: (target: unknown, params: Record<string, unknown>) => rpc("setVariant", { target: ref(target), ...params }),
    detachInstance: (target: unknown) => rpc("detachInstance", { target: ref(target) }),

    /* variables */
    listVariables: () => rpc("listVariables"),
    findVariable: (query: string) => rpc("findVariable", { query }),
    createVariable: (params: Record<string, unknown>) => rpc("createVariable", params),
    setVariableValue: (params: Record<string, unknown>) => rpc("setVariableValue", params),
    bindVariable: (target: unknown, params: Record<string, unknown>) => rpc("bindVariable", { target: ref(target), ...params }),

    /* styles */
    listStyles: () => rpc("listStyles"),
    findStyle: (query: string, kind?: string) => rpc("findStyle", { query, kind }),
    createPaintStyle: (params: Record<string, unknown>) => rpc("createPaintStyle", params),
    createTextStyle: (params: Record<string, unknown>) => rpc("createTextStyle", params),
    createEffectStyle: (params: Record<string, unknown>) => rpc("createEffectStyle", params),
    applyStyle: (target: unknown, params: Record<string, unknown>) => rpc("applyStyle", { target: ref(target), ...params }),

    /* find / selection */
    find: (query: Record<string, unknown>, root?: unknown) => rpc("find", { query, root: ref(root) }),
    getSelection: () => rpc("getSelection"),
    setSelection: (nodeIds: string[]) => rpc("setSelection", { nodeIds }),
    getNode: (target: unknown) => rpc("getNode", { target: ref(target) }),
    getChildren: (target: unknown) => rpc("getChildren", { target: ref(target) }),
    getParent: (target: unknown) => rpc("getParent", { target: ref(target) }),
    getBounds: (target: unknown) => rpc("getBounds", { target: ref(target) }),
    getAbsoluteBounds: (target: unknown) => rpc("getAbsoluteBounds", { target: ref(target) }),

    /* geometry */
    setPosition: (target: unknown, params: Record<string, unknown>) => rpc("setPosition", { target: ref(target), ...params }),
    setSize: (target: unknown, params: Record<string, unknown>) => rpc("setSize", { target: ref(target), ...params }),
    setBounds: (target: unknown, params: Record<string, unknown>) => rpc("setBounds", { target: ref(target), ...params }),
    setRotation: (target: unknown, params: Record<string, unknown>) => rpc("setRotation", { target: ref(target), ...params }),
    setCornerRadius: (target: unknown, params: Record<string, unknown>) => rpc("setCornerRadius", { target: ref(target), ...params }),
    setIndividualCornerRadii: (target: unknown, params: Record<string, unknown>) => rpc("setIndividualCornerRadii", { target: ref(target), ...params }),

    /* layout */
    setAutoLayout: (target: unknown, params: Record<string, unknown>) => rpc("setAutoLayout", { target: ref(target), ...params }),
    setClipContent: (target: unknown, params: Record<string, unknown>) => rpc("setClipContent", { target: ref(target), ...params }),
    setConstraints: (target: unknown, params: Record<string, unknown>) => rpc("setConstraints", { target: ref(target), ...params }),

    /* paint */
    setFill: (target: unknown, params: Record<string, unknown>) => rpc("setFill", { target: ref(target), ...params }),
    setFills: (target: unknown, params: Record<string, unknown>) => rpc("setFills", { target: ref(target), ...params }),
    clearFill: (target: unknown) => rpc("clearFill", { target: ref(target) }),
    setStroke: (target: unknown, params: Record<string, unknown>) => rpc("setStroke", { target: ref(target), ...params }),
    setEffects: (target: unknown, params: Record<string, unknown>) => rpc("setEffects", { target: ref(target), ...params }),
    setOpacity: (target: unknown, params: Record<string, unknown>) => rpc("setOpacity", { target: ref(target), ...params }),
    setVisible: (target: unknown, params: Record<string, unknown>) => rpc("setVisible", { target: ref(target), ...params }),
    setBlendMode: (target: unknown, params: Record<string, unknown>) => rpc("setBlendMode", { target: ref(target), ...params }),

    /* typography */
    setTypography: (target: unknown, params: Record<string, unknown>) => rpc("setTypography", { target: ref(target), ...params }),
    setTextContent: (target: unknown, params: Record<string, unknown>) => rpc("setTextContent", { target: ref(target), ...params }),
    loadFont: (font: unknown) => rpc("loadFont", { font }),

    /* vectors / misc */
    setIsMask: (target: unknown, params: Record<string, unknown>) => rpc("setIsMask", { target: ref(target), ...params }),
    setOverflowDirection: (target: unknown, params: Record<string, unknown>) => rpc("setOverflowDirection", { target: ref(target), ...params }),
    setPathData: (target: unknown, params: Record<string, unknown>) => rpc("setPathData", { target: ref(target), ...params }),

    /* structure */
    clone: (target: unknown, params: Record<string, unknown> = {}) => rpc("clone", { target: ref(target), ...params }),
    rename: (target: unknown, name: string) => rpc("rename", { target: ref(target), name }),
    remove: (target: unknown) => rpc("remove", { target: ref(target) }),
    append: (parent: unknown, child: unknown) => rpc("append", { target: ref(parent), child: ref(child) }),
    insertChild: (parent: unknown, child: unknown, index: number) =>
      rpc("insertChild", { target: ref(parent), child: ref(child), index }),
  };
}

async function safeRollback(session: Session, transactionId: string): Promise<Record<string, unknown>> {
  try {
    return (await session.request(
      "native_design",
      { action: "rollbackNativeTransaction", transactionId },
      RPC_TIMEOUT_MS,
    )) as Record<string, unknown>;
  } catch (err) {
    return { status: "rollback-failed", rolledBack: false, error: message(err) };
  }
}

function classify(msg: string): string {
  if (/Unknown native action/i.test(msg)) return "UNKNOWN_ACTION";
  if (/Invalid parameters for/i.test(msg)) return "INVALID_PARAMETERS";
  // Checked before the generic abort pattern: an RPC-limit message contains
  // "exceeded" too, and the two need different recovery advice.
  if (/RPC limit/i.test(msg)) return "RPC_LIMIT";
  if (/hard budget|budget was exhausted|aborted|not open/i.test(msg)) return "ABORTED";
  if (/not found/i.test(msg)) return "NODE_NOT_FOUND";
  if (/requires a TEXT|requires a|does not support|not a component|not an INSTANCE/i.test(msg)) return "INVALID_NODE_TYPE";
  if (/Font .* is not available|font/i.test(msg)) return "FONT_UNAVAILABLE";
  return "NATIVE_ERROR";
}

function recoveryFor(code: string): string {
  switch (code) {
    case "UNKNOWN_ACTION":
      return "Call the action with one of the supported names. The error lists them; do not invent new ones.";
    case "INVALID_PARAMETERS":
      return "Fix the named parameter and retry. The field path in the message says which one.";
    case "ABORTED":
      return "The script was stopped and rolled back. Split the work into smaller scripts and inspect before retrying; do not blindly repeat it.";
    case "RPC_LIMIT":
      return "Batch related work into fewer fig.* calls, or build the screen in semantic mode and refine natively.";
    case "NODE_NOT_FOUND":
      return "Re-inspect to get current node ids, then address a node that exists.";
    case "INVALID_NODE_TYPE":
      return "Inspect the target's type first, then use an operation that matches it.";
    case "FONT_UNAVAILABLE":
      return "Use a font already installed and reported by inspect_design_system.";
    default:
      return "Inspect the current state, correct the call from evidence, and retry. Do not repeat the failed call unchanged.";
  }
}

async function runNativeScript(session: Session, script: string): Promise<unknown> {
  const budgetMs = scriptTimeoutMs();
  const transactionId = `ntx_${randomUUID()}`;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  let aborted = false;
  let rpcCalls = 0;

  const rpc: Rpc = async (action, payload = {}) => {
    if (aborted) {
      throw new Error(`Native execution aborted: the script exceeded its ${budgetMs}ms budget.`);
    }
    rpcCalls += 1;
    const limit = maxRpcCalls();
    if (rpcCalls > limit) {
      throw new Error(`Native RPC limit exceeded (${limit}). Batch related work into fewer calls.`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Native execution aborted: the ${budgetMs}ms budget was exhausted.`);
    }
    return session.request("native_design", { action, transactionId, ...payload }, Math.min(RPC_TIMEOUT_MS, remaining));
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    await rpc("beginNativeTransaction", {});

    const fig = createFigApi(rpc);

    const hardTimeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        aborted = true;
        reject(new Error(`Native script exceeded the ${budgetMs}ms hard budget (this covers async work).`));
      }, budgetMs);
    });

    const context = vm.createContext({ fig, console, Math, JSON, Date });
    const wrapped = `(async () => { ${script} })()`;
    const scriptPromise = vm.runInContext(wrapped, context, { timeout: budgetMs }) as Promise<unknown>;
    // After a timeout the script is still running in the background; swallow its
    // eventual rejection so it never surfaces as an unhandled rejection.
    scriptPromise.catch(() => {});

    await Promise.race([scriptPromise, hardTimeout]);

    const transaction = await rpc("commitNativeTransaction", {});
    return {
      status: "success",
      transactionId,
      rpcCalls,
      durationMs: Date.now() - startedAt,
      message: "Native script executed successfully.",
      transaction,
    };

  } catch (err) {
    aborted = true;
    const msg = message(err);
    const code = classify(msg);
    const rollback = await safeRollback(session, transactionId);
    return {
      status: "failed",
      transactionId,
      rpcCalls,
      durationMs: Date.now() - startedAt,
      timedOut: code === "ABORTED",
      rolledBack: rollback?.rolledBack === true,
      error: { code, message: msg, recovery: recoveryFor(code) },
      rollback,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function figdesUseFigmaHandler(session: Session, args: unknown): Promise<unknown> {
  const parsed = UseFigmaArgs.parse(args ?? {});
  // Serialized per session: two native scripts must never interleave transactions.
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
