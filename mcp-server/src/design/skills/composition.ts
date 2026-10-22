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
import { classifyDecision } from "../../plan/planner";

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
  version: "v1",
  name: "Visual hierarchy and composition strategy",
  purpose:
    "Selects a composition archetype from the decision the screen supports and the content shape the brief supplies, with density, whitespace, focal role and rejected alternatives stated for review.",
  signals: ["content-inventory", "spatial-request", "form-task", "many-regions", "card-grid-risk"],
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
    decisions.push({
      skill: SPEC.id,
      dimension: "density",
      key: "visual-intent.density",
      value: density,
      why: "From the archetype's density rule for this decision figure and content shape.",
      hard: false,
    });
    decisions.push({
      skill: SPEC.id,
      dimension: "spacing",
      key: "visual-intent.rhythm",
      value: choice.whitespace,
      why: "The archetype's whitespace contract.",
      hard: false,
    });
    decisions.push({
      skill: SPEC.id,
      dimension: "typography",
      key: "visual-intent.alignment",
      value: choice.alignment,
      why: alignmentWhy(choice.alignment),
      hard: false,
    });
    return {
      skill: SPEC.id,
      decisions,
      notes: [
        `Composition archetype contract: ${choice.archetype} (planner runs after this and derives regions; the plan is reviewed against this contract).`,
      ],
    };
  },
};

function alignmentWhy(alignment: "strong" | "loose"): string {
  return alignment === "strong"
    ? "Numeric scanning rewards strict grid alignment; tune up alignment when values update in place."
    : "Editorial composition breathes: alignment stays loose so the rhythm rests with the content.";
}
