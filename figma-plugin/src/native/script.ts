/**
 * Native Figma Plugin API executor.
 *
 * The raw API is available for maximum expressiveness, while the injected
 * \`figdes\` builder provides a safer, higher-level composition layer.
 *
 * Important: JavaScript promises cannot be forcibly cancelled in the Figma
 * plugin main thread. The timeout below is therefore a watchdog: on expiry we
 * wait for the in-flight script to settle before rolling back. That prevents
 * the old "timeout -> rollback -> late mutation" race.
 */
import { beginNativeTransaction, commitNativeTransaction, rollbackNativeTransaction } from "./transaction";
import { createFigdesBuilder } from "./builder";

const MAX_SCRIPT_SIZE = 160_000;
const MAX_EXECUTION_MS = 300_000;
interface ScriptPayload {
  script?: unknown;
  transactionId?: unknown;
  readonly?: unknown;
  timeoutMs?: unknown;
}

function serializable(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => serializable(item, seen, depth + 1));
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[circular]";
    seen.add(value as object);

    const object = value as Record<string, unknown>;
    if (typeof object.id === "string" && typeof object.type === "string") {
      const node = value as {
        id: string; type: string; name?: string; x?: number; y?: number; width?: number; height?: number;
      };
      return {
        id: node.id,
        type: node.type,
        ...(node.name !== undefined ? { name: node.name } : {}),
        ...(node.x !== undefined ? { x: node.x } : {}),
        ...(node.y !== undefined ? { y: node.y } : {}),
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
      };
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object).slice(0, 500)) {
      out[key] = serializable(child, seen, depth + 1);
    }
    return out;
  }
  return String(value);
}

function rollbackResult(transactionId: string, error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const rollback = rollbackNativeTransaction(transactionId);
    return {
      status: "failed",
      transactionId,
      rolledBack: rollback.rolledBack === true,
      error: {
        code: "FIGMA_API_ERROR",
        message,
        recovery: "Inspect the returned error, fix the script, and retry. Failed mutating scripts are rolled back.",
      },
      rollback,
    };
  } catch (rollbackError) {
    return {
      status: "failed",
      transactionId,
      rolledBack: false,
      error: {
        code: "FIGMA_API_ERROR",
        message,
        recovery: "Rollback failed. Inspect the current canvas before retrying.",
      },
      rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
    };
  }
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_EXECUTION_MS;
  return Math.max(5_000, Math.min(MAX_EXECUTION_MS, Math.floor(value)));
}

/**
 * Counts raw-API mutations heuristically.
 *
 * The `figdes` builder reports exact counts through noteMutation, but a raw
 * `figma.*` script bypasses it — so a script creating 25 nodes reported
 * mutations:0, which reads as "did nothing" next to a success status. This
 * wraps the injected `figma` object and counts mutating method calls plus
 * property writes. It is a heuristic, not an audit: exotic mutators may be
 * missed (undercount, never overclaim), and the count is labelled as such.
 * Reads (getNodeByIdAsync, currentPage access without writes, findAll…)
 * never count.
 */
const MUTATING_METHODS = new Set([
  "createFrame", "createRectangle", "createEllipse", "createPolygon", "createStar",
  "createLine", "createText", "createVector", "createConnector", "createComponent",
  "createComponentSet", "createInstance", "createPage", "createSlice",
  "createBooleanOperation", "flatten", "subtract", "union", "intersect", "exclude",
  "appendChild", "insertChild", "remove", "clone", "resize", "rescale",
  "group", "ungroup", "detachInstance", "swapComponent", "swapStyle",
  "setPluginData", "setSharedPluginData", "setRelaunchData",
  "addOnDocumentChange", "notify",
]);
const READ_METHODS = new Set([
  "getNodeByIdAsync", "getStyleByIdAsync", "loadFontAsync", "listAvailableFontsAsync",
  "loadAllPagesAsync", "getLocalPaintStylesAsync", "getLocalTextStylesAsync",
  "getLocalEffectStylesAsync", "getLocalGridStylesAsync",
  "findAll", "findOne", "findAllWithCriteria", "findChildren",
  "getImageByHashAsync", "createImageAsync",
]);

function countingFigma(raw: typeof figma): { api: typeof figma; mutations: () => number } {
  let count = 0;
  const wrap = (value: unknown, depth: number): unknown => {
    if (depth > 4 || value === null || (typeof value !== "object" && typeof value !== "function")) return value;
    if (typeof value === "function") {
      // Detached by construction (a return value, not a method access): the
      // original call would have no receiver either, so counting is all we do.
      const fn = value as (...args: unknown[]) => unknown;
      const name = fn.name ?? "";
      return (...args: unknown[]): unknown => {
        if (MUTATING_METHODS.has(name)) count += 1;
        const out = fn(...args);
        if (out !== null && (typeof out === "object" || typeof out === "function")) return wrap(out, depth + 1);
        return out;
      };
    }
    return new Proxy(value as object, {
      get(target, prop, receiver) {
        const got = Reflect.get(target, prop, receiver);
        // Methods keep their receiver: Figma API calls may depend on `this`,
        // and an unbound wrapper would break them while counting correctly.
        if (typeof got === "function" && typeof prop === "string") {
          const mutating = MUTATING_METHODS.has(prop) || (!READ_METHODS.has(prop) && /^[A-Z]/.test(prop));
          return (...args: unknown[]): unknown => {
            if (mutating) count += 1;
            const out = Reflect.apply(got as (...a: unknown[]) => unknown, target, args);
            if (out !== null && (typeof out === "object" || typeof out === "function")) return wrap(out, depth + 1);
            return out;
          };
        }
        if (got !== null && (typeof got === "object" || typeof got === "function")) return wrap(got, depth + 1);
        return got;
      },
      set(target, prop, next, receiver) {
        // Any property write on a node (x, fills, characters…) is a mutation.
        // Reads of figma.currentPage etc. never reach here as sets.
        if (typeof prop === "string" && !prop.startsWith("__")) count += 1;
        return Reflect.set(target, prop, next, receiver);
      },
    });
  };
  return { api: wrap(raw, 0) as typeof figma, mutations: () => count };
}

export async function executeFigmaScript(payload: unknown): Promise<Record<string, unknown>> {
  const input = (payload ?? {}) as ScriptPayload;
  const script = input.script;
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new Error("execute_figma_script needs a non-empty script.");
  }
  if (script.length > MAX_SCRIPT_SIZE) {
    throw new Error("execute_figma_script script exceeds " + MAX_SCRIPT_SIZE + " characters.");
  }

  const transactionId =
    typeof input.transactionId === "string" && input.transactionId.length > 0
      ? input.transactionId
      : "plugin_tx_" + Date.now();
  const readonlyMode = input.readonly === true;
  const timeoutMs = clampTimeout(input.timeoutMs);

  if (!readonlyMode) beginNativeTransaction(transactionId);

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
    new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

  const execute = new AsyncFunction(
    "figma",
    "Math",
    "JSON",
    "Date",
    "console",
    "figdes",
    script,
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    // Raw `figma.*` calls bypass the builder's noteMutation tracking, so a
    // script creating 25 nodes reported mutations:0 next to a success status.
    // The counting wrapper observes mutating calls and property writes
    // heuristically (documented in countingFigma); the builder keeps its
    // exact count. The two paths are disjoint, so the total never double
    // counts.
    const counted = countingFigma(figma);
    const execution = Promise.resolve(execute(
      counted.api,
      Math,
      JSON,
      Date,
      console,
      createFigdesBuilder(figma),
    ));

    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new Error("Figma script exceeded " + timeoutMs + "ms. Waiting for the in-flight script to settle before rollback."));
      }, timeoutMs);
    });

    let result: unknown;
    try {
      result = await Promise.race([execution, timeout]);
    } catch (error) {
      if (!timedOut) throw error;
      // Promise.race cannot cancel the script. Await it before rollback so a
      // late Figma mutation can never land after the document is restored.
      try { await execution; } catch { /* rollback below records the original timeout */ }
      throw error;
    }

    if (!readonlyMode) {
      const committed = commitNativeTransaction(transactionId);
      return {
        status: "success",
        transactionId,
        result: serializable(result),
        transaction: committed,
        rawApiMutations: { count: counted.mutations(), heuristic: true },
      };
    }

    return { status: "success", readonly: true, result: serializable(result) };
  } catch (error) {
    if (readonlyMode) {
      return {
        status: "failed",
        readonly: true,
        error: {
          code: timedOut ? "FIGMA_SCRIPT_TIMEOUT" : "FIGMA_API_ERROR",
          message: error instanceof Error ? error.message : String(error),
          recovery: timedOut
            ? "The script was allowed to settle before returning. Reduce the script size or split the work into safe phases."
            : "Fix the Plugin API script and retry.",
        },
      };
    }
    return rollbackResult(transactionId, error);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
