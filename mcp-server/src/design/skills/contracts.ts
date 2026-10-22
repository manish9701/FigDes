/**
 * The Design Skills contract (issue #22, phase 1).
 *
 * ## What a skill is
 *
 * A skill is an explicit, testable decision procedure — not a prompt snippet and
 * not a name for a hard-coded template. It declares when it applies, what it
 * needs, the rules it follows per design dimension, structured outputs the
 * planner and the compiler consume, and measurable acceptance criteria. Each
 * skill's `apply` runs in-process against the normalized brief, so a skill can
 * be unit-tested the way any deterministic function is.
 *
 * ## What a skill is not
 *
 * A skill never becomes a second generator: it guides and constrains the
 * existing planner and runtime. `apply` returns decisions, not nodes, not
 * coordinates and not a parallel program.
 */
import { z } from "zod";
import type { NormalizedBrief, CompositionPlan } from "../../pipeline/contracts";
import type { VisualIntent } from "../../../../shared/ir";

/* -------------------------------------------------------------------------- */
/* Design dimensions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The design dimensions a skill may speak about. The list is the issue's list:
 * keeping it closed is what lets a reviewer ask "which dimension does this rule
 * constrain?" and get an answer instead of prose.
 */
export const SKILL_DIMENSIONS = [
  "hierarchy",
  "composition",
  "typography",
  "spacing",
  "color",
  "density",
  "interaction",
  "components",
  "imagery",
  "accessibility",
  "responsive",
] as const;

export type SkillDimension = (typeof SKILL_DIMENSIONS)[number];

/* -------------------------------------------------------------------------- */
/* Signals                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Brief features a selector may match skills against. "Avoid running every
 * skill on every screen" is enforced at this level: a skill announces the
 * signals it needs and the selector skips it — with a recorded reason — when
 * none of them fire.
 */
export const SKILL_SIGNALS = [
  /** The brief states a visual manner in words. */
  "stated-direction",
  /** The brief names information the screen must carry. */
  "content-inventory",
  /** The screen will end up with four or more regions. */
  "many-regions",
  /** The brief asks for an overview/dashboard data surface. */
  "card-grid-risk",
  /** Numeric or time-series readouts dominate the information. */
  "data-readouts",
  /** The caller insists on a spatial/canvas/topology composition. */
  "spatial-request",
  /** A form/configure task. */
  "form-task",
  /** The brief declares design-system constraints the output must honour. */
  "design-system-context",
  /** The direction names a closed-vocabulary composition descriptor (issue #24, item 3). */
  "composition-request",
] as const;

export type SkillSignal = (typeof SKILL_SIGNALS)[number];

/* -------------------------------------------------------------------------- */
/* The skill spec                                                              */
/* -------------------------------------------------------------------------- */

export const SkillSpecSchema = z
  .object({
    /** `^[a-z][a-z0-9-]*$` — a stable id the registry, reports and tests key on. */
    id: z.string().regex(/^[a-z][a-z0-9-]*$/, "skill id must be kebab-case"),
    /** Version of the skill's rules; bumped when a decision rule changes. */
    version: z.string().regex(/^v\d+$/, "version must be like v1"),
    name: z.string().min(1).max(80),
    purpose: z.string().min(20).max(600),
    /** Signals that, when any of them fires, make the skill applicable. */
    signals: z.array(z.enum(SKILL_SIGNALS)).min(1),
    whenToUse: z.string().min(1),
    whenNotToUse: z.string().min(1),
    expectedOutput: z.string().min(1),
    /** Named input contracts the skill requires. */
    requiredInputs: z.array(z.string().min(1)).min(1),
    /** Context the skill reads opportunistically when it is available. */
    optionalContext: z.array(z.string().min(1)),
    decisionRules: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            dimension: z.enum(SKILL_DIMENSIONS),
            rule: z.string().min(10).max(500),
            why: z.string().min(1).max(400).optional(),
          })
          .strict(),
      )
      .min(1),
    /**
     * Structured outputs, each with the consumer that reads it.
     *
     * An output whose `consumedBy` is empty is a dead field by definition, so
     * the schema refuses it. This is the issue's "no field without a
     * traceable effect" rule, applied to skills themselves.
     */
    outputs: z
      .array(
        z
          .object({
            field: z.string().regex(/^[a-z0-9-]+$/),
            description: z.string().min(1).max(300),
            consumedBy: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    /** Measurable acceptance criteria, tied to a dimension. */
    qualityChecks: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9-]+$/),
            dimension: z.enum(SKILL_DIMENSIONS),
            /** How passing is decided, so a reviewer can check it by hand. */
            criterion: z.string().min(10).max(400),
          })
          .strict(),
      )
      .min(1),
    examples: z
      .array(z.object({ summary: z.string().min(1).max(300), why: z.string().min(1).max(400) }).strict())
      .min(1),
    counterexamples: z
      .array(z.object({ summary: z.string().min(1).max(300), why: z.string().min(1).max(400) }).strict())
      .min(1),
    /** Regression fixture ids this skill's behaviour is pinned against. */
    fixtures: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
  })
  .strict();

export type SkillSpec = z.infer<typeof SkillSpecSchema>;

/* -------------------------------------------------------------------------- */
/* Skill outputs                                                               */
/* -------------------------------------------------------------------------- */

/** One decision a skill made, with the reason it can be audited by. */
export interface SkillDecision {
  skill: string;
  /** The dimension the decision constrains, so a report can group them. */
  dimension: SkillDimension;
  key: string;
  /** String, number or boolean depending on the decision. */
  value: string | number | boolean;
  why: string;
  /** True when the brief states this as a hard constraint, not a preference. */
  hard: boolean;
}

/** What one skill produced for one input. */
export interface SkillOutput {
  skill: string;
  decisions: SkillDecision[];
  notes: string[];
  /**
   * Plan-level findings, only for review-time skills that receive a plan.
   * Findings are recorded, not repaired silently: repairs are the repair
   * planner's job and only for findings it can act on.
   */
  findings?: SkillFinding[];
}

/** A finding a review skill raised against a plan or a build. */
export interface SkillFinding {
  /** `anti-generic.<rule>` or `skill.<id>`. */
  rule: string;
  severity: "critical" | "serious" | "minor";
  confidence: "high" | "medium" | "low";
  summary: string;
  why: string;
  /** The measurable or structural evidence behind the finding. */
  evidence: string;
  /** What would fix it, so a reviewer can act without re-deriving. */
  repair: string;
}

/** An input the skill layer hands to a skill's `apply`. */
export interface SkillInput {
  brief: NormalizedBrief;
  /**
   * The composition plan, when one exists. Compile-time skills (direction,
   * composition, type/spacing) run before the plan and see none; review-time
   * skills (anti-generic) run after and review it.
   */
  plan?: CompositionPlan;
}

/** A registered skill: validated spec plus the executable decision procedure. */
export interface SkillEntry {
  spec: SkillSpec;
  apply: (input: SkillInput) => SkillOutput;
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

export const SkillSelectionSchema = z
  .object({
    /** The signals that actually fired. */
    signals: z.array(z.enum(SKILL_SIGNALS)),
    /** Skills whose signals fired; a subset of the registry. */
    selected: z.array(z.string().min(1)),
    /** Skills not selected, each with the reason a reviewer can check. */
    skipped: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) }).strict()),
  })
  .strict();

export type SkillSelection = z.infer<typeof SkillSelectionSchema>;

/* -------------------------------------------------------------------------- */
/* The canonical visual intent                                                 */
/* -------------------------------------------------------------------------- */

/**
 * ## One compiler, one target
 *
 * The canonical typed visual intent is `shared/ir.ts`'s `VisualIntent` — the
 * schema the runtime's interpreter already parses programs with. The compiler
 * produces exactly that shape, so intent never has a second representation to
 * drift against.
 *
 * The issue requires that no visual-intent field is a dead field: every field
 * is either consumed by a named module or explicitly marked unsupported with a
 * reason. `INTENT_FIELD_CONSUMERS` is that ledger, and the contract test
 * asserts it covers every field `VisualIntentSchema` declares.
 */
export interface IntentFieldConsumer {
  /** `consumed` — some module reads the field. `unsupported` — declared but intentionally inert, with the reason. */
  status: "consumed" | "unsupported";
  /** The module path and function that reads the field (consumed fields). */
  consumer?: string;
  /** What changes in plan or render when the field is set (consumed fields). */
  effect?: string;
  /** Why the field is inert (unsupported fields). Never empty for `unsupported`. */
  reason?: string;
}

/**
 * The consumer ledger for the canonical `VisualIntent`. Keys must cover every
 * field of `shared/ir.ts`'s `VisualIntentSchema` — the contract test walks the
 * schema's own shape to check that, so a new shared field cannot be added
 * silently without being either wired or explicitly written off.
 */
export const INTENT_FIELD_CONSUMERS: Record<string, IntentFieldConsumer> = {
  style: {
    status: "consumed",
    consumer: "mcp-server/src/runtime/visual-presets.ts resolveStyleTokens + mcp-server/src/runtime/compile.ts styleLook",
    effect:
      "Named manner resolved into concrete mechanics: surfaces (bordered/open), typography voice (quiet/editorial/confident), numeral discipline (tabular/mono-first), warmth, shape, sizing, color usage.",
  },
  density: {
    status: "consumed",
    consumer: "mcp-server/src/runtime/interpreter.ts GAP_SCALE",
    effect: "Scales the whole spacing system (airy 1.5 / calm 1.25 / balanced 1 / dense 0.75 - the grid stays, gap rhythm follows).",
  },
  focal: {
    status: "consumed",
    consumer: "mcp-server/src/runtime/interpreter.ts (growth + emphasis)",
    effect: "The named region gets grow 2 so the eye lands there first; content ids may also be named.",
  },
  visualWeight: {
    status: "consumed",
    consumer: "mcp-server/src/runtime/interpreter.ts (growth weighting)",
    effect: "Per-region relative weight 0-1 drives how leftover space is distributed.",
  },
  rhythm: {
    status: "consumed",
    consumer: "mcp-server/src/runtime/compile.ts rhythmScale",
    effect: "Multiplies inter-region gutters: generous 1.25, tight 0.75, even 1.",
  },
  contrast: {
    status: "consumed",
    consumer: "mcp-server/src/runtime/compile.ts titleScale",
    effect: "Scales display type: bold 1.15, muted 0.9, restrained 1.",
  },
  alignment: {
    status: "consumed",
    consumer: "mcp-server/src/runtime/compile.ts alignGrid",
    effect: "Strong alignment snaps region bounds to the canvas grid; loose keeps the computed rhythm.",
  },
  depth: {
    status: "consumed",
    consumer: "mcp-server/src/runtime/compile.ts (elevation)",
    effect: "Layered/subtle lift chrome and panel regions one elevation level (soft shadow); flat stays flat.",
  },
  composition: {
    status: "consumed",
    consumer:
      "mcp-server/src/design/skills/composition.ts apply (closed-vocabulary descriptor → composition decisions) + " +
      "mcp-server/src/design/composition/planner.ts buildCompositionPlan / applyCompositionHint (hint → density, geometry, negative space)",
    effect:
      "A descriptor word in the direction ('asymmetric | split | centered | radial | dense-editorial | topology-over-inspector') " +
      "is compiled by the composition-strategy skill into concrete density/rhythm/alignment overrides plus a composition hint. " +
      "The composition planner applies that hint to the plan's density, geometry and negative-space plans, naming the descriptor " +
      "as provenance. The runtime interpreter still never reads the field directly: the effect is plan-level, and a caller-supplied " +
      "desiredComposition remains the hard shell constraint the descriptor can never replace.",
  },
};

/**
 * Lists every declared `VisualIntent` field and classifies it. Used by the
 * contract test ("no silent dead fields") and available to reports.
 */
export function intentFieldLedger(): Record<string, IntentFieldConsumer> {
  return INTENT_FIELD_CONSUMERS;
}

/** Re-export so callers of the skills layer can validate without a second import. */
export type CanonicalVisualIntent = VisualIntent;
