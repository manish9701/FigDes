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
 * Observes raw-API mutations without ever proxying Figma's API.
 *
 * The `figdes` builder reports exact counts through noteMutation, but a raw
 * `figma.*` script bypasses it — so a script creating 25 nodes reported
 * mutations:0, which reads as "did nothing" next to a success status (and made
 * the rollback gate a no-op for raw scripts).
 *
 * A JS Proxy wrapper around `figma` was tried to close that gap and removed:
 * under Figma's sandbox (QuickJS) the called object is itself a proxy under
 * `documentAccess: "dynamic-page"`, and wrapping it in another JS Proxy trips
 * QuickJS's proxy invariants (`proxy: inconsistent get`) no matter how the
 * traps forward — live-measured on 2026-10-29 against the fixed receiver and
 * identity-preserving variant. Meanwhile the SAME calls succeed untouched —
 * the builder path (raw `figma`, direct calls) commits cleanly, and a script
 * speaking only the builder built, loaded fonts, and read back node state.
 *
 * So scripts now receive the raw `figma` they would have in any normal
 * plugin, and mutations are observed through Figma's own `documentchange`
 * events instead. documentchange is batched asynchronously: it fires after
 * the mutation, on a later task — so the observer is disposed on a delay
 * (LATE_DISPOSE_MS) and the failure path of the script runner waits one short
 * turn of the event loop before making the rollback decision, letting events
 * for changes made just before a throw land in the ledger first.
 */
const LATE_DISPOSE_MS = 750;

function mutationObserver(raw: typeof figma): {
  mutations: () => number;
  dispose: () => void;
} {
  let count = 0;
  const onDocumentChange = (..._args: unknown[]): void => {
    count += 1;
    // Separately guarded: once the owning transaction commits or rolls back,
    // noteMutation throws (ledger closed) — the count itself must survive so
    // the report still says how many changes the script made.
    try {
      noteMutation();
    } catch {
      /* ledger closed already — nothing to count on */
    }
  };
  try {
    raw.on("documentchange", onDocumentChange);
  } catch {
    /* host without documentchange support: the ledger stays on the builder */
  }
  return {
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

/** Disposes the observer on a delay, unlike `finally` disposal which races the
 * batched documentchange dispatch itself. Never throws. */
function lateDispose(observer: ReturnType<typeof mutationObserver> | null): void {
  if (observer === null) return;
  const self = observer;
  setTimeout(() => {
    try {
      self.dispose();
    } catch {
      /* ignore — disposal is best-effort */
    }
  }, LATE_DISPOSE_MS);
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
  let observer: ReturnType<typeof mutationObserver> | null = null;

  try {
    // Scripts run against the RAW `figma` object — proxies around it are
    // unsound under Figma's QuickJS sandbox (see mutationObserver). Raw
    // `figma.*` mutations bypass the builder's noteMutation, so a
    // documentchange observer fills the ledger instead (documented in
    // mutationObserver); the builder keeps its exact count. The two can
    // overlap: the ledger treats the total as a presence indicator, not an
    // audit.
    observer = mutationObserver(figma);
    const builder = createFigdesBuilder(figma);
    const execution = Promise.resolve(execute(
      figma,
      Math,
      JSON,
      Date,
      console,
      builder,
    ));

    // Warm the common text styles while the script runs: its first text call
    // then shares this load instead of paying it synchronously. Fire-and-forget
    // — the warmup must never delay or fail the script itself.
    void builder.preloadFonts();

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
      // documentchange is batched asynchronously; without this wait the
      // commit lands before the events for the script's own changes do, so
      // the ledger reports mutations:0 next to a successful build. One short
      // let of the event loop is enough for the batched dispatch, and keeps
      // the gate honest for both success reports and later rollbacks.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const committed = commitNativeTransaction(transactionId);
      return {
        status: "success",
        transactionId,
        result: serializable(result),
        transaction: committed,
        rawApiMutations: { count: observer.mutations(), heuristic: true, source: "documentchange" },
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
    // documentchange is batched asynchronously — events for changes made just
    // before the throw have not been dispatched yet. One short turn of the
    // event loop lets them land in the ledger first, so the rollback gate
    // sees them and actually undoes instead of reporting a no-op for work
    // the script did do.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return rollbackResult(transactionId, error);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    // Late disposal: an immediate unsubscribe races the batched
    // documentchange dispatch, which lands after this call returns. The
    // observer stays ≤750ms and is then removed by lateDispose.
    lateDispose(observer);
  }
}
