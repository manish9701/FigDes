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
  type RollbackStatus,
  type TransactionFailure,
  type TransactionResult,
  type TransactionTimings,
} from "../../shared/protocol";
import { parseSvgPath, parseVectorSegments, segmentsToPathData } from "../../shared/path";

const MAX_CREATED_NODES = 500;

/** Applied-trace lines returned per transaction; the rest is summarized. */
const APPLIED_TRACE_CAP = 300;

/**
 * How often the apply loop hands control back so the canvas can repaint.
 *
 * ~60Hz. Repaints are perceptible at this rate, so a slower cadence would make
 * the build look like it stutters rather than fill in smoothly — and a faster
 * one only buys task switches nobody can see.
 */
const PAINT_INTERVAL_MS = 16;

/**
 * Idempotency + cancellation for the semantic transaction path.
 *
 * The server dedupes by transactionId, but a server-side timeout used to mean
 * a same-id retry executed the whole plan a second time on the plugin — which
 * is how timed-out batches duplicated nodes when the first run committed
 * late. The plugin now keeps the last N *successful* results keyed by
 * transactionId: a retry with the same id returns the prior success without
 * touching the document. Failures are NOT cached (a fully rolled-back plan is
 * safe to re-run), which keeps the retry path open.
 *
 * Cancellation is cooperative: the main thread cannot be pre-empted
 * mid-`await`, so a cancel request sets a flag the run loop checks between
 * operations. The in-flight op finishes, then the transaction aborts into the
 * normal journaled rollback — the same path as any other failure, so a
 * cancelled batch reports rolled-back/partial instead of committing late.
 */
const TRANSACTION_CACHE_CAP = 50;
const SETTLED_CAP = 100;
const transactionResults = new Map<string, TransactionResult>();
const cancelledTransactions = new Set<string>();
/**
 * Ids that already reached a terminal state (committed or rolled back).
 *
 * Without this a cancel arriving *after* a transaction finished used to arm a
 * flag nothing would ever consume, and the very same-id retry the server tells
 * the model to perform would abort at operation 0 saying "cancelled". A timeout
 * that lands late therefore locked out the only safe recovery path.
 */
const settledTransactions = new Set<string>();

function rememberSettled(transactionId: string): void {
  if (!transactionId) return;
  settledTransactions.add(transactionId);
  if (settledTransactions.size > SETTLED_CAP) {
    const first = settledTransactions.values().next().value;
    if (first) settledTransactions.delete(first);
  }
}

/** Mark a transaction as cancelled. The run loop aborts between operations and rolls back. */
export function cancelTransaction(transactionId: string): boolean {
  if (!transactionId) return false;
  if (transactionResults.has(transactionId)) return false;
  // A cancel for a transaction that already finished is a late timeout, not an
  // instruction: refuse it so it cannot poison the next same-id retry.
  if (settledTransactions.has(transactionId)) return false;
  cancelledTransactions.add(transactionId);
  return true;
}

export function isTransactionCancelled(transactionId: string): boolean {
  return cancelledTransactions.has(transactionId);
}

function takeCancellation(transactionId: string): boolean {
  if (cancelledTransactions.has(transactionId)) {
    cancelledTransactions.delete(transactionId);
    return true;
  }
  return false;
}

function cacheTransactionResult(transactionId: string, result: TransactionResult): void {
  if (!transactionId || result.status !== "success" || result.dryRun) return;
  transactionResults.set(transactionId, result);
  if (transactionResults.size > TRANSACTION_CACHE_CAP) {
    const first = transactionResults.keys().next().value;
    if (first) transactionResults.delete(first);
  }
}

export function getCachedTransactionResult(transactionId: string): TransactionResult | undefined {
  return transactionResults.get(transactionId);
}

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
 * Cached font catalogue.
 *
 * `listAvailableFontsAsync` is the slowest call in a text-heavy build: the
 * previous code called it once per text node (via resolveWeightStyle) plus
 * once per fallback in loadFont. A 100-text screen therefore scanned the
 * installed fonts 100+ times before drawing anything, which is a large part
 * of why big builds felt stalled. Cache the list once per plugin session.
 */
let availableFontsCache: ReadonlyArray<Font> | null = null;
async function availableFonts(): Promise<ReadonlyArray<Font>> {
  if (availableFontsCache) return availableFontsCache;
  try {
    availableFontsCache = await figma.listAvailableFontsAsync();
  } catch {
    availableFontsCache = [];
  }
  return availableFontsCache;
}

/**
 * Text typography requires the font to be loaded before the property is set.
 * A missing family is reported, never silently substituted — otherwise the
 * model believes it applied a brand font when it did not.
 */
export async function loadFont(family: string, style: string): Promise<FontName> {
  const key = `${family}::${style}`;
  const cached = fontCache.get(key);
  if (cached) return cached;

  try {
    await figma.loadFontAsync({ family, style });
  } catch {
    const available = await availableFonts();
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

  const available = await availableFonts();
  if (available.length === 0) return candidates[0]!;

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
  /** Pre-mutation journal for P0 truthful rollback (prior values per node). */
  journal: JournalEntry[];
  /** In-transaction node-handle cache: real id -> node (P1 hot-path). */
  nodeCache: Map<string, BaseNode | null>;
  cacheHits: number;
  cacheMisses: number;
}

/**
 * One journaled mutation against a pre-existing node.
 *
 * `before` holds plain-data prior values read BEFORE the mutation. `kind`
 * selects the restore path; `extra` carries reparent anchors (parent id +
 * index) and removed-node references for remove/reparent cases.
 */
interface JournalEntry {
  figmaNodeId: string;
  opIndex: number;
  opType: string;
  kind: string;
  before: Record<string, unknown>;
  parentId?: string;
  parentIndex?: number;
  nodeRef?: BaseNode;
  childrenBefore?: Array<{ id: string; parentId: string; index: number }>;
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

function invalidateCache(ctx: Ctx, ...realIds: string[]): void {
  for (const id of realIds) ctx.nodeCache.delete(id);
}

async function resolve(ctx: Ctx, ref: string, index: number, opType: string): Promise<BaseNode> {
  const id = ctx.ids.get(ref) ?? ref;
  if (ctx.nodeCache.has(id)) {
    const cached = ctx.nodeCache.get(id);
    if (cached) {
      try {
        if (!(cached as { removed?: boolean }).removed) {
          ctx.cacheHits += 1;
          return cached;
        }
      } catch {
        /* fall through to live lookup */
      }
      ctx.nodeCache.delete(id);
    } else {
      ctx.cacheHits += 1;
      throw new OperationError(`Node not found: ${ref}`, index, opType);
    }
  }
  let node: BaseNode | null = null;
  try {
    node = await figma.getNodeByIdAsync(id);
  } catch {
    node = null;
  }
  ctx.cacheMisses += 1;
  ctx.nodeCache.set(id, node);
  // A removed node is a missing node. The cached path above already treats it as
  // one; without this the live path returned it, so whether a reference to a
  // node that disappeared earlier in the same transaction resolved depended on
  // whether the cache happened to hold it. That is failure-injection case 8
  // ("parent disappears during execution") silently passing.
  if (!node || (node as { removed?: boolean }).removed) {
    ctx.nodeCache.delete(id);
    throw new OperationError(`Node not found: ${ref}`, index, opType);
  }
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
/* Mutation journal (P0 truthful rollback)                                     */
/* -------------------------------------------------------------------------- */

function childIndex(node: BaseNode): number {
  try {
    const parent = (node as { parent?: { children?: unknown[] } | null }).parent;
    if (!parent || !Array.isArray(parent.children)) return -1;
    return parent.children.indexOf(node as never);
  } catch {
    return -1;
  }
}

function readProp(node: unknown, key: string): unknown {
  try {
    return (node as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function clonePaints(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return value;
  }
}

/** Record prior values BEFORE mutating an existing node. Never throws. */
function journal(ctx: Ctx, entry: JournalEntry): void {
  try {
    ctx.journal.push(entry);
  } catch {
    /* journaling must never fail a build */
  }
}

function journalProps(ctx: Ctx, node: BaseNode, index: number, opType: string, kind: string, keys: string[]): void {
  const before: Record<string, unknown> = {};
  for (const k of keys) {
    const v = readProp(node, k);
    try {
      before[k] = JSON.parse(JSON.stringify(v ?? null));
    } catch {
      before[k] = v as unknown;
    }
  }
  journal(ctx, { figmaNodeId: node.id, opIndex: index, opType, kind, before });
}

function journalReparent(
  ctx: Ctx,
  node: BaseNode,
  index: number,
  opType: string,
  kind: string,
  extraBefore: Record<string, unknown> = {},
): void {
  const parent = (node as { parent?: BaseNode | null }).parent;
  journal(ctx, {
    figmaNodeId: node.id,
    opIndex: index,
    opType,
    kind,
    before: extraBefore,
    parentId: parent ? parent.id : undefined,
    parentIndex: childIndex(node),
    nodeRef: node,
  });
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
 * Per-operation watchdog.
 *
 * A single hung Figma call (a font or image load that never settles) wedged
 * the whole transaction until the 5-minute iframe budget fired: 10 ops
 * applied, zero progress frames, then a blind rollback with no cause named.
 * Racing each op against a generous budget fails fast and names the stuck
 * operation instead.
 *
 * The race cannot abort the underlying Figma call, so a late settlement lands
 * under the normal rollback path — the same guarantee as a server cancel.
 */
const PER_OP_WATCHDOG_MS = 60_000;
/**
 * Test-only override for the watchdog budget, read at call time.
 *
 * The mock harness sets `globalThis.__FIGDES_PER_OP_WATCHDOG_MS__` to prove
 * the stall path without waiting out the production 60s. Production never
 * sets it, so the budget is constant there.
 */
function perOpWatchdogMs(): number {
  const override = (globalThis as { __FIGDES_PER_OP_WATCHDOG_MS__?: unknown }).__FIGDES_PER_OP_WATCHDOG_MS__;
  return typeof override === "number" && override > 0 ? override : PER_OP_WATCHDOG_MS;
}
async function applyWithWatchdog(ctx: Ctx, op: Parsed, index: number): Promise<string> {
  const budget = perOpWatchdogMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new OperationError(
          `Operation #${index} (${op.type}) produced no result within ${budget / 1000}s — the Figma call is hung (often a font or image load that never resolves). Nothing after this operation ran; the transaction rolls back. Retry with the SAME transactionId; if the same operation hangs again, simplify or split it (dryRun first to validate).`,
          index,
          op.type,
        ),
      );
    }, budget);
  });
  try {
    return await Promise.race([apply(ctx, op, index), watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const t0 = Date.now();
  let parsed: Parsed[];

  try {
    parsed = parseAll(input.operations);
  } catch (err) {
    return failure(input.transactionId, err, false);
  }
  const parseMs = Date.now() - t0;

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

  // Idempotent retry: a same-id re-dispatch after a server timeout must not
  // execute the plan twice. Successes are cached; failures roll back and stay
  // re-runnable, so only successes short-circuit here.
  const cached = getCachedTransactionResult(input.transactionId);
  if (cached) return cached;
  // A cancel that arrived before the first op still counts: abort into the
  // normal rollback path (nothing committed → "nothing was committed").
  if (isTransactionCancelled(input.transactionId)) {
    takeCancellation(input.transactionId);
    return failure(
      input.transactionId,
      new OperationError(
        `Transaction ${input.transactionId} was cancelled before it started (server timeout). Nothing was committed; retry with the SAME transactionId after checking get_job_status.`,
        -1,
        "cancelled",
      ),
      false,
    );
  }

  const ctx: Ctx = {
    ids: new Map(),
    created: [],
    modified: new Set(),
    currentPageId: figma.currentPage.id,
    isDryRun: false,
    journal: [],
    nodeCache: new Map(),
    cacheHits: 0,
    cacheMisses: 0,
  };

  const applied: string[] = [];
  const perOperation: Array<{ index: number; opType: string; ms: number }> = [];
  const pass1 = parsed.filter(isCreateOp);
  const pass2 = parsed.filter((op) => !isCreateOp(op));

  // Seal prior document state so this transaction becomes one undo step.
  try {
    figma.commitUndo();
  } catch {
    /* commitUndo is best-effort */
  }

  const applyT0 = Date.now();
  // Paint cadence accounting, declared out here so the reported timings can
  // separate "time spent applying" from "time spent waiting to be allowed to
  // paint" — the distinction that made this stage's real cost invisible.
  let yieldCount = 0;
  let yieldMs = 0;
  try {
    const ordered = [...pass1, ...pass2];
    const total = ordered.length;
    // Pinned once: the first container scrolls the viewport to the build site
    // while it is still empty, so the user watches regions fill in rather
    // than staring at a blank area until the final reveal.
    let pinned = false;
    let lastYieldAt = Date.now();

    for (let n = 0; n < ordered.length; n++) {
      // Cooperative cancellation: the server's timeout fires outside this
      // runner while a native op is stalled, so the only safe stop is here,
      // between ops. The in-flight op finishes, then we abort into the normal
      // journaled rollback instead of committing the tail late.
      if (isTransactionCancelled(input.transactionId)) {
        takeCancellation(input.transactionId);
        throw new OperationError(
          `Transaction ${input.transactionId} was cancelled after ${n}/${total} operations (server timeout). Rolling back the ${n} applied operation(s); the document will hold none of this transaction's partial work if rollback is full — check rolledBack/rollbackStatus, then retry with the SAME transactionId in smaller verified passes.`,
          n < parsed.length ? parsed.indexOf(ordered[n]!) : -1,
          "cancelled",
        );
      }
      const op = ordered[n]!;
      const index = parsed.indexOf(op);
      const opT0 = Date.now();
      // Watchdogged: a hung Figma call fails this op in 60s with its index
      // and type named, instead of wedging the transaction until the 5-minute
      // iframe budget fires with nothing diagnosed.
      const note = await applyWithWatchdog(ctx, op, index);
      perOperation.push({ index, opType: op.type, ms: Date.now() - opT0 });
      if (perOperation.length > 300) perOperation.shift();
      applied.push(`${op.type}${note ? ` ${note}` : ""}`);
      touchRefs(ctx, op);

      if (!pinned && (op.type === "createFrame" || op.type === "createSlide" || op.type === "createComponent")) {
        pinned = true;
        // Viewport only, no selection change: a selection would fire
        // selectionchange and trigger a full panel scan mid-build, while a
        // bare scroll simply lands the user where the work is happening.
        // Not awaited — the build must never wait on the viewport.
        void pinViewport(ctx);
      }

      // Report roughly every 5% (and always the last op) so a 500-op build
      // narrates without flooding the iframe with 500 messages. 10% steps
      // left long builds silent for 30+ seconds, which reads as "stalled".
      const done = n + 1;
      if (input.onProgress && (done === total || done % Math.max(1, Math.floor(total / 20)) === 0)) {
        input.onProgress(done, total, describe(op) || op.type);
      }

      // Yield so the canvas repaints and the panel stays alive. Without this
      // the whole transaction runs synchronously and the user sees nothing
      // until the final commit — the "blank page, then everything pops at
      // once" symptom.
      //
      // The cadence is gated on ELAPSED TIME, not on the operation count, and
      // that distinction is the whole point. A repaint is perceptible at ~60Hz;
      // what the user sees is regions landing on a timer, not once per
      // operation. Gating on op count made the cost scale with batch size
      // instead of with elapsed time, and a task switch is not free: measured
      // against the mock document, `setTimeout(0)` costs ~15ms per yield, so a
      // 51-op build spent 772ms yielding and 15ms actually applying — 98% of
      // the apply stage was waiting to be allowed to paint.
      //
      // Time-gating keeps the visible cadence identical (still ~60Hz) and
      // collapses the task switches to one per paint interval, so the cost now
      // tracks wall-clock rather than batch size. `yieldCount`/`yieldMs` are
      // reported so a live run can verify this instead of taking it on trust.
      //
      // Completed nodes stay on the canvas as they land: nothing here removes
      // or hides earlier work, so progress is cumulative, not flashing.
      if (done === total || Date.now() - lastYieldAt >= PAINT_INTERVAL_MS) {
        const y0 = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 0));
        yieldCount += 1;
        yieldMs += Date.now() - y0;
        lastYieldAt = Date.now();
      }
    }
  } catch (err) {
    // Surgical rollback: journaled mutations are restored first, then created
    // nodes are removed by id. A bare undo here would pop whatever Figma last
    // recorded — after a timeout or interleaving work, that is somebody else's
    // commit. Consume any cancel flag so a same-id retry starts clean.
    takeCancellation(input.transactionId);
    const result = await failure(
      input.transactionId,
      err,
      true,
      ctx.created.map((c) => c.figmaNodeId),
      ctx,
      perOperation,
    );
    rememberSettled(input.transactionId);
    return result;
  }
  const applyMs = Date.now() - applyT0;

  try {
    figma.commitUndo();
  } catch {
    /* ignore */
  }

  // Evidence: committed bounds for everything created, read after the dust
  // settles so auto-layout shifts are included. A node removed later in the
  // same transaction simply carries no bounds rather than failing the report.
  // Anything unresolvable is reported, not hidden: a "success" whose nodes are
  // already gone is how silent partial builds happen.
  const verifyT0 = Date.now();
  const unconfirmedIds: string[] = [];
  // Verify only affected subtrees by default: created nodes plus journaled
  // mutation targets, not a full file scan. Full verification remains
  // available via inspect; the transaction verifies what it touched.
  for (const entry of ctx.created) {
    try {
      const cached = ctx.nodeCache.get(entry.figmaNodeId);
      const node = cached ?? await figma.getNodeByIdAsync(entry.figmaNodeId);
      if (node && "x" in node && "width" in node) {
        const b = node as SceneNode & { x: number; y: number; width: number; height: number };
        entry.bounds = {
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.round(b.width),
          height: Math.round(b.height),
        };
      } else {
        unconfirmedIds.push(entry.figmaNodeId);
      }
    } catch {
      /* gone: no bounds, still reported as created */
      unconfirmedIds.push(entry.figmaNodeId);
    }
  }
  const verifyMs = Date.now() - verifyT0;

  // Reveal: select what was built and bring the viewport to it. Without this
  // the canvas stays where the user left it — often an empty area — so a
  // successful build reads as a "blank page" until they scroll and find it.
  // Best-effort by design: a viewport failure must never fail the build.
  const revealT0 = Date.now();
  await revealCreated(ctx);
  const revealMs = Date.now() - revealT0;

  // The trace is evidence, not a log file: cap it so a 2000-op construction
  // does not flood the model with 2000 lines.
  const trace = applied.length > APPLIED_TRACE_CAP
    ? [...applied.slice(0, APPLIED_TRACE_CAP), `… and ${applied.length - APPLIED_TRACE_CAP} more operations applied.`]
    : applied;

  const totalMs = Date.now() - t0;
  const timings: TransactionTimings = {
    parse: parseMs,
    apply: applyMs,
    verify: verifyMs,
    reveal: revealMs,
    total: totalMs,
    perOperation,
    cache: { hits: ctx.cacheHits, misses: ctx.cacheMisses },
    nodeCount: ctx.created.length + ctx.modified.size,
    operationCount: parsed.length,
    // Paint cadence, separated out. A live run that reports a large apply time
    // can now tell "the operations are slow" from "we are yielding too often",
    // which are opposite fixes.
    yields: { count: yieldCount, ms: yieldMs, intervalMs: PAINT_INTERVAL_MS },
  };

  // Operation budget from measured latency + node count. Warn (never split
  // silently): an atomic user edit stays atomic; the warning names the split
  // point for the next call. Splitting without an explicit undo boundary is
  // how half-committed screens happen.
  const warnings: string[] = [];
  if (parsed.length > 150) {
    warnings.push(
      `Transaction of ${parsed.length} operations took ${totalMs}ms (apply ${applyMs}ms). Split the next build at logical region boundaries into verified passes of ≤150 ops; this transaction stayed atomic and committed as one undo step.`,
    );
  }
  if (ctx.created.length > 300) {
    warnings.push(
      `Created ${ctx.created.length} nodes in one transaction. Prefer region-scoped passes with a render + review between them so a failure cannot orphan hundreds of nodes.`,
    );
  }
  if (unconfirmedIds.length > 0) {
    warnings.push(
      `${unconfirmedIds.length} created node(s) no longer resolve after commit (${unconfirmedIds.slice(0, 5).join(", ")}${unconfirmedIds.length > 5 ? ", …" : ""}). Verify before reporting success.`,
    );
  }

  const success: TransactionResult = {
    transactionId: input.transactionId,
    status: "success",
    dryRun: false,
    createdNodes: ctx.created,
    modifiedNodes: [...ctx.modified],
    applied: trace,
    ...(unconfirmedIds.length > 0
      ? { unconfirmedIds }
      : {}),
    timings,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  takeCancellation(input.transactionId);
  cacheTransactionResult(input.transactionId, success);
  rememberSettled(input.transactionId);
  return success;
}

/**
 * Early viewport pin: scrolls to the first container created, without touching
 * the selection.
 *
 * Called once per transaction, right when structure first exists and details
 * are still landing. The canvas therefore shows the frame appearing and
 * filling in progressively; completed parts stay visible throughout because
 * nothing in the loop removes or hides earlier work.
 */
async function pinViewport(ctx: Ctx): Promise<void> {
  try {
    const entry = ctx.created[ctx.created.length - 1];
    if (!entry) return;
    const node = await figma.getNodeByIdAsync(entry.figmaNodeId).catch(() => null);
    if (!node || node.removed) return;
    if (node.type === "PAGE" || node.type === "DOCUMENT") return;
    try {
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
    } catch {
      /* older API surface: the final reveal still lands the user */
    }
  } catch {
    /* pinning must never fail a build */
  }
}

/**
 * Brings the viewport to what a transaction just built.
 *
 * Selects up to 8 top-level created frames/components (plus any modified
 * targets when nothing was created) and scrolls to them. Slides are skipped
 * for selection — they live in the deck grid, not on a free canvas — but the
 * first slide's page is still surfaced via selection when possible.
 */
async function revealCreated(ctx: Ctx): Promise<void> {
  try {
    const ids: string[] = [];
    for (const entry of ctx.created) {
      if (entry.type === "PAGE" || entry.type === "DOCUMENT") continue;
      // Prefer containers: a root frame tells the user where the screen is,
      // a loose text node does not.
      if (entry.type === "FRAME" || entry.type === "COMPONENT" || entry.type === "INSTANCE" || entry.type === "GROUP" || entry.type === "SLIDE") {
        ids.push(entry.figmaNodeId);
        if (ids.length >= 8) break;
      }
    }
    if (ids.length === 0) {
      for (const id of ctx.modified) {
        ids.push(id);
        if (ids.length >= 8) break;
      }
    }
    if (ids.length === 0) return;

    const scenes: SceneNode[] = [];
    for (const id of ids) {
      try {
        const node = await figma.getNodeByIdAsync(id);
        if (!node || node.removed) continue;
        if (node.type === "PAGE" || node.type === "DOCUMENT") continue;
        scenes.push(node as SceneNode);
      } catch {
        /* gone: skip */
      }
    }
    if (scenes.length === 0) return;

    try {
      figma.currentPage.selection = scenes.slice(0, 8);
    } catch {
      /* selection is a nicety, not a requirement */
    }
    try {
      figma.viewport.scrollAndZoomIntoView(scenes.slice(0, 4));
    } catch {
      /* older API surface: selection alone still lands the user nearby */
    }
  } catch {
    /* reveal must never fail a successful build */
  }
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
    case "setTextStyle":
      return `${op.style}`;
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

      // TEXT property overrides (e.g. the new screen's label on a reused
      // button). Best-effort per key: an unknown property name is skipped
      // rather than failing the whole instance.
      if (op.properties !== undefined) {
        for (const [key, value] of Object.entries(op.properties)) {
          try {
            instance.setProperties({ [key]: value });
          } catch {
            // Skipped: not a TEXT property on this component.
          }
        }
      }

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
      // The file's own text style, when the author named one. Binding the
      // existing style is what keeps a new screen inside the design system
      // instead of drawing its own type beside it.
      if (op.textStyleId !== undefined) {
        try {
          text.textStyleId = op.textStyleId;
        } catch {
          // A missing style is not a reason to fail the whole transaction: the
          // text is still drawn, with the properties the op carried.
        }
      }
      text.fills = toPaints(op.fill ?? [{ color: "#111111", opacity: 1 }]);
      if (op.opacity !== undefined) text.opacity = op.opacity;
      if (op.visible !== undefined) text.visible = op.visible;

      if (op.width !== undefined) {
        // `TRUNCATE` is the deliberate choice for a text that cannot wrap —
        // an identifier, a path, a hash. It keeps the box and cuts the text,
        // so the layout does not move and the reader is told the value is
        // longer than the space it has.
        text.textAutoResize = op.textAutoResize ?? "HEIGHT";
        text.resize(op.width, text.height);
      } else {
        text.textAutoResize = op.textAutoResize ?? "WIDTH_AND_HEIGHT";
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
      // Boolean ops consume their sources: journal them as unrestorable so a
      // later failure reports partial-rollback instead of claiming full.
      for (const n of nodes) {
        journal(ctx, { figmaNodeId: n.id, opIndex: index, opType: op.type, kind: "booleanConsume", before: {} });
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
      journalProps(ctx, node, index, op.type, "setVectorPath", ["vectorPaths"]);
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
      invalidateCache(ctx, node.id);
      return node.id;
    }

    case "mirrorNode": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      journalProps(ctx, node, index, op.type, "mirrorNode", ["relativeTransform", "x", "y"]);
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
      invalidateCache(ctx, node.id);
      return node.id;
    }

    case "setLayoutGrid": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("layoutGrids" in node)) {
        throw new OperationError(`${node.type} does not support layout grids. Target a frame or component.`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setLayoutGrid", ["layoutGrids"]);
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
      invalidateCache(ctx, node.id);
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
      // Journal prior bindings so a later failure can unbind exactly.
      try {
        const prior: Record<string, unknown> = {};
        const reader = target as unknown as { getBoundVariable?: (f: string) => unknown };
        for (const field of fields) {
          prior[field] = typeof reader.getBoundVariable === "function" ? reader.getBoundVariable(field) : null;
        }
        journal(ctx, { figmaNodeId: target.id, opIndex: index, opType: op.type, kind: "bindVariable", before: prior });
      } catch {
        journal(ctx, { figmaNodeId: target.id, opIndex: index, opType: op.type, kind: "bindVariable", before: {} });
      }

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
      // Journal every child's pre-group anchor so rollback can ungroup exactly.
      const childrenBefore = kids.map((kid) => {
        const p = (kid as { parent?: BaseNode | null }).parent;
        return { id: kid.id, parentId: p ? p.id : figma.currentPage.id, index: childIndex(kid) };
      });

      const group = figma.group(
        kids,
        (op.parent ? await resolveParent(ctx, op.parent, index, op.type) : (firstParent as unknown as ParentNode)) ?? figma.currentPage,
      );
      group.name = op.name ?? "Group";
      journal(ctx, { figmaNodeId: group.id, opIndex: index, opType: op.type, kind: "createGroup", before: {}, childrenBefore });
      invalidateCache(ctx, ...kids.map((k) => k.id));
      return register(ctx, op.id, group, index, op.type);
    }

    case "setEffect": {
      const target = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("effects" in target)) {
        throw new OperationError(`${target.type} nodes do not support effects.`, index, op.type);
      }
      journalProps(ctx, target, index, op.type, "setEffect", ["effects"]);

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
      journal(ctx, {
        figmaNodeId: from.id,
        opIndex: index,
        opType: op.type,
        kind: "prototypeLink",
        before: { reactions: Array.isArray(reactive.reactions) ? [...reactive.reactions] : [] },
      });

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
      journalProps(ctx, node, index, op.type, "renameNode", ["name"]);
      node.name = op.name;
      invalidateCache(ctx, node.id);
      return `-> ${op.name}`;
    }

    case "setVariant": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (node.type !== "INSTANCE") {
        throw new OperationError(`setVariant target must be an INSTANCE. Got ${node.type}`, index, op.type);
      }
      const instance = node as InstanceNode;
      try {
        journal(ctx, {
          figmaNodeId: node.id,
          opIndex: index,
          opType: op.type,
          kind: "setVariant",
          before: { componentProperties: JSON.parse(JSON.stringify(instance.componentProperties ?? {})) },
        });
      } catch {
        journal(ctx, { figmaNodeId: node.id, opIndex: index, opType: op.type, kind: "setVariant", before: {} });
      }
      // We need to merge with existing properties
      const newProps: { [propertyName: string]: string | boolean | VariableAlias } = {};
      for (const [k, prop] of Object.entries(instance.componentProperties)) {
        if (prop.value !== undefined && typeof prop.value !== "object") {
          newProps[k] = prop.value as string | boolean;
        }
      }
      for (const [k, v] of Object.entries(op.variant ?? {})) {
        newProps[k] = String(v);
      }
      for (const [k, v] of Object.entries(op.properties ?? {})) {
        newProps[k] = String(v);
      }
      if (Object.keys(op.variant ?? {}).length === 0 && Object.keys(op.properties ?? {}).length === 0) {
        throw new OperationError(`setVariant on ${node.id} changes nothing: give a variant and/or TEXT properties.`, index, op.type);
      }
      instance.setProperties(newProps);
      invalidateCache(ctx, node.id);
      return instance.id;
    }

    case "setPosition": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      journalProps(ctx, node, index, op.type, "setPosition", ["x", "y"]);
      if (op.x !== undefined) node.x = op.x;
      if (op.y !== undefined) node.y = op.y;
      invalidateCache(ctx, node.id);
      return `x=${op.x ?? node.x} y=${op.y ?? node.y}`;
    }

    case "setSize": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("resize" in node)) {
        throw new OperationError(`${node.type} cannot be resized`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setSize", ["width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight"]);
      if (op.ignoreAutoLayout) {
        if ("minWidth" in node) (node as FrameNode).minWidth = 0;
        if ("maxWidth" in node) (node as FrameNode).maxWidth = null;
        if ("minHeight" in node) (node as FrameNode).minHeight = 0;
        if ("maxHeight" in node) (node as FrameNode).maxHeight = null;
      }
      node.resize(op.width ?? node.width, op.height ?? node.height);
      invalidateCache(ctx, node.id);
      return `${op.width ?? node.width}x${op.height ?? node.height}`;
    }

    case "setFill": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("fills" in node)) {
        throw new OperationError(`${node.type} does not support fills`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setFill", ["fills"]);
      node.fills = toPaints(op.fill) as typeof node.fills;
      invalidateCache(ctx, node.id);
      return JSON.stringify(op.fill);
    }

    case "setStroke": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("strokes" in node)) {
        throw new OperationError(`${node.type} does not support strokes`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setStroke", ["strokes", "strokeWeight", "strokeAlign", "dashPattern"]);
      node.strokes = [solid(op.color)];
      const weight = op.weight ?? 1;
      node.strokeWeight = weight;
      if (op.align) node.strokeAlign = op.align;
      if (op.dashPattern) node.dashPattern = op.dashPattern;
      invalidateCache(ctx, node.id);
      return `${op.color} w=${weight}`;
    }

    case "setOpacity": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("opacity" in node)) {
        throw new OperationError(`${node.type} does not support opacity`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setOpacity", ["opacity"]);
      node.opacity = op.opacity;
      invalidateCache(ctx, node.id);
      return String(op.opacity);
    }

    case "setCornerRadius": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      journalProps(ctx, node, index, op.type, "setCornerRadius", ["cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]);
      applyRadius(node, op.radius);
      invalidateCache(ctx, node.id);
      return typeof op.radius === "number" ? String(op.radius) : "per-corner";
    }

    case "appendChild": {
      const parent = await resolveParent(ctx, op.parent, index, op.type);
      const child = await resolve(ctx, op.child, index, op.type);
      // The container ability is the PARENT side (resolveParent already
      // checked it). The moved child may be ANY scene node — rectangles,
      // ellipses, vectors and text are appended into frames constantly, and
      // ChildrenMixin only exists on containers, so testing it on the child
      // rejected every leaf ("RECTANGLE cannot be a child node") and made
      // layer reordering in a live file impossible. What cannot be somebody's
      // child is the document itself or a page.
      const childType = (child as { type?: string }).type;
      if (childType === "DOCUMENT" || childType === "PAGE") {
        throw new OperationError(`A ${childType} cannot be a child node`, index, op.type);
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
      journalReparent(ctx, child, index, op.type, "reparent");

      if (op.index !== undefined) parent.insertChild(Math.min(op.index, parent.children.length), child as never);
      else parent.appendChild(child as never);
      invalidateCache(ctx, child.id, parent.id);
      return `${child.id} -> ${parent.id}`;
    }

    case "removeNode": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      journal(ctx, {
        figmaNodeId: node.id,
        opIndex: index,
        opType: op.type,
        kind: "removeNode",
        before: { name: node.name, type: node.type },
        parentId: (node as { parent?: BaseNode | null }).parent?.id,
        parentIndex: childIndex(node),
        nodeRef: node,
      });
      node.remove();
      invalidateCache(ctx, node.id);
      return "removed";
    }

    case "setAutoLayout": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("layoutMode" in node)) {
        throw new OperationError(`${node.type} does not support auto layout`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setAutoLayout", ["layoutMode", "itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "primaryAxisAlignItems", "counterAxisAlignItems", "layoutWrap"]);
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
      invalidateCache(ctx, node.id);
      return op.mode;
    }

    case "setPadding": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("paddingTop" in node)) {
        throw new OperationError(`${node.type} does not support padding`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setPadding", ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]);
      const [t, r, b, l] = four(op.padding);
      node.paddingTop = t;
      node.paddingRight = r;
      node.paddingBottom = b;
      node.paddingLeft = l;
      invalidateCache(ctx, node.id);
      return `${t} ${r} ${b} ${l}`;
    }

    case "setGap": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (!("itemSpacing" in node)) {
        throw new OperationError(`${node.type} does not support item spacing`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setGap", ["itemSpacing"]);
      node.itemSpacing = op.gap;
      invalidateCache(ctx, node.id);
      return String(op.gap);
    }

    case "setTypography": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (node.type !== "TEXT") {
        throw new OperationError(`setTypography requires a TEXT node, got ${node.type}`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setTypography", ["fontName", "fontSize", "lineHeight", "letterSpacing", "textAlignHorizontal", "textAlignVertical"]);
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
      invalidateCache(ctx, node.id);
      return `${family} ${style} ${op.fontSize ?? ""}`;
    }

    case "setTextContent": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (node.type !== "TEXT") {
        throw new OperationError(`setTextContent requires a TEXT node, got ${node.type}`, index, op.type);
      }
      journalProps(ctx, node, index, op.type, "setTextContent", ["characters"]);
      const text = node as TextNode;
      if (text.fontName === figma.mixed) {
        throw new OperationError("Cannot set characters on text with mixed fonts", index, op.type);
      }
      await loadFont(text.fontName.family, text.fontName.style);
      text.characters = op.content;
      invalidateCache(ctx, node.id);
      return `"${op.content.slice(0, 32)}"`;
    }

    case "setTextStyle": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      if (node.type !== "TEXT") {
        throw new OperationError(`setTextStyle requires a TEXT node, got ${node.type}`, index, op.type);
      }
      const styles = await figma.getLocalTextStylesAsync();
      const style = styles.find((s) => s.name === op.style || s.id === op.style);
      if (!style) {
        throw new OperationError(
          `Text style not found: "${op.style}". Create it first with createTextStyle (or seed_exo_system), then bind by name.`,
          index,
          op.type,
        );
      }
      journalProps(ctx, node, index, op.type, "setTextStyle", ["textStyleId"]);
      const text = node as TextNode;
      // The *Async setter is mandatory under "documentAccess": "dynamic-page";
      // the sync assignment throws there at runtime. Fall back to it only for
      // API surfaces that predate the async setter (and test mocks).
      if ("setTextStyleIdAsync" in text && typeof (text as unknown as { setTextStyleIdAsync?: unknown }).setTextStyleIdAsync === "function") {
        await (text as unknown as { setTextStyleIdAsync: (id: string) => Promise<void> }).setTextStyleIdAsync(style.id);
      } else {
        text.textStyleId = style.id;
      }
      invalidateCache(ctx, node.id);
      return `-> ${style.name}`;
    }

    case "setVisible": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      journalProps(ctx, node, index, op.type, "setVisible", ["visible"]);
      node.visible = op.visible;
      invalidateCache(ctx, node.id);
      return String(op.visible);
    }

    case "setPage": {
      const node = requireScene(await resolve(ctx, op.target, index, op.type), index, op.type);
      journalReparent(ctx, node, index, op.type, "setPage");
      await figma.loadAllPagesAsync();
      let page: PageNode | undefined;
      if (op.page) {
        page = figma.root.children.find((p) => p.id === op.page || p.name === op.page);
        if (!page) throw new OperationError(`Page not found: ${op.page}`, index, op.type);
      } else {
        page = figma.currentPage;
      }
      page.appendChild(node);
      invalidateCache(ctx, node.id);
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
      journalProps(ctx, node, index, op.type, "setConstraints", ["constraints"]);
      const current = node.constraints;
      // Constraints is readonly as a whole, so this is a deliberate widening:
      // the Figma schema is authoritative at runtime.
      (node as SceneNode & { constraints: Constraints }).constraints = {
        horizontal: op.horizontal ?? current.horizontal,
        vertical: op.vertical ?? current.vertical,
      };
      invalidateCache(ctx, node.id);
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
  // Seed the handle cache with the node we just built. Every create path holds
  // the live node in hand and then throws the reference away, so the verify
  // pass afterwards re-fetched every created node by id — one round trip each,
  // for a node already in memory. Measured on a 51-op screen: 60 lookups, of
  // which 44 existed only to re-observe nodes we had just created.
  //
  // Seeding is safe for the same reason `invalidateCache` exists: a cached
  // handle is dropped as soon as an operation mutates the node, so a stale
  // entry cannot survive a write.
  ctx.nodeCache.set(node.id, node);
  ctx.created.push({
    temporaryId: tempId,
    figmaNodeId: node.id,
    type: node.type,
    name: node.name,
  });
  return `${node.id}${tempId ? ` (${tempId})` : ""}`;
}

/**
 * Roll back a failed transaction by removing exactly the nodes it created.
 *
 * A bare `triggerUndo()` undoes whatever Figma last recorded — which, after a
 * timeout, a user hand-edit, or any interleaving work, is somebody else's
 * commit, not ours. Failed builds deleting previously committed screens is
 * how that reads, and it is why rollback here is surgical: every created id
 * is resolved and removed individually, and anything unresolvable is reported
 * as an orphan for explicit cleanup rather than guessed away with an undo.
 *
 * Group-created containers are emptied first: removing a GROUP node would
 * otherwise delete pre-existing children that were only moved into it. Each
 * grouped child is restored to its journaled parent (when known) or to the
 * current page before the group itself is removed.
 */
async function removeCreated(
  ctx: Ctx | null,
  figmaNodeIds: string[],
): Promise<{ removedIds: string[]; orphanIds: string[] }> {
  const removedIds: string[] = [];
  const orphanIds: string[] = [];
  const groupedChildren = new Map<string, Array<{ id: string; parentId: string; index: number }>>();
  if (ctx) {
    for (const entry of ctx.journal) {
      if (entry.kind === "createGroup" && entry.childrenBefore) {
        for (const child of entry.childrenBefore) groupedChildren.set(entry.figmaNodeId, entry.childrenBefore);
        break;
      }
    }
  }
  for (const id of [...figmaNodeIds].reverse()) {
    try {
      const node = await figma.getNodeByIdAsync(id);
      if (!node || (node as { removed?: boolean }).removed) {
        orphanIds.push(id);
        continue;
      }
      const kids = groupedChildren.get(id);
      if (kids && "children" in node) {
        for (const child of kids) {
          try {
            const childNode = await figma.getNodeByIdAsync(child.id);
            if (!childNode || (childNode as { removed?: boolean }).removed) continue;
            const parentNode = await figma.getNodeByIdAsync(child.parentId).catch(() => null);
            const parent = parentNode && "appendChild" in parentNode ? (parentNode as ParentNode) : figma.currentPage;
            if ("appendChild" in childNode) {
              if (Number.isFinite(child.index) && child.index >= 0 && (parent as ParentNode).children) {
                try {
                  (parent as ParentNode).insertChild(Math.min(child.index, (parent as ParentNode).children.length), childNode as never);
                } catch {
                  (parent as ParentNode).appendChild(childNode as never);
                }
              } else {
                (parent as ParentNode).appendChild(childNode as never);
              }
            }
          } catch {
            /* one unrestorable child must not block the rest */
          }
        }
      }
      if ("remove" in node && typeof (node as { remove?: unknown }).remove === "function") {
        (node as unknown as { remove: () => void }).remove();
        // Verified, not assumed: `rollbackStatus: "full"` tells the model the
        // document holds none of this transaction's work, so the removal has to
        // be read back. Figma's `remove()` is not documented to throw on every
        // failure path (a node detached by an interleaved edit, a locked
        // instance), and an unverified removal counted as clean is exactly the
        // "reported a clean rollback without evidence" failure. If the node
        // still resolves, it is an orphan and the rollback is only partial.
        const stillThere = await figma
          .getNodeByIdAsync(id)
          .then((n) => (n ? (n as { removed?: boolean }).removed !== true : false))
          .catch(() => false);
        if (stillThere) orphanIds.push(id);
        else removedIds.push(id);
      } else {
        orphanIds.push(id);
      }
    } catch {
      orphanIds.push(id);
    }
  }
  return { removedIds, orphanIds };
}

/** Best-effort write that records whether the target still accepts it. */
function trySet(target: Record<string, unknown>, key: string, value: unknown): boolean {
  try {
    target[key] = value;
    return true;
  } catch {
    return false;
  }
}

async function resolveLive(id: string): Promise<BaseNode | null> {
  try {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || (node as { removed?: boolean }).removed) return null;
    return node;
  } catch {
    return null;
  }
}

/**
 * Restore journaled mutations in reverse order (last mutation first).
 *
 * Returns confirmed-restored ids vs ids that could not be restored because
 * the node was deleted/moved by the user mid-transaction or a property is no
 * longer writable. A restore that cannot be verified is reported, never
 * assumed — that is what makes `rolledBack: true` trustworthy.
 */
async function restoreJournal(ctx: Ctx): Promise<{ restoredIds: string[]; unrestoredIds: string[] }> {
  const restoredIds: string[] = [];
  const unrestoredIds: string[] = [];
  for (const entry of [...ctx.journal].reverse()) {
    try {
      if (entry.kind === "removeNode") {
        const ref = entry.nodeRef;
        const parentLive = entry.parentId ? await resolveLive(entry.parentId) : null;
        const parent = parentLive && "appendChild" in parentLive ? (parentLive as ParentNode) : null;
        if (!ref || (ref as { removed?: boolean }).removed !== true) {
          // Node was never actually removed (failure happened before remove).
          restoredIds.push(entry.figmaNodeId);
          continue;
        }
        if (!parent) {
          unrestoredIds.push(entry.figmaNodeId);
          continue;
        }
        try {
          if (Number.isFinite(entry.parentIndex) && (entry.parentIndex ?? -1) >= 0) {
            parent.insertChild(Math.min(entry.parentIndex ?? parent.children.length, parent.children.length), ref as never);
          } else {
            parent.appendChild(ref as never);
          }
          try {
            (ref as { removed?: boolean }).removed = false;
          } catch {
            /* flag is best-effort */
          }
          invalidateCache(ctx, entry.figmaNodeId);
          restoredIds.push(entry.figmaNodeId);
        } catch {
          unrestoredIds.push(entry.figmaNodeId);
        }
        continue;
      }
      if (entry.kind === "reparent" || entry.kind === "setPage") {
        const node = await resolveLive(entry.figmaNodeId);
        // The restored child is any scene node — leaves included. ChildrenMixin
        // exists only on containers, so demanding appendChild on the node here
        // checked the wrong side and would have refused to restore every leaf
        // the op had already moved, turning a full rollback into a partial one.
        // Container ability is the parent's demand: restore into the recorded
        // old parent when it still is a container, else into the documented
        // fallback destination, the current page.
        const parentLive = entry.parentId ? await resolveLive(entry.parentId) : null;
        if (!node) {
          unrestoredIds.push(entry.figmaNodeId);
          continue;
        }
        const parent = parentLive && "appendChild" in parentLive ? (parentLive as ParentNode) : figma.currentPage;
        try {
          if (Number.isFinite(entry.parentIndex) && (entry.parentIndex ?? -1) >= 0) {
            parent.insertChild(Math.min(entry.parentIndex ?? parent.children.length, parent.children.length), node as never);
          } else {
            parent.appendChild(node as never);
          }
          for (const [k, v] of Object.entries(entry.before)) trySet(node as unknown as Record<string, unknown>, k, v);
          restoredIds.push(entry.figmaNodeId);
        } catch {
          unrestoredIds.push(entry.figmaNodeId);
        }
        continue;
      }
      if (entry.kind === "createGroup") {
        // Children were already moved back by removeCreated; nothing else to do.
        restoredIds.push(entry.figmaNodeId);
        continue;
      }
      if (entry.kind === "booleanConsume") {
        // Consumed sources cannot be reconstructed from properties alone.
        unrestoredIds.push(entry.figmaNodeId);
        continue;
      }
      const node = await resolveLive(entry.figmaNodeId);
      if (!node) {
        unrestoredIds.push(entry.figmaNodeId);
        continue;
      }
      const target = node as unknown as Record<string, unknown>;
      let ok = true;
      if (entry.kind === "bindVariable") {
        for (const [field, variable] of Object.entries(entry.before)) {
          try {
            (node as unknown as { setBoundVariable: (f: string, v: unknown) => void }).setBoundVariable(
              field,
              (variable as { id?: string }) ?? null,
            );
          } catch {
            ok = false;
          }
        }
      } else if (entry.kind === "prototypeLink") {
        try {
          const reactive = node as unknown as { setReactionsAsync?: (r: unknown[]) => Promise<void> };
          if (typeof reactive.setReactionsAsync === "function") {
            await reactive.setReactionsAsync((entry.before["reactions"] as unknown[]) ?? []);
          } else {
            ok = false;
          }
        } catch {
          ok = false;
        }
      } else if (entry.kind === "setVariant") {
        try {
          const inst = node as unknown as { setProperties?: (p: Record<string, unknown>) => void };
          const prior = entry.before["componentProperties"] as Record<string, { value?: unknown }> | undefined;
          if (typeof inst.setProperties === "function" && prior) {
            const props: Record<string, unknown> = {};
            for (const [k, prop] of Object.entries(prior)) {
              if (prop && typeof prop === "object" && "value" in prop && prop.value !== undefined && typeof prop.value !== "object") {
                props[k] = prop.value;
              }
            }
            inst.setProperties(props);
          } else {
            ok = false;
          }
        } catch {
          ok = false;
        }
      } else if (entry.kind === "setTextStyle") {
        // Style bindings restore through the async setter under
        // "documentAccess": "dynamic-page", where sync assignment throws and
        // would otherwise downgrade a fully-restored transaction to partial.
        try {
          const prior = entry.before["textStyleId"];
          const t = node as unknown as { setTextStyleIdAsync?: (id: string) => Promise<void> };
          if (typeof prior === "string" && prior.length > 0 && typeof t.setTextStyleIdAsync === "function") {
            await t.setTextStyleIdAsync(prior);
          } else if (!trySet(target, "textStyleId", prior)) {
            ok = false;
          }
        } catch {
          ok = false;
        }
      } else {
        for (const [k, v] of Object.entries(entry.before)) {
          if (!trySet(target, k, v)) ok = false;
        }
        if (entry.kind === "setTypography" || entry.kind === "setTextContent") {
          // Font-gated writes: reload the prior font before restoring chars.
          try {
            if (node.type === "TEXT") {
              const font = (node as TextNode).fontName;
              if (font && typeof font === "object" && "family" in font) {
                await figma.loadFontAsync(font as FontName).catch(() => undefined);
              }
            }
          } catch {
            /* restore already attempted */
          }
        }
      }
      if (ok) restoredIds.push(entry.figmaNodeId);
      else unrestoredIds.push(entry.figmaNodeId);
    } catch {
      unrestoredIds.push(entry.figmaNodeId);
    }
  }
  return { restoredIds: [...new Set(restoredIds)].filter((id) => !unrestoredIds.includes(id)), unrestoredIds: [...new Set(unrestoredIds)] };
}

async function failure(
  transactionId: string,
  err: unknown,
  attempted: boolean,
  createdIds: string[] = [],
  ctx: Ctx | null = null,
  perOperation: Array<{ index: number; opType: string; ms: number }> = [],
): Promise<TransactionFailure> {
  let removedIds: string[] = [];
  let orphanIds: string[] = [];
  let restoredIds: string[] = [];
  let unrestoredIds: string[] = [];
  let rollbackStatus: RollbackStatus = "none";

  if (attempted) {
    // Order matters: restore existing-node mutations FIRST (they may live
    // inside created containers), then remove created nodes in reverse order.
    if (ctx && ctx.journal.length > 0) {
      const restored = await restoreJournal(ctx);
      restoredIds = restored.restoredIds;
      unrestoredIds = restored.unrestoredIds;
    }
    // Surgical: only our own nodes go. Never a bare undo.
    const result = await removeCreated(ctx, createdIds);
    removedIds = result.removedIds;
    orphanIds = result.orphanIds;
    const journalClean = !ctx || ctx.journal.length === 0 || (restoredIds.length > 0 && unrestoredIds.length === 0 && restoredIds.length >= new Set(ctx.journal.map((j) => j.figmaNodeId)).size);
    const createdClean = createdIds.length === 0 || (removedIds.length === createdIds.length && orphanIds.length === 0);
    // Exact accounting: every distinct journaled node must be confirmed
    // restored; anything less is partial, never full.
    const journaledIds = ctx ? new Set(ctx.journal.map((j) => j.figmaNodeId)) : new Set<string>();
    const fullyRestored = [...journaledIds].every((id) => restoredIds.includes(id));
    if (createdClean && fullyRestored) rollbackStatus = "full";
    else if (removedIds.length > 0 || restoredIds.length > 0) rollbackStatus = "partial";
    else rollbackStatus = createdIds.length > 0 || journaledIds.size > 0 ? "partial" : "none";
    void journalClean;
  }

  const rolledBack = attempted && rollbackStatus === "full";

  const isOpError = err instanceof OperationError;
  const raw = err instanceof Error ? err.message : String(err);

  const note = !attempted
    ? "Nothing was committed, so the document is unchanged."
    : rollbackStatus === "full"
      ? createdIds.length === 0 && (!ctx || ctx.journal.length === 0)
        ? "Nothing was committed before the failure, so the document is unchanged."
        : `Full rollback: restored ${restoredIds.length} mutated node(s) and removed ${removedIds.length} created node(s). The document holds none of this transaction's partial work.`
      : `Partial rollback (${rollbackStatus}): restored [${restoredIds.join(", ")}]; could not restore [${unrestoredIds.join(", ")}]; removed ${removedIds.length}/${createdIds.length} created node(s)${orphanIds.length > 0 ? `; orphans: ${orphanIds.join(", ")}` : ""}. Inspect these ids before retrying — the document may hold partial work. Recovery: re-inspect each listed id; hand-restore any unrestored properties; do not retry with the same temp ids until the orphans are resolved.`;

  return {
    transactionId,
    status: "failed",
    error: {
      operation: isOpError ? err.operationIndex : -1,
      opType: isOpError ? err.opType : "plan",
      message: raw,
      // Spec §36: what failed, what was rolled back, what to try next.
      hint: hintFor(raw, isOpError ? err.opType : "plan"),
      rolledBackNote: note,
    },
    rolledBack,
    rollbackStatus,
    // What was slow before it died, slowest first: the evidence the next
    // attempt needs instead of a blind retry.
    ...(perOperation.length > 0
      ? { timings: { perOperation: [...perOperation].sort((a, b) => b.ms - a.ms).slice(0, 12) } }
      : {}),
    ...(removedIds.length > 0 ? { removedIds } : {}),
    ...(orphanIds.length > 0 ? { orphanIds } : {}),
    ...(restoredIds.length > 0 ? { restoredIds } : {}),
    ...(unrestoredIds.length > 0 ? { unrestoredIds } : {}),
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

  if (/was cancelled/i.test(m) || opType === "cancelled") {
    return "The transaction was cancelled (usually a server timeout asking the plugin to stop). Check rolledBack/rollbackStatus: full means nothing landed and a same-transactionId retry in smaller verified passes is safe; partial means inspect the listed ids first. Use get_job_status with the SAME transactionId before retrying.";
  }
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