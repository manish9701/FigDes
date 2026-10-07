import { z } from "zod";
import vm from "vm";
import { type Session } from "../sessions";

const MAX_SCRIPT_SIZE = 120_000;
const MAX_RPC_CALLS = 1_000;
const SCRIPT_TIMEOUT_MS = 30_000;

export const UseFigmaArgs = z.object({
  sessionId: z.string().max(200).optional(),
  script: z.string().max(MAX_SCRIPT_SIZE).describe("Controlled JavaScript executed against the FigDes native Figma API. Only the exposed fig API, Math, JSON, Date and console are available. All fig.* calls are async and must be awaited."),
});

export const InspectVisualArgs = z.object({
  sessionId: z.string().max(200).optional(),
  target: z.string().max(200).optional().describe("Figma node id to inspect visually. Omit to use a single selected scene node."),
});

export async function figdesUseFigmaHandler(session: Session, args: unknown) {
  const parsed = UseFigmaArgs.parse(args ?? {});
  let rpcCount = 0;

  const rpc = async (action: string, payload: any = {}) => {
    rpcCount += 1;
    if (rpcCount > MAX_RPC_CALLS) {
      throw new Error("Native script RPC limit exceeded (" + MAX_RPC_CALLS + "). Batch related work into fewer operations.");
    }
    return session.request("native_design", { action, ...payload });
  };

  const fig = {
    page: async () => rpc("getNode", { target: "page" }),
    currentPage: async () => rpc("getNode", { target: "page" }),
    getPages: async () => rpc("getPages"),
    createPage: async (params: any = {}) => rpc("createPage", params),
    setCurrentPage: async (target: any) => rpc("setCurrentPage", { target: target?.id || target }),
    createFrame: async (params: any) => rpc("createFrame", params),
    createRectangle: async (params: any) => rpc("createRectangle", params),
    createEllipse: async (params: any) => rpc("createEllipse", params),
    createPolygon: async (params: any) => rpc("createPolygon", params),
    createStar: async (params: any) => rpc("createStar", params),
    createLine: async (params: any) => rpc("createLine", params),
    createText: async (params: any) => rpc("createText", params),
    createVector: async (params: any) => rpc("createVector", params),
    createGroup: async (params: any) => rpc("createGroup", params),
    createComponent: async (params: any) => rpc("createComponent", params),
    createInstance: async (params: any) => rpc("createInstance", params),
    listComponents: async () => rpc("listComponents"),
    getComponentProperties: async (target: any) => rpc("getComponentProperties", { target: target?.id || target }),
    setVariant: async (target: any, params: any) => rpc("setVariant", { target: target?.id || target, ...params }),
    detachInstance: async (target: any) => rpc("detachInstance", { target: target?.id || target }),
    listVariables: async () => rpc("listVariables"),
    findVariable: async (query: string) => rpc("findVariable", { query }),
    createVariable: async (params: any) => rpc("createVariable", params),
    setVariableValue: async (params: any) => rpc("setVariableValue", params),
    bindVariable: async (target: any, params: any) => rpc("bindVariable", { target: target?.id || target, ...params }),
    listStyles: async () => rpc("listStyles"),
    findStyle: async (query: string, kind?: any) => rpc("findStyle", { query, kind }),
    createPaintStyle: async (params: any) => rpc("createPaintStyle", params),
    createTextStyle: async (params: any) => rpc("createTextStyle", params),
    createEffectStyle: async (params: any) => rpc("createEffectStyle", params),
    applyStyle: async (target: any, params: any) => rpc("applyStyle", { target: target?.id || target, ...params }),
    find: async (query: any, root?: any) => rpc("find", { query, root: root?.id || root }),
    getSelection: async () => rpc("getSelection"),
    setSelection: async (nodeIds: string[]) => rpc("setSelection", { nodeIds }),
    getNode: async (target: any) => rpc("getNode", { target: target?.id || target }),
    getChildren: async (target: any) => rpc("getChildren", { target: target?.id || target }),
    getParent: async (target: any) => rpc("getParent", { target: target?.id || target }),
    getBounds: async (target: any) => rpc("getBounds", { target: target?.id || target }),
    getAbsoluteBounds: async (target: any) => rpc("getAbsoluteBounds", { target: target?.id || target }),
    setPosition: async (target: any, params: any) => rpc("setPosition", { target: target?.id || target, ...params }),
    setSize: async (target: any, params: any) => rpc("setSize", { target: target?.id || target, ...params }),
    setBounds: async (target: any, params: any) => rpc("setBounds", { target: target?.id || target, ...params }),
    setRotation: async (target: any, params: any) => rpc("setRotation", { target: target?.id || target, ...params }),
    setCornerRadius: async (target: any, params: any) => rpc("setCornerRadius", { target: target?.id || target, ...params }),
    setIndividualCornerRadii: async (target: any, params: any) => rpc("setIndividualCornerRadii", { target: target?.id || target, ...params }),
    setAutoLayout: async (target: any, params: any) => rpc("setAutoLayout", { target: target?.id || target, ...params }),
    setClipContent: async (target: any, params: any) => rpc("setClipContent", { target: target?.id || target, ...params }),
    setConstraints: async (target: any, params: any) => rpc("setConstraints", { target: target?.id || target, ...params }),
    setFill: async (target: any, params: any) => rpc("setFill", { target: target?.id || target, ...params }),
    setFills: async (target: any, params: any) => rpc("setFills", { target: target?.id || target, ...params }),
    clearFill: async (target: any) => rpc("clearFill", { target: target?.id || target }),
    setStroke: async (target: any, params: any) => rpc("setStroke", { target: target?.id || target, ...params }),
    setEffects: async (target: any, params: any) => rpc("setEffects", { target: target?.id || target, ...params }),
    setOpacity: async (target: any, params: any) => rpc("setOpacity", { target: target?.id || target, ...params }),
    setVisible: async (target: any, params: any) => rpc("setVisible", { target: target?.id || target, ...params }),
    setBlendMode: async (target: any, params: any) => rpc("setBlendMode", { target: target?.id || target, ...params }),
    setTypography: async (target: any, params: any) => rpc("setTypography", { target: target?.id || target, ...params }),
    setTextContent: async (target: any, params: any) => rpc("setTextContent", { target: target?.id || target, ...params }),
    loadFont: async (font: any) => rpc("loadFont", { font }),
    setIsMask: async (target: any, params: any) => rpc("setIsMask", { target: target?.id || target, ...params }),
    setOverflowDirection: async (target: any, params: any) => rpc("setOverflowDirection", { target: target?.id || target, ...params }),
    setPathData: async (target: any, params: any) => rpc("setPathData", { target: target?.id || target, ...params }),
    clone: async (target: any, params: any = {}) => rpc("clone", { target: target?.id || target, ...params }),
    rename: async (target: any, name: string) => rpc("rename", { target: target?.id || target, name }),
    remove: async (target: any) => rpc("remove", { target: target?.id || target }),
    append: async (parent: any, child: any) => rpc("append", { target: parent?.id || parent, child: child?.id || child }),
    insertChild: async (parent: any, child: any, index: number) => rpc("insertChild", { target: parent?.id || parent, child: child?.id || child, index }),
  };

  const context = vm.createContext({ fig, console, Math, JSON, Date });
  try {
    await session.request("native_design", { action: "beginNativeTransaction" });
    const wrapped = "(async () => { " + parsed.script + " })()";
    await vm.runInContext(wrapped, context, { timeout: SCRIPT_TIMEOUT_MS });
    await session.request("native_design", { action: "commitNativeTransaction" });
    return { status: "success", rpcCalls: rpcCount, message: "Native script executed successfully." };
  } catch (err: any) {
    try {
      await session.request("native_design", { action: "rollbackNativeTransaction" });
    } catch (rollbackError: any) {
      throw new Error("Native execution failed: " + err.message + "; rollback also failed: " + (rollbackError?.message ?? rollbackError));
    }
    throw new Error("Native execution failed: " + err.message);
  }
}

export async function figdesInspectVisualHandler(session: Session, args: unknown) {
  const parsed = InspectVisualArgs.parse(args ?? {});
  const raw = (await session.request("collect_metrics", parsed.target ? { target: parsed.target } : {})) as any;
  if (!raw || typeof raw !== "object" || raw.error) throw new Error(raw?.error || "Failed to inspect visually.");

  let renderTarget = parsed.target;
  if (!renderTarget) {
    const selection = (await session.request("inspect_selection", { depth: 1, budget: 20 })) as any;
    const selected = selection?.selection ?? [];
    if (selected.length === 1 && selected[0]?.id) renderTarget = selected[0].id;
  }

  let imageContent: any = null;
  if (renderTarget) {
    try {
      const renderRes = await session.request("render_node", { nodeId: renderTarget, maxWidth: 1024, detail: "low" }) as any;
      if (renderRes?.data) imageContent = { type: "image", data: renderRes.data, mimeType: "image/png" };
    } catch { /* visual inspection still returns structural evidence */ }
  }

  const root = raw.scan?.[0] || {};
  const canvasWidth = Number(root.width || 1);
  const canvasHeight = Number(root.height || 1);
  const nodes = raw.scan || [];
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;

  const focalCandidates = nodes
    .filter((n: any) => n.id !== root.id && n.width > 0 && n.height > 0)
    .map((n: any) => {
      const areaRatio = (n.width * n.height) / Math.max(1, canvasWidth * canvasHeight);
      const textScale = n.type === "TEXT" ? Math.min(1.5, (n.style?.fontSize || 12) / 48) : 0;
      const name = String(n.name || "").toLowerCase();
      const semanticPriority = /primary|hero|focus|main|action|title|model|runtime|topology/.test(name) ? 1 : n.type === "INSTANCE" ? 0.7 : 0.3;
      const contrast = n.fill && n.background && n.fill !== n.background ? 0.9 : n.fill ? 0.5 : 0.2;
      const distance = Math.hypot((n.x + n.width / 2) - centerX, (n.y + n.height / 2) - centerY);
      const positionFocus = 1 - Math.min(1, distance / Math.max(1, Math.hypot(centerX, centerY)));
      const score = areaRatio * 0.15 + contrast * 0.20 + semanticPriority * 0.25 + textScale * 0.10 + positionFocus * 0.10;
      return { id: n.id, name: n.name, type: n.type, score: Number(score.toFixed(4)), areaRatio, positionFocus };
    })
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 7);

  const textHierarchy = nodes.filter((n: any) => n.type === "TEXT")
    .sort((a: any, b: any) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0))
    .slice(0, 12)
    .map((n: any) => ({ id: n.id, text: n.characters, size: n.style?.fontSize, weight: n.style?.fontWeight }));

  const surfaces = nodes.filter((n: any) => ["FRAME", "RECTANGLE"].includes(n.type) && n.fills?.length > 0);
  const structure = {
    canvasDimensions: { width: root.width, height: root.height },
    renderTarget: renderTarget ?? null,
    textHierarchy,
    surfaceCount: surfaces.length,
    focalCandidates,
    visualLayers: surfaces.length,
    componentUsage: nodes.filter((n: any) => n.type === "INSTANCE").length,
    cardLikeSurfaces: surfaces.filter((n: any) => n.cornerRadius && n.cornerRadius > 0).length,
    note: imageContent ? "Screenshot included for visual judgement. Structural focal candidates are heuristics only." : "No screenshot available; use structural evidence only."
  };
  const content: any[] = [{ type: "text", text: JSON.stringify(structure, null, 2) }];
  if (imageContent) content.push(imageContent);
  return { content };
}