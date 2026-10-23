/**
 * Skill: visual hierarchy and composition strategy (issue #22, skill B).
 *
 * ## What it does
 *
 * Chooses a composition archetype from what the user came to do and what the
 * screen must show — before the planner runs — and states why that archetype
 * fits and which others were rejected. Densities and whitespace follow from
 * the content shape, audience and the manner the direction skill derived.
 *
 * ## Honest boundary
 *
 * The planner (plan/planner.ts `planScreen`) still decides the composition
 * from the derived regions; this skill produces the archetype contract the
 * plan is reviewed against, and the compiler carries its density and rhythm
 * into `visualIntent`. The grep-able truth: a skill decision here should be
 * explainable from the brief alone, and the planner's own derivation should
 * reach the same answer for a well-formed brief — when it does not, that
 * difference is worth surfacing in review, not papering over.
 */
import type { SkillDecision, SkillEntry, SkillOutput, SkillSpec } from "./contracts";
import type { NormalizedBrief } from "../../pipeline/contracts";
import type { CompositionHint } from "../composition/planner";
import { classifyDecision } from "../../plan/planner";

/* -------------------------------------------------------------------------- */
/* Composition descriptor vocabulary (issue #24, item 3)                        */
/* -------------------------------------------------------------------------- */

/**
 * The closed vocabulary of composition descriptors the skill can translate.
 * A descriptor is a *composition* word, not a manner word: it says how the
 * canvas is arranged, not how it feels. Keeping the set closed is what makes
 * the ledger honest — a word outside it is recorded untranslated rather than
 * guessed at.
 */
export const COMPOSITION_VOCABULARY = [
  "asymmetric",
  "split",
  "centered",
  "radial",
  "dense-editorial",
  "topology-over-inspector",
] as const;

export type CompositionDescriptor = (typeof COMPOSITION_VOCABULARY)[number];

/** The arrangement family: two arrangements contradict each other. */
const ARRANGEMENT_FAMILY: CompositionDescriptor[] = ["asymmetric", "split", "centered", "radial"];

/**
 * What each descriptor commits to, in terms the planner consumes. `density`,
 * `rhythm` and `alignment` override the archetype's defaults *with provenance*
 * (the archetype's value stays in the decision trail); `geometry`,
 * `negativeSpace` and `focalPosture` are plan-level commitments that ride the
 * hint into `design/composition/planner.ts`.
 */
const DESCRIPTOR_SPECS: Record<CompositionDescriptor, Omit<CompositionHint, "descriptor" | "why">> = {
  asymmetric: {
    geometryStrategy: "asymmetric two-column weight: one tall dominant column beside a narrow one",
    geometryRules: ["left-to-right weight bias; the dominant column holds the focal content"],
    negativeSpaceStrategy: "negative space gathers on the light side so the weight difference reads as intent",
    focalPosture: "the dominant column carries the focal region",
  },
  split: {
    geometryStrategy: "equal split: two columns of equal width with a hard boundary",
    geometryRules: ["equal column widths; the boundary between the halves is a structural line, not a gradient"],
    negativeSpaceStrategy: "negative space sits inside each half; the halves themselves stay fully weighted",
    focalPosture: "the focal region anchors one half; the other half answers it",
  },
  centered: {
    geometryStrategy: "single centered axis: the focal content sits on the vertical centre line",
    geometryRules: ["content symmetric around the centre axis; nothing breaks the axis without a reason"],
    negativeSpaceStrategy: "generous symmetric margins; whitespace frames the axis",
    focalPosture: "the focal region sits at centre, first on the axis",
  },
  radial: {
    geometryStrategy: "radial arrangement: content placed around a centre point, focal at the centre",
    geometryRules: ["even angular spacing where content allows; the centre holds the focal"],
    negativeSpaceStrategy: "negative space is the ring between spokes; the centre keeps breathing room",
    focalPosture: "the focal region occupies the centre of the arrangement",
  },
  "dense-editorial": {
    geometryStrategy: "dense readouts over an editorial grid: data columns inside an editorial column rhythm",
    geometryRules: ["readouts pack into aligned data columns; headlines keep editorial scale above them"],
    negativeSpaceStrategy: "editorial rhythm is generous between sections even though readouts pack tight",
    density: "dense",
    rhythm: "generous",
    focalPosture: "the largest readout cluster is the visual, the headline is the entry",
  },
  "topology-over-inspector": {
    geometryStrategy: "topology canvas with a subordinate inspector rail beside it",
    geometryRules: ["the canvas owns the width; the inspection column is a fixed subordinate width"],
    negativeSpaceStrategy: "whitespace lives in the canvas; the inspector column stays compact",
    focalPosture: "the canvas is the focal; the inspector never competes with it",
  },
};

/**
 * The plain words a person actually writes for each descriptor, beside its
 * canonical vocabulary name. The synonym set is closed under the same honesty
 * rule as the vocabulary itself: only real words for these six arrangements —
 * "topology" for topology-over-inspector, the way a user actually types it —
 * and nothing is guessed beyond them. No word appears under two descriptors,
 * so a direction word can never match the vocabulary ambiguously: one match
 * resolves to exactly one descriptor.
 */
export const DESCRIPTOR_SYNONYMS: Record<CompositionDescriptor, readonly string[]> = {
  asymmetric: ["asymmetrical"],
  split: ["split-view", "split view", "split-screen", "split screen"],
  centered: ["centred"],
  radial: ["hub-and-spoke", "hub and spoke"],
  "dense-editorial": ["dense editorial"],
  "topology-over-inspector": ["topology", "topology map", "network map", "network diagram", "node-link", "node link", "cluster map"],
};

/** Escapes a vocabulary phrase for exact text search. */
function escapePhrase(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NEGATOR_WORDS = ["not", "no", "without", "never", "anti", "non"];
/** Function words that may sit between a negator and the phrase it negates. */
const NEGATOR_FILLER = new Set(["a", "an", "the", "this", "that", "it", "its", "just", "really", "truly", "merely", "purely", "exactly"]);

/**
 * True when `text` ends with a negator immediately before the phrase match.
 *
 * Reading is loose adjacency: articles and emphasis words between the negator
 * and the phrase are crossed when scanning backwards up to four tokens ("not a
 * topology map" excludes; "a topology map next to it" does not), so the
 * grammar of a real direction does not defeat the exclusion.
 */
function precededByNegator(text: string, matchIndex: number): boolean {
  const before = text.slice(0, matchIndex).trimEnd().toLowerCase();
  if (before === "") return false;
  const tokens = before.split(/[\s\-_/]+/).filter((t) => t.length > 0);
  for (let i = tokens.length - 1, scanned = 0; i >= 0 && scanned < 4; i -= 1, scanned += 1) {
    const token = tokens[i]!;
    if (NEGATOR_FILLER.has(token)) continue;
    return NEGATOR_WORDS.includes(token);
  }
  return false;
}

export interface CompositionDescriptorFacts {
  /** Descriptors the direction states affirmatively, in order of appearance. */
  applied: CompositionDescriptor[];
  /** Descriptors the direction negates ('not asymmetric'), recorded by the direction skill. */
  excluded: CompositionDescriptor[];
}

/** Cached word-boundary pattern per descriptor phrase; inner spaces flexible. */
const PHRASE_PATTERNS = new Map<string, RegExp>();

function compiledPhrasePattern(phrase: string): RegExp {
  let pattern = PHRASE_PATTERNS.get(phrase);
  if (pattern === undefined) {
    const source = phrase
      .split(/\s+/)
      .map((word) => escapePhrase(word))
      .join("\\s+");
    // No "g" flag: every exec must answer with the leftmost match, so the
    // cached pattern carries no lastIndex state across calls.
    pattern = new RegExp(`(?<![a-zA-Z\\-])${source}(?![a-zA-Z\\-])`, "i");
    PHRASE_PATTERNS.set(phrase, pattern);
  }
  return pattern;
}

/**
 * Reads the composition descriptors out of a direction string.
 *
 * Each descriptor is matched through its canonical vocabulary name *and* its
 * plain-word synonyms (DESCRIPTOR_SYNONYMS), on word boundaries
 * case-insensitively — 'split' never matches 'split-view' mid-word, and
 * 'topology' matches at the string's start, at its end, and before
 * punctuation. Per descriptor the match that comes first in the string wins
 * (equal indexes keep the canonical name first), which decides applied versus
 * excluded together with the negation rule, so a phrase pair like
 * 'topology … not network map' records the direction honestly rather than
 * letting a later synonym override the earlier word. The outer loop runs in
 * vocabulary order, so `applied` is stable across calls.
 */
export function detectCompositionDescriptors(direction: string): CompositionDescriptorFacts {
  const applied: CompositionDescriptor[] = [];
  const excluded: CompositionDescriptor[] = [];
  for (const descriptor of COMPOSITION_VOCABULARY) {
    let first: number | null = null;
    for (const phrase of [descriptor, ...DESCRIPTOR_SYNONYMS[descriptor]]) {
      const match = compiledPhrasePattern(phrase).exec(direction);
      if (match !== null && (first === null || match.index < first)) first = match.index;
    }
    if (first === null) continue;
    if (precededByNegator(direction, first)) excluded.push(descriptor);
    else applied.push(descriptor);
  }
  return { applied, excluded };
}

/** True when the word is (part of) this skill's descriptor vocabulary. */
export function isCompositionDescriptor(word: string): boolean {
  return (COMPOSITION_VOCABULARY as readonly string[]).includes(word.toLowerCase());
}

/**
 * The composition-hint sources, resolved in priority order with named
 * provenance — the receipt both plan_screen and the pipeline report from, so
 * the two paths cannot disagree.
 *
 * Two sources exist: the composition the caller *requests*
 * (`desiredComposition` names a descriptor or one of its plain words —
 * 'topology' asks for topology-over-inspector, 'split-view' for split) and
 * the descriptors the direction states in words. The requested composition
 * has priority: it is an explicit instruction, where a direction word is
 * manner; when both name a descriptor the requested one is applied first and
 * the direction's remaining descriptors follow, and both provenance clauses
 * are recorded so the receipt never hides a source. Honesty is preserved:
 * a negated direction word ('not asymmetric') contributes only to
 * `excluded` and never applies, a composition name outside the vocabulary
 * ('dashboard') contributes nothing, and with neither source present
 * `applied` is empty so no hint is compiled and the receipt stays false.
 */
export interface CompositionHintSources {
  /** Descriptors that will shape the composition hint, requested composition first. */
  applied: CompositionDescriptor[];
  /** Descriptors the direction negates ('not asymmetric'); never applied. */
  excluded: CompositionDescriptor[];
  /** One provenance clause per source that fired, requested composition first. */
  why: string;
}

/**
 * Which descriptor(s) a *requested* composition label names, if any. The
 * closed vocabulary and its synonyms decide: 'topology' names
 * topology-over-inspector and 'split-view' names split, while a plain
 * composition name outside it ('dashboard', 'table', 'canvas') resolves to
 * none, so a requested composition produces a hint only where the vocabulary
 * says one exists.
 */
export function descriptorsForRequestedComposition(desiredComposition: string | null | undefined): CompositionDescriptor[] {
  if (desiredComposition === undefined || desiredComposition === null) return [];
  return detectCompositionDescriptors(desiredComposition).applied;
}

export function resolveCompositionHintSources(input: {
  desiredComposition?: string | null;
  visualDirection?: string | null;
}): CompositionHintSources {
  const requestedName = input.desiredComposition;
  const direction = input.visualDirection;
  const requested = requestedName !== undefined && requestedName !== null ? detectCompositionDescriptors(requestedName).applied : [];
  const stated =
    direction !== undefined && direction !== null ? detectCompositionDescriptors(direction) : { applied: [], excluded: [] };
  const applied: CompositionDescriptor[] = [];
  for (const descriptor of requested) applied.push(descriptor);
  for (const descriptor of stated.applied) if (!applied.includes(descriptor)) applied.push(descriptor);
  // Each clause is its own sentence (priority respected, request first), so
  // they are joined with spaces rather than semicolons through the periods.
  const clauses: string[] = [];
  if (requested.length > 0) clauses.push(`Requested composition: ${requestedName}.`);
  if (stated.applied.length > 0) clauses.push(`Stated in the direction: '${direction}'.`);
  return { applied, excluded: stated.excluded, why: clauses.join(" ") };
}

/**
 * Builds the planner hint for applied descriptors. Arrangement descriptors are
 * exclusive — the first one wins and later ones are returned as `superseded`
 * so the caller can record them — while role overlays ('dense-editorial',
 * 'topology-over-inspector') stack on any arrangement.
 */
export function compositionHintFor(
  descriptors: readonly CompositionDescriptor[],
  why: string,
): { hint: CompositionHint; superseded: CompositionDescriptor[] } {
  const hint: CompositionHint = { descriptor: "", why };
  const superseded: CompositionDescriptor[] = [];
  let arrangementUsed = false;
  for (const descriptor of descriptors) {
    const spec = DESCRIPTOR_SPECS[descriptor];
    if (spec === undefined) continue;
    const isArrangement = ARRANGEMENT_FAMILY.includes(descriptor);
    if (isArrangement && arrangementUsed) {
      superseded.push(descriptor);
      continue;
    }
    if (isArrangement) arrangementUsed = true;
    if (hint.descriptor.length === 0) hint.descriptor = descriptor;
    else hint.descriptor = `${hint.descriptor}+${descriptor}`;
    if (spec.density !== undefined) hint.density = spec.density;
    if (spec.rhythm !== undefined) hint.rhythm = spec.rhythm;
    if (spec.alignment !== undefined) hint.alignment = spec.alignment;
    if (spec.geometryStrategy !== undefined) hint.geometryStrategy = spec.geometryStrategy;
    if (spec.geometryRules !== undefined) hint.geometryRules = spec.geometryRules;
    if (spec.negativeSpaceStrategy !== undefined) hint.negativeSpaceStrategy = spec.negativeSpaceStrategy;
    if (spec.focalPosture !== undefined) hint.focalPosture = spec.focalPosture;
  }
  return { hint, superseded };
}

/** The archetype vocabulary of this skill (issue B's list). */
const ARCHETYPES = [
  "editorial-focus",
  "asymmetric",
  "split-view",
  "workspace",
  "data-dense",
  "canvas",
  "list-detail",
  "form-led",
  "dashboard",
] as const;

type Archetype = (typeof ARCHETYPES)[number];

/** The decision figures the planner classifies; reused, not re-derived. */
type DecisionFigure = ReturnType<typeof classifyDecision>;

interface ArchetypeChoice {
  archetype: Archetype;
  /** Why this fits the decision figure and content shape. */
  rationale: string;
  density: "airy" | "calm" | "balanced" | "dense";
  /** The whitespace contract: generous/even/tight between regions. */
  whitespace: "generous" | "even" | "tight";
  focalRole: string;
  alignment: "strong" | "loose";
  rejected: Array<{ archetype: Archetype; why: string }>;
}

interface ContentShape {
  decision: DecisionFigure;
  infoCount: number;
  hasNumericReadouts: boolean;
  hasSpatialRelations: boolean;
}

const NUMERIC_KEY = /\b(\d|percent|%|rate|latency|throughput|ms|count|score|status|uptime|health|load|pressure)\b/i;

/** Reads the content shape out of the brief, once. */
function contentShape(brief: NormalizedBrief): ContentShape {
  const info = [...brief.requiredInformation, ...brief.optionalInformation];
  const hasNumericReadouts = info.filter((i) => NUMERIC_KEY.test(i)).length >= 2;
  const hasSpatialRelations =
    brief.desiredComposition !== undefined && ["canvas", "topology", "spatial", "diagram"].includes(brief.desiredComposition);
  return {
    decision: classifyDecision(brief.primaryDecision),
    infoCount: info.length,
    hasNumericReadouts,
    hasSpatialRelations,
  };
}

/** Chooses the archetype from the decision figure and content shape. */
function chooseArchetype(shape: ContentShape, brief: NormalizedBrief): ArchetypeChoice {
  /* A caller-specified composition is a hard constraint: it wins, and the
     skill records what it thinks would have been tried otherwise. */
  if (brief.desiredComposition !== undefined) {
    return {
      archetype: brief.desiredComposition as Archetype,
      rationale: `The caller insists on '${brief.desiredComposition}'; composition overrides the archetype vocabulary where it maps.`,
      density: "balanced",
      whitespace: "even",
      focalRole: `the caller's '${brief.desiredComposition}' composition decides where the eye lands; reviewed against that instead of an archetype`,
      alignment: "loose",
      rejected: [
        { archetype: "editorial-focus", why: "Rejected in favour of the caller's explicit composition." },
      ],
    };
  }

  const numeric = shape.hasNumericReadouts;
  const switches: Record<DecisionFigure, () => ArchetypeChoice> = {
    monitor: () => ({
      archetype: "workspace",
      rationale:
        "Monitoring is a live instrument over a working area; a status rail next to an instrument field keeps state glanceable.",
      density: numeric ? "balanced" : "calm",
      whitespace: numeric ? "even" : "generous",
      focalRole: "the instrument field: the signals that decide 'intervene or not' live there",
      alignment: numeric ? "strong" : "loose",
      rejected: [
        { archetype: "dashboard", why: "A grid of metrics has no place for the working area the decision is made in." },
        { archetype: "editorial-focus", why: "Monitoring is scanned continuously, not read once." },
      ],
    }),
    compare: () => ({
      archetype: "split-view",
      rationale: "Comparison reads two things against one another at the same time; a split keeps them equally present.",
      density: "balanced",
      whitespace: "even",
      focalRole: "the differences column — the only thing a comparison is actually for",
      alignment: "strong",
      rejected: [
        { archetype: "dashboard", why: "Side-by-side equality is the point; tiles break the alignment." },
      ],
    }),
    configure: () => ({
      archetype: "form-led",
      rationale: "Configuring is a guided edit task; a form beside what it configures beats a field grid.",
      density: "balanced",
      whitespace: "even",
      focalRole: "the form, with the preview as its immediate consequence",
      alignment: "strong",
      rejected: [{ archetype: "data-dense", why: "Densities help scanning, not editing." }],
    }),
    explore: () => ({
      archetype: "list-detail",
      rationale: "Finding is narrowing a list and looking at one of them; list-detail is the honest shape of that.",
      density: "balanced",
      whitespace: "even",
      focalRole: "the list's selected item detail, once something is chosen",
      alignment: "loose",
      rejected: [{ archetype: "canvas", why: "Spatial exploration is only right when relations are the point." }],
    }),
    select: () => ({
      archetype: "list-detail",
      rationale: "Choosing between options needs the options beside enough detail to choose well.",
      density: "balanced",
      whitespace: "even",
      focalRole: "the options, ranked with the detail that separates them",
      alignment: "loose",
      rejected: [{ archetype: "dashboard", why: "An overview of tiles does not show why one option wins." }],
    }),
    deploy: () => ({
      archetype: "list-detail",
      rationale:
        "Launching onto the fleet compares candidates in rows beside the automatic placement recommendation; the fit verdict and the commit step must both be visible.",
      density: "balanced",
      whitespace: "even",
      focalRole: "the automatic placement recommendation: where the model runs and whether it fits",
      alignment: "strong",
      rejected: [
        { archetype: "dashboard", why: "A grid of metrics carries no fit verdict and no commit action." },
        { archetype: "form-led", why: "A form would present placement as manual configuration instead of a recommendation." },
      ],
    }),
    inspect: () => ({
      archetype: "data-dense",
      rationale:
        "Understanding one thing thoroughly wants a focused readout with supporting context in a dense column, not air.",
      density: numeric ? "balanced" : "calm",
      whitespace: numeric ? "tight" : "even",
      focalRole: "the readout that answers 'what happened and why'",
      alignment: "strong",
      rejected: [{ archetype: "editorial-focus", why: "A big headline shows the verdict but not the evidence." }],
    }),
    topology: () => ({
      archetype: "canvas",
      rationale: "Connections are the point; a spatial canvas with routed connectors shows them honestly.",
      density: "airy",
      whitespace: "generous",
      focalRole: "the strained or central node: the map exists to find it",
      alignment: "loose",
      rejected: [{ archetype: "dashboard", why: "Tiles destroy adjacency, which is the information." }],
    }),
    integration: () => ({
      archetype: "split-view",
      rationale: "Provider list beside endpoint detail is the shape of a connections desk.",
      density: "balanced",
      whitespace: "even",
      focalRole: "the connected provider's endpoint state",
      alignment: "strong",
      rejected: [{ archetype: "form-led", why: "A form hides the provider list, which is the navigation." }],
    }),
    author: () => ({
      archetype: "canvas",
      rationale: "Creating needs a surface with controls; canvas plus controls is honest.",
      density: "airy",
      whitespace: "even",
      focalRole: "the surface being composed on",
      alignment: "loose",
      rejected: [{ archetype: "list-detail", why: "A list is not a place to compose in." }],
    }),
  };
  const choice = switches[shape.decision]();
  if (numeric && choice.density !== "dense") choice.alignment = "strong";
  return choice;
}

const SPEC: SkillSpec = {
  id: "composition-strategy",
  version: "v2",
  name: "Visual hierarchy and composition strategy",
  purpose:
    "Selects a composition archetype from the decision the screen supports and the content shape the brief supplies, with density, whitespace, focal role and rejected alternatives stated for review.",
  signals: ["content-inventory", "spatial-request", "form-task", "many-regions", "card-grid-risk", "composition-request"],
  whenToUse: "A brief with any inventory of information, or an explicit composition request.",
  whenNotToUse:
    "A bare brief with only a primary decision: the planner's shells already cover a one-line brief and this skill would add vocabulary to a plan there is nothing to constrain.",
  expectedOutput:
    "Archetype, density, whitespace rhythm, focal role, alignment logic and honest rejections of at least one alternative archetype.",
  requiredInputs: ["brief.primaryDecision", "brief.information"],
  optionalContext: ["brief.desiredComposition", "brief.audience", "brief.dataMode"],
  decisionRules: [
    {
      id: "decision-first",
      dimension: "composition",
      rule: "The primary decision figure (select/monitor/configure/explore/inspect/compare/topology/integration/author) picks the archetype; manner never overrides it.",
      why: "Composition serves the task; 'premium' is a manner, not a layout.",
    },
    {
      id: "caller-composition-wins",
      dimension: "composition",
      rule: "An explicit desiredComposition is a hard constraint and wins, recorded as such.",
      why: "The caller overrides; the skill records its recommendation lost to the override instead of silently winning.",
    },
    {
      id: "descriptor-vocabulary-closed",
      dimension: "composition",
      rule:
        "Composition descriptor words in the direction (asymmetric, split, centered, radial, dense-editorial, topology-over-inspector) compile to concrete density/geometry/negative-space commitments and a planner hint; at most one arrangement descriptor survives (the first), role overlays stack on it, and words outside the vocabulary are never guessed at.",
      why: "A composition word that silently changed layout would be an unexplained difference between what the caller asked for and what the plan shows.",
    },
    {
      id: "density-from-evidence",
      dimension: "density",
      rule: "Density follows numeric readout share and task type; a scanning task with many live readouts may not be airy by default.",
      why: "Scanability is a functional requirement, not a style preference.",
    },
    {
      id: "whitespace-by-scale",
      dimension: "spacing",
      rule: "Whitespace strategy stated as generous/even/tight, consistent with density and the decision's reading pattern.",
      why: "Spacing rhythm is the main lever from archetype to executed look.",
    },
  ],
  outputs: [
    {
      field: "archetype-contract",
      description: "The archetype the plan is reviewed against, with rationale and rejections.",
      consumedBy: ["design/skills/intent-compiler.ts (decision trail)", "design/skills/anti-generic.ts (review alignment)"],
    },
    {
      field: "intent-density",
      description: "Compiled density decision.",
      consumedBy: ["shared/ir.ts VisualIntentSchema.density", "mcp-server/src/runtime/interpreter.ts GAP_SCALE"],
    },
    {
      field: "intent-rhythm",
      description: "Compiled whitespace rhythm decision.",
      consumedBy: ["shared/ir.ts VisualIntentSchema.rhythm", "mcp-server/src/runtime/compile.ts rhythmScale"],
    },
    {
      field: "intent-alignment",
      description: "Compiled alignment logic decision.",
      consumedBy: ["shared/ir.ts VisualIntentSchema.alignment", "mcp-server/src/runtime/compile.ts alignGrid"],
    },
    {
      field: "intent-composition",
      description:
        "Closed-vocabulary composition descriptor compiled to visualIntent.composition, plus the plan-level composition hint.",
      consumedBy: [
        "shared/ir.ts VisualIntentSchema.composition",
        "design/composition/planner.ts buildCompositionPlan / applyCompositionHint",
        "design/skills/intent-compiler.ts (ledger)",
      ],
    },
  ],
  qualityChecks: [
    {
      id: "archetype-not-default",
      dimension: "composition",
      criterion: "Every archetype named comes with a rationale naming the decision figure and content evidence.",
    },
    {
      id: "rejected-alternatives-present",
      dimension: "composition",
      criterion: "At least one alternative archetype is rejected with a reason, not an unexplained default.",
    },
    {
      id: "density-consistent",
      dimension: "density",
      criterion: "Compiled density is one of airy/calm/balanced/dense and consistent with the archetype's numeric-readout rule.",
    },
  ],
  examples: [
    {
      summary: "A 'configure rate limiting' brief compiles to form-led, not a dashboard",
      why: "The configure decision figure names form-led; the rejected alternative records why data-dense would be wrong.",
    },
  ],
  counterexamples: [
    {
      summary: "'Monitor cluster health' with four live readouts compiles dense and grid-aligned",
      why: "Monitoring with numeric readouts gets balanced-to-dense instruments, never an airy card grid.",
    },
  ],
  fixtures: ["issue-22-composition-strategy-briefs"],
};

export const compositionStrategy: SkillEntry = {
  spec: SPEC,

  apply({ brief }: { brief: NormalizedBrief }): SkillOutput {
    const shape = contentShape(brief);
    const choice = chooseArchetype(shape, brief);
    const hard = brief.desiredComposition !== undefined;
    const notes: string[] = [
      `Composition archetype contract: ${choice.archetype} (planner runs after this and derives regions; the plan is reviewed against this contract).`,
    ];
    const decisions: SkillDecision[] = [
      {
        skill: SPEC.id,
        dimension: "composition",
        key: "archetype",
        value: choice.archetype,
        why: choice.rationale + (shape.infoCount > 0 ? ` Content shape: ${shape.infoCount} information item(s), numeric readouts ${shape.hasNumericReadouts ? "present" : "absent"}, spatial request ${shape.hasSpatialRelations ? "stated" : "not stated"}.` : ""),
        hard,
      },
      {
        skill: SPEC.id,
        dimension: "composition",
        key: "focal-role",
        value: choice.focalRole,
        why: "The archetype names what the eye is for, so the plan's focal can be checked against it.",
        hard: false,
      },
    ];
    for (const rejected of choice.rejected) {
      decisions.push({
        skill: SPEC.id,
        dimension: "composition",
        key: `rejected:${rejected.archetype}`,
        value: rejected.why,
        why: "Stated so the composition is a decision, not the absence of one.",
        hard: false,
      });
    }
    const density = shape.decision === "inspect" && shape.hasNumericReadouts ? ("dense" as const) : choice.density;
    let rhythm = choice.whitespace;
    let alignment = choice.alignment;

    /* --- composition descriptors from the direction (issue #24, item 3) ------ */

    let recordedDensity = density;
    if (brief.visualDirection !== null) {
      const facts = detectCompositionDescriptors(brief.visualDirection);
      if (facts.applied.length > 0) {
        const { hint, superseded } = compositionHintFor(facts.applied, `Stated in the direction: '${brief.visualDirection}'.`);
        const shellOverride = brief.desiredComposition !== undefined
          ? ` The brief's stated composition ('${brief.desiredComposition}') remains the hard shell constraint; the descriptor shapes the arrangement manner inside it.`
          : "";
        for (const rejected of superseded) {
          notes.push(
            `Composition descriptor '${rejected}' contradicts the arrangement '${facts.applied[0]}', which appeared first in the direction; the descriptor is recorded but not applied.`,
          );
        }
        decisions.push({
          skill: SPEC.id,
          dimension: "composition",
          key: "visual-intent.composition",
          value: hint.descriptor,
          why: `Compiled from the direction '${brief.visualDirection}': closed-vocabulary descriptors resolve to concrete density/geometry/negative-space commitments (` +
            [hint.geometryStrategy, hint.negativeSpaceStrategy, hint.density !== undefined ? `density ${hint.density}` : undefined, hint.focalPosture].filter(Boolean).join("; ") +
            `).${shellOverride}`,
          hard: false,
        });
        decisions.push({
          skill: SPEC.id,
          dimension: "composition",
          key: "composition-hint",
          value: hint.descriptor,
          why: `Plan-level hint consumed by design/composition/planner.ts (applyCompositionHint): geometry strategy '${hint.geometryStrategy ?? "unchanged"}', negative space '${hint.negativeSpaceStrategy ?? "unchanged"}'.${shellOverride}`,
          hard: false,
        });
        /* The descriptor overrides the archetype's manner where it commits to
           one — with the overridden value kept visible in the why. */
        if (hint.density !== undefined && hint.density !== recordedDensity) {
          decisions.push({
            skill: SPEC.id,
            dimension: "density",
            key: "density overridden",
            value: recordedDensity,
            why: `The descriptor '${hint.descriptor}' commits density ${hint.density}; the archetype's '${recordedDensity}' stays here for audit.`,
            hard: false,
          });
          recordedDensity = hint.density;
        }
        if (hint.rhythm !== undefined && hint.rhythm !== rhythm) {
          decisions.push({
            skill: SPEC.id,
            dimension: "spacing",
            key: "rhythm overridden",
            value: rhythm,
            why: `The descriptor '${hint.descriptor}' commits rhythm ${hint.rhythm}; the archetype's '${rhythm}' stays here for audit.`,
            hard: false,
          });
          rhythm = hint.rhythm;
        }
        if (hint.alignment !== undefined && hint.alignment !== alignment) {
          decisions.push({
            skill: SPEC.id,
            dimension: "typography",
            key: "alignment overridden",
            value: alignment,
            why: `The descriptor '${hint.descriptor}' commits alignment ${hint.alignment}; the archetype's '${alignment}' stays here for audit.`,
            hard: false,
          });
          alignment = hint.alignment;
        }
        notes.push(
          `Composition descriptors [${facts.applied.join(", ")}] compiled into the composition plan hint with the overridden manner values recorded in the trail.`,
        );
      }
      if (facts.excluded.length > 0) {
        notes.push(`Composition descriptor(s) excluded by negation in the direction: ${facts.excluded.join(", ")}.`);
      }
    }

    decisions.push({
      skill: SPEC.id,
      dimension: "density",
      key: "visual-intent.density",
      value: recordedDensity,
      why: "From the archetype's density rule for this decision figure and content shape; overridden by a composition descriptor when the direction states one.",
      hard: false,
    });
    decisions.push({
      skill: SPEC.id,
      dimension: "spacing",
      key: "visual-intent.rhythm",
      value: rhythm,
      why: "The archetype's whitespace contract; overridden by a composition descriptor when the direction states one.",
      hard: false,
    });
    decisions.push({
      skill: SPEC.id,
      dimension: "typography",
      key: "visual-intent.alignment",
      value: alignment,
      why: alignmentWhy(alignment),
      hard: false,
    });
    return { skill: SPEC.id, decisions, notes };
  },
};

function alignmentWhy(alignment: "strong" | "loose"): string {
  return alignment === "strong"
    ? "Numeric scanning rewards strict grid alignment; tune up alignment when values update in place."
    : "Editorial composition breathes: alignment stays loose so the rhythm rests with the content.";
}
