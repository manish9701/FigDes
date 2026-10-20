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
import type { MetricsReport } from "../../../shared/protocol";
import { inferComposition } from "../runtime/layout";
import { runGuard, snapshotFromIR, decideGuardTarget, type GuardSnapshot } from "./guard";
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
    /**
     * The screen to check: a node id ("123:456") or a frame's name.
     *
     * The current selection is a poor default for a screen-level rule: a
     * designer with three layers selected would get a verdict about three
     * layers, and the rules would either pass by default or fail on nothing.
     * A named or identified target is resolved explicitly, and the resolved
     * target is reported so the verdict can be read with its scope.
     */
    target: z.string().max(200).optional(),
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

  if (args.inspect || args.target !== undefined) {
    if (!session) throw new Error("design_guard(inspect:true) needs a connected Figma plugin.");
    const resolved = await resolveGuardTarget(session, args.target);
    if ("ambiguity" in resolved) {
      // The screen could not be resolved uniquely. Say so, rather than
      // checking a random selection and reporting a verdict about it.
      return {
        status: "indeterminate",
        project: key,
        verdict: "INDETERMINATE",
        findings: [
          {
            verdict: "INDETERMINATE",
            rule: "scope",
            message: resolved.ambiguity,
            evidence: { candidates: resolved.candidates },
            nextStep: "Pass the target as a node id, or a name that matches exactly one frame.",
          },
        ],
        stats: { rulesChecked: 0, passed: 0, warnings: 0, failures: 0, manual: 0 },
        snapshot: { source: "resolved-target", resolved: false, scope: null },
        howToProceed: "Resolve the target and re-run. Nothing was checked, so nothing was approved.",
      };
    }
    snapshot = resolved.snapshot;
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

/**
 * Builds a guard snapshot from a live measurement of a named target.
 *
 * The metrics carry the names, the text and the instance types, which is what
 * the guard's rules read. The composition is unknown for a built screen — the
 * layout engine's answer is not recoverable from the file — so it is left
 * undefined rather than guessed.
 */
function snapshotFromMetrics(metrics: MetricsReport, targetId?: string): GuardSnapshot {
  const nodes = metrics.nodes ?? [];
  const names: string[] = [];
  const texts: string[] = [];
  const instanceTypes: string[] = [];
  for (const node of nodes) {
    if (node.name) names.push(node.name);
    if (node.text?.content) texts.push(node.text.content);
    if (node.type === "INSTANCE" || node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      instanceTypes.push(node.name || node.type);
    }
  }
  const counts = new Map<string, number>();
  for (const type of instanceTypes) counts.set(type, (counts.get(type) ?? 0) + 1);
  const components = [...counts.entries()].map(([type, count]) => ({ type, count }));

  const truncated = metrics.truncated === true;
  const root = nodes[0];
  const screenLevel = nodes.length > 0 && (root?.type === "FRAME" || root?.type === "COMPONENT" || root?.type === "INSTANCE");

  return {
    source: "live",
    resolved: nodes.length > 0,
    nodeNames: names,
    texts,
    components,
    scope: {
      ...(targetId !== undefined ? { id: targetId } : {}),
      ...(root?.name !== undefined ? { name: root.name } : {}),
      ...(root?.type !== undefined ? { type: root.type } : {}),
      nodeCount: nodes.length,
      textCount: texts.length,
      screenLevel,
    },
    ...(nodes.length === 0
      ? { unresolvedReason: "The target resolved to nothing, so no rule could be evaluated." }
      : truncated
        ? { unresolvedReason: `The scan was truncated after ${nodes.length} node(s), so the screen was not fully examined.` }
        : {}),
  };
}

/**
 * Resolves the screen a guard run is about.
 *
 * A node id is used directly. A name is searched for, and a name that matches
 * more than one frame is an *ambiguity*, not a coin toss: the caller is asked
 * which one, because a verdict about the wrong screen is worse than no
 * verdict.
 */
async function resolveGuardTarget(
  session: Session,
  target: string | undefined,
): Promise<{ snapshot: GuardSnapshot } | { ambiguity: string; candidates: string[] }> {
  if (target === undefined) {
    const inspected = (await session.request("inspect_selection", { maxNodes: 2000 })) as Record<string, unknown>;
    return { snapshot: snapshotFromInspected(inspected) };
  }

  // A node id is unambiguous; a name has to be looked up.
  const matches = /^\d+:\d+$/.test(target)
    ? []
    : (((await session.request("find_node", { name: target, limit: 10 })) as { matches?: Array<{ id?: string; name?: string; type?: string }> }).matches ?? []);
  const decision = decideGuardTarget(target, matches);
  if (decision.kind === "not-found") return { ambiguity: decision.message, candidates: [] };
  if (decision.kind === "ambiguous") return { ambiguity: decision.message, candidates: decision.candidates };

  const metrics = (await session.request("collect_metrics", { target: decision.id, maxNodes: 2000 })) as MetricsReport;
  return { snapshot: snapshotFromMetrics(metrics, decision.id) };
}

/** Builds a guard snapshot from an `inspect_selection` payload. */function snapshotFromInspected(inspected: Record<string, unknown>): GuardSnapshot {
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

export { VerdictSchema, snapshotFromMetrics, resolveGuardTarget, runGuard };