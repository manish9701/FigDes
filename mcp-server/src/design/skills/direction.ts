/**
 * Skill: brief interpretation and art direction (issue #22, skill A).
 *
 * ## What it does
 *
 * Reads the brief's free-worded visual direction and produces observable
 * visual decisions: which style tokens to carry, what "premium" or "minimal"
 * means in spacing, surface and type terms, and — critically — which
 * adjectives it could not translate. An untranslated word is a visible gap,
 * not a silent drop: the note names it so the caller can rephrase or accept
 * the default taste deliberately.
 *
 * ## Honest boundary
 *
 * A dictionary of eight carefully-chosen words is deliberately conservative.
 * Manner words outside the table map to no tokens at all rather than guessed
 * at, and are recorded — the compiled intent says only what was actually
 * derived, and the notes name every word left unapplied.
 */
import type { SkillDecision, SkillEntry, SkillOutput, SkillSpec } from "./contracts";
import type { NormalizedBrief } from "../../pipeline/contracts";
import { resolveStyleTokens } from "../../runtime/visual-presets";
import { detectCompositionDescriptors, type CompositionDescriptor } from "./composition";

interface AdjectiveMapping {
  /** Style tokens: named presets, accordion words or bare directives. */
  tokens: string[];
  /** The observable decisions the word commits to. */
  decisions: Array<{ dimension: SkillDecision["dimension"]; key: string; value: string }>;
  /**
   * Canonical visual-intent contributions: fields the compiler assigns
   * directly. Emitted as `visual-intent.*` decisions only when the word's
   * tokens survive the contradiction check, so manner and tokens never
   * disagree with each other.
   */
  intent?: {
    rhythm?: "generous" | "tight";
    contrast?: "muted" | "restrained" | "bold";
    depth?: "flat" | "subtle" | "layered";
  };
}

/* Intent contributions per word. Kept next to the tokens so a word's surface
   claim and its compiled intent can never be edited apart. */
const INTENT_CONTRIBUTIONS: Record<string, { rhythm?: "generous" | "tight"; contrast?: "muted" | "restrained" | "bold"; depth?: "flat" | "subtle" | "layered" }> = {
  premium: { rhythm: "generous", contrast: "restrained", depth: "subtle" },
  minimal: { depth: "flat" },
  editorial: { rhythm: "generous", depth: "subtle" },
  technical: { depth: "subtle" },
  instrument: { contrast: "muted", depth: "flat" },
  playful: { depth: "flat" },
  calm: { depth: "flat" },
  dense: { depth: "flat" },
};

/**
 * The adjective dictionary. Every token must be a preset, accordion word or
 * bare directive the runtime resolves — the compiler re-checks the compiled
 * string with `resolveStyleTokens`, which is what makes a typo here a visible
 * note instead of a silently ignored style.
 */
const ADJECTIVES: Record<string, AdjectiveMapping> = {
  premium: {
    tokens: ["generous", "restrained", "open", "tabular"],
    decisions: [
      { dimension: "spacing", key: "rhythm", value: "generous: whitespace opens up before content is added, not after" },
      { dimension: "color", key: "accents", value: "restrained: at most two accent colours, no decorative gradients" },
      { dimension: "components", key: "surfaces", value: "open surfaces; hierarchy comes from type and spacing, not borders" },
    ],
  },
  minimal: {
    tokens: ["minimal"],
    decisions: [
      { dimension: "components", key: "surfaces", value: "borderless and open; no decorative borders, gradients or shadows" },
      { dimension: "typography", key: "voice", value: "quiet; whitespace and scale carry hierarchy instead of boxes" },
    ],
  },
  editorial: {
    tokens: ["editorial", "generous"],
    decisions: [
      { dimension: "typography", key: "voice", value: "editorial: headlines carry the decision, readouts support it" },
      { dimension: "composition", key: "focal", value: "one headline as the screen's entry point" },
    ],
  },
  technical: {
    tokens: ["calm-technical", "tabular"],
    decisions: [
      { dimension: "typography", key: "numbers", value: "tabular numerals for any value that updates" },
      { dimension: "spacing", key: "grid", value: "disciplined 8px rhythm; alignment is deliberate, not accidental" },
    ],
  },
  instrument: {
    tokens: ["instrument"],
    decisions: [
      { dimension: "density", key: "value", value: "dense" },
      { dimension: "typography", key: "numbers", value: "mono-first: the values are the content" },
      { dimension: "composition", key: "strategy", value: "grid-aligned readouts; chrome disappears so the data is visible" },
    ],
  },
  playful: {
    tokens: ["gallery-warm"],
    decisions: [
      { dimension: "color", key: "temperature", value: "warm; colour carries the mood with at most two accents" },
      { dimension: "components", key: "shape", value: "organic and soft; nothing visually aggressive" },
    ],
  },
  calm: {
    tokens: ["calm"],
    decisions: [{ dimension: "density", key: "value", value: "calm" }],
  },
  dense: {
    tokens: ["dense"],
    decisions: [{ dimension: "density", key: "value", value: "dense" }],
  },
};

/**
 * Exposes the vocabulary for validation and tests: word → tokens. The contract
 * test asserts every token in every word resolves cleanly, so the dictionary
 * cannot name a token the runtime does not know.
 */
export function directionVocabulary(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [word, mapping] of Object.entries(ADJECTIVES)) out[word] = mapping.tokens;
  return out;
}

/** The exact phrase the runtime emits when two style tokens contradict. */
const CONTRADICTION_MARK = "opposite directions";

/** Negation words: the next manner word is excluded rather than applied. */
const NEGATORS = new Set(["not", "no", "without", "never", "anti", "non"]);

/** Splits the brief's visual direction into normalised words. */
function directionWords(direction: string): string[] {
  return direction
    .toLowerCase()
    .split(/[\s,/+-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);
}

/**
 * Composition descriptors (issue #24, item 3) belong to the composition
 * strategy skill's closed vocabulary, not to manner tokens. This removes them
 * from the word stream so their hyphenated fragments never surface as
 * untranslated manner words, and returns what it found so the hand-off is
 * named instead of a silent drop. A negated descriptor ('not asymmetric') is
 * returned as excluded rather than handed over.
 */
function stripCompositionDescriptors(direction: string): {
  text: string;
  handed: CompositionDescriptor[];
  excluded: CompositionDescriptor[];
} {
  const facts = detectCompositionDescriptors(direction);
  let text = direction;
  for (const descriptor of [...facts.applied, ...facts.excluded]) {
    const phrase = descriptor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![a-zA-Z\\-])${phrase}(?![a-zA-Z\\-])`, "gi"), " ");
  }
  return { text, handed: facts.applied, excluded: facts.excluded };
}

/** Pairs of direction *words* (not tokens) that pull against each other. */
const TENSION_WORDS: Array<{ left: string[]; right: string[] }> = [
  { left: ["premium", "generous"], right: ["dense", "crowded"] },
  { left: ["minimal", "airy"], right: ["dense", "instrument", "compact"] },
  { left: ["playful", "warm"], right: ["brutal", "raw"] },
];

const SPEC: SkillSpec = {
  id: "brief-art-direction",
  version: "v2",
  name: "Brief interpretation and art direction",
  purpose:
    "Turns the brief's manner words into observable style decisions, separates hard constraints from preferences, and carries one direction through generation so the critique can check against it later.",
  signals: ["stated-direction", "design-system-context"],
  whenToUse: "The brief words a visual manner, or names design-system constraints the output must respect.",
  whenNotToUse:
    "No manner and no constraints are stated: the runtime's curated default direction (inferArtDirection) already covers the manner.",
  expectedOutput:
    "A validated style-token string for visualIntent.style, per-dimension decisions for direction words, untranslated words surfaced in notes, and tension findings for contradicting manners.",
  requiredInputs: ["brief.visual-direction"],
  optionalContext: ["brief.design-system-constraints", "brief.anti-goals", "brief.states"],
  decisionRules: [
    {
      id: "hard-vs-preferred",
      dimension: "composition",
      rule:
        "Design-system constraints, states and anti-goals are hard constraints; manner words are preferences that shape the output but never override the task.",
      why: "An anti-goal is a requirement worded negatively; a manner word is a taste the caller may trade for a better screen.",
    },
    {
      id: "translate-or-record",
      dimension: "typography",
      rule:
        "Each manner word either maps to concrete tokens and decisions, or is recorded untranslated; words never disappear without saying so.",
      why: "A silently ignored adjective is an unexplained difference between what the caller asked for and what the screen shows.",
    },
    {
      id: "one-direction",
      dimension: "composition",
      rule:
        "All token decisions compile to a single coherent style string; a later word contradicting the tokens so far is dropped with a note before the build.",
      why: "The runtime drops ALL style on a contradiction, so a contradiction that reaches the build becomes default taste.",
    },
    {
      id: "carry-through",
      dimension: "hierarchy",
      rule:
        "The compiled tokens ride with the decision trail so later critique passes can ask whether the render still looks like the chosen direction.",
      why: "The direction must be written down where a reviewer can find it; a direction nobody records cannot be preserved.",
    },
  ],
  outputs: [
    {
      field: "style-tokens",
      description: "Validated style tokens compiled into visualIntent.style.",
      consumedBy: ["design/skills/intent-compiler.ts (style)", "shared/ir.ts VisualIntentSchema.style"],
    },
    {
      field: "tension-and-translation-notes",
      description: "Word tensions and untranslated words, visible instead of silently resolved.",
      consumedBy: ["design/skills/intent-compiler.ts (notes)", "pipeline/tools.ts (response payload)"],
    },
    {
      field: "hard-constraints",
      description: "Design-system constraints, anti-goals and states restated as hard-constraint decisions.",
      consumedBy: ["design/skills/intent-compiler.ts (decision trail)", "pipeline/report.ts (trace stages)"],
    },
  ],
  qualityChecks: [
    {
      id: "every-word-accounted",
      dimension: "composition",
      criterion:
        "Every word of the direction is either reflected in compiled tokens or named untranslated in the notes.",
    },
    {
      id: "no-created-contradictions",
      dimension: "color",
      criterion:
        "The compiled token string resolves without a contradiction warning from the runtime resolver that would discard the whole style.",
    },
    {
      id: "hard-constraints-exhaustive",
      dimension: "accessibility",
      criterion: "Design-system constraints, anti-goals and states appear verbatim in hard-flagged decisions.",
    },
  ],
  examples: [
    {
      summary: "'Premium fintech overview' compiles to generous rhythm and two restrained accents",
      why: "'premium' produces observable decisions (generous, restrained, open, tabular) instead of gradients everywhere.",
    },
  ],
  counterexamples: [
    {
      summary: "'Minimal dense premium' drops the premium tokens with a tension note",
      why: "A word contradiction surfaces where a caller can read it, instead of the runtime discarding everything at build time.",
    },
  ],
  fixtures: ["issue-22-premium-direction"],
};

export const briefArtDirection: SkillEntry = {
  spec: SPEC,

  apply({ brief }: { brief: NormalizedBrief }): SkillOutput {
    const decisions: SkillDecision[] = [];
    const notes: string[] = [];

    /* --- hard constraints: stated negatively or as system rules ------------- */

    for (const constraint of brief.designSystemConstraints) {
      decisions.push({
        skill: SPEC.id,
        dimension: "components",
        key: `design-system: ${constraint}`,
        value: "honoured",
        why: "Stated as a design-system constraint, which is a hard constraint.",
        hard: true,
      });
    }
    for (const anti of brief.antiGoals) {
      decisions.push({
        skill: SPEC.id,
        dimension: "composition",
        key: `anti-goal: ${anti}`,
        value: "avoided",
        why: "Stated as an anti-goal; treated as a hard constraint, not a preference.",
        hard: true,
      });
    }
    for (const state of brief.states) {
      decisions.push({
        skill: SPEC.id,
        dimension: "interaction",
        key: `state: ${state}`,
        value: "drawn",
        why: "The brief declares this state should be expressed on the screen.",
        hard: true,
      });
    }

    /* --- the manner words --------------------------------------------------- */

    const direction = brief.visualDirection;
    if (direction === null) {
      return {
        skill: SPEC.id,
        decisions,
        notes: ["No visual manner stated; the runtime's default art direction applies."],
      };
    }

    const stripped = stripCompositionDescriptors(direction);
    for (const descriptor of stripped.handed) {
      notes.push(`'${descriptor}' is a composition descriptor: the composition strategy skill's closed vocabulary owns it and compiles it into composition decisions; no manner tokens here.`);
    }
    for (const descriptor of stripped.excluded) {
      decisions.push({
        skill: SPEC.id,
        dimension: "composition",
        key: `direction-exclusion: ${descriptor}`,
        value: "avoided",
        why: `The direction bars '${descriptor}' ('${direction}'); the composition strategy skill will not apply it either.`,
        hard: true,
      });
      notes.push(`Composition descriptor '${descriptor}' excluded by negation; recorded as a hard exclusion, not an unapplied manner word.`);
    }
    const words = directionWords(stripped.text);
    const tokensByWord = new Map<string, string[]>();
    const untranslated: string[] = [];

    /* A negation word excludes the manner word that follows it: 'not playful'
       must never compile the playful manner. This is the difference between a
       hard exclusion (an anti-goal, effectively) and an untranslated flavoured
       phrase — and getting it wrong produced an angry warm screen behind the
       word 'not'. */
    let negateNext = false;
    for (const word of words) {
      if (NEGATORS.has(word)) {
        negateNext = true;
        continue;
      }
      if (negateNext) {
        decisions.push({
          skill: SPEC.id,
          dimension: "composition",
          key: `direction-exclusion: ${word}`,
          value: "avoided",
          why: `The direction bars '${word}' ('${direction}'); its manner tokens are withheld from the compiled style.`,
          hard: true,
        });
        notes.push(`'${word}' excluded by negation in the direction; mapped to no tokens.`);
        negateNext = false;
        continue;
      }
      const mapping = ADJECTIVES[word];
      if (mapping === undefined) {
        untranslated.push(word);
        continue;
      }
      tokensByWord.set(word, mapping.tokens);
      for (const d of mapping.decisions) {
        decisions.push({
          skill: SPEC.id,
          dimension: d.dimension,
          key: d.key,
          value: d.value,
          why: `'${word}' in the visual direction maps to this; direction: '${direction}'.`,
          hard: false,
        });
      }
    }
    if (negateNext) {
      notes.push("The direction ends on a negation with no word following it; nothing was excluded by it.");
    }

    if (untranslated.length > 0) {
      notes.push(
        `Untranslated manner word(s): ${untranslated.join(", ")}. They map to no decisions in the direction vocabulary, so they were recorded rather than guessed at.`,
      );
    }

    /* --- direction-word tensions --------------------------------------------- */

    for (const { left, right } of TENSION_WORDS) {
      const l = left.find((w) => words.includes(w));
      const r = right.find((w) => words.includes(w));
      if (l !== undefined && r !== undefined) {
        notes.push(
          `Direction tension: '${l}' alongside '${r}' pull against each other. The later word's tokens hold; resolve the brief if this was not intended.`,
        );
      }
    }

    if (tokensByWord.size === 0) {
      notes.push(`None of the words in '${direction}' are in the direction vocabulary; no style tokens were compiled.`);
      return { skill: SPEC.id, decisions, notes };
    }

    /* --- compile one expansion-aware coherent token string ------------------- */

    // Tokens compile word by word, re-resolving the running set each time. The
    // runtime drops ALL style on a contradiction (both tokens back to default
    // taste), so the wall is found here where a note can ask the brief to pick
    // one — not 200 operations deep in a build.
    let contracted: string[] = [];
    const survivingWords: string[] = [];
    for (const [word, tokens] of tokensByWord) {
      const candidate = [...contracted];
      for (const token of tokens) if (!candidate.includes(token)) candidate.push(token);
      const resolved = resolveStyleTokens(candidate.join(","));
      const conflicted = contracted.length > 0 && resolved.warnings.some((w) => w.includes(CONTRADICTION_MARK));
      if (conflicted) {
        notes.push(
          `'${word}' carries tokens [${tokens.join(", ")}] that contradict the direction so far; they were dropped before the build so the runtime cannot discard the whole style.`,
        );
        continue;
      }
      contracted = candidate;
      survivingWords.push(word);
    }

    if (contracted.length === 0) {
      notes.push(
        "No style tokens survived contradiction checks; the direction applies no compiled manner and the default direction covers the build.",
      );
      return { skill: SPEC.id, decisions, notes };
    }

    const style = contracted.join(",");
    const finalResolution = resolveStyleTokens(style);
    for (const warning of finalResolution.warnings) {
      notes.push(`Style validation: ${warning}`);
    }
    for (const note of finalResolution.notes) notes.push(`Runtime resolution: ${note}`);

    decisions.push({
      skill: SPEC.id,
      dimension: "composition",
      key: "visual-intent.style",
      value: style,
      why: `Compiled from direction '${direction}'; resolved cleanly by the runtime's style resolver.`,
      hard: false,
    });

    /* Only words whose tokens survived contribute canonical intent fields, so
       the fields and the compiled tokens can never claim different manners. */
    for (const word of survivingWords) {
      const contribution = INTENT_CONTRIBUTIONS[word];
      if (contribution === undefined) continue;
      for (const e of Object.entries(contribution) as Array<[string, string]>) {
        decisions.push({
          skill: SPEC.id,
          dimension: e[0] === "contrast" ? "color" : "spacing",
          key: `visual-intent.${e[0]}`,
          value: e[1],
          why: `'${word}' commits to ${e[0]} '${e[1]}' in the canonical visual intent.`,
          hard: false,
        });
      }
    }

    return { skill: SPEC.id, decisions, notes };
  },
};
