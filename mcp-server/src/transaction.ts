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
import { validateTransaction, preflightCheckTag, splitPreflightIssues, preflightApprovalWaived } from "./preflight";
import type { PreflightContext } from "./preflight-blocking";
import { withDocumentLock, DocumentLockBusyError } from "./native/lock";
import {
  recordDuplicateRetry,
  recordPreflightCatch,
  recordRollback,
  recordToolCall,
  recordTransaction,
} from "./metrics";

/**
 * Pre-build score/guard evidence threaded in by the calling handler.
 *
 * Collected via the score_design / design_guard tool internals (never a new
 * tool): the score report's weak spots and the product guard's verdict for
 * the program about to be built. The dispatcher enforces it at the
 * transaction edge — a FAIL verdict or a critical weak spot refuses the apply
 * unless the caller waives it explicitly with approved:true plus a reason.
 * Absent evidence means nothing was measured, which is not a block.
 */
export interface ScoreGuardEvidence {
  /** score_design weak spots: dimension names (advisory) or detail objects. */
  scoreWeakSpots?: unknown[];
  /** design_guard verdict: PASS | WARNING | FAIL | INDETERMINATE ... */
  guardVerdict?: string;
  /** Explicit human waiver covering this evidence. Single-use per dispatch. */
  approved?: boolean;
  reason?: string;
}

/**
 * A weak spot only blocks dispatch when it is critical: an explicit
 * critical severity, or a dimension score below 4 (severely failing, not
 * merely below the 6-point done bar). Plain dimension names — the shape
 * score_design returns — stay advisory: they are the fix list for the next
 * pass, not a reason to refuse the build.
 */
export function isCriticalWeakSpot(spot: unknown): boolean {
  if (spot === null || typeof spot !== "object" || Array.isArray(spot)) return false;
  const o = spot as Record<string, unknown>;
  if (o["severity"] === "critical") return true;
  if (typeof o["score"] === "number" && o["score"] < 4) return true;
  return false;
}

/**
 * Returns the refusal reason when the score/guard evidence blocks, or null.
 *
 * A FAIL guard verdict and any critical weak spot both refuse unless waived
 * with approved:true plus a non-empty reason — the same explicit-justification
 * pattern as the checkpoint gate's needs-approval.
 */
export function scoreGuardRefusal(evidence: ScoreGuardEvidence | undefined): string | null {
  if (!evidence) return null;
  const waived =
    evidence.approved === true && typeof evidence.reason === "string" && evidence.reason.trim().length > 0;
  if (waived) return null;
  const verdict = typeof evidence.guardVerdict === "string" ? evidence.guardVerdict.toUpperCase() : "";
  if (verdict === "FAIL") {
    return (
      `score-guard: the design_guard verdict for this build is FAIL, so nothing may be applied from it. ` +
      `Fix the failing truths (or re-run design_guard on the repaired program) and rebuild — ` +
      `or waive explicitly with approved:true plus the reason this FAIL is safe to build.`
    );
  }
  const critical = (evidence.scoreWeakSpots ?? []).filter(isCriticalWeakSpot);
  if (critical.length > 0) {
    return (
      `score-guard: score_design reports ${critical.length} critical weak spot(s) for this build, ` +
      `so nothing may be applied from it. Repair the failing dimensions and rebuild — ` +
      `or waive explicitly with approved:true plus the reason these spots are safe to build.`
    );
  }
  return null;
}

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
  payload: { description?: string; operations: unknown[]; dryRun?: boolean; transactionId?: string; targets?: string[]; preflight?: PreflightContext; scoreGuard?: ScoreGuardEvidence; /** Issue #30: plan provenance for the ledger chain. */ planId?: string; /** Issue #30: explicit-justification waiver for the geometry-class preflight findings. */ approved?: boolean; reason?: string },
): Promise<TransactionResult> {
  const transactionId = payload.transactionId ?? `txn_${randomUUID().slice(0, 8)}`;
  const ops = payload.operations as unknown[];

  // Issue #23, check 7 — the brief gate at the transaction edge. The pipeline
  // stops contradictory briefs at stage 1, but it was the only place that did:
  // any other path (a rerun, a hand-wired caller, a future stage that forgets)
  // could still dispatch a build whose brief the normalizer refused. So the
  // refusal lives HERE, server-side, before any socket or document contact —
  // a brief that contradicts itself must never reach a build, full stop.
  const blockingBrief = (payload.preflight?.briefBlockers ?? []).filter((b) => b && b.severity === "blocking");
  if (blockingBrief.length > 0) {
    const first = blockingBrief[0]!;
    const summary = blockingBrief.slice(0, 5).map((b) => b.message).join("; ");
    const label = `blocked: brief carries ${blockingBrief.length} blocking contradiction(s)`;
    recordPreflightCatch(blockingBrief.length);
    registry.jobs.begin({ transactionId, tool, session, operationCount: ops.length, ...(payload.planId !== undefined ? { planId: payload.planId } : {}) });
    registry.jobs.complete(transactionId, "failed", { error: summary, label });
    throw new Error(
      `Refused before dispatch: the brief carries ${blockingBrief.length} blocking contradiction(s), so nothing may be built from it ` +
        `(ledger: "${label}").\n` +
        blockingBrief.slice(0, 5).map((b) => `  ${b.message}${b.fix ? ` Fix: ${b.fix}` : ""}`).join("\n") +
        `\nFirst contradiction: "${first.message}". Resolve it in the brief, then build again.`,
    );
  }

  // Issue #26 — the score/guard gate at the transaction edge. A build whose
  // measured verdict is FAIL (or carries critical weak spots) must not reach
  // the document, whatever path threaded it here. The evidence rides in on
  // `scoreGuard`; an explicit waiver (approved:true plus a reason) covers this
  // dispatch only. Refused server-side, before any socket or document contact.
  const guardBlock = scoreGuardRefusal(payload.scoreGuard);
  if (guardBlock !== null) {
    const label = "blocked: score-guard refused (FAIL verdict or critical weak spots)";
    recordPreflightCatch(1);
    registry.jobs.begin({ transactionId, tool, session, operationCount: ops.length, ...(payload.planId !== undefined ? { planId: payload.planId } : {}) });
    registry.jobs.complete(transactionId, "failed", { error: guardBlock, label });
    throw new Error(
      `Refused before dispatch: ${guardBlock}\n` +
        `(ledger: "${label}"). Nothing was created and nothing was sent.`,
    );
  }

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

  // Issue #23 — program-level blocking checks ride in on the caller's
  // `preflight` context (plan boxes, overflow permissions, text measurements,
  // connectors, brief blockers). The context is evidence already gathered
  // deterministically; passing it never contacts Figma.
  const evaluated = validateTransaction(ops, payload.preflight);
  // Issue #30 — the approval covers the geometry-class findings the threaded
  // context exposes. An approved+reason dispatch (the same explicit
  // justification the raw-provenance and score-guard gates already accept)
  // proceeds past waivable geometry findings, which surface as warnings on
  // the committed result instead of vanishing. Structural findings
  // (schema / dup-id / dup-parent / unresolved and stale refs / page target)
  // never waive: an approval about intent is not evidence about identity.
  let waivedCount = 0;
  let preflight = evaluated;
  if (!preflight.ok) {
    const { hard, soft } = splitPreflightIssues(evaluated.issues);
    const waived = hard.length === 0 && soft.length > 0 && preflightApprovalWaived(payload);
    if (!waived) {
      recordPreflightCatch(evaluated.issues.length);
      registry.jobs.begin({ transactionId, tool, session, operationCount: ops.length, ...(payload.planId !== undefined ? { planId: payload.planId } : {}) });
      const first = (hard[0] ?? soft[0])!;
      // The ledger note names the check that blocked, so a get_job_status after
      // the refusal answers "why was nothing created" without re-reading the error.
      const label = `blocked: preflight (${preflightCheckTag(first)}) refused ${evaluated.issues.length} issue(s)`;
      registry.jobs.complete(transactionId, "failed", { error: first.message, label });
      const waiverHint =
        soft.length > 0
          ? `\n(${soft.length} of these are geometry findings — outside-bounds / text-overflow / geometry-drift / connector — that an explicit approved:true plus reason could waive on this dispatch; the structural findings above cannot be waived.)`
          : "";
      throw new Error(
        `Preflight rejected the plan before contacting Figma (${evaluated.issues.length} issue(s), blocking check: ${preflightCheckTag(first)}); nothing was created and the ledger records it as "${label}":\n` +
          evaluated.issues.slice(0, 8).map((i) => `  #${i.index} (${i.opType}): ${i.message} Fix: ${i.fix}`).join("\n") +
          `\nFirst failure at operation #${first.index} (${first.opType}). Fix every issue and retry with the SAME transactionId.` +
          waiverHint,
      );
    }
    // Waived: proceed, and keep the findings visible. They ride the result's
    // warnings exactly how preflight.warnings already surface, and the ledger
    // note names them so the dispatch is searchable rather than silent.
    recordPreflightCatch(soft.length);
    waivedCount = soft.length;
    preflight = {
      ...evaluated,
      ok: true,
      issues: [],
      warnings: [...evaluated.warnings, ...soft.map((i) => ({ index: i.index, opType: i.opType, message: `[preflight-waived] ${i.message}` }))],
    };
  }

  registry.jobs.begin({ transactionId, tool, session, operationCount: ops.length, ...(payload.planId !== undefined ? { planId: payload.planId } : {}) });
  registry.jobs.update(transactionId, {
    state: "preflight",
    label: waivedCount > 0 ? `preflight passed (${ops.length} ops; ${waivedCount} geometry finding(s) waived on approval)` : `preflight passed (${ops.length} ops)`,
  });
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
    registry.jobs.complete(
      transactionId,
      "committed",
      {
        done: ops.length,
        createdIds: result.createdNodes.map((n) => n.figmaNodeId),
        // Issue #30: the final record stays searchable — the intermediate
        // "preflight passed" label is overwritten by the applying update, so
        // the waiver note rides the terminal state instead.
        ...(waivedCount > 0 ? { label: `committed (${waivedCount} geometry finding(s) waived on approval)` } : {}),
      },
      result,
    );
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
