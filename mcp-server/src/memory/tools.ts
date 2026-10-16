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
    // `indeterminate` is deliberately not `ok`: nothing was checked, so there
    // is no outcome to report as a success. A caller keying on `status` must
    // not treat an empty snapshot as a clean run.
    status: result.verdict === "INDETERMINATE" ? "indeterminate" : "ok",
    project: key,
    verdict: result.verdict,
    findings: result.findings,
    stats: result.stats,
    snapshot: {
      source: snapshot.source ?? "unknown",
      resolved: snapshot.resolved ?? true,
      /** Exactly what was checked. A verdict is only meaningful with its scope. */
      scope: snapshot.scope ?? null,
      composition: snapshot.composition,
      components: snapshot.components,
      metrics: snapshot.metrics,
    },
    ...(result.verdict === "INDETERMINATE"
      ? {
          howToProceed:
            "Resolve the target and re-run. An empty snapshot means no rule was evaluated — it is never evidence that the design passes.",
        }
      : {}),
    ...(problem ? { warning: problem } : {}),
  };
}

/** Builds a guard snapshot from an `inspect_selection` payload. */
function snapshotFromInspected(inspected: Record<string, unknown>): GuardSnapshot {
  const textNode = (node: Record<string, unknown>): string => (typeof node.characters === "string" ? node.characters : "");

  let maxNodes: number | undefined;
  let truncated: boolean | undefined;
  // Identity of what was selected. Recorded so the verdict can be read with its
  // scope rather than assumed to cover the whole design.
  let selectedIdentity: { id?: string; name?: string; type?: string } = {};

  const walk = (node: Record<string, unknown>, names: string[], texts: string[], instances: Array<{ type: string }>): void => {
    if (typeof node.name === "string") names.push(node.name);
    const t = textNode(node);
    if (t) texts.push(t);

    // Instances carry their component's semantics, which is what `maxInstances`
    // rules are measured against. A live snapshot that dropped them could only
    // ever report zero components.
    if (node.type === "INSTANCE" || node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      const name = typeof node.name === "string" && node.name.length > 0 ? node.name : String(node.type);
      instances.push({ type: name });
    }

    const children = node.children;
    if (Array.isArray(children)) {
      for (const child of children) if (child && typeof child === "object") walk(child as Record<string, unknown>, names, texts, instances);
    }
  };

  const names: string[] = [];
  const texts: string[] = [];
  const instances: Array<{ type: string }> = [];
  const selection = inspected.selection;
  const selected = Array.isArray(selection) ? selection[0] : selection;
  if (selected && typeof selected === "object") {
    const root = selected as Record<string, unknown>;
    walk(root, names, texts, instances);
    selectedIdentity = {
      ...(typeof root.id === "string" ? { id: root.id } : {}),
      ...(typeof root.name === "string" ? { name: root.name } : {}),
      ...(typeof root.type === "string" ? { type: root.type } : {}),
    };
  }

  const composition = typeof inspected.composition === "string" ? inspected.composition : undefined;

  if (typeof inspected.maxNodes === "number") maxNodes = inspected.maxNodes;
  if (inspected.truncated === true) truncated = true;

  // Component counts are the one metric a truncated scan cannot make safe to
  // reason about: nodes past the cap were never walked, so "no forbidden
  // component" is an artefact of the cap rather than an observation.
  const capped = truncated === true;

  const components = new Map<string, number>();
  for (const i of instances) components.set(i.type, (components.get(i.type) ?? 0) + 1);

  const resolved = names.length > 0 && !capped;
  const unresolvedReason =
    names.length === 0
      ? "The plugin returned an empty selection: nothing was measured, so every rule would pass by default. Select the frame to check and re-run."
      : capped
        ? `The inspection was capped at ${maxNodes ?? "the plugin limit"} nodes, so absence-based rules would pass on nodes that were never scanned. Narrow the target or re-run on a smaller frame.`
        : undefined;

  return {
    composition,
    source: "live",
    resolved,
    // The exact scope, so a verdict about one layer cannot be read as a verdict
    // about a screen. A TEXT selection is explicitly not screen-level.
    scope: {
      ...selectedIdentity,
      nodeCount: names.length,
      textCount: texts.length,
      screenLevel:
        typeof selectedIdentity.type === "string" &&
        ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "PAGE", "DOCUMENT", "SECTION", "GROUP", "SLIDE"].includes(
          selectedIdentity.type.toUpperCase(),
        ),
    },
    ...(unresolvedReason ? { unresolvedReason } : {}),
    components: [...components].map(([type, count]) => ({ type, count })),
    nodeNames: names,
    texts,
    metrics: { nodes: names.length, textNodes: texts.length },
  };
}

export { VerdictSchema };