/**
 * Native action dispatcher (spec §19).
 *
 * Every call is validated against `NATIVE_ACTIONS` before it reaches a handler,
 * so an unknown action or a malformed parameter is rejected here with a message
 * that names the problem, instead of failing deep inside the Figma Plugin API.
 *
 * Mutating calls that name a transaction are gated on that transaction being
 * open, and every mutation is counted so a rollback knows whether it has
 * anything to undo. See transaction.ts for why that state is explicit.
 */
import { handleCreate } from "./create";
import { handleContext } from "./context";
import { handleInspect } from "./inspect";
import { handleGeometry } from "./geometry";
import { handlePaint } from "./paint";
import { handleLayout } from "./layout";
import { handleTypography } from "./typography";
import { handleVectors } from "./vectors";
import { handleComponents } from "./components";
import { handleVariables } from "./variables";
import { handleStyles } from "./styles";
import { resolve, serialize, asScene } from "./utils";
import { NATIVE_ACTIONS, NATIVE_ACTION_NAMES } from "./schema";
import {
  assertOpen,
  beginNativeTransaction,
  commitNativeTransaction,
  noteMutation,
  rollbackNativeTransaction,
} from "./transaction";

export interface NativeCallResult {
  [key: string]: unknown;
}

export async function executeNativeCall(payload: unknown): Promise<unknown> {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const { action, target, transactionId, ...rest } = raw;

  if (typeof action !== "string" || action.length === 0) {
    throw new Error("A native call needs an `action`.");
  }

  const def = NATIVE_ACTIONS[action];
  if (!def) {
    throw new Error(`Unknown native action: ${action}. Known actions: ${NATIVE_ACTION_NAMES.join(", ")}.`);
  }

  const parsed = def.params.safeParse(rest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") ?? "";
    throw new Error(`Invalid parameters for ${action}${path ? ` (${path})` : ""}: ${issue?.message ?? "schema mismatch"}.`);
  }
  const params = parsed.data as Record<string, unknown>;

  const txnId = typeof transactionId === "string" ? transactionId : undefined;

  // Transaction control is handled before the mutation gate: a rollback must be
  // allowed to run even though it is not itself a mutation.
  if (action === "beginNativeTransaction") {
    return beginNativeTransaction(txnId ?? "txn");
  }
  if (action === "commitNativeTransaction") {
    return commitNativeTransaction(txnId);
  }
  if (action === "rollbackNativeTransaction") {
    return rollbackNativeTransaction(txnId);
  }

  // A mutating call that names a transaction must belong to the open one. After
  // a rollback the state is closed, so a late in-flight call from an aborted
  // script is rejected here rather than mutating a restored document.
  if (def.mutates && txnId !== undefined) {
    assertOpen(txnId);
  }

  const result = await dispatch(action, target as string | undefined, params);

  if (def.mutates && txnId !== undefined) noteMutation();
  return result;
}

async function dispatch(action: string, target: string | undefined, params: Record<string, unknown>): Promise<unknown> {
  let res = await handleContext(action, target, params);
  if (res !== null) return res;

  res = await handleCreate(action, params);
  if (res !== null) return res;

  res = await handleComponents(action, target, params);
  if (res !== null) return res;

  res = await handleVariables(action, target, params);
  if (res !== null) return res;

  res = await handleStyles(action, target, params);
  if (res !== null) return res;

  res = await handleInspect(action, target, params);
  if (res !== null) return res;

  res = await handleGeometry(action, target, params);
  if (res !== null) return res;

  res = await handlePaint(action, target, params);
  if (res !== null) return res;

  res = await handleLayout(action, target, params);
  if (res !== null) return res;

  res = await handleTypography(action, target, params);
  if (res !== null) return res;

  res = await handleVectors(action, target, params);
  if (res !== null) return res;

  switch (action) {
    case "getPages":
      return figma.root.children.map((page) => ({ id: page.id, name: page.name, childCount: page.children.length }));

    case "createPage": {
      const page = figma.createPage();
      if (params.name) page.name = String(params.name);
      if (params.makeCurrent !== false) figma.currentPage = page;
      return { id: page.id, type: page.type, name: page.name };
    }

    case "setCurrentPage": {
      const page = await resolve(target);
      if (page.type !== "PAGE") throw new Error("setCurrentPage requires a PAGE target.");
      figma.currentPage = page as PageNode;
      return { id: page.id, type: page.type, name: page.name };
    }

    case "setIsMask": {
      const node = asScene(await resolve(target)) as unknown as { isMask?: boolean };
      if (!("isMask" in node)) throw new Error("Target does not support masks.");
      node.isMask = Boolean(params.value);
      return serialize(await resolve(target));
    }

    case "setOverflowDirection": {
      const node = asScene(await resolve(target)) as unknown as { overflowDirection?: string };
      if (!("overflowDirection" in node)) throw new Error("Target does not support overflowDirection.");
      node.overflowDirection = String(params.value);
      return serialize(await resolve(target));
    }
  }

  throw new Error(`Native action ${action} is declared but has no handler. This is a plugin bug.`);
}
