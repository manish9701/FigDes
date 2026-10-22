/**
 * Skill: typography and spacing discipline (issue #22, skill C).
 *
 * ## What it does
 *
 * Decides the type-role contract and the spacing rhythm for the screen from
 * the content kinds the brief names, and turns the decisions the runtime
 * understands (alignment, numeral discipline, rhythm) into compiled intent.
 * It also declares the check catalogue the critic phases apply — the checks a
 * *review* pass can run when type and spacing measurements exist.
 *
 * ## Why not more code here
 *
 * Type sizes and gaps are chosen by the compiler and the planner from the
 * composition; this skill constrains *how those choices are made* for this
 * brief (strict alignment for readouts, tabular numbers, quiet labels) and
 * writes down the acceptance criteria. A skill that re-picked font sizes would
 * become a second compiler drifting against the first.
 */
import type { SkillDecision, SkillEntry, SkillOutput, SkillSpec } from "./contracts";
import type { NormalizedBrief } from "../../pipeline/contracts";
import { classifyDecision } from "../../plan/planner";

const NUMERIC_KEY = /\b(\d|percent|%|rate|latency|throughput|ms|count|score|status|uptime|price|load|pressure|auction|bid)\b/i;

const SPEC: SkillSpec = {
  id: "type-and-space",
  version: "v1",
  name: "Typography and spacing discipline",
  purpose:
    "Turns the brief's content shape into the type-role and spacing contract the compile applies, and states the measurable type and spacing criteria the critique must check when rendered evidence exists.",
  signals: ["content-inventory", "data-readouts", "stated-direction"],
  whenToUse: "Any brief whose screen carries headings, values or labelled controls — that is, nearly any brief with an information inventory.",
  whenNotToUse:
    "No information at all is named beyond the decision: the planner's shared type ramp already covers a one-slot screen.",
  expectedOutput:
    "Alignment and numeral-discipline decisions compiled where the runtime consumes them, a type-role assignment per content kind, and the declared spacing and type acceptance criteria.",
  requiredInputs: ["brief.information"],
  optionalContext: ["brief.visualDirection", "brief.audience", "brief.states"],
  decisionRules: [
    {
      id: "labels-never-tiny",
      dimension: "accessibility",
      rule: "No label on the screen renders below 11px; metadata is not 'small caps at any price'.",
      why: "Tiny labels are the most common spacing-discipline failure and the cheapest to gate.",
    },
    {
      id: "uppercase-budget",
      dimension: "typography",
      rule: "Uppercase is reserved for eyebrows and status dots, not sentence-length metadata; at most a handful of words per screen.",
      why: "Uppercase metadata everywhere reads as shouting and harms scanning.",
    },
    {
      id: "values-are-tabular",
      dimension: "typography",
      rule: "Any value that updates or compares is set with tabular numerals.",
      why: "Proportional numerals jitter as values change, and align-down-the-column comparisons misread.",
    },
    {
      id: "spacing-on-rhythm",
      dimension: "spacing",
      rule: "Gaps follow the grid rhythm the direction compiled (generous/even/tight); two different gaps between sibling regions need a stated reason.",
      why: "Inconsistent gaps read as careless even when every region is individually tidy.",
    },
    {
      id: "line-length-capped",
      dimension: "typography",
      rule: "Body columns cap around 75 characters; a readout column is as narrow as its content.",
      why: "Uncapped line length breaks scanning and wraps without warning in narrow columns.",
    },
  ],
  outputs: [
    {
      field: "intent-alignment",
      description: "Strict or loose alignment for the whole screen.",
      consumedBy: ["shared/ir.ts VisualIntentSchema.alignment", "mcp-server/src/runtime/compile.ts alignGrid"],
    },
    {
      field: "numeral-discipline",
      description: "Tabular or mono numerals for live values.",
      consumedBy: ["design/skills/intent-compiler.ts (style tokens)", "mcp-server/src/runtime/visual-presets.ts resolveStyleTokens"],
    },
    {
      field: "type-role-contract",
      description: "Which content kinds take which type roles on this screen.",
      consumedBy: ["design/skills/intent-compiler.ts (decision trail)", "pipeline/report.ts (trace stages)"],
    },
    {
      field: "acceptance-criteria",
      description: "The declared label-size, uppercase-budget, spacing-rhythm and line-length criteria.",
      consumedBy: ["design/skills/visual-critique (phase 2)", "pipeline (review passes)"],
    },
  ],
  qualityChecks: [
    {
      id: "readable-labels",
      dimension: "accessibility",
      criterion: "No text node renders below 11px when measurements exist.",
    },
    {
      id: "uppercase-in-check",
      dimension: "typography",
      criterion: "Uppercase runs total at most a handful of words; metadata is sentence case.",
    },
    {
      id: "one-rhythm",
      dimension: "spacing",
      criterion: "Sibling-region gaps are all one compiled rhythm step, within rounding.",
    },
    {
      id: "column-length-sane",
      dimension: "typography",
      criterion: "Body text columns stay around 75 characters; readout columns hug their content.",
    },
  ],
  examples: [
    {
      summary: "An operations monitor compiles tabular numerals and strict alignment",
      why: "Values are the content; numeric columns align and jitter stops when a latency updates.",
    },
  ],
  counterexamples: [
    {
      summary: "An editorial brief compiles strict grid alignment for readouts absent",
      why: "With no readouts the type contract stays loose; strict alignment would add nothing but rigidity.",
    },
  ],
  fixtures: ["issue-22-type-space-briefs"],
};

export const typeAndSpace: SkillEntry = {
  spec: SPEC,

  apply({ brief }: { brief: NormalizedBrief }): SkillOutput {
    const decisions: SkillDecision[] = [];
    const notes: string[] = [];

    const info = [...brief.requiredInformation, ...brief.optionalInformation];
    const numeric = info.filter((i) => NUMERIC_KEY.test(i)).length;
    const decisionFigure = classifyDecision(brief.primaryDecision);

    /* --- numeral discipline -------------------------------------------------- */

    if (numeric >= 2) {
      if (!brief.designSystemConstraints.some((c) => /mono|tabular|numeral/i.test(c))) {
        decisions.push({
          skill: SPEC.id,
          dimension: "typography",
          key: "visual-intent.numerals",
          value: "tabular",
          why: `${numeric} information item(s) name numeric readouts; tabular numerals keep updating and compared values aligned.`,
          hard: false,
        });
        notes.push(`Readable-numeral decision: tabular numerals for the ${numeric} numeric readout item(s).`);
      } else {
        notes.push("The file's design system already constrains numeral styling; the skill defers to it.");
      }
    }

    /* --- alignment: only where the task earns it ------------------------------ */

    const alignment: "strong" | "loose" = numeric >= 3 || decisionFigure === "monitor" || decisionFigure === "configure" ? "strong" : "loose";
    decisions.push({
      skill: SPEC.id,
      dimension: "typography",
      key: "visual-intent.alignment",
      value: alignment,
      why:
        alignment === "strong"
          ? `${numeric} numeric readout(s) and the '${decisionFigure}' task want a strict grid so values compare down the column.`
          : `No readout-dense task; alignment stays loose so the editorial rhythm carries.`,
      hard: false,
    });

    /* --- the type-role contract, in reading order ----------------------------- */

    notes.push(
      "Type-role contract: the screen name takes the title role, the decision context takes the subtitle, each information item takes its natural role (eyebrow for metadata, label for chrome-ish captions, body for prose, code for identifiers), and status states take the label role at legible size.",
    );

    /* --- declared acceptance criteria ----------------------------------------- */

    notes.push(
      "Acceptance criteria declared: no label below 11px; uppercase reserved for eyebrows; one spacing rhythm step between sibling regions; body columns around 75 characters. Measured on rendered evidence when screenshot critique runs (issue #22 phase 2).",
    );

    return { skill: SPEC.id, decisions, notes };
  },
};
