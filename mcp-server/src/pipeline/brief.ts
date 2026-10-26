/**
 * Stage 1 — normalize the brief (issue #16, §Stage 1).
 *
 * ## What this does and why it is not a formality
 *
 * The pipeline's first job is to separate three things that look identical in a
 * chat message:
 *
 *   1. what the user **stated** (a requirement),
 *   2. what the pipeline **inferred** (an assumption),
 *   3. what the brief **contradicts** (a blocker that must be resolved before a
 *      single node is created).
 *
 * A screen built from a guess that reads like a requirement is the failure mode
 * this stage exists to prevent, and so is a screen built from a brief that
 * cannot be satisfied at all — the "put the content at the origin and carry on"
 * behaviour that makes a broken screen look finished.
 *
 * Everything here is pure: no session, no Figma, no network. A brief that
 * cannot be normalized is rejected *before* the plan, and the plan is rejected
 * before the apply.
 */
import type {
  Assumption,
  BriefBlocker,
  BriefInput,
  Clarification,
  NormalizedBrief,
} from "./contracts";

/** The viewport used when the caller names none. */
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;

/** The smallest canvas that can hold a composed screen at all. */
export const MIN_VIEWPORT = { width: 320, height: 400 } as const;

/**
 * Direction keywords, used to catch an anti-goal that contradicts the stated
 * direction.
 *
 * The check is deliberately narrow: it only fires when the anti-goal names the
 * *opposite* of a word the direction requires. A loose keyword match would
 * block briefs for the wrong reason, and a brief that is blocked for the wrong
 * reason is worse than one that is not blocked.
 */
const OPPOSITES: Array<{ key: string; wants: RegExp; forbids: RegExp }> = [
  { key: "dark", wants: /\bdark\b|\binverted\b|\bnight\b/, forbids: /\bno dark\b|\bnot dark\b|\bavoid dark\b|\blight only\b/ },
  { key: "light", wants: /\blight\b|\bdaylight\b|\bbright\b/, forbids: /\bno light\b|\bnot light\b|\bavoid light\b/ },
  { key: "dense", wants: /\bdense\b|\bcompact\b|\btight\b/, forbids: /\bno dense\b|\bnot dense\b|\bavoid dense\b|\bairy\b|\bspacious\b/ },
  { key: "airy", wants: /\bairy\b|\bspacious\b|\broomy\b|\bcalm\b/, forbids: /\bno airy\b|\bnot airy\b|\bavoid airy\b|\bdense\b/ },
  { key: "monochrome", wants: /\bmonochrome\b|\bgreyscale\b|\bblack and white\b/, forbids: /\bno monochrome\b|\bnot monochrome\b|\bavoid monochrome\b/ },
  { key: "colorful", wants: /\bcolorful\b|\bcolourful\b|\bvivid\b/, forbids: /\bno color\b|\bnot color\b|\bavoid color\b|\bmonochrome\b/ },
];

function uniq(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter((s) => s.length > 0))];
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Normalizes a brief.
 *
 * Returns the brief, the assumptions it rests on, the questions worth asking
 * and the contradictions that must be resolved first. Blocking contradictions
 * mean the caller must not build.
 */
export function normalizeBrief(input: BriefInput, id = "brief"): {
  brief: NormalizedBrief;
  assumptions: Assumption[];
  clarifications: Clarification[];
  blockers: BriefBlocker[];
} {
  const assumptions: Assumption[] = [];
  const clarifications: Clarification[] = [];
  const blockers: BriefBlocker[] = [];

  const required = uniq(input.requiredInformation ?? []);
  const optional = uniq(input.optionalInformation ?? []);
  const stated = uniq(input.availableInformation ?? []);
  const purpose = input.purpose?.trim() ?? "";
  const decision = input.primaryDecision?.trim() ?? "";
  const screen = input.screen?.trim() ?? "";

  /* --- the task ---------------------------------------------------------- */

  if (!purpose && !decision) {
    blockers.push({
      id: "no-task",
      severity: "blocking",
      message: "The brief names no task: neither a purpose nor a primary decision.",
      why: "A screen without a task is a page, and pages are what turn into generic dashboards. Everything downstream — the regions, the hierarchy, what counts as a defect — is derived from the task.",
      fix: "State what the user is trying to do on this screen (purpose) or what they decide here (primaryDecision).",
    });
  }

  if (!screen) {
    clarifications.push({
      id: "screen-name",
      question: "What should this screen be called?",
      why: "The name becomes the frame name in Figma and the id in the trace. A placeholder name makes the build impossible to find later.",
      blocking: false,
    });
    assumptions.push({
      id: "assume-screen-name",
      statement: "The screen is named after its primary decision.",
      source: "inferred",
      why: "No name was given, so the decision phrase is the least surprising name and keeps the frame findable.",
    });
  }

  if (!purpose && decision) {
    assumptions.push({
      id: "assume-purpose",
      statement: `The purpose of the screen is '${decision}'.`,
      source: "inferred",
      why: "Only a decision was stated. The purpose is recorded as an inference so it is never mistaken for something the user confirmed.",
    });
  }

  /* --- information ------------------------------------------------------- */

  const both = required.filter((r) => optional.some((o) => normalise(o) === normalise(r)));
  if (both.length > 0) {
    blockers.push({
      id: "information-conflict",
      severity: "blocking",
      message: `The same information is listed as both required and optional: ${both.join(", ")}.`,
      why: "Required information is placed in the primary area and optional information is supporting. An item in both has no position, and the planner would silently pick one.",
      fix: "Decide for each item whether it is required or optional, and list it in exactly one.",
    });
  }

  if (required.length === 0 && optional.length === 0) {
    clarifications.push({
      id: "no-information",
      question: "What data does this screen show?",
      why: "Without named information the planner falls back to a generic shell, which is the shape the product rules forbid.",
      blocking: false,
    });
    assumptions.push({
      id: "assume-no-data",
      statement: "The screen carries no data rows; it is a structural screen.",
      source: "inferred",
      why: "No information was named, so the composition is derived from the task alone.",
    });
  }

  /* --- data mode --------------------------------------------------------- */

  const dataMode = input.dataMode ?? "unknown";
  const dataNotes = input.dataNotes?.trim() || null;
  if (dataMode === "unknown" && (required.length > 0 || optional.length > 0)) {
    assumptions.push({
      id: "assume-illustrative-data",
      statement: "Values on this screen are illustrative, not live telemetry.",
      source: "inferred",
      why: "The brief did not say the data is live, and fabricating live-looking telemetry is forbidden. Values are placeholders and the report says so.",
    });
  }
  if (dataMode === "live" && dataNotes !== null && /\b(sample|demo|mock|placeholder|illustrative|fake)\b/i.test(dataNotes)) {
    blockers.push({
      id: "data-mode-conflict",
      severity: "blocking",
      message: "The brief says the data is live, but the data notes describe it as sample/demo data.",
      why: "A screen that presents demo numbers as live readings is worse than a screen that admits it is a mock: the user cannot tell which one they are looking at.",
      fix: "Set dataMode to 'demo' if the values are illustrative, or remove the sample wording from the notes if they really are live.",
    });
  }
  if (dataMode === "live" && dataNotes === null) {
    clarifications.push({
      id: "live-data-source",
      question: "Which live source do these values come from (service, environment, time range)?",
      why: "The screen can say where the numbers are from, or not. The pipeline will not invent a source.",
      blocking: false,
    });
  }

  /* --- clean-concept and on-screen disclosure requests (issue #23 §4) ----- */

  // Production screens are clean by default: the pipeline does not paint a
  // provenance caption unless the caller asks for one explicitly. The ask is
  // recorded with provenance like every stated fact — a caption that appeared
  // on its own would be the pipeline deciding the screen looked more honest
  // with a caveat on it, the exact trade this flag keeps out of its own
  // hands. cleanConcept stays the explicit no-caption-ever request and wins
  // when both are set (a contradiction resolves toward the cleaner screen;
  // the report records the data mode either way).
  const cleanConcept = input.cleanConcept === true;
  const onScreenDisclosure = input.onScreenDisclosure === true && !cleanConcept;
  if (onScreenDisclosure) {
    assumptions.push({
      id: "assume-on-screen-disclosure",
      statement: "An on-screen disclosure was explicitly requested: one concise caption may qualify the illustrative values.",
      source: "stated",
      why: "The caller asked for the data caveat on the screen itself. Fabricating live-looking telemetry stays forbidden; an invented capability is still a product-truth failure.",
    });
  }
  if (cleanConcept) {
    assumptions.push({
      id: "assume-clean-concept",
      statement: "Clean visual exploration was requested: no on-screen sample-data disclosure. The report alone records that the values are illustrative.",
      source: "stated",
      why: "The caller explicitly asked for a clean concept, so the screen carries no caveat copy while the report keeps the truthful data mode. Fabricating live-looking telemetry stays forbidden; an invented capability is still a product-truth failure.",
    });
  }

  /* --- viewport ---------------------------------------------------------- */

  const viewport = input.viewport ?? { ...DEFAULT_VIEWPORT };
  if (!input.viewport) {
    assumptions.push({
      id: "assume-viewport",
      statement: `The screen is designed for a ${viewport.width}x${viewport.height} viewport.`,
      source: "inferred",
      why: "No viewport was stated, so the product's default desktop canvas is used and recorded rather than guessed silently.",
    });
  }
  if (viewport.width < MIN_VIEWPORT.width || viewport.height < MIN_VIEWPORT.height) {
    blockers.push({
      id: "viewport-too-small",
      severity: "blocking",
      message: `A ${viewport.width}x${viewport.height} viewport is smaller than the ${MIN_VIEWPORT.width}x${MIN_VIEWPORT.height} minimum a composed screen needs.`,
      why: "Below that size there is no room for a header, a primary area and a supporting area, and the planner would place regions on top of each other.",
      fix: "Name a larger viewport, or state that this screen is a single-purpose mobile view with only one region.",
    });
  }

  for (const r of input.responsive ?? []) {
    if (r.width < MIN_VIEWPORT.width || r.height < MIN_VIEWPORT.height) {
      blockers.push({
        id: "responsive-too-small",
        severity: "blocking",
        message: `The responsive target '${r.name}' (${r.width}x${r.height}) is below the ${MIN_VIEWPORT.width}x${MIN_VIEWPORT.height} minimum.`,
        why: "A viewport that cannot hold the screen's own minimum regions cannot hold a stacked version of it either.",
        fix: "Remove the target or raise its size to the product's real minimum.",
      });
    }
  }
  const responsiveNames = (input.responsive ?? []).map((r) => normalise(r.name));
  if (new Set(responsiveNames).size !== responsiveNames.length) {
    blockers.push({
      id: "responsive-duplicate",
      severity: "blocking",
      message: "Two responsive targets have the same name.",
      why: "The names are how the report refers to a target; duplicates make the responsive behaviour unmeasurable.",
      fix: "Give each target a distinct name.",
    });
  }

  /* --- actions ----------------------------------------------------------- */

  const primaryAction = input.primaryAction?.trim() || null;
  const secondaryActions = uniq(input.secondaryActions ?? []);
  if (primaryAction !== null && secondaryActions.some((a) => normalise(a) === normalise(primaryAction))) {
    blockers.push({
      id: "action-conflict",
      severity: "blocking",
      message: `'${primaryAction}' is listed as both the primary action and a secondary action.`,
      why: "The primary action is what the screen is for; if it is also secondary, the screen has no single job and the hierarchy below it is arbitrary.",
      fix: "Keep the action in exactly one of the two lists.",
    });
  }
  if (primaryAction === null) {
    clarifications.push({
      id: "no-primary-action",
      question: "What is the one action this screen exists to make possible?",
      why: "A screen without a primary action cannot be checked: there is no way to tell whether the composition serves it.",
      blocking: false,
    });
  }

  /* --- scope ------------------------------------------------------------- */

  const scope = {
    create: uniq(input.scope?.create ?? []),
    edit: uniq(input.scope?.edit ?? []),
    leaveUntouched: uniq(input.scope?.leaveUntouched ?? []),
  };
  const overlap = scope.edit.filter((e) => scope.leaveUntouched.some((u) => normalise(u) === normalise(e)));
  if (overlap.length > 0) {
    blockers.push({
      id: "scope-conflict",
      severity: "blocking",
      message: `The scope allows editing and requires leaving untouched: ${overlap.join(", ")}.`,
      why: "A node that is both editable and untouchable has no defined treatment, and the pipeline would have to pick one silently.",
      fix: "Remove the node from one of the two lists.",
    });
  }
  if (scope.create.length === 0 && scope.edit.length === 0) {
    clarifications.push({
      id: "scope-unstated",
      question: "May the pipeline create new frames, or only edit what already exists?",
      why: "Creating is the default for a new screen; editing is the default for a refinement. Guessing wrong touches the wrong part of the file.",
      blocking: false,
    });
  }

  /* --- direction and anti-goals ------------------------------------------ */

  const visualDirection = input.visualDirection?.trim() || null;
  const antiGoals = uniq(input.antiGoals ?? []);
  if (visualDirection !== null) {
    for (const rule of OPPOSITES) {
      const wants = rule.wants.test(normalise(visualDirection));
      const forbids = antiGoals.some((a) => rule.forbids.test(normalise(a)));
      if (wants && forbids) {
        blockers.push({
          id: `direction-conflict-${rule.key}`,
          severity: "blocking",
          message: `The visual direction ('${visualDirection}') requires a ${rule.key} treatment, but an anti-goal forbids it.`,
          why: "The direction and the anti-goal cannot both be honoured, so one of them would be silently ignored — and the one that gets ignored is whichever the renderer happened to apply last.",
          fix: `Drop the anti-goal that forbids ${rule.key}, or change the direction.`,
        });
      }
    }
  }
  if (antiGoals.length === 0) {
    assumptions.push({
      id: "assume-default-anti-goals",
      statement: "The screen avoids generic SaaS card walls and equal-weight panels.",
      source: "inferred",
      why: "No anti-goals were given, so the product's standing rules are applied and recorded rather than assumed silently.",
    });
  }

  /* --- references -------------------------------------------------------- */

  const references = {
    observations: uniq(input.references?.observations ?? []),
    assumptions: uniq(input.references?.assumptions ?? []),
  };
  if (references.observations.length === 0 && references.assumptions.length === 0) {
    clarifications.push({
      id: "no-reference",
      question: "Is there a reference image or an existing screen this one should match?",
      why: "Without one the pipeline works from the brief alone, and the brief may be missing the visual truth the user has in mind.",
      blocking: false,
    });
  }
  for (const a of references.assumptions) {
    assumptions.push({
      id: `reference-assumption-${assumptions.length + 1}`,
      statement: a,
      source: "inferred",
      why: "Recorded as an inference from a reference, not as a stated requirement.",
    });
  }

  /* --- what the user stated, kept verbatim ------------------------------- */

  for (const item of stated) {
    assumptions.push({
      id: `stated-${item.slice(0, 24).replace(/\W+/g, "-")}`,
      statement: item,
      source: "stated",
      why: "Provided by the caller as available information.",
    });
  }

  const brief: NormalizedBrief = {
    id,
    product: input.product?.trim() || null,
    profile: input.profile?.trim() || null,
    screen: screen || decision || "Untitled screen",
    purpose: purpose || decision,
    primaryDecision: decision || purpose,
    primaryAction,
    secondaryActions,
    requiredInformation: required,
    optionalInformation: optional,
    values: { ...(input.values ?? {}) },
    data: {
      mode: dataMode,
      notes: dataNotes,
      illustrative: dataMode !== "live",
    },
    // Recorded as an assumption when stated (issue #23 §4), so the report
    // names who asked for a caveat-free screen or for the one caption.
    cleanConcept,
    onScreenDisclosure,
    interactions: input.interactions ?? [],
    viewport,
    responsive: input.responsive ?? [],
    designSystemConstraints: uniq(input.designSystemConstraints ?? []),
    references,
    visualDirection,
    antiGoals,
    states: uniq(input.states ?? []),
    scope,
    existingPatterns: uniq(input.existingPatterns ?? []),
    audience: input.audience ?? "general",
    archetype: input.archetype?.trim() || null,
    desiredComposition: input.desiredComposition,
  };

  return { brief, assumptions, clarifications, blockers };
}
