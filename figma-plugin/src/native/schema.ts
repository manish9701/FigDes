/**
 * Strict validation for the native action surface (spec §37).
 *
 * Before this existed, the bridge forwarded `params` as `any` straight into the
 * handlers, so a typo, a wrong type, or a stray field reached the Figma Plugin
 * API and failed there with an opaque message (or worse, silently did nothing).
 *
 * Every action now has an explicit Zod schema and a `mutates` flag. Unknown
 * actions are rejected with the full list of what *is* supported, and unknown
 * parameters on a known action are rejected rather than ignored. This is the
 * action allowlist the security spec asks for, expressed as data.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Shared fragments                                                            */
/* -------------------------------------------------------------------------- */

const Num = z.number().finite();
const Str = z.string().max(2000);
const ShortStr = z.string().min(1).max(200);
const Bool = z.boolean();

const Pos = z.object({ x: Num.optional(), y: Num.optional() }).strict();
const Size = z.object({ width: Num.optional(), height: Num.optional() }).strict();
const Bounds = z.object({ x: Num.optional(), y: Num.optional(), width: Num.optional(), height: Num.optional() }).strict();
const Padding = z
  .object({ top: Num.optional(), right: Num.optional(), bottom: Num.optional(), left: Num.optional() })
  .strict();

/** A colour as a hex string, or a Figma paint object. */
const Color = z.string().min(1).max(60);
const PaintObject = z.object({ type: z.string().min(1).max(60) }).passthrough();
const Paint = z.union([Color, PaintObject]);
const Paints = z.array(Paint).max(64);

const PathPoint = z
  .object({
    command: z.enum(["M", "L", "H", "V", "C", "S", "Q", "T", "A", "Z"]),
    x: Num.optional(),
    y: Num.optional(),
    x1: Num.optional(),
    y1: Num.optional(),
    x2: Num.optional(),
    y2: Num.optional(),
    rx: Num.optional(),
    ry: Num.optional(),
    rotation: Num.optional(),
    largeArc: Bool.optional(),
    sweep: Bool.optional(),
  })
  .strict();
const Path = z.array(PathPoint).min(1).max(5000);

const Font = z.object({ family: z.string().min(1).max(120), style: z.string().min(1).max(120) }).strict();

const Constraints = z
  .object({
    horizontal: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]),
    vertical: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]),
  })
  .strict();

const Effect = z.object({ type: z.string().min(1).max(40) }).passthrough();

const AutoLayoutMode = z.enum(["NONE", "HORIZONTAL", "VERTICAL"]);
const AxisAlign = z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]);
const CounterAlign = z.enum(["MIN", "CENTER", "MAX", "BASELINE"]);
const SizingMode = z.enum(["FIXED", "AUTO", "HUG"]);

const Empty = z.object({}).strict();

/** Common scene-node creation fields, shared by every `create*` primitive. */
const CommonCreate = {
  name: Str.optional(),
  x: Num.optional(),
  y: Num.optional(),
  width: Num.optional(),
  height: Num.optional(),
  opacity: Num.min(0).max(1).optional(),
  visible: Bool.optional(),
  rotation: Num.optional(),
  cornerRadius: z.union([Num, z.record(z.string(), Num)]).optional(),
  fill: z.union([Paint, Paints, z.null()]).optional(),
  fills: Paints.optional(),
  stroke: z.union([Paint, Paints, z.null()]).optional(),
  strokes: Paints.optional(),
  strokeWeight: Num.optional(),
  parent: ShortStr.optional(),
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

export interface NativeAction {
  /** Validates the action's parameters (everything except `action`/`target`). */
  params: z.ZodTypeAny;
  /** True when the action changes the document, for transaction accounting. */
  mutates: boolean;
  description: string;
}

const A = (params: z.ZodTypeAny, mutates: boolean, description: string): NativeAction => ({
  params,
  mutates,
  description,
});

export const NATIVE_ACTIONS: Record<string, NativeAction> = {
  /* ---- document / inspection ---- */
  getFileInfo: A(Empty, false, "File metadata: name, pages, selection, component/variable/style counts."),
  getDesignContext: A(
    z.object({ maxNodes: Num.int().min(50).max(6000).optional(), depth: Num.int().min(1).max(6).optional() }).strict(),
    false,
    "Aggregated read context: file metadata, top frames, design-system summary, libraries.",
  ),
  listLibraryCollections: A(Empty, false, "Enabled team-library variable collections and their variable counts."),
  getPages: A(Empty, false, "List every page."),
  getSelection: A(Empty, false, "The current selection."),
  setSelection: A(z.object({ nodeIds: z.array(ShortStr).max(200) }).strict(), false, "Select nodes by id."),
  find: A(
    z.object({ query: z.object({ name: Str.optional(), type: Str.optional(), text: Str.optional() }).strict(), root: ShortStr.optional() }).strict(),
    false,
    "Find nodes by name, type or text within a root.",
  ),
  getNode: A(Empty, false, "Serialized node summary."),
  getChildren: A(Empty, false, "Serialized direct children."),
  getParent: A(Empty, false, "Serialized parent node."),
  getProperties: A(Empty, false, "Full node state: geometry, layout, paints, styles, text, component info."),
  inspect: A(
    z.object({ depth: Num.int().min(1).max(8).optional(), includeText: Bool.optional(), budget: Num.int().min(10).max(4000).optional() }).strict(),
    false,
    "Depth- and budget-limited node tree.",
  ),
  getBounds: A(Empty, false, "Local bounds."),
  getAbsoluteBounds: A(Empty, false, "Absolute bounds."),

  /* ---- creation ---- */
  createFrame: A(z.object({ ...CommonCreate, layoutMode: AutoLayoutMode.optional(), mode: AutoLayoutMode.optional(), direction: AutoLayoutMode.optional(), primaryAxisSizing: SizingMode.optional(), counterAxisSizing: SizingMode.optional(), primaryAxisAlignItems: AxisAlign.optional(), counterAxisAlignItems: CounterAlign.optional(), itemSpacing: Num.optional(), paddingTop: Num.optional(), paddingRight: Num.optional(), paddingBottom: Num.optional(), paddingLeft: Num.optional(), clipsContent: Bool.optional() }).strict(), true, "Create a frame."),
  createRectangle: A(z.object({ ...CommonCreate }).strict(), true, "Create a rectangle."),
  createEllipse: A(z.object({ ...CommonCreate }).strict(), true, "Create an ellipse."),
  createPolygon: A(z.object({ ...CommonCreate, pointCount: Num.int().min(3).max(60).optional() }).strict(), true, "Create a polygon."),
  createStar: A(z.object({ ...CommonCreate, pointCount: Num.int().min(3).max(60).optional(), innerRadius: Num.min(0).max(1).optional() }).strict(), true, "Create a star."),
  createLine: A(z.object({ ...CommonCreate }).strict(), true, "Create a line."),
  createText: A(z.object({ ...CommonCreate, font: Font.optional(), fontName: Font.optional(), family: Str.optional(), style: Str.optional(), fontSize: Num.optional(), content: Str.optional(), lineHeight: z.union([Num, z.object({ value: Num, unit: z.string().max(20) }).strict()]).optional(), letterSpacing: z.union([Num, z.object({ value: Num, unit: z.string().max(20) }).strict()]).optional(), textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(), textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(), textAutoResize: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional(), textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(), textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional() }).strict(), true, "Create a text node."),
  createVector: A(z.object({ ...CommonCreate, path: Path.optional() }).strict(), true, "Create a vector from a path."),
  createGroup: A(z.object({ name: Str.optional(), x: Num.optional(), y: Num.optional(), children: z.array(ShortStr).min(1).max(500), parent: ShortStr.optional() }).strict(), true, "Group existing nodes."),
  createComponent: A(z.object({ ...CommonCreate }).strict(), true, "Create a component."),
  createInstance: A(z.object({ componentId: ShortStr, name: Str.optional(), parent: ShortStr.optional(), x: Num.optional(), y: Num.optional() }).strict(), true, "Instantiate a component."),

  /* ---- generic mutation ---- */
  rename: A(z.object({ name: z.string().max(500) }).strict(), true, "Rename a node."),
  setPosition: A(Pos, true, "Move a node."),
  setSize: A(Size, true, "Resize a node."),
  setBounds: A(Bounds, true, "Move and resize a node."),
  setRotation: A(z.object({ rotation: Num }).strict(), true, "Rotate a node."),
  setOpacity: A(z.object({ opacity: Num.min(0).max(1) }).strict(), true, "Set opacity."),
  setVisible: A(z.object({ visible: Bool }).strict(), true, "Show or hide a node."),
  setBlendMode: A(z.object({ mode: z.string().min(1).max(40) }).strict(), true, "Set blend mode."),
  setClipContent: A(z.object({ value: Bool }).strict(), true, "Clip or unclip a frame."),
  setConstraints: A(z.object({ constraints: Constraints }).strict(), true, "Set resize constraints."),
  setCornerRadius: A(z.object({ radius: Num.min(0) }).strict(), true, "Set corner radius."),
  setIndividualCornerRadii: A(z.object({ radii: z.tuple([Num, Num, Num, Num]) }).strict(), true, "Set per-corner radii."),
  setIsMask: A(z.object({ value: Bool }).strict(), true, "Set mask flag."),
  setOverflowDirection: A(z.object({ value: z.string().min(1).max(40) }).strict(), true, "Set overflow direction."),

  /* ---- paint ---- */
  setFill: A(z.object({ paint: Paint }).strict(), true, "Replace fills with one paint."),
  setFills: A(z.object({ paints: Paints }).strict(), true, "Replace fills."),
  clearFill: A(Empty, true, "Remove all fills."),
  setStroke: A(z.object({ paints: Paints.optional(), weight: Num.optional(), align: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(), dashPattern: z.array(Num).max(64).optional(), cap: z.string().max(20).optional(), join: z.string().max(20).optional() }).strict(), true, "Set strokes."),
  setEffects: A(z.object({ effects: z.array(Effect).max(64) }).strict(), true, "Set effects."),

  /* ---- layout ---- */
  setAutoLayout: A(z.object({ direction: AutoLayoutMode.optional(), primaryAxisSizing: SizingMode.optional(), counterAxisSizing: SizingMode.optional(), primaryAxisAlignItems: AxisAlign.optional(), counterAxisAlignItems: CounterAlign.optional(), itemSpacing: Num.optional(), paddingTop: Num.optional(), paddingRight: Num.optional(), paddingBottom: Num.optional(), paddingLeft: Num.optional(), layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(), counterAxisAlignContent: z.string().max(30).optional() }).strict(), true, "Configure auto layout."),
  setLayoutGrid: A(
    z.object({
      pattern: z.enum(["COLUMNS", "ROWS", "GRID"]).optional(),
      count: Num.int().min(1).max(24).optional(),
      gutter: Num.min(0).max(400).optional(),
      offset: Num.min(0).max(1000).optional(),
      sectionSize: Num.positive().max(100000).optional(),
      visible: Bool.optional(),
      color: Color.optional(),
    }).strict(),
    true,
    "Append a layout grid (columns, rows, or square module) to a frame.",
  ),
  clone: A(z.object({ x: Num.optional(), y: Num.optional(), parent: ShortStr.optional() }).strict(), true, "Clone a node."),
  remove: A(Empty, true, "Remove a node."),
  append: A(z.object({ child: ShortStr }).strict(), true, "Append a child to a parent."),
  insertChild: A(z.object({ child: ShortStr, index: Num.int().min(0).max(100000) }).strict(), true, "Insert a child at an index."),

  /* ---- typography ---- */
  loadFont: A(z.object({ font: Font }).strict(), false, "Load a font for use."),
  setTypography: A(z.object({ font: Font.optional(), size: Num.optional(), lineHeight: z.union([Num, z.object({ value: Num, unit: z.string().max(20) }).strict()]).optional(), letterSpacing: z.union([Num, z.object({ value: Num, unit: z.string().max(20) }).strict()]).optional(), textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE", "SMALL_CAPS", "SMALL_CAPS_FORCED"]).optional(), textDecoration: z.enum(["NONE", "UNDERLINE", "STRIKETHROUGH"]).optional(), horizontalAlign: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(), verticalAlign: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(), resizingMode: z.enum(["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"]).optional() }).strict(), true, "Set typography on a text node."),
  setTextContent: A(z.object({ content: Str }).strict(), true, "Set text content."),

  /* ---- vectors ---- */
  setPathData: A(z.object({ path: Path }).strict(), true, "Replace a vector's path."),
  getVectorPath: A(Empty, false, "Read a vector's path data, winding rules and vertex counts."),
  booleanOperation: A(
    z.object({ operation: z.enum(["union", "subtract", "intersect", "exclude"]), targets: z.array(ShortStr).min(2).max(50), name: Str.optional() }).strict(),
    true,
    "Combine 2+ sibling nodes with a native boolean operation.",
  ),
  outlineStroke: A(z.object({ name: Str.optional() }).strict(), true, "Convert a vector/shape stroke into filled outline geometry."),
  mirrorNode: A(z.object({ axis: z.enum(["horizontal", "vertical"]) }).strict(), true, "Mirror a node across its own centre."),

  /* ---- batch execution ---- */
  executeBatch: A(
    z.object({
      operations: z
        .array(
          z.object({
            action: z.string().min(1).max(80),
            target: z.union([ShortStr, z.object({ $ref: z.string().min(1).max(64) }).strict()]).optional(),
            params: z.record(z.string(), z.unknown()).default({}),
            /** Stores this operation's node id for later ops as `$ref` / `{ $ref }`. */
            ref: z.string().min(1).max(64).optional(),
          }).strict(),
        )
        .min(1)
        .max(200),
      /** Compact id+bounds results (default) versus full node summaries. */
      compact: Bool.optional(),
    }).strict(),
    true,
    "Execute many native actions locally in one round-trip, with batch-local $refs. Prefer this over N sequential calls.",
  ),

  /* ---- components ---- */
  listComponents: A(Empty, false, "Local components and component sets."),
  getComponentProperties: A(Empty, false, "Instance component properties."),
  setVariant: A(z.object({ properties: z.record(z.string(), z.string()).optional(), variant: Str.optional() }).strict(), true, "Switch an instance to a variant."),
  detachInstance: A(Empty, true, "Detach an instance from its component."),

  /* ---- variables ---- */
  listVariables: A(Empty, false, "Local variables."),
  findVariable: A(z.object({ query: Str }).strict(), false, "Find variables by name or id."),
  createVariable: A(z.object({ name: z.string().min(1).max(200), collectionId: Str.optional(), collection: Str.optional(), type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]), description: Str.optional(), value: z.unknown().optional() }).strict(), true, "Create a local variable."),
  setVariableValue: A(z.object({ variableId: ShortStr, modeId: Str.optional(), value: z.unknown() }).strict(), true, "Set a variable value for a mode."),
  bindVariable: A(z.object({ variableId: ShortStr, field: z.string().min(1).max(60) }).strict(), true, "Bind a variable to a node field."),

  /* ---- styles ---- */
  listStyles: A(Empty, false, "Local paint, text and effect styles."),
  findStyle: A(z.object({ query: Str, kind: z.enum(["paint", "text", "effect"]).optional() }).strict(), false, "Find a style by id or name."),
  createPaintStyle: A(z.object({ name: z.string().min(1).max(200), paints: Paints.optional(), paint: Paint.optional() }).strict(), true, "Create a paint style."),
  createTextStyle: A(z.object({ name: z.string().min(1).max(200), font: Font.optional(), fontSize: Num.optional(), letterSpacing: z.union([Num, z.object({ value: Num, unit: z.string().max(20) }).strict()]).optional(), lineHeight: z.union([Num, z.object({ value: Num, unit: z.string().max(20) }).strict()]).optional() }).strict(), true, "Create a text style."),
  createEffectStyle: A(z.object({ name: z.string().min(1).max(200), effects: z.array(Effect).max(64).optional() }).strict(), true, "Create an effect style."),
  applyStyle: A(z.object({ styleId: Str.optional(), style: Str.optional(), kind: z.enum(["paint", "text", "effect"]).optional() }).strict(), true, "Apply a style to a node."),

  /* ---- pages ---- */
  createPage: A(z.object({ name: Str.optional(), makeCurrent: Bool.optional() }).strict(), true, "Create a page."),
  setCurrentPage: A(Empty, true, "Switch the current page."),

  /* ---- transaction control ---- */
  beginNativeTransaction: A(z.object({ transactionId: Str.optional() }).strict(), false, "Open a native transaction."),
  commitNativeTransaction: A(z.object({ transactionId: Str.optional() }).strict(), false, "Commit the open native transaction."),
  rollbackNativeTransaction: A(z.object({ transactionId: Str.optional() }).strict(), false, "Roll back the open native transaction."),
};

export const NATIVE_ACTION_NAMES = Object.keys(NATIVE_ACTIONS).sort();

export function isMutatingAction(action: string): boolean {
  return NATIVE_ACTIONS[action]?.mutates === true;
}
