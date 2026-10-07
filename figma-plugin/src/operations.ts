/**
 * The execution layer.
 *
 * Every mutation the model can cause lives in this file, dispatched from a
 * closed switch over a zod-validated discriminated union (SPEC §19). There is
 * deliberately no eval, no new Function, and no dynamic property access on
 * figma nodes.
 *
 * Two-pass execution: pass 1 creates nodes and records the temp-id -> figma-id
 * mapping, pass 2 applies everything else in the original order. This lets a
 * plan reference a node before its create operation appears in the array.
 */
import {
  OperationSchema,
  parseColor,
  type CornerRadius,
  type CreatedNode,
  type Operation,
  type Padding,
  type TransactionFailure,
  type TransactionResult,
} from "../../shared/protocol";
import { parseSvgPath, parseVectorSegments, segmentsToPathData } from "../../shared/path";

const MAX_CREATED_NODES = 500;

/** Applied-trace lines returned per transaction; the rest is summarized. */
const APPLIED_TRACE_CAP = 300;

/**
 * Estimates the width of a hug-sized pill, button or nav item.
 *
 * Figma's FrameNode has no `resize` mode that shrinks to content, so a compact
 * auto-width component has to be measured up front. The numbers are calibrated
 * for Inter at the sizes used below and deliberately generous: a slightly wide
 * pill looks intentional, a clipped one looks broken.
 */
function hugWidth(text: string, { fontSize, paddingX }: { fontSize: number; paddingX: number }): number {
  const charWidth = fontSize * 0.56;
  return Math.ceil(Math.max(1, text.length) * charWidth + paddingX * 2);
}

export class OperationError extends Error {
  constructor(
    message: string,
    readonly operationIndex: number,
    readonly opType: string,
  ) {
    super(message);
    this.name = "OperationError";
  }
}

/* -------------------------------------------------------------------------- */
/* Font handling                                                               */
/* -------------------------------------------------------------------------- */

const fontCache = new Map<string, FontName>();

/**
 * Text typography requires the font to be loaded before the property is set.
 * A missing family is reported, never silently substituted — otherwise the
 * model believes it applied a brand font when it did not.
 */
async function loadFont(family: string, style: string): Promise<FontName> {
  const key = `${family}::${style}`;
  const cached = fontCache.get(key);
  if (cached) return cached;

  try {
    await figma.loadFontAsync({ family, style });
  } catch {
    const available = await figma.listAvailableFontsAsync();
    const match =
      available.find((f) => f.fontName.family === family && f.fontName.style === style) ??
      available.find((f) => f.fontName.family === family) ??
      available.find((f) => f.fontName.family.toLowerCase() === family.toLowerCase());

    if (!match) {
      const sample = Array.from(new Set(available.map((f) => f.fontName.family))).slice(0, 12);
      throw new Error(
        `Font "${family}" is not available to plugins. Sample of available families: ${sample.join(", ")}`,
      );
    }
    await figma.loadFontAsync(match.fontName);
    fontCache.set(key, match.fontName);
    return match.fontName;
  }

  const name: FontName = { family, style };
  fontCache.set(key, name);
  return name;
}

/**
 * Maps a CSS-style numeric weight onto a style the family actually has.
 *
 * Tries the requested style first, then progressively simpler fallbacks, so a
 * font that ships only Regular renders at Regular instead of failing outright.
 */
async function resolveWeightStyle(family: string, weight: number, preferred: string): Promise<string> {
  const wanted = weightToStyleName(weight);
  const candidates = [...new Set([wanted, preferred, "Regular"])];

  let available: ReadonlyArray<Font> = [];
  try {
    available = await figma.listAvailableFontsAsync();
  } catch {
    return candidates[0]!;
  }

  const stylesForFamily = new Set(available.filter((f) => f.fontName.family === family).map((f) => f.fontName.style));
  if (stylesForFamily.size === 0) {
    const caseInsensitive = new Set(
      available.filter((f) => f.fontName.family.toLowerCase() === family.toLowerCase()).map((f) => f.fontName.style),
    );
    if (caseInsensitive.size > 0) return candidates.find((c) => caseInsensitive.has(c)) ?? "Regular";
    return candidates[0]!;
  }

  return candidates.find((c) => stylesForFamily.has(c)) ?? "Regular";
}

function weightToStyleName(weight: number): string {
  if (weight >= 800) return "ExtraBold";
  if (weight >= 700) return "Bold";
  if (weight >= 600) return "SemiBold";
  if (weight >= 500) return "Medium";
  return "Regular";
}

/* -------------------------------------------------------------------------- */
/* Variables and styles                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Finds a variable collection by name, creating it if absent.
 *
 * Looked up rather than always created because re-running a program is the
 * normal case in an iterative loop. Blindly creating would leave the file with
 * `Design Agent` and `Design Agent 2` after two runs, which is exactly the
 * accumulation problem §22 is meant to solve.
 *
 * The collections list is passed in because `getLocalVariableCollections` is
 * async under `documentAccess: "dynamic-page"`, and the caller has already
 * awaited it.
 */
function ensureVariableCollection(name: string, collections: readonly VariableCollection[]): VariableCollection {
  return collections.find((c) => c.name === name) ?? figma.variables.createVariableCollection(name);
}

/** Finds a mode by name, creating it when the program introduces a new one. */
function ensureMode(collection: VariableCollection, name: string): string {
  const existing = collection.modes.find((m) => m.name === name);
  if (existing) return existing.modeId;
  return collection.addMode(name);
}

/**
 * Finds an existing variable in a collection, for the create-or-update case.
 *
 * Compared against the name *passed to createVariable*, not the operation's
 * name, because that is the name under which it was stored. Uses `variableIds`
 * plus `getVariableById` rather than a `variables` array: the collection shape
 * has moved between plugin-typing versions, and this pair is the stable one.
 */
function findVariable(collection: VariableCollection, name: string): Variable | undefined {
  for (const id of collection.variableIds) {
    const variable = figma.variables.getVariableById(id);
    if (variable && variable.name === name) return variable;
  }
  return undefined;
}

/**
 * Resolves a variable by name, with or without a collection prefix.
 *
 * Fails loudly when the variable does not exist, naming the fix: declare it
 * with the `variable` primitive or run the project's seed tool. Silently
 * substituting a literal would freeze the value and defeat the binding.
 */
async function resolveVariable(ref: string, collectionHint: string | undefined, index: number, opType: string): Promise<Variable> {
  const fail = (): OperationError =>
    new OperationError(
      `Variable '${ref}' does not exist in this file. Declare it with the variable primitive (or seed_exo_system for the EXO set) before binding to it.`,
      index,
      opType,
    );

  const slash = ref.indexOf("/");
  const collectionName = slash >= 0 ? ref.slice(0, slash) : (collectionHint ?? null);
  const name = slash >= 0 ? ref.slice(slash + 1) : ref;

  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  for (const collection of collections) {
    if (collectionName && collection.name !== collectionName) continue;
    const found = findVariable(collection, name);
    if (found) return found;
  }
  throw fail();
}

/**
 * Coerces a model-supplied value to the type the variable expects.
 *
 * Figma throws if a STRING variable receives a number, and a COLOR variable
 * receives anything unparseable. Coercing here means a slightly-off token value
 * degrades to something sensible rather than failing the whole transaction.
 */
function coerceVariableValue(value: string | number | boolean, type: "color" | "number" | "string" | "boolean"): VariableValue {
  switch (type) {
    case "color": {
      const c = parseColor(typeof value === "string" ? value : "#000000");
      return { r: c.r, g: c.g, b: c.b, a: c.a };
    }
    case "number":
      return typeof value === "number" ? value : Number.parseFloat(String(value)) || 0;
    case "boolean":
      return typeof value === "boolean" ? value : value === "true";
    case "string":
    default:
      return String(value);
  }
}

/**
 * Sets speaker notes on a slide, when this API version exposes them.
 *
 * `SlideNode.speakerNotes` exists at runtime but is absent from some published
 * plugin-typing versions, so it goes through a guarded write rather than an
 * assertion. Notes are a bonus on top of the slide itself, never the reason a
 * transaction fails.
 */
function applySlideNotes(slide: SlideNode, notes: string | undefined): void {
  if (notes === undefined) return;
  const target = slide as SlideNode & { speakerNotes?: string };
  if ("speakerNotes" in target) target.speakerNotes = notes;
}

/**
 * Applies a fill to a text style, if this API version exposes one.
 *
 * `TextStyle.fills` is present at runtime but absent from some published
 * plugin-typing versions, so it is applied through a guarded read rather than
 * asserted. Typography without a colour is still a usable style; silently
 * failing to set the colour would be worse than not offering it.
 */
function applyTextStylePaints(style: TextStyle, fill: unknown): void {
  if (fill === undefined || fill === null) return;
  const paints = toPaints(fill);
  if (paints.length === 0) return;
  const target = style as TextStyle & { fills?: readonly Paint[] };
  if ("fills" in target) target.fills = paints;
}

/**
 * Registers a non-scene result (a variable or style id) under a transaction-local
 * alias.
 *
 * Variables and styles are not in the scene graph, so they cannot go through
 * `register`, which tracks created scene nodes for rollback accounting. They
 * still need to be addressable, because a later operation may want to bind a
 * node to a variable it just created.
 */
function registerId(ctx: Ctx, tempId: string | undefined, realId: string): string {
  if (tempId) ctx.ids.set(tempId, realId);
  return realId;
}

/* -------------------------------------------------------------------------- */
/* Paint helpers                                                               */
/* -------------------------------------------------------------------------- */

function solid(color: string, opacity?: number): SolidPaint {
  const c = parseColor(color);
  return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: opacity ?? c.a };
}

function toPaints(fill: unknown): readonly Paint[] {
  if (fill === null) return [];
  if (typeof fill === "string") return [solid(fill)];
  if (Array.isArray(fill)) return fill.map((f) => (typeof f === "string" ? solid(f) : solid(f.color, f.opacity)));
  const o = fill as { color: string; opacity?: number };
  return [solid(o.color, o.opacity)];
}

/** True when a fill spec actually names at least one paint. */
function hasAnyPaint(fill: unknown): boolean {
  if (fill === null || fill === undefined) return false;
  if (typeof fill === "string") return fill.length > 0;
  if (Array.isArray(fill)) return fill.length > 0;
  return typeof (fill as { color?: unknown }).color === "string";
}

function four(value: Padding): [number, number, number, number] {
  if (typeof value === "number") return [value, value, value, value];
  const t = value.top ?? 0;
  const r = value.right ?? value.top ?? 0;
  const b = value.bottom ?? value.top ?? 0;
  const l = value.left ?? value.right ?? value.top ?? 0;
  return [t, r, b, l];
}

function applyRadius(node: SceneNode, radius: CornerRadius): void {
  if (!("cornerRadius" in node)) {
    throw new Error(`${node.type} does not support corner radius`);
  }
  // cornerRadius is readonly on a few node types (e.g. PolygonNode), so this
  // is a deliberate widening: the Figma schema is authoritative at runtime.
  const mutable = node as SceneNode & { cornerRadius: number };
  if (typeof radius === "number") {
    mutable.cornerRadius = radius;
    return;
  }
  if (radius.topLeft !== undefined) (node as FrameNode).topLeftRadius = radius.topLeft;
  if (radius.topRight !== undefined) (node as FrameNode).topRightRadius = radius.topRight;
  if (radius.bottomLeft !== undefined) (node as FrameNode).bottomLeftRadius = radius.bottomLeft;
  if (radius.bottomRight !== undefined) (node as FrameNode).bottomRightRadius = radius.bottomRight;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

interface Ctx {
  /** temp id -> real figma id */
  ids: Map<string, string>;
  created: CreatedNode[];
  /** Figma ids touched by non-create operations, for evidence. */
  modified: Set<string>;
  currentPageId: string;
  isDryRun: boolean;
}

/**
 * Records every node a mutation addresses, resolved to its real Figma id.
 *
 * Runs after a successful apply, so a failed operation never pollutes the
 * evidence: the next call operates from what actually changed, not from what
 * was attempted. Creates record their parent (a new child modifies its
 * container); mutations record their target, and appendChild both ends.
 */
function touchRefs(ctx: Ctx, op: Parsed): void {
  const refs: string[] = [];
  const o = op as Record<string, unknown>;
  if (typeof o.target === "string") refs.push(o.target);
  if (typeof o.parent === "string") refs.push(o.parent);
  if (typeof o.child === "string") refs.push(o.child);
  for (const ref of refs) {
    ctx.modified.add(ctx.ids.get(ref) ?? ref);
  }
}

/** Anything that can receive children: a page, frame, component or instance. */
type ParentNode = ChildrenMixin & BaseNode;

async function resolve(ctx: Ctx, ref: string, index: number, opType: string): Promise<BaseNode> {
  const id = ctx.ids.get(ref) ?? ref;
  let node: BaseNode | null = null;
  try {
    node = await figma.getNodeByIdAsync(id);
  } catch {
    node = null;
  }
  if (!node) throw new OperationError(`Node not found: ${ref}`, index, opType);
  return node;
}

async function resolveParent(ctx: Ctx, ref: string | undefined, index: number, opType: string): Promise<ParentNode> {
  if (!ref) return figma.currentPage;
  const node = await resolve(ctx, ref, index, opType);
  if (!("appendChild" in node)) {
    throw new OperationError(`${node.type} cannot be a parent`, index, opType);
  }
  return node as ParentNode;
}

function requireScene(node: BaseNode, index: number, opType: string): SceneNode {
  if (node.type === "DOCUMENT" || node.type === "PAGE") {
    throw new OperationError(`Operation not valid on ${node.type}`, index, opType);
  }
  return node as SceneNode;
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

type Parsed = Operation;

function parseAll(ops: unknown[]): Parsed[] {
  return ops.map((raw, i) => {
    const parsed = OperationSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") ?? "";
      throw new OperationError(
        `Invalid operation: ${issue?.message ?? "schema mismatch"}${path ? ` (at ${path})` : ""}`,
        i,
        (raw as { type?: string })?.type ?? "unknown",
      );
    }
    return parsed.data;
  });
}

/**
 * Validate + execute a whole transaction.
 *
 * Undo handling uses Figma's native undo stack rather than a hand-rolled
 * journal: commit before, commit after, and triggerUndo() if we bail halfway.
 *
 * Progress is reported as operations land, and the loop yields to the event
 * loop between chunks. That pair is what makes a build *visible*: without the
 * yield, a large program applies inside one synchronous run and the screen
 * appears all at once; with it, regions land one after another while the panel
 * narrates. The transaction still commits once, so undo stays a single step.
 */
export async function runTransaction(input: {
  transactionId: string;
  description?: string;
  operations: unknown[];
  dryRun: boolean;
  onProgress?: (done: number, total: number, label: string) => void;
}): Promise<TransactionResult> {
  let parsed: Parsed[];

  try {
    parsed = parseAll(input.operations);
  } catch (err) {
    return failure(input.transactionId, err, false);
  }

  if (input.dryRun) {
    // Validation-only: report what *would* happen without touching the document.
    return {
      transactionId: input.transactionId,
      status: "success",
      dryRun: true,
      createdNodes: [],
      modifiedNodes: [],
      applied: parsed.map((op) => `${op.type}${describe(op)}`),
    };
  }

  const ctx: Ctx = {
    ids: new Map(),
    created: [],
    modified: new Set(),
    currentPageId: figma.currentPage.id,
    isDryRun: false,
  };

  const applied: string[] = [];
  const pass1 = parsed.filter(isCreateOp);
  const pass2 = parsed.filter((op) => !isCreateOp(op));

  // Seal prior document state so this transaction becomes one undo step.
  try {
    figma.commitUndo();
  } catch {
    /* commitUndo is best-effort */
  }

  try {
    const ordered = [...pass1, ...pass2];
    const total = ordered.length;

    for (let n = 0; n < ordered.length; n++) {
      const op = ordered[n]!;
      const index = parsed.indexOf(op);
      const note = await apply(ctx, op, index);
      applied.push(`${op.type}${note ? ` ${note}` : ""}`);
      touchRefs(ctx, op);

      // Report roughly every 10% (and always the last op) so a 500-op build
      // narrates without flooding the iframe with 500 messages.
      const done = n + 1;
      if (input.onProgress && (done === total || done % Math.max(1, Math.floor(total / 10)) === 0)) {
        input.onProgress(done, total, describe(op) || op.type);
      }

      // Yield so the canvas repaints and the panel stays alive. Without this
      // the whole transaction runs synchronously and the user sees nothing
      // until the final commit.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (err) {
    return failure(input.transactionId, err, true);
  }

  try {
    figma.commitUndo();
  } catch {
    /* ignore */
  }

  // Evidence: committed bounds for everything created, read after the dust
  // settles so auto-layout shifts are included. A node removed later in the
  // same transaction simply carries no bounds rather than failing the report.
  for (const entry of ctx.created) {
    try {
      const node = await figma.getNodeByIdAsync(entry.figmaNodeId);
      if (node && "x" in node && "width" in node) {
        const b = node as SceneNode & { x: number; y: number; width: number; height: number };
        entry.bounds = {
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.round(b.width),
          height: Math.round(b.height),
        };
      }
    } catch {
      /* gone: no bounds, still reported as created */
    }
  }

  // The trace is evidence, not a log file: cap it so a 2000-op construction
  // does not flood the model with 2000 lines.
  const trace = applied.length > APPLIED_TRACE_CAP
    ? [...applied.slice(0, APPLIED_TRACE_CAP), `… and ${applied.length - APPLIED_TRACE_CAP} more operations applied.`]
    : applied;

  return {
    transactionId: input.transactionId,
    status: "success",
    dryRun: false,
    createdNodes: ctx.created,
    modifiedNodes: [...ctx.modified],
    applied: trace,
  };
}

function isCreateOp(op: Parsed): boolean {
  return (
    op.type === "createFrame" ||
    op.type === "createRectangle" ||
    op.type === "createEllipse" ||
    op.type === "createText" ||
    op.type === "createVector" ||
    op.type === "booleanOperation" ||
    op.type === "outlineStroke" ||
    op.type === "createSlide" ||
    op.type === "cloneNode" ||
    op.type === "createComponent" ||
    op.type === "createInstance"
  );
}

function describe(op: Parsed): string {
  switch (op.type) {
    case "createFrame":
      return `${op.name ?? "Frame"} ${op.width}x${op.height}`;
    case "createRectangle":
    case "createEllipse":
      return `${op.width}x${op.height}`;
    case "createText":
      return `"${op.content.slice(0, 32)}"`;
    case "createVector":
      return "vector";
    case "booleanOperation":
      return op.operation;
    case "outlineStroke":
      return "outline";
    case "setVectorPath":
      return "path";
    case "mirrorNode":
      return op.axis;
    case "setLayoutGrid":
      return `${op.count}x${op.pattern}`;
    case "createSlide":
      return `${op.name ?? "Slide"} 1920x1080`;
    case "createComponent":
      return `Component ${op.name ?? ""}`;
    case "createInstance":
      return `Instance ${op.name ?? ""}`;
    case "createVariable":
      return `${op.name} (${op.variableType})`;
    case "bindVariable":
      return `${op.field}=${op.variable}`;
    case "createTextStyle":
      return `${op.name} ${op.fontSize}px`;
    case "createPaintStyle":
      return `${op.name} ${op.color}`;
    case "prototypeLink":
      return `${op.from} -> ${op.to}`;
    case "createGroup":
      return op.name ?? "Group";
    case "setEffect":
      return op.effect;
    case "setVariant":
      return JSON.stringify(op.variant);
    case "setConstraints":
      return `${op.horizontal} / ${op.vertical}`;
    case "renameNode":
      return op.name;
    case "setSize":
      return `${op.width ?? "?"}x${op.height ?? "?"}`;
    case "setPosition":
      return `x=${op.x ?? "?"} y=${op.y ?? "?"}`;
    case "setFill":
      return JSON.stringify(op.fill);
    default:
      return "";
  }
}

/** Serialises a parsed polyline into Figma's VectorPath data format. */
function toVectorPathData(points: Array<{ x: number; y: number }>): VectorPath {
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]!.x} ${points[i]!.y}`;
  return { windingRule: "NONE", data: `${d} Z` };
}

/**
 * Bezier-preserving vector paths for Figma's VectorNode.
 *
 * The legacy pipeline flattens every curve to polylines. This keeps M/L/C/Q
 * intact so curve handles survive. Arcs (A) are not in Figma's vector-path
 * grammar, so a path containing one falls back to the flattened pipeline —
 * correct geometry at a higher point count rather than a refused logo.
 * Subpaths after the first become EVENODD fill regions (rings, cutouts,
 * letterform counters) unless the caller names another winding rule.
 */
function toBezierVectorPaths(d: string, windingRule: "NONE" | "NONZERO" | "EVENODD"): VectorPath[] {
  const segments = parseVectorSegments(d);
  const subpaths: string[][] = [];
  let current: string[] = [];
  for (const s of segments) {
    if (s.cmd === "M") {
      if (current.length > 0) subpaths.push(current);
      current = [`M ${s.x} ${s.y}`];
    } else if (s.cmd === "L") {
      current.push(`L ${s.x} ${s.y}`);
    } else if (s.cmd === "C") {
      current.push(`C ${s.x1} ${s.y1} ${s.x2} ${s.y2} ${s.x} ${s.y}`);
    } else if (s.cmd === "Q") {
      current.push(`Q ${s.x1} ${s.y1} ${s.x} ${s.y}`);
    } else if (s.cmd === "Z") {
      current.push("Z");
      subpaths.push(current);
      current = [];
    } else {
      // A should have been screened out by the caller; refuse loudly rather
      // than emitting a command Figma would misread.
      throw new Error("Arc segments need the flattened pipeline; call with an arc-free path.");
    }
  }
  if (current.length > 0) subpaths.push(current);
  if (subpaths.length === 0) throw new Error("Path produced no drawable geometry.");
  return subpaths.map((parts, i) => ({
    windingRule: i === 0 ? windingRule : "EVENODD",
    data: parts.join(" "),
  }));
}

function hasArcCommand(d: string): boolean {
  return /(^|[\s,])A(?=[\s,]|$)/.test(d) || /(^|[\s,])a(?=[\s,]|$)/.test(d);
}

async function apply(ctx: Ctx, op: Parsed, index: number): Promise<string> {
  switch (op.type) {
    /* ------------------------------ create ------------------------------ */
    case "createFrame": {
      const parent = await resolveParent(ctx, op.parent, index, op.type);
      const frame = figma.createFrame();
      frame.name = op.name ?? "Frame";
      frame.resize(op.width, op.height);
      parent.appendChild(frame);

      if (op.layoutMode && op.layoutMode !== "NONE") frame.layoutMode = op.layoutMode;
      if (op.itemSpacing !== undefined) frame.itemSpacing = op.itemSpacing;
      if (op.padding !== undefined) {
        const [t, r, b, l] = four(op.padding);
        frame.paddingTop = t;
        frame.paddingRight = r;
        frame.paddingBottom = b;
        frame.paddingLeft = l;
      }
      if (op.primaryAxisAlignItems) frame.primaryAxisAlignItems = op.primaryAxisAlignItems;
      if (op.counterAxisAlignItems) frame.counterAxisAlignItems = op.counterAxisAlignItems;
      if (op.clipsContent !== undefined) frame.clipsContent = op.clipsContent;

      frame.fills = toPaints(op.fill ?? []);
      if (op.opacity !== undefined) frame.opacity = op.opacity;
      if (op.cornerRadius !== undefined) applyRadius(frame, op.cornerRadius);
      if (op.stroke) {
        frame.strokes = [solid(op.stroke)];
        frame.strokeWeight = op.strokeWeight ?? 1;
      }
      if (op.visible !== undefined) frame.visible = op.visible;
      if (op.x !== undefined || op.y !== undefined) frame.x = op.x ?? frame.x;
      if (op.y !== undefined) frame.y = op.y;

      return register(ctx, op.id, frame, index, op.type);
    }

    case "createRectangle": {
      const parent = await resolveParent(ctx, op.parent, index, op.type);
      const rect = figma.createRectangle();
      rect.name = op.name ?? "Rectangle";
      rect.resize(op.width, op.height);
      parent.appendChild(rect);

      rect.fills = toPaints(op.fill ?? [{ color: "#CCCCCC", opacity: 1 }]);
      if (op.opacity !== undefined) rect.opacity = op.opacity;
      if (op.cornerRadius !== undefined) applyRadius(rect, op.cornerRadius);
      if (op.opacity !== undefined) rect.opacity = op.opacity;
      if (op.stroke) {
        rect.strokes = [solid(op.stroke)];
        rect.strokeWeight = op.strokeWeight ?? 1;
      }
      if (op.visible !== undefined) rect.visible = op.visible;
      if (op.x !== undefined) rect.x = op.x;
      if (op.y !== undefined) rect.y = op.y;

      return register(ctx, op.id, rect, index, op.type);
    }

    case "createEllipse": {
      const parent = await resolveParent(ctx, op.parent, index, op.type);
      const ell = figma.createEllipse();
      ell.name = op.name ?? "Ellipse";
      ell.resize(op.width, op.height);
      parent.appendChild(ell);

      ell.fills = toPaints(op.fill ?? []);
      if (op.opacity !== undefined) ell.opacity = op.opacity;
      if (op.stroke) {
        ell.strokes = [solid(op.stroke)];
        ell.strokeWeight = op.strokeWeight ?? 1;
      }
      if (op.visible !== undefined) ell.visible = op.visible;
      if (op.x !== undefined) ell.x = op.x;
      if (op.y !== undefined) ell.y = op.y;

      return register(ctx, op.id, ell, index, op.type);
    }

    case "createComponent": {
      const parent = await resolveParent(ctx, op.parent, index, op.type);
      const comp = figma.createComponent();
      comp.name = op.name ?? "Component";
      if (op.width !== undefined && op.height !== undefined) {
        comp.resize(op.width, op.height);
      }
      parent.appendChild(comp);

      comp.fills = toPaints(op.fill ?? []);
      if (op.opacity !== undefined) comp.opacity = op.opacity;
      if (op.x !== undefined) comp.x = op.x;
      if (op.y !== undefined) comp.y = op.y;

      return register(ctx, op.id, comp, index, op.type);
    }

    case "createInstance": {
      const parent = await resolveParent(ctx, op.parent, index, op.type);
      const componentNode = await resolve(ctx, op.componentId, index, op.type);
      if (componentNode.type !== "COMPONENT" && componentNode.type !== "COMPONENT_SET") {
        throw new OperationError(`Node ${op.componentId} is not a Component`, index, op.type);
      }
      const instance = (componentNode as ComponentNode).createInstance();
      instance.name = op.name ?? instance.name;
      parent.appendChild(instance);

      if (op.x !== undefined) instance.x = op.x;
      if (op.y !== undefined) instance.y = op.y;

      return register(ctx, op.id, instance, index, op.type);
    }

    case "createText": {
      const parent = await resolveParent(ctx, op.parent, index, op.type);
      // Numeric weight shorthand is resolved to a style the font actually has.
      // Guessing "SemiBold" for a font that only ships Regular would silently
      // render everything at Regular, so the real installed style wins.
      const requested = op.style ?? "Regular";
      const style = op.weight !== undefined ? await resolveWeightStyle(op.family, op.weight, requested) : requested;
      const font = await loadFont(op.family, style);

      const text = figma.createText();
      text.fontName = font;
      text.fontSize = op.fontSize;
      // Characters are set only after the font is loaded (Figma requirement).
      text.characters = op.content;
      text.name = op.name ?? (op.content.slice(0, 40) || "Text");
      parent.appendChild(text);

      if (op.lineHeight !== undefined) text.lineHeight = { value: op.lineHeight, unit: "PIXELS" };
      if (op.letterSpacing !== undefined) text.letterSpacing = { value: op.letterSpacing, unit: "PIXELS" };
      if (op.textAlignHorizontal) text.textAlignHorizontal = op.textAlignHorizontal;
      if (op.textAlignVertical) text.textAlignVertical = op.textAlignVertical;
      text.fills = toPaints(op.fill ?? [{ color: "#111111", opacity: 1 }]);
      if (op.opacity !== undefined) text.opacity = op.opacity;
      if (op.visible !== undefined) text.visible = op.visible;

      if (op.width !== undefined) {
        text.textAutoResize = "HEIGHT";
        text.resize(op.width, text.height);
      } else {
        text.textAutoResize = "WIDTH_AND_HEIGHT";
      }
      if (op.x !== undefined) text.x = op.x;
      if (op.y !== undefined) text.y = op.y;

      return register(ctx, op.id, text, index, op.type);
    }

    case "createVector": {
      const parent = await resolveParent(ctx, op.parent, index, op.type);
      const node = figma.createVector();
      node.name = op.name ?? "Vector";

      // Bezier-preserving pipeline: C/Q handles survive to the VectorNode.
      // Arc-bearing paths fall back to the flattened pipeline (correct, denser).
      const winding = op.windingRule ?? "NONE";
      if (hasArcCommand(op.path)) {
        const parsed = parseSvgPath(op.path);
        const vectorPaths: VectorPath[] = [{ ...toVectorPathData(parsed.winding), windingRule: winding }];
        for (const region of parsed.regions) {
          vectorPaths.push({ windingRule: "EVENODD", data: toVectorPathData(region).data });
        }
        node.vectorPaths = vectorPaths;
      } else {
        node.vectorPaths = toBezierVectorPaths(op.path, winding);
      }

      parent.appendChild(node);

      node.strokes = [solid(op.stroke ?? "#000000")];
      node.strokeWeight = op.strokeWeight ?? 1;
      if (op.strokeAlign) node.strokeAlign = op.strokeAlign;
      if (op.strokeCap) {
        const cap = op.strokeCap as StrokeCap;
        try {
          node.strokeCap = cap;
        } catch {
          throw new OperationError(`This Figma version does not support stroke cap '${op.strokeCap}'.`, index, op.type);
        }
      }
      if (op.strokeJoin) {
        try {
          (node as VectorNode & { strokeJoin: unknown }).strokeJoin = op.strokeJoin;
        } catch {
          throw new OperationError(`This Figma version does not support stroke join '${op.strokeJoin}'.`, index, op.type);
        }
      }
      if (op.dashPattern !== undefined && op.dashPattern.length > 0) node.dashPattern = op.dashPattern;

      // A connector's arrowheads are closed subpaths in the same path as the
      // line, so the vector needs fills as well as strokes. `fillArrows` keeps
      // this opt-in: filling an ordinary open path would fill its bounding shape.
      if (op.fillArrows) {
        const arrowColor = op.stroke ?? "#000000";
        node.fills = hasAnyPaint(op.fill) ? toPaints(op.fill) : [solid(arrowColor)];
      } else if (op.fill !== undefined) {
        node.fills = toPaints(op.fill);
      }

      if (op.opacity !== undefined) node.opacity = op.opacity;
      if (op.visible !== undefined) node.visible = op.visible;
      if (op.x !== undefined) node.x = op.x;
      if (op.y !== undefined) node.y = op.y;

      return register(ctx, op.id, node, index, op.type);
    }

    case "booleanOperation": {
      const nodes: SceneNode[] = [];
      for (const ref of op.targets) {
        nodes.push(requireScene(await resolve(ctx, ref, index, op.type), index, op.type));
      }
      const firstParent = nodes[0]!.parent;
      for (const n of nodes.slice(1)) {
        if (n.parent !== firstParent) {
          throw new OperationError(
            "All boolean targets must share a parent. Reparent them first, or combine per-parent clusters instead.",
            index,
            op.type,
          );
        }
      }
      const parent: ParentNode = op.parent
        ? await resolveParent(ctx, op.parent, index, op.type)
        : ((firstParent as unknown as ParentNode) ?? figma.currentPage);
      const api = figma as PluginAPI & {
        union?: (nodes: SceneNode[], parent: ParentNode) => BooleanOperationNode;
        subtract?: (nodes: SceneNode[], parent: ParentNode) => BooleanOperationNode;
        intersect?: (nodes: SceneNode[], parent: ParentNode) => BooleanOperationNode;
        exclude?: (nodes: SceneNode[], parent: ParentNode) => BooleanOperationNode;
      };
      const fn = op.operation === "union" ? api.union : op.operation === "subtract" ? api.subtract : op.operation === "intersect" ? api.intersect : api.exclude;
      if (typeof fn !== "function") {
        throw new OperationError(`This Figma version does not expose boolean '${op.operation}'.`, index, op.type);
      }
      const result = fn.bind(figma)(nodes, parent);
      result.name = op.name ?? `${op.operation} ${nodes.length}`;
      return register(ctx, op.id, result, index, op.type);
    }

    case "outlineStroke": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("outlineStroke" in node) || typeof (node as VectorNode).outlineStroke !== "function") {
        throw new OperationError(`${node.type} does not support outlineStroke in this Figma version.`, index, op.type);
      }
      const outlined = (node as VectorNode).outlineStroke();
      if (!outlined) {
        throw new OperationError("outlineStroke produced no geometry: the node may have no stroke.", index, op.type);
      }
      if (op.name !== undefined) outlined.name = op.name;
      return register(ctx, op.id, outlined, index, op.type);
    }

    case "setVectorPath": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (node.type !== "VECTOR") {
        throw new OperationError(`setVectorPath requires a VECTOR node, got ${node.type}`, index, op.type);
      }
      const winding = op.windingRule ?? "NONE";
      if (hasArcCommand(op.path)) {
        const parsed = parseSvgPath(op.path);
        const vectorPaths: VectorPath[] = [{ ...toVectorPathData(parsed.winding), windingRule: winding }];
        for (const region of parsed.regions) {
          vectorPaths.push({ windingRule: "EVENODD", data: toVectorPathData(region).data });
        }
        (node as VectorNode).vectorPaths = vectorPaths;
      } else {
        (node as VectorNode).vectorPaths = toBezierVectorPaths(op.path, winding);
      }
      return node.id;
    }

    case "mirrorNode": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (op.axis === "vertical") {
        node.relativeTransform = [
          [-1, 0, node.x * 2 + node.width],
          [0, 1, 0],
        ] as unknown as typeof node.relativeTransform;
      } else {
        node.relativeTransform = [
          [1, 0, 0],
          [0, -1, node.y * 2 + node.height],
        ] as unknown as typeof node.relativeTransform;
      }
      return node.id;
    }

    case "setLayoutGrid": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("layoutGrids" in node)) {
        throw new OperationError(`${node.type} does not support layout grids. Target a frame or component.`, index, op.type);
      }
      let color: RGBA | undefined;
      if (op.color !== undefined) {
        try {
          const c = parseColor(op.color);
          color = { r: c.r, g: c.g, b: c.b, a: c.a };
        } catch {
          throw new OperationError(`Unrecognized grid color: ${op.color}. Use #RRGGBB.`, index, op.type);
        }
      }
      const holder = node as SceneNode & { layoutGrids: LayoutGrid[] };
      const grid: LayoutGrid =
        op.pattern === "GRID"
          ? {
              pattern: "GRID",
              sectionSize: op.sectionSize ?? 8,
              visible: op.visible,
              ...(color !== undefined ? { color } : {}),
            }
          : {
              pattern: op.pattern,
              alignment: "STRETCH",
              gutterSize: op.gutter,
              count: op.count,
              ...(op.offset !== undefined ? { offset: op.offset } : {}),
              visible: op.visible,
              ...(color !== undefined ? { color } : {}),
            };
      holder.layoutGrids = [...(holder.layoutGrids ?? []), grid];
      return `${op.pattern} x${op.count}`;
    }

    case "createSlide": {
      // Slides only exist in Figma Slides. The manifest declares both editors,
      // but a design file has no slide grid, so this fails loudly rather than
      // creating a broken frame-shaped thing in the wrong product.
      if (figma.editorType !== "slides") {
        throw new OperationError(
          `createSlide needs Figma Slides, but this file is open in '${figma.editorType}'. Open a Slides deck (or a file whose editor supports slides) and retry.`,
          index,
          op.type,
        );
      }
      if (typeof figma.createSlide !== "function") {
        throw new OperationError("This Figma version does not expose figma.createSlide.", index, op.type);
      }

      const slide = op.row !== undefined || op.col !== undefined ? figma.createSlide(op.row ?? 0, op.col ?? 0) : figma.createSlide();
      slide.name = op.name ?? "Slide";

      // The background is a real fill on the slide, not a stacked rectangle, so
      // re-running a program updates it instead of piling up layers.
      if (op.background !== undefined) slide.fills = toPaints(op.background);
      applySlideNotes(slide, op.notes);
      if (op.skipped !== undefined) slide.isSkippedSlide = op.skipped;

      return register(ctx, op.id, slide, index, op.type);
    }

    /* ------------------------- variables and styles ------------------- */

    case "bindVariable": {
      const target = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      const variable = await resolveVariable(op.variable, op.collection, index, op.type);

      // A uniform radius binds all four corners. Binding one corner would leave
      // a rectangle with three frozen radii and one live one.
      const fields: string[] =
        op.field === "cornerRadius" ? ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"] : [op.field];

      for (const field of fields) {
        try {
          (target as SceneNode & { setBoundVariable: (field: string, variable: Variable | null) => void }).setBoundVariable(field, variable);
        } catch (error) {
          throw new OperationError(
            `Cannot bind ${op.field} on ${target.type} to variable '${op.variable}': ${(error as Error).message}`,
            index,
            op.type,
          );
        }
      }

      return target.id;
    }

    case "createVariable": {
      // Variables are looked up by name and created on demand, so re-running a
      // program updates the existing token instead of producing "space/md" and
      // "space/md 2" in the file.
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const collection = ensureVariableCollection(op.collection ?? "Design Agent", collections);
      const primary = collection.modes[0]?.modeId;
      if (primary === undefined) throw new Error(`Variable collection '${collection.name}' has no modes.`);

      const existing = findVariable(collection, op.name);
      const resolvedType =
        op.variableType === "color" ? "COLOR" : op.variableType === "number" ? "FLOAT" : op.variableType === "string" ? "STRING" : "BOOLEAN";
      // The real API takes a collection *id*, not the collection object. Passing
      // the object worked only against the test mock; on a real file it throws.
      const variable = existing ?? figma.variables.createVariable(op.name, collection.id, resolvedType);

      if (op.description !== undefined) variable.description = op.description;
      if (op.scopes !== undefined) {
        // Scopes are string constants in the Figma API; the schema's enum keeps
        // model input inside that set, so the widening is safe.
        variable.scopes = op.scopes as unknown as VariableScope[];
      }

      for (const [modeName, value] of Object.entries(op.values)) {
        const modeId = modeName === "default" || modeName === "" ? primary : ensureMode(collection, modeName);
        variable.setValueForMode(modeId, coerceVariableValue(value, op.variableType));
      }

      return registerId(ctx, op.id, variable.id);
    }

    case "createTextStyle": {
      const preferred = weightToStyleName(op.weight);
      const styleName = await resolveWeightStyle(op.family, op.weight, preferred);
      const font = await loadFont(op.family, styleName);

      const styles = await figma.getLocalTextStylesAsync();
      const style = styles.find((s) => s.name === op.name) ?? figma.createTextStyle();

      style.name = op.name;
      style.fontName = font;
      style.fontSize = op.fontSize;
      if (op.lineHeight !== undefined) style.lineHeight = { value: op.lineHeight, unit: "PIXELS" };
      if (op.letterSpacing !== undefined) style.letterSpacing = { value: op.letterSpacing, unit: "PIXELS" };
      applyTextStylePaints(style, op.fill);

      return registerId(ctx, op.id, style.id);
    }

    case "createPaintStyle": {
      const styles = await figma.getLocalPaintStylesAsync();
      const style = styles.find((s) => s.name === op.name) ?? figma.createPaintStyle();

      style.name = op.name;
      const c = parseColor(op.color);
      style.paints = [{ type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: op.opacity }];

      return registerId(ctx, op.id, style.id);
    }

    case "cloneNode": {
      const source = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      const copy = source.clone();
      const parent: ParentNode = op.parent
        ? await resolveParent(ctx, op.parent, index, op.type)
        : ((copy.parent as unknown as ParentNode) ?? figma.currentPage);
      parent.appendChild(copy);
      if (op.name !== undefined) copy.name = op.name;
      if (op.x !== undefined) copy.x = op.x;
      if (op.y !== undefined) copy.y = op.y;

      return register(ctx, op.id, copy, index, op.type);
    }

    case "createGroup": {
      const kids: SceneNode[] = [];
      for (const ref of op.children) {
        kids.push(requireScene(await resolve(ctx, ref, index, op.type), index, op.type));
      }
      const firstParent = kids[0]!.parent;
      for (const kid of kids.slice(1)) {
        if (kid.parent !== firstParent) {
          throw new OperationError(
            "All grouped nodes must share a parent. Reparent them first, or group per-parent clusters instead.",
            index,
            op.type,
          );
        }
      }

      const group = figma.group(
        kids,
        (op.parent ? await resolveParent(ctx, op.parent, index, op.type) : (firstParent as unknown as ParentNode)) ?? figma.currentPage,
      );
      group.name = op.name ?? "Group";
      return register(ctx, op.id, group, index, op.type);
    }

    case "setEffect": {
      const target = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("effects" in target)) {
        throw new OperationError(`${target.type} nodes do not support effects.`, index, op.type);
      }

      const c = parseColor(op.color);
      const paint = { r: c.r, g: c.g, b: c.b, a: op.opacity };
      const effect =
        op.effect === "blur"
          ? { type: "LAYER_BLUR", radius: op.radius, visible: true }
          : {
              type: op.effect === "inner-shadow" ? "INNER_SHADOW" : "DROP_SHADOW",
              color: paint,
              offset: { x: op.offsetX, y: op.offsetY },
              radius: op.radius,
              spread: op.effect === "inner-shadow" ? 0 : op.spread,
              visible: true,
              blendMode: "NORMAL",
            };

      (target as SceneNode & { effects: unknown }).effects = [effect];
      return target.id;
    }

    case "prototypeLink": {
      const from = requireScene(await resolve(ctx, op.from, index, op.type), index, op.type);
      const to = requireScene(await resolve(ctx, op.to, index, op.type), index, op.type);

      const reactive = from as SceneNode & {
        reactions?: readonly unknown[];
        setReactionsAsync?: (reactions: unknown[]) => Promise<void>;
      };
      if (typeof reactive.setReactionsAsync !== "function") {
        throw new OperationError(`${from.type} nodes cannot carry prototype interactions.`, index, op.type);
      }

      const transition =
        op.transition === "none"
          ? null
          : op.transition === "smart-animate"
            ? { type: "SMART_ANIMATE", easing: { type: "EASE_IN_AND_OUT", duration: 300 } }
            : { type: "DISSOLVE", easing: { type: "EASE_IN", duration: 200 } };

      // Append, never replace: a flow added by the agent must not destroy
      // hand-built prototyping already on the node.
      const existing = Array.isArray(reactive.reactions) ? [...reactive.reactions] : [];
      await reactive.setReactionsAsync([
        ...existing,
        {
          trigger: { type: op.trigger },
          actions: [{ type: "NODE", destinationId: to.id, navigation: "NAVIGATE", transition }],
        },
      ]);

      return from.id;
    }

    /* ------------------------------ mutate ------------------------------ */
    case "renameNode": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      node.name = op.name;
      return `-> ${op.name}`;
    }

    case "setVariant": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (node.type !== "INSTANCE") {
        throw new OperationError(`setVariant target must be an INSTANCE. Got ${node.type}`, index, op.type);
      }
      const instance = node as InstanceNode;
      // We need to merge with existing properties
      const newProps: { [propertyName: string]: string | boolean | VariableAlias } = {};
      for (const [k, prop] of Object.entries(instance.componentProperties)) {
         if (prop.value !== undefined && typeof prop.value !== "object") {
            newProps[k] = prop.value as string | boolean;
         }
      }
      for (const [k, v] of Object.entries(op.variant)) {
        newProps[k] = String(v);
      }
      instance.setProperties(newProps);
      return instance.id;
    }

    case "setPosition": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (op.x !== undefined) node.x = op.x;
      if (op.y !== undefined) node.y = op.y;
      return `x=${op.x ?? node.x} y=${op.y ?? node.y}`;
    }

    case "setSize": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("resize" in node)) {
        throw new OperationError(`${node.type} cannot be resized`, index, op.type);
      }
      if (op.ignoreAutoLayout) {
        if ("minWidth" in node) (node as FrameNode).minWidth = 0;
        if ("maxWidth" in node) (node as FrameNode).maxWidth = null;
        if ("minHeight" in node) (node as FrameNode).minHeight = 0;
        if ("maxHeight" in node) (node as FrameNode).maxHeight = null;
      }
      node.resize(op.width ?? node.width, op.height ?? node.height);
      return `${op.width ?? node.width}x${op.height ?? node.height}`;
    }

    case "setFill": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("fills" in node)) {
        throw new OperationError(`${node.type} does not support fills`, index, op.type);
      }
      node.fills = toPaints(op.fill) as typeof node.fills;
      return JSON.stringify(op.fill);
    }

    case "setStroke": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("strokes" in node)) {
        throw new OperationError(`${node.type} does not support strokes`, index, op.type);
      }
      node.strokes = [solid(op.color)];
      const weight = op.weight ?? 1;
      node.strokeWeight = weight;
      if (op.align) node.strokeAlign = op.align;
      if (op.dashPattern) node.dashPattern = op.dashPattern;
      return `${op.color} w=${weight}`;
    }

    case "setOpacity": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("opacity" in node)) {
        throw new OperationError(`${node.type} does not support opacity`, index, op.type);
      }
      node.opacity = op.opacity;
      return String(op.opacity);
    }

    case "setCornerRadius": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      applyRadius(node, op.radius);
      return typeof op.radius === "number" ? String(op.radius) : "per-corner";
    }

    case "appendChild": {
      const parent = await resolveParent(ctx, op.parent, index, op.type);
      const child = await resolve(ctx, op.child, index, op.type);
      if (!("appendChild" in child)) {
        throw new OperationError(`${child.type} cannot be a child node`, index, op.type);
      }
      if (parent.id === child.id) {
        throw new OperationError("Cannot append a node to itself", index, op.type);
      }
      // Guard against reparenting a node into its own descendant.
      let ancestor: BaseNode | null = parent;
      while (ancestor) {
        if (ancestor.id === child.id) {
          throw new OperationError("Cannot append a node to its own descendant", index, op.type);
        }
        ancestor = "parent" in ancestor && ancestor.parent ? ancestor.parent : null;
      }

      if (op.index !== undefined) parent.insertChild(Math.min(op.index, parent.children.length), child as never);
      else parent.appendChild(child as never);
      return `${child.id} -> ${parent.id}`;
    }

    case "removeNode": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      node.remove();
      return "removed";
    }

    case "setAutoLayout": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("layoutMode" in node)) {
        throw new OperationError(`${node.type} does not support auto layout`, index, op.type);
      }
      node.layoutMode = op.mode;
      if (op.itemSpacing !== undefined && "itemSpacing" in node) node.itemSpacing = op.itemSpacing;
      if (op.padding !== undefined && "paddingTop" in node) {
        const [t, r, b, l] = four(op.padding);
        node.paddingTop = t;
        node.paddingRight = r;
        node.paddingBottom = b;
        node.paddingLeft = l;
      }
      if (op.primaryAxisAlignItems && "primaryAxisAlignItems" in node) {
        node.primaryAxisAlignItems = op.primaryAxisAlignItems;
      }
      if (op.counterAxisAlignItems && "counterAxisAlignItems" in node) {
        node.counterAxisAlignItems = op.counterAxisAlignItems;
      }
      if (op.layoutWrap !== undefined && "layoutWrap" in node) node.layoutWrap = op.layoutWrap;
      return op.mode;
    }

    case "setPadding": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("paddingTop" in node)) {
        throw new OperationError(`${node.type} does not support padding`, index, op.type);
      }
      const [t, r, b, l] = four(op.padding);
      node.paddingTop = t;
      node.paddingRight = r;
      node.paddingBottom = b;
      node.paddingLeft = l;
      return `${t} ${r} ${b} ${l}`;
    }

    case "setGap": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("itemSpacing" in node)) {
        throw new OperationError(`${node.type} does not support item spacing`, index, op.type);
      }
      node.itemSpacing = op.gap;
      return String(op.gap);
    }

    case "setTypography": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (node.type !== "TEXT") {
        throw new OperationError(`setTypography requires a TEXT node, got ${node.type}`, index, op.type);
      }
      const text = node as TextNode;
      const current = text.fontName === figma.mixed ? null : text.fontName;
      const family = op.family ?? current?.family;
      const style = op.style ?? current?.style ?? "Regular";
      if (!family) {
        throw new OperationError("Cannot resolve font family for this text node", index, op.type);
      }
      text.fontName = await loadFont(family, style);
      if (op.fontSize !== undefined) text.fontSize = op.fontSize;
      if (op.lineHeight !== undefined) text.lineHeight = { value: op.lineHeight, unit: "PIXELS" };
      if (op.letterSpacing !== undefined) text.letterSpacing = { value: op.letterSpacing, unit: "PIXELS" };
      if (op.textAlignHorizontal) text.textAlignHorizontal = op.textAlignHorizontal;
      if (op.textAlignVertical) text.textAlignVertical = op.textAlignVertical;
      return `${family} ${style} ${op.fontSize ?? ""}`;
    }

    case "setTextContent": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (node.type !== "TEXT") {
        throw new OperationError(`setTextContent requires a TEXT node, got ${node.type}`, index, op.type);
      }
      const text = node as TextNode;
      if (text.fontName === figma.mixed) {
        throw new OperationError("Cannot set characters on text with mixed fonts", index, op.type);
      }
      await loadFont(text.fontName.family, text.fontName.style);
      text.characters = op.content;
      return `"${op.content.slice(0, 32)}"`;
    }

    case "setVisible": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      node.visible = op.visible;
      return String(op.visible);
    }

    case "setPage": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      await figma.loadAllPagesAsync();
      let page: PageNode | undefined;
      if (op.page) {
        page = figma.root.children.find((p) => p.id === op.page || p.name === op.page);
        if (!page) throw new OperationError(`Page not found: ${op.page}`, index, op.type);
      } else {
        page = figma.currentPage;
      }
      page.appendChild(node);
      return `-> ${page.name}`;
    }

    case "setConstraints": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("constraints" in node)) {
        throw new OperationError(`${node.type} does not support constraints`, index, op.type);
      }
      if (op.horizontal === undefined && op.vertical === undefined) {
        throw new OperationError("setConstraints needs at least one of horizontal or vertical", index, op.type);
      }
      const current = node.constraints;
      // Constraints is readonly as a whole, so this is a deliberate widening:
      // the Figma schema is authoritative at runtime.
      (node as SceneNode & { constraints: Constraints }).constraints = {
        horizontal: op.horizontal ?? current.horizontal,
        vertical: op.vertical ?? current.vertical,
      };
      return `${op.horizontal ?? current.horizontal}/${op.vertical ?? current.vertical}`;
    }

    default: {
      // Exhaustiveness guard: adding a case to the union without a handler
      // becomes a compile error here, not a silent no-op at runtime.
      const unhandled: never = op;
      throw new OperationError(`Unhandled operation type: ${JSON.stringify(unhandled)}`, index, "unknown");
    }
  }
}

function register(ctx: Ctx, tempId: string | undefined, node: SceneNode, index: number, opType: string): string {
  if (ctx.created.length >= MAX_CREATED_NODES) {
    throw new OperationError(`Transaction would create more than ${MAX_CREATED_NODES} nodes`, index, opType);
  }
  if (tempId) {
    if (ctx.ids.has(tempId)) {
      throw new OperationError(`Duplicate temporary id in transaction: ${tempId}`, index, opType);
    }
    ctx.ids.set(tempId, node.id);
  }
  ctx.created.push({
    temporaryId: tempId,
    figmaNodeId: node.id,
    type: node.type,
    name: node.name,
  });
  return `${node.id}${tempId ? ` (${tempId})` : ""}`;
}

function failure(transactionId: string, err: unknown, attempted: boolean): TransactionFailure {
  let rolledBack = false;

  if (attempted) {
    // Revert the partial application using Figma's own undo stack, then re-seal
    // so the rollback is not itself undoable garbage.
    try {
      figma.triggerUndo();
      figma.commitUndo();
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
  }

  const isOpError = err instanceof OperationError;
  const raw = err instanceof Error ? err.message : String(err);

  return {
    transactionId,
    status: "failed",
    error: {
      operation: isOpError ? err.operationIndex : -1,
      opType: isOpError ? err.opType : "plan",
      message: raw,
      // Spec §36: what failed, what was rolled back, what to try next.
      hint: hintFor(raw, isOpError ? err.opType : "plan"),
      rolledBackNote: rolledBack
        ? "All earlier operations in this transaction were reverted; the document is unchanged."
        : "Nothing was committed, so the document is unchanged.",
    },
    rolledBack,
  };
}

/**
 * Turn a raw failure into an actionable next step.
 *
 * A bare "node not found" tells the model nothing it can act on; naming the
 * likely cause lets it either inspect first or correct the reference.
 */
function hintFor(message: string, opType: string): string {
  const m = message;

  if (/Node not found/i.test(m)) {
    return "Call inspect_selection or inspect_file to get current node ids. Reference ids that exist rather than guessing, and never reuse ids from a previous transaction after a rollback.";
  }
  if (/Temporary id|duplicate temporary/i.test(m)) {
    return "Each create operation needs its own unique `id`. Reuse the same id to reference the node from later operations.";
  }
  if (/Font .* is not available/i.test(m)) {
    return "Use a font installed on the machine running the Figma desktop app. Call inspect_design_system and reuse a family it already reports.";
  }
  if (/mixed fonts/i.test(m)) {
    return "Split the text so each node uses one font, or set the font family explicitly with setTypography before editing characters.";
  }
  if (/Invalid operation/i.test(m)) {
    return "One operation failed schema validation. Check the operation type and field names against the create_design schema description.";
  }
  if (/Cannot append/i.test(m)) {
    return "appendChild cannot create a cycle. Make sure the child is not an ancestor of the parent.";
  }
  if (/does not support/i.test(m)) {
    return `The target node type does not support that property. Inspect it first and use an operation that matches its node type, or convert it with a supported operation. (operation: ${opType})`;
  }
  if (/Page not found/i.test(m)) {
    return "Call inspect_file to list the real page names, then use one of them exactly.";
  }
  if (/more than \d+ nodes/i.test(m)) {
    return "Split the work into several smaller transactions.";
  }

  return "Inspect the target nodes first, then retry with corrected arguments. Use dryRun=true to validate without changing the document.";
}

/* -------------------------------------------------------------------------- */
/* Undo                                                                        */
/* -------------------------------------------------------------------------- */

export interface UndoResult {
  status: "success" | "failed";
  message: string;
}

/**
 * Undo the last committed transaction. We rely on Figma's native undo stack,
 * which is why runTransaction seals a batch with commitUndo() on both sides.
 */
export function undoLastOperation(): UndoResult {
  try {
    figma.triggerUndo();
    figma.commitUndo();
    return { status: "success", message: "Reverted the last committed design transaction." };
  } catch (err) {
    return {
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}