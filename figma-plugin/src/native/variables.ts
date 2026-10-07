import { resolve, serialize } from "./utils";

type AnyVariable = {
  id: string;
  name: string;
  resolvedType: string;
  variableCollectionId: string;
  description?: string;
  scopes?: unknown;
  setValueForMode: (modeId: string, value: unknown) => void;
};

type AnyCollection = {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  defaultModeId?: string;
  variableIds: string[];
  addMode?: (name: string) => string;
};

async function listCollections(): Promise<AnyCollection[]> {
  const api = figma.variables as unknown as {
    getLocalVariableCollectionsAsync?: () => Promise<AnyCollection[]>;
    getLocalVariableCollections?: () => AnyCollection[];
  };
  if (typeof api.getLocalVariableCollectionsAsync === "function") return api.getLocalVariableCollectionsAsync();
  return api.getLocalVariableCollections?.() ?? [];
}

async function listVariables(): Promise<AnyVariable[]> {
  const api = figma.variables as unknown as {
    getLocalVariablesAsync?: () => Promise<AnyVariable[]>;
    getLocalVariables?: () => AnyVariable[];
  };
  if (typeof api.getLocalVariablesAsync === "function") return api.getLocalVariablesAsync();
  return api.getLocalVariables?.() ?? [];
}

async function getVariable(id: string): Promise<AnyVariable | null> {
  const api = figma.variables as unknown as {
    getVariableByIdAsync?: (id: string) => Promise<AnyVariable | null>;
    getVariableById?: (id: string) => AnyVariable | null;
  };
  if (typeof api.getVariableByIdAsync === "function") return api.getVariableByIdAsync(id);
  return api.getVariableById?.(id) ?? null;
}

function defaultModeId(collection: AnyCollection): string | undefined {
  return collection.defaultModeId ?? collection.modes[0]?.modeId;
}

async function ensureCollection(collectionId?: string, collectionName?: string): Promise<AnyCollection> {
  const collections = await listCollections();
  if (collectionId) {
    const byId = collections.find((c) => c.id === collectionId);
    if (byId) return byId;
    const byName = collections.find((c) => c.name === collectionId);
    if (byName) return byName;
  }
  if (collectionName) {
    const byName = collections.find((c) => c.name === collectionName);
    if (byName) return byName;
  }
  // No collection named: create a default so a variable can always land
  // somewhere predictable instead of failing for want of a collection id.
  return figma.variables.createVariableCollection(collectionName ?? "FigDes") as unknown as AnyCollection;
}

function summarize(v: AnyVariable): Record<string, unknown> {
  return {
    id: v.id,
    name: v.name,
    type: v.resolvedType,
    collectionId: v.variableCollectionId,
    description: v.description ?? "",
    scopes: v.scopes ?? [],
  };
}

export async function handleVariables(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "listVariables":
      return (await listVariables()).map(summarize);

    case "findVariable": {
      const query = String(params.query ?? "").toLowerCase();
      return (await listVariables())
        .filter((v) => v.id.toLowerCase().includes(query) || v.name.toLowerCase().includes(query))
        .map((v) => ({ id: v.id, name: v.name, type: v.resolvedType, collectionId: v.variableCollectionId }));
    }

    case "createVariable": {
      const name = String(params.name);
      const type = String(params.type);
      const collection = await ensureCollection(params.collectionId as string | undefined, params.collection as string | undefined);
      // Pass the collection *id*, which is what the real API expects.
      const variable = figma.variables.createVariable(name, collection.id, type as VariableResolvedDataType) as unknown as AnyVariable;
      if (params.description !== undefined) variable.description = String(params.description);

      if (params.value !== undefined) {
        const modeId = defaultModeId(collection);
        if (modeId) variable.setValueForMode(modeId, params.value);
      }
      return summarize(variable);
    }

    case "setVariableValue": {
      const variable = await getVariable(String(params.variableId));
      if (!variable) throw new Error(`Variable ${params.variableId} not found.`);
      const collections = await listCollections();
      const collection = collections.find((c) => c.id === variable.variableCollectionId);
      if (!collection) throw new Error(`Variable collection ${variable.variableCollectionId} not found.`);
      const modeId = (params.modeId as string | undefined) ?? defaultModeId(collection);
      if (!modeId) throw new Error(`Variable collection ${collection.name} has no modes.`);
      variable.setValueForMode(modeId, params.value);
      return { id: variable.id, name: variable.name, modeId, value: params.value };
    }

    case "bindVariable": {
      const node = (await resolve(target)) as unknown as { setBoundVariable?: (field: string, variable: unknown) => void };
      if (typeof node.setBoundVariable !== "function") {
        throw new Error("Target node does not support variable binding.");
      }
      const variable = await getVariable(String(params.variableId));
      if (!variable) throw new Error(`Variable ${params.variableId} not found.`);
      node.setBoundVariable(String(params.field), variable);
      return serialize((await resolve(target)) as never);
    }
  }
  return null;
}
