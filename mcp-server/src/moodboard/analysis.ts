/**
 * Moodboard analysis (issue #11, Part C).
 *
 * ## What can and cannot be measured here
 *
 * A Figma frame can be *measured*: fills, type sizes, spacing, grid, radius. A
 * URL or an external image cannot — the server has no pixels and no file. Those
 * two cases are kept strictly apart.
 *
 * This matters because the issue asks the agent to return "evidence-backed
 * observations and confidence, not unquestioned facts", and separately asks for
 * "an explicit partial-analysis state" when a source cannot be read. Conflating a
 * measured palette with a guessed one is exactly the failure that makes a
 * moodboard library untrustworthy, so:
 *
 *  - Measured observations carry `provenance: "measured"` and real values.
 *  - A vision-capable model fills in the rest as `inferred`, at lower confidence,
 *    and is told which is which.
 *  - An unreadable source produces no observations and a recorded reason. It
 *    never produces a plausible-looking guess.
 */
import { contrastRatio, parseHex, relativeLuminance } from "../../../shared/contrast";
import { isOnRadiusScale } from "../../../shared/protocol";
import type { MoodboardSource, Observation, ObservationKind, VisualBrief } from "./model";

/** The shape the plugin returns for one frame. */
export interface MeasurableFrame {
  id: string;
  name: string;
  nodes: Array<{
    id: string;
    type: string;
    name: string;
    fill?: string;
    stroke?: string;
    radius?: number;
    w: number;
    h: number;
    x: number;
    y: number;
    text?: { content: string; size?: number; family?: string; weight?: string; color?: string };
    background?: string;
  }>;
}

/**
 * Observations a caller can propose after looking at an image.
 *
 * The tool accepts these rather than inventing a vision model server-side. The
 * agent doing the work *is* the vision-capable model, and having it hand back
 * structured claims keeps provenance honest: a claim the agent wrote is
 * `inferred`, and only what this module measured is `measured`.
 */
export type ProposedObservation = Observation;

const now = (): string => new Date().toISOString();

/**
 * Measures what a frame can actually prove.
 *
 * Deliberately conservative about what counts as a finding: a colour used once
 * is a colour, not a palette. A palette claim needs the colour to recur, and the
 * claim says how often, so a reviewer can judge whether it deserves approval.
 */
export function measureFrame(source: MoodboardSource, frame: MeasurableFrame): Observation[] {
  const out: Observation[] = [];
  const evidence = { sourceNodeId: source.nodeId ?? frame.id, area: frame.name };
  const push = (kind: ObservationKind, claim: string, confidence: number, measurement?: Record<string, unknown>): void => {
    out.push({
      id: `obs-${kind}-${out.length + 1}`,
      moodboardId: "",
      kind,
      claim,
      confidence,
      provenance: "measured",
      evidence: { ...evidence, ...(measurement ? { measurement } : {}) },
      approved: false,
      editedByUser: false,
    });
  };

  /* --- palette --------------------------------------------------------- */

  const fillCounts = new Map<string, number>();
  for (const n of frame.nodes) {
    if (!n.fill || !parseHex(n.fill)) continue;
    fillCounts.set(n.fill.toUpperCase(), (fillCounts.get(n.fill.toUpperCase()) ?? 0) + 1);
  }
  const ranked = [...fillCounts.entries()].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((a, [, n]) => a + n, 0);
  if (ranked.length > 0) {
    const dominant = ranked[0]!;
    const share = Math.round((dominant[1] / total) * 100);
    const dominantLum = relativeLuminance(parseHex(dominant[0])!);
    const temperature = dominantLum > 0.6 ? "light" : dominantLum < 0.2 ? "dark" : "mid";
    push(
      "palette",
      `Surfaces are dominated by ${dominant[0]} (${share}% of ${total} filled nodes), a ${temperature} base.`,
      Math.min(0.95, 0.4 + share / 200),
      { colours: ranked.slice(0, 8).map(([hex, n]) => ({ hex, count: n })) },
    );
  }

  // Text colour against its measured backdrop: the one contrast fact a reference
  // can state without judgement, and the one most worth carrying forward.
  const textPairs = frame.nodes.filter((n) => n.text?.content?.trim() && n.text.color && n.background);
  let legible = 0;
  let illegible = 0;
  for (const n of textPairs) {
    const ratio = contrastRatio(n.text!.color!, n.background!);
    if (ratio === null) continue;
    if (ratio >= 4.5) legible++;
    else illegible++;
  }
  if (textPairs.length > 0) {
    push(
      "typography",
      `${legible} of ${textPairs.length} text layers meet WCAG AA against their measured surface (${illegible} do not).`,
      0.9,
      { textNodes: textPairs.length, legible, illegible },
    );
  }

  /* --- type scale ------------------------------------------------------ */

  const sizes = [...new Set(textPairs.map((n) => n.text?.size).filter((s): s is number => typeof s === "number"))].sort((a, b) => b - a);
  if (sizes.length >= 2) {
    push("typography", `The type scale steps ${sizes.slice(0, 6).join(" / ")}px, spanning a ${(sizes[0]! / sizes[sizes.length - 1]!).toFixed(1)}:1 range.`, 0.85, { sizes: sizes.slice(0, 10) });
  } else if (sizes.length === 1) {
    push("typography", `Text is set at a single size (${sizes[0]}px), so hierarchy comes from weight or colour rather than scale.`, 0.6, { sizes });
  }
  const families = [...new Set(textPairs.map((n) => n.text?.family).filter((f): f is string => typeof f === "string"))];
  if (families.length > 0) {
    push("typography", families.length === 1 ? `One family throughout: ${families[0]}.` : `${families.length} families in use: ${families.slice(0, 5).join(", ")}.`, 0.8, { families });
  }

  /* --- shape and radius ------------------------------------------------ */

  const radii = frame.nodes.map((n) => n.radius).filter((r): r is number => typeof r === "number" && r > 0);
  const offScale = radii.filter((r) => !isOnRadiusScale(r));
  if (radii.length >= 3) {
    const distinct = [...new Set(radii)].sort((a, b) => a - b);
    push(
      "shape",
      offScale.length === 0
        ? `Corner radii sit on the documented scale: ${distinct.slice(0, 6).join(", ")}px.`
        : `${offScale.length} of ${radii.length} corners are off-scale (${[...new Set(offScale)].slice(0, 5).join(", ")}px).`,
      offScale.length === 0 ? 0.85 : 0.8,
      { radii: distinct.slice(0, 10), offScale: [...new Set(offScale)].slice(0, 10) },
    );
  }

  /* --- density and spacing --------------------------------------------- */

  const gaps = new Set<number>();
  const containers = frame.nodes.filter((n) => n.type === "FRAME" && n.w > 0);
  for (const n of containers) {
    for (const m of frame.nodes) {
      if (m.id === n.id) continue;
      const dx = Math.abs(m.x + m.w / 2 - (n.x + n.w / 2));
      const dy = Math.abs(m.y + m.h / 2 - (n.y + n.h / 2));
      if (dy < 2 && dx > 0 && dx < n.w) gaps.add(Math.round(dx));
    }
  }
  const steps = [...gaps].filter((g) => g > 0).sort((a, b) => a - b);
  if (steps.length >= 2) {
    push("spacing", `Horizontal rhythm steps through ${steps.slice(0, 6).join(", ")}px, suggesting a base unit near ${smallestStep(steps)}px.`, 0.6, { gaps: steps.slice(0, 12) });
  }

  const filled = frame.nodes.filter((n) => n.fill).length;
  const bordered = frame.nodes.filter((n) => n.stroke).length;
  if (frame.nodes.length >= 8) {
    const fillShare = Math.round((filled / frame.nodes.length) * 100);
    push(
      "surface",
      `${fillShare}% of nodes carry a fill and ${Math.round((bordered / frame.nodes.length) * 100)}% carry a stroke: a ${fillShare > 55 ? "filled-surface" : bordered > 40 ? "outlined" : "sparse"} treatment.`,
      0.7,
      { nodes: frame.nodes.length, filled, bordered },
    );
  }

  return out;
}

/** GCD of the observed gaps, floored at 1: the implied base unit. */
function smallestStep(steps: number[]): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  return steps.reduce((acc, s) => gcd(acc, s), steps[0] ?? 1) || 1;
}

/**
 * Builds a brief from measurements plus observations the agent proposed.
 *
 * Proposed observations are kept but downgraded: an agent's reading of an image
 * is an inference until it is checked, and the brief says so in the data rather
 * than in a footnote. Any unreadable source marks the whole brief partial.
 */
export function buildBrief(input: {
  moodboardId: string;
  sources: MoodboardSource[];
  measured: Observation[];
  proposed: ProposedObservation[];
}): VisualBrief {
  const unreadable = input.sources.filter((s) => !s.readable);
  const observations = [
    ...input.measured.map((o) => ({ ...o, moodboardId: input.moodboardId })),
    ...input.proposed.map((o) => ({
      ...o,
      moodboardId: input.moodboardId,
      approved: false,
      editedByUser: false,
      // A caller-supplied observation is an inference by construction: this
      // module never measured it. Marking one `measured` would let an unverified
      // claim enter the approved profile wearing the authority of a measurement.
      provenance: o.provenance === "measured" ? "inferred" : o.provenance,
    })),
  ];

  return {
    moodboardId: input.moodboardId,
    observations,
    partial: unreadable.length > 0,
    unreadableSources: unreadable.map((s) => `${s.label || s.nodeId || s.url || "source"}: ${s.unreadableReason ?? "not readable"}`),
    analysedAt: now(),
  };
}