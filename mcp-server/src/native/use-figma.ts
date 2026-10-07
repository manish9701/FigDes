import { z } from "zod";
import vm from "vm";
import { type Session } from "../sessions";

export const UseFigmaArgs = z.object({
  sessionId: z.string().max(200).optional(),
  script: z.string().describe("JavaScript to execute in the sandboxed native environment. Exposes a `fig` object."),
});

export const InspectVisualArgs = z.object({
  sessionId: z.string().max(200).optional(),
  target: z.string().max(200).optional().describe("Figma node id to inspect visually. Omit to use selection."),
});

export async function figdesUseFigmaHandler(session: Session, args: unknown) {
  const parsed = UseFigmaArgs.parse(args ?? {});
  const operations: any[] = [];
  let nextTempId = 1;

  function genId(prefix: string) {
    return `${prefix}_${nextTempId++}`;
  }

  const fig = {
    page: () => ({ id: "page" }),
    frame: (params: any) => {
      const id = genId("frame");
      operations.push({ type: "createFrame", id, ...params });
      return { id };
    },
    rectangle: (params: any) => {
      const id = genId("rect");
      operations.push({ type: "createRectangle", id, ...params });
      return { id };
    },
    ellipse: (params: any) => {
      const id = genId("ellipse");
      operations.push({ type: "createEllipse", id, ...params });
      return { id };
    },
    text: (params: any) => {
      const id = genId("text");
      operations.push({ type: "createText", id, ...params });
      return { id };
    },
    vector: (params: any) => {
      const id = genId("vector");
      operations.push({ type: "createVector", id, ...params });
      return { id };
    },
    group: (params: any) => {
      const id = genId("group");
      operations.push({ type: "createGroup", id, ...params });
      return { id };
    },
    variable: (params: any) => {
      const id = genId("variable");
      operations.push({ type: "createVariable", id, ...params });
      return { id };
    },
    style: (params: any) => {
      const id = genId("style");
      if (params.color) {
        operations.push({ type: "createPaintStyle", id, ...params });
      } else {
        operations.push({ type: "createTextStyle", id, ...params });
      }
      return { id };
    },
    effect: (params: any) => {
      operations.push({ type: "setEffect", ...params });
    },
    autoLayout: (params: any) => {
      operations.push({ type: "setAutoLayout", ...params });
    },
    append: (parent: any, child: any) => {
      operations.push({ type: "appendChild", parent: parent?.id || parent, child: child?.id || child });
    },
    remove: (target: any) => {
      operations.push({ type: "removeNode", target: target?.id || target });
    },
    clone: (target: any, params: any) => {
      const id = genId("clone");
      operations.push({ type: "cloneNode", id, target: target?.id || target, ...params });
      return { id };
    },
    bounds: (target: any, params: any) => {
      operations.push({ type: "setPosition", target: target?.id || target, x: params.x, y: params.y });
      operations.push({ type: "setSize", target: target?.id || target, width: params.width, height: params.height });
    },
  };

  const context = vm.createContext({ fig, console });
  try {
    vm.runInContext(parsed.script, context, { timeout: 3000 });
  } catch (err: any) {
    throw new Error(`Native execution failed: ${err.message}`);
  }

  if (operations.length === 0) {
    return { status: "ok", message: "Script executed successfully but produced no operations." };
  }

  const result = await session.request("create_design", {
    description: "Native Execution (figdes_use_figma)",
    operations,
    dryRun: false,
  }) as any;

  if (result.status === "failed") {
    throw new Error(`Transaction failed: ${result.error?.message}`);
  }

  return result;
}

export async function figdesInspectVisualHandler(session: Session, args: unknown) {
  const parsed = InspectVisualArgs.parse(args ?? {});
  
  // Call collect_metrics to get the visual data
  const raw = (await session.request("collect_metrics", { target: parsed.target })) as any;
  if (!raw || typeof raw !== "object" || raw.error) {
    throw new Error(raw?.error || "Failed to inspect visually.");
  }

  // Derive the visual summary 
  const root = raw.scan?.[0] || {};
  const canvasDimensions = { width: root.width, height: root.height };
  
  const nodes = raw.scan || [];
  
  // largest objects
  const largestObjects = nodes
    .filter((n: any) => n.id !== root.id)
    .sort((a: any, b: any) => (b.width * b.height) - (a.width * a.height))
    .slice(0, 5)
    .map((n: any) => ({ id: n.id, name: n.name, area: n.width * n.height }));
    
  // text hierarchy
  const textNodes = nodes.filter((n: any) => n.type === "TEXT");
  const textHierarchy = textNodes
    .sort((a: any, b: any) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0))
    .slice(0, 10)
    .map((n: any) => ({ text: n.characters, size: n.style?.fontSize, weight: n.style?.fontWeight }));
    
  // surface count
  const surfaces = nodes.filter((n: any) => ["FRAME", "RECTANGLE"].includes(n.type) && n.fills?.length > 0);
  
  return {
    canvasDimensions,
    largestObjects,
    textHierarchy,
    surfaceCount: surfaces.length,
    focalCandidates: largestObjects, // naive for now
    visualLayers: surfaces.length,
    componentUsage: nodes.filter((n: any) => n.type === "INSTANCE").length,
    cardLikeSurfaces: surfaces.filter((n: any) => n.cornerRadius && n.cornerRadius > 0).length,
  };
}
