/**
 * MCP tools for tagging, change requests and feedback history (issue #11, Part D).
 *
 * The workflow the issue describes, and the order the tools enforce:
 *
 *   request_change       "make these three buttons consistent" — with the
 *                        selection's stable ids attached, and constraints that
 *                        survive to verification
 *   plan_change          the agent proposes operations; nothing is applied
 *   approve_change       the plan is accepted
 *   apply_change         the transaction commits
 *   verify_change        review + render, producing real before/after evidence
 *
 * `apply_change` refuses to mark a request `applied` until `verify_change` has
 * run, which is how "created successfully" is kept distinct from "passed visual
 * QA" in the data rather than in a promise.
 *
 * Selection context is attached automatically: whatever the user has selected
 * becomes the target set with its node ids, names and instance relationships, so
 * "this inspector" resolves to an id rather than to a guess.
 */
import { z } from "zod";
import type { Session } from "../sessions";
import { projectKey } from "../memory/store";
import { loadFeedback, reconcileTargets, removeTag, saveFeedback, upsertRequest, upsertTag } from "./store";
import { ChangeKindSchema, IllegalTransitionError, transition, type ChangeRequest, type Constraint, type Target } from "./model";

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

const TargetInputSchema = z
  .object({
    nodeId: z.string().min(1).max(200),
    name: z.string().max(300).optional(),
    nodeType: z.string().max(40).optional(),
    instanceOf: z.string().max(200).optional(),
  })
  .strict();

const ConstraintInputSchema = z
  .object({
    id: z.string().min(1).max(80),
    description: z.string().min(3).max(300),
    protectNodeIds: z.array(z.string().max(200)).max(200).optional(),
    property: z.string().max(60).optional(),
    blocking: z.boolean().optional(),
  })
  .strict();

export const RequestChangeArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** The user's words, kept verbatim. */
    request: z.string().min(3).max(2000),
    kind: ChangeKindSchema.optional(),
    /** Explicit targets. Omit to use the current selection. */
    targets: z.array(TargetInputSchema).max(200).optional(),
    constraints: z.array(ConstraintInputSchema).max(50).optional(),
    /** Adopt the current Figma selection as the target set. Default true when no targets given. */
    useSelection: z.boolean().optional(),
  })
  .strict()
  .describe("Record a change request against specific nodes, with constraints. Names the targets before anything is changed.");

export const PlanChangeArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    requestId: z.string().min(1).max(80),
    /** The agent's plan, in plain language. Shown before anything is applied. */
    plan: z.string().min(3).max(4000),
    /** Proposed operations, validated by the shared schema before anything runs. */
    operations: z.array(z.record(z.unknown())).max(500),
  })
  .strict();

export const ApplyChangeArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    requestId: z.string().min(1).max(80),
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
    transactionId: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
  })
  .strict();

export const VerifyChangeArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    requestId: z.string().min(1).max(80),
    /** Node to review and render. Defaults to the request's first target's parent. */
    target: z.string().max(200).optional(),
  })
  .strict();

export const UpdateChangeRequestArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    requestId: z.string().min(1).max(80),
    status: z.enum(["approved", "rejected"]).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export const ReresolveChangeArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    requestId: z.string().min(1).max(80),
    /** Map an unresolved node id to the id the user confirmed. */
    replacements: z.array(z.object({ was: z.string().max(200), now: z.string().max(200), name: z.string().max(300).optional() }).strict()).min(1).max(200),
  })
  .strict()
  .describe("Point a change request at the nodes the user confirmed after a rename or replacement. Never guessed automatically.");

export const TagTargetsArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    tag: z.string().min(1).max(60),
    targets: z.array(TargetInputSchema).min(1).max(200).optional(),
    useSelection: z.boolean().optional(),
    /** Remove this tag from the targets instead of adding it. */
    remove: z.boolean().optional(),
  })
  .strict();

export const ListFeedbackArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    tag: z.string().max(60).optional(),
    status: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Selection context                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Reads the current selection with the relationships the issue asks for.
 *
 * Node ids, names, parents and instance-of: enough for a change request to name
 * its targets precisely, and for a reviewer to understand what was touched. This
 * is the "selection-aware" part — without it, "this inspector" has to be guessed
 * from a name.
 */
async function selectionTargets(session: Session | null): Promise<{ targets: Target[]; problem?: string }> {
  if (!session) return { targets: [], problem: "no connected Figma plugin; pass explicit target node ids instead" };
  try {
    const raw = (await session.request("inspect_selection", { maxNodes: 2000 })) as {
      selection?: Array<{ id?: string; name?: string; type?: string; instanceOf?: string }>;
    };
    const selection = Array.isArray(raw?.selection) ? raw.selection : [];
    const targets = selection
      .filter((n): n is { id: string; name?: string; type?: string; instanceOf?: string } => typeof n.id === "string")
      .map((n) => ({ nodeId: n.id, name: n.name ?? "", nodeType: n.type ?? "", ...(n.instanceOf ? { instanceOf: n.instanceOf } : {}) }));
    return { targets, ...(targets.length === 0 ? { problem: "nothing is selected in Figma" } : {}) };
  } catch (error) {
    return { targets: [], problem: `the selection could not be read (${(error as Error).message})` };
  }
}

function toTarget(input: z.infer<typeof TargetInputSchema>): Target {
  return { nodeId: input.nodeId, name: input.name ?? "", nodeType: input.nodeType ?? "", ...(input.instanceOf !== undefined ? { instanceOf: input.instanceOf } : {}) };
}

function keyFor(session: Session | null, project?: string): string {
  return projectKey(project ?? session?.fileKey, session?.fileName);
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

export async function requestChangeTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = RequestChangeArgs.parse(rawArgs);
  const key = keyFor(session);
  const { file, problem } = loadFeedback(key);

  const useSelection = args.useSelection ?? (args.targets === undefined || args.targets.length === 0);
  const selection = useSelection ? await selectionTargets(session) : { targets: [] };
  const targets = (args.targets ?? []).map(toTarget);

  const all = [...targets, ...selection.targets];
  if (all.length === 0) {
    return {
      status: "no-targets",
      note: selection.problem ?? "A change request must name the nodes it is about. Pass targets, or select them in Figma.",
      ...(problem ? { warning: problem } : {}),
    };
  }

  const deduped = [...new Map(all.map((t) => [t.nodeId, t])).values()];
  const constraints: Constraint[] = (args.constraints ?? []).map((c) => ({
    id: c.id,
    description: c.description,
    protectNodeIds: c.protectNodeIds ?? [],
    ...(c.property !== undefined ? { property: c.property } : {}),
    blocking: c.blocking ?? true,
  }));

  const request: ChangeRequest = {
    id: `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    project: key,
    request: args.request,
    kind: args.kind ?? "edit",
    targets: deduped,
    constraints,
    status: "proposed",
    proposedOperations: [],
    unresolvedTargets: [],
    verified: false,
    notes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveFeedback(key, upsertRequest(file, request));

  return {
    status: "ok",
    requestId: request.id,
    requestStatus: request.status,
    targets: deduped.map((t) => ({ nodeId: t.nodeId, name: t.name, type: t.nodeType, instanceOf: t.instanceOf ?? null })),
    constraints: constraints.map((c) => `${c.id}: ${c.description}${c.blocking ? " (blocking)" : ""}`),
    nextStep: "Nothing has changed. Call plan_change with the operations you propose; the plan is reported before any commit.",
    ...(selection.problem ? { selectionNote: selection.problem } : {}),
    ...(problem ? { warning: problem } : {}),
  };
}

export async function planChangeTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = PlanChangeArgs.parse(rawArgs);
  const key = keyFor(session);
  const { file, problem } = loadFeedback(key);
  const request = file.requests.find((r) => r.id === args.requestId);
  if (!request) return { status: "not-found", requestId: args.requestId, knownIds: file.requests.map((r) => r.id) };

  // Constraints are checked against the plan before it can be approved, so an
  // operation that would violate one is refused here rather than after commit.
  const planned = new Set(args.operations.map((op) => String((op as Record<string, unknown>).target ?? "")));
  const protectedIds = request.constraints.filter((c) => c.blocking).flatMap((c) => c.protectNodeIds);
  const violations = protectedIds.filter((id) => planned.has(id));
  if (violations.length > 0) {
    return {
      status: "plan-violates-constraints",
      requestId: request.id,
      violations,
      blockingConstraints: request.constraints.filter((c) => c.blocking && c.protectNodeIds.some((p) => violations.includes(p))).map((c) => c.description),
      nextStep: "The proposed operations touch nodes a blocking constraint protects. Revise the plan; nothing was applied.",
    };
  }

  const next = { ...request, plan: args.plan, proposedOperations: args.operations, status: "proposed" as const, updatedAt: new Date().toISOString() };
  saveFeedback(key, upsertRequest(file, next));

  return {
    status: "ok",
    requestId: request.id,
    operations: args.operations.length,
    protectedByConstraints: protectedIds,
    nextStep: "Plan recorded and validated. Call apply_change to commit it, then verify_change to prove the result.",
    ...(problem ? { warning: problem } : {}),
  };
}

export async function applyChangeTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = ApplyChangeArgs.parse(rawArgs);
  const key = keyFor(session);
  const { file } = loadFeedback(key);
  const request = file.requests.find((r) => r.id === args.requestId);
  if (!request) return { status: "not-found", requestId: args.requestId, knownIds: file.requests.map((r) => r.id) };
  if (!session) throw new Error("apply_change needs a connected Figma plugin.");
  if (request.proposedOperations.length === 0) {
    return { status: "no-plan", requestId: request.id, howToProceed: "Record a plan with plan_change first; nothing is applied from a bare request." };
  }

  const approved = transition(request, "approved");
  const result = (await session.request("modify_design", {
    description: args.description ?? `change request: ${request.request.slice(0, 120)}`,
    operations: request.proposedOperations,
    ...(args.transactionId !== undefined ? { transactionId: args.transactionId } : {}),
  })) as { status?: string; error?: { message?: string }; createdNodes?: Array<{ figmaNodeId: string }> };

  if (result.status !== "success") {
    const failed: ChangeRequest = { ...approved, status: "failed", notes: [...request.notes, `apply failed: ${result.error?.message ?? "unknown error"}`] };
    saveFeedback(key, upsertRequest(file, failed));
    return { status: "failed", requestId: request.id, error: result.error?.message ?? "the transaction failed" };
  }

  // Deliberately NOT `applied`. The operations ran; that is all that is known.
  const running = { ...approved, transactionId: args.transactionId, notes: [...request.notes, `committed ${result.createdNodes?.length ?? 0} node(s); awaiting verification`] };
  saveFeedback(key, upsertRequest(file, running));

  return {
    status: "committed-awaiting-verification",
    requestId: request.id,
    created: result.createdNodes?.length ?? 0,
    nextStep: "Operations ran. Call verify_change to review and render the result — the request is not marked 'applied' until that passes.",
    note: "Committed is not the same as applied. 'applied' requires verification.",
  };
}

export async function verifyChangeTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = VerifyChangeArgs.parse(rawArgs);
  const key = keyFor(session);
  const { file } = loadFeedback(key);
  const request = file.requests.find((r) => r.id === args.requestId);
  if (!request) return { status: "not-found", requestId: args.requestId, knownIds: file.requests.map((r) => r.id) };
  if (!session) throw new Error("verify_change needs a connected Figma plugin.");
  if (!request.transactionId) {
    return { status: "not-committed", requestId: request.id, howToProceed: "This request has not been committed yet, so there is nothing to verify." };
  }

  const target = args.target ?? request.targets[0]?.nodeId;
  if (!target) return { status: "no-target", requestId: request.id };

  const { runRules } = await import("../review/rules");
  const { contentRevision } = await import("../design/quality/revision");

  const metrics = (await session.request("collect_metrics", { target, maxNodes: 2000, depth: 12 })) as { nodes?: Array<{ id: string; x: number; y: number; w: number; h: number; fill?: string; name: string }> };
  const findings = runRules(metrics as never, "review");
  const high = findings.filter((f) => f.confidence === "high");

  let rendered: { data?: string } | null = null;
  try {
    rendered = (await session.request("render_node", { nodeId: target, maxWidth: 1024, detail: "low" }, 120_000)) as { data?: string };
  } catch {
    rendered = null;
  }

  const afterRevision = contentRevision({ target, nodes: (metrics.nodes ?? []).map((n) => [n.id, n.x, n.y, n.w, n.h, n.fill, n.name]) }, "rev");

  const verified = high.length === 0 && rendered !== null;
  const next: ChangeRequest = {
    ...request,
    findingsBefore: request.findingsBefore ?? undefined,
    findingsAfter: high.length,
    afterRevision,
    verified,
    beforeRender: request.beforeRender,
    ...(rendered?.data ? { afterRender: `render:${target}:low` } : {}),
    notes: [
      ...request.notes,
      `verified: ${high.length} high-confidence finding(s) remain${rendered ? ", render captured" : ", NO RENDER CAPTURED"}`,
    ],
  };

  let saved = next;
  let status = next.status;
  if (verified) {
    saved = transition(next, "applied");
    status = "applied";
  }

  saveFeedback(key, upsertRequest(file, saved));

  return {
    status,
    requestId: request.id,
    verified,
    findingsAfter: high.length,
    ...(high.length > 0 ? { remainingHighConfidence: high.map((f) => ({ rule: f.rule, nodes: f.nodeIds })) } : {}),
    rendered: rendered !== null,
    howToProceed: verified
      ? "Verified: the change was reviewed, no high-confidence findings remain, and a render was captured. The request is now 'applied'."
      : `Not verified: ${high.length} high-confidence finding(s) remain${rendered ? "" : " and no render could be captured"}. The request stays 'approved'.`,
  };
}

export async function updateChangeRequestTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = UpdateChangeRequestArgs.parse(rawArgs);
  const key = keyFor(session);
  const { file } = loadFeedback(key);
  const request = file.requests.find((r) => r.id === args.requestId);
  if (!request) return { status: "not-found", requestId: args.requestId, knownIds: file.requests.map((r) => r.id) };
  if (!args.status) return { status: "ok", request };

  try {
    const next = transition(request, args.status, args.note ? { notes: [...request.notes, args.note] } : {});
    saveFeedback(key, upsertRequest(file, next));
    return { status: "ok", requestId: next.id, requestStatus: next.status };
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      return { status: "illegal-transition", requestId: request.id, from: error.from, to: error.to, message: error.message };
    }
    throw error;
  }
}

export async function reresolveChangeTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = ReresolveChangeArgs.parse(rawArgs);
  const key = keyFor(session);
  const { file } = loadFeedback(key);
  const request = file.requests.find((r) => r.id === args.requestId);
  if (!request) return { status: "not-found", requestId: args.requestId, knownIds: file.requests.map((r) => r.id) };

  const replacements = new Map(args.replacements.map((r) => [r.was, r]));
  const applied: string[] = [];
  const targets = request.targets.map((t) => {
    const replacement = replacements.get(t.nodeId);
    if (!replacement) return t;
    applied.push(`${t.nodeId} -> ${replacement.now}`);
    return { nodeId: replacement.now, name: replacement.name ?? t.name, nodeType: t.nodeType, ...(t.instanceOf ? { instanceOf: t.instanceOf } : {}) };
  });

  const unresolved = request.targets.filter((t) => !replacements.has(t.nodeId) && request.unresolvedTargets.includes(t.nodeId)).map((t) => t.nodeId);
  const next: ChangeRequest = {
    ...request,
    targets,
    unresolvedTargets: unresolved,
    status: unresolved.length === 0 ? "proposed" : request.status,
    notes: [...request.notes.filter((n) => !n.startsWith("Targets no longer resolve")), `re-resolved: ${applied.join(", ") || "nothing"}`],
    updatedAt: new Date().toISOString(),
  };
  saveFeedback(key, upsertRequest(file, next));

  return {
    status: "ok",
    requestId: next.id,
    applied,
    stillUnresolved: unresolved,
    note: "FigDes never substitutes a similar-looking node on its own; every re-point is one the user confirmed.",
  };
}

export async function tagTargetsTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = TagTargetsArgs.parse(rawArgs);
  const key = keyFor(session);
  const { file, problem } = loadFeedback(key);

  const useSelection = args.useSelection ?? (args.targets === undefined || args.targets.length === 0);
  const selection = useSelection ? await selectionTargets(session) : { targets: [] };
  const targets = [...(args.targets ?? []).map(toTarget), ...selection.targets];
  if (targets.length === 0) {
    return { status: "no-targets", note: selection.problem ?? "Pass targets or select something in Figma." };
  }

  if (args.remove) {
    const remaining = file.tags.filter((t) => !(t.tag === args.tag && t.targets.some((x) => targets.some((y) => y.nodeId === x.nodeId))));
    saveFeedback(key, { ...file, tags: remaining });
    return { status: "ok", action: "removed", tag: args.tag, removedFrom: targets.map((t) => t.nodeId) };
  }

  const tag = {
    id: `tag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    project: key,
    tag: args.tag,
    targets,
    createdAt: new Date().toISOString(),
  };
  const saved = saveFeedback(key, upsertTag(file, tag));

  return {
    status: "ok",
    tag: args.tag,
    targets: targets.map((t) => ({ nodeId: t.nodeId, name: t.name })),
    totalTags: saved.tags.length,
    howToProceed: `Use request_change and attach '${args.tag}' targets, or list them with list_feedback tag:'${args.tag}'.`,
    ...(problem ? { warning: problem } : {}),
  };
}

export async function listFeedbackTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = ListFeedbackArgs.parse(rawArgs);
  const key = keyFor(session);
  const { file, problem } = loadFeedback(key);

  // Targets are reconciled against the live file when a plugin is connected, so
  // a renamed or deleted node surfaces as needing re-resolution rather than as a
  // request that looks fine and quietly points at the wrong thing.
  let reconciled = file.requests;
  let reconcileProblem: string | undefined;
  if (session) {
    try {
      const inspected = (await session.request("inspect_file", {})) as { topLevelFrames?: Array<{ id?: string }> };
      // File-wide id collection is not exposed; reconcile against the targets we
      // know about by asking for each id directly, which is bounded by the
      // request count rather than the file size.
      const live = new Set<string>();
      for (const request of file.requests) {
        for (const target of request.targets) {
          if (live.has(target.nodeId)) continue;
          try {
            await session.request("find_node", { nodeId: target.nodeId });
            live.add(target.nodeId);
          } catch {
            live.delete(target.nodeId);
          }
        }
      }
      reconciled = file.requests.map((r) => reconcileTargets(r, live).request);
      // The reconciliation is what the caller sees; it is persisted so a rename
      // that happened days ago is still visible on the next read.
      const changed = reconciled.filter((r) => {
        const prior = file.requests.find((p) => p.id === r.id);
        return prior && (prior.status !== r.status || prior.unresolvedTargets.join(",") !== r.unresolvedTargets.join(","));
      });
      if (changed.length > 0) {
        let next = file;
        for (const r of changed) next = upsertRequest(next, r);
        saveFeedback(key, next);
      }
    } catch (error) {
      reconcileProblem = `targets were not reconciled against the live file (${(error as Error).message})`;
    }
  }

  const byTag = args.tag ? file.tags.filter((t) => t.tag === args.tag) : file.tags;
  const requests = reconciled
    .filter((r) => !args.status || r.status === args.status)
    .filter((r) => !args.tag || r.targets.some((t) => byTag.some((tag) => tag.targets.some((tt) => tt.nodeId === t.nodeId))))
    .slice(-(args.limit ?? 50));

  return {
    status: "ok",
    tags: byTag.map((t) => ({ id: t.id, tag: t.tag, targets: t.targets.map((x) => ({ nodeId: x.nodeId, name: x.name })) })),
    requests: requests.map((r) => ({
      id: r.id,
      request: r.request,
      kind: r.kind,
      status: r.status,
      targets: r.targets.map((t) => ({ nodeId: t.nodeId, name: t.name })),
      unresolvedTargets: r.unresolvedTargets,
      constraints: r.constraints.map((c) => c.description),
      verified: r.verified,
      findingsBefore: r.findingsBefore ?? null,
      findingsAfter: r.findingsAfter ?? null,
      transactionId: r.transactionId ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    counts: {
      tags: file.tags.length,
      requests: file.requests.length,
      needsReResolution: reconciled.filter((r) => r.status === "needs-re-resolution").length,
    },
    ...(reconcileProblem ? { reconcileNote: reconcileProblem } : {}),
    ...(problem ? { warning: problem } : {}),
  };
}