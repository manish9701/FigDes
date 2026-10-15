/**
 * Argument schemas for the runtime primitives.
 *
 * ## Why this exists
 *
 * `runtime_primitives` used to return a name, a kind and a sentence of prose for
 * each primitive and nothing else. A model could therefore see that `logoGrid`
 * existed but had no way to learn it took `divisions` — and a guessed property
 * was rejected with a warning that named the mistake without naming the fix.
 * Three primitives were effectively unusable by discovery alone (`vectorPlan`,
 * `logoGrid`, `logoLockup`), because the keys that make them work were
 * invisible in both the catalogue and the rejection message.
 *
 * So the accepted arguments are declared here, once, and three things read the
 * same table:
 *
 * 1. `runtime_primitives` returns them, so discovery is the schema.
 * 2. The interpreter validates against them *before* layout, so a wrong type is
 *    reported as a wrong type rather than silently defaulting.
 * 3. The unknown-argument warning quotes the closest accepted key, so a typo
 *    tells you what to write instead.
 *
 * The table is derived from what the compiler actually reads, not from what the
 * prose suggests. A schema that lists an argument nothing consumes is exactly
 * the failure mode being fixed.
 */
import { LOGO_MARKS } from "./marks";

/* -------------------------------------------------------------------------- */
/* Arg vocabulary                                                              */
/* -------------------------------------------------------------------------- */

export type ArgType =
  | "string"
  | "number"
  | "boolean"
  | "colour"
  | "token"
  | "enum"
  | "size"
  | "role"
  | "variant"
  | "tone"
  | "mark"
  | "text"
  | "string[]"
  | "number[]"
  | "object"
  | "object[]";

export interface ArgSpec {
  name: string;
  type: ArgType;
  description: string;
  /** Closed value list, for enums. */
  values?: readonly string[];
  /** A worked example of the value, not of the whole call. */
  example?: string;
}

const TONE_VALUES = ["success", "healthy", "warning", "danger", "error", "info", "neutral", "offline", "degraded", "unavailable"] as const;
const VARIANT_VALUES = ["primary", "secondary", "destructive", "quiet", "loading", "disabled"] as const;
const STATE_VALUES = ["default", "active", "selected", "disabled", "loading", "hover", "pressed"] as const;
const HEALTH_VALUES = ["healthy", "degraded", "offline", "warning", "selected", "unavailable"] as const;
const ROUTING_VALUES = ["straight", "orthogonal", "curved"] as const;
const SHAPE_VALUES = ["rect", "ellipse", "line", "polygon", "star"] as const;
const ROLE_VALUES = ["eyebrow", "title", "subtitle", "body", "label", "value", "caption", "code"] as const;
const LAYOUT_VALUES = ["flow", "grid", "masonry", "timeline", "radial", "cluster", "tree", "force", "topology"] as const;
const BOOLEAN_OP_VALUES = ["union", "subtract", "intersect", "exclude"] as const;
const WINDING_VALUES = ["NONE", "NONZERO", "EVENODD"] as const;
const PLAN_OPS = ["silhouette", "cutout", "mirror", "refine"] as const;
const TOKEN_TYPES = ["COLOR", "NUMBER", "STRING", "BOOLEAN"] as const;

const colour: ArgSpec = { name: "fill", type: "colour", description: "Hex colour or 'transparent'.", example: '"#242521"' };
const text = (name: string, description: string, example?: string): ArgSpec => ({ name, type: "string", description, ...(example ? { example } : {}) });
const num = (name: string, description: string, example?: string): ArgSpec => ({ name, type: "number", description, ...(example ? { example } : {}) });
const bool = (name: string, description: string): ArgSpec => ({ name, type: "boolean", description });
const enumArg = (name: string, description: string, values: readonly string[], example?: string): ArgSpec => ({
  name,
  type: "enum",
  description,
  values,
  ...(example ? { example } : {}),
});
/** An argument whose value is a list or a nested object rather than a scalar. */
const structured = (name: string, type: ArgType, description: string, example: string): ArgSpec => ({ name, type, description, example });

/** Args every region primitive accepts. */
const REGION_COMMON: ArgSpec[] = [
  { name: "width", type: "size", description: "Fixed width in px, or 'fill' to absorb leftover space, or 'hug' to fit content.", example: "320" },
  { name: "height", type: "size", description: "Fixed height in px, or 'fill' to absorb leftover space, or 'hug' to fit content.", example: "900" },
  num("grow", "Relative share of leftover space. Higher absorbs more."),
  num("gap", "Space between this region's children."),
  num("padding", "Inner padding in px."),
  colour,
  num("radius", "Corner radius.", "8"),
  enumArg("composition", "Forces a composition instead of inferring one.", ["auto", "editorial", "instrument", "canvas", "topology", "table", "timeline", "split-view", "spatial", "diagram", "sequence", "comparison"]),
  enumArg("layout", "How children are arranged.", LAYOUT_VALUES, '"topology"'),
  num("columns", "Column count for grid/masonry layouts."),
  num("gridColumns", "Figma layout-grid columns drawn on this region."),
  num("gridGutter", "Figma layout-grid gutter."),
];

/** Args every state-capable component accepts. */
const STATE_COMMON: ArgSpec[] = [
  structured("states", "object[]", "Expands to one sibling per state, each carrying the state in its id.", '[{ "state": "loading" }, { "state": "error" }]'),
];

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Per-primitive accepted arguments.
 *
 * `RUNTIME_PRIMITIVES` stays the source of truth for name/kind/description;
 * this is the source of truth for what each one *takes*. A test asserts the two
 * never drift apart.
 */
export const PRIMITIVE_ARGUMENTS: Record<string, ArgSpec[]> = {
  /* ---- canvas + regions ---- */
  screen: [{ ...num("width", "Canvas width."), example: "1440" }, { ...num("height", "Canvas height."), example: "900" }, num("grid", "Base spacing unit. Every gutter derives from it.", "8")],
  frame: REGION_COMMON,
  slide: [{ ...num("width", "Slide width. Defaults to 1920."), example: "1920" }, num("height", "Slide height. Defaults to 1080."), { ...num("grid", "Base spacing unit."), example: "8" }],
  stage: REGION_COMMON,
  column: REGION_COMMON,
  navigation: REGION_COMMON,
  header: REGION_COMMON,
  hero: REGION_COMMON,
  inspector: REGION_COMMON,
  stack: REGION_COMMON,
  grid: REGION_COMMON,

  /* ---- text + graphics ---- */
  text: [
    text("text", "The string to render.", '"Deploy to prod"'),
    enumArg("role", "Type-scale role.", ROLE_VALUES, '"title"'),
    num("size", "Explicit font size in px, overriding the role scale."),
    text("family", "Font family name.", '"Inter"'),
    num("weight", "Font weight 100-900.", "600"),
    num("letterSpacing", "Tracking in 1/100 em."),
    colour,
    num("maxWidth", "Wrapping width in px."),
  ],
  shape: [
    enumArg("shape", "Shape kind.", SHAPE_VALUES, '"polygon"'),
    colour,
    text("stroke", "Stroke colour.", '"#D9D8D0"'),
    num("radius", "Corner radius for rect."),
    num("opacity", "Opacity 0-1."),
    num("sides", "Side count for polygon/star (3-24).", "6"),
    num("innerRatio", "Inner radius ratio for a star.", "0.42"),
    num("rotation", "Rotation in degrees.", "-90"),
  ],
  vector: [
    text("path", "SVG path data, absolute commands only: M L H V C S Q T A Z. Beziers survive.", '"M 0 0 L 40 0 L 40 40 Z"'),
    text("stroke", "Stroke colour."),
    num("strokeWeight", "Stroke width in px.", "2"),
    colour,
    enumArg("windingRule", "Fill rule.", WINDING_VALUES, '"EVENODD"'),
    text("strokeCap", "Line cap.", '"ROUND"'),
    text("strokeJoin", "Line join.", '"MITER"'),
    bool("closed", "Close the path."),
    structured("dashPattern", "number[]", "Dash pattern.", "[4, 4]"),
  ],
  vectorPlan: [
    structured("steps", "object[]", "Ordered construction steps, executed as geometry.", '[{ "op": "silhouette", "mark": "hex" }, { "op": "cutout" }, { "op": "mirror" }]'),
    text("cutout", "Named cutout applied to the silhouette."),
    text("grid", "Construction grid hint for the plan."),
    text("color", "Primary ink colour."),
    num("strokeWeight", "Stroke width in px."),
    num("size", "Fraction of the box the mark occupies (0.1-1).", "0.8"),
  ],
  booleanGroup: [
    enumArg("operation", "Boolean operation applied to the sibling shapes.", BOOLEAN_OP_VALUES, '"subtract"'),
    structured("targets", "string[]", "Ids of the shapes to combine.", '["a", "b"]'),
  ],

  /* ---- semantic components ---- */
  metric: [
    text("label", "Caption above the value.", '"GPUs"'),
    text("value", "The figure itself.", '"8x H100"'),
    text("delta", "Change indicator. Omit when there is none."),
    text("surface", "Card surface."),
    num("radius", "Corner radius."),
    text("valueStyle", "'technical' sets the value in a monospaced face.", '"technical"'),
    bool("mono", "Shorthand for valueStyle:'technical'."),
  ],
  statusPill: [
    text("label", "The word that carries the state. Never rely on colour alone.", '"Online"'),
    enumArg("tone", "Colour pair for the pill.", TONE_VALUES, '"healthy"'),
    enumArg("state", "Alias for tone.", TONE_VALUES),
    text("surface", "Override the pill background."),
    ...STATE_COMMON,
  ],
  deviceNode: [
    text("label", "Machine name.", '"gpu-01"'),
    text("memory", "Memory caption.", '"1.8 TB"'),
    text("compute", "Compute capability caption.", '"8x H100"'),
    text("shard", "Shard assignment caption."),
    enumArg("health", "Health stroke.", HEALTH_VALUES, '"degraded"'),
    enumArg("status", "Alias for health; accepts 'selected' and 'pressured'.", [...HEALTH_VALUES, "pressured"]),
    bool("selected", "Draws the action-blue selection ring."),
    text("surface", "Tile surface."),
    ...STATE_COMMON,
  ],
  navItem: [
    text("label", "Nav label.", '"Cluster"'),
    enumArg("state", "Wayfinding state.", STATE_VALUES, '"active"'),
    bool("active", "Shorthand for state:'active'."),
    text("color", "Label colour when not active."),
    text("surface", "Row surface."),
    ...STATE_COMMON,
  ],
  panel: [text("title", "Panel title."), text("surface", "Panel surface."), enumArg("tone", "Surface tone.", TONE_VALUES)],
  button: [
    text("label", "Button label.", '"Deploy"'),
    enumArg("variant", "Visual contract for the action.", VARIANT_VALUES, '"primary"'),
    ...STATE_COMMON,
  ],
  divider: [text("color", "Rule colour.", '"#E0E0E0"')],
  sectionHeader: [text("title", "Section title.", '"Throughput"'), text("action", "Right-aligned action label, e.g. 'View all'."), num("subtitle", "Unused; use a text primitive for a subtitle.")],
  sectionDivider: [text("title", "Divider label."), text("color", "Rule colour.")],
  modelRow: [
    text("title", "Model name.", '"llama-70b"'),
    text("value", "Shards or placement count.", '"4 shards"'),
    text("label", "Caption."),
    enumArg("status", "Row status.", [...HEALTH_VALUES, "fits", "does-not-fit"]),
    text("surface", "Row surface."),
  ],
  topologyMap: [
    text("title", "Map title.", '"Compute topology"'),
    text("surface", "Map background."),
    structured("nodes", "object[]", "Graph nodes. Presence of this expands the map into deviceNodes plus routed connectors.", '[{ "id": "gpu-1", "label": "GPU 1", "status": "healthy" }]'),
    structured("edges", "object[]", "Graph edges between declared node ids.", '[{ "from": "gpu-1", "to": "inference", "latency": "2ms", "weight": "critical" }]'),
    text("selectedNode", "Id of the node to draw selected."),
  ],
  placementMap: [
    text("title", "Map title."),
    text("model", "Model the placement is for.", '"llama-70b"'),
    num("required", "Memory the model needs."),
    num("available", "Memory the cluster has."),
    structured("machines", "object[]", "Machines in the cluster.", '[{ "id": "gpu-1", "memory": 80 }]'),
    structured("assignments", "object[]", "Shard-to-machine assignments.", '[{ "shard": "s1", "machine": "gpu-1" }]'),
    bool("fits", "Explicit fits-or-not verdict, when it must not be computed."),
  ],
  shardBlock: [text("shard", "Shard id.", '"shard-1"'), text("size", "Shard size."), text("machine", "Target machine."), text("title", "Block caption.")],
  memoryBudget: [
    text("usedLabel", "Label for the used figure."),
    text("totalLabel", "Label for the total figure."),
    num("used", "Used figure."),
    num("total", "Total figure."),
    num("remaining", "Headroom figure, when it is known."),
    text("unit", "Unit suffix.", '"GB"'),
  ],
  fitGauge: [bool("fits", "Whether the model fits."), text("verdict", "Verdict word shown in the pill.", '"Fits"'), text("detail", "Supporting line.")],
  compatibilityMatrix: [structured("rows", "object[]", "Model-by-machine rows.", '[{ "label": "llama-70b", "machine": "gpu-1", "verdict": "fits" }]')],

  /* ---- logo ---- */
  logoMark: [
    enumArg("mark", "Which mark to draw.", LOGO_MARKS, '"ring"'),
    num("size", "Fraction of the box the mark occupies (0.1-1).", "0.8"),
    text("color", "Stroke ink."),
    text("surface", "Fill colour for closed marks."),
    num("strokeWeight", "Stroke width in px."),
  ],
  logoGrid: [
    num("size", "Fraction of the box the grid covers (0.1-1).", "0.8"),
    num("divisions", "Grid divisions per axis (2-12).", "4"),
    text("color", "Guide colour."),
  ],
  logoLockup: [
    enumArg("mark", "Which mark to draw above the wordmark.", LOGO_MARKS, '"ring"'),
    text("wordmark", "Wordmark text, set in tracked-out capitals.", '"EXO"'),
    text("color", "Ink colour for both mark and wordmark."),
    num("strokeWeight", "Stroke width in px."),
    bool("optical", "Apply the optical baseline shift for round marks."),
  ],

  /* ---- diagram + deck ---- */
  flowNode: [text("label", "Step label."), text("title", "Step title."), enumArg("state", "Step state.", STATE_VALUES), text("surface", "Node surface.")],
  decisionDiamond: [text("label", "Decision label."), text("title", "Decision title."), text("surface", "Diamond surface.")],
  timelineEvent: [text("date", "Date or step marker."), text("title", "Event title."), text("body", "Event body."), text("label", "Caption."), text("surface", "Event surface.")],
  chartBar: [structured("values", "object[]", "Labelled values. Order is preserved; no bar is assumed tallest.", '[{ "label": "gpu-1", "value": 80 }]'), structured("labels", "string[]", "Axis labels.", '["gpu-1", "gpu-2"]')],
  chartLine: [
    structured("series", "object[]", "Ordered points.", '[{ "label": "09:00", "value": 42 }]'),
    structured("labels", "string[]", "Axis labels.", '["09:00", "10:00"]'),
    text("color", "Line colour."),
  ],
  chartPie: [
    structured("shares", "object[]", "Named shares.", '[{ "label": "H100", "value": 60 }]'),
    structured("values", "object[]", "Alias for shares.", '[{ "label": "H100", "value": 60 }]'),
    text("color", "First slice colour."),
  ],
  callout: [text("label", "Callout text."), text("body", "Supporting line."), text("color", "Accent colour.")],
  annotation: [text("label", "Annotation text."), text("title", "Annotation title."), text("color", "Accent colour."), num("size", "Annotation scale.")],
  quoteBlock: [text("quote", "The statement."), text("author", "Attribution."), text("color", "Ink colour.")],
  imageFrame: [text("src", "Image source, when one is available."), text("alt", "Alt text, required for accessibility."), text("caption", "Caption.")],
  slideMaster: [text("title", "Master title."), text("footer", "Footer text."), text("background", "Slide background colour."), text("accent", "Accent colour.")],
  deckOutline: [
    structured("acts", "object[]", "Acts of the narrative.", '[{ "title": "Problem", "slides": ["a", "b"] }]'),
    text("title", "Deck title."),
    text("footer", "Deck footer."),
  ],
  stat: [text("value", "The figure.", '"42 TB"'), text("label", "Caption."), text("number", "Alias for value."), text("color", "Figure colour.")],
  bullets: [structured("items", "string[]", "Bullet lines.", '["First", "Second"]'), text("body", "Alias for items.")],

  /* ---- connections ---- */
  connector: [
    text("from", "Id of the node this line starts at."),
    text("to", "Id of the node this line ends at."),
    enumArg("routing", "Route style.", ROUTING_VALUES, '"orthogonal"'),
    text("label", "Edge label. Unlabelled edges read as anonymous."),
    text("stroke", "Line colour."),
    num("strokeWeight", "Stroke width in px.", "2"),
    bool("arrowStart", "Arrowhead at the start."),
    bool("arrowEnd", "Arrowhead at the end. Defaults to true."),
    num("curvature", "Bow amount for curved routing (-2..2).", "0.2"),
    structured("dashPattern", "number[]", "Dash pattern.", "[4, 4]"),
  ],

  /* ---- tokens + styles ---- */
  variable: [
    text("name", "Variable name.", '"surface"'),
    enumArg("type", "Variable type.", TOKEN_TYPES, '"COLOR"'),
    text("collection", "Collection to add the variable to."),
    structured("values", "object", "Values keyed by mode.", '{ "default": "#FFFFFF" }'),
    structured("scopes", "string[]", "Variable scopes.", '["CORNER_RADIUS"]'),
    text("description", "Human description."),
  ],
  textStyle: [
    text("name", "Style name.", '"Body"'),
    text("family", "Font family.", '"Inter"'),
    num("size", "Font size in px."),
    num("weight", "Font weight 100-900."),
    num("lineHeight", "Line height in px."),
    num("letterSpacing", "Tracking."),
    colour,
  ],
  paintStyle: [text("name", "Style name.", '"Surface"'), text("color", "Colour value.", '"#FFFFFF"'), num("opacity", "Opacity 0-1.")],

  /* ---- composition ---- */
  template: [text("name", "Name of a template declared in the program's 'templates' list.", '"page-header"')],
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

export interface ArgIssue {
  arg: string;
  problem: "unknown" | "wrong-type";
  message: string;
  /** Accepted keys, or accepted values for an enum. */
  accepted?: readonly string[];
  /** Closest accepted key, when the mistake looks like a typo. */
  suggestion?: string;
}

/** Levenshtein distance, capped: only near-misses are worth suggesting. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const row = [i];
    for (let j = 1; j < cols; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[cols - 1]!;
}

function closest(name: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = editDistance(name.toLowerCase(), candidate.toLowerCase());
    // Only within a third of the word's length, so unrelated guesses stay unrelated.
    if (d < bestDistance && d <= Math.max(1, Math.floor(name.length / 3))) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

function typeMatches(spec: ArgSpec, value: unknown): boolean {
  switch (spec.type) {
    case "number":
    case "size":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "number[]":
      return Array.isArray(value) && value.every((v) => typeof v === "number");
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "object[]":
      return Array.isArray(value) && value.every((v) => typeof v === "object" && v !== null);
    case "enum":
      return typeof value === "string" && (spec.values ?? []).includes(value);
    case "colour":
    case "token":
      // A colour slot accepts a hex or a variable name; whether the name
      // resolves is the plugin's business, not the schema's.
      return typeof value === "string";
    default:
      return typeof value === "string";
  }
}

/** Human wording for a type, used verbatim in the rejection message. */
export function describeType(spec: ArgSpec): string {
  switch (spec.type) {
    case "number":
      return "a number";
    case "size":
      return "a number, 'fill' or 'hug'";
    case "boolean":
      return "true or false";
    case "colour":
    case "token":
      return "a hex colour or a variable name";
    case "enum":
      return `one of ${(spec.values ?? []).map((v) => `"${v}"`).join(", ")}`;
    case "string[]":
      return "an array of strings";
    case "number[]":
      return "an array of numbers";
    case "object":
      return "an object";
    case "object[]":
      return "an array of objects";
    default:
      return "a string";
  }
}

/**
 * Checks one call's arguments against its schema.
 *
 * Runs before layout so a mistyped argument is a precise message naming the
 * accepted shape, instead of a call that silently draws the default.
 */
export function validatePrimitiveArgs(fn: string, args: Record<string, unknown>): ArgIssue[] {
  const specs = PRIMITIVE_ARGUMENTS[fn];
  if (!specs) return [];
  const byName = new Map(specs.map((s) => [s.name, s]));
  const issues: ArgIssue[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const spec = byName.get(key);
    if (!spec) {
      const suggestion = closest(key, specs.map((s) => s.name));
      issues.push({
        arg: key,
        problem: "unknown",
        message:
          `'${fn}' has no argument '${key}'.` +
          (suggestion ? ` Did you mean '${suggestion}'?` : "") +
          ` Run runtime_primitives for the accepted arguments.`,
        accepted: specs.map((s) => s.name),
        ...(suggestion ? { suggestion } : {}),
      });
      continue;
    }

    if (spec.type === "size" && (value === "fill" || value === "hug")) continue;
    if (typeMatches(spec, value)) continue;

    // `size` accepts both a number and the symbolic forms, so a bad value there
    // needs the union spelled out rather than just "a number".
    const message =
      spec.type === "enum"
        ? `'${fn}' argument '${key}' must be ${describeType(spec)}, but got ${JSON.stringify(value)}.`
        : spec.type === "size"
          ? `'${fn}' argument '${key}' must be ${describeType(spec)}, but got ${JSON.stringify(value)}.`
          : `'${fn}' argument '${key}' must be ${describeType(spec)}, but got ${JSON.stringify(value)}.`;

    issues.push({
      arg: key,
      problem: "wrong-type",
      message,
      accepted: spec.type === "enum" ? spec.values : undefined,
    });
  }

  return issues;
}

/**
 * Worked call examples, so discovery shows the shape rather than only the
 * vocabulary. A schema a model has to assemble correctly first time is a schema
 * it will get wrong.
 */
export const PRIMITIVE_EXAMPLES: Record<string, string> = {
  text: '{ fn: "text", id: "t1", parent: "hero", args: { text: "3 machines online", role: "body" } }',
  metric: '{ fn: "metric", id: "gpus", parent: "hero", args: { label: "GPUs", value: "8x H100", delta: "+2" } }',
  statusPill: '{ fn: "statusPill", id: "state", parent: "rail", args: { label: "Online", tone: "healthy" } }',
  deviceNode: '{ fn: "deviceNode", id: "gpu-1", parent: "map", args: { label: "GPU 1", health: "healthy", status: "selected" } }',
  topologyMap: '{ fn: "topologyMap", id: "topo", parent: "field", args: { title: "Compute topology", nodes: [{ id: "gpu-1", label: "GPU 1" }, { id: "inf", label: "Inference" }], edges: [{ from: "gpu-1", to: "inf", latency: "2ms", weight: "critical" }] } }',
  connector: '{ fn: "connector", id: "e1", parent: "field", args: { from: "gpu-1", to: "inf", routing: "orthogonal", label: "2 ms" } }',
  button: '{ fn: "button", id: "deploy", parent: "hero", args: { label: "Deploy", variant: "primary" } }',
  logoMark: '{ fn: "logoMark", id: "mark", parent: "hero", args: { mark: "ring", size: 0.8, color: "#242521" } }',
  logoGrid: '{ fn: "logoGrid", id: "guides", parent: "hero", args: { size: 0.8, divisions: 4, color: "#0D99FF" } }',
  logoLockup: '{ fn: "logoLockup", id: "logo", parent: "hero", args: { mark: "ring", wordmark: "EXO", color: "#242521" } }',
  vectorPlan: '{ fn: "vectorPlan", id: "logo-path", parent: "hero", args: { steps: [{ op: "silhouette", mark: "hex" }, { op: "cutout" }, { op: "mirror" }], color: "#242521" } }',
  inspector: '{ fn: "inspector", id: "side", args: { width: 320, composition: "split-view" } }',
  variable: '{ fn: "variable", id: "surface-token", args: { name: "surface", type: "COLOR", values: { default: "#FFFFFF" } } }',
};