/**
 * Unified screen-edit orchestrator (P1).
 *
 * One edit request → one transaction id, one timeline, one final diff.
 * Stages: discover (subtree + local tokens) → draft patch → shared-schema
 * preflight (no Figma contact on failure) → tracked transaction (job ledger)
 * → thumbnail render → geometry/a11y/token review → visual before/after diff →
 * one targeted repair pass when safe → final QA requiring fresh evidence.
 *
 * Never automatically applies large semantic layout changes or overrides a
 * selected design direction: the proposed patch and affected nodes are
 * reported before commit, and destructive/large patches still go through the
 * checkpoint gate.
 */
import { z } from "zod";
import type { SessionRegistry, Session } from "../sessions";
import { validateTransaction, splitPreflightIssues, preflightApprovalWaived, containmentOnlyPreflightContext } from "../preflight";
import { dispatchTransaction } from "../transaction";
import { guardMutation } from "../plan/gate";
import { runRules } from "../review/rules";
import { evaluateConsistency } from "../design/quality/consistency";
import { contentRevision } from "../design/quality/revision";
import type { MetricsReport, TransactionResult } from "../../../shared/protocol";
import { recordPreflightCatch, recordRollback, recordTransaction } from "../metrics";

export const EditScreenArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    target: z.string().max(200).describe("Frame/node id to edit. Resolve with find_node first; never guess."),
    goals: z.array(z.string().max(300)).min(1).max(10).describe("What this edit should achieve, e.g. ['raise contrast of primary action', 'tighten hero spacing']."),
    operations: z.array(z.record(z.unknown())).min(1).max(500).describe("Proposed patch as structured operations. Reported back before commit when dryRun is used."),
    preserve: z.array(z.string().max(200)).max(50).optional().describe("Node ids or rule names the loop must not touch."),
    description: z.string().max(1000).optional(),
    dryRun: z.boolean().optional().describe("Validate + report the patch without touching the document."),
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
    transactionId: z.string().max(200).optional(),
    repair: z.boolean().optional().describe("Run one targeted high-confidence repair pass after the patch. Default true."),
  })
  .strict();

export type EditScreenInput = z.infer<typeof EditScreenArgs>;

interface TimelineEntry {
  stage: string;
  at: number;
  detail: string;
}

function timeline(): { log: TimelineEntry[]; mark: (stage: string, detail: string) => void } {
  const log: TimelineEntry[] = [];
  return { log, mark: (stage: string, detail: string) => log.push({ stage, at: Date.now(), detail }) };
}

async function collect(session: Session, target: string): Promise<MetricsReport> {
  const raw = (await session.request("collect_metrics", { target, maxNodes: 2000, depth: 12 })) as MetricsReport;
  if (!raw || !Array.isArray((raw as MetricsReport).nodes)) {
    throw new Error("The Figma plugin returned no measurements for the edit target. Inspect the node and retry.");
  }
  return raw as MetricsReport;
}

export async function editScreenTool(registry: SessionRegistry, rawArgs: unknown): Promise<unknown> {
  const args = EditScreenArgs.parse(rawArgs ?? {});
  const marks = timeline();
  const transactionId = args.transactionId ?? `edit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  marks.mark("received", `goals: ${args.goals.join("; ")}. ops: ${args.operations.length}. target: ${args.target}.`);

  const session = registry.resolve(args.sessionId);
  const preserve = new Set(args.preserve ?? []);

  // Stage 1 — discover: relevant subtree + local tokens, once (no repeated re-inspection).
  let before: MetricsReport;
  try {
    before = await collect(session, args.target);
  } catch (err) {
    throw new Error(`edit_screen discover failed: ${err instanceof Error ? err.message : String(err)} Nothing was changed.`);
  }
  marks.mark("discovered", `${before.nodeCount} node(s) in scope "${before.scope}".`);
  const beforeRevision = contentRevision({ target: args.target, nodes: before.nodes.map((n) => [n.id, n.x, n.y, n.w, n.h, n.fill, n.name]) }, "rev");

  // Local token snapshot for token-aware repair + consistency.
  let approvedTokens: string[] = [];
  try {
    const listed = (await session.request("list_variables", {})) as {
      variables?: Array<{ collection: string; name: string; type: string; value: string | number | boolean | null }>;
    };
    approvedTokens = (listed.variables ?? [])
      .filter((v) => typeof v.value === "string" && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(v.value))
      .map((v) => String(v.value).toUpperCase());
  } catch {
    approvedTokens = [];
  }

  // Component reuse check (P2 default, not follow-up): before creating, look
  // for matching components so repeated structures become instances. Cheap
  // heuristic on size + name stem; the orchestrator reports the candidate and
  // the caller decides — never silently swapped.
  let reuseNotes: string[] = [];
  try {
    const found = (await session.request("find_components", { limit: 50 })) as {
      matches?: Array<{ component: { id: string; name: string; width: number; height: number; instanceCount: number } }>;
    };
    const components = found.matches ?? [];
    const creates = (args.operations as Array<Record<string, unknown>>).filter((op) =>
      ["createFrame", "createRectangle", "createComponent"].includes(String(op["type"])),
    );
    for (const op of creates.slice(0, 20)) {
      const w = Number(op["width"] ?? 0);
      const h = Number(op["height"] ?? 0);
      if (!(w > 0 && h > 0)) continue;
      const hit = components.find(
        (m) => Math.abs(m.component.width - w) <= 8 && Math.abs(m.component.height - h) <= 8 && m.component.instanceCount > 0,
      );
      if (hit) {
        reuseNotes.push(
          `Patch creates ${w}x${h} "${String(op["name"] ?? op["type"])}" but component "${hit.component.name}" (${hit.component.width}x${hit.component.height}, ${hit.component.instanceCount} instance(s)) is close: prefer create_instance ${hit.component.id} unless the content genuinely differs.`,
        );
      }
    }
    if (reuseNotes.length > 0) marks.mark("reuse-check", `${reuseNotes.length} reuse candidate(s) found.`);
  } catch {
    reuseNotes = [];
  }

  // Stage 2 — preflight with the shared schema. Never contacts Figma on failure.
  // Issue #30 (phase-3 close-out): the pass threads the containment-only
  // context — these are caller-authored ops with no plan behind them, so plan
  // evidence is not claimed, but the ops' own declared create chain is
  // containment-checked at this gate too, not only at dispatch.
  const preflight = validateTransaction(args.operations as unknown[], containmentOnlyPreflightContext());
  if (!preflight.ok) {
    recordPreflightCatch(preflight.issues.length);
    const { hard, soft } = splitPreflightIssues(preflight.issues);
    // Issue #30 (phase-3 close-out): the early pass honours the SAME explicit
    // waiver the dispatch below accepts — otherwise a caller who already
    // justified a deliberate bleed would be refused here even though the
    // transaction edge would have let them through.
    if (hard.length === 0 && soft.length > 0 && preflightApprovalWaived(args)) {
      marks.mark("preflight-waived", `${soft.length} geometry finding(s) waived on approval; they ride the committed result as warnings.`);
    } else {
      return {
        status: "preflight-failed",
        transactionId,
        timeline: marks.log,
        issues: preflight.issues,
        warnings: preflight.warnings,
        howToProceed:
          (soft.length > 0
            ? `Fix every structural issue (indices + fixes above); the ${soft.length} geometry finding(s) can alternatively be waived with approved:true plus a reason on the same call. `
            : "") +
          "Retry with the SAME transactionId. Figma was not contacted.",
      };
    }
  }
  marks.mark("preflight", `${preflight.operationCount} op(s) valid; ${preflight.warnings.length} warning(s).`);

  // Preserve filter before the gate so protected nodes never reach Figma.
  const ops = (args.operations as Array<Record<string, unknown>>).filter((op) => {
    for (const key of ["target", "parent", "child"]) {
      const v = op[key];
      if (typeof v === "string" && preserve.has(v)) return false;
    }
    return true;
  });
  const skippedByPreserve = args.operations.length - ops.length;
  if (ops.length === 0) {
    return { status: "preserved", transactionId, timeline: marks.log, note: "Every proposed operation touched a preserved node or rule. Nothing was sent." };
  }

  const gate = guardMutation({ operations: ops, approved: args.approved, reason: args.reason, dryRun: args.dryRun ?? false });
  if (gate) return { status: "needs-approval", transactionId, timeline: marks.log, ...(gate as object) };
  if (args.dryRun) {
    return {
      status: "ok",
      dryRun: true,
      transactionId,
      timeline: marks.log,
      patch: ops,
      affectedEstimate: before.nodeCount,
      warnings: preflight.warnings,
      howToProceed: "Re-send with dryRun:false to commit this patch as one tracked transaction.",
    };
  }

  // Stage 3 — tracked transaction (job ledger: queued → applying → verifying).
  const { randomUUID } = await import("node:crypto");
  const tid = transactionId.startsWith("edit_") ? transactionId : transactionId;
  void randomUUID;
  registry.jobs.begin({ transactionId: tid, tool: "edit_screen", session, operationCount: ops.length });
  registry.jobs.update(tid, { state: "preflight", done: 0, label: "preflight passed" });
  marks.mark("committing", `transaction ${tid} with ${ops.length} op(s).`);

  // Idempotency: a retried transactionId with a completed result returns it.
  const prior = registry.jobs.priorResult(tid);
  if (prior) {
    const { recordDuplicateRetry } = await import("../metrics");
    recordDuplicateRetry();
    return { status: "duplicate", transactionId: tid, timeline: marks.log, result: prior, note: "This transactionId already completed; returning the prior result instead of duplicating nodes." };
  }

  registry.jobs.update(tid, { state: "applying", done: 0, label: "dispatching to Figma" });
  let result: TransactionResult;
  // Issue #23 close-out — the plugin call goes through the tracked dispatcher
  // (blocking preflight, ledger, document lock, transaction-call idempotency)
  // like every other mutating path. The plugin transaction's ledger record
  // lives under `${tid}:apply`; `tid` stays this tool's orchestration record,
  // so the retry/reconcile contract below is unchanged.
  const applyTid = `${tid}:apply`;
  try {
    result = await dispatchTransaction(registry, session, "modify_design", {
      description: args.description ?? `edit_screen: ${args.goals.join("; ")}`,
      operations: ops,
      transactionId: applyTid,
      // Issue #30 (phase-3 close-out): caller-authored ops get the
      // containment-only context, so a patch that declares an escape with no
      // plan behind it fails closed here exactly as it would on modify_design —
      // and approves out of it the same one-argument way.
      preflight: containmentOnlyPreflightContext(),
      approved: args.approved,
      reason: args.reason,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const unknownOutcome = /outcome unknown|did not respond|disconnected while executing|stalled on/i.test(msg);
    if (unknownOutcome) {
      registry.jobs.complete(tid, "timed-out", { error: msg, label: "awaiting late-result reconciliation" });
      throw new Error(
        `edit_screen transaction ${tid} timed out with an UNKNOWN outcome (Figma may still commit late; a cancel was requested). Reconcile with get_job_status {transactionId:${tid}} before retrying with the SAME id. Original: ${msg}`,
      );
    }
    // The dispatcher throws — instead of returning a failed payload — after
    // parking the rejected transaction against `${tid}:apply`; keep the
    // structured `transaction-failed` response and the orchestration ledger
    // state this tool has always reported.
    const failed = registry.jobs.priorResult(applyTid) as TransactionResult | undefined;
    if (failed && failed.status === "failed") {
      registry.jobs.complete(
        tid,
        failed.rollbackStatus === "full" ? "rolled-back" : failed.rollbackStatus === "partial" ? "partial-rollback" : "failed",
        { error: failed.error.message, createdIds: failed.removedIds ?? [] },
      );
      return { status: "transaction-failed", transactionId: tid, timeline: marks.log, result: failed, howToProceed: failed.error.hint };
    }
    registry.jobs.complete(tid, "failed", { error: msg });
    throw err;
  }

  if (result.status === "failed") {
    const status: string = result.rollbackStatus ?? (result.rolledBack ? "rolled-back" : "failed");
    recordRollback(result.rollbackStatus ?? "none");
    registry.jobs.complete(tid, status === "rolled-back" || result.rollbackStatus === "full" ? "rolled-back" : status === "partial-rollback" || result.rollbackStatus === "partial" ? "partial-rollback" : "failed", {
      error: result.error.message,
      createdIds: result.removedIds ?? [],
    });
    return { status: "transaction-failed", transactionId: tid, timeline: marks.log, result, howToProceed: result.error.hint };
  }

  recordTransaction(result.timings ? { apply: result.timings.apply, total: result.timings.total, operationCount: ops.length, nodeCount: result.createdNodes.length + (result.modifiedNodes?.length ?? 0) } : undefined);
  registry.jobs.update(tid, { state: "verifying", done: ops.length, label: "rendering thumbnail" });
  marks.mark("committed", `created ${result.createdNodes.length}, modified ${result.modifiedNodes?.length ?? 0}.`);

  // Stage 4 — thumbnail render (low detail first; high only for text questions).
  let renderInfo: Record<string, unknown> | null = null;
  try {
    const rendered = (await session.request("render_node", { nodeId: args.target, maxWidth: 1024, detail: "low" })) as {
      width?: number; height?: number; estimatedTokens?: number; byteLength?: number; base64Length?: number; data?: string;
    };
    renderInfo = {
      width: rendered.width,
      height: rendered.height,
      estimatedTokens: rendered.estimatedTokens,
      bytes: rendered.byteLength ?? rendered.base64Length,
      detail: "low",
    };
    marks.mark("rendered", `thumbnail ${rendered.width}x${rendered.height} (~${rendered.estimatedTokens} tokens).`);
  } catch (err) {
    marks.mark("render-failed", err instanceof Error ? err.message : String(err));
  }

  // Stage 5 — review geometry/a11y/token consistency on the NEW state (fresh evidence only).
  const after = await collect(session, args.target);
  const afterRevision = contentRevision({ target: args.target, nodes: after.nodes.map((n) => [n.id, n.x, n.y, n.w, n.h, n.fill, n.name]) }, "rev");
  const findings = runRules(after, "review").filter((f) => !preserve.has(f.rule) && !f.nodeIds.some((id) => preserve.has(id)));
  const high = findings.filter((f) => f.confidence === "high" && (f.suggestedOperations?.length ?? 0) > 0);
  const fills = after.nodes.map((n) => n.fill).filter((f): f is string => typeof f === "string");
  const consistency = evaluateConsistency({ fills, approvedTokens });
  marks.mark("reviewed", `${findings.length} finding(s), ${high.length} high-confidence with fixes; consistency ${consistency.score}/100.`);

  // Stage 6 — structural before/after diff (machine-readable delta).
  const beforeIds = new Set(before.nodes.map((n) => n.id));
  const afterIds = new Set(after.nodes.map((n) => n.id));
  const added = [...afterIds].filter((id) => !beforeIds.has(id));
  const removed = [...beforeIds].filter((id) => !afterIds.has(id));
  const moved: Array<{ id: string; dx: number; dy: number }> = [];
  const recolored: Array<{ id: string; from?: string; to?: string }> = [];
  const textOverflow: string[] = [];
  for (const b of before.nodes) {
    const a = after.nodes.find((n) => n.id === b.id);
    if (!a) continue;
    if (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1) moved.push({ id: b.id, dx: Math.round(a.x - b.x), dy: Math.round(a.y - b.y) });
    if (b.fill !== a.fill) recolored.push({ id: b.id, ...(b.fill ? { from: b.fill } : {}), ...(a.fill ? { to: a.fill } : {}) });
    if (a.text && a.text.truncated) textOverflow.push(a.id);
  }
  const newOverlaps = runRules(after, "review").filter((f) => f.rule === "overflow").length;
  const contrastChange = findings.filter((f) => /contrast/i.test(f.rule)).length;
  const delta = {
    added: added.length,
    removed: removed.length,
    moved: moved.length,
    recolored: recolored.length,
    newOverlaps,
    changedTokens: recolored.filter((r) => (r.to && !approvedTokens.includes(r.to.toUpperCase())) || (r.from && !approvedTokens.includes(r.from.toUpperCase()))).length,
    textOverflow: textOverflow.length,
    contrastChange,
  };
  marks.mark("diffed", `+${added.length}/-${removed.length} nodes, ${moved.length} moved, ${recolored.length} recolored.`);

  // Stage 7 — one targeted repair pass (high-confidence only, token-aware).
  let repair: Record<string, unknown> | null = null;
  if ((args.repair ?? true) && high.length > 0 && high.length <= 5) {
    const repairOps = high.flatMap((f) => f.suggestedOperations ?? []);
    // Token guard: no repair may introduce an unapproved fill.
    const introducesUnknown = repairOps.some((op) => {
      const s = JSON.stringify(op);
      const hexes = s.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
      return hexes.some((h) => approvedTokens.length > 0 && !approvedTokens.includes(h.toUpperCase()));
    });
    if (!introducesUnknown) {
      const repairGate = guardMutation({ operations: repairOps as Array<Record<string, unknown>>, approved: args.approved, reason: args.reason });
      if (!repairGate) {
        try {
          const repairResult = await dispatchTransaction(registry, session, "modify_design", {
            description: `edit_screen repair: ${high.map((f) => f.rule).join(", ")}`,
            operations: repairOps,
            transactionId: `${tid}:repair`,
            // Issue #30 (phase-3 close-out): suggested fix ops get the same
            // containment-only context as the main pass; a refusal surfaces as
            // a recorded repair failure, never a crash.
            preflight: containmentOnlyPreflightContext(),
            approved: args.approved,
            reason: args.reason,
          });
          if (repairResult.status === "success") {
            // Whole-screen consistency re-run after the local fix (P1).
            const recheck = await collect(session, args.target);
            const recheckFills = recheck.nodes.map((n) => n.fill).filter((f): f is string => typeof f === "string");
            const recheckConsistency = evaluateConsistency({ fills: recheckFills, approvedTokens });
            repair = {
              applied: high.map((f) => f.rule),
              consistencyBefore: consistency.score,
              consistencyAfter: recheckConsistency.score,
              drift: recheckConsistency.score < consistency.score ? "regressed — hand-review before done" : "holds",
            };
            marks.mark("repaired", `${high.length} high-confidence fix(es) applied; consistency ${consistency.score} → ${recheckConsistency.score}.`);
          } else {
            repair = { applied: [], error: repairResult.error.message };
            marks.mark("repair-failed", repairResult.error.message);
          }
        } catch (err) {
          repair = { applied: [], error: err instanceof Error ? err.message : String(err) };
          marks.mark("repair-failed", String(repair.error));
        }
      } else {
        repair = { applied: [], gated: true };
        marks.mark("repair-gated", "Repair needs approval; nothing further changed.");
      }
    } else {
      repair = { applied: [], skipped: "repair would introduce unapproved fills" };
      marks.mark("repair-skipped", "Token guard blocked a repair that names fills outside the approved set.");
    }
  }

  registry.jobs.complete(tid, "committed", { done: ops.length, createdIds: result.createdNodes.map((n) => n.figmaNodeId) }, result);

  return {
    status: "ok",
    transactionId: tid,
    timeline: marks.log,
    committed: {
      created: result.createdNodes.length,
      modified: result.modifiedNodes?.length ?? 0,
      timings: result.timings ?? null,
      warnings: (result as { warnings?: string[] }).warnings ?? [],
    },
    reuse: reuseNotes.length > 0 ? reuseNotes.slice(0, 8) : undefined,
    evidence: {
      beforeRevision,
      afterRevision,
      freshRender: renderInfo,
      reviewedNodes: after.nodeCount,
      findings: findings.length,
      highConfidence: high.length,
      consistency,
    },
    delta: {
      ...delta,
      movedSample: moved.slice(0, 10),
      recoloredSample: recolored.slice(0, 10),
    },
    ...(repair ? { repair } : {}),
    skippedByPreserve,
    preflightWarnings: preflight.warnings,
    howToProceed: "Judge the thumbnail render yourself; run final_qa (it requires a fresh render of this exact revision) before calling it done.",
  };
}
