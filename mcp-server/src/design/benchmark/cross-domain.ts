/**
 * Cross-domain benchmark (GitHub issue #27) — does the planner guard design
 * for the domain the brief describes, or does everything still come out as an
 * EXO admin console?
 *
 * Issue #27 made the planner and the product guard product-agnostic: product
 * behaviour lives only inside a typed Project Design Profile, and a project
 * with no profile plans and vets under general, domain-neutral defaults.
 * Before that boundary, EXO's vocabulary, archetype inference, runtime states
 * and rule vetos were engine defaults — every screen from an editorial page to
 * a landing narrative was planned with an EXO flavour it never asked for.
 *
 * This suite pins the boundary from both sides with twelve frozen fixtures:
 *
 *   - seven artefact-led fixtures (editorial, landing, mobile, dataviz,
 *     diagram, identity, design-system) whose expected composition traits are
 *     presence assertions: an editorial page plans a reading rhythm
 *     (masthead/column/furniture, never a nav rail), a landing page a
 *     narrative with one conversion action, a narrow viewport one column at
 *     390x844, a chart real scales, a diagram its connections, identity work
 *     editable geometry, a design system its specimens;
 *   - two decision-led general fixtures (NO artefact and NO product): the
 *     deploy flow keeps its shell with neutral placement wording — no shard
 *     vocabulary, no product states, no inferred EXO archetype, and the tool
 *     layer (`buildPlan`) reports an empty product identity; the dense ops
 *     console's monitor decision keeps its six live signals carried by one
 *     instrument (a status rail and one primary signal surface, never a
 *     metric card wall or an admin nav), and the intervention the decision
 *     names is stated as first-class brief data (primaryAction), so the
 *     commit step earns an action region of its own;
 *   - one content-led general fixture (the `product-ui` artefact): a
 *     content-heavy review screen keeps every stated information item as
 *     required information, and the caller's declared states survive the
 *     merge into the plan's interaction states;
 *   - the EXO-led control (the single fixture naming a product) proving the
 *     product power still exists INSIDE its profile: model-fit inference,
 *     product runtime states, the profile's placement truth;
 *   - the guard-isolation lane: the SAME card-wall program guarded under a
 *     project with no profile and no stored rules resolves INDETERMINATE
 *     (never a PASS borrowed from another product), while the identical
 *     program under the EXO profile still fails what EXO vetoes.
 *
 * Honesty rules, strictly above convenience (the whole point of this suite is
 * to prevent a misleading PASS):
 *   - every expected trait is an explicit equality/list/regex assertion —
 *     there is no score, no threshold and no "pass N of M" escape hatch;
 *   - an unmet or uncheckable trait FAILS its fixture — a trait the evidence
 *     cannot resolve is a failure with the reason stated, never a skip;
 *   - a planner/guard throw for a fixture is recorded as that fixture's FAIL
 *     evidence, with the message in the trait detail;
 *   - any fixture FAIL or NOT EVALUATED makes the overall benchmark FAIL —
 *     and when a tool could not run at all, the benchmark may not claim PASS.
 *
 * Dependencies are injected, never imported. This module is pure data plus
 * one evaluator, so it compiles standalone and cannot reach the dist-test
 * bundles from its own source location. The runner
 * (scripts/run-cross-domain-benchmark.mjs) imports the bundles itself and
 * passes exactly these three functions in:
 *
 *   runCrossDomainBenchmark({
 *     planScreen:      (await import("…/dist-test/plan/planner.js")).planScreen,
 *     buildPlan:       (await import("…/dist-test/plan/tools.js")).buildPlan,
 *     designGuardTool: (await import("…/dist-test/memory/tools.js")).designGuardTool,
 *   });
 *
 * A missing dep throws with the module path to import it from — this module
 * deliberately has no fallback import, because a bundle that silently planned
 * "against itself" is precisely the drift it measures.
 *
 * Memory note: memory/store.ts binds DESIGN_AGENT_MEMORY_DIR at module load,
 * so the runner must set it (a fresh temp dir) BEFORE importing any dist-test
 * bundle, and the guard lane's project keys must not name a product —
 * key-seeded profile seeding would corrupt the no-profile lane.
 *
 * Versioned like the other benchmark arrays: these fixtures are frozen design
 * intent, and both ids and counts must move deliberately with tests.
 */

export const CROSS_DOMAIN_VERSION = 2;

/* -------------------------------------------------------------------------- */
/* Fixture/plan data types (structural — no runtime dependency on the planner) */
/* -------------------------------------------------------------------------- */

export type CrossDomainProduct = "general" | "exo";

/** What one fixture turns: planScreen/buildPlan for the planner lane, designGuardTool for the guard lane. */
export type CrossDomainLane = "planner" | "guard";

/**
 * The plain-data planner intent the benchmark passes to planScreen (and to
 * buildPlan, on the lane that checks the tool boundary). This is the
 * documented subset of the planner's ScreenIntent the fixtures need; the
 * module defines it structurally so it compiles standalone and cannot
 * accidentally bind to planner runtime behaviour.
 */
export interface CrossDomainPlannerIntent {
  primaryDecision: string;
  /** Stated as first-class brief data: the one action the screen exists to commit. */
  primaryAction?: string;
  availableInformation?: string[];
  artefact?: string;
  goal?: string;
  visualDirection?: string;
  existingPatterns?: string[];
  states?: string[];
}

/** The card-wall program the guard lane runs under both profile lanes. */
export interface CrossDomainGuardProgram {
  canvas?: Record<string, unknown>;
  regions?: Array<Record<string, unknown>>;
  content?: Array<Record<string, unknown>>;
}

/**
 * The guard lane's argument: a project key with no profile and no stored
 * rules, plus the program to guard. When `profiledLane` is present, the
 * evaluator re-runs the SAME program under the named profile so the two
 * verdicts can be compared — the isolation proof.
 */
export interface CrossDomainGuardIntent {
  project: string;
  program: CrossDomainGuardProgram;
  profiledLane?: { project: string; profile: "exo" };
}

export type CrossDomainFixtureIntent = CrossDomainPlannerIntent | CrossDomainGuardIntent;

/** The plan a planner lane produced (structural subset of ScreenPlan). */
export interface CrossDomainPlannerPlan {
  intent: {
    primaryDecision?: string;
    decisionKind?: string;
    canvas?: { width?: number; height?: number; grid?: number };
    product?: string;
    artefact?: string;
  };
  template?: { name?: string; kinds?: string[]; why?: string };
  /** The plan's own required-information list, echoed from the brief's stated items. */
  requiredInformation?: string[];
  artefact?: { type?: string; why?: string };
  profile?: { product?: string | null; ruleCount?: number };
  archetype?: { name?: string } | null;
  regions?: Array<{ id: string; role: string; composition?: string; because?: string }>;
  guardPreview?: Array<{ rule?: string; therefore?: string }>;
  artDirection?: { interactionStates?: string[] };
}

/** The tool response the tool lane produced (structural subset of buildPlan). */
export interface CrossDomainToolPlan {
  status?: string;
  intelligence?: { decisionKind?: string };
  decision?: { primaryDecision?: string; kind?: string };
  template?: { name?: string };
  artefact?: { type?: string } | null;
  archetype?: { name?: string } | null;
  regions?: Array<{ id: string; role: string; why?: string }>;
  guardPreview?: Array<{ rule?: string; therefore?: string }>;
  designContext?: { product?: string | null; brief?: string };
  artDirection?: { interactionStates?: string[] };
}

/** One guard leg's response (structural subset of designGuardTool). */
export interface CrossDomainGuardResponse {
  status?: string;
  project?: string;
  verdict?: string;
  findings?: Array<{ verdict?: string; rule?: string; message?: string; evidence?: unknown; nextStep?: string }>;
  stats?: { rulesChecked?: number; passed?: number; warnings?: number; failures?: number; manual?: number };
  rulesSource?: { product?: string | null; builtIn?: number; stored?: number };
  activeProfile?: { product?: string | null; source?: string; rulesChecked?: number };
}

/** The injected implementations. Required from the caller — see the module header. */
export interface CrossDomainDeps {
  /** `planScreen` from mcp-server/dist-test/plan/planner.js (the planner lane). */
  planScreen: (intent: CrossDomainPlannerIntent & { product?: string }) => CrossDomainPlannerPlan;
  /** `buildPlan` from mcp-server/dist-test/plan/tools.js (the tool lane, fixture `general-deploy-flow`). */
  buildPlan: (args: CrossDomainPlannerIntent, opts?: { profile?: string } & Record<string, unknown>) => CrossDomainToolPlan;
  /** `designGuardTool` from mcp-server/dist-test/memory/tools.js (the guard lane). */
  designGuardTool: (session: null, args: Record<string, unknown>) => Promise<CrossDomainGuardResponse>;
}

/* -------------------------------------------------------------------------- */
/* Expected traits — every expectation is explicit and material                */
/* -------------------------------------------------------------------------- */

/**
 * A fixture's expected traits. Whatever is declared, the evaluator checks;
 * whatever is NOT declared is not asserted (a fixture only speaks for the
 * traits it names). Every declared trait is material: one miss fails the
 * fixture. There are deliberately no soft traits, so the WARNING status
 * never fires in this suite — softness is how a silent drift turns into a
 * green report, and this suite exists to refuse that.
 */
export interface CrossDomainExpectations {
  /** plan.artefact.type echoes the named artefact, exactly. */
  artefactType?: string;
  /** plan.template.name, exactly (an artefact-led plan's template is the artefact's). */
  template?: string;
  /** Every listed brief item appears in the plan's requiredInformation — stated data survives into the plan. */
  requiredInformation?: string[];
  /** Every listed region id is present among plan.regions. */
  requiredRegions?: string[];
  /** None of the listed region ids is present — e.g. no nav rail on an editorial page, no sidebar on a phone. */
  forbiddenRegions?: string[];
  /** A named region must carry exactly this composition. */
  regionCompositions?: Record<string, string>;
  /** plan.intent.canvas resolves to this size (the artefact's canvas when the caller named none). */
  canvas?: { width: number; height: number };
  /** plan.intent.decisionKind (the classifier's verdict over the decision text). */
  decisionKind?: string;
  /** The resolved profile identity — always asserted: "general" ⇒ product null (and no rules active), "exo" ⇒ "exo". */
  profileProduct: CrossDomainProduct;
  /** An archetype with exactly this name was inferred (only possible under a profile that declares inference). */
  archetype?: string;
  /** No archetype at all — inference is profile-scoped, so a general plan infers none. */
  archetypeAbsence?: true;
  /** No guard-preview rule id may start with any of these prefixes (the IS-issue-27 veto leak). */
  ruleIdPrefixesForbidden?: string[];
  /** The deploy shell's placement region's reason: product-neutral under no profile, the profile's truth under its profile. */
  placementBecause?: { requirePattern?: string; forbidPattern?: string };
  /** The plan's interaction states: what must appear, what may never appear. */
  interactionStates?: { required?: string[]; forbidden?: string[] };
  /** Tool-boundary traits, checked against the injected buildPlan (fixture `general-deploy-flow`). */
  tool?: {
    decisionKind?: string;
    /** designContext.product is exactly this ("" for a general project — no product identity). */
    designContextProduct?: string;
    /** Regex patterns (case-insensitive) the design context's brief must not match. */
    briefForbidsPatterns?: string[];
    /** Guard-preview rule id prefixes that must not fire at the tool layer. */
    guardPreviewPrefixesForbidden?: string[];
    /** States that must not multiply into the tool response's interaction states. */
    interactionStatesForbidden?: string[];
  };
  /** Guard-lane traits (fixture `guard-isolation-lane`): the same program, two profile lanes. */
  guard?: {
    baseline: {
      status: string;
      verdict: string;
      /** A finding whose rule is exactly this must exist (the guard names WHY nothing ran). */
      profileFindingRule: string;
      rulesChecked: number;
      /** No finding's rule id may start with these prefixes. */
      rulePrefixesForbidden: string[];
    };
    profiled: {
      verdict: string;
      failingRule: string;
      failingRuleVerdict: string;
      rulesSourceProduct: string;
      activeProfileSource: string;
    };
  };
}

/* -------------------------------------------------------------------------- */
/* The fixtures                                                                */
/* -------------------------------------------------------------------------- */

export interface CrossDomainFixture {
  /** Stable id. These are frozen design intent; renaming means moving the runner/tests with it. */
  id: string;
  /** Short domain label for the compact runner table. */
  domain: string;
  description: string;
  /** Which dep the fixture primarily turns. The guard fixture drives the injected designGuardTool. */
  lane: CrossDomainLane;
  /** Plain data: the planScreen argument (planner lane) or the designGuardTool argument (guard lane). */
  intent: CrossDomainFixtureIntent;
  /**
   * The product profile this fixture plans under, when one is active. Only
   * the EXO control names one ("exo") — the other eleven prove the
   * product-free default actually applies.
   */
  product?: "exo";
  expect: CrossDomainExpectations;
}

/** The EXO product-rule prefixes the guard lane knows to forbid on a general project. */
export const EXO_RULE_ID_PREFIX = "exo.";

/**
 * The EXO runtime states a general project's deploy plan must never carry
 * (issue #27: lifecycle vocabulary travels with the profile, not with the
 * engine). `inference running`/`device connecting` belong to topology/monitor
 * kinds; they are listed anyway as defence in depth.
 */
export const EXO_RUNTIME_STATE_WORDS = [
  "model downloading",
  "model preparing",
  "model fitting",
  "model loading",
  "device connecting",
  "device unavailable",
  "cluster degraded",
  "inference running",
] as const;

/**
 * The card-wall program the guard isolation lane guards under both lanes —
 * the same program a recorded EXO profile always failed, so the fixture
 * echoes what the EXO veto has always vetoed (three repeated metric cards).
 */
export const GUARD_CARD_WALL_PROGRAM: CrossDomainGuardProgram = {
  canvas: { name: "Card wall", width: 1440, height: 900, grid: 8 },
  regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
  content: [
    { fn: "metric", id: "m1", parent: "main", args: { label: "GPUs", value: "8" } },
    { fn: "metric", id: "m2", parent: "main", args: { label: "Memory", value: "1.8 TB" } },
    { fn: "metric", id: "m3", parent: "main", args: { label: "Throughput", value: "42" } },
  ],
};

/**
 * Project keys for the guard lane. Neither may contain "exo" — the store
 * seeds a profile for a key that names a product, and the no-profile lane
 * must resolve NO profile from its key, memory or rules.
 */
export const GUARD_BASELINE_PROJECT = "cross-domain-import-baseline";
export const GUARD_PROFILED_PROJECT = "cross-domain-profiled-lane";

/**
 * The twelve cross-domain fixtures. Ids are stable; the runner's table and any
 * pinned count must agree with this array.
 */
export const CROSS_DOMAIN_FIXTURES: ReadonlyArray<CrossDomainFixture> = [
  {
    id: "editorial-deep-dive",
    domain: "editorial",
    description:
      "A long-form deep-dive article plans an editorial reading rhythm — not an admin shell with a nav rail.",
    lane: "planner",
    intent: {
      primaryDecision: "how the long-form deep-dive should read",
      availableInformation: ["the drafted piece", "pull-quotes and captions", "publication standfirst"],
      artefact: "editorial",
    },
    expect: {
      artefactType: "editorial",
      template: "editorial-rhythm",
      requiredRegions: ["masthead", "column", "furniture"],
      forbiddenRegions: ["nav"],
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
    },
  },
  {
    id: "landing-conversion",
    domain: "landing",
    description:
      "A marketing page plans a narrative with one conversion action — hero and cta, not an application shell.",
    lane: "planner",
    intent: {
      primaryDecision: "what the offer promises and asks of the visitor",
      availableInformation: ["the headline promise", "customer proof", "feature narrative"],
      artefact: "landing",
    },
    expect: {
      artefactType: "landing",
      template: "landing-narrative",
      requiredRegions: ["hero", "cta"],
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
    },
  },
  {
    id: "mobile-onboarding",
    domain: "mobile",
    description:
      "A narrow-viewport flow plans one column at 390x844 — never a two-pane shell.",
    lane: "planner",
    intent: {
      primaryDecision: "how a new user completes setup on a phone",
      availableInformation: ["the account details to collect", "the device permission steps"],
      artefact: "mobile",
    },
    expect: {
      artefactType: "mobile",
      template: "mobile-flow",
      canvas: { width: 390, height: 844 },
      requiredRegions: ["header", "steps", "submit"],
      forbiddenRegions: ["sidebar"],
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
    },
  },
  {
    id: "dataviz-trend",
    domain: "dataviz",
    description:
      "A visualisation plans real scales — the chart and its legend, not a metric card row.",
    lane: "planner",
    intent: {
      primaryDecision: "which reading the annual revenue trend supports",
      availableInformation: ["the monthly revenue series", "the year-over-year change", "data caveats and units"],
      artefact: "dataviz",
    },
    expect: {
      artefactType: "dataviz",
      template: "data-axes",
      requiredRegions: ["chart", "legend"],
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
    },
  },
  {
    id: "system-diagram",
    domain: "diagram",
    description:
      "An architecture decision plans its relationships — a topology map with nodes and edges plus a legend.",
    lane: "planner",
    intent: {
      primaryDecision: "how the ingestion services connect",
      availableInformation: ["the service inventory", "the data flows between services", "the failure paths"],
      artefact: "diagram",
    },
    expect: {
      artefactType: "diagram",
      template: "relationship-map",
      requiredRegions: ["map", "legend"],
      regionCompositions: { map: "topology" },
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
    },
  },
  {
    id: "identity-marks",
    domain: "identity",
    description:
      "A brand exploration plans editable mark geometry — a canvas of marks beside the palette, not a grid of screenshots.",
    lane: "planner",
    intent: {
      primaryDecision: "which mark best represents the studio",
      availableInformation: ["the mark explorations", "the brand palette", "the type ramp"],
      artefact: "identity",
    },
    expect: {
      artefactType: "identity",
      template: "identity-exploration",
      requiredRegions: ["marks", "palette"],
      regionCompositions: { marks: "canvas" },
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
    },
  },
  {
    id: "design-system-specimens",
    domain: "design-system",
    description:
      "A vocabulary decision plans specimens of the system — tokens and component instances, not product chrome.",
    lane: "planner",
    intent: {
      primaryDecision: "how the component vocabulary is specified",
      availableInformation: ["the design tokens", "the component inventory", "the type ramp"],
      artefact: "design-system",
    },
    expect: {
      artefactType: "design-system",
      template: "system-specimens",
      requiredRegions: ["tokens", "specimens"],
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
    },
  },
  {
    id: "dense-ops-console",
    domain: "ops",
    description:
      "A dense ops console with no artefact and no profile keeps its monitor decision as one instrument: a status rail and one primary signal surface carry the six live signals, never a metric card wall or an admin nav — and because the brief states the intervention as first-class data (primaryAction), the commit step earns an action region of its own rather than being left to leftover chrome.",
    lane: "planner",
    intent: {
      primaryDecision: "watch the fleet and intervene when something degrades",
      availableInformation: ["node pressure", "queue depth", "throughput", "latency p99", "error rate", "shard health"],
      primaryAction: "take over the degraded node",
    },
    expect: {
      decisionKind: "monitor",
      requiredRegions: ["rail", "primary-visual", "detail", "action"],
      forbiddenRegions: ["nav"],
      regionCompositions: { rail: "instrument", "primary-visual": "instrument" },
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
    },
  },
  {
    id: "content-heavy-missing-states",
    domain: "content",
    description:
      "A content-heavy review screen plans under the general profile with the current template an unnamed queue resolves to — and keeps the caller's stated information as required information plus the caller's declared states (empty, error, loading, disabled) alive through the interaction-state merge.",
    lane: "planner",
    intent: {
      primaryDecision: "review the submissions queue",
      availableInformation: ["submission title", "submitter", "submitted at", "review state", "attachment name"],
      artefact: "product-ui",
      states: ["empty", "error", "loading", "disabled"],
    },
    expect: {
      template: "model-analysis",
      requiredInformation: ["submission title", "submitter", "submitted at", "review state", "attachment name"],
      interactionStates: { required: ["empty", "error", "loading", "disabled"] },
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
    },
  },
  {
    id: "general-deploy-flow",
    domain: "deploy (general)",
    description:
      "A deployment decision with no product profile keeps the deploy shell and says placement neutrally — no shard vocabulary, no product states, no inferred EXO archetype, and the tool layer echoes an empty product identity.",
    lane: "planner",
    intent: {
      primaryDecision: "roll out the pricing update",
      availableInformation: ["affected plans", "change review"],
    },
    expect: {
      decisionKind: "deploy",
      requiredRegions: ["candidates", "placement"],
      placementBecause: {
        requirePattern: "required vs available|what is required",
        forbidPattern: "shards?",
      },
      profileProduct: "general",
      archetypeAbsence: true,
      ruleIdPrefixesForbidden: [EXO_RULE_ID_PREFIX],
      interactionStates: { forbidden: [...EXO_RUNTIME_STATE_WORDS] },
      tool: {
        decisionKind: "deploy",
        designContextProduct: "",
        briefForbidsPatterns: ["EXO", "exo\\."],
        guardPreviewPrefixesForbidden: [EXO_RULE_ID_PREFIX],
        interactionStatesForbidden: [...EXO_RUNTIME_STATE_WORDS],
      },
    },
  },
  {
    id: "exo-deploy-under-profile",
    domain: "deploy (exo)",
    description:
      "Under its own profile, the product's power still exists: model-fit inference, product runtime states, and the profile's placement truth — proving the isolation above is about the boundary, not about extinguishing the product.",
    lane: "planner",
    product: "exo",
    intent: {
      primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
      availableInformation: ["candidate models", "cluster memory"],
    },
    expect: {
      profileProduct: "exo",
      archetype: "model-fit",
      placementBecause: {
        requirePattern: "automatic placement|placement is recommended automatically|dragging shards by hand",
      },
      interactionStates: { required: ["model fitting", "cluster degraded"] },
    },
  },
  {
    id: "guard-isolation-lane",
    domain: "guard",
    description:
      "The EXO truth set is not a global default: the same card-wall program guarded with no profile resolves INDETERMINATE (nothing product-specific ran, and the guard says so), while the identical program under the EXO profile still fails the veto EXO has always carried.",
    lane: "guard",
    intent: {
      project: GUARD_BASELINE_PROJECT,
      program: GUARD_CARD_WALL_PROGRAM,
      profiledLane: { project: GUARD_PROFILED_PROJECT, profile: "exo" },
    },
    expect: {
      profileProduct: "general",
      guard: {
        baseline: {
          status: "indeterminate",
          verdict: "INDETERMINATE",
          profileFindingRule: "profile",
          rulesChecked: 0,
          rulePrefixesForbidden: [EXO_RULE_ID_PREFIX],
        },
        profiled: {
          verdict: "FAIL",
          failingRule: "exo.no-generic-saas",
          failingRuleVerdict: "FAIL",
          rulesSourceProduct: "exo",
          activeProfileSource: "explicit",
        },
      },
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Results and report                                                          */
/* -------------------------------------------------------------------------- */

export type CrossDomainStatus = "PASS" | "FAIL" | "WARNING" | "INDETERMINATE" | "NOT EVALUATED";

/** One checked expectation, with the evidence a reviewer needs without re-running. */
export interface CrossDomainTrait {
  /** Stable, reviewer-readable assertion name. */
  trait: string;
  ok: boolean;
  /** What was expected and what was observed. Always present on a miss. */
  detail?: string;
}

export interface CrossDomainFixtureResult {
  id: string;
  domain: string;
  status: CrossDomainStatus;
  traits: CrossDomainTrait[];
  /** One honest sentence: what the fixture turned and whether every declared trait held. */
  summary: string;
}

export interface CrossDomainReport {
  tool: "cross-domain-benchmark";
  version: typeof CROSS_DOMAIN_VERSION;
  generatedAt: string;
  fixturesRun: number;
  counts: {
    pass: number;
    fail: number;
    /** Reserved for soft traits — this suite declares none, so a run reports 0. */
    warning: number;
    /** Reserved for fixtures whose evidence could not be assigned to a lane — 0 on a valid run. */
    indeterminate: number;
    notEvaluated: number;
  };
  verdict: "PASS" | "FAIL";
  summary: string;
  results: CrossDomainFixtureResult[];
}

/* -------------------------------------------------------------------------- */
/* The evaluator                                                               */
/* -------------------------------------------------------------------------- */

const trait = (name: string, ok: boolean, detail?: string): CrossDomainTrait => ({
  trait: name,
  ok,
  ...(detail !== undefined ? { detail } : {}),
});

function observed(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "string") return `'${value}'`;
  return JSON.stringify(value);
}

/** Builds a fixture result from its traits; the summary names the first failure when one exists. */
function fixtureResult(
  fixture: CrossDomainFixture,
  traits: CrossDomainTrait[],
  statusOverride?: CrossDomainStatus,
): CrossDomainFixtureResult {
  const failures = traits.filter((t) => !t.ok);
  const status: CrossDomainStatus = statusOverride ?? (failures.length === 0 ? "PASS" : "FAIL");
  const held = traits.length - failures.length;
  const summary =
    failures.length === 0
      ? `${held}/${traits.length} traits held.`
      : `${held}/${traits.length} traits held — failed: ${failures.map((f) => f.trait).join(", ")}.`;
  return { id: fixture.id, domain: fixture.domain, status, traits, summary };
}

/** Whether a plan field is genuinely absent (undefined only — null observed facts are real evidence). */
function isAbsent(value: unknown): boolean {
  return value === undefined;
}

/** Evaluates the planner lane (fixtures 1–9). */
function evaluatePlannerFixture(fixture: CrossDomainFixture, deps: CrossDomainDeps): CrossDomainFixtureResult {
  const expect = fixture.expect;
  const traits: CrossDomainTrait[] = [];

  let plan: CrossDomainPlannerPlan;
  try {
    plan = deps.planScreen({
      ...(fixture.intent as CrossDomainPlannerIntent),
      ...(fixture.product !== undefined ? { product: fixture.product } : {}),
    });
  } catch (error) {
    traits.push(trait("planner-run", false, `planScreen threw for this fixture: ${(error as Error)?.message ?? String(error)} — a plan that cannot be produced is itself the defect.`));
    return fixtureResult(fixture, traits);
  }

  /* --- profile identity (always material) ---------------------------------- */
  if (expect.profileProduct === "general") {
    const product = plan.profile?.product;
    const ruleCount = plan.profile?.ruleCount;
    traits.push(
      trait(
        "profile-is-general",
        isAbsent(plan.profile) === false && product === null && ruleCount === 0,
        `expected profile.product null with 0 product rules active, observed ${observed(plan.profile)} — ` +
          "a general fixture must plan under no product profile at all.",
      ),
    );
  } else {
    const product = plan.profile?.product;
    traits.push(
      trait(
        "profile-is-exo",
        product === "exo",
        `expected profile.product 'exo', observed ${observed(product)} — the EXO control only works while its profile is active.`,
      ),
    );
  }

  /* --- artefact echo -------------------------------------------------------- */
  if (expect.artefactType !== undefined) {
    const type = plan.artefact?.type;
    traits.push(
      trait(
        `artefact-echo/${expect.artefactType}`,
        type === expect.artefactType,
        `expected plan.artefact.type === '${expect.artefactType}', observed ${observed(type)} — the artefact must be first-class input, not dropped on the way in.`,
      ),
    );
  }

  /* --- template -------------------------------------------------------------- */
  if (expect.template !== undefined) {
    const template = plan.template?.name;
    traits.push(
      trait(
        `template/${expect.template}`,
        template === expect.template,
        `expected plan.template.name === '${expect.template}', observed ${observed(template)}.`,
      ),
    );
  }

  /* --- required information --------------------------------------------------- */
  if (expect.requiredInformation !== undefined) {
    const carried = plan.requiredInformation ?? [];
    const missing = expect.requiredInformation.filter((item) => !carried.includes(item));
    traits.push(
      trait(
        "required-information/all-stated-items",
        missing.length === 0,
        missing.length === 0
          ? `plan.requiredInformation carries every stated item (${carried.length} items)`
          : `stated information item(s) ${missing.join(", ")} missing from plan.requiredInformation; observed: [${carried.join(", ") || "none"}]`,
      ),
    );
  }

  /* --- regions ---------------------------------------------------------------- */
  const regionIds = (plan.regions ?? []).map((r) => r.id);
  if (expect.requiredRegions !== undefined) {
    const missing = expect.requiredRegions.filter((id) => !regionIds.includes(id));
    traits.push(
      trait(
        `regions-include/${expect.requiredRegions.join("+")}`,
        missing.length === 0,
        missing.length === 0
          ? `all required regions present; observed: [${regionIds.join(", ") || "none"}]`
          : `missing region(s) ${missing.join(", ")}; observed regions: [${regionIds.join(", ") || "none"}]`,
      ),
    );
  }
  if (expect.forbiddenRegions !== undefined) {
    const present = expect.forbiddenRegions.filter((id) => regionIds.includes(id));
    traits.push(
      trait(
        `regions-exclude/${expect.forbiddenRegions.join("+")}`,
        present.length === 0,
        present.length === 0
          ? `none of ${expect.forbiddenRegions.join(", ")} present; observed: [${regionIds.join(", ") || "none"}]`
          : `forbidden region(s) ${present.join(", ")} present; observed: [${regionIds.join(", ") || "none"}]`,
      ),
    );
  }
  if (expect.regionCompositions !== undefined) {
    const byId = new Map((plan.regions ?? []).map((r) => [r.id, r]));
    for (const [id, wanted] of Object.entries(expect.regionCompositions)) {
      const got = byId.get(id)?.composition;
      traits.push(
        trait(
          `region-composition/${id}=${wanted}`,
          got === wanted,
          `expected region '${id}' composition '${wanted}', observed ${observed(got)}.`,
        ),
      );
    }
  }

  /* --- canvas ------------------------------------------------------------------ */
  if (expect.canvas !== undefined) {
    const canvas = plan.intent?.canvas;
    const ok = canvas?.width === expect.canvas.width && canvas?.height === expect.canvas.height;
    traits.push(
      trait(
        `canvas/${expect.canvas.width}x${expect.canvas.height}`,
        ok,
        `expected plan.intent.canvas ${expect.canvas.width}x${expect.canvas.height}, observed ${observed(canvas && { width: canvas.width, height: canvas.height })}.`,
      ),
    );
  }

  /* --- decision kind ------------------------------------------------------------ */
  if (expect.decisionKind !== undefined) {
    const kind = plan.intent?.decisionKind;
    traits.push(
      trait(
        `decision-kind/${expect.decisionKind}`,
        kind === expect.decisionKind,
        `expected plan.intent.decisionKind === '${expect.decisionKind}', observed ${observed(kind)}.`,
      ),
    );
  }

  /* --- archetype ----------------------------------------------------------------- */
  if (expect.archetypeAbsence === true) {
    const archetype = plan.archetype;
    traits.push(
      trait(
        "archetype-absent",
        archetype === undefined || archetype === null,
        archetype === undefined || archetype === null
          ? "no archetype present, as expected — inference declares itself profile-scoped"
          : `expected no archetype, observed ${observed(archetype?.name)} — archetype inference leaked past the profile boundary.`,
      ),
    );
  }
  if (expect.archetype !== undefined) {
    const name = plan.archetype?.name;
    traits.push(
      trait(
        `archetype/${expect.archetype}`,
        name === expect.archetype,
        `expected inferred archetype '${expect.archetype}', observed ${observed(name)}.`,
      ),
    );
  }

  /* --- guard preview leak ---------------------------------------------------------- */
  if (expect.ruleIdPrefixesForbidden !== undefined) {
    const rules = (plan.guardPreview ?? []).map((g) => g.rule ?? "");
    const leaked = rules.filter((rule) => expect.ruleIdPrefixesForbidden!.some((prefix) => rule.startsWith(prefix)));
    traits.push(
      trait(
        `guard-preview-excludes/${expect.ruleIdPrefixesForbidden.join("|")}`,
        leaked.length === 0,
        leaked.length === 0
          ? "no preview carries a product rule id; rule ids observed: none"
          : `preview rule id(s) ${leaked.join(", ")} fired — another product's veto reached a project that did not name it.`,
      ),
    );
  }

  /* --- placement vocabulary ---------------------------------------------------------- */
  if (expect.placementBecause !== undefined) {
    const placement = (plan.regions ?? []).find((r) => r.id === "placement");
    if (placement === undefined) {
      traits.push(
        trait(
          "placement-region-present",
          false,
          "expected a 'placement' region in the deploy shell — the shell must survive without a product profile.",
        ),
      );
    } else {
      const because = placement.because ?? "";
      const forbid = expect.placementBecause.forbidPattern;
      const requirePattern = expect.placementBecause.requirePattern;
      const forbiddenHit = forbid !== undefined && new RegExp(forbid, "i").test(because);
      const requiredHit = requirePattern === undefined || new RegExp(requirePattern, "i").test(because);
      traits.push(
        trait(
          `placement-vocabulary/${expect.profileProduct}`,
          !forbiddenHit && requiredHit,
          forbid !== undefined && forbiddenHit
            ? `placement 'because' matched the forbidden pattern /${forbid}/i — observed: "${because.slice(0, 160)}"`
            : !requiredHit
              ? `placement 'because' missed the required pattern /${requirePattern}/i — observed: "${because.slice(0, 160)}"`
              : `placement 'because' is ${expect.profileProduct}-worded; observed: "${because.slice(0, 160)}"`,
        ),
      );
    }
  }

  /* --- interaction states --------------------------------------------------------------- */
  if (expect.interactionStates !== undefined) {
    const states = plan.artDirection?.interactionStates ?? [];
    const required = expect.interactionStates.required ?? [];
    const forbidden = expect.interactionStates.forbidden ?? [];
    const missingRequired = required.filter((s) => !states.includes(s));
    const presentForbidden = forbidden.filter((s) => states.includes(s));
    traits.push(
      trait(
        "interaction-states",
        missingRequired.length === 0 && presentForbidden.length === 0,
        missingRequired.length > 0
          ? `required state(s) ${missingRequired.join(", ")} missing from interactionStates`
          : presentForbidden.length > 0
            ? `product state(s) ${presentForbidden.join(", ")} multiplied into a project that does not declare them; observed: [${states.join(", ")}]`
            : `interactionStates hold (${states.length} states)`,
      ),
    );
  }

  return fixtureResult(fixture, traits);
}

/** Evaluates the tool lane traits of a fixture against the injected buildPlan. */
function evaluateToolLane(fixture: CrossDomainFixture, deps: CrossDomainDeps): CrossDomainTrait[] {
  const toolExpect = fixture.expect.tool;
  const traits: CrossDomainTrait[] = [];
  if (toolExpect === undefined) return traits;

  let out: CrossDomainToolPlan;
  try {
    out = deps.buildPlan(fixture.intent as CrossDomainPlannerIntent);
  } catch (error) {
    traits.push(
      trait("tool-run", false, `buildPlan threw for this fixture: ${(error as Error)?.message ?? String(error)}`),
    );
    return traits;
  }

  if (toolExpect.decisionKind !== undefined) {
    const kind = out.decision?.kind ?? out.intelligence?.decisionKind;
    traits.push(
      trait(
        `tool-decision-kind/${toolExpect.decisionKind}`,
        kind === toolExpect.decisionKind,
        `expected buildPlan decision.kind === '${toolExpect.decisionKind}', observed ${observed(kind)}.`,
      ),
    );
  }
  if (toolExpect.designContextProduct !== undefined) {
    const product = out.designContext?.product;
    traits.push(
      trait(
        `tool-design-context/${toolExpect.designContextProduct === "" ? "no-product" : toolExpect.designContextProduct}`,
        product === toolExpect.designContextProduct,
        `expected designContext.product === ${observed(toolExpect.designContextProduct)}, observed ${observed(product)} — the tool layer is the boundary issue #27 closed.`,
      ),
    );
  }
  if (toolExpect.briefForbidsPatterns !== undefined) {
    const brief = out.designContext?.brief ?? "";
    const hits = toolExpect.briefForbidsPatterns.filter((p) => new RegExp(p, "i").test(brief));
    traits.push(
      trait(
        "tool-brief-free-of-other-products",
        hits.length === 0,
        hits.length === 0
          ? "the design context brief carries no other product's identity"
          : `brief matched forbidden pattern(s) ${hits.join(", ")} — observed: "${brief.slice(0, 160)}"`,
      ),
    );
  }
  if (toolExpect.guardPreviewPrefixesForbidden !== undefined) {
    const rules = (out.guardPreview ?? []).map((g) => g.rule ?? "");
    const leaked = rules.filter((rule) => toolExpect.guardPreviewPrefixesForbidden!.some((prefix) => rule.startsWith(prefix)));
    traits.push(
      trait(
        `tool-guard-preview-excludes/${toolExpect.guardPreviewPrefixesForbidden.join("|")}`,
        leaked.length === 0,
        leaked.length === 0
          ? "no tool-layer guard preview carries a product rule id"
          : `preview rule id(s) ${leaked.join(", ")} fired at the tool layer.`,
      ),
    );
  }
  if (toolExpect.interactionStatesForbidden !== undefined) {
    const states = out.artDirection?.interactionStates ?? [];
    const present = toolExpect.interactionStatesForbidden.filter((s) => states.includes(s));
    traits.push(
      trait(
        "tool-interaction-states-free-of/product",
        present.length === 0,
        present.length === 0
          ? `tool response interactionStates carry no product states (${states.length} states)`
          : `product state(s) ${present.join(", ")} present in the tool response.`,
      ),
    );
  }
  return traits;
}

/**
 * Evaluates the guard lane (fixture 10): the same program under two profile
 * lanes. The no-profile leg must be honestly unable to approve; the EXO leg
 * must still veto what EXO has always vetoed.
 */
async function evaluateGuardFixture(fixture: CrossDomainFixture, deps: CrossDomainDeps): Promise<CrossDomainFixtureResult> {
  const traits: CrossDomainTrait[] = [];
  const guardExpect = fixture.expect.guard;
  const intent = fixture.intent as CrossDomainGuardIntent;

  if (guardExpect === undefined) {
    return fixtureResult(fixture, [trait("guard-expectation-present", false, "the guard lane fixture declares no guard expectations — nothing could be checked.")]);
  }

  let baseline: CrossDomainGuardResponse;
  try {
    baseline = await deps.designGuardTool(null, { project: intent.project, program: intent.program });
  } catch (error) {
    traits.push(
      trait("guard-baseline-run", false, `designGuardTool threw for the no-profile lane: ${(error as Error)?.message ?? String(error)}`),
    );
    return fixtureResult(fixture, traits);
  }

  const profiledLane = intent.profiledLane;
  let profiled: CrossDomainGuardResponse;
  try {
    profiled = await deps.designGuardTool(null, {
      project: profiledLane?.project,
      program: intent.program,
      profile: profiledLane?.profile,
    });
  } catch (error) {
    traits.push(
      trait("guard-profiled-run", false, `designGuardTool threw for the profiled lane: ${(error as Error)?.message ?? String(error)}`),
    );
    return fixtureResult(fixture, traits);
  }

  /* --- the no-profile leg: honestly unable to approve ------------------------ */
  const base = guardExpect.baseline;
  traits.push(
    trait(
      `guard-baseline-status/${base.status}`,
      baseline.status === base.status,
      `expected status '${base.status}', observed ${observed(baseline.status)} — nothing product-specific ran, so the run is not a success status.`,
    ),
  );
  traits.push(
    trait(
      `guard-baseline-verdict/${base.verdict}`,
      baseline.verdict === base.verdict,
      `expected verdict '${base.verdict}', observed ${observed(baseline.verdict)} — zero rules may never read as approval.`,
    ),
  );
  const baselineFindings = baseline.findings ?? [];
  const profileFinding = baselineFindings.find((f) => f.rule === base.profileFindingRule);
  traits.push(
    trait(
      `guard-baseline-finding/${base.profileFindingRule}`,
      profileFinding !== undefined,
      profileFinding !== undefined
        ? `finding '${base.profileFindingRule}' present, as expected`
        : `expected a finding with rule '${base.profileFindingRule}' naming why nothing checked; observed rules: [${baselineFindings.map((f) => f.rule ?? "").join(", ") || "none"}]`,
    ),
  );
  const rulesChecked = baseline.stats?.rulesChecked;
  traits.push(
    trait(
      `guard-baseline-rules-checked/${base.rulesChecked}`,
      rulesChecked === base.rulesChecked,
      `expected stats.rulesChecked === ${base.rulesChecked}, observed ${observed(rulesChecked)}.`,
    ),
  );
  const baselineLeak = baselineFindings.filter(
    (f) => (f.rule ?? "").startsWith(EXO_RULE_ID_PREFIX),
  );
  traits.push(
    trait(
      "guard-baseline-no-product-findings",
      baselineLeak.length === 0,
      baselineLeak.length === 0
        ? `no finding rule id starts with '${EXO_RULE_ID_PREFIX}' on the no-profile lane`
        : `finding(s) ${baselineLeak.map((f) => f.rule).join(", ")} fired — EXO's truth set reached a project that did not name it.`,
    ),
  );

  /* --- the EXO leg: the same program still vetoes under its profile ----------- */
  const prof = guardExpect.profiled;
  const profiledFindings = profiled.findings ?? [];
  const failing = profiledFindings.find((f) => f.rule === prof.failingRule);
  traits.push(
    trait(
      `guard-profiled-verdict/${prof.verdict}`,
      profiled.verdict === prof.verdict,
      `expected verdict '${prof.verdict}', observed ${observed(profiled.verdict)} — the veto must survive inside its profile.`,
    ),
  );
  traits.push(
    trait(
      `guard-profiled-failing-rule/${prof.failingRule}`,
      failing !== undefined && failing.verdict === prof.failingRuleVerdict,
      failing === undefined
        ? `expected a finding with rule '${prof.failingRule}'; observed rules: [${profiledFindings.map((f) => f.rule ?? "").join(", ") || "none"}]`
        : `expected verdict ${observed(prof.failingRuleVerdict)} for '${prof.failingRule}', observed ${observed(failing.verdict)}`,
    ),
  );
  traits.push(
    trait(
      `guard-profiled-rules-source/${prof.rulesSourceProduct}`,
      profiled.rulesSource?.product === prof.rulesSourceProduct,
      `expected rulesSource.product '${prof.rulesSourceProduct}', observed ${observed(profiled.rulesSource?.product)}.`,
    ),
  );
  traits.push(
    trait(
      `guard-profiled-source/${prof.activeProfileSource}`,
      profiled.activeProfile?.source === prof.activeProfileSource,
      `expected activeProfile.source '${prof.activeProfileSource}', observed ${observed(profiled.activeProfile?.source)} — the explicit profile argument, not a global default, is what activated the rules.`,
    ),
  );

  /* --- the contrast in one line: same program, only the profile changed ------- */
  traits.push(
    trait(
      "guard-isolation-contrast",
      baselineLeak.length === 0 && failing !== undefined && failing.verdict === prof.failingRuleVerdict,
      `same program on two projects: no '${EXO_RULE_ID_PREFIX}' rule fired with no profile, while '${prof.failingRule}' fired '${prof.failingRuleVerdict}' under its profile — the truth set is profile data, not an engine default.`,
    ),
  );

  return fixtureResult(fixture, traits);
}

/**
 * Runs every cross-domain fixture against the injected implementations and
 * returns the versioned report. See the module header for the deps contract:
 * the function validates its deps up front and throws naming the missing
 * pieces — it never imports bundles itself and never fakes a pass.
 */
export async function runCrossDomainBenchmark(deps: CrossDomainDeps): Promise<CrossDomainReport> {
  const missing: string[] = [];
  if (typeof deps?.planScreen !== "function") {
    missing.push("planScreen (import from mcp-server/dist-test/plan/planner.js)");
  }
  if (typeof deps?.buildPlan !== "function") {
    missing.push("buildPlan (import from mcp-server/dist-test/plan/tools.js)");
  }
  if (typeof deps?.designGuardTool !== "function") {
    missing.push("designGuardTool (import from mcp-server/dist-test/memory/tools.js)");
  }
  if (missing.length > 0) {
    throw new Error(
      `The cross-domain benchmark needs injected implementations; missing: ${missing.join("; ")}. ` +
        "This module is pure data and never imports the dist-test bundles itself — the runner must pass them in.",
    );
  }

  const results: CrossDomainFixtureResult[] = [];
  for (const fixture of CROSS_DOMAIN_FIXTURES) {
    if (fixture.lane === "guard") {
      results.push(await evaluateGuardFixture(fixture, deps));
    } else if (fixture.lane === "planner") {
      const plannerResult = evaluatePlannerFixture(fixture, deps);
      const toolTraits = evaluateToolLane(fixture, deps);
      results.push(fixtureResult(fixture, [...plannerResult.traits, ...toolTraits]));
    } else {
      // Unknown lane: nothing could be evaluated, and the report must not
      // pretend otherwise — NOT EVALUATED, which can never yield a PASS.
      results.push(
        fixtureResult(
          fixture,
          [
            trait(
              "lane-known",
              false,
              `fixture lane ${observed((fixture as { lane?: string }).lane)} is not 'planner' or 'guard' — the fixture was not evaluated.`,
            ),
          ],
          "NOT EVALUATED",
        ),
      );
    }
  }

  const counts = {
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    warning: results.filter((r) => r.status === "WARNING").length,
    indeterminate: results.filter((r) => r.status === "INDETERMINATE").length,
    notEvaluated: results.filter((r) => r.status === "NOT EVALUATED").length,
  };
  const verdict: "PASS" | "FAIL" = counts.fail === 0 && counts.notEvaluated === 0 && counts.indeterminate === 0 ? "PASS" : "FAIL";
  const summary =
    verdict === "PASS"
      ? `all ${results.length} fixtures held every declared trait — product behaviour stayed inside its profile and the domains planned their own compositions.`
      : `${counts.fail} fixture(s) failed${counts.notEvaluated > 0 ? `, ${counts.notEvaluated} not evaluated` : ""} — see the failing traits for exact expected-vs-observed evidence. The benchmark may not claim a pass it did not verify.`;

  return {
    tool: "cross-domain-benchmark",
    version: CROSS_DOMAIN_VERSION,
    generatedAt: new Date().toISOString(),
    fixturesRun: results.length,
    counts,
    verdict,
    summary,
    results,
  };
}
