/**
 * Blocking program-level preflight (issue #23).
 *
 * ## The rule this module exists to enforce
 *
 * The first preflight (preflight.ts) proves a transaction is well-formed:
 * schema-valid, references resolvable, parents acyclic. Issue #23 adds the
 * other half — the transaction must be *geometrically and logically sound
 * before any document mutation*, because a check that fires after the plugin
 * already applied is a warning at best and a rollback at worst.
 *
 * So the checks here are REJECTING, not advisory: any finding blocks dispatch
 * (transaction.ts) exactly like a schema failure. They are all deterministic —
 * no async, no live Figma probing, no font lookups — which is what makes them
 * true for `dryRun` in the same words as for an apply: a failed blocking check
 * means NO mutation anywhere.
 *
 * Evidence comes from the caller through `PreflightContext`: the plan's
 * resolved boxes and overflow permissions, the measurements the plugin
 * returned for text, the connectors' resolved endpoints, and any validated
 * reasons recorded in the trace. A check with no evidence for its inputs does
 * NOT run rather than guessing — a check that cannot run must never be
 * reported as a pass (the same fails-closed posture verification.ts took for
 * issue #16/#20).
 *
 * ## Grace thresholds (the ones the issue asked to be documented)
 *
 * - `CONTAINMENT_EPS` (1px): a child may sit within 1px of its parent's edge
 *   before it counts as outside. Sub-pixel fractions from rounding are noise;
 *   a full pixel is a bug.
 * - `TEXT_EPS` (1px): measured text may exceed its allocated box by at most
 *   1px. Beyond that the content clips, and clipping content the plan
 *   promised is a defect, not a style.
 * - `TRACE_EPS` (1px): emitted geometry may differ from the resolved plan by
 *   at most 1px on an axis the operation actually declares. Deliberate
 *   differences larger than that need a recorded reason.
 * - `CONNECTOR_TOUCH_EPS` (2px): matches the compiler's own endpoint reach
 *   (compile.ts `REACH`), so preflight and compilation call the same line
 *   "touching".
 * - `LABEL_HULL_EPS` (2px): a connector label may sit anywhere inside the
 *   hull of its two endpoint boxes (plus the 2px reach); entirely off that
 *   hull it is floating in space unrelated to the edge it claims to label.
 */
import { OperationSchema, type PreflightIssue } from "../../shared/protocol";

/* -------------------------------------------------------------------------- */
/* Evidence the caller supplies                                                */
/* -------------------------------------------------------------------------- */

export interface PreflightBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A connector whose geometry was already resolved (routeConnector output). */
export interface PreflightConnectorSpec {
  id: string;
  from: string;
  to: string;
  /**
   * Resolved endpoints in the SAME page-absolute space as `planBoxes`.
   * The first endpoint must touch the `from` box, the last one the `to` box.
   */
  endpoints: Array<{ x: number; y: number }>;
  /** Where a label was anchored, in the same space. Absent = no label. */
  labelAt?: { x: number; y: number } | null;
}

export type PreflightOverflow = "allow" | "clip" | "forbid";

/**
 * Deterministic evidence for the program-level checks.
 *
 * Maps and plain objects are both accepted (normalised below), so a caller
 * can hand this straight from its own data without re-keying. Every field is
 * optional; an absent field means the corresponding check has no evidence and
 * does not run.
 */
export interface PreflightContext {
  /** Resolved boxes (plan / compiled geometry), page-absolute, by id. */
  planBoxes?: Map<string, PreflightBox> | Record<string, PreflightBox>;
  /** `constraints.overflow` of the region a node belongs to, per region id (child ids may also carry it). */
  overflow?: Map<string, PreflightOverflow> | Record<string, PreflightOverflow>;
  /** The justification required before "allow" counts as permission. */
  overflowReasons?: Map<string, string> | Record<string, string>;
  /** Measured text metrics (measureProgramText output), keyed by content id. */
  textMeasurements?: Map<string, { width: number; height: number }> | Record<string, { width: number; height: number }>;
  /** Connectors with their resolved endpoints. */
  connectors?: PreflightConnectorSpec[];
  /** Plan sizing per region ("fill" | "hug" | number) — names why an axis is auto-sized. */
  sizing?: Map<string, { width: "fill" | "hug" | number; height: "fill" | "hug" | number }> | Record<string, { width: "fill" | "hug" | number; height: "fill" | "hug" | number }>;
  /** Validated reasons for deliberate geometry differences, per node id. */
  geometryReasons?: Map<string, string> | Record<string, string>;
  /** Brief blockers (pipeline brief.ts), carried so the transaction edge can refuse them. */
  briefBlockers?: Array<{ id?: string; severity: string; message: string; fix?: string }>;
}

/* -------------------------------------------------------------------------- */
/* Tolerances                                                                  */
/* -------------------------------------------------------------------------- */

const CONTAINMENT_EPS = 1;
const TEXT_EPS = 1;
const TRACE_EPS = 1;
const CONNECTOR_TOUCH_EPS = 2;
const LABEL_HULL_EPS = 2;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function asMap<T>(m: Map<string, T> | Record<string, T> | undefined): Map<string, T> {
  if (m instanceof Map) return m;
  const out = new Map<string, T>();
  if (m && typeof m === "object") {
    for (const [k, v] of Object.entries(m as Record<string, T>)) if (v !== undefined) out.set(k, v);
  }
  return out;
}

interface ParsedOp {
  index: number;
  type: string;
  op: Record<string, unknown>;
}

function parseOps(operations: unknown[]): ParsedOp[] {
  const out: ParsedOp[] = [];
  operations.forEach((raw, index) => {
    const parsed = OperationSchema.safeParse(raw);
    if (!parsed.success) return; // already reported by the schema pass in preflight.ts
    out.push({ index, type: String(parsed.data["type"]), op: parsed.data as unknown as Record<string, unknown> });
  });
  return out;
}

interface OpRef {
  key: string;
  ref: string;
}

/** Every transaction-local reference an operation makes. */
function opRefs(op: Record<string, unknown>, type: string): OpRef[] {
  const refs: OpRef[] = [];
  for (const key of ["id", "target", "parent", "child", "componentId", "from", "to"]) {
    const v = op[key];
    if (typeof v === "string") refs.push({ key, ref: v });
  }
  if ((type === "booleanOperation" || type === "createGroup") && Array.isArray(op["targets"])) {
    for (const t of op["targets"] as unknown[]) if (typeof t === "string") refs.push({ key: "targets", ref: t });
  }
  if (type === "createGroup" && Array.isArray(op["children"])) {
    for (const t of op["children"] as unknown[]) if (typeof t === "string") refs.push({ key: "children", ref: t });
  }
  return refs;
}

/** A create-ish operation declares that a node exists after it runs. */
const CREATE_TYPES = new Set([
  "createFrame",
  "createRectangle",
  "createEllipse",
  "createText",
  "createVector",
  "createSlide",
  "createComponent",
  "createInstance",
  "cloneNode",
  "createGroup",
  "booleanOperation",
  "outlineStroke",
]);

const REMOVE_TYPE = "removeNode";

/* -------------------------------------------------------------------------- */
/* Geometry replay                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Replays the operations into a final-geometry table, the same way the
 * compiler's own trace verification does (compile.ts `verifyOperationTrace`),
 * with two additions this module needs: absolute positions (parent origins
 * resolved recursively) and the flag of which dimensions were *declared on
 * purpose* (create width/height or a setSize) versus left to Figma to size.
 *
 * Coordinates are parent-local on the wire; absolute here. `planBoxes` are
 * headless page-absolute; the resolved-vs-emitted comparison anchors on the
 * root's replayed position, so a caller-side canvas placement (which rewrites
 * the root op and shifts its chain) cancels out instead of translating every
 * box away from the plan.
 */
interface NodeState {
  id: string;
  opIndex: number;
  /** The create op's type, for messages. */
  kind: string;
  parent: unknown;
  /** Parent-local position, when an op declared one. */
  local?: { x: number; y: number };
  w?: number;
  h?: number;
  /** Declared on purpose (an operation names the size) rather than left to Figma. */
  declaredW: boolean;
  declaredH: boolean;
  /** A text node's own resize intent, straight off the create op. */
  opAutoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE";
  /**
   * True when the op's x/y/width/height are derived from the op's own path
   * data rather than named by the layout (a logoMark's tight mark bbox, a
   * connector's route bbox). Their truth is the path, not the plan box, so
   * the resolved-vs-emitted comparison must not judge them by positions —
   * containment still applies.
   */
  derived?: boolean;
}

interface ResolvedNode extends NodeState {
  absolute?: { x: number; y: number };
}

function replayGeometry(ops: ParsedOp[]): Map<string, ResolvedNode> {
  const nodes = new Map<string, NodeState>();
  for (const { index, op, type } of ops) {
    if (CREATE_TYPES.has(type)) {
      const id = op["id"];
      if (typeof id !== "string") continue;
      const w = typeof op["width"] === "number" ? op["width"] : undefined;
      const h = typeof op["height"] === "number" ? op["height"] : undefined;
      const autoResize = op["textAutoResize"];
      // Absence of x/y IS the origin for this system — the compiler emits the
      // root frame with no coordinates and placeRootInFreeCanvas reads that as
      // "at the origin" — so the replay honours the same contract.
      nodes.set(id, {
        id,
        opIndex: index,
        kind: type,
        parent: op["parent"],
        local: { x: typeof op["x"] === "number" ? op["x"] : 0, y: typeof op["y"] === "number" ? op["y"] : 0 },
        ...(w !== undefined ? { w } : {}),
        ...(h !== undefined ? { h } : {}),
        declaredW: w !== undefined,
        declaredH: h !== undefined,
        ...(autoResize === "NONE" || autoResize === "WIDTH_AND_HEIGHT" || autoResize === "HEIGHT" || autoResize === "TRUNCATE"
          ? { opAutoResize: autoResize }
          : {}),
        ...(type === "createVector" && (op["path"] !== undefined || op["vectorPaths"] !== undefined) ? { derived: true } : {}),
      });
      continue;
    }
    const state = nodes.get(typeof op["target"] === "string" ? op["target"] : "");
    if (!state) continue; // real Figma id / unknown: the reference pass covers it
    if (type === "setPosition") {
      if (typeof op["x"] === "number" || typeof op["y"] === "number") {
        state.local = {
          x: typeof op["x"] === "number" ? op["x"] : (state.local?.x ?? 0),
          y: typeof op["y"] === "number" ? op["y"] : (state.local?.y ?? 0),
        };
      }
    } else if (type === "setSize") {
      if (typeof op["width"] === "number") {
        state.w = op["width"];
        state.declaredW = true;
      }
      if (typeof op["height"] === "number") {
        state.h = op["height"];
        state.declaredH = true;
      }
    }
  }

  // Absolute positions: local + parent origin, cycle-guarded. An unresolvable
  // or absent parent is its own origin (the page / the root frame), exactly
  // like the trace verifier's fallback.
  const resolved = new Map<string, ResolvedNode>();
  for (const [id, state] of nodes) resolved.set(id, { ...state });
  const absoluteOf = (id: string, seen: Set<string>): { x: number; y: number } | undefined => {
    const node = resolved.get(id);
    if (!node || !node.local) return undefined;
    const parent = typeof node.parent === "string" ? node.parent : "";
    if (parent === "" || parent === id || seen.has(parent) || !resolved.has(parent)) {
      return { x: node.local.x, y: node.local.y };
    }
    seen.add(parent);
    const origin = absoluteOf(parent, seen) ?? { x: 0, y: 0 };
    return { x: node.local.x + origin.x, y: node.local.y + origin.y };
  };
  for (const [id, node] of resolved) {
    node.absolute = absoluteOf(id, new Set([id]));
  }
  return resolved;
}

/* -------------------------------------------------------------------------- */
/* 1. duplicate ids / dual parents                                             */
/* -------------------------------------------------------------------------- */

interface ParentAssignment {
  index: number;
  parent: string;
  source: "create" | "append" | "group" | "boolean";
}

function collectParentAssignments(ops: ParsedOp[]): Map<string, ParentAssignment[]> {
  const byChild = new Map<string, ParentAssignment[]>();
  const push = (child: string, a: ParentAssignment): void => {
    const list = byChild.get(child) ?? [];
    list.push(a);
    byChild.set(child, list);
  };
  for (const { index, op, type } of ops) {
    if (CREATE_TYPES.has(type) && typeof op["parent"] === "string") {
      const id = op["id"];
      if (typeof id === "string") push(id, { index, parent: op["parent"], source: "create" });
      continue;
    }
    if (type === "appendChild" && typeof op["parent"] === "string" && typeof op["child"] === "string") {
      push(op["child"], { index, parent: op["parent"], source: "append" });
      continue;
    }
    if (type === "createGroup") {
      const gid = typeof op["id"] === "string" ? op["id"] : "(group)";
      if (typeof op["parent"] === "string" && typeof op["id"] === "string") {
        push(op["id"], { index, parent: op["parent"], source: "create" });
      }
      if (Array.isArray(op["children"])) {
        for (const child of op["children"] as unknown[]) {
          if (typeof child === "string") push(child, { index, parent: gid, source: "group" });
        }
      }
      continue;
    }
    if (type === "booleanOperation") {
      const bid = typeof op["id"] === "string" ? op["id"] : "(union)";
      if (typeof op["parent"] === "string" && typeof op["id"] === "string") {
        push(op["id"], { index, parent: op["parent"], source: "create" });
      }
      if (Array.isArray(op["targets"])) {
        for (const target of op["targets"] as unknown[]) {
          if (typeof target === "string") push(target, { index, parent: bid, source: "boolean" });
        }
      }
    }
  }
  return byChild;
}

/**
 * A node assigned to two different parents within one transaction is
 * ambiguous — two operations fighting over where the node lives (issue #23:
 * blocking). The exception is the documented re-cluster: grouping or unioning
 * siblings into a NEW container supersedes the create-time parent on purpose,
 * so `create(parent)` followed by `createGroup([node])` is a deliberate move
 * with exactly one final parent, not an ambiguity. Everything else — a
 * second create naming another parent, a second appendChild to a different
 * container — is refused: the winner would be an accident of pass order.
 */
function checkParentAssignments(ops: ParsedOp[]): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const CLUSTER_SOURCES = new Set(["group", "boolean"]);
  for (const [child, assignments] of collectParentAssignments(ops)) {
    let effective: ParentAssignment | undefined;
    for (const a of assignments) {
      if (effective !== undefined && a.parent !== effective.parent) {
        const supersededByCluster = CLUSTER_SOURCES.has(a.source) && effective.source === "create";
        if (!supersededByCluster) {
          issues.push({
            index: a.index,
            opType: ops[a.index]?.type ?? "assign",
            message:
              `dup-parent: node '${child}' is assigned to two different parents in one transaction — ` +
              `'${effective.parent}' (op #${effective.index}) and '${a.parent}'. Which one wins is an accident of pass order; the result is one or the other, never both.`,
            fix: `Assign the node once: drop the redundant parent assignment (op #${effective.index}), or split the move into its own transaction after the first one lands.`,
          });
        }
      }
      effective = a;
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* 5. provably unresolvable (stale-after-remove) targets                       */
/* -------------------------------------------------------------------------- */

/**
 * The offline split the issue asks for: a reference that cannot resolve
 * *within this transaction* — no create mints the id (preflight.ts
 * "unknown-ref"), or the node was removed earlier in the same transaction —
 * is BLOCKING. A reference that is merely fragile (created later in pass
 * order) stays a warning and lives in preflight.ts. Real Figma ids are never
 * judged here: that would be a live lookup, and preflight only refuses what
 * it can prove offline.
 */
function checkStaleTargets(ops: ParsedOp[]): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const removed = new Map<string, number>();
  for (const { index, op, type } of ops) {
    for (const { ref } of opRefs(op, type)) {
      const removedAt = removed.get(ref);
      if (removedAt !== undefined) {
        issues.push({
          index,
          opType: type,
          message: `stale-ref: '${ref}' was removed by op #${removedAt} earlier in this transaction, so this reference provably cannot resolve.`,
          fix: `Reorder or trim: keep every operation that touches '${ref}' before its removeNode, and delete the dead operations.`,
        });
      }
    }
    if (type === REMOVE_TYPE && typeof op["target"] === "string") {
      removed.set(op["target"], index);
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* 2. children outside their parent bounds                                     */
/* -------------------------------------------------------------------------- */

/**
 * Runs only when both the child box (its own w+h declared) and its parent's
 * box are known; a check with half the evidence cannot run. The permission
 * source is the plan's `constraints.overflow`, recorded per region (and
 * per content id when the caller keyed it that way): "forbid"/"clip" block,
 * "allow" blocks unless a reason was recorded, and NO record fails closed —
 * an unrecorded permission is not a permission.
 *
 * The replay supplies both boxes: containment is translation-invariant, so a
 * caller-side canvas placement cancels out and the emitted stream remains the
 * last word on where things ended up.
 */
function checkChildBounds(resolved: Map<string, ResolvedNode>, context: PreflightContext): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const overflow = asMap(context.overflow);
  const reasons = asMap(context.overflowReasons);
  for (const node of resolved.values()) {
    if (typeof node.parent !== "string") continue;
    if (node.absolute === undefined || node.w === undefined || node.h === undefined) continue;
    const parent = resolved.get(node.parent);
    if (!parent || parent.absolute === undefined || parent.w === undefined || parent.h === undefined) continue;

    const childRight = node.absolute.x + node.w;
    const childBottom = node.absolute.y + node.h;
    const parentRight = parent.absolute.x + parent.w;
    const parentBottom = parent.absolute.y + parent.h;
    const outside =
      node.absolute.x < parent.absolute.x - CONTAINMENT_EPS ||
      node.absolute.y < parent.absolute.y - CONTAINMENT_EPS ||
      childRight > parentRight + CONTAINMENT_EPS ||
      childBottom > parentBottom + CONTAINMENT_EPS;
    if (!outside) continue;

    // Which permission governs: the child's own record first (the caller may
    // key content by id), then the region's.
    const child = node.id;
    const region = node.parent;
    const permission = overflow.get(child) ?? overflow.get(region);
    const reason = reasons.get(child) ?? reasons.get(region);
    if (permission === "allow" && reason !== undefined && reason.trim().length > 0) continue; // allowed AND justified

    const boxNote = `child at (${Math.round(node.absolute.x)}, ${Math.round(node.absolute.y)}) ${Math.round(node.w)}x${Math.round(node.h)} against parent '${region}' at (${Math.round(parent.absolute.x)}, ${Math.round(parent.absolute.y)}) ${Math.round(parent.w)}x${Math.round(parent.h)}`;
    let message: string;
    if (permission === "allow") {
      message =
        `outside-bounds: '${child}' lies outside its parent (allow with no reason) — ${boxNote}. ` +
        `"allow" is a permission, not a shrug: overflow of a planned region must carry the reason the plan recorded for it.`;
    } else if (permission === undefined) {
      message =
        `outside-bounds: '${child}' lies outside its parent (no permission recorded) — ${boxNote}. ` +
        `The plan carries no constraints.overflow for '${region}', so this fails closed.`;
    } else {
      message =
        `outside-bounds: '${child}' lies outside its parent (plan permission is "${permission}") — ${boxNote}. ` +
        `"${permission}" means the region's content is contained or visibly clipped, never poking past the edge.`;
    }
    issues.push({
      index: node.opIndex,
      opType: node.kind,
      message,
      fix:
        `Move or shrink '${child}' so it fits inside '${region}', or change the plan: record constraints.overflow:"allow" ` +
        `for '${region}' together with the reason that justifies it.`,
    });
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* 3. text that cannot contain its measured content                            */
/* -------------------------------------------------------------------------- */

/**
 * Compares text the plugin measured (measureProgramText) against the box the
 * operations allocate. Allocating is explicit: a createText with a `width`
 * (what the compiler emits for every prose slot, compile.ts emitText) or a
 * parent box to sit inside. Text the operations neither size nor place is
 * skipped — without an allocation there is nothing to overflow.
 *
 * `textAutoResize:"HEIGHT"` may wrap at its width, so a width overflow cannot
 * happen by construction and the check does not fire; `WIDTH_AND_HEIGHT`
 * sizes itself to the content, so there is no allocation to violate. Text
 * WITHOUT a measurement is not judged ("no evidence" is not a pass) — the
 * failure mode the per-session measurement cache exists to prevent.
 */
function checkTextOverflow(resolved: Map<string, ResolvedNode>, context: PreflightContext): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const measured = asMap(context.textMeasurements);
  for (const node of resolved.values()) {
    if (node.kind !== "createText") continue;
    const measurement = measured.get(node.id);
    if (!measurement) continue;

    // Allocation: the declared width wins; otherwise the parent's box when known.
    let allocatedW: number | undefined = node.declaredW ? node.w : undefined;
    let allocatedH: number | undefined = node.declaredH ? node.h : undefined;
    if ((allocatedW === undefined || allocatedH === undefined) && typeof node.parent === "string") {
      const parent = resolved.get(node.parent);
      if (parent?.w !== undefined && parent?.h !== undefined) {
        if (allocatedW === undefined) allocatedW = parent.w;
        if (allocatedH === undefined) allocatedH = parent.h;
      }
    }
    if (allocatedW === undefined && allocatedH === undefined) continue;

    const autoResize = node.opAutoResize;
    if (autoResize === "WIDTH_AND_HEIGHT") continue; // sizes itself to the content: no allocation to violate
    if (autoResize === "HEIGHT") {
      // It may wrap at its width, so the width cannot overflow — but a FIXED
      // box height can still be outgrown by the wrapped text.
      if (node.declaredH && allocatedH !== undefined && measurement.height > allocatedH + TEXT_EPS) {
        issues.push(textOverflowIssue(node, allocatedH, measurement, "height"));
      }
      continue;
    }
    if (allocatedW !== undefined && measurement.width > allocatedW + TEXT_EPS) {
      issues.push(textOverflowIssue(node, allocatedW, measurement, "width"));
    } else if (node.declaredH && allocatedH !== undefined && measurement.height > allocatedH + TEXT_EPS) {
      issues.push(textOverflowIssue(node, allocatedH, measurement, "height"));
    }
  }
  return issues;
}

function textOverflowIssue(node: ResolvedNode, allocated: number, measured: { width: number; height: number }, axis: "width" | "height"): PreflightIssue {
  const over = axis === "width" ? measured.width - allocated : measured.height - allocated;
  return {
    index: node.opIndex,
    opType: node.kind,
    message:
      `text-overflow: '${node.id}' measured ${axis} ${Math.round(measured[axis])}px cannot be contained by its allocated ` +
      `${Math.round(allocated)}px box (over by ${Math.round(over)}px). The text will clip or spill, and the plan promised it would fit.`,
    fix:
      `Widen the box (or its region), shorten the content, or set textAutoResize:"HEIGHT" so the text can wrap ` +
      `at the width the layout resolved.`,
  };
}

/* -------------------------------------------------------------------------- */
/* 6. resolved geometry vs emitted geometry                                    */
/* -------------------------------------------------------------------------- */

/**
 * Compares the plan's resolved bounds against the geometry the operations
 * replay to. The two disagreeing means either the operations were emitted
 * from a layout pass that is not the plan, or a hand edit moved a node away
 * from where its region resolved — both are screens that will not match the
 * screen that was promised.
 *
 * Grace: 1px (`TRACE_EPS`) on every axis the operation declares. An axis left
 * to Figma to size (text height, auto-sized text) is skipped, because its
 * final value comes from the measured re-flow rather than from the plan.
 * A "hug"/"fill" axis forced to a fixed, different value is reported as the
 * sizing contradiction it is. A caller-recorded validated reason
 * (`geometryReasons[id]`) stands for the difference — recorded, not assumed.
 */
function checkResolvedVsEmitted(resolved: Map<string, ResolvedNode>, context: PreflightContext): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const planBoxes = asMap(context.planBoxes);
  const sizing = asMap(context.sizing);
  const geometryReasons = asMap(context.geometryReasons);
  if (planBoxes.size === 0) return issues;

  // `planBoxes` are headless page-absolute (canvas-origin space, before any
  // placeRootInFreeCanvas shift). The replay anchors on the root frame's own
  // replayed position to land in that same space, so a caller-side placement
  // on the wire cancels out instead of translating every box.
  const rootOrigin = resolved.get("root")?.absolute ?? { x: 0, y: 0 };

  for (const [id, plan] of planBoxes) {
    if (id === "root") continue;
    const node = resolved.get(id);
    if (!node || node.absolute === undefined) continue;
    // A derived-geometry op (path-bearing vector: a logoMark's tight mark
    // bbox, a connector's route bbox) positions itself from its own path, not
    // from the layout — comparing it against the plan box would false-positive
    // on exactly the consistent emitters. Containment still applies to them
    // via the child-bounds class; the connector class audits endpoints.
    if (node.derived === true) continue;
    // A caller-recorded validated reason stands for any deliberate
    // difference on this node — recorded, not assumed.
    if (geometryReasons.get(id) !== undefined) continue;
    const emittedX = node.absolute.x - rootOrigin.x;
    const emittedY = node.absolute.y - rootOrigin.y;

    if (Math.abs(emittedX - plan.x) > TRACE_EPS || Math.abs(emittedY - plan.y) > TRACE_EPS) {
      issues.push({
        index: node.opIndex,
        opType: node.kind,
        message:
          `geometry-drift: '${id}' resolves to (${Math.round(plan.x)}, ${Math.round(plan.y)}) in the plan but the operations place it at ` +
          `(${Math.round(emittedX)}, ${Math.round(emittedY)}). A preview the build contradicts trains the reader to distrust the preview.`,
        fix:
          `Emit the operation at the resolved position, or record a validated reason for the deliberate difference ` +
          `(geometryReasons["${id}"]) before dispatching.`,
      });
      continue;
    }

    const emittedW = node.declaredW ? node.w : undefined;
    const emittedH = node.declaredH ? node.h : undefined;
    const planSizing = sizing.get(id);
    for (const axis of ["w", "h"] as const) {
      const emitted = axis === "w" ? emittedW : emittedH;
      if (emitted === undefined) continue; // auto-sized axis: its truth comes from measurement, not the plan
      const planSize = axis === "w" ? plan.w : plan.h;
      if (Math.abs(emitted - planSize) <= TRACE_EPS) continue;
      const sizingAxis = axis === "w" ? "width" : "height";
      const constraint = planSizing?.[sizingAxis];
      const contradiction =
        constraint === "hug" || constraint === "fill"
          ? `The plan sizes this axis as "${constraint}", the operations force it to a fixed ${Math.round(emitted)}px — a sizing contradiction.`
          : "";
      issues.push({
        index: node.opIndex,
        opType: node.kind,
        message:
          `geometry-drift: '${id}' resolves to ${Math.round(planSize)}px ${axis === "w" ? "wide" : "tall"} in the plan but the operations declare ` +
          `${Math.round(emitted)}px${contradiction ? ` — ${contradiction}` : ""}.`,
        fix:
          `Emit the size the plan resolved, or record a validated reason for the deliberate difference ` +
          `(geometryReasons["${id}"]) before dispatching.`,
      });
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* 4. connector endpoints and labels                                           */
/* -------------------------------------------------------------------------- */

/**
 * A connector already solved its route at compile time (routeConnector), so
 * the only pre-mutation question left is whether that route still lands on
 * the nodes it names: the first endpoint must touch the `from` box, the last
 * one the `to` box (2px reach, matching the compiler), and a label must lie
 * within the hull of the two endpoint boxes — a label entirely outside it is
 * not offset from the edge, it labels nothing.
 */
function checkConnectors(ops: ParsedOp[], context: PreflightContext): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const connectors = context.connectors ?? [];
  if (connectors.length === 0) return issues;
  const planBoxes = asMap(context.planBoxes);
  const ownerByOpId = new Map<string, ParsedOp>();
  for (const p of ops) {
    const id = p.op["id"];
    if (typeof id === "string") ownerByOpId.set(id, p);
  }

  const touches = (p: { x: number; y: number }, box: PreflightBox): boolean =>
    p.x >= box.x - CONNECTOR_TOUCH_EPS &&
    p.x <= box.x + box.w + CONNECTOR_TOUCH_EPS &&
    p.y >= box.y - CONNECTOR_TOUCH_EPS &&
    p.y <= box.y + box.h + CONNECTOR_TOUCH_EPS;

  for (const spec of connectors) {
    const owner = ownerByOpId.get(spec.id);
    const index = owner?.index ?? -1;
    const opType = owner?.type ?? "connector";
    const fromBox = planBoxes.get(spec.from);
    const toBox = planBoxes.get(spec.to);
    if (!fromBox || !toBox) {
      issues.push({
        index,
        opType,
        message:
          `connector: '${spec.id}' names '${!fromBox ? spec.from : spec.to}', which has no resolved box, so its endpoints cannot be proven to land on the node they name.`,
        fix: `Give '${spec.from}' and '${spec.to}' placed parents (or resolve their boxes) so the route can terminate on the node.`,
      });
      continue;
    }
    if (!Array.isArray(spec.endpoints) || spec.endpoints.length < 2) {
      issues.push({
        index,
        opType,
        message: `connector: '${spec.id}' resolved ${spec.endpoints?.length ?? 0} endpoint(s); a route needs a distinct start and end to be checked.`,
        fix: `Route the connector between two placed nodes (routeConnector) before dispatching.`,
      });
      continue;
    }
    const first = spec.endpoints[0]!;
    const last = spec.endpoints[spec.endpoints.length - 1]!;
    if (!touches(first, fromBox)) {
      issues.push({
        index,
        opType,
        message:
          `connector: '${spec.id}' starts at (${Math.round(first.x)}, ${Math.round(first.y)}), which does not touch '${spec.from}' ` +
          `at (${Math.round(fromBox.x)}, ${Math.round(fromBox.y)}) ${Math.round(fromBox.w)}x${Math.round(fromBox.h)}. The route was solved against different geometry than the nodes ended up with.`,
        fix: `Re-route the connector against the final node boxes, or fix the node geometry it was routed against.`,
      });
    }
    if (!touches(last, toBox)) {
      issues.push({
        index,
        opType,
        message:
          `connector: '${spec.id}' ends at (${Math.round(last.x)}, ${Math.round(last.y)}), which does not touch '${spec.to}' ` +
          `at (${Math.round(toBox.x)}, ${Math.round(toBox.y)}) ${Math.round(toBox.w)}x${Math.round(toBox.h)}. The route was solved against different geometry than the nodes ended up with.`,
        fix: `Re-route the connector against the final node boxes, or fix the node geometry it was routed against.`,
      });
    }
    if (spec.labelAt) {
      const hull = {
        x: Math.min(fromBox.x, toBox.x),
        y: Math.min(fromBox.y, toBox.y),
        right: Math.max(fromBox.x + fromBox.w, toBox.x + toBox.w),
        bottom: Math.max(fromBox.y + fromBox.h, toBox.y + toBox.h),
      };
      const off =
        spec.labelAt.x < hull.x - LABEL_HULL_EPS ||
        spec.labelAt.x > hull.right + LABEL_HULL_EPS ||
        spec.labelAt.y < hull.y - LABEL_HULL_EPS ||
        spec.labelAt.y > hull.bottom + LABEL_HULL_EPS;
      if (off) {
        issues.push({
          index,
          opType,
          message:
            `connector: the label of '${spec.id}' at (${Math.round(spec.labelAt.x)}, ${Math.round(spec.labelAt.y)}) sits entirely outside the hull of ` +
            `'${spec.from}' and '${spec.to}' — it labels the edge in name only.`,
          fix: `Anchor the label on the route between the two nodes (routeConnector's labelAt), or remove it.`,
        });
      }
    }
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* 7. blocking brief contradictions                                            */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors the transaction-edge refusal in transaction.ts so `dryRun` and any
 * direct preflight caller see the same words. The pipeline stops at stage 1
 * already; this is the belt under whatever path still reaches dispatch.
 */
function checkBriefBlockers(context: PreflightContext): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  for (const blocker of context.briefBlockers ?? []) {
    if ((blocker?.severity ?? "") !== "blocking") continue;
    issues.push({
      index: -1,
      opType: "brief",
      message: `brief-blocker: ${blocker.message}`,
      fix: blocker.fix ?? "Resolve the contradiction in the brief; nothing may be dispatched from a brief that contradicts itself.",
    });
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* Composition                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Runs every blocking program check. `operations` may contain schema-invalid
 * entries — those are skipped here and reported by preflight.ts's schema
 * pass, which keeps this module self-contained without double-reporting.
 */
export function runBlockingChecks(operations: unknown[], context?: PreflightContext): PreflightIssue[] {
  if (!Array.isArray(operations) || operations.length === 0) return [];
  const ops = parseOps(operations);
  const issues: PreflightIssue[] = [];
  issues.push(...checkParentAssignments(ops));
  issues.push(...checkStaleTargets(ops));
  if (context !== undefined) {
    const resolved = replayGeometry(ops);
    issues.push(...checkChildBounds(resolved, context));
    issues.push(...checkTextOverflow(resolved, context));
    issues.push(...checkResolvedVsEmitted(resolved, context));
    issues.push(...checkConnectors(ops, context));
    issues.push(...checkBriefBlockers(context));
  }
  return issues;
}
