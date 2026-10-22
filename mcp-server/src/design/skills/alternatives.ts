/**
 * Composition alternatives (issue #22, §3 — "Generate alternatives before committing").
 *
 * The blueprint engine in `../composition/candidates.ts` generates, scores and
 * chooses — but it was pinned by tests and bypassed by every live path: the
 * pipeline planned one composition and never asked whether a materially
 * different one would serve the brief better.
 *
 * This module is the bridge. It is *not* a planner: the planner stays the
 * composer of record, keeps its viability rules, and keeps every one of its
 * derivation paths. What this module does is:
 *
 *  1. propose ≥3 composition hypotheses that genuinely differ — each family is
 *     written against the six structural axes of §4.1, so two candidates can
 *     never be a colour swap;
 *  2. score them on the dimensions that have *brief evidence* — task fit by
 *     decision kind, hierarchy by the inventory shape, relationship clarity by
 *     whether relationships exist and the family can draw them, scanability by
 *     inventory size, design-system fit by the patterns the brief names. The
 *     dimensions score() does not measure default to the engine's neutral 5,
 *     because an unmeasured strength is not a strength;
 *  3. select with the shared engine (`selectComposition`), where a disqualified
 *     candidate cannot win on a good average;
 *  4. steer the plan *only within the planner's own rules*: the selected
 *     composition is handed over as the planner's existing
 *     `desiredComposition` hint, which the planner may refuse if the roles in
 *     play cannot support it. A caller's explicit desiredComposition is a hard
 *     constraint: the engine records how it ranked and never substitutes its
 *     own choice.
 */
import { classifyDecision } from "../../plan/planner";
import { classifyInfoItem } from "../composition/derive";
import { selectComposition, ensureCandidateMinimum, type CompositionHypothesis, type CompositionSelection, type ScoredCandidate, type CandidateDimension } from "../composition/candidates";
import type { Composition } from "../../runtime/layout";

/** The decision classifier's kind vocabulary — reused, not re-derived. */
type DecisionKind = ReturnType<typeof classifyDecision>;

/** The shared engine's task-category keys are a subset of the decision kinds. */
const KIND_TO_WEIGHTS: Record<DecisionKind, string> = {
  compare: "compare",
  topology: "topology",
  monitor: "monitor",
  configure: "configure",
  inspect: "inspect",
  select: "explore",
  explore: "explore",
  integration: "default",
  author: "default",
};

interface FamilyProfile {
  /** The hypothesis family is the planner composition it would produce. */
  family: Composition;
  /** §4.1 axis 1 — one statement per region role the family's IA carries. */
  informationArchitecture: string[];
  spatialArrangement: string;
  interactionPattern: string;
  emphasis: string;
  navigationModel: string;
  treatmentOfMainObject: string;
  /** Why this direction exists, written as an argument, not a label. */
  rationale: string;
  /** Decision kinds whose ranked affinity with this family is above neutral. */
  affinity: Partial<Record<DecisionKind, number>>;
  /** Whether the family draws relationships on a canvas rather than listing them. */
  relational: boolean;
  /** How the family carries a large inventory of items. */
  scanPattern: "columns" | "columns-rows" | "spaced-nodes" | "focused-read";
  /** Words in the brief's named patterns that argue for this family. */
  patternKey: RegExp;
}

const FAMILIES: FamilyProfile[] = [
  {
    family: "instrument",
    informationArchitecture: [
      "a live readout strip carries the state of the whole",
      "the working area carries the object of the decision",
      "a context column carries the detail the decision needs to cite",
    ],
    spatialArrangement: "a narrow band across the top, one dominant working area beneath it",
    interactionPattern: "glance at the readouts, act in the working area",
    emphasis: "the working area; the readout strip is chrome, never the object",
    navigationModel: "rails are chrome; the screen is the destination",
    treatmentOfMainObject: "rendered natively in the working area, not tiled",
    rationale: "an instrument keeps the state of the whole at eye level and the object under it, so intervention happens where the evidence is",
    affinity: { monitor: 9, topology: 6, inspect: 7, configure: 6 },
    relational: false,
    scanPattern: "columns-rows",
    patternKey: /\binstrument|strip|rail|gauge|readout\b/i,
  },
  {
    family: "topology",
    informationArchitecture: [
      "the relationships themselves are the content",
      "the nodes carry the labels that name what connects to what",
      "a supporting band carries the readouts the relationship explains",
    ],
    spatialArrangement: "a spatial field the nodes occupy, supporting context in a band beside it",
    interactionPattern: "select a node and follow its edges out",
    emphasis: "the field: the whole arrangement is the answer",
    navigationModel: "minimap or pan controls over the field",
    treatmentOfMainObject: "posed as nodes and edges, editable in place",
    rationale: "when how things connect is the decision, the connections must be drawn, not described in rows",
    affinity: { topology: 9, inspect: 8, author: 7, integration: 6 },
    relational: true,
    scanPattern: "spaced-nodes",
    patternKey: /\btopolog|graph|map\b/i,
  },
  {
    family: "table",
    informationArchitecture: [
      "every item is a row",
      "the columns carry the attributes being compared",
      "filters carry the narrowing before the rows are read",
    ],
    spatialArrangement: "a content area that packs rows down the page, filters above",
    interactionPattern: "scan, filter, then open one row",
    emphasis: "the rows, with the ranking order they are scanned in",
    navigationModel: "filters and facets above the table",
    treatmentOfMainObject: "each option is a row with its attributes in columns",
    rationale: "an inventory of comparable things reads fastest as rows, which is the shape a listing already has",
    affinity: { explore: 9, select: 8, integration: 7, inspect: 7 },
    relational: false,
    scanPattern: "columns-rows",
    patternKey: /\btable|list|listing|columns\b/i,
  },
  {
    family: "split-view",
    informationArchitecture: [
      "each compared thing holds one panel, equal to the other",
      "the differences between them carry their own space",
    ],
    spatialArrangement: "two equal panels with a shared comparison surface between or beneath them",
    interactionPattern: "read one side, then the other, differences highlighted",
    emphasis: "the differences — the only thing a comparison is actually for",
    navigationModel: "choices of what to put in each side, above",
    treatmentOfMainObject: "the two alternatives, held equally present",
    rationale: "comparing needs both things on screen at once and aligned, or the comparison collapses into memory",
    affinity: { compare: 9, select: 7, inspect: 8, configure: 7 },
    relational: false,
    scanPattern: "columns",
    patternKey: /\bsplit|side by side|compare|comparison\b/i,
  },
  {
    family: "spatial",
    informationArchitecture: [
      "the arrangement of things in the room carries part of the meaning",
      "the object being placed carries the focus",
      "docked controls carry the operations",
    ],
    spatialArrangement: "a free canvas with placed objects, controls docked at the edge",
    interactionPattern: "move, arrange, then commit the arrangement",
    emphasis: "the canvas and the object being placed",
    navigationModel: "pan/zoom over the canvas",
    treatmentOfMainObject: "a draggable, placeable object",
    rationale: "arranging or locating things is itself the task, so the composition has to be a place rather than a list",
    affinity: { topology: 8, explore: 8, author: 7 },
    relational: true,
    scanPattern: "spaced-nodes",
    patternKey: /\bspatial|canvas|place|arrange\b/i,
  },
  {
    family: "timeline",
    informationArchitecture: [
      "what happened carries its place in the order",
      "the order itself carries the meaning",
      "the moment under review carries the detail",
    ],
    spatialArrangement: "a horizontal band of events over a detail area beneath it",
    interactionPattern: "walk the sequence left to right, open one event",
    emphasis: "the band, and the moment under review inside it",
    navigationModel: "period controls above the band",
    treatmentOfMainObject: "events with their place in the sequence preserved",
    rationale: "a story over time must keep its order visible; a grid erases exactly what the brief is about",
    affinity: { inspect: 8, monitor: 7, author: 6 },
    relational: false,
    scanPattern: "columns-rows",
    patternKey: /\btimeline|history|stream|sequence|activity\b/i,
  },
  {
    family: "editorial",
    informationArchitecture: [
      "one argument leads, stated at a scale that claims the screen",
      "supporting material carries the evidence at a lower weight",
    ],
    spatialArrangement: "a dominant statement with supporting material in a narrow band below or beside it",
    interactionPattern: "read the headline answer first, then drill",
    emphasis: "the statement: the screen's first look *is* the answer",
    navigationModel: "few paths; the screen states one direction",
    treatmentOfMainObject: "the subject, shown at a scale that claims the screen",
    rationale: "when the brief has one thing to say, the composition must say it first — air, scale and a single focal region",
    affinity: { inspect: 7, select: 6, author: 6, monitor: 3, topology: 3, compare: 4, configure: 4, integration: 4, explore: 5 },
    relational: false,
    scanPattern: "focused-read",
    patternKey: /\beditorial|magazine|typographic|one thing\b/i,
  },
];

/* -------------------------------------------------------------------------- */
/* Evidence-based dimension scores                                             */
/* -------------------------------------------------------------------------- */

interface BriefFacts {
  relationshipItems: string[];
  items: string[];
  kind: DecisionKind;
  statedPatterns: string[];
  desired: Composition | undefined;
}

/**
 * Scores the dimensions the brief's own content can actually measure, and
 * records the arithmetic as the dimension's evidence. Dimensions with no
 * offline evidence are simply left out of `scores` — the shared engine then
 * gives them its neutral 5 and nothing pretends to have been measured.
 */
function evidenceScores(profile: FamilyProfile, facts: BriefFacts): Partial<Record<CandidateDimension, { score: number; evidence: string }>> {
  const out: Partial<Record<CandidateDimension, { score: number; evidence: string }>> = {};
  const items = facts.items.length;

  /* --- task fit: the family's ranked affinity for the classified decision --- */
  // The caller's own composition is honoured by the *selection* (preferredFamily),
  // never by inflating this score: a constraint the evidence argues against must
  // still hit the floors and be reported, not praised into eligibility.
  const affinity = profile.affinity[facts.kind] ?? 5;
  out.taskFit = {
    score: Math.min(10, affinity + (facts.relationshipItems.length > 0 && profile.relational ? 1 : 0)),
    evidence:
      facts.desired === profile.family
        ? "the caller states this composition — a hard constraint honoured in the selection regardless of this rank (issue #22 §3)."
        : `ranked affinity for the '${facts.kind}' decision class${facts.relationshipItems.length > 0 && profile.relational ? ", plus the brief's stated relationships that this family draws" : ""}.`,
  };
  if (facts.relationshipItems.length > 0 && profile.relational) {
    out.relationshipClarity = {
      score: 9,
      evidence: `${facts.relationshipItems.length} stated relationship item(s): '${facts.relationshipItems.slice(0, 3).join("', '")}' — drawn, not listed.`,
    };
  } else if (profile.relational) {
    out.relationshipClarity = {
      score: 4,
      evidence: "a relational field with nothing relational stated to put in it: the field becomes decoration.",
    };
  } // non-relational families leave relationship clarity unmeasured (neutral 5).

  /* --- hierarchy and scanability: the inventory's shape against the family --- */
  switch (profile.scanPattern) {
    case "columns-rows":
      out.informationHierarchy = {
        score: items >= 6 ? 9 : items >= 3 ? 7 : 4,
        evidence: `${items} information item(s) against a family that packs them into comparable columns and rows.`,
      };
      break;
    case "columns":
      out.informationHierarchy = {
        score: items >= 4 ? 8 : items >= 2 ? 7 : 4,
        evidence: `${items} information item(s) against a family that aligns fewer, taller columns.`,
      };
      break;
    case "spaced-nodes":
      out.informationHierarchy = {
        score: items <= 8 ? 8 : 5,
        evidence: `${items} information item(s) against a spatial field: dense past ~8 nodes, individual labels stop being readable in place.`,
      };
      break;
    case "focused-read":
      out.informationHierarchy = {
        score: items <= 5 ? 8 : 4,
        evidence: `${items} information item(s) against a single-focus read: past a handful, the focus is a claim, not a fact.`,
      };
      break;
  }
  out.densityScanability = {
    score:
      profile.scanPattern === "columns-rows"
        ? Math.min(9, 4 + Math.floor(items / 2))
        : profile.scanPattern === "columns"
          ? Math.min(9, 4 + Math.floor(items / 3))
          : profile.scanPattern === "spaced-nodes"
            ? (items <= 6 ? 8 : items <= 12 ? 6 : 3)
            : (items <= 5 ? 9 : items <= 8 ? 6 : 4),
    evidence: `how ${items} item(s) sit in this family: ${profile.scanPattern === "spaced-nodes" ? "spaced nodes need room per label" : profile.scanPattern === "focused-read" ? "a focused read needs few items to stay a read" : "rows/columns absorb inventory"}.`,
  };

  /* --- design-system fit: the patterns the brief itself names ---------------- */
  if (facts.statedPatterns.length > 0) {
    const matched = facts.statedPatterns.filter((p) => profile.patternKey.test(p));
    out.designSystemFit = {
      score: matched.length > 0 ? 9 : 4,
      evidence: matched.length > 0
        ? `the brief names existing patterns against this family: '${matched.slice(0, 3).join("', ")}'.`
        : "the brief's named patterns argue for a different family; reusing this one would fight the file.",
    };
  } // no named patterns: left unmeasured — file conventions are simply unknown offline.

  return out;
}

/* -------------------------------------------------------------------------- */
/* The candidates                                                              */
/* -------------------------------------------------------------------------- */

function hypothesesFor(facts: BriefFacts): CompositionHypothesis[] {
  const candidates: CompositionHypothesis[] = [];
  for (const profile of FAMILIES) {
    const dimScores = evidenceScores(profile, facts);
    const scores: Partial<Record<CandidateDimension, number>> = {};
    const evidence: string[] = [];
    for (const [dimension, measured] of Object.entries(dimScores)) {
      if (measured === undefined) continue;
      scores[dimension as CandidateDimension] = measured.score;
      evidence.push(`${dimension}: ${measured.score} — ${measured.evidence}`);
    }
    candidates.push({
      id: `family:${profile.family}`,
      family: profile.family,
      informationArchitecture: profile.informationArchitecture,
      spatialArrangement: profile.spatialArrangement,
      interactionPattern: profile.interactionPattern,
      emphasis: profile.emphasis,
      navigationModel: profile.navigationModel,
      treatmentOfMainObject: profile.treatmentOfMainObject,
      rationale: `${profile.rationale} (${facts.kind} decision, ${facts.items} item(s)). ${evidence.join(" ")}`,
      scores,
    });
  }
  return candidates;
}

export interface CompositionAlternativesRecord {
  /** The classified decision the alternatives were scored for. */
  taskKind: DecisionKind;
  /** The key the shared engine's weights were looked up under. */
  taskCategoryForWeights: string;
  /** The weighted-lift for decision kinds the weight table names differently. */
  weightMappingNote: string | null;
  /** Every hypothesis, already scored, ranked as the engine ranked them. */
  considered: ScoredCandidate[];
  selection: CompositionSelection;
  /** The winner's family, or null when nothing cleared the floors. */
  selectedFamily: string | null;
  /** How the caller's own composition fared, when they stated one. */
  userOverride: { stated: string; honored: boolean; note: string } | null;
  /**
   * The composition handed to the planner as its `desiredComposition` hint —
   * only when steering is legitimate (no caller constraint, floors cleared,
   * the set genuinely distinct). `null` means the planner decides freely.
   */
  steeredComposition: Composition | null;
  /** Every claim this record makes, in order, for the trace. */
  provenance: string[];
}

export interface AlternativesInput {
  primaryDecision: string;
  requiredInformation?: string[];
  optionalInformation?: string[];
  desiredComposition?: string;
  existingPatterns?: string[];
}

/**
 * Proposes, scores and selects composition alternatives for one brief.
 * Deterministic: the same brief always produces the same ranking, the same
 * reasons and the same steering decision.
 */
export function resolveCompositionAlternatives(input: AlternativesInput): CompositionAlternativesRecord {
  const kind = classifyDecision(input.primaryDecision);
  const items = [...(input.requiredInformation ?? []), ...(input.optionalInformation ?? [])];
  const relationshipItems = items.filter((i) => classifyInfoItem(i) === "relationship");
  const desired = input.desiredComposition as Composition | undefined;
  const facts: BriefFacts = {
    relationshipItems,
    items,
    kind,
    statedPatterns: input.existingPatterns ?? [],
    desired,
  };

  const candidates = hypothesesFor(facts);
  // §4.1: pairwise structural distinctness is a property of the authored
  // vocabulary; audited (and topped up if a future edit breaks it) rather than
  // assumed.
  const topped = ensureCandidateMinimum(candidates, []);
  const selection = selectComposition(topped.candidates, {
    taskCategory: KIND_TO_WEIGHTS[kind],
    ...(desired !== undefined ? { preferredFamily: desired } : {}),
  });

  const provenance: string[] = [];
  const taskCategory = KIND_TO_WEIGHTS[kind];
  const weightNote =
    KIND_TO_WEIGHTS[kind] === kind
      ? null
      : `The '${kind}' decision class has no weight table of its own; the '${KIND_TO_WEIGHTS[kind]}' table is the nearest by task shape (nearest-neighbour mapping, recorded so the scores are auditable).`;

  provenance.push(
    `${candidates.length} composition hypotheses proposed across ${FAMILIES.length} families — each pair differs on at least one structural axis of §4.1 (audited: ${selection.audit.distinct ? "distinct" : `NON-DISTINCT: ${selection.audit.warnings.join("; ")}`}).`,
  );
  provenance.push(weightNote ?? "Task-category weights from the shared table, keyed directly by the decision class.");
  if (desired !== undefined) {
    const preferred = selection.considered.find((s) => s.candidate.family === desired);
    if (preferred === undefined) {
      provenance.push(`The caller stated desiredComposition '${desired}', which is not one of the families scored this pass; the planner remains bound by it, the engine simply did not audit it.`);
      provenance.push(`Selection (outside the caller's constraint) ranked: ${selection.reason}`);
    } else if (selection.selected?.candidate.family === desired) {
      provenance.push(`The caller's stated composition '${desired}' ranked ${selection.considered.indexOf(preferred) + 1} of ${selection.considered.length} on the engine's evidence and stays in force: a stated composition is a hard constraint, not a suggestion (issue #22 §3).`);
    } else if (preferred.disqualifiedBy.length > 0) {
      provenance.push(`The caller's stated composition '${desired}' did not clear the engine's dimension floors (${preferred.disqualifiedBy.join(", ")}); nothing was forced — this needs a human call, since a caller constraint the evidence argues against is a contradiction worth one question.`);
    } else {
      provenance.push(`The caller's stated composition '${desired}' was honoured as a hard constraint without re-ranking the set.`);
    }
  } else if (selection.selected !== null) {
    provenance.push(`Selected '${selection.selected.candidate.family}' (${selection.selected.total}/100) over ${selection.rejected.length} alternative(s); ${selection.tradeoffs[0] ?? "no runner-up worth noting"}.`);
  } else {
    provenance.push(`No candidate cleared the dimension floors (${selection.reason}); nothing was steered and the planner decides with full freedom.`);
  }
  if (selection.insufficientAlternatives) {
    provenance.push("The set fell short of the engine's minimum: flagged rather than silently shipped.");
  }

  /* --- the steering decision ------------------------------------------------ */

  let userOverride: CompositionAlternativesRecord["userOverride"] = null;
  if (desired !== undefined) {
    const preferred = selection.considered.find((s) => s.candidate.family === desired);
    const rankedFirst = selection.considered[0]?.candidate.family === desired;
    userOverride = {
      stated: desired,
      honored: preferred !== undefined && preferred.disqualifiedBy.length === 0,
      note:
        preferred === undefined
          ? "the caller's composition is outside the audited vocabulary; the engine recorded nothing against it"
          : preferred.disqualifiedBy.length > 0
            ? `did not clear the floors (${preferred.disqualifiedBy.join(", ")}) — reconcile before building`
            : rankedFirst
              ? "the caller's composition also ranked first on the engine's evidence"
              : `the caller's constraint was honoured although '${selection.considered[0]?.candidate.family ?? "another family"}' ranked higher on offline evidence`,
    };
  }

  const steer =
    desired === undefined &&
    items.length >= 3 &&
    selection.selected !== null &&
    selection.audit.distinct &&
    !selection.insufficientAlternatives
      ? (selection.selected.candidate.family as Composition)
      : null;
  if (desired === undefined) {
    provenance.push(
      steer !== null
        ? `Steering: the planner receives '${steer}' as its desiredComposition hint, under its own viability rules — the planner may still conclude the roles in play cannot support it.`
        : items.length < 3
          ? `Steering: none — the brief's inventory (${items.length} item(s)) is below the engine's evidentiary floor of 3 items; the planner composes.`
          : "Steering: none — the planner composes freely.",
    );
  }

  return {
    taskKind: kind,
    taskCategoryForWeights: taskCategory,
    weightMappingNote: weightNote,
    considered: selection.considered,
    selection,
    selectedFamily: selection.selected?.candidate.family ?? null,
    userOverride,
    steeredComposition: steer,
    provenance,
  };
}
