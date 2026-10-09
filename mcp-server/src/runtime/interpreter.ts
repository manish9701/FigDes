/**
 * Design Runtime — the safe escape hatch (spec §3, §4, §45).
 *
 * ## The security decision
 *
 * The spec proposes `design_runtime.execute({ program: "..." })`. Executing that
 * string would be `eval` / `new Function` on model output — which the same
 * document forbids in §34 and §45, and which this codebase has never had.
 *
 * So the escape hatch exists, but it takes **JSON that names built-in
 * primitives**, not code. The model chooses *what* to build from a rich
 * vocabulary; the runtime decides *how*. Nothing from the model is ever
 * compiled, evaluated, or interpreted as code. There is no `program` string, no
 * expression parser, and no dynamic dispatch on model-provided strings.
 *
 * ## What this actually buys
 *
 * The model stops emitting coordinates and stops counting nodes. A metric card
 * is one semantic unit instead of four primitives, and layout is computed. That
 * is where the speed and the quality both come from — not from a bigger API.
 */
import { z } from "zod";
import {
  canvasSize,
  ComponentSpecSchema,
  ConnectorSpecSchema,
  DesignIRSchema,
  PaintStyleSpecSchema,
  ShapeSpecSchema,
  TextSpecSchema,
  TextStyleSpecSchema,
  TokenSpecSchema,
  VectorSpecSchema,
  VisualIntentSchema,
  type DesignIR,
  type VisualIntent,
} from "../../../shared/ir";
import { compileIR, TYPE_SCALE } from "./compile";
import { parseConstraint } from "./constraints";
import { compileVisual } from "./visual";
import { resolveStyleTokens, presetAlignment } from "./visual-presets";
import { VisualConceptSchema } from "../../../shared/ir";

/* -------------------------------------------------------------------------- */
/* The runtime vocabulary                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every callable the model may invoke.
 *
 * This is the complete surface. Adding a capability here is the only way to
 * widen what the model can build, which keeps the review surface small enough to
 * actually audit.
 */
export const RUNTIME_PRIMITIVES = {
  screen: {
    description: "A full screen canvas.",
    kind: "canvas" as const,
  },
  frame: { description: "A rectangular region.", kind: "region" as const },
  slide: { description: "One slide in a deck: a full-bleed 1920x1080 visual composition.", kind: "region" as const },
  stage: { description: "The primary visual stage inside a slide: the focal artifact.", kind: "region" as const },
  column: { description: "One column inside a multi-column composition.", kind: "region" as const },
  navigation: { description: "A side or top navigation rail.", kind: "region" as const },
  header: { description: "A page header band.", kind: "region" as const },
  hero: { description: "The primary visual region.", kind: "region" as const },
  inspector: { description: "A side detail panel.", kind: "region" as const },
  stack: { description: "A vertically stacked group.", kind: "region" as const },
  grid: { description: "A multi-column group.", kind: "region" as const },
  text: { description: "A text layer.", kind: "content" as const },
  shape: { description: "A rectangle, ellipse or line.", kind: "content" as const },
  vector: { description: "A bezier path with custom geometry: M/L/C/Q/S/T/A/Z, beziers preserved.", kind: "content" as const },
  vectorPlan: { description: "A constructed logo path: silhouette -> cutout -> mirror -> refine, executed as geometry.", kind: "content" as const },
  booleanGroup: { description: "A native boolean combination (union, subtract, intersect, exclude) of sibling shapes.", kind: "content" as const },
  metric: { description: "A labelled metric with a value and optional delta.", kind: "content" as const },
  statusPill: { description: "A small status badge.", kind: "content" as const },
  deviceNode: { description: "A machine in a topology map.", kind: "content" as const },
  navItem: { description: "One navigable item.", kind: "content" as const },
  panel: { description: "A titled content panel.", kind: "content" as const },
  button: { description: "A primary action.", kind: "content" as const },
  divider: { description: "A hairline rule.", kind: "content" as const },
  sectionHeader: { description: "A section title.", kind: "content" as const },
  sectionDivider: { description: "A labelled section divider for decks and editorial layouts.", kind: "content" as const },
  modelRow: { description: "A row in a model table.", kind: "content" as const },
  topologyMap: { description: "A node-link visualization region.", kind: "content" as const },
  placementMap: { description: "A model-to-machine placement diagram: model requirement, machines, shard assignments.", kind: "content" as const },
  shardBlock: { description: "One model shard: a captioned block with its size and target machine.", kind: "content" as const },
  memoryBudget: { description: "A used/total memory bar with a mono readout.", kind: "content" as const },
  fitGauge: { description: "A fits-or-not verdict pill for a model against cluster memory.", kind: "content" as const },
  compatibilityMatrix: { description: "Model-by-machine fit rows with verdicts.", kind: "content" as const },
  logoMark: { description: "A deterministic geometric logo mark: ring, orbit, chevron, hex, bars, prism, wave, grid, shield, bolt, lens, arc.", kind: "content" as const },
  logoGrid: { description: "Construction grid + clearspace guides for a logo mark.", kind: "content" as const },
  logoLockup: { description: "A complete logo: mark plus tracked-out wordmark, optically aligned.", kind: "content" as const },
  flowNode: { description: "One step box in a flow/process diagram.", kind: "content" as const },
  decisionDiamond: { description: "A decision diamond in a flow diagram.", kind: "content" as const },
  timelineEvent: { description: "One dated event on a timeline.", kind: "content" as const },
  chartBar: { description: "A bar-chart scaffold from labelled values.", kind: "content" as const },
  chartLine: { description: "A line-chart scaffold from an ordered series.", kind: "content" as const },
  chartPie: { description: "A pie/donut scaffold from labelled shares.", kind: "content" as const },
  callout: { description: "An annotation callout pointing at a feature.", kind: "content" as const },
  annotation: { description: "A small captioned annotation.", kind: "content" as const },
  quoteBlock: { description: "A large typographic statement with attribution.", kind: "content" as const },
  imageFrame: { description: "An image placeholder frame with crop and caption.", kind: "content" as const },
  slideMaster: { description: "A reusable slide master: background, title slot and footer.", kind: "content" as const },
  deckOutline: { description: "A deck narrative outline: acts that become differently-composed slides.", kind: "content" as const },
  stat: { description: "A large-number stat for slides and infographics.", kind: "content" as const },
  bullets: { description: "A bullet list for slides.", kind: "content" as const },
  template: { description: "An instance of a user-defined template from the program's templates list.", kind: "content" as const },
  connector: { description: "A routed line between two nodes, with an optional label.", kind: "content" as const },
  variable: { description: "A reusable design token (colour, number, string or boolean).", kind: "content" as const },
  textStyle: { description: "A named typography style.", kind: "content" as const },
  paintStyle: { description: "A named colour style.", kind: "content" as const },
} as const;

export type PrimitiveName = keyof typeof RUNTIME_PRIMITIVES;

export const PRIMITIVE_NAMES = Object.keys(RUNTIME_PRIMITIVES) as PrimitiveName[];

/* -------------------------------------------------------------------------- */
/* Call schema                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One runtime call. `fn` must be a known primitive name; the compiler maps it to
 * the right IR node kind. Unknown names are rejected, not ignored.
 */
/**
 * Argument keys each primitive understands.
 *
 * Kept explicit so an unrecognised key can be *reported* rather than silently
 * dropped. This is the safety property that replaces a rejected `program`
 * string: a model writing `program: "..."` gets told it is not a valid argument,
 * instead of the string being quietly ignored and the call doing nothing.
 */
const REGION_ARGS = new Set([
  "width",
  "height",
  "grow",
  "gap",
  "padding",
  "fill",
  "radius",
  "composition",
  "layout",
  "columns",
  "gridColumns",
  "gridGutter",
]);
const CONTENT_ARGS = new Set([
  "text",
  "content",
  "role",
  "size",
  "family",
  "weight",
  "letterSpacing",
  "fill",
  "maxWidth",
  "stroke",
  "strokeWeight",
  "radius",
  "opacity",
  "shape",
  "path",
  // Vector geometry: beziers preserved, booleans native.
  "windingRule",
  "strokeCap",
  "strokeJoin",
  "closed",
  "axis",
  "operation",
  "targets",
  "steps",
  "cutout",
  "grid",
  "wordmark",
  "optical",
  // Shape geometry
  "sides",
  "innerRatio",
  "rotation",
  // Logo marks
  "mark",
  "size",
  // Semantic component props
  "label",
  "value",
  "delta",
  "title",
  "memory",
  "surface",
  "color",
  // Natural component states (spec §4). These read like product design rather
  // than schema archaeology, which is precisely why they were missing: every one
  // of them was rejected as an "unknown argument" during real EXO testing.
  "state",
  "active",
  "tone",
  "variant",
  "valueStyle",
  "mono",
  "health",
  "compute",
  "selected",
  "selectedNode",
  "status",
  "action",
  // Topology content
  "nodes",
  "edges",
  "latency",
  "bandwidth",
  "shard",
  "placement",
  // Placement content
  "model",
  "required",
  "available",
  "machines",
  "assignments",
  "fits",
  "machine",
  "verdict",
  "detail",
  "used",
  "total",
  "usedLabel",
  "totalLabel",
  "unit",
  "rows",
  // State strips: every state-capable component accepts `states: [...]`.
  "states",
  // Connector args
  "from",
  "to",
  "routing",
  "arrowStart",
  "arrowEnd",
  "curvature",
  "dashPattern",
  // Visualization + deck args
  "subtitle",
  "body",
  "items",
  "values",
  "labels",
  "series",
  "shares",
  "date",
  "quote",
  "author",
  "caption",
  "src",
  "alt",
  "acts",
  "background",
  "footer",
  "accent",
  "number",
  // Token / style args
  "name",
  "type",
  "values",
  "collection",
  "scopes",
  "description",
  "lineHeight",
  "letterSpacing",
]);

export const RuntimeCallSchema = z.object({
  fn: z.enum(PRIMITIVE_NAMES as [PrimitiveName, ...PrimitiveName[]]),
  args: z.record(z.unknown()).default({}),
  /** Optional transaction-local id, so later calls can reference this node. */
  id: z.string().min(1).max(64).optional(),
  /** Which region this belongs to. Defaults to the first region. */
  parent: z.string().max(64).optional(),
});

/** Returns the argument keys a primitive does not recognise. */
export function unknownArgs(fn: PrimitiveName, args: Record<string, unknown>): string[] {
  const allowed = RUNTIME_PRIMITIVES[fn].kind === "region" ? REGION_ARGS : CONTENT_ARGS;
  return Object.keys(args).filter((k) => !allowed.has(k));
}

export type RuntimeCall = z.infer<typeof RuntimeCallSchema>;

/**
 * A user-defined reusable pattern (spec §20, without code).
 *
 * This is the declarative form of the spec's design functions. A template is
 * data: a name, default parameter values, and a body made only of existing
 * runtime calls. It is expanded before layout and compilation, so there is no
 * second execution model and no way for a template to do anything a normal
 * content call cannot do.
 */
export const TemplateDefinitionSchema = z
  .object({
    name: z.string().min(1).max(32),
    parameters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    body: z.array(RuntimeCallSchema).min(1).max(40),
  })
  .strict();

export type TemplateDefinition = z.infer<typeof TemplateDefinitionSchema>;

/**
 * Built-in reusable patterns.
 *
 * The everyday patterns every screen needs: a page header, a field row, an
 * action row, a section, an empty state, an error state. Defined once here so
 * every screen builds them identically — a header assembled six different ways
 * across six screens is how a design system quietly forks.
 *
 * User definitions win on name conflict: a project-specific header replaces the
 * built-in one rather than competing with it.
 */
export const BUILTIN_TEMPLATES: TemplateDefinition[] = [
  {
    name: "page-header",
    parameters: { eyebrow: "", title: "Title", subtitle: "" },
    body: [
      { fn: "text", id: "eyebrow", args: { text: "{{eyebrow}}", role: "eyebrow" } },
      { fn: "text", id: "title", args: { text: "{{title}}", role: "title" } },
      { fn: "text", id: "subtitle", args: { text: "{{subtitle}}", role: "subtitle" } },
      { fn: "divider", id: "rule", args: {} },
    ],
  },
  {
    name: "field-row",
    parameters: { label: "Label", value: "—" },
    body: [
      { fn: "text", id: "label", args: { text: "{{label}}", role: "label" } },
      { fn: "text", id: "value", args: { text: "{{value}}", role: "value" } },
    ],
  },
  {
    name: "action-row",
    parameters: { primary: "Continue", secondary: "Cancel" },
    body: [
      { fn: "button", id: "primary", args: { label: "{{primary}}", variant: "primary" } },
      { fn: "button", id: "secondary", args: { label: "{{secondary}}", variant: "quiet" } },
    ],
  },
  {
    name: "section",
    parameters: { title: "Section" },
    body: [
      { fn: "sectionHeader", id: "header", args: { title: "{{title}}" } },
      { fn: "divider", id: "rule", args: {} },
    ],
  },
  {
    name: "empty-state",
    parameters: { title: "Nothing here yet", body: "Get started to fill this view.", action: "Get started" },
    body: [
      { fn: "text", id: "title", args: { text: "{{title}}", role: "title" } },
      { fn: "text", id: "body", args: { text: "{{body}}", role: "body" } },
      { fn: "button", id: "action", args: { label: "{{action}}", variant: "primary" } },
    ],
  },
  {
    name: "error-state",
    parameters: { title: "Something went wrong", body: "Try again.", action: "Retry" },
    body: [
      { fn: "statusPill", id: "flag", args: { label: "Error", tone: "error" } },
      { fn: "text", id: "title", args: { text: "{{title}}", role: "title" } },
      { fn: "text", id: "body", args: { text: "{{body}}", role: "body" } },
      { fn: "button", id: "action", args: { label: "{{action}}", variant: "primary" } },
    ],
  },
];

/** Names reserved for built-ins, so a user template cannot shadow them by accident. */
export const BUILTIN_TEMPLATE_NAMES = new Set(BUILTIN_TEMPLATES.map((t) => t.name));

/**
 * Runtime program shape.
 *
 * `regions` has no zod minimum here: an empty array produces a clear error
 * inside `executeRuntime` rather than a raw zod issue dump, because "your program
 * had no regions" is more actionable than a min-length violation.
 */
/**
 * Runtime program shape.
 *
 * The canvas is deliberately loose (`z.record(z.unknown())`) and validated by
 * hand in `executeRuntime`. A strict schema here would reject an unusable
 * canvas width outright and cost the user the whole screen, when the right
 * behaviour is to fall back to a default and say so.
 */
export const RuntimeProgramSchema = z.object({
  canvas: z.record(z.unknown()).optional(),
  /** Top-level regions, in order. */
  regions: z.array(RuntimeCallSchema).max(40).default([]),
  /** Anything inside a region. */
  content: z.array(RuntimeCallSchema).max(800).default([]),
  /**
   * A plan_screen output, used directly.
   *
   * The plan's regions become this program's regions, so the model never
   * retypes geometry it already approved: plan_screen() → design_runtime() with
   * no manual translation between the two coordinate systems. Explicit regions
   * in the program are appended after the plan's, and explicit canvas wins over
   * the plan's canvas.
   */
  plan: z.record(z.unknown()).optional(),
  /**
   * User-defined reusable patterns.
   *
   * Instantiated with `{ fn: "template", args: { name, values } }`. Expansion is
   * bounded and non-recursive: template bodies may not contain other templates.
   */
  templates: z.array(TemplateDefinitionSchema).max(50).default([]),
  /**
   * Relationship constraints (spec §18): `{ id, rightOf, gap, width }`.
   *
   * Loose on purpose. Each entry is validated individually so one bad relation
   * reports itself and the rest still apply.
   */
  relations: z.array(z.record(z.unknown())).max(200).default([]),
  /** Named links used by tree/force layouts and by connectors (spec §17). */
  links: z
    .array(
      z
        .object({
          from: z.string().min(1).max(64),
          to: z.string().min(1).max(64),
          label: z.string().max(120).optional(),
        })
        .strict(),
    )
    .max(400)
    .default([]),
  /**
   * How the screen should be seen (FigDes §4). Validated strictly but applied
   * leniently: an uninterpretable intent warns and is ignored, because guessing
   * at taste is worse than defaulting to it.
   */
  visualIntent: z.record(z.unknown()).optional(),
  /**
   * Visual IR concepts: focal, anchor, cluster, field, stage, lens, trace,
   * layer, orbit, zone. Each entry is validated individually; bad entries warn
   * and skip while the rest compile.
   */
  visual: z.array(z.record(z.unknown())).max(100).default([]),
  constraints: DesignIRSchema.shape.constraints,
});

export type RuntimeProgram = z.infer<typeof RuntimeProgramSchema>;

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

export interface RuntimeResult {
  ir: DesignIR;
  operations: unknown[];
  violations: Array<{ rule: string; message: string }>;
  stats: {
    calls: number;
    regions: number;
    content: number;
    operationCount: number;
    layoutMs: number;
    /** How many primitives the model used instead of hand-rolled operations. */
    semanticUnits: number;
  };
  /** Populated when a call referenced a primitive that does not apply here. */
warnings: string[];
  /** What the visual intent changed, in plain language. Not warnings. */
  intentNotes: string[];
  /** Algorithms invoked per region, so the caller can see what was chosen. */
  algorithms: Record<string, string>;
  /** How many relations were applied. */
  constrained: number;
  /** How many text layers were re-flowed because a relation resized a region. */
  reflowed: number;
  /** Placed geometry by node id. Connectors are resolved against this. */
  boxes: Map<string, { id: string; x: number; y: number; w: number; h: number }>;
}

/**
 * Interprets a structured program into a Design IR, then compiles it.
 *
 * Two passes: the first establishes regions so content has somewhere to land,
 * the second places content. Unknown or misused primitives produce warnings
 * rather than exceptions, because dropping one card is better than failing a
 * whole screen — but the warnings are returned so the caller always knows.
 */
export function executeRuntime(input: unknown): RuntimeResult {
  const warnings: string[] = [];

  // Parsed leniently so a single bad field cannot cost the user the whole
  // design. Anything unusable falls back to a sane default and is reported.
  const program = RuntimeProgramSchema.safeParse(input);
  if (!program.success) {
    const issue = program.error.issues[0];
    throw new Error(
      `Malformed runtime program: ${issue?.message ?? "could not be parsed"}` +
        (issue?.path.length ? ` (at ${issue.path.join(".")})` : "") +
        ". Expected { canvas?, regions: [{ fn, id?, args }], content?: [{ fn, id?, parent?, args }] }.",
    );
  }

  const parsedProgram = program.data;
  const rawCanvas = parsedProgram.canvas as Record<string, unknown> | undefined;
  const intentNotes: string[] = [];

  // A plan_screen output carries its own canvas and regions. Explicit program
  // fields win where both exist; the plan fills the gaps. Anything in the plan
  // that is not a valid region call is reported and skipped, never trusted.
  const planRegions = extractPlanRegions(parsedProgram.plan, warnings);
  const regionCalls = [...planRegions, ...parsedProgram.regions];
  const planIntent = parsedProgram.visualIntent === undefined ? extractPlanIntent(parsedProgram.plan, warnings) : undefined;

  // Visual intent is parsed strictly but applied leniently: an uninterpretable
  // intent warns once and is ignored, because guessing at taste is worse than
  // defaulting to it. The plan's intent applies only when the program states
  // none of its own.
  let intent: VisualIntent | undefined;
  const intentSource = parsedProgram.visualIntent !== undefined ? parsedProgram.visualIntent : planIntent;
  if (intentSource !== undefined) {
    const parsed = VisualIntentSchema.safeParse(intentSource);
    if (parsed.success) {
      intent = parsed.data;
      if (parsedProgram.visualIntent === undefined && planIntent !== undefined) {
        intentNotes.push("Visual intent inherited from the plan; stating visualIntent overrides it wholesale.");
      }
    } else {
      warnings.push(`Visual intent ignored: ${parsed.error.issues[0]?.message}. The program builds with default taste.`);
    }
  }

  // Style presets: named manners that fill in whatever the intent leaves unset.
  // An explicit field always wins over its preset — presets are defaults with
  // opinions, not overrides. The registry lives in visual-presets.ts: curated
  // presets, accordion shorthands ("compact" expands to "dense, quiet"), and
  // compound directives ("dense, warm"). Contradictory pairs ("airy" with
  // "dense") are rejected with a warning and default taste, because building
  // the average of two opposing manners would be guessing. Unknown names are
  // reported, never guessed at.
  if (intent?.style !== undefined) {
    const resolved = resolveStyleTokens(intent.style);
    for (const note of resolved.notes) intentNotes.push(note);
    for (const warning of resolved.warnings) warnings.push(warning);
    // Only intent-native mechanics fill intent fields, and only when unset.
    // Presentation mechanics (spacing, align, typography, surfaces, numbers,
    // shape, sizing, warmth, contentDensity, colorUsage) travel with the IR
    // style value into the compiler, which applies them in builders.
    if (typeof resolved.mechanics.density === "string" && (intent as Record<string, unknown>).density === undefined) {
      (intent as Record<string, unknown>).density = resolved.mechanics.density;
    }
    if (typeof resolved.mechanics.contrast === "string" && (intent as Record<string, unknown>).contrast === undefined) {
      (intent as Record<string, unknown>).contrast = resolved.mechanics.contrast;
    }
    if (resolved.mechanics.align !== undefined && (intent as Record<string, unknown>).alignment === undefined) {
      const bridged = presetAlignment(resolved.mechanics.align);
      if (bridged !== undefined) (intent as Record<string, unknown>).alignment = bridged;
    }
  }
  // Density rescales the spacing system. Airy means roomier gutters, padding and
  // gaps everywhere; dense tightens them. One multiplier keeps every derived
  // measurement consistent instead of special-casing each one.
  // (Style presets above may have filled density in; explicit still won.)
  const GAP_SCALE: Record<string, number> = { airy: 1.5, calm: 1.25, balanced: 1, dense: 0.75 };
  const gapScale = intent?.density ? (GAP_SCALE[intent.density] ?? 1) : 1;
  const baseGrid = typeof rawCanvas?.grid === "number" && rawCanvas.grid > 0 ? rawCanvas.grid : 8;

  const canvas = {
    name: typeof rawCanvas?.name === "string" ? rawCanvas.name : "Screen",
    width: canvasSize(rawCanvas?.width, 1440),
    height: canvasSize(rawCanvas?.height, 900),
    grid: Math.round(baseGrid * gapScale * 100) / 100,
    newPage: rawCanvas?.newPage === true,
    // Deck mode reinterprets every region as a 1920x1080 slide. It is read here
    // rather than inferred, because guessing "this looks like a deck" from the
    // content would be wrong exactly when it mattered.
    deck: rawCanvas?.deck === true,
    ...(rawCanvas?.fill !== undefined ? { fill: coerceToken(rawCanvas.fill) } : {}),
  };

  if (intent?.density && gapScale !== 1) {
    intentNotes.push(`Density '${intent.density}' scaled the spacing system to ${canvas.grid}px.`);
  }

  if (rawCanvas && (typeof rawCanvas.width !== "number" || typeof rawCanvas.height !== "number")) {
    warnings.push(
      `Canvas size fell back to ${canvas.width}x${canvas.height}; ` +
        `"${String(rawCanvas.width)}x${String(rawCanvas.height)}" is not a usable size.`,
    );
  }

  /* ---------------------------------------------------- regions ---------- */

  const regions: DesignIR["regions"] = [];
  const regionIds = new Set<string>();

  for (const call of regionCalls) {
    const def = RUNTIME_PRIMITIVES[call.fn];
    if (def.kind !== "region") {
      warnings.push(`'${call.fn}' is a content primitive and cannot be used as a region.`);
      continue;
    }

    const id = call.id ?? `region-${regions.length + 1}`;
    if (regionIds.has(id)) {
      warnings.push(`Duplicate region id '${id}' ignored.`);
      continue;
    }
    regionIds.add(id);

const args = call.args as Record<string, unknown>;

    // A `program: "..."` style argument is the exact shape the design document
    // proposed. It is reported rather than ignored, so the model learns the
    // runtime has no code path instead of watching its call silently do nothing.
    const stray = unknownArgs(call.fn, args);
    if (stray.length > 0) {
      warnings.push(
        `'${call.fn}' does not accept ${stray.map((k) => `'${k}'`).join(", ")}. ` +
          `This runtime takes declarative arguments only and never executes code strings.`,
      );
    }

// A region that grows must also fill along the cross axis. "hug" there would
    // resolve to zero width inside a side rail and the region would vanish, so
    // `grow` and `fill` are kept consistent.
    const grow = coerceNumber(args.grow, 0, 0, 10);
    const width = coerceSize(args.width, grow > 0 ? "fill" : "hug");
    const height = coerceSize(args.height, grow > 0 ? "fill" : "hug");

    if (grow > 0 && (width === "hug" || height === "hug")) {
      warnings.push(`Region '${id}' has grow: ${grow} but hugs on one axis; treating that axis as fill.`);
    }

regions.push({
      id,
      role: coerceRole(call.fn),
      composition: coerceComposition(args.composition),
      layout: coerceLayout(args.layout, compositionHint(args.composition)),
      ...(args.columns !== undefined ? { columns: coerceNumber(args.columns, 1, 1, 24) } : {}),
      width,
      height,
      grow,
      ...(args.gap !== undefined ? { gap: coerceNumber(args.gap, 0, 0, 400) } : {}),
      ...(args.padding !== undefined ? { padding: coercePadding(args.padding) } : {}),
      ...(args.fill !== undefined ? { fill: coerceToken(args.fill) } : {}),
      ...(args.radius !== undefined ? { radius: coerceNumber(args.radius, 0, 0, 200) } : {}),
      ...(args.gridColumns !== undefined ? { gridColumns: Math.max(1, Math.min(24, Math.round(Number(args.gridColumns) || 12))) } : {}),
      ...(args.gridGutter !== undefined ? { gridGutter: coerceNumber(args.gridGutter, 24, 0, 400) } : {}),
      elevation: 0,
      children: [],
    });
  }

  if (regions.length === 0) {
    throw new Error("A runtime program needs at least one region primitive (frame, navigation, header, hero, inspector).");
  }

  // Visual IR concepts compile here, after regions exist and before content is
  // parented. Concepts that create regions append them (grow and validation
  // below then see the full set); member claims reparent content calls; traces
  // append connector calls; focal feeds intent. Template-expanded items cannot
  // be targeted — their ids are namespaced at expansion — so visual references
  // the declared ids of top-level content calls.
  const visualReparents = new Map<string, string>();
  const visualTraceConnectors: RuntimeCall[] = [];
  if (parsedProgram.visual.length > 0) {
    const declaredContent = new Set(
      parsedProgram.content.map((c, i) => (typeof c.id === "string" && c.id ? c.id : `__positional-${i}`)),
    );
    const concepts: Array<{ id: string; kind: string; target?: string; members?: string[]; zone?: string; from?: string; to?: string; label?: string; title?: string }> = [];
    for (const raw of parsedProgram.visual) {
      const parsed = VisualConceptSchema.safeParse({
        id: typeof raw.id === "string" ? raw.id : "",
        kind: typeof raw.kind === "string" ? raw.kind : "",
        ...(typeof raw.target === "string" ? { target: raw.target } : {}),
        ...(Array.isArray(raw.members) ? { members: raw.members } : {}),
        ...(typeof raw.zone === "string" ? { zone: raw.zone } : {}),
        ...(typeof raw.from === "string" ? { from: raw.from } : {}),
        ...(typeof raw.to === "string" ? { to: raw.to } : {}),
        ...(typeof raw.label === "string" ? { label: raw.label } : {}),
        ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      });
      if (!parsed.success) {
        warnings.push(`Visual concept skipped: ${parsed.error.issues[0]?.message}. Concepts need an id and a known kind.`);
        continue;
      }
      concepts.push(parsed.data);
    }

    const plan = compileVisual(concepts, regionIds, declaredContent);
    warnings.push(...plan.warnings);
    for (const region of plan.regions) {
      regions.push(region);
      regionIds.add(region.id);
    }
    for (const [contentId, regionId] of plan.reparents) visualReparents.set(contentId, regionId);
    if (plan.focal !== undefined && intent?.focal === undefined) {
      const base: VisualIntent = intent ?? { visualWeight: {} };
      intent = { ...base, focal: plan.focal };
      intentNotes.push(`Focal point '${plan.focal}' set by the visual layer.`);
    }
    if (plan.elevated.length > 0) {
      intentNotes.push(`Depth: ${plan.elevated.length} region(s) carry elevation.`);
    }
    visualTraceConnectors.push(...plan.connectors);
  }

  // Visual weight becomes growth: a region with weight 0.9 absorbs slack like
  // grow 2, weight 0.35 like grow 1, weight 0.15 like grow 0. The focal region
  // grows hardest, because the thing the eye finds first needs the room to be
  // found in. Declared grow always wins ties: explicit beats inferred.
  //
  // Weights may also name content objects, not just regions: the hero is often
  // a topology or a chart *inside* a region. Content weights cannot move boxes
  // (packing owns positions), so they become emphasis — larger, bolder type —
  // applied when the text spec is built below. Unknown keys are validated after
  // the content loop, once content ids actually exist.
  const contentWeights = new Map<string, number>();
  let contentFocal: string | undefined;
  if (intent && (Object.keys(intent.visualWeight).length > 0 || intent.focal !== undefined)) {
    for (const region of regions) {
      const weight = intent.visualWeight[region.id];
      if (weight !== undefined) {
        const inferred = Math.round(weight * 2);
        if (inferred > region.grow) {
          region.grow = inferred;
          intentNotes.push(`Region '${region.id}' grows with weight ${weight} (grow ${inferred}).`);
        }
      }
      if (intent.focal === region.id && region.grow < 2) {
        region.grow = 2;
        intentNotes.push(`Region '${region.id}' is the focal point and absorbs slack first.`);
      }
    }
    if (intent.focal !== undefined && !regionIds.has(intent.focal)) {
      contentFocal = intent.focal;
    }
    for (const [key, weight] of Object.entries(intent.visualWeight)) {
      if (!regionIds.has(key)) contentWeights.set(key, weight);
    }
  }

/* ---------------------------------------------------- content --------- */

  const content: DesignIR["content"] = [];
  /**
   * Tokens and styles live in their own IR section rather than in `content`.
   *
   * They are not drawn, and a region does not contain them. Keeping them
   * separate is what lets the compiler emit them once at the top of the plan
   * instead of trying to place a variable inside a frame.
   */
  const tokens: DesignIR["tokens"] = [];
  const templateMap = buildTemplateMap(parsedProgram.templates, warnings);

  // Templates expand to ordinary calls before parenting. This keeps one code path
  // for validation, layout and compilation, and bounds the total output.
  const calls: RuntimeCall[] = [];
  let templateUses = 0;
  let topologyUses = 0;
  let expansionCapped = false;
  // Topology expansion contributes layout links as well as content, so the
  // parsed list is copied: input stays immutable, the IR gets the full graph.
  const links: RuntimeProgram["links"] = [...parsedProgram.links];
  const pushCall = (call: RuntimeCall): void => {
    if (calls.length >= 800) {
      if (!expansionCapped) {
        expansionCapped = true;
        warnings.push("Content stopped at 800 items; the rest of the program was not expanded.");
      }
      return;
    }
    calls.push(call);
  };

  // A top-level link is a relationship the layout already uses for placement —
  // but nothing drew it, so topology screens rendered nodes with no edges.
  // Synthesize one connector call per link so the edge is visible. A
  // hand-written connector for the same pair wins: explicit drawing always
  // beats synthesis, and the synthesis never duplicates it.
  {
    const drawn = new Set<string>();
    for (const call of parsedProgram.content) {
      if (call.fn !== "connector") continue;
      const a = call.args as Record<string, unknown>;
      if (typeof a.from === "string" && typeof a.to === "string") drawn.add(`${a.from}→${a.to}`);
    }
    for (const link of links) {
      const key = `${link.from}→${link.to}`;
      if (drawn.has(key)) continue;
      drawn.add(key);
      pushCall({
        fn: "connector",
        id: `link-${link.from}-${link.to}`.slice(0, 64),
        args: { from: link.from, to: link.to, ...(link.label !== undefined ? { label: link.label } : {}) },
      });
    }
  }

  for (const call of parsedProgram.content) {
    if (call.fn === "template") {
      templateUses += 1;
      for (const item of expandTemplateCall(call, templateMap, templateUses, warnings)) pushCall(item);
      continue;
    }
    // A topologyMap carrying nodes desugars into deviceNodes plus connectors
    // (spec §5). The map itself draws nothing: the nodes and their routed edges
    // ARE the visualization, laid out by the region's tree/cluster algorithm
    // and connected by the same solver as hand-written connectors.
    if (call.fn === "topologyMap" && Array.isArray((call.args as Record<string, unknown>).nodes)) {
      topologyUses += 1;
      for (const item of expandTopologyMap(call, links, topologyUses, warnings)) pushCall(item);
      continue;
    }
    if (call.fn === "placementMap") {
      topologyUses += 1;
      for (const item of expandPlacementMap(call, links, topologyUses, warnings)) pushCall(item);
      continue;
    }
    // Interaction states expand to one sibling per state (FigDes §28): a design
    // is not a single screenshot, and Pass 4 needs the states drawn, not
    // described. Each sibling carries the state in its id, so the strip reads
    // without captions.
    if (
      (call.fn === "button" || call.fn === "statusPill" || call.fn === "navItem" || call.fn === "deviceNode") &&
      Array.isArray((call.args as Record<string, unknown>).states)
    ) {
      for (const item of expandStates(call, warnings)) pushCall(item);
      continue;
    }
    pushCall(call);
  }

  // Traces compiled from the visual layer join the stream like hand-written
  // connectors, parented normally below.
  for (const trace of visualTraceConnectors) pushCall(trace);

  for (const call of calls) {
    const def = RUNTIME_PRIMITIVES[call.fn];
    const id = call.id ?? `node-${content.length + 1}`;

    if (def.kind !== "content") {
      warnings.push(`'${call.fn}' is a region primitive and belongs in 'regions'.`);
      continue;
    }

const args = call.args as Record<string, unknown>;

    // A visual claim overrides an explicit parent with exactly one warning: the
    // visual block is authoritative for its members, but a conflict means the
    // program disagrees with itself and the author should know.
    let effectiveParent = call.parent;
    if (id && visualReparents.has(id)) {
      const claimed = visualReparents.get(id)!;
      if (call.parent !== undefined && call.parent !== claimed) {
        warnings.push(`'${id}' was claimed by the visual layer into '${claimed}' instead of '${call.parent}'.`);
      }
      effectiveParent = claimed;
    }

    const stray = unknownArgs(call.fn, args);
    if (stray.length > 0) {
      warnings.push(
        `'${call.fn}' does not accept ${stray.map((k) => `'${k}'`).join(", ")}. ` +
          `This runtime takes declarative arguments only and never executes code strings.`,
      );
    }

    // Tokens and styles are document-level, not drawn inside a region, so they
    // claim no parent. Adding them to `children` would make the compiler look
    // for geometry that does not exist.
    const documentLevel = call.fn === "variable" || call.fn === "textStyle" || call.fn === "paintStyle";

    if (!documentLevel) {
      const parentId = effectiveParent && regionIds.has(effectiveParent) ? effectiveParent : regions[0]!.id;
      if (effectiveParent && !regionIds.has(effectiveParent)) {
        warnings.push(`Unknown parent '${effectiveParent}' for '${id}'; placed in '${regions[0]!.id}'.`);
      }
      regions.find((r) => r.id === parentId)!.children.push(id);
    }

    switch (call.fn) {
      case "text": {
        // Content-level emphasis: a weight >= 0.7 or the focal id enlarges and
        // emboldens this text against the same role scale the compiler uses, so
        // estimateHeight accounts for it automatically. Below 0.7 the text is
        // left alone: emphasis that moves everything moves nothing.
        const emphasis = contentFocal === id || (contentWeights.get(id) ?? 0) >= 0.7;
        const role = ((args.role as never) ?? "body") as keyof typeof TYPE_SCALE;
        const roleSize = TYPE_SCALE[role]?.size ?? TYPE_SCALE.body!.size;
        const roleWeight = TYPE_SCALE[role]?.weight ?? TYPE_SCALE.body!.weight;
        const parsed = TextSpecSchema.safeParse({
          id,
          kind: "text",
          text: String(args.text ?? args.content ?? ""),
          role: (args.role as never) ?? "body",
          size: emphasis ? Math.round((typeof args.size === "number" ? args.size : roleSize) * 1.25) : args.size !== undefined ? coerceNumber(args.size, 16, 1, 400) : undefined,
          ...(args.family !== undefined ? { family: String(args.family) } : {}),
          weight: emphasis
            ? Math.max(typeof args.weight === "number" ? args.weight : 0, roleWeight, 600)
            : args.weight !== undefined
              ? coerceNumber(args.weight, 400, 100, 900)
              : undefined,
          ...(args.letterSpacing !== undefined ? { letterSpacing: coerceNumber(args.letterSpacing, 0, -100, 1000) } : {}),
          ...(args.fill !== undefined ? { fill: coerceToken(args.fill) } : {}),
          ...(args.maxWidth !== undefined ? { maxWidth: coerceNumber(args.maxWidth, 0, 1, 20000) } : {}),
        });
        if (parsed.success) {
          content.push(parsed.data);
          if (emphasis) intentNotes.push(`Text '${id}' emphasized by visual intent (larger, bolder).`);
        } else warnings.push(`Text '${id}' rejected: ${parsed.error.issues[0]?.message}`);
        break;
      }

case "shape": {
        const parsed = ShapeSpecSchema.safeParse({
          id,
          kind: "shape",
          shape: (args.shape as never) ?? "rect",
          ...(args.fill !== undefined ? { fill: coerceToken(args.fill) } : {}),
          ...(args.stroke !== undefined ? { stroke: coerceToken(args.stroke) } : {}),
          ...(args.radius !== undefined ? { radius: coerceNumber(args.radius, 0, 0, 200) } : {}),
          ...(args.opacity !== undefined ? { opacity: coerceNumber(args.opacity, 1, 0, 1) } : {}),
          ...(args.sides !== undefined ? { sides: Math.max(3, Math.min(24, Math.round(Number(args.sides) || 6))) } : {}),
          ...(args.innerRatio !== undefined ? { innerRatio: coerceNumber(args.innerRatio, 0.382, 0.05, 0.95) } : {}),
          ...(args.rotation !== undefined ? { rotation: coerceNumber(args.rotation, -90, -360, 360) } : {}),
        });
        if (parsed.success) content.push(parsed.data);
        else warnings.push(`Shape '${id}' rejected: ${parsed.error.issues[0]?.message}`);
        break;
      }

      case "vector": {
        const parsed = VectorSpecSchema.safeParse({
          id,
          kind: "vector",
          path: String(args.path ?? ""),
          ...(args.stroke !== undefined ? { stroke: coerceToken(args.stroke) } : {}),
          ...(args.fill !== undefined ? { fill: coerceToken(args.fill) } : {}),
          ...(args.strokeWeight !== undefined ? { strokeWeight: coerceNumber(args.strokeWeight, 1, 0, 64) } : {}),
          ...(typeof args.windingRule === "string" && ["NONE", "NONZERO", "EVENODD"].includes(args.windingRule) ? { windingRule: args.windingRule } : {}),
          ...(typeof args.strokeCap === "string" ? { strokeCap: args.strokeCap } : {}),
          ...(typeof args.strokeJoin === "string" ? { strokeJoin: args.strokeJoin } : {}),
          ...(args.closed !== undefined ? { closed: args.closed === true } : {}),
          ...(Array.isArray(args.dashPattern) ? { dashPattern: args.dashPattern as number[] } : {}),
        });
        if (parsed.success) content.push(parsed.data);
        else warnings.push(`Vector '${id}' rejected: ${parsed.error.issues[0]?.message}`);
        break;
      }

      case "connector": {
        const parsed = ConnectorSpecSchema.safeParse({
          id,
          kind: "connector",
          from: String(args.from ?? ""),
          to: String(args.to ?? ""),
          routing: coerceRouting(args.routing),
          ...(args.label !== undefined ? { label: String(args.label) } : {}),
          ...(args.stroke !== undefined ? { stroke: coerceToken(args.stroke) } : {}),
          strokeWeight: coerceNumber(args.strokeWeight, 1, 0, 24),
          arrowStart: args.arrowStart === true,
          arrowEnd: args.arrowEnd !== false,
          curvature: coerceNumber(args.curvature, 0.2, -2, 2),
          ...(Array.isArray(args.dashPattern) ? { dashPattern: args.dashPattern as number[] } : {}),
        });
        if (parsed.success) content.push(parsed.data);
        else warnings.push(`Connector '${id}' rejected: ${parsed.error.issues[0]?.message}. It needs both 'from' and 'to'.`);
        break;
      }

      case "variable": {
        const type = coerceVariableType(args.type);
        const parsed = TokenSpecSchema.safeParse({
          id,
          kind: "token",
          name: String(args.name ?? id),
          type,
          ...(args.collection !== undefined ? { collection: String(args.collection) } : {}),
          values: coerceTokenValues(args.values ?? shorthandTokenValue(args, type), type),
          ...(Array.isArray(args.scopes) ? { scopes: args.scopes } : {}),
          ...(args.description !== undefined ? { description: String(args.description) } : {}),
        });
        if (parsed.success) tokens.push(parsed.data);
        else warnings.push(`Variable '${id}' rejected: ${parsed.error.issues[0]?.message}`);
        break;
      }

      case "textStyle": {
        const parsed = TextStyleSpecSchema.safeParse({
          id,
          kind: "textStyle",
          name: String(args.name ?? id),
          family: typeof args.family === "string" ? args.family : "Inter",
          weight: coerceNumber(args.weight, 400, 100, 900),
          fontSize: coerceNumber(args.size ?? args.fontSize, 16, 1, 1000),
          ...(args.lineHeight !== undefined ? { lineHeight: coerceNumber(args.lineHeight, 20, 1, 5000) } : {}),
          ...(args.letterSpacing !== undefined ? { letterSpacing: coerceNumber(args.letterSpacing, 0, -100, 1000) } : {}),
          ...(args.fill !== undefined ? { fill: coerceToken(args.fill) } : {}),
        });
        if (parsed.success) tokens.push(parsed.data);
        else warnings.push(`Text style '${id}' rejected: ${parsed.error.issues[0]?.message}`);
        break;
      }

      case "paintStyle": {
        const parsed = PaintStyleSpecSchema.safeParse({
          id,
          kind: "paintStyle",
          name: String(args.name ?? id),
          color: typeof args.color === "string" ? args.color : typeof args.fill === "string" ? args.fill : "#000000",
          opacity: coerceNumber(args.opacity, 1, 0, 1),
        });
        if (parsed.success) tokens.push(parsed.data);
        else warnings.push(`Paint style '${id}' rejected: ${parsed.error.issues[0]?.message}`);
        break;
      }

      default: {
        const parsed = ComponentSpecSchema.safeParse({
          id,
          kind: "component",
          type: componentTypeFor(call.fn),
          props: args,
        });
        if (parsed.success) {
          content.push(parsed.data);
          // A `surface: "surface-02"` style directive is not a colour, but it
          // still emits: the build proceeds with the literal value while the
          // note tells the model to bind it to a style downstream.
          const surface = (args as Record<string, unknown>).surface;
          if (typeof surface === "string" && /^surface-\d+$/i.test(surface)) {
            intentNotes.push(`'${surface}' is a surface directive, not a colour: emitted literally so the build proceeds; bind it to a style downstream.`);
          }
        } else warnings.push(`Component '${id}' rejected: ${parsed.error.issues[0]?.message}`);
        break;
      }
    }
  }

  // Content-level intent keys are validated now that content ids exist. A key
  // matching neither a region nor a placed node names nothing, and is reported
  // naming both namespaces so the fix is obvious.
  if (contentWeights.size > 0 || contentFocal !== undefined) {
    const placed = new Set<string>();
    for (const region of regions) for (const child of region.children) placed.add(child);
    if (contentFocal !== undefined && !placed.has(contentFocal)) {
      warnings.push(`Visual intent names focal '${contentFocal}', which matches no region or content. The focal boost was skipped.`);
    }
    for (const key of contentWeights.keys()) {
      if (!placed.has(key)) {
        warnings.push(`Visual weight names '${key}', which matches no region or content. That weight was skipped.`);
      }
    }
  }

  /* ---------------------------------------------------- compile ---------- */

  const ir: DesignIR = {
    canvas,
    regions,
    content,
    relations: parseRelations(parsedProgram.relations, warnings),
    tokens,
    links,
    ...(intent !== undefined ? { visualIntent: intent } : {}),
    ...(parsedProgram.constraints ? { constraints: parsedProgram.constraints } : {}),
  };

  const compiled = compileIR(ir);

  return {
    ir,
    operations: compiled.operations,
    violations: compiled.violations,
    boxes: compiled.boxes,
    algorithms: compiled.stats.algorithms,
    constrained: compiled.stats.constrained,
    reflowed: compiled.stats.reflowed,
    stats: {
      calls: regionCalls.length + parsedProgram.content.length,
      regions: compiled.stats.regionCount,
      content: compiled.stats.contentCount,
      operationCount: compiled.stats.operationCount,
      layoutMs: compiled.stats.layoutMs,
      semanticUnits: parsedProgram.content.filter((c) => RUNTIME_PRIMITIVES[c.fn].kind === "content").length,
    },
    warnings,
    intentNotes,
  };
}

/**
 * Builds the template lookup, reporting duplicates separately.
 *
 * Built-ins load first and user definitions override them silently: replacing
 * the project header is a customization, not a conflict worth warning about.
 * Two user definitions under one name keep the first and report the second,
 * because silently merging two different bodies would make every later instance
 * unpredictable.
 */
function buildTemplateMap(raw: TemplateDefinition[], warnings: string[]): Map<string, TemplateDefinition> {
  const map = new Map<string, TemplateDefinition>(BUILTIN_TEMPLATES.map((t) => [t.name, t]));
  const seen = new Set<string>();
  for (const def of raw) {
    if (BUILTIN_TEMPLATE_NAMES.has(def.name)) {
      // A project-specific header replaces the built-in one. Customization, not
      // conflict: no warning.
      map.set(def.name, def);
      continue;
    }
    if (seen.has(def.name)) {
      warnings.push(`Duplicate template name '${def.name}' ignored; the first definition wins.`);
      continue;
    }
    seen.add(def.name);
    map.set(def.name, def);
  }
  return map;
}

function namespacedTemplateId(instanceId: string, bodyKey: string): string {
  const key = bodyKey.length > 40 ? bodyKey.slice(-40) : bodyKey;
  const suffix = `__${key}`;
  if ((instanceId + suffix).length <= 64) return instanceId + suffix;
  return `${instanceId.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
}

function substituteTemplateValue(value: unknown, params: Record<string, string | number | boolean>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/);
    if (exact) {
      const replacement = params[exact[1]!];
      return replacement === undefined ? value : replacement;
    }
    return value.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) => {
      const replacement = params[key];
      return replacement === undefined ? match : String(replacement);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substituteTemplateValue(entry, params));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = substituteTemplateValue(entry, params);
    return out;
  }
  return value;
}

function findTemplatePlaceholders(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) found.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) findTemplatePlaceholders(entry, found);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) findTemplatePlaceholders(entry, found);
  }
}

/**
 * Expands one `{ fn: "template" }` call into ordinary runtime calls.
 *
 * Expansion happens before regions claim children, so template output flows
 * through the same parenting, validation, layout and compilation as hand-written
 * calls. Templates cannot contain other templates, regions, variables or styles:
 * they are reusable drawable patterns, not a second language.
 */
function expandTemplateCall(
  call: RuntimeCall,
  templates: Map<string, TemplateDefinition>,
  useNumber: number,
  warnings: string[],
): RuntimeCall[] {
  const args = call.args as Record<string, unknown>;
  const stray = unknownArgs("template", args);
  if (stray.length > 0) {
    warnings.push(
      `'template' does not accept ${stray.map((k) => `'${k}'`).join(", ")}. ` +
        `Use { name, values } with a template from the program's templates list.`,
    );
  }

  const name = typeof args.name === "string" ? args.name : "";
  if (!name) {
    warnings.push("Template instance skipped: it has no 'name'.");
    return [];
  }

  const def = templates.get(name);
  if (!def) {
    warnings.push(`Unknown template '${name}'. Define it in the program's templates list before using it.`);
    return [];
  }

  const supplied = args.values;
  const suppliedRecord: Record<string, unknown> =
    supplied && typeof supplied === "object" && !Array.isArray(supplied) ? (supplied as Record<string, unknown>) : {};
  if (args.values !== undefined && (typeof supplied !== "object" || supplied === null || Array.isArray(supplied))) {
    warnings.push(`Template '${name}' ignored its 'values' because they are not an object.`);
  }

  const params: Record<string, string | number | boolean> = { ...def.parameters };
  for (const [key, value] of Object.entries(suppliedRecord)) {
    if (!(key in def.parameters)) {
      warnings.push(`Template '${name}' has no parameter '${key}'; it was ignored.`);
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") params[key] = value;
    else warnings.push(`Template '${name}' ignored non-scalar value for parameter '${key}'.`);
  }

  const instanceId = call.id ?? `template-${useNumber}`;
  const expanded: RuntimeCall[] = [];
  const bodyIds = new Map<string, string>();

  for (let i = 0; i < def.body.length; i++) {
    const body = def.body[i]!;
    if (body.fn === "template") {
      warnings.push(`Template '${name}' skipped a nested template; templates cannot contain other templates.`);
      continue;
    }

    const bodyDef = RUNTIME_PRIMITIVES[body.fn];
    if (bodyDef.kind !== "content") {
      warnings.push(`Template '${name}' skipped '${body.fn}'; template bodies hold drawable content only.`);
      continue;
    }
    if (body.fn === "variable" || body.fn === "textStyle" || body.fn === "paintStyle") {
      warnings.push(`Template '${name}' skipped '${body.fn}'; variables and styles are document-level, not template content.`);
      continue;
    }

    const bodyKey = typeof body.id === "string" && body.id ? body.id : `part-${i + 1}`;
    const newId = namespacedTemplateId(instanceId, bodyKey);
    bodyIds.set(bodyKey, newId);

    if (body.parent !== undefined && body.parent !== call.parent) {
      warnings.push(`Template '${name}' ignored a body parent; instances use the template call's parent.`);
    }

    const substituted = substituteTemplateValue(body.args, params) as Record<string, unknown>;

    // An empty text is not content: it happens when the caller leaves an
    // optional slot (like a subtitle) at its default. Drawing it would leave a
    // blank line of dead space in the layout.
    if (body.fn === "text" && String(substituted.text ?? substituted.content ?? "").length === 0) {
      continue;
    }

    expanded.push({
      fn: body.fn,
      args: substituted,
      id: newId,
      ...(call.parent !== undefined ? { parent: call.parent } : {}),
    });
  }

  // Connectors inside one template can name sibling body parts. Those names only
  // exist before namespacing, so rewrite them to the expanded ids.
  for (const item of expanded) {
    if (item.fn !== "connector") continue;
    const itemArgs = { ...(item.args as Record<string, unknown>) };
    for (const edge of ["from", "to"] as const) {
      const target = itemArgs[edge];
      if (typeof target === "string" && bodyIds.has(target)) itemArgs[edge] = bodyIds.get(target)!;
    }
    item.args = itemArgs;
  }

  const unresolved = new Set<string>();
  for (const item of expanded) findTemplatePlaceholders(item.args, unresolved);
  if (unresolved.size > 0) {
    warnings.push(`Template '${name}' left ${[...unresolved].map((k) => `'${k}'`).join(", ")} without values.`);
  }

  return expanded;
}

/**
 * Expands a topologyMap carrying nodes into deviceNodes plus connectors.
 *
 * Without nodes, a topologyMap keeps its old behaviour (a titled placeholder
 * region the caller fills by hand). With them, the map is real: every node
 * becomes a deviceNode, every edge a routed connector with its latency as the
 * label, and the edges join the program's links so the region's tree/cluster
 * layout arranges the graph instead of stacking it.
 */
function expandTopologyMap(call: RuntimeCall, links: RuntimeProgram["links"], useNumber: number, warnings: string[]): RuntimeCall[] {
  const args = call.args as Record<string, unknown>;
  const rawNodes: unknown[] = Array.isArray(args.nodes) ? args.nodes : [];
  if (rawNodes.length === 0) return [call];

  return expandGraph({
    instanceId: call.id ?? `topology-${useNumber}`,
    parent: call.parent,
    title: typeof args.title === "string" && args.title ? args.title : undefined,
    nodes: rawNodes,
    edges: Array.isArray(args.edges) ? (args.edges as unknown[]) : [],
    selectedId: typeof args.selectedNode === "string" ? args.selectedNode : undefined,
    nodeDefaults: {},
    links,
    warnings,
  });
}

/**
 * Expands a placementMap: model requirement, machines, shard assignments.
 *
 * Built on the same graph expansion as a topology because a placement diagram
 * IS a graph with a fit question attached. The header states the requirement
 * against available memory, the machines are the nodes, and each shard
 * assignment is a routed edge. An explicit `fits` verdict becomes a pill so the
 * answer is drawn, not implied.
 */
function expandPlacementMap(call: RuntimeCall, links: RuntimeProgram["links"], useNumber: number, warnings: string[]): RuntimeCall[] {
  const args = call.args as Record<string, unknown>;
  const rawMachines: unknown[] = Array.isArray(args.machines) ? args.machines : [];
  if (rawMachines.length === 0) return [call];

  const out: RuntimeCall[] = [];
  const instanceId = call.id ?? `placement-${useNumber}`;
  const model = typeof args.model === "string" && args.model ? args.model : "Model";
  const required = typeof args.required === "string" ? args.required : undefined;
  const available = typeof args.available === "string" ? args.available : undefined;

  out.push({
    fn: "sectionHeader",
    args: { title: model },
    id: `${instanceId}-title`,
    ...(call.parent !== undefined ? { parent: call.parent } : {}),
  });
  if (required || available) {
    out.push({
      fn: "text",
      args: {
        text: `Requires ${required ?? "?"} · Available ${available ?? "?"}`,
        role: "body",
      },
      id: `${instanceId}-budget`,
      ...(call.parent !== undefined ? { parent: call.parent } : {}),
    });
  }

  // The model itself participates in the graph when an assignment names it, so
  // edges have a source to route from.
  const rawAssignments: unknown[] = Array.isArray(args.assignments) ? args.assignments : [];
  const namesModel = rawAssignments.some(
    (raw) => raw && typeof raw === "object" && ((raw as Record<string, unknown>).from === "model" || (raw as Record<string, unknown>).to === "model"),
  );
  const nodes: unknown[] = namesModel ? [{ id: "model", label: model }, ...rawMachines] : rawMachines;
  const edges = rawAssignments.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const edge = { ...(raw as Record<string, unknown>) };
    // Shard assignments label themselves with the shard; latency-style labels
    // still win when explicitly given.
    if (typeof edge.shard === "string" && typeof edge.label !== "string") edge.label = edge.shard;
    return edge;
  });

  out.push(
    ...expandGraph({
      instanceId,
      parent: call.parent,
      title: undefined,
      nodes,
      edges,
      selectedId: undefined,
      nodeDefaults: {},
      links,
      warnings,
    }),
  );

  if (args.fits === true || args.fits === false) {
    out.push({
      fn: "statusPill",
      args: args.fits === true ? { label: "Fits", tone: "success" } : { label: "Does not fit", tone: "error" },
      id: `${instanceId}-verdict`,
      ...(call.parent !== undefined ? { parent: call.parent } : {}),
    });
  }

  return out;
}

interface GraphExpansion {
  instanceId: string;
  parent: string | undefined;
  title: string | undefined;
  nodes: unknown[];
  edges: unknown[];
  selectedId: string | undefined;
  nodeDefaults: Record<string, unknown>;
  links: RuntimeProgram["links"];
  warnings: string[];
}

/** Shared node/edge expansion for topologyMap and placementMap. */

/**
 * What a graph node *means* as deviceNode props.
 *
 * `selected` draws the action-blue ring; health tones draw the state stroke;
 * `pressured` maps to the warning tone (amber needs-attention) because the
 * device vocabulary has no pressured state of its own. Unknown statuses warn
 * and are ignored rather than guessed at.
 */
function nodeStatusArgs(status: unknown, warnings: string[], nodeId: string): Record<string, unknown> {
  if (status === undefined) return {};
  if (typeof status !== "string" || status.length === 0) {
    warnings.push(`Graph node '${nodeId}' has an unusable status and it was ignored.`);
    return {};
  }
  const s = status.toLowerCase();
  if (s === "selected") return { selected: true };
  if (s === "healthy" || s === "degraded" || s === "offline" || s === "warning" || s === "success" || s === "error") {
    return { health: s };
  }
  if (s === "pressured") return { health: "warning" };
  warnings.push(`Graph node '${nodeId}' status '${status}' is not a device state and was ignored. Use selected, healthy, degraded, offline, pressured or warning.`);
  return {};
}

/**
 * What an edge's importance *looks like*.
 *
 * Critical edges draw strong (3px, always labelled by the caller); major
 * edges draw medium (2px); minor edges recede (1px dashed). Unknown weights
 * warn and fall back to the default rather than inventing emphasis.
 */
function edgeWeightArgs(weight: unknown, warnings: string[], index: number): Record<string, unknown> {
  if (weight === undefined) return {};
  if (weight === "critical") return { strokeWeight: 3 };
  if (weight === "major") return { strokeWeight: 2 };
  if (weight === "minor") return { strokeWeight: 1, dashPattern: [4, 4] };
  warnings.push(`Graph edge #${index + 1} weight '${String(weight)}' is not critical, major or minor and was ignored.`);
  return {};
}

function expandGraph(exp: GraphExpansion): RuntimeCall[] {
  const { instanceId, parent, title, nodes, edges, selectedId, nodeDefaults, links, warnings } = exp;
  const out: RuntimeCall[] = [];
  const known = new Set<string>();

  if (title) {
    out.push({ fn: "sectionHeader", args: { title }, id: `${instanceId}-title`, ...(parent !== undefined ? { parent } : {}) });
  }

  nodes.slice(0, 60).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") {
      warnings.push(`Graph node #${i + 1} is not an object and was skipped.`);
      return;
    }
    const node = raw as Record<string, unknown>;
    const nodeId = typeof node.id === "string" && node.id ? node.id : `node-${i + 1}`;
    if (known.has(nodeId)) {
      warnings.push(`Duplicate graph node id '${nodeId}' ignored.`);
      return;
    }
    known.add(nodeId);

    out.push({
      fn: "deviceNode",
      args: {
        ...nodeDefaults,
        ...(typeof node.label === "string" ? { label: node.label } : { label: nodeId }),
        ...(typeof node.memory === "string" ? { memory: node.memory } : {}),
        ...(typeof node.health === "string" ? { health: node.health } : {}),
        ...(typeof node.compute === "string" ? { compute: node.compute } : {}),
        ...(typeof node.shard === "string" ? { shard: node.shard } : {}),
        ...nodeStatusArgs(node.status, warnings, nodeId),
        ...(selectedId !== undefined && nodeId === selectedId ? { selected: true } : {}),
      },
      id: `${instanceId}-${nodeId}`,
      ...(parent !== undefined ? { parent } : {}),
    });
  });

  if (nodes.length > 60) {
    warnings.push(`Graph kept the first 60 of ${nodes.length} nodes; the rest were dropped.`);
  }

  edges.slice(0, 200).forEach((raw, i) => {
    if (!raw || typeof raw !== "object") {
      warnings.push(`Graph edge #${i + 1} is not an object and was skipped.`);
      return;
    }
    const edge = raw as Record<string, unknown>;
    const from = typeof edge.from === "string" ? edge.from : "";
    const to = typeof edge.to === "string" ? edge.to : "";
    if (!from || !to) {
      warnings.push(`Graph edge #${i + 1} needs both 'from' and 'to'.`);
      return;
    }
    if (!known.has(from) || !known.has(to)) {
      warnings.push(`Graph edge '${from} -> ${to}' names an unknown node and was skipped.`);
      return;
    }

    // Latency first, then bandwidth: the label answers "how slow" before "how wide".
    // Meaning last: it answers why the edge exists (serves, replicates, …).
    const bits = [edge.latency, edge.bandwidth, edge.label].filter((b): b is string => typeof b === "string" && b.length > 0);
    if (typeof edge.meaning === "string" && edge.meaning.length > 0 && !bits.includes(edge.meaning)) {
      bits.push(edge.meaning);
    }
    const label = bits.length > 0 ? bits.join(" · ").slice(0, 120) : undefined;

    out.push({
      fn: "connector",
      args: {
        from: `${instanceId}-${from}`,
        to: `${instanceId}-${to}`,
        ...(label !== undefined ? { label } : {}),
        ...edgeWeightArgs(edge.weight, warnings, i),
      },
      id: `${instanceId}-edge-${i + 1}`,
      ...(parent !== undefined ? { parent } : {}),
    });
    // Links keep the label: layout, connectors and the relationship-clarity
    // critic all read it, and dropping it here made every edge anonymous.
    links.push({
      from: `${instanceId}-${from}`,
      to: `${instanceId}-${to}`,
      ...(label !== undefined ? { label } : {}),
    });
  });

  if (edges.length > 200) {
    warnings.push(`Graph kept the first 200 of ${edges.length} edges; the rest were dropped.`);
  }

  return out;
}

/**
 * Reads region calls out of a plan_screen output object.
 *
 * Each entry is validated as a region call on its own, so a malformed plan
 * degrades to the regions that parsed rather than failing the program.
 */
function extractPlanRegions(plan: Record<string, unknown> | undefined, warnings: string[]): RuntimeCall[] {
  if (!plan) return [];
  const program = plan.program;
  if (!program || typeof program !== "object") {
    warnings.push("The 'plan' argument has no program to build from; it was ignored.");
    return [];
  }
  const regions = (program as Record<string, unknown>).regions;
  if (!Array.isArray(regions)) {
    warnings.push("The plan's program has no regions list; it was ignored.");
    return [];
  }

  const out: RuntimeCall[] = [];
  regions.forEach((raw, i) => {
    const parsed = RuntimeCallSchema.safeParse(raw);
    if (!parsed.success) {
      warnings.push(`Plan region #${i + 1} is not a valid region call and was skipped.`);
      return;
    }
    out.push(parsed.data);
  });
  return out;
}

/**
 * Reads visual intent out of a plan_screen output object.
 *
 * An explicit program-level visualIntent wins outright: the plan's taste is a
 * starting point the author can override wholesale, not a layer to merge
 * field-by-field (half-merged taste is incoherent taste).
 */
function extractPlanIntent(plan: Record<string, unknown> | undefined, warnings: string[]): Record<string, unknown> | undefined {
  if (!plan) return undefined;
  const program = plan.program;
  if (!program || typeof program !== "object") return undefined;
  const intent = (program as Record<string, unknown>).visualIntent;
  if (intent === undefined) return undefined;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    warnings.push("The plan's visual intent is not an object; it was ignored.");
    return undefined;
  }
  return intent as Record<string, unknown>;
}

/**
 * Expands `states: [...]` on a state-capable component into one sibling per
 * state.
 *
 * The state tables map each state name onto the component's own state
 * vocabulary (button variant, pill tone, nav state, device health), so the
 * strip exercises real rendering paths rather than a parallel styling system
 * that could drift from it. Unknown states warn and skip; an empty list is a
 * no-op that leaves the single default instance alone.
 */
const STATE_TABLES: Record<string, Record<string, Record<string, unknown>>> = {
  button: {
    default: {},
    hover: { variant: "primary" },
    selected: { variant: "primary" },
    focused: { variant: "secondary" },
    disabled: { variant: "quiet" },
    loading: { variant: "loading" },
    empty: { variant: "quiet" },
    error: { variant: "destructive" },
    success: { variant: "primary" },
    offline: { variant: "quiet" },
    partial: { variant: "secondary" },
    deploying: { variant: "loading" },
    running: { variant: "primary" },
    paused: { variant: "quiet" },
  },
  statusPill: {
    default: {},
    hover: {},
    selected: {},
    focused: {},
    disabled: { tone: "neutral" },
    loading: { label: "Loading…", tone: "info" },
    empty: { label: "Empty", tone: "neutral" },
    error: { tone: "error" },
    success: { tone: "success" },
    offline: { tone: "error" },
    partial: { tone: "warning" },
    deploying: { label: "Deploying…", tone: "info" },
    running: { tone: "success" },
    paused: { tone: "warning" },
  },
  navItem: {
    default: {},
    hover: {},
    selected: { state: "active" },
    focused: {},
    disabled: { state: "disabled" },
    loading: { state: "disabled" },
    empty: { state: "disabled" },
    error: {},
    success: { state: "active" },
    offline: { state: "disabled" },
    partial: {},
    deploying: { state: "disabled" },
    running: { state: "active" },
    paused: { state: "disabled" },
  },
  deviceNode: {
    default: {},
    hover: {},
    selected: { selected: true },
    focused: {},
    disabled: { health: "offline" },
    loading: { health: "degraded" },
    empty: { health: "offline" },
    error: { health: "offline" },
    success: { health: "healthy" },
    offline: { health: "offline" },
    partial: { health: "degraded" },
    deploying: { health: "degraded" },
    running: { health: "healthy" },
    paused: { health: "degraded" },
  },
};

function expandStates(call: RuntimeCall, warnings: string[]): RuntimeCall[] {
  const args = call.args as Record<string, unknown>;
  const table = STATE_TABLES[call.fn];
  if (!table) return [call];

  const raw = Array.isArray(args.states) ? args.states : [];
  const states = raw.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 14);
  if (states.length === 0) {
    const { states: _dropped, ...rest } = args;
    void _dropped;
    return [{ ...call, args: rest }];
  }

  const { states: _dropped, ...base } = args;
  void _dropped;
  const instanceId = call.id ?? `${call.fn}-states`;
  const out: RuntimeCall[] = [];

  for (const state of states) {
    const key = state.toLowerCase();
    const mapping = table[key];
    if (!mapping) {
      warnings.push(`State '${state}' is not defined for '${call.fn}' and was skipped.`);
      continue;
    }
    out.push({
      fn: call.fn,
      args: { ...base, ...mapping },
      id: `${instanceId}-${key}`,
      ...(call.parent !== undefined ? { parent: call.parent } : {}),
    });
  }

  return out;
}

/**
 * Parses the relation list, reporting each bad entry separately.
 *
 * A relation that cannot be understood is dropped rather than allowed to fail
 * the program: the remaining constraints still produce a correct screen, and the
 * warning tells the model exactly which one it lost.
 */
function parseRelations(raw: Array<Record<string, unknown>>, warnings: string[]): DesignIR["relations"] {
  const out: DesignIR["relations"] = [];

  for (const entry of raw) {
    const id = entry.id;
    if (typeof id !== "string" || id.length === 0) {
      warnings.push(`Relation skipped: it has no 'id'. Every relation needs the node it constrains, e.g. { id: "inspector", rightOf: "topology", gap: 24 }.`);
      continue;
    }
    const parsed = parseConstraint(entry, id);
    if ("error" in parsed) {
      warnings.push(parsed.error);
      continue;
    }
    out.push(parsed);
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Coercion                                                                    */
/* -------------------------------------------------------------------------- */

/** Coerces loosely-typed model input into the strict IR shape. */
function coerceRole(fn: PrimitiveName): DesignIR["regions"][number]["role"] {
  const map: Record<string, DesignIR["regions"][number]["role"]> = {
    navigation: "navigation",
    header: "header",
    hero: "hero",
    inspector: "inspector",
    slide: "slide",
    stage: "stage",
    column: "column",
  };
  return map[fn] ?? "custom";
}

function coerceComposition(v: unknown): DesignIR["regions"][number]["composition"] {
  const allowed = ["editorial", "instrument", "canvas", "topology", "table", "timeline", "split-view", "spatial", "diagram", "sequence", "comparison"] as const;
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as never) : "auto";
}

/**
 * Resolves a region's layout algorithm.
 *
 * When the model does not name one, the composition decides. That mapping is the
 * point: a `topology` region should be laid out as a tree without the model
 * having to remember, and a `table` should be a grid. Asking for the algorithm
 * explicitly is still supported and wins.
 */
function coerceLayout(v: unknown, compositionHint: string): DesignIR["regions"][number]["layout"] {
  const allowed = ["flow", "grid", "tree", "cluster", "masonry", "timeline", "radial", "force", "topology"] as const;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as never;

  switch (compositionHint) {
    case "topology":
    case "diagram":
      return "topology";
    case "table":
    case "instrument":
    case "comparison":
      return "grid";
    case "timeline":
    case "sequence":
      return "timeline";
    default:
      return "flow";
  }
}

/** Reads the composition a call asked for, without validating it twice. */
function compositionHint(v: unknown): string {
  return typeof v === "string" ? v : "auto";
}

function coerceRouting(v: unknown): "straight" | "orthogonal" | "curved" {
  return v === "straight" || v === "curved" ? v : "orthogonal";
}

function coerceVariableType(v: unknown): "color" | "number" | "string" | "boolean" {
  return v === "number" || v === "string" || v === "boolean" ? v : "color";
}

/**
 * Picks up a token value from whichever argument the model used.
 *
 * `values` is the explicit form and supports modes. The shorthands exist because
 * writing `{ name: "surface", values: { default: "#FFFDF9" } }` to set one colour
 * is exactly the kind of ceremony that makes a model give up and hardcode the hex
 * instead -- which defeats the entire point of §22.
 */
function shorthandTokenValue(args: Record<string, unknown>, type: "color" | "number" | "string" | "boolean"): unknown {
  if (type === "color" && typeof args.color === "string") return args.color;
  if (type === "color" && typeof args.fill === "string") return args.fill;
  if (type !== "color" && typeof args.value !== "undefined") return args.value;
  if (type === "number" && typeof args.size !== "number") return args.size;
  return undefined;
}

/**
 * Coerces token values into a mode-keyed record.
 *
 * A bare scalar is treated as the `default` mode, which is what makes
 * `variable({ name: "surface", color: "#FFFDF9" })` work without the model having
 * to know Figma's mode concept exists.
 */
function coerceTokenValues(v: unknown, type: "color" | "number" | "string" | "boolean"): Record<string, string | number | boolean> {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
    }
    return out;
  }
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return { default: v };
  // Sensible zero values rather than an empty record, which Figma rejects.
  return { default: type === "number" ? 0 : type === "boolean" ? false : "#000000" };
}

function coerceSize(v: unknown, fallback: "fill" | "hug"): "fill" | "hug" | number {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (v === "fill" || v === "hug") return v;
  return fallback;
}

function coerceNumber(v: unknown, fallback: number, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function coerceToken(v: unknown): string | number {
  if (typeof v === "number") return v;
  return String(v ?? "");
}

function coercePadding(v: unknown): number | { top: number; right: number; bottom: number; left: number } {
  if (typeof v === "number") return coerceNumber(v, 0, 0, 400);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const num = (k: string) => coerceNumber(o[k], 0, 0, 400);
    return { top: num("top"), right: num("right"), bottom: num("bottom"), left: num("left") };
  }
  return 0;
}

function componentTypeFor(fn: PrimitiveName): DesignIR["content"][number] extends { type: infer T } ? T : never {
  const map: Record<string, string> = {
    metric: "metric",
    statusPill: "statusPill",
    deviceNode: "deviceNode",
    navItem: "navItem",
    panel: "panel",
    button: "button",
    divider: "divider",
    sectionHeader: "sectionHeader",
    modelRow: "modelRow",
    topologyMap: "topologyMap",
    placementMap: "placementMap",
    shardBlock: "shardBlock",
    memoryBudget: "memoryBudget",
    fitGauge: "fitGauge",
    compatibilityMatrix: "compatibilityMatrix",
    logoMark: "logoMark",
    logoGrid: "logoGrid",
    logoLockup: "logoLockup",
    vectorPlan: "vectorPlan",
    booleanGroup: "booleanGroup",
    flowNode: "flowNode",
    decisionDiamond: "decisionDiamond",
    timelineEvent: "timelineEvent",
    chartBar: "chartBar",
    chartLine: "chartLine",
    chartPie: "chartPie",
    callout: "callout",
    annotation: "annotation",
    sectionDivider: "sectionDivider",
    quoteBlock: "quoteBlock",
    imageFrame: "imageFrame",
    slideMaster: "slideMaster",
    deckOutline: "deckOutline",
    stat: "stat",
    bullets: "bullets",
  };
  return (map[fn] ?? "panel") as never;
}

