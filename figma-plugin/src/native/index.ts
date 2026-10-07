import { handleCreate } from "./create";
import { handleInspect } from "./inspect";
import { handleGeometry } from "./geometry";
import { handlePaint } from "./paint";
import { handleLayout } from "./layout";
import { handleTypography } from "./typography";
import { handleVectors } from "./vectors";
import { handleComponents } from "./components";
import { handleVariables } from "./variables";
import { handleStyles } from "./styles";
import { serialize, resolve, asScene } from "./utils";

export async function executeNativeCall(payload: any): Promise<any> {
  const { action, target, ...params } = payload;
  try {
    let res = await handleCreate(action, params);
    if (res !== null) return res;
    res = handleComponents(action, target, params);
    if (res !== null) return res;
    res = handleVariables(action, target, params);
    if (res !== null) return res;
    res = handleStyles(action, target, params);
    if (res !== null) return res;
    res = handleInspect(action, target, params);
    if (res !== null) return res;
    res = handleGeometry(action, target, params);
    if (res !== null) return res;
    res = handlePaint(action, target, params);
    if (res !== null) return res;
    res = handleLayout(action, target, params);
    if (res !== null) return res;
    res = await handleTypography(action, target, params);
    if (res !== null) return res;
    res = handleVectors(action, target, params);
    if (res !== null) return res;
    switch (action) {
      case "getPages":
        return figma.root.children.map((page) => ({ id: page.id, name: page.name }));
      case "createPage": {
        const page = figma.createPage();
        if (params.name) page.name = String(params.name);
        if (params.makeCurrent !== false) figma.currentPage = page;
        return { id: page.id, type: page.type, name: page.name };
      }
      case "setCurrentPage": {
        const page = resolve(target);
        if (page.type !== "PAGE") throw new Error("setCurrentPage requires a PAGE target.");
        figma.currentPage = page as PageNode;
        return { id: page.id, type: page.type, name: page.name };
      }
      case "beginNativeTransaction":
        figma.commitUndo();
        return { status: "transaction-open" };
      case "commitNativeTransaction":
        figma.commitUndo();
        return { status: "transaction-committed" };
      case "rollbackNativeTransaction":
        figma.triggerUndo();
        return { status: "transaction-rolled-back" };
      case "setIsMask": {
        const node = asScene(resolve(target)) as any;
        if (!("isMask" in node)) throw new Error("Target does not support masks.");
        node.isMask = Boolean(params.value);
        return serialize(node);
      }
      case "setOverflowDirection": {
        const node = asScene(resolve(target)) as any;
        if (!("overflowDirection" in node)) throw new Error("Target does not support overflowDirection.");
        node.overflowDirection = params.value;
        return serialize(node);
      }
      default:
        throw new Error(`Unknown native action: ${action}`);
    }
  } catch (err: any) {
    throw new Error(`Native execution failed: ${err.message}`);
  }
}
