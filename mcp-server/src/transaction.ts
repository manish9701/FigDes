/**
 * Tracked, idempotent, preflighted dispatch for every mutating plugin call.
 *
 * One transactionId → one ledger record → one result. A retry with the SAME
 * transactionId returns the prior result instead of duplicating nodes; a bad
 * request fails in preflight before the WebSocket/document is contacted; every
 * outcome updates the job ledger and the latency/rollback metrics.
 *
 * Timeout/disconnect semantics: the Figma main thread keeps running after the
 * server stops waiting, so those paths mark the job `timed-out` (outcome
 * unknown) instead of `failed`. A late plugin answer reconciles the record via
 * the socket router; until then any same-id retry is refused with a
 * reconcile-first error rather than dispatched as a duplicate.
 *
 * ## Why this lives in its own module
 *
 * Every path that mutates the document has to go through it, and there are
 * three of them: the low-level tools, the semantic runtime, and the design
 * pipeline. When the dispatcher lived inside the tool table, the runtime
 * reached the plugin directly and bypassed the ledger — so a retried runtime
 * build duplicated the whole screen, and a timed-out one left nothing to
 * reconcile against. One dispatcher, three callers, one set of semantics.
 */
import { randomUUID } from "node:crypto";
import type { TransactionResult } from "../../shared/protocol";
import {
  TransactionTimeoutError,
  SessionDisconnectedError,
  type Session,
  type SessionRegistry,
} from "./sessions";
import { validateTransaction } from "./preflight";
import { withDocumentLock, DocumentLockBusyError } from "./native/lock";
import {
  recordDuplicateRetry,
  recordPreflightCatch,
  recordRollback,
  recordToolCall,
  recordTransaction,
} from "./metrics";

/**
 * A failed transaction is thrown as an MCP tool error rather than returned as a
 * successful payload. Returning `{status:"failed"}` as a *success* invites the
 * model to gloss over it and report the design as done.
 */
export function assertTransaction(result: TransactionResult): TransactionResult {
  if (result.status === "failed") {
    const { operation, opType, message, hint, rolledBackNote } = result.error;
    const where = operation >= 0 ? `operation #${operation} (${opType})` : "the plan";
    throw new Error(
      `Figma rejected the transaction at ${where}: ${message}\n` +
        `Document state: ${rolledBackNote}\n` +
        `Next step: ${hint}`,
    );
  }
  return result;
}

export async function dispatchTransaction(
  registry: SessionRegistry,
  session: Session,
  tool: "create_design" | "modify_design" | "update_component" | "native_design",
  payload: { description?: string; operations: unknown[]; dryRun?: boolean; transactionId?: string; targets?: string[] },
): Promise<TransactionResult> {
  const transactionId = payload.transactionId ?? `txn_${randomUUID().slice(0, 8)}`;
  const ops = payload.operations as unknown[];

  const prior = registry.jobs.priorResult(transactionId);
  if (prior && (prior as { status?: string }).status === "success") {
    recordDuplicateRetry();
    return prior as TransactionResult;
  }

  // Same-id retry while the first attempt is still in flight (or timed out
  // with an unknown outcome) must NOT dispatch a second copy: if the first run
  // commits late, the duplicate creates the same nodes twice.
  const existing = registry.jobs.get(transactionId);
  if (existing && (existing.state === "queued" || existing.state === "preflight" || existing.state === "applying" || existing.state === "verifying")) {
    throw new Error(
      `Transaction ${transactionId} is already ${existing.state} (${existing.done}/${existing.operationCount} ops). Do not dispatch a duplicate: wait for progress, then call get_job_status with this transactionId. A retry must reuse the SAME transactionId only after the ledger settles to committed, rolled-back, partial-rollback, failed or timed-out.`,
    );
  }
  if (existing && existing.state === "timed-out") {
    throw new Error(
      `Transaction ${transactionId} timed out with an unknown outcome and has not reconciled yet. Do NOT retry blindly: call get_job_status with this transactionId first — a late result may already have committed it. Inspect the target subtree for partial work, then retry with the SAME transactionId only once the ledger shows a terminal state or you have confirmed nothing landed.`,
    );
  }

  const preflight = validateTransaction(ops);
  if (!preflight.ok) {
    recordPreflightCatch(preflight.issues.length);
    registry.jobs.begin({ transactionId, tool, session, operationCount: ops.length });
    registry.jobs.complete(transactionId, "failed", { error: preflight.issues[0]?.message ?? "preflight failed" });
    const first = preflight.issues[0]!;
    throw new Error(
      `Preflight rejected the plan before contacting Figma (${preflight.issues.length} issue(s)):\n` +
        preflight.issues.slice(0, 8).map((i) => `  #${i.index} (${i.opType}): ${i.message} Fix: ${i.fix}`).join("\n") +
        `\nFirst failure at operation #${first.index} (${first.opType}). Fix every issue and retry with the SAME transactionId.`,
    );
  }

  registry.jobs.begin({ transactionId, tool, session, operationCount: ops.length });
  registry.jobs.update(transactionId, { state: "preflight", label: `preflight passed (${ops.length} ops)` });
  registry.jobs.update(transactionId, { state: "applying", done: 0, label: "dispatching" });

  const t0 = Date.now();
  let result: TransactionResult;
  try {
    // Cross-session coordination (checklist #21): two plugin sessions bound to
    // the same Figma document must not dispatch mutations concurrently. The
    // ledger refuses same-transaction duplicates; nothing refused *different*
    // transactions over the same document — exactly the clobber the session
    // lock cannot see. `dryRun` mutates nothing, so it bypasses the document
    // lock exactly as a read does. The lock releases in a finally, so a
    // timeout or mid-apply disconnect frees the document instead of blocking
    // the other session after the holder is already dead.
    const dispatch = async (): Promise<TransactionResult> => {
      // The wire request id is bound synchronously by `request`, so the ledger
      // can record it here. Without that binding a late plugin result has no
      // key to rebind to and the `byRequestId` fallback can never match
      // anything.
      const inFlight = session.request(tool, { ...payload, transactionId });
      registry.jobs.update(transactionId, { requestId: session.requestIdFor(transactionId) ?? undefined });
      return (await inFlight) as TransactionResult;
    };
    result = ((payload.dryRun === true ? await dispatch() : await withDocumentLock(session, dispatch))) as TransactionResult;
  } catch (err) {
    if (err instanceof DocumentLockBusyError) {
      // Nothing was dispatched, so this is a refusal, not a Figma failure.
      // Recorded as a clean searchable failure; the error names the holder
      // session and document verbatim.
      registry.jobs.complete(transactionId, "failed", { error: err.message, label: "blocked: another session is writing this document" });
      recordToolCall(tool, Date.now() - t0, { ops: ops.length });
      throw err;
    }
    const unknownOutcome =
      err instanceof TransactionTimeoutError ||
      err instanceof SessionDisconnectedError ||
      (err instanceof Error && /outcome unknown|did not respond|disconnected while executing/i.test(err.message));
    if (unknownOutcome) {
      const msg = err instanceof Error ? err.message : String(err);
      registry.jobs.complete(transactionId, "timed-out", { error: msg, label: "awaiting late-result reconciliation" });
      recordToolCall(tool, Date.now() - t0, { ops: ops.length });
      // The cancel was already sent best-effort by the session; surface the
      // reconcile-first path, not a plain "failed".
      throw new Error(
        `Transaction ${transactionId} to ${tool} timed out with an UNKNOWN outcome: the Figma plugin may still be applying it (a cancel was requested, but a late commit is still possible).\n` +
          `${msg}\n` +
          `Reconcile before retrying: 1) get_job_status {transactionId} — a late result reconciles automatically; 2) inspect the target subtree for partial work (17/32 applied is possible); 3) retry only with the SAME transactionId once settled. Do not mint a new id.`,
      );
    }
    registry.jobs.complete(transactionId, "failed", { error: err instanceof Error ? err.message : String(err) });
    recordToolCall(tool, Date.now() - t0, { ops: ops.length });
    throw err;
  }
  const ms = Date.now() - t0;
  recordToolCall(tool, ms, { ops: ops.length, nodes: result.status === "success" ? result.createdNodes.length + (result.modifiedNodes?.length ?? 0) : 0 });

  if (result.status === "success") {
    recordTransaction(
      result.timings
        ? { apply: result.timings.apply, total: result.timings.total, operationCount: ops.length, nodeCount: result.createdNodes.length + (result.modifiedNodes?.length ?? 0) }
        : { total: ms, operationCount: ops.length },
    );
    registry.jobs.complete(transactionId, "committed", { done: ops.length, createdIds: result.createdNodes.map((n) => n.figmaNodeId) }, result);
    return assertTransaction({ ...result, ...(preflight.warnings.length > 0 ? { warnings: [...((result as { warnings?: string[] }).warnings ?? []), ...preflight.warnings.map((w) => w.message)] } : {}) });
  }

  recordRollback(result.rollbackStatus ?? (result.rolledBack ? "full" : "none"));
  registry.jobs.complete(
    transactionId,
    result.rollbackStatus === "full" ? "rolled-back" : result.rollbackStatus === "partial" ? "partial-rollback" : "failed",
    { error: result.error.message, createdIds: result.removedIds ?? [] },
    result,
  );
  return assertTransaction(result);
}
