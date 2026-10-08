/** Direct Figma Plugin API executor. The Figma API itself is the abstraction. */
import { beginNativeTransaction, commitNativeTransaction, rollbackNativeTransaction } from "./transaction";

const MAX_SCRIPT_SIZE = 120_000;
const MAX_EXECUTION_MS = 300_000;
interface ScriptPayload { script?: unknown; transactionId?: unknown; readonly?: unknown; }

function serializable(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(serializable);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string" && typeof object.type === "string") {
      const node = value as { id: string; type: string; name?: string; x?: number; y?: number; width?: number; height?: number };
      return { id: node.id, type: node.type, ...(node.name !== undefined ? { name: node.name } : {}), ...(node.x !== undefined ? { x: node.x } : {}), ...(node.y !== undefined ? { y: node.y } : {}), ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}) };
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) out[key] = serializable(child);
    return out;
  }
  return String(value);
}

function rollbackResult(transactionId: string, error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const rollback = rollbackNativeTransaction(transactionId);
    return { status: "failed", transactionId, rolledBack: rollback.rolledBack === true, error: { code: "FIGMA_API_ERROR", message, recovery: "Fix the Plugin API script and retry. Failed mutating scripts are rolled back." }, rollback };
  } catch (rollbackError) {
    return { status: "failed", transactionId, rolledBack: false, error: { code: "FIGMA_API_ERROR", message, recovery: "Rollback failed. Inspect the current canvas before retrying." }, rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) };
  }
}

export async function executeFigmaScript(payload: unknown): Promise<Record<string, unknown>> {
  const input = (payload ?? {}) as ScriptPayload;
  const script = input.script;
  if (typeof script !== "string" || script.trim().length === 0) throw new Error("execute_figma_script needs a non-empty script.");
  if (script.length > MAX_SCRIPT_SIZE) throw new Error(`execute_figma_script script exceeds ${MAX_SCRIPT_SIZE} characters.`);
  const transactionId = typeof input.transactionId === "string" && input.transactionId.length > 0 ? input.transactionId : `plugin_tx_${Date.now()}`;
  const readonlyMode = input.readonly === true;
  if (!readonlyMode) beginNativeTransaction(transactionId);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;
  const execute = new AsyncFunction("figma", "Math", "JSON", "Date", "console", script);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`Figma script exceeded ${MAX_EXECUTION_MS}ms.`)), MAX_EXECUTION_MS);
    });
    const result = await Promise.race([execute(figma, Math, JSON, Date, console), timeout]);
    if (!readonlyMode) return { status: "success", transactionId, result: serializable(result), transaction: commitNativeTransaction(transactionId) };
    return { status: "success", readonly: true, result: serializable(result) };
  } catch (error) {
    if (readonlyMode) return { status: "failed", readonly: true, error: { code: "FIGMA_API_ERROR", message: error instanceof Error ? error.message : String(error), recovery: "Fix the Plugin API script and retry." } };
    return rollbackResult(transactionId, error);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
