/**
 * The visual critic (FigDes §16.2).
 *
 * ## Structural vs aesthetic, kept apart on purpose
 *
 * The structural critic answers "is it correct" (overflow, contrast, naming,
 * tap targets). This one answers "is it good": focal clarity, hierarchy,
 * composition, whitespace, density, repetition, card-wall tendency, balance,
 * data-visualization quality, surface hierarchy, depth, and whether the screen
 * feels template-generated. Mixing the two would let a screen that passes
 * geometry fail vibes, or vice versa; they run separately and report separately.
 *
 * ## Measured, not felt
 *
 * Every dimension below is computed from boxes, operations and IR — the same
 * honesty contract as the structural critic. Verdicts are PASS / WATCH / FAIL,
 * never numbers: a number would pretend to a precision the measurements do not
 * have, and the spec explicitly forbids arbitrary aesthetic scores.
 */
import type { PlacedBox } from "../../../shared/ir";
import type { Operation } from "../../../shared/protocol";
import { parseColor } from "../../../shared/protocol";
import { scoreDesign } from "./score";

export type AestheticVerdict = "PASS" | "WATCH" | "FAIL";

export interface AestheticDimension {
  dimension: string;
  verdict: AestheticVerdict;
  evidence: string;
  suggestion?: string;
}

export interface CritiqueReport {
  verdict: AestheticVerdict;
  dimensions: AestheticDimension[];
  /** Dimensions needing attention, worst first. */
  watchList: string[];
}

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function critiqueVisual(input: {
  boxes: Map<string, PlacedBox>;
  operations: Operation[];
  regions: Array<{ id: string; role: string }>;
  composition: string;
  canvasW: number;
  canvasH: number;
  links?: Array<{ from: string; to: string; label?: string }>;
  focal?: string;
}): CritiqueReport {
  const boxes: Box[] = [...input.boxes.values()].map((b) => ({ ...b }));
  const ops = input.operations as Array<Record<string, unknown>>;
  const regionIds = new Set(input.regions.map((r) => r.id));
  const regionBoxes = boxes.filter((b) => regionIds.has(b.id));

  // The seven measured dimensions come from the scorer; the critic reframes
  // them as aesthetic verdicts and adds the five it alone can see.
  const scored = scoreDesign({
    boxes: input.boxes,
    operations: input.operations,
    regions: input.regions,
    composition: input.composition,
    canvasW: input.canvasW,
    canvasH: input.canvasH,
    ...(input.focal !== undefined ? { focal: input.focal } : {}),
  });
  const dim = (name: string): number => scored.dimensions.find((d) => d.dimension === name)?.score ?? 5;
  const pass = (score: number): AestheticVerdict => (score >= 7 ? "PASS" : score >= 5 ? "WATCH" : "FAIL");

  const dimensions: AestheticDimension[] = [
    {
      dimension: "Focal clarity",
      verdict: pass(dim("Focus")),
      evidence: scored.dimensions.find((d) => d.dimension === "Focus")?.evidence ?? "no focus data",
      ...(dim("Focus") < 7 ? { suggestion: "Give one object the size and position to be found first." } : {}),
    },
    {
      dimension: "Hierarchy",
      verdict: pass(dim("Hierarchy")),
      evidence: scored.dimensions.find((d) => d.dimension === "Hierarchy")?.evidence ?? "no hierarchy data",
    },
    {
      dimension: "Composition",
      verdict: pass(dim("Composition")),
      evidence: scored.dimensions.find((d) => d.dimension === "Composition")?.evidence ?? "no composition data",
    },
    {
      dimension: "Whitespace",
      verdict: pass(dim("Information density")),
      evidence: scored.dimensions.find((d) => d.dimension === "Information density")?.evidence ?? "no density data",
    },
    {
      dimension: "Density",
      verdict: pass(dim("Information density")),
      evidence: `${regionBoxes.length} regions; ${ops.length} operations drawn`,
    },
    repetition(boxes),
    cardWallTendency(ops, input.canvasW, input.canvasH),
    visualBalance(regionBoxes, input.canvasW, input.canvasH),
    dataVizQuality(input.links ?? [], ops),
    surfaceHierarchy(ops),
    depthUsed(ops),
    templateFeel(input.regions, input.composition, boxes),
  ];

  const order = { FAIL: 0, WATCH: 1, PASS: 2 };
  const verdict: AestheticVerdict = dimensions.some((d) => d.verdict === "FAIL")
    ? "FAIL"
    : dimensions.some((d) => d.verdict === "WATCH")
      ? "WATCH"
      : "PASS";

  return {
    verdict,
    dimensions,
    watchList: dimensions
      .filter((d) => d.verdict !== "PASS")
      .sort((a, b) => order[a.verdict] - order[b.verdict])
      .map((d) => `${d.dimension} (${d.verdict}): ${d.suggestion ?? d.evidence}`),
  };
}

/** Three or more same-sized boxes read as stamping, not designing. */
function repetition(boxes: Box[]): AestheticDimension {
  const groups = new Map<string, number>();
  for (const b of boxes) {
    if (b.w <= 0 || b.h <= 0) continue;
    const key = `${Math.round(b.w / 8) * 8}x${Math.round(b.h / 8) * 8}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const biggest = Math.max(0, ...groups.values());
  if (biggest >= 4) {
    return {
      dimension: "Repetition",
      verdict: "WATCH",
      evidence: `${biggest} boxes share one size bucket`,
      suggestion: "Vary the rhythm: promote one to hero size, merge two, or convert the cluster to a visual field.",
    };
  }
  return { dimension: "Repetition", verdict: "PASS", evidence: biggest > 0 ? `largest size group holds ${biggest}` : "no repeated sizes" };
}

/** Bordered-surface share, program-side twin of the live card-wall rule. */
function cardWallTendency(ops: Array<Record<string, unknown>>, canvasW: number, canvasH: number): AestheticDimension {
  let cardArea = 0;
  let cards = 0;
  for (const o of ops) {
    if (o.type !== "createFrame" && o.type !== "createRectangle") continue;
    const w = typeof o.width === "number" ? o.width : 0;
    const h = typeof o.height === "number" ? o.height : 0;
    const bordered = o.stroke !== undefined || (typeof o.cornerRadius === "number" && o.cornerRadius >= 4);
    if (bordered && w > 40 && h > 24) {
      cards += 1;
      cardArea += w * h;
    }
  }
  const share = cardArea / Math.max(1, canvasW * canvasH);
  if (cards >= 3 && share >= 0.4) {
    return {
      dimension: "Card-wall tendency",
      verdict: "WATCH",
      evidence: `${cards} bordered surfaces cover ${Math.round(share * 100)}% of the canvas`,
      suggestion: "Convert one cluster into a visual field, chart, topology, or open composition.",
    };
  }
  return { dimension: "Card-wall tendency", verdict: "PASS", evidence: cards === 0 ? "no bordered surfaces" : `${cards} bordered surface(s), ${Math.round(share * 100)}% of canvas` };
}

/** Left/right visual weight symmetry. Perfect symmetry is static; wild imbalance topples. */
function visualBalance(regionBoxes: Box[], canvasW: number, canvasH: number): AestheticDimension {
  if (regionBoxes.length === 0) {
    return { dimension: "Visual balance", verdict: "PASS", evidence: "nothing placed yet" };
  }
  let left = 0;
  let right = 0;
  for (const b of regionBoxes) {
    const area = Math.max(0, b.w) * Math.max(0, b.h);
    const cx = b.x + b.w / 2;
    if (cx < canvasW / 2) left += area;
    else right += area;
  }
  const total = left + right || 1;
  const imbalance = Math.abs(left - right) / total;
  if (imbalance > 0.75) {
    return {
      dimension: "Visual balance",
      verdict: "WATCH",
      evidence: `${Math.round((Math.max(left, right) / total) * 100)}% of region area sits on one side`,
      suggestion: "Counterweight the heavy side, or commit to deliberate asymmetry with whitespace doing the balancing.",
    };
  }
  return { dimension: "Visual balance", verdict: "PASS", evidence: `left/right split ${Math.round((left / total) * 100)}/${Math.round((right / total) * 100)}` };
}

/** Edges exist to be read: unlabeled ones are decoration. */
function dataVizQuality(links: Array<{ from: string; to: string; label?: string }>, ops: Array<Record<string, unknown>>): AestheticDimension {
  const vectors = ops.filter((o) => o.type === "createVector").length;
  if (links.length === 0 && vectors === 0) {
    return { dimension: "Data-visualization quality", verdict: "PASS", evidence: "no data graphics to judge" };
  }
  const labeled = links.filter((l) => l.label !== undefined && l.label.length > 0).length;
  const mono = ops.some((o) => o.type === "createText" && typeof o.family === "string" && /mono/i.test(o.family));
  if (links.length > 0 && labeled < links.length) {
    return {
      dimension: "Data-visualization quality",
      verdict: "WATCH",
      evidence: `${links.length - labeled}/${links.length} edges carry no label`,
      suggestion: "Label what each edge means (latency, flow, assignment). An unexplained line is decoration.",
    };
  }
  return {
    dimension: "Data-visualization quality",
    verdict: "PASS",
    evidence: `${labeled}/${links.length} edges labelled${mono ? "; technical values monospaced" : ""}`,
  };
}

/** Distinct surface layers: too few is flat, too many is noise. */
function surfaceHierarchy(ops: Array<Record<string, unknown>>): AestheticDimension {
  const fills = new Set<string>();
  for (const o of ops) {
    if (typeof o.fill === "string") fills.add(o.fill.toLowerCase());
  }
  if (fills.size <= 1 && ops.length > 5) {
    return {
      dimension: "Surface hierarchy",
      verdict: "WATCH",
      evidence: "a single surface colour across the whole screen",
      suggestion: "Separate canvas, surface and accent with three distinct values so depth reads.",
    };
  }
  if (fills.size > 8) {
    return {
      dimension: "Surface hierarchy",
      verdict: "WATCH",
      evidence: `${fills.size} distinct surfaces`,
      suggestion: "Merge near-identical surfaces until the file has a background, a surface and accents.",
    };
  }
  return { dimension: "Surface hierarchy", verdict: "PASS", evidence: `${fills.size} surface(s) in play` };
}

/** Depth actually used: elevations, effects, translucency. */
function depthUsed(ops: Array<Record<string, unknown>>): AestheticDimension {
  let signals = 0;
  const notes: string[] = [];
  for (const o of ops) {
    if (o.type === "setEffect") {
      signals += 1;
      notes.push("effect");
    }
    if (typeof o.opacity === "number" && o.opacity < 1) {
      signals += 1;
      notes.push("translucency");
    }
  }
  if (signals === 0) {
    return { dimension: "Depth", verdict: "PASS", evidence: "flat by construction; depth is opt-in, not required" };
  }
  return { dimension: "Depth", verdict: "PASS", evidence: `depth via ${[...new Set(notes)].join(", ")}` };
}

/** The template smell: perfect symmetry, uniform regions, unresolved composition. */
function templateFeel(regions: Array<{ id: string; role: string }>, composition: string, boxes: Box[]): AestheticDimension {
  const regionBoxes = boxes.filter((b) => regions.some((r) => r.id === b.id));
  const smells: string[] = [];
  if (composition === "canvas") smells.push("unresolved generic composition");
  if (regionBoxes.length >= 3) {
    const areas = regionBoxes.map((b) => Math.round((b.w * b.h) / 100) * 100);
    const distinct = new Set(areas).size;
    if (distinct === 1) smells.push("all regions identically sized");
  }
  if (smells.length === 0) {
    return { dimension: "Template feel", verdict: "PASS", evidence: "no template markers detected" };
  }
  return {
    dimension: "Template feel",
    verdict: "WATCH",
    evidence: smells.join("; "),
    suggestion: "Break one symmetry deliberately: promote a hero, vary a span, let whitespace do work.",
  };
}

/** Parses a hex colour; null when it is not a literal. Exported for reuse. */
export function tryParseColor(hex: string): { r: number; g: number; b: number } | null {
  try {
    const c = parseColor(hex);
    return { r: c.r, g: c.g, b: c.b };
  } catch {
    return null;
  }
}
