export async function executeNativeCall(payload: any): Promise<any> {
  const { action, target, ...params } = payload;

  function resolve(id: string | null | undefined): BaseNode {
    if (!id || id === "page") return figma.currentPage;
    const n = figma.getNodeById(id);
    if (!n) throw new Error(`Node ${id} not found`);
    return n;
  }

  function asScene(n: BaseNode): SceneNode {
    if (n.type === "PAGE" || n.type === "DOCUMENT") throw new Error("Expected a SceneNode");
    return n as SceneNode;
  }

  function serialize(n: BaseNode) {
    if (n.type === "PAGE" || n.type === "DOCUMENT") return { id: n.id, type: n.type, name: n.name };
    const sn = n as SceneNode;
    return { id: sn.id, type: sn.type, name: sn.name, x: sn.x, y: sn.y, width: sn.width, height: sn.height };
  }

  switch (action) {
    case "createFrame": {
      const frame = figma.createFrame();
      if (params.name) frame.name = params.name;
      if (params.width && params.height) frame.resize(params.width, params.height);
      figma.currentPage.appendChild(frame);
      return serialize(frame);
    }
    case "createRectangle": {
      const rect = figma.createRectangle();
      if (params.name) rect.name = params.name;
      if (params.width && params.height) rect.resize(params.width, params.height);
      figma.currentPage.appendChild(rect);
      return serialize(rect);
    }
    case "createText": {
      const text = figma.createText();
      await figma.loadFontAsync(text.fontName as FontName);
      if (params.name) text.name = params.name;
      if (params.content) text.characters = params.content;
      if (params.fontSize) text.fontSize = params.fontSize;
      figma.currentPage.appendChild(text);
      return serialize(text);
    }
    case "createComponent": {
      const comp = figma.createComponent();
      if (params.name) comp.name = params.name;
      if (params.width && params.height) comp.resize(params.width, params.height);
      figma.currentPage.appendChild(comp);
      return serialize(comp);
    }
    case "createInstance": {
      const comp = resolve(params.componentId);
      if (comp.type !== "COMPONENT" && comp.type !== "COMPONENT_SET") throw new Error("Not a component");
      const inst = (comp as ComponentNode).createInstance();
      if (params.name) inst.name = params.name;
      figma.currentPage.appendChild(inst);
      return serialize(inst);
    }
    case "find": {
      const query = params.query;
      const root = params.root ? resolve(params.root) : figma.currentPage;
      if (!("findAll" in root)) return [];
      const nodes = root.findAll((n) => {
        if (query.name && !n.name.includes(query.name)) return false;
        if (query.type && n.type !== query.type) return false;
        return true;
      });
      return nodes.map(serialize);
    }
    case "getSelection": {
      return figma.currentPage.selection.map(serialize);
    }
    case "getNode": {
      return serialize(resolve(target));
    }
    case "getChildren": {
      const node = resolve(target);
      if (!("children" in node)) return [];
      return node.children.map(serialize);
    }
    case "getBounds": {
      const sn = asScene(resolve(target));
      return { x: sn.x, y: sn.y, width: sn.width, height: sn.height };
    }
    case "setPosition": {
      const sn = asScene(resolve(target));
      if (params.x !== undefined) sn.x = params.x;
      if (params.y !== undefined) sn.y = params.y;
      return serialize(sn);
    }
    case "setSize": {
      const sn = asScene(resolve(target));
      if (params.width !== undefined && params.height !== undefined) {
        if ("resize" in sn) (sn as any).resize(params.width, params.height);
      }
      return serialize(sn);
    }
    case "setAutoLayout": {
      const sn = asScene(resolve(target));
      if ("layoutMode" in sn) {
        const frame = sn as FrameNode;
        frame.layoutMode = params.layoutMode ?? "NONE";
        if (params.padding) {
          frame.paddingTop = params.padding[0];
          frame.paddingRight = params.padding[1];
          frame.paddingBottom = params.padding[2];
          frame.paddingLeft = params.padding[3];
        }
        if (params.spacing !== undefined) frame.itemSpacing = params.spacing;
      }
      return serialize(sn);
    }
    case "setFill": {
      const sn = asScene(resolve(target));
      if ("fills" in sn) {
        (sn as any).fills = params.fill ? [{ type: "SOLID", color: params.fill }] : [];
      }
      return serialize(sn);
    }
    case "setStroke": {
      const sn = asScene(resolve(target));
      if ("strokes" in sn) {
        (sn as any).strokes = params.stroke ? [{ type: "SOLID", color: params.stroke }] : [];
        if (params.weight !== undefined) (sn as any).strokeWeight = params.weight;
      }
      return serialize(sn);
    }
    case "setEffect": {
      const sn = asScene(resolve(target));
      if ("effects" in sn) {
        // Just a stub for now
        (sn as any).effects = [];
      }
      return serialize(sn);
    }
    case "setTypography": {
      const sn = asScene(resolve(target));
      if (sn.type === "TEXT") {
        const text = sn as TextNode;
        if (params.fontSize) text.fontSize = params.fontSize;
      }
      return serialize(sn);
    }
    case "setVariable": {
      // Stub
      return serialize(resolve(target));
    }
    case "setStyle": {
      // Stub
      return serialize(resolve(target));
    }
    case "clone": {
      const sn = asScene(resolve(target));
      const cloned = sn.clone();
      if (params.x !== undefined) cloned.x = params.x;
      if (params.y !== undefined) cloned.y = params.y;
      figma.currentPage.appendChild(cloned);
      return serialize(cloned);
    }
    case "remove": {
      const sn = resolve(target);
      sn.remove();
      return { status: "removed" };
    }
    case "append": {
      const parent = resolve(params.parent);
      const child = asScene(resolve(params.child));
      if ("appendChild" in parent) {
        (parent as any).appendChild(child);
      }
      return serialize(child);
    }
    default:
      throw new Error(`Unknown native action: ${action}`);
  }
}
