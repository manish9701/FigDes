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
import {
  MemoryNoteSchema,
  ProjectMemorySchema,
  type MemoryNote,
  type ProductRule,
  type ProjectMemory,
  type ProjectProfileRef,
} from "../../../shared/memory";
import { defaultRules } from "./rules-exo";
import {
  profileForProduct,
  resolveActiveProduct,
  assertKnownProfile,
  keySeedsProfile,
} from "./profiles";

/** Re-exported for callers that read the built-in set through the store module. */
export { defaultRules };

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
  /**
   * A fresh memory carries NO product rules and NO product notes unless the
   * project key itself names a known product (GitHub issue #27). Seeding one
   * product's truths into every unrelated project was the cross-project leak
   * the profile boundary exists to prevent: "acme-landing" must not open with
   * EXO's rules, and an unowned project must not open with any of them.
   */
  const fresh = (): ProjectMemory => ({
    version: 1,
    project: key,
    fileKey: null,
    notes: defaultNotes(key),
    rules: defaultRulesFor(key),
    ...(defaultProfileFor(key) !== null ? { profile: { product: defaultProfileFor(key)! } as ProjectProfileRef } : {}),
    updatedAt: new Date().toISOString(),
  });

  const file = pathFor(key);

  if (!existsSync(file)) {
    return { memory: fresh() };
  }

  try {
    const raw = readFileSync(file, "utf8");
    const parsed = ProjectMemorySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        memory: fresh(),
        problem: `Memory file for '${key}' is not valid (${parsed.error.issues[0]?.message}). Defaults were used; the file was left untouched.`,
      };
    }
    return { memory: parsed.data };
  } catch (error) {
    return {
      memory: fresh(),
      problem: `Memory file for '${key}' could not be read (${(error as Error).message}). Defaults were used.`,
    };
  }
}

/**
 * Default visual notes for a new project (FigDes §32).
 *
 * Only seeded when the project key names a product as its own word (the
 * issue #27 key seed): these notes are product-identity judgements
 * (topology heroes, restrained accents, open surfaces), and imposing
 * another product's taste on an unrelated file would be exactly the kind of
 * silent presumption this system exists to avoid. Every one can be forgotten
 * with project_memory forget.
 */
function defaultNotes(key: string): ProjectMemory["notes"] {
  const product = keySeedsProfile(key);
  if (!product) return [];
  if (product !== "exo") return []; // no seeded identity notes defined for this profile yet
  const at = new Date().toISOString();
  return [
    { id: "visual-topology-hero", note: "Prefer topology as the hero visualization on system screens.", scope: "project", tags: ["visual", "default"], recordedAt: at },
    { id: "visual-open-surfaces", note: "Prefer open surfaces over bordered cards; avoid unnecessary card borders.", scope: "project", tags: ["visual", "default"], recordedAt: at },
    { id: "visual-restrained-accents", note: "Use accent colour sparingly: one action yellow, one health green, nothing neon.", scope: "project", tags: ["visual", "default"], recordedAt: at },
    { id: "visual-quiet-metrics", note: "Metrics are quiet instrument readouts, never a KPI wall.", scope: "project", tags: ["visual", "default"], recordedAt: at },
    { id: "visual-mono-data", note: "Set identifiers, latencies and addresses in a monospaced face.", scope: "project", tags: ["visual", "default"], recordedAt: at },
  ] as ProjectMemory["notes"];
}

/**
 * The product profile a project's key seeds, and the rules that follow it.
 *
 * The SAME mechanism (and the same honesty limits) as `defaultNotes`: a project
 * whose key names a known product as its own word seeds that product's profile
 * and truths, so existing product work keeps its guard; every other key seeds
 * nothing. The profile is stored explicitly on the memory file, so after the
 * first save the resolution is recorded data, not filename inference (issue #27).
 */
export function defaultProfileFor(key: string): string | null {
  return keySeedsProfile(key);
}

/** The rules a project's key seeds: the named product's truths, or none. */
function defaultRulesFor(key: string): ProductRule[] {
  const product = defaultProfileFor(key);
  return product ? (profileForProduct(product)?.rules ?? []) : [];
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
  // What design_guard actually enforces after the merge (checklist #14): the
  // built-ins plus the stored rules, not the stored file alone — otherwise a
  // rule recorded via project_memory is described but never applied.
  const checkable = effectiveRules(memory).filter((r) => r.evidence.some((e) => e.kind !== "manual"));
  if (checkable.length === 0) return "";

  const lines = checkable.map((r) => {
    const sev = r.severity === "fail" ? "FAIL" : "WARN";
    return `- ${sev} ${r.id}: ${r.therefore}`;
  });

  return ["Product rules enforced by design_guard:", ...lines].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Stored rules: validated load, built-in merge                               */
/* -------------------------------------------------------------------------- */

/**
 * Degrades a stored rule that cannot be *evaluated* into one that can be
 * *surfaced*.
 *
 * Rules recorded through `project_memory` for a project must apply during
 * generation, not only at final review — but a stored rule is user input, and
 * user input must never be able to take the guard down or hard-fail a screen
 * on a guess. Two degradations, both honest:
 *
 * - a pattern that does not compile is demoted to a `manual` question (a bad
 *   regex would otherwise throw mid-guard and abort the whole run; an
 *   unevaluated rule is INDETERMINATE machinery, not a failure);
 * - a rule carrying no evidence at all gets one `manual` question derived from
 *   its own `therefore`, so it surfaces as guidance the way built-in manual
 *   rules do, never as an automatic FAIL.
 *
 * The declared severity is untouched: the guard still reads it, and a
 * manual-only rule is INDETERMINATE regardless of severity — exactly the
 * "PENDING, not guessed" treatment recorded rules deserve.
 */
export function normalizeStoredRule(rule: ProductRule): ProductRule {
  const out: ProductRule = { ...rule, evidence: [...rule.evidence], passesWhen: [...(rule.passesWhen ?? [])] };
  const compileFails = (pattern: string): boolean => {
    try {
      new RegExp(pattern);
      return false;
    } catch {
      return true;
    }
  };
  out.evidence = out.evidence.map((e) => {
    const pattern = e.kind === "forbiddenText" || e.kind === "maxTexts" ? e.pattern : e.kind === "maxNodes" ? e.namePattern : null;
    if (pattern !== null && compileFails(pattern)) {
      return { kind: "manual" as const, question: `The stored rule '${out.id}' carries a pattern that does not compile; a human must check it: ${out.therefore}` };
    }
    return e;
  });
  if (out.evidence.length === 0) {
    out.evidence = [{ kind: "manual", question: `Recorded rule '${out.id}' states no measurable evidence; check by hand: ${out.therefore}` }];
  }
  return out;
}

/**
 * The rule set a guard run should actually apply: the active profile's product
 * truths plus every rule recorded in the project's memory, merged at use time.
 *
 * GitHub issue #27 — the built-ins are no longer GLOBAL. Which set applies is
 * resolved from the project (see `resolveActiveProduct` for the order):
 * the task brief's explicit profile wins, then the recorded profile, then a
 * stored `exo.*` rule id or the project key naming a product. A project that
 * resolves to no profile gets NO product rules — its guard surfaces that
 * honestly (INDETERMINATE, "nothing product-specific was checked") rather
 * than inheriting another product's acceptance criteria.
 *
 * A stored rule still cannot *shadow* an active built-in: a stored copy of a
 * built-in id would freeze an old version of a truth the build maintains in
 * code — the drift the guard exists to catch. Stored rules with fresh ids are
 * additive.
 */
export function effectiveRules(memory: ProjectMemory, explicitProduct?: string | null): ProductRule[] {
  // Last recording of an id wins within the stored set (same replace-by-id
  // semantics as notes); the active profile fills the space around them.
  const stored = new Map<string, ProductRule>();
  for (const rule of memory.rules ?? []) {
    if (typeof rule?.id !== "string" || rule.id.length === 0) continue;
    stored.set(rule.id, normalizeStoredRule(rule));
  }
  const product = resolveActiveProduct(memory, explicitProduct);
  const builtIn = product ? (profileForProduct(product)?.rules ?? []) : [];
  // A stored rule may not shadow an active built-in: a stored copy of its id
  // would freeze an old version of a product truth this build maintains in
  // code — the drift the guard exists to catch. Built-in wins the id; stored
  // rules with fresh ids are additive.
  const builtInIds = new Set(builtIn.map((r) => r.id));
  const storedValues = [...stored.values()].filter((r) => !builtInIds.has(r.id));
  return [...builtIn, ...storedValues];
}