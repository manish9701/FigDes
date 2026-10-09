/**
 * `plan_screen` — the pre-draw planning tool (spec §30, §31, §32, §38).
 *
 * One call replaces "start drawing immediately". It returns:
 *
 * - the classified primary decision and the composition that follows from it
 * - a 2D composition model with real resolved geometry (§31)
 * - a region program ready to hand to `design_runtime`
 * - the five-pass build plan, each pass naming what it must *not* do yet (§32)
 * - a preview of which product rules the plan is likely to trip
 * - genuine composition alternatives, or none if there is no real trade (§38)
 *
 * It creates nothing. That is the point: the expensive, hard-to-reverse decision
 * happens in a call that costs one message, not an undo.
 */
import { z } from "zod";
import { classifyDecision, planDeckNarrative, planScreen, archetypeFor, SCREEN_ARCHETYPES, type ScreenIntent } from "./planner";
import { notesForPrompt, loadMemory, projectKey } from "../memory/store";
import { bestPattern } from "../design/grammar/matcher";
import { buildCompositionPlan, compositionHolds } from "../design/composition/planner";
import { buildDesignContext, contextBrief } from "../design/context/design-context";
import type { Composition } from "../runtime/layout";
import type { Session } from "../sessions";

export const PlanScreenArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /**
     * The decision this screen exists to support.
     *
     * The only required field. Everything else sharpens the plan, but a screen
     * with no decision behind it is a page, and pages are what turn into
     * dashboards.
     */
    primaryDecision: z.string().min(2).max(200).optional().describe("What the user decides here. A short noun phrase: 'select a model'. May be omitted when archetype implies it."),

    goal: z.string().max(400).optional().describe("What the user is trying to accomplish, in their words."),
    audience: z.enum(["developer", "operator", "engineer", "leadership", "general"]).optional(),
    availableInformation: z.array(z.string().max(120)).max(30).optional().describe("Data you actually have. Named, not assumed."),
    existingPatterns: z.array(z.string().max(120)).max(20).optional().describe("Patterns the file already uses."),
    desiredComposition: z.enum(["editorial", "instrument", "canvas", "topology", "table", "timeline", "split-view", "spatial", "diagram", "sequence", "comparison"]).optional(),
    name: z.string().max(120).optional(),
    /**
     * Visual direction in words ("technical-editorial", "instrument"...).
     *
     * Recorded on the plan and carried into design_runtime as intent style,
     * where the runtime's presets turn it into spacing, rhythm, alignment and
     * contrast mechanics. A direction that never reaches geometry is decoration.
     */
    visualDirection: z.string().max(120).optional().describe("Visual manner in words. Travels with the plan into the build."),
    /**
     * A known screen archetype ("model-fit", "topology", "runtime"...).
     *
     * Inherits the archetype's objective, decision and template instead of
     * re-deriving them — including its anti-patterns, which is where the value
     * compounds. An explicit primaryDecision still wins; the archetype fills
     * what is missing.
     */
    archetype: z.string().max(120).optional().describe("Known EXO screen archetype, e.g. 'model-fit'."),
    /**
     * `deck` plans a slide deck instead of a screen: the canvas becomes
     * 1920x1080 and every region is a slide. Passed through to design_runtime
     * as deck:true, so plan and build agree.
     */
    format: z.enum(["screen", "deck"]).optional(),
    canvas: z
      .object({
        width: z.number().positive().max(20000).optional(),
        height: z.number().positive().max(20000).optional(),
        grid: z.number().positive().max(200).optional(),
      })
      .optional(),

    /** Plan several decision kinds and compare the resulting compositions. */
    artDirection: z.object({
      visualCharacter: z.string().describe("Character of the design (e.g. premium, dense, airy)"),
      primaryFocalObject: z.string(),
      secondaryFocalObject: z.string().optional(),
      density: z.enum(["low", "medium", "high"]),
      gridStrategy: z.string(),
      spatialRhythm: z.string(),
      surfaceStrategy: z.string(),
      typographyHierarchy: z.string(),
      colorStrategy: z.string(),
      depthStrategy: z.string(),
      interactionEmphasis: z.string(),
      compositionType: z.string().describe("Describe relationships not templates. e.g. 'hero dominates 55%, secondary on vertical axis'"),
      rejectGenericDashboard: z.boolean().describe("If true, explicitly rejects conventional SaaS dashboard layouts if they lack strong product reason."),
    }).optional().describe("Explicit Art Director stage to determine visual relationships and style before layout generation."),

    alsoConsider: z.array(z.string().min(2).max(200)).max(3).optional().describe("Other plausible primary decisions, to compare compositions."),
    /**
     * Return full structural variants alongside the recommendation (FigDes §6).
     *
     * Each variant is a real plan recomputed for that composition — regions with
     * reasons and resolved geometry — not a paragraph describing one. Build the
     * strongest, compare, then commit. Defaults on: a single composition should
     * never be considered final without seeing its siblings.
     */
    variants: z.boolean().optional().describe("Include 2-3 full structural variants to compare. Default true."),
  })
  .strict();

/**
 * Builds the tool result.
 *
 * Kept as a separate exported function so it can be tested without a session —
 * the planner is pure and should not require a live Figma connection to exercise.
 */
export function buildPlan(args: z.infer<typeof PlanScreenArgs>, opts: { screen?: string; notes?: string } = {}): unknown {
  // An archetype presets the decision; anything stated explicitly wins. The
  // archetype's anti-patterns join the warnings so they are seen, not buried.
  const archetype = args.archetype !== undefined ? archetypeFor(args.archetype) : undefined;
  if (args.archetype !== undefined && !archetype) {
    throw new Error(
      `Unknown archetype '${args.archetype}'. Known archetypes: ${SCREEN_ARCHETYPES.map((a) => a.name).join(", ")}.`,
    );
  }

  const intent: ScreenIntent = {
    primaryDecision: args.primaryDecision ?? archetype?.decision ?? "",
    ...(args.goal !== undefined ? { goal: args.goal } : archetype?.objective !== undefined ? { goal: archetype.objective } : {}),
    ...(args.audience !== undefined ? { audience: args.audience } : {}),
    ...(args.availableInformation !== undefined ? { availableInformation: args.availableInformation } : {}),
    ...(args.existingPatterns !== undefined ? { existingPatterns: args.existingPatterns } : {}),
    ...(args.desiredComposition !== undefined ? { desiredComposition: args.desiredComposition } : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
    // Deck format overrides any canvas size: slides are fixed 1920x1080, and a
    // custom size here would promise geometry the build cannot produce.
    ...(args.format === "deck" ? { canvas: { width: 1920, height: 1080, grid: 8 } } : args.canvas !== undefined ? { canvas: args.canvas } : {}),
  };

  if (!intent.primaryDecision) {
    throw new Error("plan_screen needs a primaryDecision, or an archetype that implies one.");
  }

  const plan = planScreen(intent);

  // The art director's explicit rejection of generic dashboards is a build
  // instruction, not decoration. The shell for `select` (nav + header +
  // table-content + inspector) IS the dashboard shape when executed
  // literally — so when rejection is requested, say so loudly and point at
  // the spatial sibling instead of silently returning the template.
  const rejectGeneric = args.artDirection?.rejectGenericDashboard === true;
  if (rejectGeneric && isGenericDashboardShape(plan)) {
    plan.warnings.push(
      "rejectGenericDashboard is set, but this plan still has the generic dashboard shape (navigation + header + table-content + inspector). " +
        "Do not execute it literally through design_runtime: build the native spatial shell instead (status strip + topology field + attention rail), " +
        "or confirm the spatial variant below.",
    );
    plan.guardPreview.push({
      rule: "exo.no-generic-saas",
      therefore: "Avoid generic SaaS dashboard composition, especially repeated three-card metric rows. Build the spatial/instrument shell natively; reserve design_runtime for reusable content inside it.",
    });
  }

  // A requested spatial/topology composition with list-detail regions is a
  // mismatch the builder must resolve, not inherit silently.
  if (
    args.desiredComposition !== undefined &&
    ["spatial", "topology", "diagram"].includes(args.desiredComposition) &&
    plan.regions.some((r) => r.role === "header" && r.id === "header") &&
    plan.regions.some((r) => r.role === "navigation")
  ) {
    plan.warnings.push(
      `desiredComposition '${args.desiredComposition}' was honoured as the composition label, but the regions are still the list-detail shell (nav + header + content + inspector). ` +
        "Execute natively per execution.mode instead of forcing these regions through design_runtime.",
    );
  }

  // The direction travels with the plan: the program it returns carries the
  // style into design_runtime, which applies its preset mechanics.
  if (args.visualDirection !== undefined) {
    (plan.program.visualIntent as Record<string, unknown>).style = args.visualDirection;
  }

  // Composition variants: the recommendation plus full structural siblings,
  // each recomputed rather than described. Comparing real geometry is what
  // makes the choice a decision instead of a preference.
  const wantVariants = args.variants !== false;
  const variants = wantVariants
    ? plan.compositionCandidates
        .filter((c) => !c.recommended)
        .slice(0, 2)
        .map((candidate) => {
          const sibling = planScreen({ ...intent, desiredComposition: candidate.composition });
          return {
            composition: sibling.composition,
            template: sibling.template.name,
            why: candidate.why,
            regions: sibling.regions.map((r) => ({ id: r.id, role: r.role, why: r.because })),
            boxes: sibling.boxes,
            focal: sibling.artDirection.focal,
          };
        })
    : [];

  // The program must carry deck:true so design_runtime builds slides. Without
  // it the plan would preview slides and the build would produce frames.
  // Deck mode also replaces the screen shells with the narrative arc: five
  // acts, each its own composition, so consecutive slides never repeat a
  // layout and the deck reads as a sequence with a beginning and an end.
  if (args.format === "deck") {
    (plan.program.canvas as Record<string, unknown>).deck = true;
    const narrative = planDeckNarrative(intent);
    plan.regions = narrative.regions as typeof plan.regions;
    plan.boxes = narrative.regions.map((r) => ({ name: r.id, x: 0, y: 0, w: 1920, h: 1080, why: r.because }));
    plan.composition = "editorial";
    (plan.program as Record<string, unknown>).regions = narrative.regions.map((r) => ({
      fn: "slide",
      id: r.id,
      args: { composition: r.composition, gap: r.gap, padding: r.padding },
    }));
    ((plan as unknown as Record<string, unknown>).deckOutline as unknown) = narrative.acts;
  }

  const alternatives = (args.alsoConsider ?? []).map((decision) => {
    const other = planScreen({ ...intent, primaryDecision: decision });
    return {
      primaryDecision: decision,
      decisionKind: classifyDecision(decision),
      composition: other.composition,
      regions: other.regions.map((r) => ({ id: r.id, why: r.because })),
      /** What this alternative gives up relative to the recommended plan. */
      trade: tradeAgainst(plan.composition, other.composition, plan.regions.length, other.regions.length),
    };
  });

  // Design intelligence (§11–§13): the pattern the decision needs, the
  // composition plan (focal → relationships → context → controls), and the
  // product context the next screen inherits. Additive: existing fields stay.
  const pattern = bestPattern(plan.intent.decisionKind, intent.goal ?? intent.primaryDecision);
  const designContext = buildDesignContext({
    ...(args.audience !== undefined ? { audience: [args.audience] } : {}),
  });
  const compositionPlan = buildCompositionPlan({
    pattern,
    focalId: plan.artDirection.focal?.id ?? null,
    ...(plan.artDirection.focal !== null ? { focalWhy: plan.artDirection.focal.why } : {}),
    hierarchy: plan.artDirection.hierarchy.map((h) => h.id),
    regions: plan.regions.map((r) => ({ id: r.id, role: r.role, why: r.because })),
    ...(args.visualDirection !== undefined ? { visualDirection: args.visualDirection } : {}),
  });
  const holds = compositionHolds(compositionPlan);

  return {
    status: plan.warnings.length > 0 || plan.guardPreview.length > 0 ? "planned-with-warnings" : "planned",

    /** The headline: what this screen is for. */
    decision: {
      primaryDecision: plan.intent.primaryDecision,
      kind: plan.intent.decisionKind,
      composition: plan.composition,
      ...(plan.intent.goal !== undefined ? { goal: plan.intent.goal } : {}),
      ...(plan.intent.audience !== undefined ? { audience: plan.intent.audience } : {}),
    },

    ...(archetype !== undefined
      ? {
          archetype: {
            name: archetype.name,
            objective: archetype.objective,
            priority: archetype.priority,
            antiPatterns: archetype.antiPatterns,
          },
        }
      : {}),

    /**
     * The named screen template this plan follows.
     *
     * Selected by the primary decision, not the page name — which is the whole
     * point. The template names the promise (list-detail, telemetry, topology…)
     * and `program` below is its paste-ready skeleton for design_runtime.
     */
    template: {
      name: plan.template.name,
      why: plan.template.why,
    },

    /**
     * The §31 composition model. Geometry only.
     *
     * Returned as a flat list with an explicit `why` per box, because "a 1440x900
     * frame with three regions" is not a plan — being able to say why each region
     * exists is what makes the plan reviewable before it is built.
     */
    composition: {
      canvas: plan.intent.canvas,
      boxes: plan.boxes,
      note: "Composition only: no content yet. Nothing here has been created in Figma.",
    },

    /** Ordered regions, each with its reason. */
    regions: plan.regions.map((r) => ({ id: r.id, role: r.role, why: r.because, grow: r.grow })),

    /** The art director's decisions: focal, hierarchy, strategies, states, risks. */
    artDirection: plan.artDirection,

    /** Execution guidance derived from the composition, not tool convenience. */
    execution: plan.execution,

    /** Compositions worth comparing, recommended first. */
    compositionCandidates: plan.compositionCandidates,

    /** The five-pass build order. Start at pass 1 and do not skip ahead. */
    passes: plan.passes,

    /** Design intelligence (§11–§13): pattern, composition plan, product context. */
    visualPattern: pattern ? { id: pattern.id, name: pattern.name, purpose: pattern.purpose, focalStrategy: pattern.focalStrategy } : null,
    compositionPlan,
    compositionHolds: holds,
    designContext: { product: designContext.productName, direction: designContext.visualDirection, brief: contextBrief(designContext) },

    /** What to hand to design_runtime for pass 1: frames and a headline only. */
    program: plan.program,

    /** Product rules this plan is likely to trip, and what to do instead. */
    guardPreview: plan.guardPreview,

    /**
     * §38 checkpoint: offer a real choice, or none.
     *
     * Emitted only when there is a genuine trade. Offering two options that are
     * both fine trains the user to click the first one without reading, which
     * makes the next genuine choice unread too.
     */
    ...(plan.alternatives.length > 0
      ? {
          needsDecision: {
            question: `Composition '${plan.composition}' was inferred. '${plan.alternatives[0]!.composition}' is a defensible alternative.`,
            recommended: plan.composition,
            alternatives: plan.alternatives,
            how: "Confirm the recommended composition, or pass desiredComposition to design_runtime.",
          },
        }
      : {}),

    ...(alternatives.length > 0 ? { alsoConsider: alternatives } : {}),

    ...(wantVariants ? { variants, variantsNote: "Build the strongest, compare renders, then commit. A single composition is never final without seeing its siblings." } : {}),

    ...((plan as unknown as Record<string, unknown>).deckOutline !== undefined
      ? { deckOutline: (plan as unknown as Record<string, unknown>).deckOutline }
      : {}),

    warnings: [...(archetype !== undefined ? archetype.antiPatterns.map((a) => `Archetype '${archetype.name}' forbids: ${a}.`) : []), ...plan.warnings],

    ...(opts.notes !== undefined && opts.notes.length > 0 ? { projectMemory: opts.notes } : {}),
    ...(opts.screen !== undefined ? { screen: opts.screen } : {}),
  };
}

/** The dashboard shape: chrome around a table, executed literally. */
function isGenericDashboardShape(plan: { regions: Array<{ id: string; role: string; composition: string }> }): boolean {
  const ids = new Set(plan.regions.map((r) => r.id));
  const hasChrome = ids.has("nav") && (ids.has("header") || ids.has("filters"));
  const hasTableContent = plan.regions.some((r) => (r.id === "content" || r.id === "results") && (r.composition === "table" || r.composition === "canvas"));
  const hasInspector = ids.has("inspector");
  return hasChrome && hasTableContent && hasInspector;
}

/** One sentence on what switching composition costs. */
function tradeAgainst(a: Composition, b: Composition, aRegions: number, bRegions: number): string {
  const delta = bRegions - aRegions;
  const shape = delta === 0 ? "the same number of regions" : delta < 0 ? `${Math.abs(delta)} fewer region(s)` : `${delta} more region(s)`;

  if (a === b) return `Same composition, ${shape}.`;

  const words: Record<string, string> = {
    editorial: "more whitespace, fewer readouts",
    instrument: "denser and more numeric",
    canvas: "one thing at a time, less scanning",
    topology: "the relationships are the content",
    table: "rows read across for comparison",
    timeline: "ordered along a single axis",
    "split-view": "two panes side by side",
    spatial: "positioned by a measure rather than listed",
    auto: "let the planner decide",
  };

  return `Reads as ${words[b] ?? b} instead of ${words[a] ?? a}, using ${shape}.`;
}

/* -------------------------------------------------------------------------- */

export async function planScreenTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = PlanScreenArgs.parse(rawArgs);

  // Project memory is read here so the plan reflects what has already been
  // decided about this project. A plan that ignores recorded preferences is how
  // the same lesson gets relearned every screen.
  const key = projectKey(session?.fileKey, session?.fileName);
  const { memory } = loadMemory(key);
  const notes = notesForPrompt(memory, { limit: 6 });

  return buildPlan(args, { notes });
}

export { PlanScreenArgs as planScreenArgs };