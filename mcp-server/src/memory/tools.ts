/**
 * MCP tools for design memory and the drift guard (spec §27, §28, §29).
 *
 * Two tools, deliberately:
 *
 * - `project_memory` reads and writes the durable notes. Writes are explicit; the
 *   agent never records an observation on its own initiative, because a memory
 *   that fills up with the agent's own guesses stops being trusted.
 * - `design_guard` runs the rules against a design and returns PASS / WARNING /
 *   FAIL. Read-only, and free — it works on a snapshot the server already has.
 */
import { z } from "zod";
import { VerdictSchema } from "../../../shared/memory";
import { inferComposition } from "../runtime/layout";
import { runGuard, snapshotFromIR, type GuardSnapshot } from "./guard";
import { addNote, loadMemory, notesForPrompt, projectKey, removeNote, rulesForPrompt, saveMemory } from "./store";
import type { Session } from "../sessions";

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

export const ProjectMemoryArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** Which project. Defaults to the connected file's key, or its name. */
    project: z.string().max(200).optional(),
    /** What to do. Omit to read. */
    action: z.enum(["read", "record", "forget", "reset"]).optional(),
    /** The observation. Required by `record`. */
    note: z
      .object({
        id: z.string().min(1).max(120).describe("Stable id. Recording the same id again updates it."),
        note: z.string().min(3).max(500),
        scope: z.enum(["project", "screen", "composition"]).optional(),
        screen: z.string().max(120).optional(),
        composition: z.string().max(60).optional(),
        tags: z.array(z.string().max(40)).max(8).optional(),
      })
      .optional(),
    /** The note to drop, for `forget`. */
    id: z.string().max(120).optional(),
    /** Screen and composition filter for reading relevant notes. */
    screen: z.string().max(120).optional(),
    composition: z.string().max(60).optional(),
  })
  .strict();

export const DesignGuardArgs = z
  .object({
    /** Run against the connected file's real node tree. Requires the plugin. */
    inspect: z.boolean().optional(),
    sessionId: z.string().max(200).optional(),
    /** Or run against a program that has not been built yet. */
    program: z.unknown().optional(),
    project: z.string().max(200).optional(),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Resolves which project the request refers to. */
function resolveKey(args: { project?: string }, session: Session | null): string {
  if (args.project) return projectKey(args.project, args.project);
  return projectKey(session?.fileKey, session?.fileName);
}

/* -------------------------------------------------------------------------- */
/* project_memory                                                              */
/* -------------------------------------------------------------------------- */

export async function projectMemoryTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = ProjectMemoryArgs.parse(rawArgs);
  const key = resolveKey(args, session);

  if (args.action === "reset") {
    // Deliberately requires an explicit action: this is the only way to lose the
    // project's accumulated knowledge, so it must never be a side effect.
    const current = loadMemory(key);
    const saved = saveMemory(key, { ...current.memory, notes: [] });
    return { status: "ok", action: "reset", project: key, file: saved, notes: 0 };
  }

  if (args.action === "record") {
    if (!args.note) throw new Error("project_memory(action:'record') needs a 'note' object with at least an id and a note string.");

    const current = loadMemory(key);
    const result = addNote(current.memory, {
      id: args.note.id,
      note: args.note.note,
      scope: args.note.scope ?? "project",
      ...(args.note.screen !== undefined ? { screen: args.note.screen } : {}),
      ...(args.note.composition !== undefined ? { composition: args.note.composition } : {}),
      tags: args.note.tags ?? [],
      recordedAt: "",
    });

    const file = saveMemory(key, result.memory);
    return {
      status: "ok",
      action: result.action,
      project: key,
      file,
      notes: result.memory.notes.length,
      recorded: args.note,
      ...(current.problem ? { warning: current.problem } : {}),
    };
  }

  if (args.action === "forget") {
    if (!args.id) throw new Error("project_memory(action:'forget') needs the 'id' of the note to remove.");

    const current = loadMemory(key);
    const result = removeNote(current.memory, args.id);
    if (!result.removed) {
      return { status: "not-found", project: key, id: args.id, knownIds: current.memory.notes.map((n) => n.id) };
    }

    const file = saveMemory(key, result.memory);
    return { status: "ok", action: "forget", project: key, file, id: args.id, notes: result.memory.notes.length };
  }

  /* read */
  const { memory, problem } = loadMemory(key);

  return {
    status: "ok",
    project: key,
    fileKey: memory.fileKey,
    updatedAt: memory.updatedAt,
    notes: memory.notes,
    noteCount: memory.notes.length,
    rules: memory.rules.map((r) => ({ id: r.id, severity: r.severity, rule: r.rule, therefore: r.therefore })),
    ruleCount: memory.rules.length,
    /** The exact text prepended to the runtime prompt, so it is inspectable. */
    promptFragment: notesForPrompt(memory, { ...(args.screen !== undefined ? { screen: args.screen } : {}), ...(args.composition !== undefined ? { composition: args.composition } : {}) }),
    rulesFragment: rulesForPrompt(memory),
    ...(problem ? { warning: problem } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* design_guard                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Runs the guard.
 *
 * Two input paths, because both are genuinely useful: `program` checks a design
 * before it is built (cheap, catches drift while it is still one edit away), and
 * `inspect` checks what is actually in the file afterwards.
 */
export async function designGuardTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = DesignGuardArgs.parse(rawArgs);
  const key = resolveKey(args, session);
  const { memory, problem } = loadMemory(key);

  let snapshot: GuardSnapshot;

  if (args.inspect) {
    if (!session) throw new Error("design_guard(inspect:true) needs a connected Figma plugin.");
    const inspected = (await session.request("inspect_selection", { maxNodes: 2000 })) as Record<string, unknown>;
    snapshot = snapshotFromInspected(inspected);
  } else if (args.program !== undefined) {
    const { executeRuntime } = await import("../runtime/interpreter");
    const result = executeRuntime(args.program);
    // The composition the shell layout actually resolved, not the one the model
    // asked for. A screen can request 'spatial' and end up 'canvas', and only the
    // resolved value is what the guard can judge.
    const resolved = inferComposition(result.ir.regions);
    snapshot = snapshotFromIR(result.ir, { composition: resolved });
  } else {
    throw new Error("design_guard needs either inspect:true (checks the current selection) or a program (checks a design before building it).");
  }

  const result = runGuard(memory.rules, snapshot);

  return {
    status: "ok",
    project: key,
    verdict: result.verdict,
    findings: result.findings,
    stats: result.stats,
    snapshot: {
      composition: snapshot.composition,
      components: snapshot.components,
      metrics: snapshot.metrics,
    },
    ...(problem ? { warning: problem } : {}),
  };
}

/** Builds a guard snapshot from an `inspect_selection` payload. */
function snapshotFromInspected(inspected: Record<string, unknown>): GuardSnapshot {
  const textNode = (node: Record<string, unknown>): string => (typeof node.characters === "string" ? node.characters : "");

  const walk = (node: Record<string, unknown>, names: string[], texts: string[]): void => {
    if (typeof node.name === "string") names.push(node.name);
    const t = textNode(node);
    if (t) texts.push(t);

    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) if (child && typeof child === "object") walk(child as Record<string, unknown>, names, texts);
    }
  };

  const names: string[] = [];
  const texts: string[] = [];
  const selected = inspected.selection;
  if (selected && typeof selected === "object") walk(selected as Record<string, unknown>, names, texts);

  const composition = typeof inspected.composition === "string" ? inspected.composition : undefined;

  return {
    composition,
    components: [],
    nodeNames: names,
    texts,
    metrics: { nodes: names.length, textNodes: texts.length },
  };
}

export { VerdictSchema };