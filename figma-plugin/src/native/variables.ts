import { resolve, serialize } from "./utils";

export function handleVariables(action: string, target: any, params: any) {
  switch (action) {
    case "listVariables":
      return figma.variables.getLocalVariables().map((v: any) => ({
        id: v.id,
        name: v.name,
        key: v.key,
        type: v.resolvedType,
        collectionId: v.variableCollectionId,
        description: v.description ?? "",
        scopes: v.scopes ?? []
      }));

    case "findVariable": {
      const query = String(params.query ?? "").toLowerCase();
      return figma.variables.getLocalVariables()
        .filter((v: any) => v.id.toLowerCase().includes(query) || v.name.toLowerCase().includes(query))
        .map((v: any) => ({ id: v.id, name: v.name, type: v.resolvedType, collectionId: v.variableCollectionId }));
    }

    case "createVariable": {
      if (!params.name || !params.collectionId || !params.type) {
        throw new Error("createVariable requires name, collectionId and type.");
      }
      const variable = figma.variables.createVariable(params.name, params.collectionId, params.type);
      if (params.description !== undefined) variable.description = params.description;
      return { id: variable.id, name: variable.name, type: variable.resolvedType, collectionId: variable.variableCollectionId };
    }

    case "setVariableValue": {
      const variable = figma.variables.getVariableById(params.variableId);
      if (!variable) throw new Error(`Variable ${params.variableId} not found.`);
      const collection = figma.variables.getVariableCollectionById(variable.variableCollectionId);
      if (!collection) throw new Error(`Variable collection ${variable.variableCollectionId} not found.`);
      const modeId = params.modeId ?? collection.defaultModeId;
      variable.setValueForMode(modeId, params.value);
      return { id: variable.id, name: variable.name, modeId, value: params.value };
    }

    case "bindVariable": {
      const node = resolve(target) as any;
      if (typeof node.setBoundVariable !== "function") {
        throw new Error("Target node does not support variable binding.");
      }
      const variable = figma.variables.getVariableById(params.variableId);
      if (!variable) throw new Error(`Variable ${params.variableId} not found.`);
      node.setBoundVariable(params.field, variable);
      return serialize(node);
    }
  }
  return null;
}
