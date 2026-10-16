/**
 * Tags and change-request persistence (issue #11, Part D).
 *
 * Same file contract as project memory and the moodboard library: JSON beside the
 * project, written to a temp file and renamed. Feedback history is the one thing
 * a user would be angriest to lose, because it is the record of what was asked
 * and what was done — and it is also the thing most likely to be interleaved with
 * other work, so it lives in its own file rather than competing with the notes.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { FeedbackFileSchema, type ChangeRequest, type FeedbackFile, type Tag } from "./model";

export const FEEDBACK_DIR = resolve(process.env.DESIGN_AGENT_MEMORY_DIR ?? process.cwd(), process.env.DESIGN_AGENT_MEMORY_DIR ? "" : ".memory");

function pathFor(key: string): string {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`Refusing to use an unsafe project key: ${key}`);
  return join(FEEDBACK_DIR, `${key}.feedback.json`);
}

function fresh(project: string): FeedbackFile {
  return { version: 1, project, tags: [], requests: [], updatedAt: new Date().toISOString() };
}

function writeAtomic(file: string, body: string): void {
  mkdirSync(resolve(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
}

export function loadFeedback(key: string): { file: FeedbackFile; problem?: string } {
  const file = pathFor(key);
  if (!existsSync(file)) return { file: fresh(key) };
  try {
    const parsed = FeedbackFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      return { file: fresh(key), problem: `Feedback history for '${key}' is not valid (${parsed.error.issues[0]?.message}). Treated as empty and left untouched.` };
    }
    return { file: parsed.data };
  } catch (error) {
    return { file: fresh(key), problem: `Feedback history for '${key}' could not be read (${(error as Error).message}). Treated as empty.` };
  }
}

export function saveFeedback(key: string, file: FeedbackFile): FeedbackFile {
  const next = { ...file, project: key, updatedAt: new Date().toISOString() };
  writeAtomic(pathFor(key), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function upsertTag(file: FeedbackFile, tag: Tag): FeedbackFile {
  const rest = file.tags.filter((t) => !(t.tag === tag.tag && sameTargets(t, tag)));
  return { ...file, tags: [...rest, tag] };
}

export function removeTag(file: FeedbackFile, tagId: string): FeedbackFile {
  return { ...file, tags: file.tags.filter((t) => t.id !== tagId) };
}

export function upsertRequest(file: FeedbackFile, request: ChangeRequest): FeedbackFile {
  const rest = file.requests.filter((r) => r.id !== request.id);
  return { ...file, requests: [...rest, request] };
}

function sameTargets(a: Tag, b: Tag): boolean {
  const x = a.targets.map((t) => t.nodeId).sort().join(",");
  const y = b.targets.map((t) => t.nodeId).sort().join(",");
  return x === y;
}

/* -------------------------------------------------------------------------- */
/* Re-resolution                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Re-checks every target against the live node table.
 *
 * A target whose id is gone moves the request to `needs-re-resolution` rather
 * than being quietly dropped or replaced by a name match. The issue is explicit
 * that a similar-looking node must not be modified in its place, and that the
 * user is asked to re-resolve.
 *
 * Renames and reorders do *not* break a target, because resolution is by id —
 * which is the property that makes this feature usable at all.
 */
export function reconcileTargets(
  request: ChangeRequest,
  liveIds: Set<string>,
): { request: ChangeRequest; resolved: string[]; unresolved: string[] } {
  const resolved = request.targets.filter((t) => liveIds.has(t.nodeId)).map((t) => t.nodeId);
  const unresolved = request.targets.filter((t) => !liveIds.has(t.nodeId)).map((t) => t.nodeId);

  if (unresolved.length === 0) {
    return { request: { ...request, unresolvedTargets: [] }, resolved, unresolved };
  }

  return {
    request: {
      ...request,
      unresolvedTargets: unresolved,
      // Status moves only out of a state where targets still resolved. An
      // already-applied request stays applied — its history is a record of what
      // happened, not a live pointer.
      status: request.status === "needs-re-resolution" ? request.status : ("needs-re-resolution" as const),
      notes: [
        ...request.notes.filter((n) => !n.startsWith("Targets no longer resolve")),
        `Targets no longer resolve: ${unresolved.join(", ")}. Re-resolve them; FigDes will not substitute a similar-looking node.`,
      ],
    },
    resolved,
    unresolved,
  };
}