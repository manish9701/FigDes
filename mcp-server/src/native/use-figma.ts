import { z } from "zod";
import vm from "vm";
import { type Session } from "../sessions";

export const UseFigmaArgs = z.object({
  sessionId: z.string().max(200).optional(),
  script: z.string().describe("JavaScript to execute in the sandboxed native environment. Exposes a `fig` object. IMPORTANT: All fig.* methods are async and must be awaited."),
});

export const InspectVisualArgs = z.object({
  sessionId: z.string().max(200).optional(),
  target: z.string().max(200).optional().describe("Figma node id to inspect visually. Omit to use selection."),
});

export async function figdesUseFigmaHandler(session: Session, args: unknown) {
  const parsed = UseFigmaArgs.parse(args ?? {});

  const rpc = async (action: string, payload: any = {}) => {
    return session.request("native_design", { action, ...payload });
  };

  const fig = {
    page: async () => rpc("resolve", { target: "page" }),
    createFrame: async (params: any) => rpc("createFrame", params),
    createRectangle: async (params: any) => rpc("createRectangle", params),
    createText: async (params: any) => rpc("createText", params),
    createComponent: async (params: any) => rpc("createComponent", params),
    createInstance: async (params: any) => rpc("createInstance", params),
    find: async (query: any, root?: any) => rpc("find", { query, root: root?.id || root }),
    getSelection: async () => rpc("getSelection"),
    getNode: async (target: any) => rpc("getNode", { target: target?.id || target }),
    getChildren: async (target: any) => rpc("getChildren", { target: target?.id || target }),
    getBounds: async (target: any) => rpc("getBounds", { target: target?.id || target }),
    setPosition: async (target: any, params: any) => rpc("setPosition", { target: target?.id || target, ...params }),
    setSize: async (target: any, params: any) => rpc("setSize", { target: target?.id || target, ...params }),
    setAutoLayout: async (target: any, params: any) => rpc("setAutoLayout", { target: target?.id || target, ...params }),
    setFill: async (target: any, params: any) => rpc("setFill", { target: target?.id || target, ...params }),
    setStroke: async (target: any, params: any) => rpc("setStroke", { target: target?.id || target, ...params }),
    setEffect: async (target: any, params: any) => rpc("setEffect", { target: target?.id || target, ...params }),
    setTypography: async (target: any, params: any) => rpc("setTypography", { target: target?.id || target, ...params }),
    setVariable: async (target: any, params: any) => rpc("setVariable", { target: target?.id || target, ...params }),
    setStyle: async (target: any, params: any) => rpc("setStyle", { target: target?.id || target, ...params }),
    clone: async (target: any, params: any) => rpc("clone", { target: target?.id || target, ...params }),
    remove: async (target: any) => rpc("remove", { target: target?.id || target }),
    append: async (parent: any, child: any) => rpc("append", { parent: parent?.id || parent, child: child?.id || child }),
  };

  const context = vm.createContext({ fig, console });
  try {
    const wrapped = `(async () => { ${parsed.script} })()`;
    await vm.runInContext(wrapped, context, { timeout: 30000 });
    return { status: "success", message: "Native script executed successfully." };
  } catch (err: any) {
    throw new Error(`Native execution failed: ${err.message}`);
  }
}

export async function figdesInspectVisualHandler(session: Session, args: unknown) {
  const parsed = InspectVisualArgs.parse(args ?? {});
  
  // Call collect_metrics to get the visual data
  const raw = (await session.request("collect_metrics", { target: parsed.target })) as any;
  if (!raw || typeof raw !== "object" || raw.error) {
    throw new Error(raw?.error || "Failed to inspect visually.");
  }

  // Get Screenshot
  let imageContent = null;
  try {
    const renderRes = await session.request("render_node", { nodeId: parsed.target || "page", maxWidth: 1024, detail: "low" }) as any;
    if (renderRes && typeof renderRes.data === "string") {
      imageContent = { type: "image", data: renderRes.data, mimeType: "image/png" };
    }
  } catch (e) {
    // Ignore render error, just omit image
  }

  // Derive the visual summary 
  const root = raw.scan?.[0] || {};
  const canvasDimensions = { width: root.width, height: root.height };
  
  const nodes = raw.scan || [];
  
  // Calculate focal scores
  function normalize(val: number) { return val || 0; }
  const focalCandidates = nodes
    .filter((n: any) => n.id !== root.id && n.width > 0 && n.height > 0)
    .map((n: any) => {
       const areaRatio = (n.width * n.height) / (root.width * root.height || 1);
       const textScale = n.type === 'TEXT' ? (n.style?.fontSize || 12) / 48 : 0;
       const contrast = n.fills?.length > 0 ? 0.8 : 0.2;
       const semanticPriority = n.type === 'INSTANCE' ? 0.7 : 0.3;
       
       const score = (
         normalize(areaRatio) * 0.15 +
         normalize(contrast) * 0.20 +
         normalize(semanticPriority) * 0.25 +
         normalize(textScale) * 0.10
       );
       return { id: n.id, name: n.name, type: n.type, score, areaRatio };
    })
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, 5);
    
  // text hierarchy
  const textNodes = nodes.filter((n: any) => n.type === "TEXT");
  const textHierarchy = textNodes
    .sort((a: any, b: any) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0))
    .slice(0, 10)
    .map((n: any) => ({ text: n.characters, size: n.style?.fontSize, weight: n.style?.fontWeight }));
    
  // surface count
  const surfaces = nodes.filter((n: any) => ["FRAME", "RECTANGLE"].includes(n.type) && n.fills?.length > 0);
  
  const structure = {
    canvasDimensions,
    textHierarchy,
    surfaceCount: surfaces.length,
    focalCandidates,
    visualLayers: surfaces.length,
    componentUsage: nodes.filter((n: any) => n.type === "INSTANCE").length,
    cardLikeSurfaces: surfaces.filter((n: any) => n.cornerRadius && n.cornerRadius > 0).length,
  };

  const content: any[] = [{ type: "text", text: JSON.stringify(structure, null, 2) }];
  if (imageContent) content.push(imageContent);

  return { content };
}
