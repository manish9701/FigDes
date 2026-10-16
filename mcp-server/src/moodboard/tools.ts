/**
 * MCP tools for moodboards (issue #11, Part C).
 *
 * Seven tools, matching the workflow the issue specifies:
 *
 *   save_moodboard        1. user selects frames/images and saves them
 *   analyse_moodboard     3. extract palette/type/spacing/... with evidence
 *   get_visual_brief      4. the editable brief
 *   update_visual_brief   4. user edits an observation before approving
 *   approve_observations  5. explicit approval into the project profile
 *   attach_moodboard      5. opt-in per task, with influence/scope/roles
 *   moodboard_context     what a task would actually receive
 *
 * Plus `list_moodboards` and `end_task_context`.
 *
 * The split that matters: saving is not approving, and analysing is not
 * attaching. Each is a separate call the user makes deliberately, because the
 * issue's central requirement is that a saved reference never becomes an active
 * rule by accident.
 */
import { z } from "zod";
import type { Session } from "../sessions";
import { loadLibrary, loadVisualProfile, saveLibrary, saveVisualProfile, addAttachment, removeAttachment, setBrief, upsertMoodboard, removeMoodboard, expireTask } from "./store";
import { projectKey } from "../memory/store";
import { assembleContext, DEFAULT_CONTEXT_BUDGET } from "./context";
import { buildBrief, measureFrame, type MeasurableFrame, type ProposedObservation } from "./analysis";
import { InfluenceSchema, ReferenceRoleSchema, ScopeSchema, MoodboardSourceSchema, type Attachment, type Moodboard, type Observation } from "./model";

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

export const SaveMoodboardArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    id: z.string().min(1).max(80).optional(),
    title: z.string().min(1).max(200),
    intent: z.string().max(1000).optional(),
    /** Figma node ids to save. Read live from the plugin when a session exists. */
    nodeIds: z.array(z.string().max(200)).max(40).optional(),
    /** Sources given directly, for images and externally hosted references. */
    sources: z.array(MoodboardSourceSchema).max(40).optional(),
    /** Render previews for the saved frames. */
    previews: z.boolean().optional().describe("Capture a thumbnail of each saved frame. Default true when a plugin is connected."),
  })
  .strict();

export const AnalyseMoodboardArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    moodboardId: z.string().min(1).max(80),
    /**
     * Observations extracted from an image by a vision-capable model.
     *
     * Accepted rather than invented: the agent calling this tool is the
     * vision-capable model, so having it return structured claims is both cheaper
     * and more honest than a server-side guess. Anything supplied here is marked
     * `inferred`, never `measured`.
     */
    observations: z
      .array(
        z
          .object({
            kind: z.enum(["palette", "typography", "spacing", "grid", "density", "shape", "surface", "component-pattern", "anti-pattern"]),
            claim: z.string().min(3).max(400),
            confidence: z.number().min(0).max(1),
            evidence: z
              .object({
                sourceNodeId: z.string().max(200).optional(),
                area: z.string().max(200).optional(),
                measurement: z.record(z.unknown()).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();

export const UpdateVisualBriefArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    moodboardId: z.string().min(1).max(80),
    observationId: z.string().min(1).max(80),
    /** The user's own wording. Marks the observation as user-authored. */
    claim: z.string().min(3).max(400).optional(),
    /** Remove an observation the extraction got wrong. */
    remove: z.boolean().optional(),
  })
  .strict();

export const ApproveObservationsArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    moodboardId: z.string().min(1).max(80),
    observationIds: z.array(z.string().min(1).max(80)).min(1).max(60),
  })
  .strict()
  .describe("Approve extracted observations into the project profile. This is the only path by which a moodboard becomes a standing rule.");

export const AttachMoodboardArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    moodboardId: z.string().min(1).max(80),
    /** The task this reference belongs to. Task scope never leaks across tasks. */
    taskId: z.string().min(1).max(120),
    influence: InfluenceSchema.optional(),
    scope: ScopeSchema.optional(),
    roles: z.array(ReferenceRoleSchema).max(6).optional(),
    exclusions: z.array(z.string().max(200)).max(20).optional(),
    targetNodeIds: z.array(z.string().max(200)).max(200).optional(),
    screenId: z.string().max(120).optional(),
    expiresAfterTask: z.boolean().optional(),
  })
  .strict();

export const MoodboardContextArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    taskId: z.string().min(1).max(120),
    targetNodeIds: z.array(z.string().max(200)).max(200).optional(),
    budget: z.number().int().min(200).max(20000).optional(),
  })
  .strict()
  .describe("Exactly what moodboard context a task would receive, and what was left out. Use this to check scope before generating.");

export const EndTaskContextArgs = z
  .object({ sessionId: z.string().max(200).optional(), taskId: z.string().min(1).max(120) })
  .strict();

export const ListMoodboardsArgs = z
  .object({ sessionId: z.string().max(200).optional(), includeBrief: z.boolean().optional() })
  .strict();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function keyFor(session: Session | null, project?: string): string {
  return projectKey(project ?? session?.fileKey, session?.fileName);
}

/**
 * Reads a frame's measurable structure from the plugin.
 *
 * Returns null when the node cannot be read, and the caller records that rather
 * than proceeding with an empty frame — an unreadable source is a state the
 * issue requires be visible.
 */
async function readFrame(session: Session | null, nodeId: string): Promise<MeasurableFrame | null> {
  if (!session) return null;
  try {
    const raw = (await session.request("inspect_selection", { target: nodeId, maxNodes: 4000 })) as { nodes?: MeasurableFrame["nodes"] };
    const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    if (nodes.length === 0) return null;
    return { id: nodeId, name: nodeId, nodes: nodes as MeasurableFrame["nodes"] };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

export async function saveMoodboardTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = SaveMoodboardArgs.parse(rawArgs);
  const key = keyFor(session);
  const { library, problem } = loadLibrary(key);
  const id = args.id ?? `mb-${Date.now().toString(36)}`;

  const sources: Moodboard["sources"] = [];

  for (const nodeId of args.nodeIds ?? []) {
    // Readability is established here, not assumed. A frame we cannot open is
    // saved with the reason attached, so the analysis step can report a partial
    // brief instead of quietly analysing nothing.
    const frame = await readFrame(session, nodeId);
    sources.push({
      kind: "figma-node",
      nodeId,
      pageName: undefined,
      fileKey: session?.fileKey ?? null,
      label: frame?.name ?? nodeId,
      readable: frame !== null,
      ...(frame === null ? { unreadableReason: "the plugin could not read this node" } : {}),
    });
  }
  sources.push(...(args.sources ?? []));

  if (sources.length === 0) {
    throw new Error("save_moodboard needs at least one source: pass nodeIds for Figma frames, or sources for images.");
  }

  const moodboard: Moodboard = {
    id,
    project: key,
    title: args.title,
    sources,
    createdAt: new Date().toISOString(),
    ...(args.intent !== undefined ? { intent: args.intent } : {}),
  };

  const saved = saveLibrary(key, upsertMoodboard(library, moodboard));

  return {
    status: "ok",
    moodboard: { id, title: moodboard.title, sources: moodboard.sources.length, readable: moodboard.sources.filter((s) => s.readable).length },
    saved: saved.moodboards.length,
    active: false,
    nextStep: "Saved. A moodboard is inactive until it is analysed, approved and attached to a task. Call analyse_moodboard next.",
    ...(problem ? { warning: problem } : {}),
  };
}

export async function analyseMoodboardTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = AnalyseMoodboardArgs.parse(rawArgs);
  const key = keyFor(session);
  const { library, problem } = loadLibrary(key);
  const moodboard = library.moodboards.find((m) => m.id === args.moodboardId);
  if (!moodboard) {
    return {
      status: "not-found",
      moodboardId: args.moodboardId,
      knownIds: library.moodboards.map((m) => m.id),
      howToProceed: "No moodboard with that id exists in this project's library.",
    };
  }

  const measured: Observation[] = [];
  const failedSources: string[] = [];

  for (const source of moodboard.sources) {
    if (!source.readable) {
      failedSources.push(`${source.label || source.nodeId}: ${source.unreadableReason ?? "not readable"}`);
      continue;
    }
    if (source.kind !== "figma-node" || !source.nodeId) continue;
    const frame = await readFrame(session, source.nodeId);
    if (!frame) {
      failedSources.push(`${source.label || source.nodeId}: the frame could not be read during analysis`);
      continue;
    }
    measured.push(...measureFrame(source, frame));
  }

  const proposed: ProposedObservation[] = (args.observations ?? []).map((o, i) => ({
    id: `prop-${i + 1}`,
    moodboardId: moodboard.id,
    kind: o.kind,
    claim: o.claim,
    confidence: o.confidence,
    provenance: "inferred",
    ...(o.evidence !== undefined ? { evidence: o.evidence } : {}),
    approved: false,
    editedByUser: false,
  }));

  // Unreadable sources discovered during analysis join the ones known at save
  // time, so "partial" reflects the state now rather than when it was saved.
  const sources = moodboard.sources.map((s) =>
    failedSources.some((f) => f.startsWith((s.label || s.nodeId || "") + ":")) && s.readable
      ? { ...s, readable: false, unreadableReason: "could not be read during analysis" }
      : s,
  );

  const brief = buildBrief({ moodboardId: moodboard.id, sources, measured, proposed });
  const saved = saveLibrary(key, setBrief({ ...library, moodboards: library.moodboards.map((m) => (m.id === moodboard.id ? { ...moodboard, sources } : m)) }, brief));

  return {
    status: brief.partial ? "partial" : "ok",
    moodboardId: moodboard.id,
    observations: brief.observations.length,
    measured: measured.length,
    inferred: proposed.length,
    partial: brief.partial,
    ...(brief.unreadableSources.length > 0 ? { unreadableSources: brief.unreadableSources } : {}),
    brief: saved.briefs.find((b) => b.moodboardId === moodboard.id),
    nextStep: brief.partial
      ? `Partial analysis: ${brief.unreadableSources.length} source(s) could not be read. Review the brief, then approve what holds. Nothing here affects a screen until it is approved and attached.`
      : "Review the brief, edit anything misread, then approve the observations you want to become project rules.",
    ...(problem ? { warning: problem } : {}),
  };
}

export async function getVisualBriefTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = z.object({ sessionId: z.string().max(200).optional(), moodboardId: z.string().min(1).max(80) }).strict().parse(rawArgs);
  const key = keyFor(session);
  const { library } = loadLibrary(key);
  const moodboard = library.moodboards.find((m) => m.id === args.moodboardId);
  const brief = library.briefs.find((b) => b.moodboardId === args.moodboardId);
  if (!moodboard) return { status: "not-found", knownIds: library.moodboards.map((m) => m.id) };

  return {
    status: "ok",
    moodboard: { id: moodboard.id, title: moodboard.title, intent: moodboard.intent ?? null },
    sources: moodboard.sources,
    brief: brief ?? null,
    approvedIntoProfile: brief?.observations.filter((o) => o.approved).length ?? 0,
    active: library.attachments.some((a) => a.moodboardId === moodboard.id),
  };
}

export async function updateVisualBriefTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = UpdateVisualBriefArgs.parse(rawArgs);
  const key = keyFor(session);
  const { library } = loadLibrary(key);
  const brief = library.briefs.find((b) => b.moodboardId === args.moodboardId);
  if (!brief) return { status: "not-found", moodboardId: args.moodboardId };

  const observations = brief.observations
    .filter((o) => !(args.remove && o.id === args.observationId))
    .map((o) =>
      o.id === args.observationId && args.claim !== undefined
        ? { ...o, claim: args.claim, editedByUser: true, provenance: "user-stated" as const }
        : o,
    );
  const next = { ...brief, observations };
  saveLibrary(key, setBrief(library, next));
  return { status: "ok", moodboardId: args.moodboardId, observations: next.observations.length, removed: args.remove === true };
}

export async function approveObservationsTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = ApproveObservationsArgs.parse(rawArgs);
  const key = keyFor(session);
  const { library } = loadLibrary(key);
  const brief = library.briefs.find((b) => b.moodboardId === args.moodboardId);
  if (!brief) return { status: "not-found", moodboardId: args.moodboardId, howToProceed: "Analyse the moodboard before approving observations from it." };

  const wanted = new Set(args.observationIds);
  const unknown = args.observationIds.filter((id) => !brief.observations.some((o) => o.id === id));
  const toApprove = brief.observations.filter((o) => wanted.has(o.id));

  const nextBrief = { ...brief, observations: brief.observations.map((o) => (wanted.has(o.id) ? { ...o, approved: true } : o)) };
  saveLibrary(key, setBrief(library, nextBrief));

  // The profile carries claim plus a pointer back to its evidence, never the
  // whole observation. It has to stay small enough to be read every turn.
  const { profile } = loadVisualProfile(key);
  const rules = [
    ...profile.rules.filter((r) => r.moodboardId !== args.moodboardId || !wanted.has(r.observationId)),
    ...toApprove.map((o) => ({
      observationId: o.id,
      moodboardId: args.moodboardId,
      kind: o.kind,
      claim: o.claim,
      ...(o.evidence?.area || o.evidence?.sourceNodeId
        ? { evidence: `${o.evidence.area ?? ""}${o.evidence.sourceNodeId ? ` (${o.evidence.sourceNodeId})` : ""}`.trim() }
        : {}),
    })),
  ];
  const saved = saveVisualProfile(key, { ...profile, rules });

  return {
    status: "ok",
    moodboardId: args.moodboardId,
    approved: toApprove.map((o) => o.id),
    ...(unknown.length > 0 ? { unknownObservationIds: unknown } : {}),
    profileRuleCount: saved.rules.length,
    nextStep: "Approved observations now form part of the project profile and apply by default. The moodboard itself stays inactive until attached to a specific task.",
  };
}

export async function attachMoodboardTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = AttachMoodboardArgs.parse(rawArgs);
  const key = keyFor(session);
  const { library } = loadLibrary(key);
  if (!library.moodboards.some((m) => m.id === args.moodboardId)) {
    return { status: "not-found", moodboardId: args.moodboardId, knownIds: library.moodboards.map((m) => m.id) };
  }

  const attachment: Attachment = {
    id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    moodboardId: args.moodboardId,
    project: key,
    taskId: args.taskId,
    influence: args.influence ?? "balanced",
    scope: args.scope ?? "task",
    roles: args.roles ?? [],
    exclusions: args.exclusions ?? [],
    targetNodeIds: args.targetNodeIds ?? [],
    ...(args.screenId !== undefined ? { screenId: args.screenId } : {}),
    attachedAt: new Date().toISOString(),
    expiresAfterTask: args.expiresAfterTask ?? true,
  };
  saveLibrary(key, addAttachment(library, attachment));

  const context = assembleContext({ library: addAttachment(library, attachment), profile: loadVisualProfile(key).profile, taskId: args.taskId });

  return {
    status: "ok",
    attachment,
    activeForTask: args.taskId,
    observedEntries: context.entries.filter((e) => e.kind === "attached-observation").length,
    ...(context.dropped.length > 0 ? { heldBack: context.dropped } : {}),
    ...(context.conflicts.length > 0 ? { conflicts: context.conflicts, note: "Surface these to the user rather than resolving them silently." } : {}),
    nextStep: `Attached to task '${args.taskId}' only. No other task can see it. Call moodboard_context to see exactly what it will inject.`,
  };
}

export async function moodboardContextTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = MoodboardContextArgs.parse(rawArgs);
  const key = keyFor(session);
  const { library, problem } = loadLibrary(key);
  const { profile } = loadVisualProfile(key);
  const context = assembleContext({
    library,
    profile,
    taskId: args.taskId,
    ...(args.targetNodeIds !== undefined ? { targetNodeIds: args.targetNodeIds } : {}),
    budget: args.budget ?? DEFAULT_CONTEXT_BUDGET,
  });

  return {
    status: "ok",
    taskId: args.taskId,
    ...context,
    howToProceed:
      context.entries.length === 0
        ? "Nothing is attached. Only the approved project profile would apply, and it is empty."
        : "This is exactly the moodboard content this task receives. Anything listed under `dropped` did not make it in.",
    ...(problem ? { warning: problem } : {}),
  };
}

export async function endTaskContextTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = EndTaskContextArgs.parse(rawArgs);
  const key = keyFor(session);
  const { library } = loadLibrary(key);
  const result = expireTask(library, args.taskId);
  saveLibrary(key, result.library);

  return {
    status: "ok",
    taskId: args.taskId,
    expiredAttachments: result.expired,
    keptAttachments: result.kept,
    moodboardsStillInLibrary: result.expired.length,
    note: "Expired attachments left active context. The moodboards themselves are still in the library and can be re-attached.",
  };
}

export async function listMoodboardsTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = ListMoodboardsArgs.parse(rawArgs);
  const key = keyFor(session);
  const { library, problem } = loadLibrary(key);
  const { profile } = loadVisualProfile(key);

  return {
    status: "ok",
    count: library.moodboards.length,
    moodboards: library.moodboards.map((m) => {
      const brief = library.briefs.find((b) => b.moodboardId === m.id);
      return {
        id: m.id,
        title: m.title,
        sources: m.sources.length,
        readable: m.sources.filter((s) => s.readable).length,
        observations: brief?.observations.length ?? 0,
        approved: brief?.observations.filter((o) => o.approved).length ?? 0,
        partial: brief?.partial ?? null,
        activeTasks: [...new Set(library.attachments.filter((a) => a.moodboardId === m.id).map((a) => a.taskId))],
        ...(args.includeBrief ? { brief } : {}),
      };
    }),
    projectProfile: { ruleCount: profile.rules.length, rules: profile.rules.map((r) => r.claim) },
    attachments: library.attachments.map((a) => ({ id: a.id, moodboardId: a.moodboardId, taskId: a.taskId, influence: a.influence, scope: a.scope })),
    note: "Saved moodboards are inactive. Only approved observations in the project profile apply without an explicit attachment.",
    ...(problem ? { warning: problem } : {}),
  };
}

export async function detachMoodboardTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = z.object({ sessionId: z.string().max(200).optional(), attachmentId: z.string().min(1).max(80) }).strict().parse(rawArgs);
  const key = keyFor(session);
  const { library } = loadLibrary(key);
  if (!library.attachments.some((a) => a.id === args.attachmentId)) return { status: "not-found", attachmentId: args.attachmentId };
  saveLibrary(key, removeAttachment(library, args.attachmentId));
  return { status: "ok", attachmentId: args.attachmentId, note: "The moodboard stays in the library; only this attachment was removed." };
}

export async function deleteMoodboardTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = z.object({ sessionId: z.string().max(200).optional(), moodboardId: z.string().min(1).max(80) }).strict().parse(rawArgs);
  const key = keyFor(session);
  const { library } = loadLibrary(key);
  const result = removeMoodboard(library, args.moodboardId);
  if (!result.removed) return { status: "not-found", moodboardId: args.moodboardId };
  saveLibrary(key, result.library);
  return { status: "ok", moodboardId: args.moodboardId, note: "Removed, along with its brief and any attachments." };
}