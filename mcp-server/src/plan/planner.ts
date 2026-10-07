/**
 * Screen planning (spec §30, §31).
 *
 * ## The problem this prevents
 *
 * §51 names the failure mode exactly: "generic SaaS dashboard composition" and
 * "repeated three-card metric layouts". That happens when a model starts drawing
 * immediately, because the first thing it reaches for is a header and a row of
 * cards. Once those exist, every later decision is constrained by them.
 *
 * So this module answers a different question than "what should I draw". It
 * answers: **what is the one decision the user is making on this screen, and what
 * has to be on screen to make it?**
 *
 * That reframing is the whole mechanism. A screen whose primary decision is
 * "which model do I run" needs a comparison surface and a fit state, not three
 * big numbers. Deriving regions from the decision instead of from a layout habit
 * is what keeps the output off the dashboard template.
 *
 * ## Composition before implementation (§31)
 *
 * The output is a 2D composition model: named regions with resolved geometry, no
 * content, no children. Building it separately is not ceremony — it means the
 * expensive, hard-to-reverse decision (where things go) is made in a call that
 * creates nothing, so a wrong composition costs one message rather than an undo.
 */
import { defaultGutter, inferComposition, layoutRegions, type Composition } from "../runtime/layout";
import type { Region } from "../../../shared/ir";
import { defaultRules } from "../memory/rules-exo";

/* -------------------------------------------------------------------------- */
/* Intent                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the user came to do, in their words.
 *
 * `primaryDecision` is the field that matters. It is required, and it is a
 * short noun phrase ("select a model"), not a layout instruction. Everything else
 * is context used to decide what the primary decision needs in order to be made.
 */
export interface ScreenIntent {
  /** What the user is trying to accomplish, verbatim. */
  goal?: string;
  /** Who is looking at this. Shapes density and vocabulary. */
  audience?: "developer" | "operator" | "engineer" | "leadership" | "general";
  /**
   * The single decision this screen exists to support.
   *
   * Exactly one. A screen that needs two is a screen that needs splitting, and
   * saying so is more useful than silently building both.
   */
  primaryDecision: string;
  /** What data is genuinely available to answer it. */
  availableInformation?: string[];
  /** Patterns the file already uses. Reused rather than reinvented. */
  existingPatterns?: string[];
  /** The model's own preference, used only as a tiebreaker. */
  desiredComposition?: Composition;
  canvas?: { width?: number; height?: number; grid?: number };
  name?: string;
}

/* -------------------------------------------------------------------------- */
/* Decision vocabulary                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The kinds of decision a screen can exist to support.
 *
 * Recognised so the planner can pick a real composition rather than defaulting.
 * Anything unrecognised falls back to `inspect`, which is the least presumptuous
 * answer: a side panel next to a primary object, with no strong opinion about
 * which is which.
 */
type DecisionKind =
  | "select"        // choosing between options -> comparison surface
  | "monitor"       // watching state over time -> instrument
  | "configure"     // setting something -> form + preview
  | "explore"       // finding something -> list + filters
  | "inspect"       // understanding one thing -> detail + context
  | "compare"       // differences -> side by side
  | "topology"      // how things connect -> diagram
  | "integration"   // connecting an external provider -> provider list + endpoint detail
  | "author";       // creating something -> canvas + controls

const DECISION_PATTERNS: Array<{ kind: DecisionKind; pattern: RegExp }> = [
  { kind: "select", pattern: /\b(select|choose|pick|which|what model|run what|switch to)\b/i },
  { kind: "compare", pattern: /\b(compare|versus|vs\.?|difference|side by side)\b/i },
  /**
   * Deliberately narrow.
   *
   * An earlier version matched `cluster`, `machines`, `nodes` and `graph`, which
   * meant "monitor cluster health" classified as a topology decision and got a
   * node-link diagram instead of an instrument. Words that merely *describe* a
   * group of things are not a statement that the relationships are the point.
   * `monitor` is also checked first, because "monitor X" is unambiguous and should
   * not be re-interpreted by whatever X happens to be.
   */
  { kind: "monitor", pattern: /\b(monitor|monitoring|watch|watching|track|status|health|utilisation|utilization|throughput|live|realtime|real-time)\b/i },
  { kind: "topology", pattern: /\b(topolog\w*|network topology|node-link|fleet|architecture|connectivity|how .* connect\w*)\b/i },
  // Integrations speak provider/endpoint/profile, so they get their own shell:
  // a provider list beside an endpoint detail pane, never a generic form.
  { kind: "integration", pattern: /\b(integrat\w*|provider|endpoint|webhook|api key|connect .* service)\b/i },
  { kind: "configure", pattern: /\b(configure|settings|setup|set up|tune|parameter|preference)\b/i },
  { kind: "explore", pattern: /\b(find|search|browse|filter|discover|list|explore)\b/i },
  { kind: "inspect", pattern: /\b(inspect|detail|understand|see|view|review|diagnose|why)\b/i },
  { kind: "author", pattern: /\b(create|new|add|compose|write|deploy|push|provision)\b/i },
];

/** Classifies the primary decision. Exported for tests and for reporting. */
export function classifyDecision(primaryDecision: string): DecisionKind {
  for (const { kind, pattern } of DECISION_PATTERNS) {
    if (pattern.test(primaryDecision)) return kind;
  }
  return "inspect";
}

/* -------------------------------------------------------------------------- */
/* Region synthesis                                                            */
/* -------------------------------------------------------------------------- */

interface PlannedRegion {
  id: string;
  role: Region["role"];
  composition: Composition;
  width: Region["width"];
  height: Region["height"];
  grow: number;
  gap?: number;
  padding?: number;
  /** Why this region exists. Shown to the user, and to the model. */
  because: string;
}

/**
 * Builds the ordered region list for a decision kind.
 *
 * Hand-written per kind rather than generated, because these encode actual design
 * judgement about what each kind of screen needs. A generic algorithm here would
 * reproduce the dashboard it exists to prevent.
 */
const SHELLS: Record<DecisionKind, (intent: ScreenIntent) => PlannedRegion[]> = {
  /* Choosing between options: a comparison surface with the option list, plus an
     inspector for detail. The list is the widest region because comparing means
     reading across rows. */
  select: (intent) => {
    const patterns = intent.existingPatterns ?? [];
    const listLabel = patterns.some((p) => /table|list|grid/i.test(p)) ? "table" : "content";
    return [
      { id: "nav", role: "navigation", composition: "instrument", width: 240, height: "fill", grow: 0, because: "orientation: where am I in the product" },
      { id: "header", role: "header", composition: "editorial", width: "fill", height: 72, grow: 0, padding: 24, because: `the decision, stated: "${intent.primaryDecision}"` },
      { id: listLabel, role: "content", composition: "table", width: "fill", height: "fill", grow: 1, gap: 16, padding: 24, because: "the options, arranged so they can be compared rather than admired" },
      { id: "inspector", role: "inspector", composition: "split-view", width: 360, height: "fill", grow: 0, gap: 24, because: "detail for the currently focused option" },
    ];
  },

  /* Watching state: an instrument. Status rail for at-a-glance, primary visual for
     the thing being watched. */
  monitor: () => [
    { id: "rail", role: "status-rail", composition: "instrument", width: "fill", height: 64, grow: 0, padding: 16, because: "state at a glance, read without focusing" },
    { id: "primary-visual", role: "primary-visual", composition: "instrument", width: "fill", height: "fill", grow: 2, gap: 24, padding: 24, because: "the primary signal, given the most space" },
    { id: "detail", role: "secondary", composition: "split-view", width: "fill", height: 240, grow: 0, gap: 16, padding: 24, because: "the underlying data behind the signal" },
  ],

  /* How things connect: the diagram is the screen. A rail for context, the map
     filling everything else. No inspector, because a topology has no single
     subject to inspect. */
  topology: () => [
    { id: "rail", role: "status-rail", composition: "instrument", width: "fill", height: 56, grow: 0, padding: 16, because: "fleet summary: counts and aggregate state" },
    { id: "map", role: "primary-visual", composition: "topology", width: "fill", height: "fill", grow: 1, gap: 32, padding: 24, because: "the relationships themselves, which are the content" },
  ],

  compare: () => [
    { id: "nav", role: "navigation", composition: "instrument", width: 208, height: "fill", grow: 0, because: "orientation" },
    { id: "header", role: "header", composition: "editorial", width: "fill", height: 72, grow: 0, padding: 24, because: "what is being compared, stated plainly" },
    { id: "left", role: "content", composition: "split-view", width: "fill", height: "fill", grow: 1, gap: 24, padding: 24, because: "first subject" },
    { id: "right", role: "content", composition: "split-view", width: "fill", height: "fill", grow: 1, gap: 24, padding: 24, because: "second subject, aligned to the first so differences read as differences" },
  ],

  configure: () => [
    { id: "nav", role: "navigation", composition: "instrument", width: 240, height: "fill", grow: 0, because: "orientation" },
    { id: "form", role: "content", composition: "editorial", width: 480, height: "fill", grow: 0, gap: 16, padding: 24, because: "the controls, in one column so their order reads as a sequence" },
    { id: "preview", role: "primary-visual", composition: "canvas", width: "fill", height: "fill", grow: 1, gap: 24, padding: 24, because: "the effect of the settings, so a change is never a leap of faith" },
  ],

  explore: () => [
    { id: "nav", role: "navigation", composition: "instrument", width: 240, height: "fill", grow: 0, because: "orientation" },
    { id: "filters", role: "header", composition: "editorial", width: "fill", height: 64, grow: 0, padding: 16, because: "narrowing, before listing" },
    { id: "results", role: "content", composition: "table", width: "fill", height: "fill", grow: 1, gap: 12, padding: 24, because: "the results, dense enough to scan" },
  ],

  inspect: () => [
    { id: "nav", role: "navigation", composition: "instrument", width: 208, height: "fill", grow: 0, because: "orientation" },
    { id: "subject", role: "primary-visual", composition: "canvas", width: "fill", height: "fill", grow: 2, gap: 24, padding: 32, because: "the thing being understood, given the most room" },
    { id: "context", role: "inspector", composition: "split-view", width: 360, height: "fill", grow: 0, gap: 24, because: "surrounding state that gives the subject meaning" },
  ],

  // Integrations are provider/endpoint/profile concepts, not generic settings:
  // a provider list beside an endpoint detail pane, with the connection state
  // always visible. A form would hide which provider each value belongs to.
  integration: () => [
    { id: "nav", role: "navigation", composition: "instrument", width: 240, height: "fill", grow: 0, because: "orientation" },
    { id: "providers", role: "content", composition: "table", width: 420, height: "fill", grow: 0, gap: 12, padding: 24, because: "the providers, each showing connection state at a glance" },
    { id: "endpoint", role: "inspector", composition: "split-view", width: "fill", height: "fill", grow: 1, gap: 24, padding: 24, because: "endpoint, profile and credentials for the selected provider" },
  ],

  author: () => [
    { id: "nav", role: "navigation", composition: "instrument", width: 240, height: "fill", grow: 0, because: "orientation" },
    { id: "canvas", role: "primary-visual", composition: "canvas", width: "fill", height: "fill", grow: 1, padding: 32, because: "the work surface" },
    { id: "controls", role: "inspector", composition: "split-view", width: 320, height: "fill", grow: 0, gap: 24, because: "the actions that apply to the current selection" },
  ],
};

/**
 * Named screen templates (spec §14).
 *
 * The shells above already select by decision; this table names them so the
 * choice is explicit, comparable and paste-ready. A template is a promise about
 * what the screen is for, not a layout preset: "list-detail" for choosing
 * between options, "telemetry" for watching state, and so on.
 */
export interface ScreenTemplate {
  name: string;
  kinds: DecisionKind[];
  why: string;
}

export const SCREEN_TEMPLATES: ScreenTemplate[] = [
  { name: "topology", kinds: ["topology"], why: "relationships are the content; the diagram is the screen" },
  { name: "list-detail", kinds: ["select", "compare", "explore"], why: "options on one side, detail on the other; choosing needs both visible" },
  { name: "model-analysis", kinds: ["inspect"], why: "one subject given the most room, context beside it" },
  { name: "runtime", kinds: ["configure", "author"], why: "controls beside a live preview, so a change is never a leap of faith" },
  { name: "telemetry", kinds: ["monitor"], why: "state at a glance above the signal, data beneath it" },
  { name: "integration", kinds: ["integration"], why: "providers listed with state, endpoint detail for the selection" },
];

/** Names the screen template for a decision kind. Every kind has exactly one. */
export function templateFor(kind: DecisionKind): ScreenTemplate {
  return SCREEN_TEMPLATES.find((t) => t.kinds.includes(kind)) ?? SCREEN_TEMPLATES[2]!;
}

/* -------------------------------------------------------------------------- */
/* Warnings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Flags an intent that will produce a generic result regardless of how well it
 * is executed.
 *
 * These are the §51 failure modes caught at planning time, which is far cheaper
 * than catching them in a render two passes later.
 */
function intentWarnings(intent: ScreenIntent, regions: PlannedRegion[]): string[] {
  const out: string[] = [];

  const metricish = /metric|total|count|average|avg|percentage|%/i;
  if (metricish.test(intent.primaryDecision)) {
    out.push(
      "The primary decision is phrased as a metric. Usually the number is the destination rather than the decision: " +
        "if the user only needs to read a value, a status rail is enough, and a whole screen for one number is where card walls come from. " +
        "If the number really is the decision - choosing between options by a figure - say what the options are.",
    );
  }

  if (!intent.availableInformation || intent.availableInformation.length === 0) {
    out.push(
      "No available information was listed. The planner will guess what to show. " +
        "Name the data you actually have - a plan built on assumed data produces confident, wrong layouts.",
    );
  }

  if (intent.primaryDecision.length > 80) {
    out.push("primaryDecision is unusually long. State it as a short noun phrase ('select a model'), not a sentence describing a screen.");
  }

  const generic = /dashboard|admin|overview|home|main page|analytics/i.test(intent.primaryDecision);
  if (generic) {
    out.push(
      `'${intent.primaryDecision}' names a page type, not a decision. Page types are what produce generic layouts. ` +
        "Name what the user decides here instead.",
    );
  }

  if (!intent.audience) {
    out.push("No audience given. Density and vocabulary will default to a general consumer, which is rarely right for infrastructure tooling.");
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Pass plan (§32)                                                             */
/* -------------------------------------------------------------------------- */

export interface PlannedPass {
  pass: number;
  name: string;
  /** What this pass may add. */
  add: string[];
  /** What this pass must not do yet. */
  hold: string[];
  /** How the pass is judged done. */
  done: string;
  /** Human approval required before moving on (§38). */
  checkpoint: boolean;
}

const PASS_NAMES = ["composition", "information", "visual refinement", "interaction states", "QA"] as const;

/**
 * The five-pass strategy from §32, specialised to this screen.
 *
 * The `hold` list is the important half. Without an explicit "not yet", a model
 * asked to build in passes will do everything in pass one anyway — the passes only
 * work if each says what it is *not* allowed to touch.
 */
export function planPasses(intent: ScreenIntent, regions: PlannedRegion[], composition: Composition): PlannedPass[] {
  const regionNames = regions.map((r) => r.id);

  return [
    {
      pass: 1,
      name: PASS_NAMES[0],
      add: [`Empty frames for: ${regionNames.join(", ")}`, "One headline naming the decision", "The primary visual as a single placeholder"],
      hold: [
        "No text content beyond the headline",
        "No repeated components - not one card, pill or row",
        "No metrics. Pass 1 is where three-card layouts appear, and they are impossible to remove once every region is full.",
      ],
      done: "You can name each region and say why it exists, and the composition is one you would defend.",
      checkpoint: true,
    },
    {
      pass: 2,
      name: PASS_NAMES[1],
      add: [
        `Labels and content inside: ${regionNames.join(", ")}`,
        `Real data from: ${(intent.availableInformation ?? []).join(", ") || "whatever you actually have"}`,
        "Controls the decision needs, and nothing more",
        "Component instances via find_component, not rebuilt from rectangles",
      ],
      hold: ["No visual polish. Spacing and type tuning is pass 3, and doing it now means doing it twice."],
      done: "A person who knows the domain can read every value and complete the decision.",
      checkpoint: false,
    },
    {
      pass: 3,
      name: PASS_NAMES[2],
      add: ["Spacing, scale, alignment, density", "Typography hierarchy and a monospaced face for machine data", "Whitespace as deliberate space, not leftover"],
      hold: ["No new content or regions. This pass only tunes what exists; adding here hides a structural problem."],
      done: "review_design returns no high-confidence findings and nothing looks accidental.",
      checkpoint: false,
    },
    {
      pass: 4,
      name: PASS_NAMES[3],
      add: ["hover, selected, disabled", "loading, empty, error, success"],
      hold: ["No layout changes. A state that does not fit reveals a pass 1 or 2 problem, not a state problem."],
      done: "Every state that can occur is drawn, especially empty and error.",
      checkpoint: false,
    },
    {
      pass: 5,
      name: PASS_NAMES[4],
      add: ["review_design, render_design (detail low), design_guard"],
      hold: ["No fixes invented from a render alone. Judge hierarchy and balance from the image; take structure from the tools."],
      done: "design_guard returns no FAIL, review_design has no high-confidence findings, and one render confirms the composition reads.",
      checkpoint: true,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                        */
/* -------------------------------------------------------------------------- */

export interface CompositionBox {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  why: string;
}

export interface ScreenPlan {
  intent: {
    goal?: string;
    audience?: string;
    primaryDecision: string;
    decisionKind: DecisionKind;
    canvas: { width: number; height: number; grid: number };
  };
  composition: Composition;
  /** The named screen template this plan follows (spec §14). */
  template: ScreenTemplate;
  /** The §31 2D model: geometry only, no content. */
  boxes: CompositionBox[];
  regions: PlannedRegion[];
  passes: PlannedPass[];
  /** Rule ids the plan is likely to trip, with what to do instead. */
  guardPreview: Array<{ rule: string; therefore: string }>;
  /** Composition alternatives worth putting to the user (§38). */
  alternatives: Array<{ composition: Composition; trade: string }>;
  warnings: string[];
  /** Ready to hand to design_runtime as a region skeleton. */
  program: {
    canvas: { name: string; width: number; height: number; grid: number };
    regions: Array<{ fn: string; id: string; args: Record<string, unknown> }>;
  };
}

/**
 * Produces the full screen plan.
 *
 * Geometry is resolved through the real layout engine rather than invented here,
 * so the plan shows the same numbers the build will produce. A plan that
 * disagreed with the build would be worse than no plan.
 */
export function planScreen(rawIntent: ScreenIntent): ScreenPlan {
  const intent: ScreenIntent = { ...rawIntent };

  const width = typeof intent.canvas?.width === "number" ? intent.canvas.width : 1440;
  const height = typeof intent.canvas?.height === "number" ? intent.canvas.height : 900;
  const grid = typeof intent.canvas?.grid === "number" && intent.canvas.grid > 0 ? intent.canvas.grid : 8;

  const decisionKind = classifyDecision(intent.primaryDecision);

  let regions = SHELLS[decisionKind](intent);

  // An explicit preference wins, but only among compositions that make sense for
  // the roles in play. Overriding to `canvas` for a topology screen would produce
  // a map with no room for it.
  const inferred = inferComposition(regions.map((r) => ({ role: r.role, composition: r.composition, width: r.width, grow: r.grow })));
  const viable = new Set<Composition>(["editorial", "instrument", "canvas", "topology", "table", "timeline", "split-view", "spatial"]);
  const requested = intent.desiredComposition;

  const composition: Composition = requested && viable.has(requested) && requested !== "canvas" ? requested : inferred;

  if (requested === "canvas" && inferred !== "canvas") {
    intent.desiredComposition = undefined;
  }

  // Resolve geometry with the actual engine so the plan and the build agree.
  const gutter = defaultGutter(grid);
  const irRegions = regions.map((r) => ({
    id: r.id,
    role: r.role,
    composition: r.composition,
    width: r.width,
    height: r.height,
    grow: r.grow,
    children: [] as string[],
    gap: r.gap,
    padding: r.padding,
  })) as Region[];

  const laid = layoutRegions({ regions: irRegions, canvasW: width, canvasH: height, gutter });
  const byId = new Map(laid.map((r) => [r.id, r]));

  const boxes: CompositionBox[] = regions.map((r) => {
    const box = byId.get(r.id);
    return {
      name: r.id,
      x: box?.x ?? 0,
      y: box?.y ?? 0,
      w: Math.round(box?.w ?? 0),
      h: Math.round(box?.h ?? 0),
      why: r.because,
    };
  });

  const warnings = intentWarnings(intent, regions);

  // Would this plan trip a product rule? Checked against the *plan*, before any
  // content exists, which is the only moment a structural change is still cheap.
  const guardPreview = previewRules(regions, intent);

  const alternatives = viableAlternatives(composition, decisionKind);

  const passes = planPasses(intent, regions, composition);

  return {
    intent: {
      ...(intent.goal !== undefined ? { goal: intent.goal } : {}),
      ...(intent.audience !== undefined ? { audience: intent.audience } : {}),
      primaryDecision: intent.primaryDecision,
      decisionKind,
      canvas: { width, height, grid },
    },
    composition,
    template: templateFor(decisionKind),
    boxes,
    regions,
    passes,
    guardPreview,
    alternatives,
    warnings,
    program: {
      canvas: { name: intent.name ?? screenName(intent), width, height, grid },
      regions: regions.map((r) => ({
        fn: primitiveFor(r.role),
        id: r.id,
        args: {
          ...(typeof r.width === "number" ? { width: r.width } : { width: r.width }),
          ...(typeof r.height === "number" ? { height: r.height } : { height: r.height }),
          ...(r.grow > 0 ? { grow: r.grow } : {}),
          ...(r.gap !== undefined ? { gap: r.gap } : {}),
          ...(r.padding !== undefined ? { padding: r.padding } : {}),
          composition: r.composition,
        },
      })),
    },
  };
}

/* -------------------------------------------------------------------------- */

/** Maps a semantic role onto the runtime primitive that creates it. */
function primitiveFor(role: Region["role"]): string {
  switch (role) {
    case "navigation":
      return "navigation";
    case "header":
      return "header";
    case "hero":
    case "primary-visual":
      return "hero";
    case "inspector":
      return "inspector";
    default:
      return "frame";
  }
}

/**
 * A screen name derived from the decision.
 *
 * Humanised rather than slugified: this becomes a Figma layer name, and
 * `SelectModelScreen` in the layer list helps nobody.
 */
function screenName(intent: ScreenIntent): string {
  const words = intent.primaryDecision
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length === 0) return "Screen";
  const [first, ...rest] = words;
  return [first!, ...rest].map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

/**
 * Compositions worth putting to the user.
 *
 * §38 asks for a checkpoint when a major composition choice is uncertain. Rather
 * than always stalling, only offer alternatives when there is a genuine trade —
 * two options that would both work is noise.
 */
function viableAlternatives(composition: Composition, kind: DecisionKind): Array<{ composition: Composition; trade: string }> {
  const out: Array<{ composition: Composition; trade: string }> = [];

  if (kind === "monitor" || kind === "topology") {
    out.push({ composition: "instrument", trade: "denser, more numeric, reads as telemetry rather than as an object" });
    out.push({ composition: "editorial", trade: "more whitespace and fewer readouts, reads as a report rather than a monitor" });
  } else if (kind === "select" || kind === "compare") {
    out.push({ composition: "table", trade: "rows read across for comparison, cheaper per option" });
    out.push({ composition: "spatial", trade: "options positioned by some measure, better when one option is clearly better" });
  } else if (kind === "explore" || kind === "inspect") {
    out.push({ composition: "split-view", trade: "list and detail side by side, more context per item" });
    out.push({ composition: "canvas", trade: "one thing at a time, less scanning" });
  }

  return out.filter((a) => a.composition !== composition).slice(0, 2);
}

/**
 * Checks the plan against the product rules that can be judged without content.
 *
 * Only structural rules are previewable here: a rule about text or component
 * counts cannot fire until there is text or components. Pretending otherwise
 * would report a clean plan for a screen that later fails, which is worse than
 * reporting nothing.
 */
function previewRules(regions: PlannedRegion[], intent: ScreenIntent): Array<{ rule: string; therefore: string }> {
  const out: Array<{ rule: string; therefore: string }> = [];

  const metricish = /metric|total|count|average|avg|percentage|kpi|stat/i.test(intent.primaryDecision);
  const hasCardishRegion = regions.some((r) => r.id === "content" && (r.composition === "table" || r.composition === "canvas"));

  if (metricish && hasCardishRegion) {
    const rule = defaultRules().find((r) => r.id === "exo.no-generic-saas");
    if (rule) {
      out.push({
        rule: rule.id,
        therefore: `The decision is phrased as a metric and this plan has a content region that could become a card row. ${rule.therefore} Keep the metric as one readout inside a wider surface, not as the screen's organising idea.`,
      });
    }
  }

  const railCount = regions.filter((r) => r.role === "status-rail").length;
  if (railCount > 1) {
    out.push({
      rule: "composition.rail-count",
      therefore: `${railCount} status rails will read as competing headers. Merge them into one rail above the content.`,
    });
  }

  if (regions.length > 4) {
    out.push({
      rule: "composition.region-count",
      therefore: `${regions.length} regions on one screen is a lot to hold at once. Check whether two of them belong on the same surface before building.`,
    });
  }

  return out;
}