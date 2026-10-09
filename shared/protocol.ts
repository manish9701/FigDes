/**
 * Single source of truth for the plugin <-> server <-> MCP wire format.
 *
 * Bundled into BOTH the Figma plugin (esbuild) and the MCP server (esbuild),
 * so there is no build-order coupling between the two.
 *
 * Security note: nothing in this file ever evaluates AI-authored code. The
 * model emits structured JSON, it is validated here against an allowlist of
 * operations, and only then reaches figma.*  See SPEC §19.
 */
import { z } from "zod";

export const PLUGIN_VERSION = "0.1.0";

/* -------------------------------------------------------------------------- */
/* Colors                                                                      */
/* -------------------------------------------------------------------------- */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const RGB_FN = /^rgba?\(\s*([\d.]+%?)[\s,/]+([\d.]+%?)[\s,/]+([\d.]+%?)(?:[\s,/]+([\d.]+%?))?\s*\)$/i;
const HEX_RE = /^#?([0-9a-f]{3,8})$/i;

/** Accepts #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb(...), rgba(...). Throws otherwise. */
export function parseColor(input: string): RGBA {
  const s = String(input).trim();

  const fn = s.match(RGB_FN);
  if (fn) {
    const chan = (v: string) => (v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v) / 255);
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith("%") ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    return { r: chan(fn[1]!), g: chan(fn[2]!), b: chan(fn[3]!), a: alpha };
  }

  const hex = s.match(HEX_RE);
  if (hex) {
    let x = hex[1]!;
    if (x.length === 3 || x.length === 4) x = x.split("").map((c) => c + c).join("");
    if (x.length !== 6 && x.length !== 8) throw new Error(`Unrecognized color: ${input}`);
    const n = parseInt(x.slice(0, 6), 16);
    return {
      r: ((n >> 16) & 255) / 255,
      g: ((n >> 8) & 255) / 255,
      b: (n & 255) / 255,
      a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1,
    };
  }

  throw new Error(`Unrecognized color: ${input}. Use #RGB, #RRGGBB, #RRGGBBAA or rgb(r,g,b).`);
}

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");

export function toHex(c: RGBA): string {
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`.toUpperCase();
}

/* -------------------------------------------------------------------------- */
/* Operation payloads                                                          */
/* -------------------------------------------------------------------------- */

/** A node reference: either a transaction-local `temp_*` id or a real Figma id. */
export const RefSchema = z.string().min(1).max(200);

/**
 * Figma's own auto-generated layer names. Shared so the plugin tags nodes and
 * the server-side critic detects them from one definition — a client-supplied
 * flag alone would let a miss go unnoticed.
 */
const DEFAULT_LAYER_NAME = /^(Frame|Group|Rectangle|Text|Vector|Union|Component|Component Set|Instance|Ellipse|Line|Polygon|Star) ?\d+$/;

export function isDefaultLayerName(name: string): boolean {
  return DEFAULT_LAYER_NAME.test(name.trim());
}

export const CornerRadiusSchema = z.union([
  z.number().min(0).max(100000),
  z.object({
    topLeft: z.number().min(0).optional(),
    topRight: z.number().min(0).optional(),
    bottomRight: z.number().min(0).optional(),
    bottomLeft: z.number().min(0).optional(),
  }),
]);

export const PaddingSchema = z.union([
  z.number().min(0).max(100000),
  z.object({
    top: z.number().min(0).optional(),
    right: z.number().min(0).optional(),
    bottom: z.number().min(0).optional(),
    left: z.number().min(0).optional(),
  }),
]);

/**
 * Paints for a node.
 *
 * `[]` is meaningful and means "no fill", so an empty array has to be accepted
 * rather than treated as an absent value.
 */
export const FillSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.string(),
      z.object({
        color: z.string(),
        opacity: z.number().min(0).max(1).optional(),
      }),
    ]),
  ),
  z.object({
    color: z.string(),
    opacity: z.number().min(0).max(1).optional(),
  }),
]);

const createBase = {
  /** Transaction-local id so later operations in the same plan can reference it. */
  id: z.string().min(1).max(64).optional(),
  /** Parent node ref. Defaults to the plugin's current page. */
  parent: RefSchema.optional(),
  name: z.string().max(500).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  fill: FillSchema.optional(),
  opacity: z.number().min(0).max(1).optional(),
  cornerRadius: CornerRadiusSchema.optional(),
  visible: z.boolean().optional(),
};

/* ------------------------------ V1 operations ----------------------------- */

export const CreateFrameOp = z.object({
  ...createBase,
  type: z.literal("createFrame"),
  width: z.number().positive().max(100000),
  height: z.number().positive().max(100000),
  layoutMode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]).optional(),
  padding: PaddingSchema.optional(),
  itemSpacing: z.number().min(0).max(100000).optional(),
  primaryAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
  counterAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
  clipsContent: z.boolean().optional(),
  /**
   * Frames accept strokes (device health rings, selection markers, card
   * borders). Rectangles and ellipses already did; frames were an oversight,
   * which meant every frame stroke in every compiled program was silently
   * dropped by schema parsing.
   */
  stroke: z.string().optional(),
  strokeWeight: z.number().min(0).max(1000).optional(),
});

export const CreateRectangleOp = z.object({
  ...createBase,
  type: z.literal("createRectangle"),
  width: z.number().positive().max(100000),
  height: z.number().positive().max(100000),
  stroke: z.string().optional(),
  strokeWeight: z.number().min(0).max(1000).optional(),
});

export const CreateEllipseOp = z.object({
  ...createBase,
  type: z.literal("createEllipse"),
  width: z.number().positive().max(100000),
  height: z.number().positive().max(100000),
  stroke: z.string().optional(),
  strokeWeight: z.number().min(0).max(1000).optional(),
});

export const CreateTextOp = z.object({
  ...createBase,
  type: z.literal("createText"),
  content: z.string().max(20000),
  /** Text is untrusted design data — rendered as characters only, never executed. */
  family: z.string().min(1).max(200).default("Inter"),
  style: z.string().max(200).default("Regular"),
  fontSize: z.number().positive().max(1000).default(16),
  /**
   * Numeric weight shorthand (100-900). Translated to a real installed style
   * name at execution time, so a file using Inter gets "SemiBold" rather than
   * silently falling back to Regular.
   */
  weight: z.number().int().min(100).max(900).optional(),
  lineHeight: z.number().positive().max(5000).optional(),
  letterSpacing: z.number().min(-100).max(1000).optional(),
  textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
  textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
  width: z.number().positive().max(100000).optional(),
});

export const RenameNodeOp = z.object({
  type: z.literal("renameNode"),
  target: RefSchema,
  name: z.string().min(1).max(500),
});

export const SetPositionOp = z.object({
  type: z.literal("setPosition"),
  target: RefSchema,
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
});

export const SetSizeOp = z.object({
  type: z.literal("setSize"),
  target: RefSchema,
  width: z.number().positive().max(100000).optional(),
  height: z.number().positive().max(100000).optional(),
  /** When true, min/max bounds on the node are cleared after resizing. */
  ignoreAutoLayout: z.boolean().optional(),
});

export const SetFillOp = z.object({
  type: z.literal("setFill"),
  target: RefSchema,
  fill: FillSchema,
});

export const SetStrokeOp = z.object({
  type: z.literal("setStroke"),
  target: RefSchema,
  color: z.string(),
  weight: z.number().min(0).max(1000).optional(),
  align: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(),
  dashPattern: z.array(z.number().min(0)).optional(),
});

export const SetOpacityOp = z.object({
  type: z.literal("setOpacity"),
  target: RefSchema,
  opacity: z.number().min(0).max(1),
});

export const SetCornerRadiusOp = z.object({
  type: z.literal("setCornerRadius"),
  target: RefSchema,
  radius: CornerRadiusSchema,
});

export const AppendChildOp = z.object({
  type: z.literal("appendChild"),
  parent: RefSchema,
  child: RefSchema,
  /** Insert at this index within the parent's children. Default: append last. */
  index: z.number().int().min(0).optional(),
});

export const RemoveNodeOp = z.object({
  type: z.literal("removeNode"),
  target: RefSchema,
});

export const CreateVectorOp = z.object({
  ...createBase,
  type: z.literal("createVector"),
  width: z.number().positive().max(100000),
  height: z.number().positive().max(100000),
  /**
   * SVG path data. This is DATA, never code: it is parsed into vectors and
   * converted to native nodes. Nothing here is executed. The bezier-preserving
   * pipeline keeps absolute M/L/C/Q/A/S/T/Z (plus relative spellings, which are
   * normalised to absolute); the legacy flattening path still accepts M/L/H/V/C/Q/A/Z.
   */
  path: z.string().min(1).max(8000),
  stroke: z.string().optional(),
  strokeWeight: z.number().min(0).max(64).optional(),
  strokeAlign: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(),
  strokeCap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]).optional(),
  strokeJoin: z.enum(["MITER", "BEVEL", "ROUND"]).optional(),
  /** Fill rule for closed subpaths. */
  closed: z.boolean().optional(),
  windingRule: z.enum(["NONE", "NONZERO", "EVENODD"]).optional(),
  /**
   * Dashed stroke, e.g. `[4, 4]`. Used by connectors to distinguish a data flow
   * from a control path without a second node.
   */
  dashPattern: z.array(z.number().min(0).max(64)).max(8).optional(),
  /**
   * Fills the closed subpaths as well as stroking them.
   *
   * Connectors need this: the arrowhead is a closed triangle riding in the same
   * path as the line, so it must fill while the line only strokes.
   */
  fillArrows: z.boolean().optional(),
});

/**
 * Boolean combination of 2+ sibling shapes/vectors (union, subtract,
 * intersect, exclude). Executes Figma's native boolean ops so the result is a
 * real editable boolean group, not a flattened picture of one.
 */
export const BooleanOperationOp = z.object({
  type: z.literal("booleanOperation"),
  id: z.string().min(1).max(64).optional(),
  name: z.string().max(500).optional(),
  operation: z.enum(["union", "subtract", "intersect", "exclude"]),
  /** At least two nodes sharing a parent. First entry is the base for subtract. */
  targets: z.array(RefSchema).min(2).max(50),
  parent: RefSchema.optional(),
});

/** Converts a vector/shape stroke into filled outline geometry. */
export const OutlineStrokeOp = z.object({
  type: z.literal("outlineStroke"),
  target: RefSchema,
  id: z.string().min(1).max(64).optional(),
  name: z.string().max(500).optional(),
});

/** Replaces a vector's path in place, preserving beziers and fill rule. */
export const SetVectorPathOp = z.object({
  type: z.literal("setVectorPath"),
  target: RefSchema,
  path: z.string().min(1).max(8000),
  windingRule: z.enum(["NONE", "NONZERO", "EVENODD"]).optional(),
});

/** Mirrors a node across its own vertical or horizontal centre. */
export const MirrorNodeOp = z.object({
  type: z.literal("mirrorNode"),
  target: RefSchema,
  axis: z.enum(["horizontal", "vertical"]),
});

/**
 * Appends a layout grid to a frame (report §10: SetGrid).
 *
 * Columns/rows for alignment structure, GRID for a baseline square module.
 * Appends rather than replaces so a columns grid and a rows grid can coexist.
 * Hidden by default: guides are construction aids, and a red overlay on every
 * region would pollute render-based visual review.
 */
export const SetLayoutGridOp = z.object({
  type: z.literal("setLayoutGrid"),
  target: RefSchema,
  pattern: z.enum(["COLUMNS", "ROWS", "GRID"]).default("COLUMNS"),
  /** Section count for COLUMNS/ROWS (12 is the classic grid). */
  count: z.number().int().min(1).max(24).default(12),
  /** Gutter between sections, in px. */
  gutter: z.number().min(0).max(400).default(24),
  /** Margin offset for COLUMNS/ROWS. */
  offset: z.number().min(0).max(1000).optional(),
  /** Cell size for the GRID pattern. */
  sectionSize: z.number().positive().max(100000).optional(),
  visible: z.boolean().default(false),
  color: z.string().optional(),
});

/**
 * Creates or updates a variable (spec §22).
 *
 * Values are keyed by mode name, with `default` used when the model did not
 * name one. `boolean` values are deliberately supported: a token such as
 * `enabled` or `darkMode` is a legitimate part of a design system, and leaving it
 * out is what forces designers to hardcode it forever.
 */
export const CreateVariableOp = z.object({
  type: z.literal("createVariable"),
  /** Transaction-local id, so a later op can bind to it. */
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200),
  variableType: z.enum(["color", "number", "string", "boolean"]),
  /** Collection name. Created if absent. */
  collection: z.string().min(1).max(200).optional(),
  values: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  scopes: z
    .array(
      z.enum([
        "ALL_SCOPES",
        "TEXT_CONTENT",
        "CORNER_RADIUS",
        "FLOATING_TEXT",
        "STROKE_FLOAT",
        "STROKE_COLOR",
        "EFFECT_FLOAT",
        "OPACITY",
        "FONT_FAMILY",
        "FONT_STYLE",
        "FONT_WEIGHT",
        "FONT_SIZE",
        "LINE_HEIGHT",
        "LETTER_SPACING",
        "PARAGRAPH_SPACING",
        "PARAGRAPH_INDENT",
        "WIDTH_HEIGHT",
        "GAP",
      ]),
    )
    .max(20)
    .optional(),
  description: z.string().max(1000).optional(),
});

/**
 * Creates or updates a text style (spec §22).
 *
 * `weight` is the numeric shorthand the rest of the system uses; the plugin
 * resolves it against the fonts actually installed, so a file using a family
 * without SemiBold gets Medium instead of a silent fallback to Regular.
 */
export const CreateTextStyleOp = z.object({
  type: z.literal("createTextStyle"),
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200),
  family: z.string().min(1).max(200).default("Inter"),
  weight: z.number().int().min(100).max(900).default(400),
  fontSize: z.number().positive().max(1000).default(16),
  lineHeight: z.number().positive().max(5000).optional(),
  letterSpacing: z.number().min(-100).max(1000).optional(),
  fill: FillSchema.optional(),
});

/** Creates or updates a paint (colour) style (spec §22). */
export const CreatePaintStyleOp = z.object({
  type: z.literal("createPaintStyle"),
  id: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(200),
  color: z.string().min(1).max(64),
  opacity: z.number().min(0).max(1).default(1),
});

/**
 * Shape of a create_component_set request.
 *
 * Kept as a schema (not an operation) because component-set creation is a
 * standalone action like its siblings, not a transaction step. Figma has no
 * createComponentSet: the set is born from at least two members.
 */
export const CreateComponentSetRequest = z.object({
  name: z.string().min(1).max(200),
  /** Component ids, or frame/group ids to promote into components first. */
  members: z.array(z.string().min(1).max(200)).min(2).max(50),
  parent: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
});

/**
 * Binds a node field to a variable (spec §22).
 *
 * This is what makes tokens real rather than decorative: a bound fill follows
 * the variable when it changes, while a hardcoded hex is frozen forever. The
 * variable is resolved by name at execution time, so the program does not need
 * to know variable ids — but it does need the variable to exist, which is what
 * `seed_exo_system` and the `variable` primitive are for.
 */
export const BindVariableOp = z.object({
  type: z.literal("bindVariable"),
  target: RefSchema,
  field: z.enum(["fills", "strokes", "cornerRadius", "fontSize"]),
  /** Variable name, with or without collection: "surface" or "exo/surface". */
  variable: z.string().min(1).max(200),
  /** Collection name. Searched when the variable name has no collection prefix. */
  collection: z.string().min(1).max(200).optional(),
});

/**
 * Groups nodes so they move and align as one.
 *
 * Groups are structure, not style: the use case is selecting and aligning a
 * cluster that the layout did not already parent together. Prefer building the
 * hierarchy correctly over grouping afterwards.
 */
export const CreateGroupOp = z.object({
  type: z.literal("createGroup"),
  id: z.string().min(1).max(64).optional(),
  name: z.string().max(500).optional(),
  /** At least two nodes, sharing a parent. */
  children: z.array(RefSchema).min(2).max(200),
  parent: RefSchema.optional(),
});

export const CreateComponentOp = z.object({
  ...createBase,
  type: z.literal("createComponent"),
  width: z.number().finite().optional(),
  height: z.number().finite().optional(),
});

export const CreateInstanceOp = z.object({
  type: z.literal("createInstance"),
  id: z.string().min(1).max(64).optional(),
  name: z.string().max(500).optional(),
  parent: RefSchema.optional(),
  componentId: RefSchema,
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
});

export const SetVariantOp = z.object({
  type: z.literal("setVariant"),
  target: RefSchema,
  variant: z.record(z.string()),
});

/**
 * Sets a drop shadow or layer blur on a node.
 *
 * Effects are used sparingly by identity: one soft shadow to lift a dialog or
 * a floating panel, never texture. Anything beyond that belongs in the design,
 * not in this operation.
 */
export const SetEffectOp = z.object({
  type: z.literal("setEffect"),
  target: RefSchema,
  effect: z.enum(["drop-shadow", "inner-shadow", "blur"]),
  color: z.string().min(1).max(64).default("#000000"),
  offsetX: z.number().min(-500).max(500).default(0),
  offsetY: z.number().min(-500).max(500).default(8),
  radius: z.number().min(0).max(200).default(24),
  spread: z.number().min(-200).max(200).default(0),
  opacity: z.number().min(0).max(1).default(0.16),
});
/**
 * Links two frames with a prototype interaction.
 *
 * Flows are what turn screens into a product: without them every screen is an
 * island and the only way to experience the design is to squint at thumbnails.
 * Reactions append to any the source already has rather than replacing them, so
 * adding a flow never destroys hand-built prototyping.
 */
export const PrototypeLinkOp = z.object({
  type: z.literal("prototypeLink"),
  /** The frame (or node) carrying the interaction. */
  from: RefSchema,
  /** Destination frame id. */
  to: RefSchema,
  trigger: z.enum(["ON_CLICK", "ON_HOVER", "ON_PRESS"]).default("ON_CLICK"),
  /** Omit for an instant cut. */
  transition: z.enum(["none", "dissolve", "smart-animate"]).default("dissolve"),
});
/**
 * Creates a slide (Figma Slides only).
 *
 * A slide is a fixed 1920x1080 frame that must live inside a slide row.
 * `figma.createSlide()` handles the row for us: the first call implicitly
 * creates row 0, later calls append to the end of the last row. `row`/`col`
 * pin the position inside the deck.
 *
 * Content is placed like any other frame: child operations address this slide
 * by its transaction-local id, exactly as they would a `createFrame`. The
 * background is a real fill on the slide itself rather than a stacked
 * rectangle, so re-running a program updates it instead of piling up layers.
 */
export const CreateSlideOp = z.object({
  type: z.literal("createSlide"),
  /** Transaction-local id so later operations in the same plan can reference it. */
  id: z.string().min(1).max(64).optional(),
  name: z.string().max(500).optional(),
  /** Position inside the deck. Omitted appends to the end. */
  row: z.number().int().min(0).max(1000).optional(),
  col: z.number().int().min(0).max(1000).optional(),
  /** Slide background fill. A full-bleed rectangle is not needed. */
  background: FillSchema.optional(),
  /** Speaker notes, as plain text or markdown. */
  notes: z.string().max(10000).optional(),
  /** Skip this slide during presentation playback. */
  skipped: z.boolean().optional(),
});

export const CloneNodeOp = z.object({
  ...createBase,
  type: z.literal("cloneNode"),
  target: RefSchema,
});

export const SetAutoLayoutOp = z.object({
  type: z.literal("setAutoLayout"),
  target: RefSchema,
  mode: z.enum(["NONE", "HORIZONTAL", "VERTICAL"]),
  itemSpacing: z.number().min(0).max(100000).optional(),
  padding: PaddingSchema.optional(),
  primaryAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
  counterAxisAlignItems: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
  layoutWrap: z.enum(["NO_WRAP", "WRAP"]).optional(),
});

export const SetPaddingOp = z.object({
  type: z.literal("setPadding"),
  target: RefSchema,
  padding: PaddingSchema,
});

export const SetGapOp = z.object({
  type: z.literal("setGap"),
  target: RefSchema,
  gap: z.number().min(0).max(100000),
});

export const SetTypographyOp = z.object({
  type: z.literal("setTypography"),
  target: RefSchema,
  family: z.string().min(1).max(200).optional(),
  style: z.string().max(200).optional(),
  fontSize: z.number().positive().max(1000).optional(),
  lineHeight: z.number().positive().max(5000).optional(),
  letterSpacing: z.number().min(-100).max(1000).optional(),
  textAlignHorizontal: z.enum(["LEFT", "CENTER", "RIGHT", "JUSTIFIED"]).optional(),
  textAlignVertical: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
});

export const SetTextContentOp = z.object({
  type: z.literal("setTextContent"),
  target: RefSchema,
  content: z.string().max(20000),
});

export const SetVisibleOp = z.object({
  type: z.literal("setVisible"),
  target: RefSchema,
  visible: z.boolean(),
});

export const SetPageOp = z.object({
  type: z.literal("setPage"),
  target: RefSchema,
  /** Page id or name. Defaults to the current page. */
  page: z.string().min(1).optional(),
});

/**
 * Explicit resize constraints (MIN | CENTER | MAX | STRETCH | SCALE per axis).
 *
 * Auto-layout covers containers; this covers everything else: a hero that must
 * stretch with its frame, a rail pinned left, an overlay centred. Without it
 * native composition cannot express responsive intent.
 */
export const SetConstraintsOp = z.object({
  type: z.literal("setConstraints"),
  target: RefSchema,
  horizontal: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
  vertical: z.enum(["MIN", "CENTER", "MAX", "STRETCH", "SCALE"]).optional(),
});

/**
 * The allowlist. Adding a case here is the ONLY way to give the model new
 * power over the document — there is no eval / dynamic dispatch path.
 */
export const OperationSchema = z.discriminatedUnion("type", [
  CreateFrameOp,
  CreateRectangleOp,
  CreateEllipseOp,
  CreateTextOp,
  CreateVectorOp,
  BooleanOperationOp,
  OutlineStrokeOp,
  SetVectorPathOp,
  MirrorNodeOp,
  SetLayoutGridOp,
  CreateSlideOp,
  PrototypeLinkOp,
  CreateGroupOp,
  SetEffectOp,
  CreateVariableOp,
  CreateTextStyleOp,
  CreatePaintStyleOp,
  BindVariableOp,
  RenameNodeOp,
  SetPositionOp,
  SetSizeOp,
  SetFillOp,
  SetStrokeOp,
  SetOpacityOp,
  SetCornerRadiusOp,
  AppendChildOp,
  RemoveNodeOp,
  CloneNodeOp,
  SetAutoLayoutOp,
  SetPaddingOp,
  SetGapOp,
  SetTypographyOp,
  SetTextContentOp,
  SetVisibleOp,
  SetPageOp,
  SetConstraintsOp,
  CreateComponentOp,
  CreateInstanceOp,
  SetVariantOp,
] as const);

export type Operation = z.infer<typeof OperationSchema>;

export type CornerRadius = z.infer<typeof CornerRadiusSchema>;
export type Padding = z.infer<typeof PaddingSchema>;
export type Fill = z.infer<typeof FillSchema>;

export const OPERATION_TYPES = OperationSchema.options.map((o) => o.shape.type.value) as [
  Operation["type"],
  ...Operation["type"][],
];

/* -------------------------------------------------------------------------- */
/* Transactions                                                                */
/* -------------------------------------------------------------------------- */

export const TransactionSchema = z.object({
  transactionId: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  operations: z.array(OperationSchema).min(1).max(2000),
});

export type Transaction = z.infer<typeof TransactionSchema>;

export interface CreatedNode {
  temporaryId?: string;
  figmaNodeId: string;
  type: string;
  name: string;
  /** Committed geometry, read after the transaction lands. Absent when the node is gone or has no bounds. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface TransactionSuccess {
  transactionId: string;
  status: "success";
  dryRun: boolean;
  createdNodes: CreatedNode[];
  /** Figma ids touched by non-create operations, so the next call operates from evidence instead of guessing. */
  modifiedNodes?: string[];
  /** Human-readable trace, one line per applied operation. */
  applied: string[];
  /**
   * Created ids that no longer resolve after commit. Never invents a failure:
   * when empty or absent everything reported as created still exists. When
   * present, the build landed partially and the caller must verify before
   * reporting success — this is the honest answer to "did it actually land".
   */
  unconfirmedIds?: string[];
}

export interface TransactionFailure {
  transactionId: string;
  status: "failed";
  error: {
    /** Index into the submitted operations array, or -1 for a plan-level failure. */
    operation: number;
    opType: string;
    message: string;
    /** Actionable next step, so the model can recover instead of guessing. */
    hint: string;
    /** What state the document is actually in. */
    rolledBackNote: string;
  };
  /**
   * True when every node this transaction created was removed again, so the
   * document holds none of its partial work. Removal is by explicit node id —
   * never a bare undo, which would pop whatever Figma last recorded regardless
   * of which transaction put it there.
   */
  rolledBack: boolean;
  /** Created ids that were removed again during rollback. */
  removedIds?: string[];
  /**
   * Created ids that could not be removed (already gone, or unresolvable).
   * Non-empty means the document may hold partial work: inspect these ids
   * before retrying rather than assuming a clean slate.
   */
  orphanIds?: string[];
}

export type TransactionResult = TransactionSuccess | TransactionFailure;

/* -------------------------------------------------------------------------- */
/* Inspect payloads                                                            */
/* -------------------------------------------------------------------------- */

export interface InspectedNode {
  id: string;
  type: string;
  name: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  opacity?: number;
  layoutMode?: string;
  characters?: string;
  fontSize?: number;
  fontName?: string;
  /** Vector structure: subpath/curve counts plus capped path data for revision. */
  vector?: {
    subpathCount?: number;
    curveCount?: number;
    winding?: string[];
    data?: string[];
    strokeWeight?: number;
    strokeCount?: number;
  };
  children?: InspectedNode[];
  /** Set when the subtree was cut off by depth or budget limits. */
  truncated?: boolean;
  childCount?: number;
}

export interface InspectSelectionResult {
  selection: InspectedNode[];
  /** True when the requested depth/budget clipped the result. */
  truncated: boolean;
  /**
   * Always present on inspect results. Text inside a Figma file is untrusted
   * design data (spec §37): it is reported as content to reason about, never as
   * instructions to follow.
   */
  contentTrust: "untrusted";
}

export interface InspectFileResult {
  fileName: string;
  fileKey: string | null;
  currentPage: { id: string; name: string };
  pages: Array<{ id: string; name: string; childCount: number }>;
  selection: InspectedNode[];
  topLevelFrames: InspectedNode[];
  counts: Record<string, number>;
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Design-system extraction (spec §6)                                          */
/* -------------------------------------------------------------------------- */

export interface Frequency {
  count: number;
  samples: string[];
}

export interface DesignSystemReport {
  fileName: string;
  scope: "page" | "file";
  pagesScanned: string[];
  nodesScanned: number;
  truncated: boolean;

  colors: Array<{ hex: string; count: number; sampleNames: string[] }>;
  colorsTotal: number;
  strokes: Array<{ hex: string; count: number }>;
  radii: Array<{ value: number; count: number }>;
  shadows: Array<{ signature: string; count: number }>;

  typography: Array<{ label: string; sampleNames: string[]; count: number }>;

  spacing: {
    /** 0 when no consistent base could be inferred. Never a guess. */
    inferredBase: number;
    values: Array<{ value: number; count: number }>;
  };

  layoutPatterns: Array<{ signature: string; count: number }>;
  components: Array<{ name: string; count: number }>;

variables: Array<{ name: string; type: string; id: string; scopes: string[] }>;
  /**
   * Resolved default-mode values for colour/number variables, keyed by name.
   * Lets token intelligence bind by name instead of hardcoding hex. Absent
   * entries mean "name known, value not resolved", never "no value".
   */
  variableValues?: Record<string, string | number | boolean | null>;
styles: { paint: number; text: number; effect: number };
  /**
   * Style names, not just counts.
   *
   * The counts answer "is this file styled?". The names answer "does this style
   * already exist?", which is what the checkpoint gate needs in order to tell
   * *creating* a token from *redefining* one -- and reusing a style by name is the
   * single biggest way to avoid creating a duplicate.
   */
  styleNames: { paint: string[]; text: string[] };

  naming: { defaultNamed: number; conventions: string[] };

  /**
   * Discovery intelligence (§7): fonts, text-style details, screens, assets and
   * visual patterns observed in the scanned scope. All optional and bounded, so
   * older servers that ignore them keep working unchanged.
   */
  fonts?: Array<{ family: string; styles: string[]; textNodes: number }>;
  styleDetails?: { text: Array<{ name: string; family: string; size: number; weight: string }> };
  screens?: Array<{ id: string; name: string; width: number; height: number; childCount: number; page: string }>;
  assets?: { images: number; vectors: number; imageNames: string[] };
  patterns?: Array<{ signature: string; count: number }>;

  health: {
    textNodes: number;
    unstyledText: number;
    hardcodedColors: number;
    hardcodedWithExistingVariable: number;
  };

  scan: { pageLoads: number; pagesCached: boolean };
}

/* -------------------------------------------------------------------------- */
/* Metrics for the critic (spec §8, §25)                                       */
/* -------------------------------------------------------------------------- */

export interface NodeMetrics {
  id: string;
  /** Real parent id from Figma. Rules rely on this, not on inferred depth. */
  parentId: string | null;
  type: string;
  name: string;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Coordinate space of x/y/w/h. "parent-local" is canonical: converted from
   * absolute boxes so rotated nodes (whose raw x/y are absolute) compare
   * correctly against parent dimensions. "local-unverified" means no absolute
   * box existed and rules must downgrade confidence rather than hard-fail.
   * Absent on older payloads, which rules treat as legacy local.
   */
  coordSpace?: "parent-local" | "local-unverified";
  visible: boolean;
  defaultNamed: boolean;
  zIndex: number;
  opacity?: number;

  fill?: string;
  fillAlpha?: number;
  fillKind?: "gradient" | "image";
  /** Colour actually seen behind this node, composited down the ancestor chain. */
  /**
   * What is actually visible behind this node, composited down the ancestor
   * chain. For TEXT nodes this excludes the node's own fill, because that fill
   * IS the text colour.
   */
  background?: string;
  stroke?: { hex: string; weight: number };
  radius?: number;
  /** Vector artwork structure: subpath and bezier counts for logo/diagram review. */
  vector?: { subpathCount: number; curveCount: number };

  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  primaryAxisSizing?: string;
  counterAxisSizing?: string;

  text?: {
    content: string;
    length: number;
    truncated: boolean;
    size: number | null;
    family: string | null;
    style: string | null;
    color: string | null;
    styled: boolean;
  };

  instanceOf?: string | null;
  componentKey?: string | null;
}

export interface MetricsReport {
  target: string | null;
  scope: string;
  nodes: NodeMetrics[];
  nodeCount: number;
  truncated: boolean;
  /** The cap that was applied, so a truncated result is interpretable. */
  scanBudget: number;
  scan: { pageLoads: number; pagesCached: boolean };
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* Review findings (spec §8, §29)                                              */
/* -------------------------------------------------------------------------- */

export type Confidence = "high" | "medium" | "low";
export type Severity = "critical" | "serious" | "minor";

export interface Finding {
  rule: string;
  confidence: Confidence;
  severity: Severity;
  title: string;
  /** What was measured, in plain numbers. Never a made-up score. */
  evidence: Record<string, string | number | boolean | null>;
  nodeIds: string[];
  /** Pre-validated against OperationSchema; safe to hand straight to modify_design. */
  suggestedOperations?: Operation[];
  /** Present when no safe fix exists, so the model knows to hand-edit. */
  guidance?: string;
  /**
   * Provenance (quality-reliability P1). All optional so older payloads keep
   * working: rule version that emitted this, what kind of evidence backs it,
   * and the coordinate space geometry was measured in.
   */
  ruleVersion?: string;
  evidenceType?: "geometry" | "screenshot" | "accessibility" | "design-system" | "heuristic";
  coordinateSpace?: "parent-local" | "local-unverified" | "legacy";
}

export interface ReviewReport {
  scope: string;
  reviewedNodes: number;
  truncated: boolean;
  summary: {
    total: number;
    high: number;
    medium: number;
    low: number;
    critical: number;
    byRule: Record<string, number>;
  };
  /** Auto-fix eligible per spec §29. Everything else needs approval. */
  autoFixable: number;
  findings: Finding[];
  scan: { pageLoads: number; pagesCached: boolean };
}

/* -------------------------------------------------------------------------- */
/* Plugin <-> server socket messages                                           */
/* -------------------------------------------------------------------------- */

export interface RegisterMessage {
  type: "register";
  fileKey: string | null;
  fileName: string;
  pageId: string;
  pageName: string;
  selection: Array<{ id: string; type: string; name: string }>;
  pluginVersion: string;
  /** Secret presented by the plugin UI. Never a Figma access token. */
  secret?: string;
}

export interface WelcomeMessage {
  type: "welcome";
  sessionId: string;
  heartbeatMs: number;
}

export interface StateMessage {
  type: "state";
  pageId: string;
  pageName: string;
  selection: Array<{ id: string; type: string; name: string }>;
  editorType: string;
  at: number;
}

export interface RequestMessage {
  type: "request";
  requestId: string;
  tool: PluginToolName;
  payload: unknown;
}

export interface ResultMessage {
  type: "result";
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface DisconnectMessage {
  type: "disconnect";
  reason: string;
}

/**
 * A one-way server-to-plugin notification.
 *
 * Requests demand answers; notifications do not. This is the live-streaming
 * channel: agent activity ("review_design found 3 findings") and render
 * previews flow to the panel as they happen, so the user watches the work
 * instead of wondering whether anything is happening. Dropped silently by
 * older clients that do not know the type.
 */
export type NotifyMessage =
  | { type: "notify"; kind: "activity"; text: string; at: number }
  | { type: "notify"; kind: "preview"; label: string; mimeType: string; data: string; at: number };

/**
 * Upstream build progress: plugin -> server.
 *
 * The main thread already posts per-chunk progress to the iframe panel, but
 * the server never saw it — so a 2-minute build looked stalled from ChatGPT's
 * side until the final result arrived (or the 60s timeout fired first and the
 * late commit "randomly popped up" afterwards). Forwarding the same
 * done/total/label/phase upstream lets the server extend its timeout and log
 * the build instead of timing out on silence.
 */
export interface ProgressMessage {
  type: "progress";
  requestId?: string;
  transactionId?: string;
  done: number;
  total: number;
  label: string;
  phase: "started" | "applying" | "done" | "failed";
  at: number;
}

export type ServerMessage = WelcomeMessage | RequestMessage | DisconnectMessage | NotifyMessage;
export type ClientMessage = RegisterMessage | StateMessage | ResultMessage | ProgressMessage;

/* -------------------------------------------------------------------------- */
/* Tool names — the single dispatch table                                      */
/* -------------------------------------------------------------------------- */

/**
 * The MCP surface — what ChatGPT sees.
 *
 * `review_design` and `audit_design` are computed on the server from
 * `collect_metrics`, so they are not in the plugin list below.
 */
export const TOOL_NAMES = [
  "figma_status",
  "inspect_selection",
  "inspect_file",
  "inspect_design_system",
  "collect_metrics",
  "render_design",
  "review_design",
  "audit_design",
  "design_runtime",
  "runtime_primitives",
  "compile_ir",
  "find_component",
  "create_component",
  "create_instance",
  "find_node",
  "set_variant",
  "update_component",
  "create_component_set",
  "seed_exo_system",
  "score_design",
  "critique_visual",
  "refine_screen",
  "diff_design",
  "final_qa",
  "export_code",
  "migrate_to_tokens",
  "audit_components",
  "prototype_flow",
  "design_snapshot",
  "project_memory",
  "design_guard",
  "plan_screen",
  "design_brief",
  "create_slide",
  "create_design",
  "modify_design",
  "native_design",
  "undo_last_operation",
  "figdes_use_figma",
  "figdes_inspect_visual",
  "figdes_read_context",
  "compare_visuals",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The dispatch table the plugin actually implements.
 *
 * Several entries are data providers with no MCP equivalent of their own:
 * `extract_design_system` feeds `inspect_design_system`, `collect_metrics`
 * feeds `review_design`, `render_node` feeds `render_design`, and
 * `find_components` feeds `find_component`. Keeping the two lists separate
 * stops the plugin from claiming a tool it does not implement.
 */
export const PLUGIN_TOOL_NAMES = [
  "figma_status",
  "inspect_selection",
  "inspect_file",
  "extract_design_system",
  "collect_metrics",
  "render_node",
  "reset_render_budget",
  "find_components",
  "create_component",
  "create_instance",
  "find_node",
  "set_variant",
  "update_component",
  "create_component_set",
  "list_variables",
  "create_design",
  "modify_design",
  "native_design",
  "execute_figma_script",
  "undo_last_operation",
] as const;

export type PluginToolName = (typeof PLUGIN_TOOL_NAMES)[number];

export interface StatusResult {
  connected: boolean;
  message?: string;
  sessionId?: string;  /** Human name for the plugin session: "Exo Labs — Chatgpt Designs". */
  sessionName?: string;
  fileName?: string;
  fileKey?: string | null;
  pageId?: string;
  pageName?: string;
  selection?: Array<{ id: string; type: string; name: string }>;
  selectionCount?: number;
  pluginVersion?: string;
  lastSeen?: number;
  /**
   * True when the socket is open but no app message arrived recently (busy
   * main thread or throttled panel). The session still receives tool calls;
   * this flag tells the user why it looks quiet, instead of showing gone.
   */
  stale?: boolean;
  /**
   * Named MCP client connections (ChatGPT, Claude Code, …), most-recent
   * first, each with its in-flight tool calls. This is how you see who is
   * working on what when several agents share one server.
   */
  clients?: ClientConnection[];
  /** Latest tool activity across all clients, newest first (bounded). */
  activity?: ClientActivity[];
}

/**
 * One named MCP client connection, as reported by its own handshake.
 *
 * `display` is the prettified name ("ChatGPT"); `reported` is the raw
 * clientInfo string. Grouped by reported name: two tabs of one client are
 * one entry with a call count, because stateless HTTP gives us nothing to
 * tell them apart — and pretending otherwise would be a lie.
 */
export interface ClientConnection {
  key: string;
  display: string;
  reported: string;
  version: string;
  firstSeen: number;
  lastSeen: number;
  lastSeenAgoMs: number;
  calls: number;
  errors: number;
  lastTool: string;
  lastTarget: string;
  lastStatus: string;
  active: Array<{ tool: string; target: string; forMs: number }>;
}

/** One finished tool call, newest activity first. Bounded to the latest 50. */
export interface ClientActivity {
  at: number;
  client: string;
  tool: string;
  target: string;
  status: "ok" | "error";
  detail?: string;
}

/* -------------------------------------------------------------------------- */
/* Render (spec §8)                                                             */
/* -------------------------------------------------------------------------- */

export interface RenderRequest {
  nodeId: string;
  /**
   * Output width in CSS pixels. Clamped to 2048.
   *
   * This is the main context lever: image token cost is driven by tile count, so
   * a 1024px render costs roughly a quarter of a 2048px one.
   */
  maxWidth?: number;
  /** Detail level. "low" halves the token cost, for shape-level checks. */
  detail?: "low" | "high";
  format?: "png" | "jpg";
  scale?: number;
}

export interface RenderResult {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
  scale: number;
  format: string;
  detail: "low" | "high";
  byteLength: number;
  /** base64 length, which is what actually crosses the wire. */
  base64Length: number;
  estimatedTokens: number;
  data: string;
  budget: {
    tokensSpent: number;
    softLimit: number;
    hardLimit: number;
    overSoftLimit: boolean;
  };
  /** True when output is smaller than the node, so detail is lost. */
  downscaled: boolean;
}

/* -------------------------------------------------------------------------- */
/* Component awareness (spec §21)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Component discovery exists so the model asks "does this already exist?"
 * before rebuilding a card from rectangles, which is the single biggest source
 * of design-system drift.
 */
export interface ComponentSummary {
  id: string;
  name: string;
  type: "COMPONENT" | "COMPONENT_SET" | "INSTANCE";
  description: string;
  /** Property names on a COMPONENT or COMPONENT_SET. */
  properties: string[];
  /** Children in a COMPONENT_SET. */
  variantCount?: number;
  width: number;
  height: number;
  /** How many instances reference this component. A high count means "reuse this". */
  instanceCount: number;
}

export interface FindComponentsResult {
  /** True when the file holds more components than were returned. */
  truncated: boolean;
  total: number;
  /** Fuzzy matches, best first. Empty when no query was given. */
  matches: Array<{ component: ComponentSummary; score: number; reason: string }>;
}

export interface CreateComponentResult {
  componentId: string;
  componentSetId: string | null;
  name: string;
  description: string;
  properties: string[];
}

export interface CreateInstanceResult {
  instanceId: string;
  name: string;
  componentId: string;
  width: number;
  height: number;
}

/**
 * Semantic node lookup (spec §3).
 *
 * Addressing by intent ("the primary action on V4 Home") instead of raw ids.
 * Every match carries its reason, so a surprising result is inspectable rather
 * than silently acted on.
 */
export interface FindNodeResult {
  truncated: boolean;
  total: number;
  matches: Array<{
    id: string;
    type: string;
    name: string;
    score: number;
    reason: string;
    path: string[];
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }>;
  searched: { screen?: string; role?: string; name?: string; text?: string };
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the plugin panel shows.
 *
 * The panel is glanceable, not a second analysis surface: it answers "is my
 * selection healthy, and what does this file already use?" on one screen. Deep
 * analysis stays with the critic over MCP, where results are durable.
 *
 * Nothing here needs the Design Agent server - it is all read straight from the
 * Figma API, so the panel stays useful while the server is offline.
 */
export interface PanelSummary {
  fileName: string;
  pageName: string;
  pageCount: number;
  pluginVersion: string;

  selection: Array<{
    id: string;
    type: string;
    name: string;
    width: number;
    height: number;
    childCount: number;
  }>;
  selectionCount: number;

  system: {
    colors: string[];
    colorCount: number;
    spacingBase: number;
    typeRamp: string[];
    componentCount: number;
    variableCount: number;
    defaultNamed: number;
  };

  contrast: Array<{
    nodeId: string;
    nodeName: string;
    ratio: number;
    required: number;
  }>;
  contrastChecked: number;
  contrastUnmeasurable: number;

  /** True when a scan hit its budget, so the panel can label itself partial. */
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Plugin UI  <->  plugin main thread (postMessage)                            */
/* -------------------------------------------------------------------------- */

export type UiToMain =
  | { kind: "ready" }
  | { kind: "connected"; status: string; sessionId?: string }
  | { kind: "disconnected"; reason: string }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string }
  | { kind: "config"; url: string; secret?: string }
  | { kind: "refresh-panel" }
  | { kind: "select-node"; nodeId: string }
  | { kind: "request"; requestId: string; tool: PluginToolName; payload: unknown };

export type MainToUi =
  | { kind: "server-config"; url: string; secret?: string; pluginVersion: string }
  | { kind: "response"; requestId: string; ok: boolean; data?: unknown; error?: string }
  | { kind: "panel-summary"; summary: PanelSummary }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string }
  | {
      kind: "progress";
      transactionId?: string;
      done: number;
      total: number;
      label: string;
      phase: "started" | "applying" | "done" | "failed";
    };