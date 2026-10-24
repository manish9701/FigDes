/**
 * Intelligence gate — mandatory design-intelligence enforcement (issue #24).
 *
 * ## The bypass problem
 *
 * The design-intelligence stack lives in `design/*` (skills, composition
 * planner, grammar, benchmark), `plan/planner.ts` (classifyDecision,
 * planScreen), `pipeline/*` and the product guard (`memory/guard.ts` +
 * `memory/rules-exo.ts`, applied at build time by `runtime/interpreter.ts`).
 * But every one of those stages is reachable only through the tools that call
 * it: a caller that compiles a raw program via `design_runtime`, raw IR via
 * `compile_ir`, or raw operations via `create_design` / `figdes_use_figma`
 * skips decision classification, composition hints and the guard preview
 * without anything saying so.
 *
 * This module is the single choke point that names that skip. It does not
 * block — a raw program is still compilable, and the auto art-direction
 * fallback still lifts it — but the payload carries `intelligence-applied`
 * as a first-class verdict (`applied: true/false` with a basis and a
 * warning), so a bypass is disclosed, never silent.
 *
 * ## Bases
 *
 * - `plan` — the program carries a `plan_screen` plan (or is the plan's own
 *   runtime program): decision classified, composition hint applied.
 * - `visual-intent` — the caller declared `visualIntent.style`: explicit art
 *   direction, auto-direction skipped.
 * - `auto-art-direction` — neither of the above: the runtime's curated
 *   fallback applies. Quality floor, not intelligence. `applied: false`.
 * - `none` — raw IR/operations with no intent channel at all. `applied: false`.
 *
 * ## Verification, not self-report (issue #29)
 *
 * A plan channel counts only when the server can verify it: a `planId` must
 * resolve against the plan registry (`plan/registry.ts`) — the set of plans
 * the server itself issued — and an inlined plan must be plan-shaped (carry
 * the `program` and `intelligence` receipts a real buildPlan payload has).
 * Self-asserted flags are no longer accepted anywhere.
 */

import { isPlanShaped, isRecord, resolvePlan } from "../plan/registry";

export type IntelligenceBasis = "plan" | "visual-intent" | "auto-art-direction" | "none";

export interface IntelligenceAssessment {
  /**
   * True only when the caller supplied plan-level or explicit visual
   * intelligence. The auto fallback keeps `applied: false`: it is a safety
   * net, and a net that reports itself as a plan stops anyone calling the
   * plan.
   */
  applied: boolean;
  /** Where the (absent) intelligence would have come from. */
  basis: IntelligenceBasis;
  /** One sentence of provenance for the payload. */
  detail: string;
  /** Non-empty exactly when `applied` is false. */
  warnings: string[];
}

function bypassWarning(autoStyle: string | null, channel: "program" | "IR"): string {
  const fallback =
    autoStyle !== null
      ? `Auto art-direction '${autoStyle}' was applied as a quality fallback,`
      : `No art direction was declared,`;
  const what =
    channel === "program"
      ? "no decision was classified and no composition hint was applied"
      : "no decision was classified, no composition hint was applied, and no visual intent travelled with the build";
  return (
    `Design intelligence bypassed: this ${channel} carries no plan_screen plan (no registered planId, no inlined plan) and declares no visualIntent.style, so ${what}. ` +
    `${fallback} which is a floor, not a plan. ` +
    `Call plan_screen first (or design_pipeline for the whole loop) and build from its program — until then this result is undisciplined by decision classification, composition hints and the guard preview.`
  );
}

/**
 * Assesses a `design_runtime` program (the shape `RuntimeArgs.program`).
 *
 * Verified provenance (issue #29): a program carrying a `planId` must
 * resolve against the plan registry — the plans this server issued; an
 * inlined `plan` must be plan-shaped (a real plan payload carries `program`
 * and `intelligence` receipts, and if it names a planId that must resolve
 * too). A declared `visualIntent.style` is explicit art direction. Anything
 * else rides the auto art-direction fallback and is reported as bypassed.
 */
export function assessRuntimeIntelligence(
  program: unknown,
  opts: { autoStyle?: string | null; fileKey?: string | null } = {},
): IntelligenceAssessment {
  if (isRecord(program)) {
    // A server-issued planId is the airtight channel: the registry remembers
    // the plans this server issued, so an invented id resolves to nothing.
    const planId = program["planId"];
    if (typeof planId === "string" && planId.length > 0) {
      if (resolvePlan(planId, opts.fileKey ?? null) !== null) {
        return {
          applied: true,
          basis: "plan",
          detail: `The program references plan_screen plan '${planId}': registered server-side when it was issued, so the decision was classified and the composition hint was applied upstream.`,
          warnings: [],
        };
      }
    }
    const plan = program["plan"];
    if (isRecord(plan) && isPlanShaped(plan)) {
      // An inlined plan that names a planId must resolve; one that does not
      // is a fabricated payload, not provenance.
      const inlineId = plan["planId"];
      if (!(typeof inlineId === "string" && inlineId.length > 0) || resolvePlan(inlineId, opts.fileKey ?? null) !== null) {
        return {
          applied: true,
          basis: "plan",
          detail: "The program carries a plan_screen plan: the primary decision was classified and the composition hint was applied upstream.",
          warnings: [],
        };
      }
    }
    const intent = program["visualIntent"];
    if (isRecord(intent) && typeof intent["style"] === "string" && intent["style"].length > 0) {
      return {
        applied: true,
        basis: "visual-intent",
        detail: `The program declares visualIntent.style '${intent["style"]}': explicit art direction, so no fallback was applied.`,
        warnings: [],
      };
    }
  }
  const autoStyle = opts.autoStyle ?? null;
  return {
    applied: false,
    basis: "auto-art-direction",
    detail:
      autoStyle !== null
        ? `No plan and no declared style: auto art-direction '${autoStyle}' applied as a fallback. Intelligence-applied is false — a fallback is not a plan.`
        : "No plan and no declared style: the build ran without design intelligence.",
    warnings: [bypassWarning(autoStyle, "program")],
  };
}

/**
 * Assesses a raw Design IR (the shape `compile_ir` takes).
 *
 * IR has no `plan` channel — a plan only travels on the runtime program — so
 * the only intelligence it can carry is a declared `visualIntent.style`.
 * Everything else is `none`: no intent channel at all.
 */
export function assessIRIntelligence(ir: unknown): IntelligenceAssessment {
  if (isRecord(ir)) {
    const intent = ir["visualIntent"];
    if (isRecord(intent) && typeof intent["style"] === "string" && intent["style"].length > 0) {
      return {
        applied: true,
        basis: "visual-intent",
        detail: `The IR declares visualIntent.style '${intent["style"]}': explicit art direction travelled with the build.`,
        warnings: [],
      };
    }
  }
  return {
    applied: false,
    basis: "none",
    detail: "Raw IR carries no plan and no visual intent: the build ran without design intelligence.",
    warnings: [bypassWarning(null, "IR")],
  };
}

/* -------------------------------------------------------------------------- */
/* The planless-screen gate (issue #29)                                        */
/* -------------------------------------------------------------------------- */

/**
 * How many top-level regions a program builds.
 *
 * Region count is the screen-scale measure the gate stands on: a single
 * component or panel is one region, a screen shell (nav + header + content)
 * is three or more.
 */
export function programRegionCount(program: unknown): number {
  if (!isRecord(program)) return 0;
  const regions = program["regions"];
  return Array.isArray(regions) ? regions.length : 0;
}

/**
 * The refusal a planless screen-scale `design_runtime` build gets: a
 * `needs-approval` result, not an error and not a warning in a payload the
 * model can ignore. The auto art-direction fallback stays available for
 * small builds — a single region is a component, and a component does not
 * need a plan — but a screen built without design intelligence is exactly
 * the generic, mediocre output the planner exists to prevent.
 */
export function planlessScreenRefusal(regions: number): Record<string, unknown> {
  return {
    status: "needs-approval",
    question:
      `This program builds ${regions} regions — a full screen — with no plan_screen provenance: no registered planId, no inlined plan, and no declared visualIntent.style. ` +
      `Building a screen without decision classification, composition hints and the build-time product guard is how generic, mediocre screens get made. Is this raw build intentional?`,
    ifApproved: "The program is built on the auto art-direction fallback, without design intelligence.",
    instead:
      "Call plan_screen first (or design_pipeline for the whole loop) and build from its program — it carries a planId this server issued, so the build is planned rather than improvised.",
    checkpoints: [{ gate: "planless-screen", detail: `a ${regions}-region program with no verified design-intelligence provenance` }],
    measured: { regions },
    howToProceed:
      "Nothing has been changed. If the user confirms the raw build is intentional, call this tool again with approved:true and a short reason. " +
      "To inspect the compiled layout first, call the same tool with dryRun:true - that needs no approval.",
  };
}
