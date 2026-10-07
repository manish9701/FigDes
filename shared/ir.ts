/**
 * Design IR — the intermediate representation between model intent and Figma
 * nodes (spec §41, §42, §43).
 *
 * ## Why this exists
 *
 * Measured: a modest dashboard needs ~28 primitive operations and ~1,050 tokens
 * of JSON for the model to emit, while the whole tool round-trip is ~21 ms.
 * Generation is roughly 840x the transport cost, so slowness is a *payload*
 * problem, not a plumbing problem.
 *
 * The fix is not a faster socket. It is giving the model fewer, fatter units to
 * emit. A screen written as regions plus semantic components costs a fraction of
 * the tokens, and the coordinates get computed here instead of guessed by the
 * model — which is also why the output is more likely to be correct.
 *
 * ## What this deliberately is not
 *
 * It is not a code string and it is never `eval`'d. The IR is plain JSON, parsed
 * by zod, then compiled. See `runtime/interpreter.ts` for the escape hatch.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Design tokens. Values may come from the file's own variables (by name) or be
 * literal. Resolution happens at compile time, so the IR stays declarative.
 */
export const TokenRefSchema = z.union([
  z.string().describe('A literal like "#F7F5EF", "8", or a variable name like "color/surface".'),
  z.number(),
]);

/* -------------------------------------------------------------------------- */
/* Regions                                                                     */
/* -------------------------------------------------------------------------- */

export const RegionSchema = z
  .object({
    id: z.string().min(1).max(64),
    /** Semantic role. Drives default sizing and is what composition modes key off. */
    role: z
      .enum([
        "navigation",
        "header",
        "hero",
        "primary-visual",
        "content",
        "secondary",
        "inspector",
        "status-rail",
        "footer",
        "custom",
      ])
      .default("custom"),
    /** Composition hint. The layout engine uses it; it is never drawn. */
    composition: z
      .enum(["editorial", "instrument", "canvas", "topology", "table", "timeline", "split-view", "spatial", "auto"])
      .default("auto"),
    /**
     * How this region's children are arranged (spec §17).
     *
     * `flow` is the default vertical stack. `grid` is a fixed-column row wrap.
     * The rest delegate to `algorithms.ts`; `topology` picks `tree` when links
     * are supplied and `cluster` when they are not.
     */
    layout: z.enum(["flow", "grid", "tree", "cluster", "masonry", "timeline", "radial", "force", "topology"]).default("flow"),
    /** Column count for `grid` / `masonry`. Derived from width when omitted. */
    columns: z.number().int().min(1).max(24).optional(),
    /** Flexible size hints. The engine resolves these against the canvas. */
    width: z.union([z.literal("fill"), z.literal("hug"), z.number().positive()]).default("hug"),
    height: z.union([z.literal("fill"), z.literal("hug"), z.number().positive()]).default("hug"),
    /** Weight when distributing leftover space along this axis. 0 means no growth. */
    grow: z.number().min(0).max(10).default(0),
    gap: z.number().min(0).max(400).optional(),
    padding: z.union([z.number().min(0), z.object({ top: z.number(), right: z.number(), bottom: z.number(), left: z.number() })]).optional(),
    fill: TokenRefSchema.optional(),
    radius: z.number().min(0).optional(),
    children: z.array(z.string().max(64)).default([]),
  })
  .strict();

export type Region = z.infer<typeof RegionSchema>;

/* -------------------------------------------------------------------------- */
/* Content                                                                     */
/* -------------------------------------------------------------------------- */

export const TextSpecSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal("text"),
    text: z.string().max(4000),
    role: z.enum(["eyebrow", "title", "subtitle", "body", "label", "value", "caption", "code"]).default("body"),
    size: z.number().positive().max(400).optional(),
    family: z.string().max(200).optional(),
    weight: z.number().int().min(100).max(900).optional(),
    fill: TokenRefSchema.optional(),
    maxWidth: z.number().positive().optional(),
    /**
     * Letter-spacing in pixels. Positive values space a wordmark out; the
     * tracked-out capitals of a wordmark are what separate it from a label.
     */
    letterSpacing: z.number().min(-100).max(1000).optional(),
  })
  .strict();

export const ShapeSpecSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal("shape"),
    shape: z.enum(["rect", "ellipse", "line", "polygon", "star"]).default("rect"),
    fill: TokenRefSchema.optional(),
    stroke: TokenRefSchema.optional(),
    strokeWeight: z.number().min(0).max(64).optional(),
    radius: z.number().min(0).optional(),
    opacity: z.number().min(0).max(1).optional(),
    /**
     * Sides for `polygon` (3-24), points for `star`.
     *
     * Computed into path data by the compiler rather than drawn by hand, for the
     * same reason coordinates are computed: one vertex off and a hexagon reads
     * as a mistake.
     */
    sides: z.number().int().min(3).max(24).default(6),
    /** Inner radius ratio for `star`. 0.382 is the classical five-point star. */
    innerRatio: z.number().min(0.05).max(0.95).default(0.382),
    /** Rotation in degrees. -90 puts the first vertex at the top. */
    rotation: z.number().min(-360).max(360).default(-90),
  })
  .strict();

/**
 * A vector path.
 *
 * SVG path data is validated against a deliberately narrow grammar rather than
 * a general regex, and only the absolute commands the runtime implements are
 * accepted. This is data, not code — see `runtime/geometry.ts`.
 */
export const VectorSpecSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal("vector"),
    path: z.string().min(1).max(4000).describe("SVG path data: M, L, C, Q, Z. Absolute coordinates only."),
    fill: TokenRefSchema.optional(),
    stroke: TokenRefSchema.optional(),
    strokeWeight: z.number().min(0).max(64).default(1),
  })
  .strict();

/**
 * A semantic component. These are the units that stop the model from
 * reassembling a card out of six rectangles every time (spec §6).
 */
export const ComponentSpecSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal("component"),
    type: z
      .enum([
        "metric",
        "statusPill",
        "deviceNode",
        "topologyMap",
        "modelRow",
        "sectionHeader",
        "navItem",
        "panel",
        "button",
        "divider",
        "logoMark",
        "placementMap",
        "shardBlock",
        "memoryBudget",
        "fitGauge",
        "compatibilityMatrix",
      ])
      .default("panel"),
    props: z
      .record(
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.union([z.string(), z.number()])),
          // Rows and other small structured values (e.g. compatibilityMatrix
          // rows). Flat records only: anything nested is rejected, so props can
          // never smuggle an opaque blob into the compiler.
          z.array(z.record(z.union([z.string(), z.number(), z.boolean()]))),
        ]),
      )
      .default({}),
  })
  .strict();

/**
 * A connector between two nodes (spec §16).
 *
 * This is the spec's `connector({ from, to, routing, label })`. Stored as data
 * rather than a pre-computed path so the geometry can be solved against the
 * boxes that were actually placed — a path baked by the model would not land on
 * the node it names.
 */
export const ConnectorSpecSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal("connector"),
    /** Node id. May reference a region or a content node. */
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    routing: z.enum(["straight", "orthogonal", "curved"]).default("orthogonal"),
    /** Optional caption placed at the route's midpoint. */
    label: z.string().max(120).optional(),
    stroke: TokenRefSchema.optional(),
    strokeWeight: z.number().min(0).max(24).default(1),
    arrowStart: z.boolean().default(false),
    arrowEnd: z.boolean().default(true),
    dashPattern: z.array(z.number().min(0).max(64)).max(8).optional(),
    /** Bow for `curved` routing, as a fraction of the chord. */
    curvature: z.number().min(-2).max(2).default(0.2),
  })
  .strict();

export type ConnectorSpec = z.infer<typeof ConnectorSpecSchema>;

/**
 * A reusable variable / style definition (spec §22).
 *
 * Emitted before the nodes that use them, so a global refinement later is a
 * single edit rather than a sweep over hardcoded values.
 */
export const TokenSpecSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal("token"),
    name: z.string().min(1).max(120),
    type: z.enum(["color", "number", "string", "boolean"]),
    /** Collection name. Defaults to the runtime's own collection. */
    collection: z.string().max(120).optional(),
    /**
     * Values keyed by mode name. A single unnamed entry creates the default
     * value; several create a variable collection with modes.
     */
    values: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    /** Scopes the value, e.g. `CORNER_RADIUS`, `FONT_SIZE`, `GAP`. */
    scopes: z
      .array(z.enum(["ALL_SCOPES", "CORNER_RADIUS", "FONT_SIZE", "GAP", "WIDTH_HEIGHT", "OPACITY", "LETTER_SPACING", "LINE_HEIGHT"]))
      .max(8)
      .optional(),
    description: z.string().max(400).optional(),
  })
  .strict();

export type TokenSpec = z.infer<typeof TokenSpecSchema>;

/** A text style definition (spec §22). */
export const TextStyleSpecSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal("textStyle"),
    name: z.string().min(1).max(120),
    family: z.string().min(1).max(200).default("Inter"),
    weight: z.number().int().min(100).max(900).default(400),
    fontSize: z.number().positive().max(1000).default(16),
    lineHeight: z.number().positive().max(5000).optional(),
    letterSpacing: z.number().min(-100).max(1000).optional(),
    /** Hex fill applied by the style. */
    fill: TokenRefSchema.optional(),
  })
  .strict();

export type TextStyleSpec = z.infer<typeof TextStyleSpecSchema>;

/** A paint (colour) style definition (spec §22). */
export const PaintStyleSpecSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.literal("paintStyle"),
    name: z.string().min(1).max(120),
    color: z.string().min(1).max(64),
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();

export type PaintStyleSpec = z.infer<typeof PaintStyleSpecSchema>;

export const ContentSchema = z.discriminatedUnion("kind", [
  TextSpecSchema,
  ShapeSpecSchema,
  VectorSpecSchema,
  ComponentSpecSchema,
  ConnectorSpecSchema,
]);

export type ContentSpec = z.infer<typeof ContentSchema>;

/* -------------------------------------------------------------------------- */
/* Canvas + root document                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A canvas dimension.
 *
 * Accepts a number, `"fill"`, or `"hug"` so a region and a canvas can share the
 * same vocabulary. Out-of-range numbers fall back rather than failing the whole
 * screen — a bad width should not cost the user their design.
 */
const CanvasSize = z.union([z.literal("fill"), z.literal("hug"), z.number().positive().max(20000)]);

export const CanvasSchema = z
  .object({
    name: z.string().max(200).default("Screen"),
    width: CanvasSize.default(1440),
    height: CanvasSize.default(900),
    fill: TokenRefSchema.optional(),
    /** Base grid used for snapping and for the spacing scale. */
    grid: z.number().positive().max(200).default(8),
    /** Place the screen on a new page. Off keeps it on the current page. */
    newPage: z.boolean().default(false),
    /**
     * Deck mode (Figma Slides).
     *
     * When true, every region becomes its own 1920x1080 slide instead of a frame
     * on a shared canvas. One program, one deck. Relations between regions are
     * meaningless across slides and are skipped with a warning; connectors must
     * stay inside a single slide.
     */
    deck: z.boolean().default(false),
  })
  .strict();

/** Resolves a canvas dimension to a number, since the canvas cannot be flexible. */
export function canvasSize(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

/**
 * A visual intent layer (FigDes §4).
 *
 * Primitives describe what information exists; intent describes how it should
 * be *seen*: what the eye finds first, how dense the screen feels, whether the
 * composition is calm or insistent. Still structured data, still no eval — but
 * it is the difference between a UI compiler and an art director.
 *
 * Every field is optional and every field has a neutral default, so omitting
 * intent degrades to current behaviour rather than failing. Intent never invents
 * coordinates; it biases the decisions the layout engine already makes.
 */
export const VisualIntentSchema = z
  .object({
    /** Overall manner: technical-editorial, instrument, calm, dense... */
    style: z.string().min(1).max(60).optional(),
    /** Symmetric, asymmetric, radial, editorial... */
    composition: z.string().min(1).max(60).optional(),
    /** airy | calm | balanced | dense */
    density: z.enum(["airy", "calm", "balanced", "dense"]).optional(),
    /** Region or content id the eye should find first. */
    focal: z.string().min(1).max(64).optional(),
    /** Relative visual weight per region/content id, 0-1. */
    visualWeight: z.record(z.number().min(0).max(1)).default({}),
    /** flat | subtle | layered */
    depth: z.enum(["flat", "subtle", "layered"]).optional(),
    /** tight | even | generous */
    rhythm: z.enum(["tight", "even", "generous"]).optional(),
    /** loose | strong */
    alignment: z.enum(["loose", "strong"]).optional(),
    /** muted | restrained | bold */
    contrast: z.enum(["muted", "restrained", "bold"]).optional(),
  })
  .strict();

export type VisualIntent = z.infer<typeof VisualIntentSchema>;

/**
 * A relationship constraint (spec §18).
 *
 * Kept in the IR as data, solved by `runtime/constraints.ts`. The alternative —
 * having the model compute a coordinate — is the failure mode this replaces.
 */
export const RelationSchema = z
  .object({
    /** Node this constrains. Must be a region id or a content id. */
    id: z.string().min(1).max(64),
    /** Anchor box to sit to the right of. */
    rightOf: z.string().min(1).max(64).optional(),
    /** Anchor box to sit below. */
    below: z.string().min(1).max(64).optional(),
    alignTo: z.enum(["start", "center", "end", "stretch", "top", "middle", "bottom", "baseline"]).optional(),
    top: z.number().finite().optional(),
    left: z.number().finite().optional(),
    right: z.number().finite().optional(),
    bottom: z.number().finite().optional(),
    width: z.union([z.literal("fill"), z.literal("hug"), z.number().positive()]).optional(),
    height: z.union([z.literal("fill"), z.literal("hug"), z.number().positive()]).optional(),
    /** Distance from the anchor. */
    gap: z.number().min(0).max(2000).optional(),
    /** Distance from the parent's edges. */
    inset: z.number().min(0).max(2000).optional(),
  })
  .strict();

export type Relation = z.infer<typeof RelationSchema>;

export const DesignIRSchema = z
  .object({
    canvas: CanvasSchema,
    regions: z.array(RegionSchema).min(1).max(40),
    content: z.array(ContentSchema).max(800).default([]),
    /** Relationship constraints applied after the shell layout (spec §18). */
    relations: z.array(RelationSchema).max(200).default([]),
    /** Variable, text style and paint style definitions (spec §22). */
    tokens: z
      .array(z.discriminatedUnion("kind", [TokenSpecSchema, TextStyleSpecSchema, PaintStyleSpecSchema]))
      .max(200)
      .default([]),
    /**
     * Named links used by the `tree` and `force` layouts, and by connectors.
     * Declared separately from connectors because a link does not have to be
     * drawn — a topology can be laid out as a tree and left unconnected.
     */
    links: z
      .array(z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64), label: z.string().max(120).optional() }).strict())
      .max(400)
      .default([]),
    /**
     * How the screen should be seen (FigDes §4). Optional; omitting it
     * degrades to current behaviour rather than failing.
     */
    visualIntent: VisualIntentSchema.optional(),
    /** Optional product constraints checked after compiling (spec §29, §51). */
    constraints: z
      .object({
        noGenericCardGrid: z.boolean().default(false),
        maxMetricCards: z.number().int().min(0).max(24).optional(),
        noChatAsPrimary: z.boolean().default(false),
      })
      .partial()
      .optional(),
  })
  .strict();

export type DesignIR = z.infer<typeof DesignIRSchema>;

/* -------------------------------------------------------------------------- */
/* Resolved form (post-compile)                                                */
/* -------------------------------------------------------------------------- */

export interface ResolvedRegion extends Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResolvedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box that knows its own id, which is what a relation or connector names. */
export interface PlacedBox extends ResolvedBox {
  id: string;
}

export interface CompileResult {
  /** Ordered operations, ready to hand to the transaction executor. */
  operations: unknown[];
  regions: ResolvedRegion[];
  /** Every placed box by id: regions and content. */
  boxes: Map<string, PlacedBox>;
  /** Populated when a constraint was violated. Never silently ignored. */
  violations: Array<{ rule: string; message: string }>;
  stats: {
    regionCount: number;
    contentCount: number;
    operationCount: number;
    layoutMs: number;
    /** Algorithms actually invoked, keyed by region id. */
    algorithms: Record<string, string>;
    /** How many boxes moved because of a relation rather than the shell layout. */
    constrained: number;
    /** How many text layers were re-flowed because a relation resized a region. */
    reflowed: number;
  };
}