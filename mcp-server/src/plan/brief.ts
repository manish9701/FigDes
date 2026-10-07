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
import type { Session } from "../sessions";

export const DesignBriefArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** Which screen, in the file's own language ("model-fit", "V4 Home"). */
    screen: z.string().max(120).optional().describe("Screen name or id, in the file's own language."),
    /** consumer | operator | engineer | leadership... */
    user: z.string().max(120).optional().describe("Who this screen serves."),
    goal: z.string().max(400).optional().describe("What the user is trying to accomplish, in their words."),
    primaryDecision: z.string().min(2).max(200).describe("What the user decides here. A short noun phrase: 'select a model'."),
    availableInformation: z.array(z.string().max(120)).max(30).optional().describe("Data you actually have. Named, not assumed."),
    existingPatterns: z.array(z.string().max(120)).max(20).optional().describe("Patterns the file already uses."),
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
export function buildBrief(args: z.infer<typeof DesignBriefArgs>): unknown {
  const intent: ScreenIntent = {
    primaryDecision: args.primaryDecision,
    ...(args.goal !== undefined ? { goal: args.goal } : {}),
    ...(args.availableInformation !== undefined ? { availableInformation: args.availableInformation } : {}),
    ...(args.existingPatterns !== undefined ? { existingPatterns: args.existingPatterns } : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.canvas !== undefined ? { canvas: args.canvas } : {}),
  };

  const plan = planScreen(intent);
  const kind = classifyDecision(args.primaryDecision);
  const template = templateFor(kind);

  const focal = plan.artDirection.focal;
  const [primary, ...secondary] = plan.artDirection.hierarchy;

  return {
    status: "ok",
    screen: args.screen ?? plan.program.canvas.name,
    user: args.user ?? "general",
    userGoal: args.goal ?? "(not stated — ask before drawing)",
    decision: {
      primaryDecision: plan.intent.primaryDecision,
      kind: plan.intent.decisionKind,
    },
    primaryObject: primary !== undefined ? { id: primary.id, why: primary.why } : null,
    secondaryInformation: secondary.map((s) => ({ id: s.id, why: s.why })),
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
    howToProceed:
      "Hand the decision, template, available information and visualDirection to plan_screen for geometry and passes. The brief is the why; the plan is the where.",
  };
}

export async function designBriefTool(_session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = DesignBriefArgs.parse(rawArgs);
  return buildBrief(args);
}