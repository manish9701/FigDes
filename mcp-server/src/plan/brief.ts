/**
 * design_brief — the step before plan_screen (FigDes §26).
 *
 * ## Why a brief, not just a plan
 *
 * plan_screen answers "how should this be arranged". A brief answers the
 * questions that come first: whose goal, what decision, what is the primary
 * object, what is secondary, what could go wrong. Writing them down before
 * drawing is what keeps a screen from inheriting whoever spoke last in the
 * conversation.
 *
 * Implemented on top of planScreen rather than beside it, so the brief and the
 * plan can never disagree: same classifier, same shells, same geometry engine.
 * The brief reframes the plan's output; it does not recompute it.
 */
import { z } from "zod";
import { classifyDecision, planScreen, templateFor, type ScreenIntent } from "./planner";
import { pipelineBriefFromDesignBrief, type UnmappedField, type DesignBriefArgsShape } from "../pipeline/adapters";
import type { Session } from "../sessions";

export const DesignBriefArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** Which screen, in the file's own language ("model-fit", "V4 Home"). */
    screen: z.string().max(120).optional().describe("Screen name or id, in the file's own language."),
    /** consumer | operator | engineer | leadership... */
    user: z.string().max(120).optional().describe("Who this screen serves."),
    /** Structured audience. Preferred over `user` when the caller knows it. */
    audience: z.enum(["developer", "operator", "engineer", "leadership", "general"]).optional().describe("Who this screen serves, as a structured audience. Shapes density and vocabulary."),
    goal: z.string().max(400).optional().describe("What the user is trying to accomplish, in their words."),
    primaryDecision: z.string().min(2).max(200).describe("What the user decides here. A short noun phrase: 'select a model'."),
    availableInformation: z.array(z.string().max(120)).max(30).optional().describe("Data you actually have. Named, not assumed."),
    existingPatterns: z.array(z.string().max(120)).max(20).optional().describe("Patterns the file already uses."),
    /** Action/state intent, threaded into the plan so the decision's commit step and states are planned, not dropped. */
    primaryAction: z.string().max(160).optional().describe("The one action this screen exists to commit, e.g. 'Launch deployment'."),
    secondaryActions: z.array(z.string().max(160)).max(8).optional().describe("Other actions, subordinate to the primary."),
    states: z.array(z.string().max(40)).max(6).optional().describe("States this screen has to express, e.g. 'selected', 'validating', 'cluster degraded'."),
    primaryObject: z.string().max(160).optional().describe("The primary object this screen is about, when known."),
    visualDirection: z.string().max(120).optional().describe("e.g. technical-editorial. Recorded and passed through, never invented."),
    name: z.string().max(120).optional(),
    canvas: z
      .object({
        width: z.number().positive().max(20000).optional(),
        height: z.number().positive().max(20000).optional(),
        grid: z.number().positive().max(200).optional(),
      })
      .optional(),
  })
  .strict();

/**
 * Builds the brief.
 *
 * Pure apart from planning, which is itself pure: no session, no Figma, no
 * network. Testable without a live anything.
 */
export function buildBrief(args: DesignBriefArgsShape): unknown {
  const intent: ScreenIntent = {
    primaryDecision: args.primaryDecision,
    ...(args.goal !== undefined ? { goal: args.goal } : {}),
    ...(args.audience !== undefined ? { audience: args.audience } : {}),
    ...(args.availableInformation !== undefined ? { availableInformation: args.availableInformation } : {}),
    ...(args.existingPatterns !== undefined ? { existingPatterns: args.existingPatterns } : {}),
    // Action/state intent travels into the planner, so the plan carries the
    // primary action and the declared states rather than losing them here.
    ...(args.primaryAction !== undefined ? { primaryAction: args.primaryAction } : {}),
    ...(args.secondaryActions !== undefined ? { secondaryActions: args.secondaryActions } : {}),
    ...(args.states !== undefined ? { states: args.states } : {}),
    ...(args.primaryObject !== undefined ? { primaryObject: args.primaryObject } : {}),
    ...(args.visualDirection !== undefined ? { visualDirection: args.visualDirection } : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.canvas !== undefined ? { canvas: args.canvas } : {}),
  };

  const plan = planScreen(intent);
  const kind = classifyDecision(args.primaryDecision);
  const template = templateFor(kind);

  /**
   * The pipeline bridge, computed here so the two brief tools are joined by
   * construction rather than by a caller's copy-and-paste (issue #20): a
   * brief whose fields survive `design_brief` but die between the tools is a
   * schema leak. Renames and unmapped fields travel with the bridge, so every
   * adaptation is documented at the moment it happens.
   */
  const { brief: pipelineBrief, renamed, unmapped } = pipelineBriefFromDesignBrief(args);
  const bridge: { brief: unknown; renamed: UnmappedField[]; unmapped: UnmappedField[] } = {
    brief: pipelineBrief,
    renamed,
    unmapped,
  };
  // The action/state fields are accepted here and threaded into the plan
  // intent above, but the brief→pipeline adapter (adapters.ts owns that
  // mapping) has no copy for them yet. Stated ones are recorded as documented
  // loss rather than letting the bridge pretend it carried them.
  if (args.primaryAction !== undefined) {
    bridge.unmapped.push({ field: "primaryAction", reason: "the design-brief → pipeline bridge does not map it yet; the field travels into the plan intent instead." });
  }
  if (args.secondaryActions !== undefined) {
    bridge.unmapped.push({ field: "secondaryActions", reason: "the design-brief → pipeline bridge does not map it yet; the field travels into the plan intent instead." });
  }
  if (args.states !== undefined) {
    bridge.unmapped.push({ field: "states", reason: "the design-brief → pipeline bridge does not map it yet; the field travels into the plan intent instead." });
  }
  if (args.primaryObject !== undefined) {
    bridge.unmapped.push({ field: "primaryObject", reason: "the design-brief → pipeline bridge does not map it yet; the field travels into the plan intent instead." });
  }

  const focal = plan.artDirection.focal;
  const [primary, ...secondary] = plan.artDirection.hierarchy;

  return {
    status: "ok",
    screen: args.screen ?? plan.program.canvas.name,
    user: args.user ?? "general",
    ...(args.audience !== undefined ? { audience: args.audience } : {}),
    userGoal: args.goal ?? "(not stated — ask before drawing)",
    decision: {
      primaryDecision: plan.intent.primaryDecision,
      kind: plan.intent.decisionKind,
    },
    primaryObject: primary !== undefined ? { id: primary.id, why: primary.why } : null,
    secondaryInformation: secondary.map((s) => ({ id: s.id, why: s.why })),
    availableInformation: plan.intent.availableInformation ?? [],
    existingPatterns: plan.intent.existingPatterns ?? [],
    derivation: plan.derivation,
    visualDirection: args.visualDirection ?? null,
    visualDirectionNote:
      args.visualDirection !== undefined
        ? "Pass this to plan_screen as visualDirection; it travels into the build as intent style."
        : "No direction stated, and none invented — ask for one or plan_screen proceeds with the system default.",
    visualHierarchy: plan.artDirection.hierarchy,
    focal: focal ?? { id: "(none)", why: "No region earns focal status; reconsider whether one should." },
    template: { name: template.name, why: template.why },
    compositionCandidates: plan.compositionCandidates,
    componentStrategy: plan.artDirection.componentStrategy,
    visualizationStrategy: plan.artDirection.visualizationStrategy,
    interactionStates: plan.artDirection.interactionStates,
    designRisks: plan.artDirection.designRisks,
    warnings: plan.warnings,
    pipelineBrief: bridge,
    howToProceed:
      "Hand the decision, template, available information and visualDirection to plan_screen for geometry and passes — or hand `pipelineBrief` straight to design_pipeline, whose input it already parses as. The brief is the why; the plan is the where.",
  };
}

export async function designBriefTool(_session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = DesignBriefArgs.parse(rawArgs);
  return buildBrief(args);
}