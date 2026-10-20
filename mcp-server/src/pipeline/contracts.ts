/**
 * The design pipeline's own contracts (issue #16).
 *
 * ## Why these types exist
 *
 * The pipeline is the one place where a decision, a plan, a set of operations,
 * the nodes those operations created, the checks that ran against them, the
 * repairs that followed and the render that was finally looked at all have to
 * refer to *the same screen*. Before this, each of those existed in its own
 * tool with its own vocabulary, and nothing could answer "was this screen
 * verified, or only built?".
 *
 * So the contracts are deliberately narrow and explicit:
 *
 * - a **brief** says what the screen is for, what may be created, and what is
 *   assumed rather than known;
 * - a **composition plan** says where things go and why, before anything is
 *   created;
 * - a **trace** links the two to the operations, the node ids, the checks, the
 *   repairs and the render;
 * - a **report** says what was generated, what was verified, what was repaired
 *   and what is still unverified — in those words, never in the word "done".
 *
 * Nothing here talks to Figma. The pipeline is deterministic until the apply
 * step, which is what makes it testable without a live document.
 */
import { z } from "zod";
import type { Composition } from "../runtime/layout";

/* -------------------------------------------------------------------------- */
/* Stage 1 — the brief                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the user asked for, in the user's terms.
 *
 * Every field is optional except the ones the pipeline cannot invent: a screen
 * with no task is a page, and pages are what turn into dashboards. The
 * normalization step decides which of these are missing *blockers* and which are
 * merely *clarifications*.
 */
export const BriefInputSchema = z
  .object({
    /** The product this screen belongs to. */
    product: z.string().max(120).optional().describe("The product this screen belongs to."),
    /** The screen's own name, in the file's language. */
    screen: z.string().max(120).optional().describe("Screen name, in the product's own language."),
    /** The user's primary task on this screen, in their words. */
    purpose: z.string().max(400).optional().describe("What the user is trying to accomplish here."),
    /** The decision the user makes on this screen. */
    primaryDecision: z.string().max(200).optional().describe("What the user decides here, as a short noun phrase."),
    /** The one action the screen exists to make possible. */
    primaryAction: z.string().max(160).optional().describe("The single most important action on the screen."),
    /** Everything else the user can do here. */
    secondaryActions: z.array(z.string().max(160)).max(8).optional(),
    /** Information the screen cannot work without. */
    requiredInformation: z.array(z.string().max(160)).max(20).optional(),
    /** Information the screen may carry, but does not need. */
    optionalInformation: z.array(z.string().max(160)).max(20).optional(),
    /**
     * Whether the numbers on this screen are real.
     *
     * The pipeline never fabricates telemetry. When the mode is not "live",
     * generated values are placeholders and the report says so.
     */
    dataMode: z.enum(["live", "demo", "unknown"]).optional().describe("Are the values real product data, illustrative demo data, or unknown?"),
    dataNotes: z.string().max(400).optional().describe("Anything that qualifies the data: which service, which environment, which time range."),
    /** Navigation and interaction relationships the screen must express. */
    interactions: z
      .array(
        z
          .object({
            from: z.string().max(120),
            to: z.string().max(120),
            kind: z.enum(["navigate", "select", "open", "compare", "configure", "trigger"]).default("navigate"),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    /** The viewport this screen is designed for. */
    viewport: z
      .object({
        width: z.number().positive().max(20000),
        height: z.number().positive().max(20000),
      })
      .optional(),
    /** Other viewports the screen has to survive. */
    responsive: z
      .array(
        z
          .object({
            name: z.string().max(60),
            width: z.number().positive().max(20000),
            height: z.number().positive().max(20000),
            note: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    /** Rules the file's design system imposes. */
    designSystemConstraints: z.array(z.string().max(200)).max(20).optional(),
    /**
     * What was seen in a reference, and what was inferred from it.
     *
     * The two are kept apart on purpose: an observation is evidence, an
     * assumption is a guess, and a pipeline that cannot tell them apart will
     * report a guess as a requirement.
     */
    references: z
      .object({
        observations: z.array(z.string().max(300)).max(20).optional(),
        assumptions: z.array(z.string().max(300)).max(20).optional(),
      })
      .optional(),
    /** The visual manner, in words. */
    visualDirection: z.string().max(120).optional().describe("Visual manner in words, e.g. 'technical-editorial'."),
    /** Things this screen must not become. */
    antiGoals: z.array(z.string().max(200)).max(10).optional(),
    /**
     * The states a data-dependent region has to express.
     *
     * A screen that only ever shows the happy path is a screen that has not
     * been designed. Naming the states puts them in the composition, where
     * they can be reviewed, instead of leaving them to be discovered in
     * production.
     */
    states: z.array(z.string().max(40)).max(6).optional(),
    /** What may be touched. */
    scope: z
      .object({
        create: z.array(z.string().max(120)).max(20).optional(),
        edit: z.array(z.string().max(120)).max(20).optional(),
        leaveUntouched: z.array(z.string().max(120)).max(20).optional(),
      })
      .optional(),
    /**
     * Real values for named information, keyed by the information text.
     *
     * The pipeline never invents a number. Anything not named here is drawn as
     * a placeholder and marked illustrative, so a demo screen cannot be
     * mistaken for a live one.
     */
    values: z.record(z.string().max(160), z.string().max(120)).optional(),
    /** Existing patterns in the file worth reusing. */
    existingPatterns: z.array(z.string().max(120)).max(20).optional(),
    /**
     * Raw information the screen has to work with, in the caller's words.
     *
     * This is the planner's input: the regions are derived from it. The
     * required/optional split above refines it, not replaces it.
     */
    availableInformation: z.array(z.string().max(160)).max(30).optional(),
    /** Who the screen serves. */
    audience: z.enum(["developer", "operator", "engineer", "leadership", "general"]).optional(),
    /** A known screen archetype, when the product has one. */
    archetype: z.string().max(120).optional(),
    /** A composition the caller insists on. */
    desiredComposition: z
      .enum(["editorial", "instrument", "canvas", "topology", "table", "timeline", "split-view", "spatial", "diagram", "sequence", "comparison"])
      .optional(),
  })
  .strict();

export type BriefInput = z.infer<typeof BriefInputSchema>;

/** A statement the pipeline is treating as true, and where it came from. */
export interface Assumption {
  id: string;
  statement: string;
  /** `stated` came from the caller; `inferred` came from the pipeline. */
  source: "stated" | "inferred";
  /** Why the pipeline believes it. */
  why: string;
}

/** A question worth asking, ranked by whether it blocks the design. */
export interface Clarification {
  id: string;
  question: string;
  why: string;
  /** A blocking clarification stops the pipeline before it mutates anything. */
  blocking: boolean;
}

/** A contradiction or an unsatisfiable constraint. */
export interface BriefBlocker {
  id: string;
  severity: "blocking" | "warning";
  message: string;
  why: string;
  /** What to change to make the brief coherent. */
  fix: string;
}

/** The brief, normalized: what the screen is, and what is assumed about it. */
export interface NormalizedBrief {
  /** Stable id for the brief, used in the trace. */
  id: string;
  product: string | null;
  screen: string;
  purpose: string;
  primaryDecision: string;
  primaryAction: string | null;
  secondaryActions: string[];
  requiredInformation: string[];
  optionalInformation: string[];
  /** Real values, keyed by the information they belong to. */
  values: Record<string, string>;
  data: {
    mode: "live" | "demo" | "unknown";
    notes: string | null;
    /** True when the screen carries values that are not real telemetry. */
    illustrative: boolean;
  };
  interactions: NonNullable<BriefInput["interactions"]>;
  viewport: { width: number; height: number };
  responsive: NonNullable<BriefInput["responsive"]>;
  designSystemConstraints: string[];
  references: { observations: string[]; assumptions: string[] };
  visualDirection: string | null;
  antiGoals: string[];
  /** The states a data-dependent region has to express. */
  states: string[];
  scope: { create: string[]; edit: string[]; leaveUntouched: string[] };
  existingPatterns: string[];
  audience: NonNullable<BriefInput["audience"]>;
  archetype: string | null;
  desiredComposition:
    | "editorial"
    | "instrument"
    | "canvas"
    | "topology"
    | "table"
    | "timeline"
    | "split-view"
    | "spatial"
    | "diagram"
    | "sequence"
    | "comparison"
    | undefined;
}

/* -------------------------------------------------------------------------- */
/* Stage 2 — the composition plan                                               */
/* -------------------------------------------------------------------------- */

/** How a region's children are arranged. */
export type RegionLayoutMode = "flow-vertical" | "flow-horizontal" | "grid" | "free";

export interface RegionSpec {
  id: string;
  role: string;
  /** The composition this region follows. It decides how its content is arranged. */
  composition: Composition;
  /** The region's parent. `null` for a top-level region. */
  parent: string | null;
  /** Position among its siblings. */
  order: number;
  /** Resolved bounds on the canvas, in pixels. */
  bounds: { x: number; y: number; w: number; h: number };
  /** How the region's own content is arranged. */
  layoutMode: RegionLayoutMode;
  /**
   * How many columns the region's content is packed into.
   *
   * Worked out from the region's height and the number of items it holds, so
   * the content fits the region rather than running past it.
   */
  columns?: number;
  /** How the region itself is sized. */
  sizing: { width: "fill" | "hug" | number; height: "fill" | "hug" | number };
  /** How much of the leftover space this region absorbs. */
  grow: number;
  padding: { top: number; right: number; bottom: number; left: number };
  gap: number;
  align: { primary: "start" | "center" | "end" | "space-between"; counter: "start" | "center" | "end" };
  /** How the region behaves at other viewports. */
  responsive: { priority: number; minWidth?: number; behavior: string };
  /** The content this region carries, in reading order. */
  contentHierarchy: string[];
  /** How dense this region is expected to be. */
  density: "low" | "medium" | "high";
  /** Relationships to other regions, and what they mean. */
  relationships: Array<{ id: string; to: string; meaning: string; importance: "primary" | "secondary" }>;
  /** The semantic primitives this region intends to use. */
  primitives: string[];
  /** What may overflow, and what may not. */
  constraints: { overflow: "allow" | "clip" | "forbid"; minWidth?: number; maxWidth?: number };
  /** Visual priority. 1 is the most important thing on the screen. */
  priority: number;
  /** What the user can do here. */
  interaction: string | null;
  /** Why this region exists. Never generic. */
  why: string;
  /** Whether the region is backed by a native auto-layout container. */
  autoLayout: boolean;
}

/** How much of the canvas the plan actually uses. */
export interface CanvasUsage {
  canvasArea: number;
  coveredArea: number;
  /** Fraction of the canvas covered by regions. */
  coverage: number;
  /** The largest empty band, as a fraction of the canvas. */
  largestEmptyBand: number;
  /** Area share of the focal region. */
  focalShare: number;
  /** Findings about the use of the canvas. */
  notes: string[];
}

/**
 * One piece of content the plan puts in a region.
 *
 * A slot is the seam between the plan and the build: it says *what* is shown,
 * *which primitive* carries it and *why it is there* — before any node exists.
 */
export interface ContentSlot {
  id: string;
  /** The region this slot belongs to. */
  regionId: string;
  /** The semantic information role. */
  kind: "option" | "attribute" | "signal" | "relationship" | "setting" | "event" | "detail" | "action" | "heading" | "unknown";
  /** The label as the user would read it. */
  label: string;
  /** The primitive that will carry it. */
  primitive: string;
  /** The value, when the brief supplied one. Never invented. */
  value: string | null;
  /** Reading order inside the region. */
  order: number;
  /** Why this content is on the screen. */
  because: string;
  /** True when the value is illustrative rather than real. */
  illustrative: boolean;
  /** The states this slot expresses, when it is a state strip. */
  states?: string[];
}

export interface CompositionPlan {
  id: string;
  canvas: { width: number; height: number; grid: number; name: string };
  /** The composition the plan follows. Decides how content is drawn. */
  composition: Composition;
  regions: RegionSpec[];
  /** The content each region carries, in reading order. */
  content: ContentSlot[];
  /**
   * Information the brief named that the composition could not place.
   *
   * Optional information yields to the canvas; required information does not,
   * and shows up in the verification as an open finding rather than as a quiet
   * omission.
   */
  notPlaced: Array<{ label: string; why: string }>;
  /** The region the eye should land on first. */
  focal: { id: string; why: string } | null;
  /** The regions in the order the eye should meet them. */
  hierarchy: Array<{ rank: number; id: string; why: string }>;
  usage: CanvasUsage;
  /** The decisions behind the plan, in the planner's words. */
  derivation: unknown;
  artDirection: unknown;
  execution: unknown;
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Stage 6/7 — findings, checks and repairs                                    */
/* -------------------------------------------------------------------------- */

export type PipelineSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface PipelineFinding {
  id: string;
  /** The stage that produced it. */
  stage: "brief" | "plan" | "program" | "structure" | "live" | "visual";
  severity: PipelineSeverity;
  /** 0–1. Below 0.6 a finding is a question, not a defect. */
  confidence: number;
  /** The nodes this finding is about. */
  nodeIds: string[];
  /** What is wrong. */
  summary: string;
  /** Why it matters to the screen's job. */
  why: string;
  /** The measured evidence. */
  evidence: { kind: "geometry" | "plan" | "brief" | "screenshot" | "rule"; detail: string };
  /** What would fix it. */
  fix: string;
  /** Whether the pipeline may apply the fix without asking. */
  automatable: boolean;
  /**
   * A targeted operation that would fix it.
   *
   * Present only when the fix is a concrete change to a named node. A repair
   * without one is not applied — it is reported for a human.
   */
  suggestedOperations?: Array<Record<string, unknown>>;
}

/** One check, and what it concluded. */
export interface PipelineCheck {
  id: string;
  /** What the check asks. */
  question: string;
  /** pass | fail | review | indeterminate — never a bare "ok". */
  status: "pass" | "fail" | "review" | "indeterminate";
  /** What was measured. */
  detail: string;
  /** The nodes the check looked at. */
  nodeIds: string[];
}

/* -------------------------------------------------------------------------- */
/* The trace and the report                                                     */
/* -------------------------------------------------------------------------- */

export interface TraceStage {
  stage: string;
  at: number;
  detail: string;
  /** The ids this stage produced, so the next stage can be tied to it. */
  ids: string[];
}

export interface PipelineTrace {
  /** The brief id. */
  briefId: string;
  /** The plan id. */
  planId: string;
  stages: TraceStage[];
  /** The operations sent to Figma, in order. */
  operations: Array<{ type: string; id?: string; parent?: string }>;
  /** The Figma node ids the operations created. */
  nodeIds: string[];
  /** The checks that ran, and their verdicts. */
  checks: PipelineCheck[];
  /** The findings that survived verification. */
  findings: PipelineFinding[];
  /** The repairs that were applied. */
  repairs: Array<{ findingId: string; operations: number; result: "applied" | "skipped" | "failed"; detail: string }>;
  /** The render, if one was produced. */
  render: { revisionId: string | null; nodeId: string | null; detail: "low" | "high" | null; at: number } | null;
}

export interface PipelineReport {
  /** What the pipeline did, in the order it did it. */
  status: "planned" | "built" | "verified" | "repaired" | "incomplete" | "blocked";
  /** The headline, in one sentence. */
  summary: string;
  /** Generated and applied. */
  generated: { brief: boolean; plan: boolean; applied: boolean; operations: number; nodeIds: string[]; transactionId: string | null };
  /** Structurally verified — and how. */
  structurallyVerified: { status: "pass" | "fail" | "review" | "indeterminate" | "not-run"; checks: PipelineCheck[]; detail: string };
  /** Rendered and visually reviewed. */
  visuallyReviewed: { status: "pass" | "fail" | "review" | "indeterminate" | "not-run"; detail: string; renderRevision: string | null };
  /** Automatically repaired. */
  automaticallyRepaired: { count: number; findings: string[]; detail: string };
  /** What is still wrong. */
  remainingFindings: PipelineFinding[];
  /** What could not be checked, and why. */
  blocked: Array<{ check: string; why: string }>;
  /** The trace, for debugging. */
  trace: PipelineTrace;
}
