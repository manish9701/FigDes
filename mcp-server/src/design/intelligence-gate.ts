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
 */

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    `Design intelligence bypassed: this ${channel} carries no plan_screen plan and declares no visualIntent.style, so ${what}. ` +
    `${fallback} which is a floor, not a plan. ` +
    `Call plan_screen first (or design_pipeline for the whole loop) and build from its program — until then this result is undisciplined by decision classification, composition hints and the guard preview.`
  );
}

/**
 * Assesses a `design_runtime` program (the shape `RuntimeArgs.program`).
 *
 * A `plan` field means the program came from `plan_screen` (or carries its
 * output wholesale): the decision was classified by `classifyDecision` and
 * the composition hint was applied by the composition planner. A declared
 * `visualIntent.style` is explicit art direction and also counts. Anything
 * else rides the auto art-direction fallback and is reported as bypassed.
 */
export function assessRuntimeIntelligence(program: unknown, opts: { autoStyle?: string | null } = {}): IntelligenceAssessment {
  if (isRecord(program)) {
    if (isRecord(program["plan"])) {
      return {
        applied: true,
        basis: "plan",
        detail: "The program carries a plan_screen plan: the primary decision was classified and the composition hint was applied upstream.",
        warnings: [],
      };
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
