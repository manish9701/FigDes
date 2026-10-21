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
import { runGuard, snapshotFromIR, decideGuardTarget, metricsFromLiveNodes, type GuardSnapshot } from "./guard";
import { checkCapabilityTruth } from "./capability-truth";
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
  let escalation: { requested: string; checked: string } | undefined;

  if (args.inspect || args.target !== undefined) {
    if (!session) throw new Error("design_guard(inspect:true) needs a connected Figma plugin.");
    if (args.target !== undefined) {
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
    } else {
      const inspected = await resolveInspectSelection(session);
      if ("ambiguity" in inspected) {
        return {
          status: "indeterminate",
          project: key,
          verdict: "INDETERMINATE",
          findings: [
            {
              verdict: "INDETERMINATE",
              rule: "scope",
              message: inspected.ambiguity,
              evidence: { candidates: inspected.candidates },
              nextStep: "Select the frame you want checked, or pass it as a node id.",
            },
          ],
          stats: { rulesChecked: 0, passed: 0, warnings: 0, failures: 0, manual: 0 },
          snapshot: { source: "live", resolved: false, scope: null },
          howToProceed: "Resolve the target and re-run. Nothing was checked, so nothing was approved.",
        };
      }
      snapshot = inspected.snapshot;
      if (inspected.escalation) escalation = inspected.escalation;
    }
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

  /**
   * The capability-truth stage: what the screen *claims*, checked separately
   * from how it behaves (issue #20, workstream 8). A screen can pass every
   * design rule and still present unconfirmed Enterprise features as shipped.
   * The fold is deliberate: a FAIL here fails the guard verdict, a
   * WARNING/INDETERMINATE is reported and downgrades an otherwise clean PASS
   * to WARNING-level truth, but never silently upgrades anything.
   */
  const capability = checkCapabilityTruth({ texts: snapshot.texts ?? [], nodeNames: snapshot.nodeNames ?? [] });
  let verdict = result.verdict;
  if (capability.verdict === "FAIL" && verdict !== "FAIL") verdict = "FAIL";
  if (capability.verdict !== "PASS" && verdict === "PASS") verdict = "WARNING";
  const capabilityNote = `capability-truth: ${capability.reason}`;

  return {
    // `indeterminate` is deliberately not `ok`: nothing was checked, so there
    // is no outcome to report as a success. A caller keying on `status` must
    // not treat an empty snapshot as a clean run.
    status: verdict === "INDETERMINATE" ? "indeterminate" : "ok",
    project: key,
    verdict,
    findings: result.findings,
    stats: result.stats,
    /** What the screen claims, and whether the product can back it. */
    capabilityTruth: {
      verdict: capability.verdict,
      reason: capability.reason,
      source: capability.source,
      findings: capability.findings,
    },
    snapshot: {
      source: snapshot.source ?? "unknown",
      resolved: snapshot.resolved ?? true,
      /** Exactly what was checked. A verdict is only meaningful with its scope. */
      scope: snapshot.scope ?? null,
      composition: snapshot.composition,
      components: snapshot.components,
      metrics: snapshot.metrics,
    },
    ...(verdict !== result.verdict ? { note: capabilityNote } : {}),
    ...(verdict === "INDETERMINATE"
      ? {
          howToProceed:
            "Resolve the target and re-run. An empty snapshot means no rule was evaluated — it is never evidence that the design passes.",
        }
      : {}),
    ...(escalation ? { scopeResolution: escalation } : {}),
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

  // The assert metrics a live frame can supply. Without these every
  // assert-based rule reports INDETERMINATE on live frames — even when the
  // facts are measurable — so the guard could only shrug at real screens.
  // Links and component props genuinely do not survive measurement, so the
  // topology rules stay manual by construction, never by default.
  const live = metricsFromLiveNodes(nodes);

  return {
    source: "live",
    /**
     * A truncated scan is NOT resolved evidence: the guard's absence rules
     * (maxNodes, maxTexts, forbiddenText) judge what is *absent* from the
     * scan, and a 2000-node frame truncated at the cap still has unscanned
     * nodes that could contradict every one of those passes. Absence of
     * evidence over an incomplete census is not evidence of absence — so the
     * snapshot refuses rather than evaluating half a frame (issue #20).
     */
    resolved: nodes.length > 0 && !truncated,
    nodeNames: names,
    texts,
    components,
    metrics: {
      nodes: nodes.length,
      textNodes: texts.length,
      ...live,
    },
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

  // A blank target must never reach `find_node`: an empty query throws a
  // bare transport error, where #18 requires an explicit indeterminate
  // result with the same shape as every other miss.
  if (target.trim().length === 0) {
    return {
      ambiguity: "No target was named: pass a node id, or a name that matches a frame.",
      candidates: [],
    };
  }

  // A node id is unambiguous; a name has to be looked up. The window is
  // deliberately wider than a disambiguation question can show: the count
  // reported to the caller is the lookup's file-wide total, so a capped
  // list is never presented as the exact match set.
  if (/^\d+:\d+$/.test(target)) return snapshotForId(session, target);
  const found = (await session.request("find_node", { name: target, limit: 25 })) as {
    matches?: Array<{ id?: string; name?: string; type?: string }>;
    total?: number;
  };
  const matches = found.matches ?? [];
  const decision = decideGuardTarget(
    target,
    matches,
    typeof found.total === "number" ? found.total : undefined,
  );
  if (decision.kind === "not-found") return { ambiguity: decision.message, candidates: [] };
  if (decision.kind === "ambiguous") return { ambiguity: decision.message, candidates: decision.candidates };

  return snapshotForId(session, decision.id);
}

async function snapshotForId(session: Session, id: string): Promise<{ snapshot: GuardSnapshot }> {
  const metrics = (await session.request("collect_metrics", { target: id, maxNodes: 2000 })) as MetricsReport;
  return { snapshot: snapshotFromMetrics(metrics, id) };
}

/** Node types that can stand for a screen on their own. */
const SCREEN_LIKE_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "PAGE", "DOCUMENT", "SECTION", "GROUP", "SLIDE"]);

/**
 * Walks from a node up to its enclosing screen frame.
 *
 * Instance children carry synthetic ids (`I<instance>;<child>`) that embed
 * their instance, so the walk starts there. Anything else climbs `parentId
 * one step at a time. Returns null at pages, documents, dead ends and
 * lookup failures — all of which mean "no screen found", never a guess.
 */
async function enclosingScreenFrame(session: Session, startId: string): Promise<{ id: string; name: string } | null> {
  const instanceChild = /^I([^;]+);/.exec(startId);
  let current: string | null = instanceChild ? instanceChild[1]! : startId;
  const seen = new Set<string>();
  for (let depth = 0; depth < 12 && current && !seen.has(current); depth++) {
    seen.add(current);
    let nodes: Array<{ id: string; type?: string; name?: string; parentId?: string | null }>;
    try {
      const metrics = (await session.request("collect_metrics", { target: current, maxNodes: 10, depth: 1 })) as MetricsReport;
      nodes = (metrics.nodes ?? []) as Array<{ id: string; type?: string; name?: string; parentId?: string | null }>;
    } catch {
      return null;
    }
    const self = nodes[0];
    if (!self) return null;
    const type = (self.type ?? "").toUpperCase();
    if (type === "FRAME") return { id: self.id, name: self.name ?? self.id };
    if (type === "PAGE" || type === "DOCUMENT") return null;
    current = self.parentId ?? null;
  }
  return null;
}

/**
 * Resolves an inspect-selection guard run to the screen it is about.
 *
 * A single screen-like selection is checked as-is (long-standing
 * behaviour). Anything else — one leaf, or several layers — is resolved
 * layer by layer to its enclosing screen frame: unanimous agreement checks
 * that frame and says so via `escalation`; anything else asks, listing
 * where each selected layer resolved. Checking the first layer and
 * ignoring the rest, or checking a leaf as if it were a screen, are both
 * how a verdict about the wrong thing gets reported.
 */
async function resolveInspectSelection(session: Session): Promise<
  | { snapshot: GuardSnapshot; escalation?: { requested: string; checked: string } }
  | { ambiguity: string; candidates: string[] }
> {
  const inspected = (await session.request("inspect_selection", { maxNodes: 2000 })) as Record<string, unknown>;
  const raw = (inspected as { selection?: unknown }).selection;
  const roots = (
    Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : []
  ) as Array<{ id?: unknown; name?: unknown; type?: unknown }>;

  if (roots.length === 0) return { snapshot: snapshotFromInspected(inspected) };

  const describe = (r: { id?: unknown; name?: unknown; type?: unknown }): string =>
    `${typeof r.type === "string" ? r.type : "layer"}${typeof r.name === "string" && r.name ? ` "${r.name}"` : ""}`;

  if (roots.length === 1) {
    const only = roots[0]!;
    if (typeof only.type === "string" && SCREEN_LIKE_TYPES.has(only.type.toUpperCase())) {
      return { snapshot: snapshotFromInspected(inspected) };
    }
    if (typeof only.id !== "string" || only.id.length === 0) {
      return { snapshot: snapshotFromInspected(inspected) };
    }
    const frame = await enclosingScreenFrame(session, only.id);
    if (!frame) return { snapshot: snapshotFromInspected(inspected) };
    const metrics = (await session.request("collect_metrics", { target: frame.id, maxNodes: 2000 })) as MetricsReport;
    return {
      snapshot: snapshotFromMetrics(metrics, frame.id),
      escalation: {
        requested: `selected ${describe(only)}`,
        checked: `enclosing frame ${frame.id} ("${frame.name}")`,
      },
    };
  }

  const frames = new Map<string, { name: string; roots: string[] }>();
  const unresolvable: string[] = [];
  for (const root of roots) {
    const label = describe(root);
    let frame: { id: string; name: string } | null = null;
    if (typeof root.id === "string" && root.id.length > 0) {
      if (typeof root.type === "string" && SCREEN_LIKE_TYPES.has(root.type.toUpperCase())) {
        frame = { id: root.id, name: typeof root.name === "string" && root.name ? root.name : root.id };
      } else {
        frame = await enclosingScreenFrame(session, root.id);
      }
    }
    if (frame) {
      const entry = frames.get(frame.id) ?? { name: frame.name, roots: [] };
      entry.roots.push(label);
      frames.set(frame.id, entry);
    } else {
      unresolvable.push(label);
    }
  }

  if (frames.size === 1 && unresolvable.length === 0) {
    const first = [...frames.entries()][0]!;
    const frameId = first[0];
    const entry = first[1];
    const metrics = (await session.request("collect_metrics", { target: frameId, maxNodes: 2000 })) as MetricsReport;
    return {
      snapshot: snapshotFromMetrics(metrics, frameId),
      escalation: {
        requested: `${roots.length} selected layers (${[...new Set(entry.roots)].slice(0, 5).join(", ")})`,
        checked: `enclosing frame ${frameId} ("${entry.name}")`,
      },
    };
  }

  const candidates = [
    ...[...frames.entries()].map(([id, entry]) => `${id} ("${entry.name}") via ${entry.roots.length} selected layer(s)`),
    ...unresolvable.map((label) => `${label} (no enclosing screen found)`),
  ];
  return {
    ambiguity:
      frames.size > 1
        ? `The selection spans ${frames.size} screens, so there is no single screen to check.`
        : "The selection could not be resolved to a screen.",
    candidates,
  };
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

export { VerdictSchema, snapshotFromMetrics, resolveGuardTarget, resolveInspectSelection, runGuard };