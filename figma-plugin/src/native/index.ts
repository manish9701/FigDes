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
import { resolve, serialize, asScene, resolveBatchRefs } from "./utils";
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
  // `readonly` is a transport-level execution flag, not an action parameter:
  // strip it before strict schema validation so it is never mistaken for one.
  const { action, target, transactionId, readonly, ...rest } = raw;

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

  // Read-only scripts opt out of the transaction entirely so inspection can run
  // concurrently with nothing to roll back. A mutation smuggled into a
  // readonly script is refused here rather than landing unprotected. Batches
  // pass through to per-operation checks so a batch of pure reads still runs.
  const readonlyMode = readonly === true;
  if (readonlyMode && def.mutates && action !== "executeBatch") {
    throw new Error(`Native action ${action} mutates the document and is refused in a readonly script. Run it without readonly instead.`);
  }

  if (action === "executeBatch") {
    return executeBatchOps(
      params.operations as Array<{ action: string; target?: string | { $ref: string }; params?: Record<string, unknown>; ref?: string }>,
      txnId,
      params.compact !== false,
      readonlyMode,
    );
  }

  const result = await dispatch(action, target as string | undefined, params);

  if (def.mutates && txnId !== undefined) noteMutation();
  return result;
}

/**
 * Native Batch Execution: many actions, one round-trip.
 *
 * Every operation runs locally inside the plugin through the same
 * validate-then-dispatch path as an individual call, so the allowlist,
 * parameter validation and transaction gating are identical — only the
 * WebSocket/postMessage round-trips collapse from N to 1. `ref` names on
 * creation operations become `$ref` addresses for later operations in the same
 * batch, so create → style → resize → parent → align chains resolve locally.
 *
 * The batch inherits the caller's native transaction: a failure at any index
 * throws with the index attached and the surrounding rollback restores the
 * document, exactly as if the operations had arrived one by one.
 */
async function executeBatchOps(
  operations: Array<{ action: string; target?: string | { $ref: string }; params?: Record<string, unknown>; ref?: string }>,
  txnId: string | undefined,
  compact: boolean,
  readonly: boolean,
): Promise<{ results: Array<Record<string, unknown>>; opCount: number; pluginMs: number }> {
  const started = Date.now();
  const refs = new Map<string, string>();
  const results: Array<Record<string, unknown>> = [];

  for (let i = 0; i < operations.length; i++) {
    const item = operations[i]!;
    const def = NATIVE_ACTIONS[item.action];
    if (!def) {
      throw new Error(`Batch op ${i} failed: unknown native action '${item.action}'. Known actions: ${NATIVE_ACTION_NAMES.join(", ")}.`);
    }
    if (readonly && def.mutates) {
      throw new Error(`Batch op ${i} (${item.action}) mutates the document and is refused in a readonly batch.`);
    }
    let target: string | undefined;
    try {
      const resolved = resolveBatchRefs(
        { target: item.target ?? null, params: item.params ?? {} },
        refs,
      ) as { target: unknown; params: Record<string, unknown> };
      target = typeof resolved.target === "string" ? resolved.target : undefined;
      const parsed = def.params.safeParse(resolved.params);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue?.path.join(".") ?? "";
        throw new Error(`Invalid parameters for ${item.action}${path ? ` (${path})` : ""}: ${issue?.message ?? "schema mismatch"}.`);
      }
      if (def.mutates && txnId !== undefined) assertOpen(txnId);
      const res = await dispatch(item.action, target, parsed.data as Record<string, unknown>);
      if (def.mutates && txnId !== undefined) noteMutation();
      else if (def.mutates) noteMutation();
      const entry = compactResult(item.ref, res, compact);
      if (item.ref) {
        const id = (entry as Record<string, unknown>).id;
        if (typeof id === "string") refs.set(item.ref, id);
      }
      results.push(entry);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Batch op ${i} (${item.action}) failed: ${msg}`);
    }
  }

  return { results, opCount: operations.length, pluginMs: Date.now() - started };
}

/** Compact id+bounds evidence for fast mutation mode; full summaries on demand. */
function compactResult(ref: string | undefined, res: unknown, compact: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = ref !== undefined ? { ref } : {};
  if (!compact) return { ...base, value: res };
  if (res !== null && typeof res === "object" && !Array.isArray(res)) {
    const o = res as Record<string, unknown>;
    if (typeof o.id === "string") {
      for (const k of ["id", "type", "name", "x", "y", "width", "height", "childCount"]) {
        if (o[k] !== undefined) base[k] = o[k];
      }
      return base;
    }
  }
  const text = JSON.stringify(res);
  return { ...base, value: text.length > 500 ? `${text.slice(0, 500)}…` : text };
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
