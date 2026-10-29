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
import { beginNativeTransaction, commitNativeTransaction, noteMutation, rollbackNativeTransaction } from "./transaction";
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
  if (Array.isArray(value)) {
    let items: unknown[];
    try {
      items = (value as unknown[]).slice(0, 500);
    } catch {
      // Proxy-backed Figma arrays can refuse slicing; report instead of throw.
      return "[unserializable array]";
    }
    return items.map((item) => serializable(item, seen, depth + 1));
  }
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

    let entries: [string, unknown][];
    try {
      // Object.entries on Figma's dynamic-page proxy throws
      // "cannot convert to object" for some live values — guard it.
      entries = Object.entries(object).slice(0, 500);
    } catch {
      return "[unserializable object]";
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of entries) {
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
 * Counts raw-API mutations heuristically, without breaking Figma's own proxy.
 *
 * The `figdes` builder reports exact counts through noteMutation, but a raw
 * `figma.*` script bypasses it — so a script creating 25 nodes reported
 * mutations:0, which reads as "did nothing" next to a success status (and made
 * the rollback gate a no-op for raw scripts). This wrapper counts mutating
 * method calls plus property writes.
 *
 * How the wrapper avoids `proxy: inconsistent get` and
 * `cannot convert to object` (the faults that made every mutating
 * `figdes_use_figma` script fail, even a minimal one-rectangle probe):
 *
 * 1. The receiver forwarded into Figma's API is always the wrapped target —
 *    never the outer Proxy. Figma's internal safe proxy
 *    (documentAccess: "dynamic-page") validates the receiver it is invoked
 *    with; passing the outer Proxy as receiver throws
 *    `proxy: inconsistent get` on the first property read or write.
 * 2. Property reads and method results are returned unwrapped. Values keep
 *    their exact identity, so `node.fills = other.fills`,
 *    `node.children` traversal, and array round-trips never hand Figma a
 *    Proxy where a plain object is required — the trigger for
 *    `cannot convert to object` — and repeated reads are `===`-stable.
 *
 * Two antennas both feed noteMutation (a presence indicator for the rollback
 * gate, not an audit — they may double count): synchronous root-level
 * mutating calls plus property writes, and Figma's own documentchange events,
 * which also cover mutations on node objects that live below the wrapped
 * root. Mutating scripts observer the handler only for the duration of the
 * run and it is always removed in dispose().
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

function countingFigma(raw: typeof figma): {
  api: typeof figma;
  mutations: () => number;
  dispose: () => void;
} {
  let count = 0;

  // Document-level antenna: fires for every real content change (including
  // writes on unwrapped node objects) and feeds the transaction ledger, so a
  // failed raw script rolls back even when the synchronous count missed it.
  const onDocumentChange = (..._args: unknown[]): void => {
    try {
      noteMutation();
      count += 1;
    } catch {
      /* ledger closed already (committed/rolled back) — nothing to count on */
    }
  };
  try {
    raw.on("documentchange", onDocumentChange);
  } catch {
    /* host without documentchange support: synchronous count still applies */
  }

  const api = new Proxy(raw as unknown as object, {
    get(target, prop) {
      // Receiver is always `target`, never the outer Proxy — see above.
      const got = Reflect.get(target, prop, target);
      if (typeof got === "function" && typeof prop === "string") {
        const mutating = MUTATING_METHODS.has(prop);
        return (...args: unknown[]): unknown => {
          // Applying with `target` as `this` is exactly what the un-wrapped
          // `figma.method(...)` call would do — node methods keep receiver.
          const out = (got as (...a: unknown[]) => unknown).apply(target, args);
          if (mutating) {
            count += 1;
            noteMutation();
          }
          // Promises and results pass through unwrapped (identity-safe).
          return out;
        };
      }
      return got;
    },
    set(target, prop, next) {
      // Any property write through the root (rare — nodes are unwrapped) is a
      // mutation. Figma validates the receiver, so it must stay `target`.
      if (typeof prop === "string" && !prop.startsWith("__")) {
        count += 1;
        noteMutation();
      }
      return Reflect.set(target, prop, next, target);
    },
  }) as unknown as typeof figma;

  return {
    api,
    mutations: () => count,
    dispose() {
      try {
        raw.off("documentchange", onDocumentChange);
      } catch {
        /* ignore — disposal is best-effort */
      }
    },
  };
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
  let collector: ReturnType<typeof countingFigma> | null = null;

  try {
    // Raw `figma.*` calls bypass the builder's noteMutation tracking, so a
    // script creating 25 nodes reported mutations:0 next to a success status.
    // The wrapper observes mutating calls, property writes, and Figma's own
    // documentchange events (documented in countingFigma); the builder keeps
    // its exact count. Values pass through unwrapped, so scripts run exactly
    // as they would against the raw API.
    collector = countingFigma(figma);
    const execution = Promise.resolve(execute(
      collector.api,
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
        rawApiMutations: { count: collector.mutations(), heuristic: true },
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
    if (collector !== null) collector.dispose();
  }
}
