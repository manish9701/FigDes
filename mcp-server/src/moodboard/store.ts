/**
 * Moodboard persistence (issue #11, Part C).
 *
 * Same durability contract as project memory: JSON beside the project, written
 * to a temp file and renamed, so a crash mid-write leaves the previous file
 * intact. A reference library that loses itself to an interrupted write is worse
 * than no library, because the user will believe their saved references exist.
 *
 * Kept in its own file rather than folded into project memory: the library is
 * large, mostly binary-adjacent, and read far less often than the handful of
 * approved rules that actually belong in a prompt.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MoodboardFileSchema,
  ProjectVisualProfileSchema,
  type Attachment,
  type Moodboard,
  type MoodboardFile,
  type ProjectVisualProfile,
  type VisualBrief,
} from "./model";

export const MOODBOARD_DIR = resolve(process.env.DESIGN_AGENT_MEMORY_DIR ?? process.cwd(), process.env.DESIGN_AGENT_MEMORY_DIR ? "" : ".memory");

function pathFor(key: string): string {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`Refusing to use an unsafe project key: ${key}`);
  return join(MOODBOARD_DIR, `${key}.moodboards.json`);
}

function profilePathFor(key: string): string {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`Refusing to use an unsafe project key: ${key}`);
  return join(MOODBOARD_DIR, `${key}.visual-profile.json`);
}

function freshFile(project: string): MoodboardFile {
  return { version: 1, project, moodboards: [], briefs: [], attachments: [], updatedAt: new Date().toISOString() };
}

function freshProfile(project: string): ProjectVisualProfile {
  return { project, rules: [], updatedAt: new Date().toISOString() };
}

function writeAtomic(file: string, body: string): void {
  mkdirSync(resolve(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
}

/**
 * Loads the library.
 *
 * Never throws for a missing or unreadable file, and says so rather than
 * pretending the library is empty — a corrupt library must not read as "this
 * project has no references", which would silently change what the agent
 * suggests.
 */
export function loadLibrary(key: string): { library: MoodboardFile; problem?: string } {
  const file = pathFor(key);
  if (!existsSync(file)) return { library: freshFile(key) };
  try {
    const parsed = MoodboardFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      return {
        library: freshFile(key),
        problem: `Moodboard library for '${key}' is not valid (${parsed.error.issues[0]?.message}). It was treated as empty and left untouched. Fix or delete ${file}.`,
      };
    }
    return { library: parsed.data };
  } catch (error) {
    return { library: freshFile(key), problem: `Moodboard library for '${key}' could not be read (${(error as Error).message}). Treated as empty.` };
  }
}

export function saveLibrary(key: string, library: MoodboardFile): MoodboardFile {
  const next = { ...library, project: key, updatedAt: new Date().toISOString() };
  writeAtomic(pathFor(key), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export function loadVisualProfile(key: string): { profile: ProjectVisualProfile; problem?: string } {
  const file = profilePathFor(key);
  if (!existsSync(file)) return { profile: freshProfile(key) };
  try {
    const parsed = ProjectVisualProfileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return { profile: freshProfile(key), problem: `Visual profile for '${key}' is not valid and was treated as empty.` };
    return { profile: parsed.data };
  } catch (error) {
    return { profile: freshProfile(key), problem: `Visual profile for '${key}' could not be read (${(error as Error).message}). Treated as empty.` };
  }
}

export function saveVisualProfile(key: string, profile: ProjectVisualProfile): ProjectVisualProfile {
  const next = { ...profile, project: key, updatedAt: new Date().toISOString() };
  writeAtomic(profilePathFor(key), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

export function upsertMoodboard(library: MoodboardFile, moodboard: Moodboard): MoodboardFile {
  const rest = library.moodboards.filter((m) => m.id !== moodboard.id);
  return { ...library, moodboards: [...rest, moodboard].sort((a, b) => a.id.localeCompare(b.id)) };
}

export function removeMoodboard(library: MoodboardFile, id: string): { library: MoodboardFile; removed: boolean } {
  const existed = library.moodboards.some((m) => m.id === id);
  return {
    library: {
      ...library,
      moodboards: library.moodboards.filter((m) => m.id !== id),
      briefs: library.briefs.filter((b) => b.moodboardId !== id),
      attachments: library.attachments.filter((a) => a.moodboardId !== id),
    },
    removed: existed,
  };
}

export function setBrief(library: MoodboardFile, brief: VisualBrief): MoodboardFile {
  return { ...library, briefs: [...library.briefs.filter((b) => b.moodboardId !== brief.moodboardId), brief] };
}

export function addAttachment(library: MoodboardFile, attachment: Attachment): MoodboardFile {
  return { ...library, attachments: [...library.attachments, attachment] };
}

export function removeAttachment(library: MoodboardFile, id: string): MoodboardFile {
  return { ...library, attachments: library.attachments.filter((a) => a.id !== id) };
}

/**
 * Ends a task: drops its expiring attachments and reports what was kept.
 *
 * A task-only reference leaves active context but stays in the library, which is
 * the whole point of separating the two. Returns the ids that remain so the
 * caller can say so out loud rather than silently mutating state.
 */
export function expireTask(library: MoodboardFile, taskId: string): { library: MoodboardFile; expired: string[]; kept: string[] } {
  const expired: string[] = [];
  const kept: string[] = [];
  const attachments = library.attachments.filter((a) => {
    if (a.taskId !== taskId) return true;
    if (a.expiresAfterTask) {
      expired.push(a.id);
      return false;
    }
    kept.push(a.id);
    return true;
  });
  return { library: { ...library, attachments }, expired, kept };
}