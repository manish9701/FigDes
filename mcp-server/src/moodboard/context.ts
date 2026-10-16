/**
 * Assembling moodboard context for one task (issue #11, Part C).
 *
 * ## What this file guarantees
 *
 * Every acceptance criterion about moodboards is a property of *what gets
 * included*, so the inclusion decision is a pure function with its own tests:
 *
 *  - **Inactive by default.** With no attachment, the only moodboard content in a
 *    context is the approved project profile. A saved reference changes nothing
 *    until someone attaches it.
 *  - **No leak.** Attachments are looked up by task id. There is no code path
 *    that puts one task's attachment into another's context, which is the
 *    property the issue asks for and the one that is easiest to lose by accident
 *    later.
 *  - **Budget.** The assembled context is capped and reports what it dropped,
 *    rather than silently truncating mid-sentence.
 *  - **Conflicts surfaced.** A reference that contradicts the approved profile is
 *    reported as a conflict. Silently preferring one is how an image of a
 *    different product quietly becomes this product's design system.
 *  - **Provenance kept.** Every injected line says where it came from and how
 *    sure the extraction was, so the model can tell a measured value from a
 *    guess and the log can distinguish them.
 */
import type { Attachment, Influence, MoodboardFile, Observation, ProjectVisualProfile, Scope } from "./model";

/** Characters of moodboard-derived text injected per task. */
export const DEFAULT_CONTEXT_BUDGET = 2400;

/**
 * How much of a reference the agent should take, per influence.
 *
 * Subtle means "borrow the restraint, not the specifics"; strong means "match it
 * unless a product rule forbids it". This is a count, not a probability: an
 * influence that cannot be expressed as "how many approved observations survive"
 * is not one the context builder can honour.
 */
const INFLUENCE_TAKE: Record<Influence, number> = { subtle: 0.25, balanced: 0.6, strong: 1 };

/**
 * Narrower scope wins.
 *
 * Ordered rather than ranked by a score: a rule scoped to two components must not
 * be overridden by one scoped to the whole project, because the narrower one is
 * the more specific statement of intent. Ties keep project scope last so the
 * broadest rule is the fallback.
 */
const SCOPE_PRECEDENCE: Record<Scope, number> = { components: 0, screen: 1, task: 2, project: 3 };

export interface ContextEntry {
  kind: "profile-rule" | "attached-observation" | "conflict" | "exclusion";
  text: string;
  /** Moodboard the entry came from, when it came from one. */
  moodboardId?: string;
  /** Observation id, for tracing back to the brief. */
  observationId?: string;
  confidence?: number;
  provenance?: Observation["provenance"];
  influence?: Influence;
  scope?: Scope;
  /** Why this entry is here. */
  reason: string;
}

export interface AssembledContext {
  entries: ContextEntry[];
  /** The rendered text to inject. Empty when nothing is active. */
  text: string;
  /** Characters used against the budget. */
  used: number;
  budget: number;
  /** Entries dropped to stay inside the budget, and why. */
  dropped: Array<{ reason: string; detail: string }>;
  /** Attachments that were considered for this task. */
  attachedMoodboardIds: string[];
  /** Conflicts between attached references and the approved profile. */
  conflicts: Array<{ moodboardId: string; profileRule: string; attached: string; resolution: string }>;
  /** Explicit "no moodboard is active" statement, so absence is legible. */
  inactiveNote: string;
}

/** A short, stable identifier for an observation's origin. */
function origin(o: Observation): string {
  return `${o.moodboardId}/${o.id}`;
}

/**
 * Renders one observation as an injectable line.
 *
 * Deliberately carries the provenance in the line itself. "warm paper surface
 * (observed, 0.7)" is materially different guidance from "warm paper surface",
 * and the difference is the difference between following a measurement and
 * following a guess.
 */
function renderObservation(o: Observation, influence: Influence): string {
  const confidence = Math.round(o.confidence * 100) / 100;
  const source = o.evidence?.area ?? o.evidence?.sourceNodeId ?? "whole image";
  return `- [${o.kind}, ${confidence} confidence, ${o.provenance}] ${o.claim} (from ${origin(o)}, evidence: ${source})`;
}

/**
 * Builds the moodboard context for one task.
 *
 * `taskId` is the scope boundary. Passing an attachment from another task is not
 * possible through this function, because attachments are filtered by it before
 * anything else happens.
 */
export function assembleContext(input: {
  library: MoodboardFile;
  profile: ProjectVisualProfile;
  taskId: string;
  /** Optional narrower filter, when the task names specific components. */
  targetNodeIds?: string[];
  budget?: number;
}): AssembledContext {
  const budget = input.budget ?? DEFAULT_CONTEXT_BUDGET;
  const entries: ContextEntry[] = [];
  const dropped: Array<{ reason: string; detail: string }> = [];
  const conflicts: AssembledContext["conflicts"] = [];

  /* --- approved project profile: always present, and small by design ------ */

  for (const rule of input.profile.rules) {
    entries.push({
      kind: "profile-rule",
      text: `- [approved] ${rule.claim}${rule.evidence ? ` (evidence: ${rule.evidence})` : ""}`,
      moodboardId: rule.moodboardId,
      observationId: rule.observationId,
      reason: "approved project profile",
      scope: "project",
    });
  }

  /* --- attachments for this task only ------------------------------------ */

  const taskAttachments = input.library.attachments.filter((a) => a.taskId === input.taskId);

  // A component-scoped attachment that does not cover any requested node is not
  // relevant to this task. Silently including it would be the scope failure the
  // issue warns about, in the direction that is hardest to notice.
  const inScope = taskAttachments.filter((a) => {
    if (a.scope !== "components") return true;
    if (a.targetNodeIds.length === 0) return false;
    const wanted = new Set(input.targetNodeIds ?? []);
    return a.targetNodeIds.some((id) => wanted.has(id));
  });

  for (const skipped of taskAttachments.filter((a) => !inScope.includes(a))) {
    dropped.push({ reason: "out-of-scope", detail: `attachment '${skipped.id}' does not cover the requested components` });
  }

  const briefOf = (moodboardId: string): { observations: Observation[]; partial: boolean; unreadable: string[] } => {
    const brief = input.library.briefs.find((b) => b.moodboardId === moodboardId);
    if (!brief) return { observations: [], partial: false, unreadable: [] };
    return { observations: brief.observations, partial: brief.partial, unreadable: brief.unreadableSources };
  };

  for (const attachment of inScope.sort((a, b) => SCOPE_PRECEDENCE[a.scope] - SCOPE_PRECEDENCE[b.scope])) {
    const moodboard = input.library.moodboards.find((m) => m.id === attachment.moodboardId);
    if (!moodboard) {
      dropped.push({ reason: "missing-moodboard", detail: `attachment '${attachment.id}' names moodboard '${attachment.moodboardId}', which is not in the library` });
      continue;
    }

    // Unreadable sources are surfaced, not summarised away. The brief is checked
    // too, because a source can become unreadable *after* it was saved and the
    // partial state would then only exist in the brief.
    const brief = briefOf(moodboard.id);
    const unreadableNow = moodboard.sources.filter((s) => !s.readable);
    if (unreadableNow.length > 0 || brief.partial) {
      const detail =
        unreadableNow.length > 0
          ? `${unreadableNow.length} source(s) could not be read`
          : brief.unreadable.length > 0
            ? brief.unreadable.join("; ")
            : "at least one source was unreadable during analysis";
      entries.push({
        kind: "profile-rule",
        text: `- [partial analysis] moodboard '${moodboard.title}' is incomplete: ${detail}. Treat its observations as incomplete.`,
        moodboardId: moodboard.id,
        reason: "the brief is partial",
        scope: attachment.scope,
      });
    }
    // Roles narrow what may be taken: a typography reference must not dictate
    // layout. No roles means the reference speaks to everything.
    const eligible = brief.observations.filter(
      (o) => o.approved && (attachment.roles.length === 0 || attachment.roles.includes(roleFor(o.kind))),
    );
    const filteredOut = brief.observations.filter((o) => o.approved && !eligible.includes(o));
    for (const o of filteredOut) {
      dropped.push({ reason: "role-excluded", detail: `${origin(o)} is ${o.kind}, outside this attachment's roles` });
    }

    const take = Math.max(1, Math.ceil(eligible.length * INFLUENCE_TAKE[attachment.influence]));
    const kept = eligible.slice(0, take);
    for (const o of eligible.slice(take)) {
      dropped.push({ reason: "influence", detail: `${origin(o)} held back: attachment influence is '${attachment.influence}'` });
    }

    for (const o of kept) {
      const line = renderObservation(o, attachment.influence);
      for (const excluded of attachment.exclusions) {
        if (o.claim.toLowerCase().includes(excluded.toLowerCase())) {
          dropped.push({ reason: "exclusion", detail: `${origin(o)} matches exclusion '${excluded}'` });
          break;
        }
      }
      if (attachment.exclusions.some((ex) => o.claim.toLowerCase().includes(ex.toLowerCase()))) continue;

      entries.push({
        kind: "attached-observation",
        text: line,
        moodboardId: moodboard.id,
        observationId: o.id,
        confidence: o.confidence,
        provenance: o.provenance,
        influence: attachment.influence,
        scope: attachment.scope,
        reason: `attached to task '${input.taskId}' at '${attachment.influence}' influence, scope '${attachment.scope}'`,
      });

      // Conflict detection against the approved profile.
      const clash = input.profile.rules.find((r) => claimsConflict(r.claim, o.claim));
      if (clash) {
        conflicts.push({
          moodboardId: moodboard.id,
          profileRule: clash.claim,
          attached: o.claim,
          resolution:
            attachment.influence === "strong"
              ? "the attached reference wins for this task, and the conflict is recorded for review"
              : "the approved profile wins; flag this conflict to the user rather than resolving it silently",
        });
      }
    }
  }

  /* --- budget ------------------------------------------------------------ */

  let used = 0;
  const keptEntries: ContextEntry[] = [];
  for (const entry of entries) {
    const cost = entry.text.length + 1;
    if (used + cost > budget) {
      dropped.push({ reason: "budget", detail: `dropped ${entry.observationId ?? entry.reason} at ${used}/${budget} characters` });
      continue;
    }
    used += cost;
    keptEntries.push(entry);
  }

  const attachedMoodboardIds = [...new Set(inScope.map((a) => a.moodboardId))];
  const text = keptEntries.length === 0 ? "" : keptEntries.map((e) => e.text).join("\n");

  return {
    entries: keptEntries,
    text,
    used,
    budget,
    dropped,
    attachedMoodboardIds,
    conflicts,
    inactiveNote:
      keptEntries.length === 0
        ? "No moodboard is attached to this task. Only the approved project profile applies; nothing else has been injected."
        : `${attachedMoodboardIds.length} moodboard(s) attached to this task. Unattached references in the library were not consulted.`,
  };
}

/** Maps an observation kind onto the attachment role that may carry it. */
function roleFor(kind: Observation["kind"]): Attachment["roles"][number] {
  switch (kind) {
    case "palette":
    case "surface":
    case "shape":
      return "visual-style";
    case "typography":
      return "typography";
    case "spacing":
    case "grid":
    case "density":
      return "layout";
    case "component-pattern":
      return "component-pattern";
    default:
      return "visual-style";
  }
}

/**
 * Whether two claims are in tension.
 *
 * Deliberately narrow. Only opposite assertions about the same axis count, so
 * this reports "the profile wants dark surfaces, the reference wants light" and
 * not every pair that happens to share a word. A conflict detector that cries
 * wolf gets ignored, and then the real one is missed too.
 */
export function claimsConflict(profileRule: string, attached: string): boolean {
  const a = profileRule.toLowerCase();
  const b = attached.toLowerCase();

  const axes: Array<[RegExp, RegExp]> = [
    [/\b(dark|darker|deep)\b/, /\b(light|lighter|bright|pale)\b/],
    [/\b(warm)\b/, /\b(cool|cold)\b/],
    [/\b(dense|denser|compact)\b/, /\b(sparse|airy|generous|open)\b/],
    [/\b(bold|heavy)\b/, /\b(light weight|thin|quiet|subtle)\b/],
    [/\b(rounded|soft)\b/, /\b(sharp|square|angular)\b/],
  ];
  return axes.some(([x, y]) => (x.test(a) && y.test(b)) || (y.test(a) && x.test(b)));
}