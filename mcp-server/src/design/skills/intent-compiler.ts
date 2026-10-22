/**
 * The Visual Intent Compiler (issue #22, requirement 2).
 *
 * ## What this is
 *
 * One pass that turns a normalized brief into the canonical, typed visual
 * intent the runtime already parses (`shared/ir.ts` `VisualIntent`), by
 * selecting the skills whose signals fire, running them, and merging their
 * `visual-intent.*` decisions into one coherent intent.
 *
 * The compile decisions travel with the intent (`decisions`, `notes`,
 * `selection`) so every field has a traceable provenance: an intent field with
 * no decision behind it does not exist — the compiler only writes fields a
 * skill decided.
 *
 * ## The rules that keep it honest
 *
 * - **No second generator.** The output is the same schema the interpreter
 *   parses today; nothing here invents coordinates, nodes or a parallel IR.
 * - **No dead fields.** Every `VisualIntent` field the runtime *or* the
 *   composition planner does not read is explicitly marked unsupported in
 *   `INTENT_FIELD_CONSUMERS`; the contract test walks `VisualIntentSchema.shape`
 *   against that ledger. `composition` (issue #24, item 3) is consumed at plan
 *   level: the composition skill compiles closed-vocabulary descriptors and the
 *   composition planner applies the compiled hint with provenance.
 * - **Manner is specific.** When two skills claim the same intent field, the
 *   per-field priority table (KEY_PRIORITY) decides, and the overridden
 *   decision stays in the trail with a note. Ties are deterministic.
 * - **Density defers to style.** When the compiled style tokens already imply
 *   a density (e.g. the `instrument` accordion), the compiler leaves
 *   `density` unset so the runtime resolves it from the manner itself, and
 *   the archetype default is recorded as not applied.
 */
import { VisualIntentSchema, type VisualIntent } from "../../../../shared/ir";
import type { NormalizedBrief, CompositionPlan } from "../../pipeline/contracts";
import { classifyDecision } from "../../plan/planner";
import { resolveStyleTokens } from "../../runtime/visual-presets";
import {
  SKILL_SIGNALS,
  intentFieldLedger,
  type SkillDecision,
  type SkillEntry,
  type SkillFinding,
  type SkillOutput,
  type SkillSelection,
  type SkillSignal,
} from "./contracts";
import { SkillRegistry, createSkillRegistry } from "./registry";
import { briefArtDirection } from "./direction";
import { compositionStrategy, detectCompositionDescriptors, COMPOSITION_VOCABULARY } from "./composition";
import { typeAndSpace } from "./type-space";
import { antiGenericReview, reviewPlan } from "./anti-generic";

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

/** The four phase-1 skills, in registration order (direction first is load-bearing for ties). */
export function defaultSkillRegistry(): SkillRegistry {
  return createSkillRegistry(briefArtDirection, typeAndSpace, compositionStrategy, antiGenericReview);
}

/* -------------------------------------------------------------------------- */
/* Signals                                                                     */
/* -------------------------------------------------------------------------- */

interface SignalFacts {
  signals: SkillSignal[];
  why: Partial<Record<SkillSignal, string>>;
}

/**
 * Derives the selector signals from the brief. Each signal records why it
 * fired, so a selection report says what the brief exhibited, not just which
 * skills were chosen.
 */
export function computeSignals(brief: NormalizedBrief): SignalFacts {
  const signals: SkillSignal[] = [];
  const why: SignalFacts["why"] = {};

  if (brief.visualDirection !== null) {
    signals.push("stated-direction");
    why["stated-direction"] = `The brief states a visual manner: '${brief.visualDirection}'.`;
  }
  if (brief.designSystemConstraints.length > 0) {
    signals.push("design-system-context");
    why["design-system-context"] = `${brief.designSystemConstraints.length} design-system constraint(s) declared.`;
  }
  const infoCount = brief.requiredInformation.length + brief.optionalInformation.length;
  if (infoCount > 0) {
    signals.push("content-inventory");
    why["content-inventory"] = `${infoCount} information item(s) named.`;
  }
  const statesAndActions = infoCount + brief.states.length + brief.interactions.length;
  if (infoCount + brief.states.length >= 6 || statesAndActions >= 8) {
    signals.push("many-regions");
    why["many-regions"] = `${statesAndActions} information item(s)/state(s)/interaction(s) — the plan will carry several regions.`;
  }
  const briefText = [brief.primaryDecision, brief.purpose, brief.product ?? ""].join(" ");
  const numericInfo = [...brief.requiredInformation, ...brief.optionalInformation].filter((i) =>
    /\b(\d|percent|%|rate|latency|throughput|ms|count|score|status|uptime|price|load|pressure)\b/i.test(i),
  ).length;
  if (numericInfo >= 2) {
    signals.push("data-readouts");
    why["data-readouts"] = `${numericInfo} information item(s) name numeric or status readouts.`;
  }
  if (/\boverview|\bdashboard|\bcard\w*\b/i.test(briefText) || /\boverview|\bdashboard\b/i.test([...brief.requiredInformation, ...brief.optionalInformation].join(" "))) {
    signals.push("card-grid-risk");
    why["card-grid-risk"] = "The brief names an overview/dashboard surface — the shape where template drift is most common.";
  }
  if (brief.desiredComposition !== undefined && ["canvas", "topology", "spatial", "diagram"].includes(brief.desiredComposition)) {
    signals.push("spatial-request");
    why["spatial-request"] = `The caller insists on '${brief.desiredComposition}'.`;
  }
  if (brief.visualDirection !== undefined && brief.visualDirection !== null) {
    const descriptors = detectCompositionDescriptors(brief.visualDirection).applied;
    if (descriptors.length > 0) {
      signals.push("composition-request");
      why["composition-request"] = `The direction names the composition descriptor(s) '${descriptors.join("', '")}' — closed-vocabulary composition word(s).`;
    }
  }
  if (classifyDecision(brief.primaryDecision) === "configure") {
    signals.push("form-task");
    why["form-task"] = "The primary decision is a configure task.";
  }

  return { signals, why };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compile-phase entries: everything except skills whose required input is a
 * composition plan (those review the plan after it exists and cannot run at
 * compile time by definition, not by convention).
 */
function compilePhaseEntries(registry: SkillRegistry): SkillEntry[] {
  return registry.list().filter((e) => !e.spec.requiredInputs.includes("compositionPlan"));
}

/** Review-phase entries: the mirror image of `compilePhaseEntries`. */
function reviewPhaseEntries(registry: SkillRegistry): SkillEntry[] {
  return registry.list().filter((e) => e.spec.requiredInputs.includes("compositionPlan"));
}

function selectSkillsForSignals(
  registry: SkillRegistry,
  signals: SkillSignal[],
  signalWhy: SignalFacts["why"],
): SkillSelection {
  const fired = new Set(signals);
  const selected: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const entry of compilePhaseEntries(registry)) {
    const applicable = entry.spec.signals.filter((s) => fired.has(s));
    if (applicable.length > 0) {
      selected.push(entry.spec.id);
      continue;
    }
    skipped.push({
      id: entry.spec.id,
      reason:
        `No applicable signal: ${entry.spec.name} needs one of [${entry.spec.signals.join(", ")}], but the brief exhibits ` +
        (signals.length > 0 ? signals.map((s) => `'${s}'`).join(", ") : "no skill signals") +
        ` (${entry.spec.whenNotToUse})`,
    });
  }
  return { signals, selected, skipped };
}

/* -------------------------------------------------------------------------- */
/* Compile                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Per-field priority: which skill's decision wins when two set the same
 * canonical field. Registration order (direction first) supplies the default
 * first-wins rule; this table only states where evidence should outrank
 * manner or fashion.
 */
const KEY_PRIORITY: Record<string, string[]> = {
  "visual-intent.alignment": ["type-and-space", "composition-strategy"],
};

/** Canonical fields the skills may write, and their runtime value types. */
const FIELD_TYPES: Record<string, string[]> = {
  "visual-intent.style": ["string"],
  "visual-intent.composition": [...COMPOSITION_VOCABULARY],
  "visual-intent.density": ["airy", "calm", "balanced", "dense"],
  "visual-intent.rhythm": ["generous", "tight", "even"],
  "visual-intent.alignment": ["loose", "strong"],
  "visual-intent.contrast": ["muted", "restrained", "bold"],
  "visual-intent.depth": ["flat", "subtle", "layered"],
  "visual-intent.numerals": ["tabular", "mono-first", "proportional"],
};

export interface VisualIntelligence {
  /** The canonical compiled intent, in the interpreter's own schema. */
  intent: VisualIntent;
  /** The signals that fired during compile. */
  signals: SkillSignal[];
  /** Selection outcome — selected and skipped-with-reason. */
  selection: SkillSelection;
  /** The full decision trail: what the skills decided and why. */
  decisions: SkillDecision[];
  /** Compile notes, auditable: what was applied, overridden, dropped. */
  notes: string[];
}

/**
 * Compiles the visual intent for a brief. Runs the compile-phase skills whose
 * signals fire and merges their canonical decisions. Never throws: intent is
 * taste, and a failed skill is noted, not fatal — the planner's own derivation
 * stays in charge.
 *
 * `statedInformation` carries `availableInformation` items the caller supplied
 * without a required/optional split. The skill layer folds them into its
 * content view (optional-information-equivalent), because "the caller listed
 * seven readouts" is content shape, and a fold that is not recorded would be
 * a silent reinterpretation.
 */
export function compileVisualIntent(
  brief: NormalizedBrief,
  opts?: { registry?: SkillRegistry; statedInformation?: string[] },
): VisualIntelligence {
  const registry = opts?.registry ?? defaultSkillRegistry();
  /* Ad-hoc callers (tests, other tools) may hand in a partial brief; every
     collection the skills read is defaulted here so a missing field is an
     empty list, never a TypeError. The skills themselves keep the strict
     NormalizedBrief contract — nowhere else are defaults applied. */
  const notesPrefix: string[] = [];
  const stated = opts?.statedInformation ?? [];
  const optionalFold = [
    ...(brief.optionalInformation ?? []),
    ...stated.filter((s) => !(brief.optionalInformation ?? []).includes(s) && !(brief.requiredInformation ?? []).includes(s)),
  ];
  if (stated.length > 0 && optionalFold.length > (brief.optionalInformation ?? []).length) {
    const added = optionalFold.length - (brief.optionalInformation ?? []).length;
    notesPrefix.push(
      `${added} stated availableInformation item(s) folded into the skill layer's content view as optional-equivalent; the plan's own placement still uses the brief untouched.`,
    );
  }
  const brief_: NormalizedBrief = {
    ...brief,
    requiredInformation: brief.requiredInformation ?? [],
    optionalInformation: optionalFold,
    states: brief.states ?? [],
    interactions: brief.interactions ?? [],
    designSystemConstraints: brief.designSystemConstraints ?? [],
    antiGoals: brief.antiGoals ?? [],
  };
  const facts = computeSignals(brief_);
  const selection = selectSkillsForSignals(registry, facts.signals, facts.why);

  const outputs: Array<{ id: string; output: SkillOutput }> = [];
  for (const id of selection.selected) {
    const entry = registry.get(id);
    if (entry === undefined) continue;
    try {
      const output = entry.apply({ brief: brief_ });
      outputs.push({ id, output });
    } catch (error) {
      selection.skipped.push({ id, reason: `Skill failed apply(): ${(error as Error).message}` });
    }
  }
  /* --- merge the canonical fields ------------------------------------------ */

  /** key → [field, value, skillId, why] in the order decisions were made. */
  const candidates = new Map<string, Array<{ field: string; value: string; skill: string; why: string }>>();
  const notes: string[] = [...notesPrefix];
  const decisions: SkillDecision[] = [];
  for (const { output } of outputs) {
    notes.push(...output.notes);
    decisions.push(...output.decisions);
    for (const decision of output.decisions) {
      if (!(decision.key in FIELD_TYPES)) continue;
      if (decision.key.startsWith("visual-intent.")) {
        const list = candidates.get(decision.key) ?? [];
        list.push({ field: decision.key, value: String(decision.value), skill: decision.skill, why: decision.why });
        candidates.set(decision.key, list);
      }
    }
  }

  const intentRec: Record<string, unknown> = {};
  for (const [key, list] of candidates) {
    const priority = KEY_PRIORITY[key];
    let chosen = list[0]!;
    if (list.length > 1) {
      if (priority !== undefined) {
        for (const preferred of priority) {
          const found = list.find((c) => c.skill === preferred);
          if (found !== undefined) {
            chosen = found;
            break;
          }
        }
      }
      const overridden = list.filter((c) => c !== chosen);
      if (overridden.length > 0) {
        if (overridden.every((c) => c.skill === chosen.skill)) {
          notes.push(
            `Self-tension inside '${chosen.skill}': two manner words claimed '${key}' (${overridden.map((c) => `'${c.value}', then '${chosen.value}'`).join("; ")}). The earlier word's claim was overridden; the tension is also in the direction skill's own notes.`,
          );
        } else {
          notes.push(
            `Field conflict on '${key}': ${overridden.map((c) => `'${c.field}'='${c.value}' from ${c.skill}`).join(", ")} overridden by ${chosen.skill}'s decision; overridden decision kept in the trail.`,
          );
        }
        for (const c of overridden) {
          decisions.push({
            skill: chosen.skill,
            dimension: "composition",
            key: `${key} overridden`,
            value: `${c.value} (from ${c.skill})`,
            why: `The compiler applied ${chosen.skill}'s value (${chosen.why}). The overridden decision stays here for audit.`,
            hard: false,
          });
        }
      }
    }
    if (chosen.value.length === 0) continue;
    intentRec[singleFieldKey(key)] = chosen.value;
  }

  /* --- density defers to style --------------------------------------------- */

  if (intentRec.density !== undefined && intentRec.style !== undefined) {
    const mechanics = resolveStyleTokens(String(intentRec.style)).mechanics;
    if (mechanics.density !== undefined) {
      if (mechanics.density !== intentRec.density) {
        notes.push(
          `Density '${intentRec.density}' not compiled: the style tokens ([${intentRec.style}]) already imply '${mechanics.density}', and the runtime resolves density from the manner itself. The archetype default is recorded here for audit.`,
        );
      } else {
        notes.push(`Density '${intentRec.density}': already implied by the style tokens; field left to the manner and not duplicated.`);
      }
      delete intentRec.density;
    }
  }

  /* --- numerals fold into the style token string ---------------------------- */

  if (typeof intentRec.numerals === "string") {
    const token = intentRec.numerals;
    if (typeof intentRec.style !== "string") {
      intentRec.style = token;
    } else if (!intentRec.style.split(",").includes(token)) {
      intentRec.style = `${intentRec.style},${token}`;
    }
    delete intentRec.numerals;
  }

  /* --- final validation: the runtime drops invalid intent wholesale --------- */

  const parsed = VisualIntentSchema.safeParse(intentRec);
  if (parsed.success) {
    notes.push(
      `Compiled visual intent ${describeIntent(parsed.data as VisualIntent)} validated against the runtime's schema.`,
    );
  } else {
    // Never hand the build an intent the interpreter would discard entirely:
    // strip offending fields, keep the rest, say what happened.
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0]);
      delete intentRec[field];
      notes.push(`Intent field '${field}' failed the runtime schema (${issue.message}); stripped rather than invalidating the whole manner.`);
    }
    notes.push(
      "The remaining fields were built only from the typed decision vocabulary, so the interpreter will parse them leniently as intended.",
    );
  }

  return { intent: intentRec as VisualIntent, signals: selection.signals, selection, decisions, notes };
}

/** A one-line description of what an intent actually says. */
function describeIntent(intent: VisualIntent): string {
  const parts: string[] = [];
  if (intent.style !== undefined) parts.push(`style '${intent.style}'`);
  if (intent.composition !== undefined) parts.push(`composition '${intent.composition}'`);
  if (intent.density !== undefined) parts.push(`density '${intent.density}'`);
  if (intent.rhythm !== undefined) parts.push(`rhythm '${intent.rhythm}'`);
  if (intent.alignment !== undefined) parts.push(`alignment '${intent.alignment}'`);
  if (intent.contrast !== undefined) parts.push(`contrast '${intent.contrast}'`);
  if (intent.depth !== undefined) parts.push(`depth '${intent.depth}'`);
  if (intent.focal !== undefined) parts.push(`focal '${intent.focal}'`);
  return parts.length > 0 ? `(${parts.join(", ")}) ` : "(no fields) ";
}

/** `'visual-intent.density'` → the VisualIntent field name. */
function singleFieldKey(decisionKey: string): string {
  return decisionKey.replace("visual-intent.", "");
}

/* -------------------------------------------------------------------------- */
/* Review (post-plan)                                                          */
/* -------------------------------------------------------------------------- */

export interface VisualReview {
  /** Findings a review-time skill raised against the plan. */
  findings: SkillFinding[];
  /** Which checks ran and which were skipped, honestly. */
  notes: string[];
  /** The review-phase selection (with skip reasons). */
  selection: SkillSelection;
}

/**
 * Runs review-phase skills over a composition plan. The anti-generic skill
 * fires on region-heavy plans; a quiet plan passes with the checks recorded
 * in the notes rather than a fabricated zero-findings flourish.
 */
export function reviewVisualIntelligence(plan: CompositionPlan, brief: NormalizedBrief, registry: SkillRegistry = defaultSkillRegistry()): VisualReview {
  const signals: SkillSignal[] = [];
  if (plan.regions.length >= 3) signals.push("many-regions");
  if (plan.content.length >= 5) signals.push("content-inventory");
  const briefText = [brief.primaryDecision, brief.purpose, brief.product ?? ""].join(" ");
  if (/\boverview|\bdashboard|\bcard\w*\b/i.test(briefText)) signals.push("card-grid-risk");

  const fired = new Set(signals);
  const selected: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const entry of reviewPhaseEntries(registry)) {
    const applicable = entry.spec.signals.filter((s) => fired.has(s));
    if (applicable.length > 0) selected.push(entry.spec.id);
    else {
      skipped.push({
        id: entry.spec.id,
        reason: `No applicable signal at review: needs [${entry.spec.signals.join(", ")}]; the plan's ${plan.regions.length} region / ${plan.content.length} slot shape and brief text produce [${signals.join(", ") || "none"}].`,
      });
    }
  }
  // Compile-phase skills are not reviewers; recording that is part of being
  // explicit about what ran and what did not.
  for (const entry of compilePhaseEntries(registry)) {
    skipped.push({ id: entry.spec.id, reason: "Compile-phase skill: it decides before the plan exists, so it is not part of the review pass." });
  }

  const findings: SkillFinding[] = [];
  const notes: string[] = [];
  for (const id of selected) {
    const entry = registry.get(id);
    if (entry === undefined) continue;
    const output = entry.apply({ brief, plan });
    notes.push(...output.notes);
    if (output.findings !== undefined) findings.push(...output.findings);
  }

  /* The structural checks run in every case where the catalogue applies, so a
     'no findings' result is a checked result, not an unchecked one. */
  const { findings: directFindings, notes: directNotes } = reviewPlan(plan);
  if (selected.length === 0) notes.push(...directNotes);
  const allFindings = selected.length > 0 ? findings : directFindings;

  return { findings: allFindings, notes, selection: { signals, selected, skipped } };
}

/* -------------------------------------------------------------------------- */
/* Ledger passthrough                                                          */
/* -------------------------------------------------------------------------- */

/** The canonical-field consumer ledger, for reports and the contract test. */
export { intentFieldLedger, SKILL_SIGNALS, VisualIntentSchema };

/**
 * Converts one skill finding into the pipeline's finding shape so it can ride
 * the existing findings flow (trace + report) without a parallel finding type.
 */
export { toPipelineFinding } from "./anti-generic";
