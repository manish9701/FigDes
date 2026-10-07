/**
 * File-backed project memory (spec §27).
 *
 * ## Why files and not a database
 *
 * The memory is a handful of small notes per project. What matters is that it can
 * be read, diffed, committed and corrected by a human — because a design rule
 * nobody can edit is a design rule nobody can argue with. A JSON file under
 * `.memory/` gives all four for free, and `git diff` on a rule change is exactly
 * the review that should happen.
 *
 * ## Durability
 *
 * Writes go to a temp file and are then renamed. A rename is atomic on both NTFS
 * and POSIX, so a crash mid-write leaves the previous memory intact rather than a
 * truncated file that fails to parse on the next load — and losing the memory
 * because of an interrupted write would be the worst possible failure for the
 * one feature whose entire value is persistence.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MemoryNoteSchema, ProjectMemorySchema, type MemoryNote, type ProjectMemory } from "../../../shared/memory";
import { defaultRules } from "./rules-exo";

/**
 * Memory lives beside the project, not inside the user's home directory.
 *
 * Overridable so tests can point it at a temp directory. Without that, a test run
 * would drop `.memory/<project>.json` files into the user's repo, which is both
 * untidy and a way to accidentally commit a fixture.
 */
export const MEMORY_DIR = resolve(process.env.DESIGN_AGENT_MEMORY_DIR ?? process.cwd(), process.env.DESIGN_AGENT_MEMORY_DIR ? "" : ".memory");

/**
 * Turns a Figma file identity into a filename-safe key.
 *
 * `fileKey` is preferred because it survives a rename. Dev-mode files have none —
 * `figma.fileKey` is null for local plugins — so the file name is the fallback.
 * Both are slugged, because a key ends up in a path.
 */
export function projectKey(fileKey: string | null | undefined, fileName: string | null | undefined): string {
  const raw = (fileKey ?? "").trim() || (fileName ?? "").trim() || "unknown";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "unknown";
}

function pathFor(key: string): string {
  // Guards against a key escaping the memory directory. `projectKey` already
  // slugifies, so this is belt-and-braces for a hand-edited file name.
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`Refusing to use an unsafe project key: ${key}`);
  return join(MEMORY_DIR, `${key}.json`);
}

/**
 * Loads a project's memory, creating it from the defaults if absent.
 *
 * Never throws for a missing or unreadable file. A corrupt memory file should
 * degrade to defaults plus a recorded problem, because refusing to run the
 * guard because of a stray comma is the wrong trade.
 */
export function loadMemory(key: string): { memory: ProjectMemory; problem?: string } {
  const file = pathFor(key);

  if (!existsSync(file)) {
    return { memory: { version: 1, project: key, fileKey: null, notes: [], rules: defaultRules(), updatedAt: new Date().toISOString() } };
  }

  try {
    const raw = readFileSync(file, "utf8");
    const parsed = ProjectMemorySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        memory: { version: 1, project: key, fileKey: null, notes: [], rules: defaultRules(), updatedAt: new Date().toISOString() },
        problem: `Memory file for '${key}' is not valid (${parsed.error.issues[0]?.message}). Defaults were used; the file was left untouched.`,
      };
    }
    return { memory: parsed.data };
  } catch (error) {
    return {
      memory: { version: 1, project: key, fileKey: null, notes: [], rules: defaultRules(), updatedAt: new Date().toISOString() },
      problem: `Memory file for '${key}' could not be read (${(error as Error).message}). Defaults were used.`,
    };
  }
}

export function saveMemory(key: string, memory: ProjectMemory): string {
  const file = pathFor(key);
  mkdirSync(dirname(file), { recursive: true });

  const next: ProjectMemory = { ...memory, version: 1, project: memory.project || key, updatedAt: new Date().toISOString() };
  const validated = ProjectMemorySchema.parse(next);

  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  renameSync(temp, file);

  return file;
}

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Adds a note, replacing one with the same id.
 *
 * Replace-by-id rather than append-always: re-recording a corrected note should
 * update it, otherwise "avoid three-card layouts" accumulates five contradictory
 * versions and the guard has no idea which one is current.
 */
export function addNote(memory: ProjectMemory, note: MemoryNote): { memory: ProjectMemory; action: "added" | "updated" } {
  const parsed = MemoryNoteSchema.parse({
    ...note,
    recordedAt: note.recordedAt || new Date().toISOString(),
  });

  const index = memory.notes.findIndex((n) => n.id === parsed.id);
  if (index >= 0) {
    const notes = [...memory.notes];
    notes[index] = parsed;
    return { memory: { ...memory, notes }, action: "updated" };
  }

  return { memory: { ...memory, notes: [...memory.notes, parsed] }, action: "added" };
}

export function removeNote(memory: ProjectMemory, id: string): { memory: ProjectMemory; removed: boolean } {
  const notes = memory.notes.filter((n) => n.id !== id);
  return { memory: { ...memory, notes }, removed: notes.length !== memory.notes.length };
}

/**
 * Selects the notes that apply to what is about to be built.
 *
 * Project notes always apply. Screen notes apply to the named screen, and
 * composition notes to that composition — which is what keeps a decision made on
 * one screen from silently becoming a global law.
 */
export function relevantNotes(memory: ProjectMemory, opts: { screen?: string; composition?: string } = {}): MemoryNote[] {
  return memory.notes.filter((note) => {
    if (note.scope === "project") return true;
    if (note.scope === "screen") return opts.screen !== undefined && note.screen === opts.screen;
    if (note.scope === "composition") return opts.composition !== undefined && note.composition === opts.composition;
    return false;
  });
}

/**
 * Renders the applicable notes as one block of text for the runtime prompt.
 *
 * Kept short on purpose. This text is prepended to a system prompt on every
 * call, so every token spent here is paid on every call; a 40-line memory dump
 * would cost more than it saves.
 */
export function notesForPrompt(memory: ProjectMemory, opts: { screen?: string; composition?: string; limit?: number } = {}): string {
  const notes = relevantNotes(memory, opts);
  if (notes.length === 0) return "";

  const limit = opts.limit ?? 12;
  const shown = notes.slice(0, limit);

  const lines = shown.map((n) => {
    const where = n.scope === "screen" ? `screen:${n.screen}` : n.scope === "composition" ? `composition:${n.composition}` : "project";
    return `- [${where}] ${n.note}`;
  });

  const extra = notes.length - shown.length;
  if (extra > 0) lines.push(`- ...and ${extra} more note(s) not shown. Ask for project_memory to read them.`);

  return ["Project design memory (durable notes about how this project should look):", ...lines].join("\n");
}

/** Renders the rules that carry machine-checkable evidence. */
export function rulesForPrompt(memory: ProjectMemory): string {
  const checkable = memory.rules.filter((r) => r.evidence.some((e) => e.kind !== "manual"));
  if (checkable.length === 0) return "";

  const lines = checkable.map((r) => {
    const sev = r.severity === "fail" ? "FAIL" : "WARN";
    return `- ${sev} ${r.id}: ${r.therefore}`;
  });

  return ["Product rules enforced by design_guard:", ...lines].join("\n");
}