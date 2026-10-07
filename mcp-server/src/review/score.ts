/**
 * Composition scoring (spec §10, §19).
 *
 * ## What a score is and is not
 *
 * A score never replaces human judgement — the spec says so explicitly, and it
 * is right. What a score does is force the question "is this a 6 or a 9, and
 * what would move it" before presentation, instead of after. Every dimension is
 * computed from measured geometry and counts, and every score carries the
 * evidence that produced it, so a number the model disagrees with can be argued
 * with rather than obeyed.
 *
 * ## Where the numbers come from
 *
 * Only from the compiled program: resolved boxes, operations and IR. No render,
 * no vision, no guessing. That keeps scoring free, offline and deterministic —
 * the same program always scores the same, which is what makes the number
 * useful across iterations rather than decorative.
 *
 * Each dimension is 0-10. The overall is the mean, rounded to one decimal.
 */
import type { PlacedBox } from "../../../shared/ir";
import type { Operation } from "../../../shared/protocol";

export interface DimensionScore {
  dimension: string;
  score: number;
  /** The measurements behind the number, so it can be argued with. */
  evidence: string;
  /** What would move this number. Empty when there is nothing concrete. */
  improve?: string;
}

export interface ScoreReport {
  overall: number;
  dimensions: DimensionScore[];
  /** Dimensions below 6. The fix list, ordered worst first. */
  weakSpots: string[];
}

interface Ctx {
  boxes: Array<{ id: string; x: number; y: number; w: number; h: number }>;
  regions: Array<{ id: string; role: string }>;
  composition: string;
  texts: Array<{ content: string; fontSize: number; family: string }>;
  fills: string[];
  strokes: string[];
  canvasW: number;
  canvasH: number;
}

const clampScore = (n: number): number => Math.max(0, Math.min(10, Math.round(n * 10) / 10));

/**
 * Scores a compiled program.
 *
 * `regionCount` and `composition` come from the caller because they are known
 * before layout in some paths and only after in others; passing them in keeps
 * this function honest about what it measures versus what it is told.
 */
export function scoreDesign(input: {
  boxes: Map<string, PlacedBox>;
  operations: Operation[];
  regions: Array<{ id: string; role: string }>;
  composition: string;
  canvasW: number;
  canvasH: number;
  /** Intended focus, when the program declared visual intent. */
  focal?: string;
}): ScoreReport {
  const ctx = buildContext(input);
  const dimensions = [
    scoreComposition(ctx),
    scoreHierarchy(ctx),
    scoreDensity(ctx),
    scoreAlignment(ctx),
    scoreConsistency(ctx),
    scoreAccessibility(ctx),
    scoreFocus(ctx, input.focal),
  ];

  const overall = clampScore(dimensions.reduce((a, d) => a + d.score, 0) / dimensions.length);
  const weakSpots = dimensions
    .filter((d) => d.score < 6)
    .sort((a, b) => a.score - b.score)
    .map((d) => `${d.dimension} (${d.score}/10): ${d.improve ?? d.evidence}`);

  return { overall, dimensions, weakSpots };
}

function buildContext(input: {
  boxes: Map<string, PlacedBox>;
  operations: Operation[];
  regions: Array<{ id: string; role: string }>;
  composition: string;
  canvasW: number;
  canvasH: number;
}): Ctx {
  const texts: Ctx["texts"] = [];
  const fills: string[] = [];
  const strokes: string[] = [];

  for (const op of input.operations) {
    const o = op as Record<string, unknown>;
    if (o.type === "createText") {
      texts.push({
        content: typeof o.content === "string" ? o.content : "",
        fontSize: typeof o.fontSize === "number" ? o.fontSize : 16,
        family: typeof o.family === "string" ? o.family : "Inter",
      });
      if (typeof o.fill === "string") fills.push(o.fill);
    }
    if (typeof o.fill === "string" && o.type !== "createText") fills.push(o.fill);
    if (typeof o.stroke === "string") strokes.push(o.stroke);
  }

  return {
    boxes: [...input.boxes.values()].map((b) => ({ ...b })),
    regions: input.regions,
    composition: input.composition,
    texts,
    fills,
    strokes,
    canvasW: input.canvasW,
    canvasH: input.canvasH,
  };
}

/* -------------------------------------------------------------------------- */

function scoreComposition(ctx: Ctx): DimensionScore {
  let score = 4;
  const notes: string[] = [];
  let improve: string | undefined;

  const focal = ctx.regions.filter((r) => r.role === "hero" || r.role === "primary-visual");
  if (focal.length === 1) {
    score += 3;
    notes.push(`one focal region (${focal[0]!.id})`);
  } else if (focal.length === 0) {
    score -= 2;
    improve = "Give the screen one focal region: a hero or primary-visual the eye lands on first.";
    notes.push("no focal region");
  } else {
    score -= 1;
    improve = `Two regions compete for focus (${focal.map((r) => r.id).join(", ")}). Demote one.`;
    notes.push(`${focal.length} focal regions compete`);
  }

  if (ctx.regions.length >= 2 && ctx.regions.length <= 5) {
    score += 2;
    notes.push(`${ctx.regions.length} regions`);
  } else {
    improve = improve ?? (ctx.regions.length < 2 ? "One region is a page, not a composition. Split intent from chrome." : "More than five regions is a lot to hold at once; merge two.");
    notes.push(`${ctx.regions.length} regions`);
  }

  if (ctx.composition === "canvas") {
    score -= 2;
    improve = "The layout resolved to a plain canvas: name the regions semantically so composition can do its job.";
    notes.push("unresolved composition");
  } else {
    score += 1;
    notes.push(`composition: ${ctx.composition}`);
  }

  return { dimension: "Composition", score: clampScore(score), evidence: notes.join("; "), ...(improve ? { improve } : {}) };
}

function scoreHierarchy(ctx: Ctx): DimensionScore {
  if (ctx.texts.length === 0) {
    return { dimension: "Hierarchy", score: 5, evidence: "no text to judge", improve: "A screen with no text has no hierarchy to read." };
  }

  const sizes = [...new Set(ctx.texts.map((t) => t.fontSize))].sort((a, b) => a - b);
  const max = sizes[sizes.length - 1]!;
  let score = 4;
  const notes = [`${sizes.length} distinct size(s): ${sizes.join(", ")}`];
  let improve: string | undefined;

  if (sizes.length >= 3) {
    score += 3;
  } else if (sizes.length === 2) {
    score += 1;
    improve = "Two sizes is a whisper of hierarchy. A third step (eyebrow or caption) would separate metadata from content.";
  } else {
    score -= 2;
    improve = "Everything is one size, so nothing is more important than anything else. Add a title step and a caption step.";
  }

  if (max >= 24) {
    score += 2;
    notes.push(`headline at ${max}px`);
  } else {
    score -= 1;
    improve = improve ?? `The largest text is ${max}px: no headline, no entry point.`;
  }

  const mono = ctx.texts.filter((t) => /mono/i.test(t.family)).length;
  if (mono > 0) {
    score += 1;
    notes.push(`${mono} technical value(s) in mono`);
  }

  return { dimension: "Hierarchy", score: clampScore(score), evidence: notes.join("; "), ...(improve ? { improve } : {}) };
}

function scoreDensity(ctx: Ctx): DimensionScore {
  const canvasArea = Math.max(1, ctx.canvasW * ctx.canvasH);
  // Regions only: content is inside them, so counting both would double-count.
  const regionIds = new Set(ctx.regions.map((r) => r.id));
  const regionArea = ctx.boxes.filter((b) => regionIds.has(b.id)).reduce((a, b) => a + Math.max(0, b.w) * Math.max(0, b.h), 0);
  const ratio = regionArea / canvasArea;

  // Regions tile the canvas by construction, so this measures fragmentation
  // rather than whitespace: many small regions read as clutter, few large ones
  // as calm. The count carries the signal.
  const n = ctx.regions.length;
  let score: number;
  let evidence: string;
  let improve: string | undefined;
  if (n >= 2 && n <= 5) {
    score = 8;
    evidence = `${n} regions tile the canvas`;
  } else if (n === 1) {
    score = 5;
    evidence = "a single region fills everything";
    improve = "One undifferentiated surface. Chrome and content deserve separation.";
  } else {
    score = 4;
    evidence = `${n} regions fragment the canvas (${Math.round(ratio * 100)}% nominal coverage)`;
    improve = "Merge regions until the screen has at most five jobs.";
  }

  return { dimension: "Information density", score, evidence, ...(improve ? { improve } : {}) };
}

function scoreAlignment(ctx: Ctx): DimensionScore {
  const boxes = ctx.boxes.filter((b) => b.w > 0 && b.h > 0);
  if (boxes.length < 2) {
    return { dimension: "Alignment", score: 7, evidence: "fewer than two boxes to align" };
  }

  // Two boxes align when they share a left edge, a right edge or a centre
  // within a pixel. The score is the fraction of boxes that align with at
  // least one other box: a layout where everything floats alone scores badly.
  let aligned = 0;
  for (const box of boxes) {
    const cx = box.x + box.w / 2;
    const right = box.x + box.w;
    const shares = boxes.some(
      (other) =>
        other !== box &&
        (Math.abs(other.x - box.x) < 1.5 || Math.abs(other.x + other.w - right) < 1.5 || Math.abs(other.x + other.w / 2 - cx) < 1.5),
    );
    if (shares) aligned += 1;
  }

  const ratio = aligned / boxes.length;
  const score = clampScore(2 + ratio * 8);
  return {
    dimension: "Alignment",
    score,
    evidence: `${aligned}/${boxes.length} boxes share an edge or centre`,
    ...(score < 6 ? { improve: "Nudge floating boxes onto shared edges: left edges must agree, not almost agree." } : {}),
  };
}

function scoreConsistency(ctx: Ctx): DimensionScore {
  const colours = new Set([...ctx.fills, ...ctx.strokes].map((c) => c.toLowerCase()));
  const families = new Set(ctx.texts.map((t) => t.family));

  let score = 6;
  const notes = [`${colours.size} colour(s)`, `${families.size} familie(s)`];
  let improve: string | undefined;

  if (colours.size <= 6) {
    score += 2;
  } else if (colours.size <= 10) {
    score += 1;
  } else {
    score -= 2;
    improve = `${colours.size} distinct colours is a rainbow, not a palette. Bind repeated values to variables.`;
  }

  if (families.size <= 2) {
    score += 2;
  } else {
    score -= 1;
    improve = (improve ? `${improve} ` : "") + `${families.size} typefaces compete. Body plus mono is the whole vocabulary.`;
  }

  return { dimension: "Visual consistency", score: clampScore(score), evidence: notes.join("; "), ...(improve ? { improve } : {}) };
}

function scoreAccessibility(ctx: Ctx): DimensionScore {
  if (ctx.texts.length === 0) {
    return { dimension: "Accessibility", score: 7, evidence: "no text to judge" };
  }

  const tiny = ctx.texts.filter((t) => t.fontSize < 11).length;
  let score = 8;
  const notes = [`smallest text ${Math.min(...ctx.texts.map((t) => t.fontSize))}px`];
  let improve: string | undefined;

  if (tiny > 0) {
    score -= Math.min(5, tiny * 2);
    improve = `${tiny} text layer(s) under 11px. Minimum readable technical text is 11px, body 12px and up.`;
    notes.push(`${tiny} tiny layer(s)`);
  }

  const monoTechnical = ctx.texts.filter((t) => /mono/i.test(t.family)).length;
  if (monoTechnical > 0) notes.push("technical values monospaced");

  return { dimension: "Accessibility", score: clampScore(score), evidence: notes.join("; "), ...(improve ? { improve } : {}) };
}

/**
 * Focus: where the eye lands first, estimated deterministically (FigDes §19).
 *
 * The model combines three measurable pulls: size (bigger wins), position
 * (upper-centre wins — reading starts top-left and settles centre), and role
 * (a hero outranks chrome). Each region gets a share of 1.0, so the output
 * reads as attention, not area. When the program declared a focal region, the
 * score is the agreement between intent and measurement; without one, a clear
 * leader still scores well and a flat field does not.
 */
function scoreFocus(ctx: Ctx, focal: string | undefined): DimensionScore {
  const regionBoxes = ctx.boxes.filter((b) => ctx.regions.some((r) => r.id === b.id));
  if (regionBoxes.length === 0) {
    return { dimension: "Focus", score: 5, evidence: "no regions to judge" };
  }

  const rolePull: Record<string, number> = { hero: 1.4, "primary-visual": 1.4, content: 1.0, secondary: 0.9, inspector: 0.7, header: 0.6, navigation: 0.5, "status-rail": 0.5, footer: 0.4, custom: 0.8 };
  const cx = ctx.canvasW / 2;
  const cy = ctx.canvasH * 0.42;

  const pulls = regionBoxes.map((b) => {
    const role = ctx.regions.find((r) => r.id === b.id)?.role ?? "custom";
    const area = Math.max(1, b.w) * Math.max(1, b.h);
    const dist = Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy);
    const position = 1 / (1 + dist / Math.max(1, ctx.canvasW / 2));
    return { id: b.id, pull: area * position * (rolePull[role] ?? 0.8) };
  });

  const total = pulls.reduce((a, p) => a + p.pull, 0) || 1;
  const shares = pulls.map((p) => ({ ...p, share: p.pull / total })).sort((a, b) => b.share - a.share);
  const leader = shares[0]!;
  const summary = shares.map((s) => `${s.id} ${Math.round(s.share * 100)}%`).join(", ");

  if (focal !== undefined) {
    const focalShare = shares.find((s) => s.id === focal)?.share ?? 0;
    if (leader.id === focal && focalShare >= 0.4) {
      return { dimension: "Focus", score: 9, evidence: `intended focal '${focal}' holds ${Math.round(focalShare * 100)}% of attention: ${summary}` };
    }
    return {
      dimension: "Focus",
      score: clampScore(Math.round(focalShare * 10)),
      evidence: `intended '${focal}' holds ${Math.round(focalShare * 100)}% but '${leader.id}' leads: ${summary}`,
      improve: `The eye lands on '${leader.id}', not the intended focal '${focal}'. Grow it, move it toward the upper centre, or reconsider which region deserves focus.`,
    };
  }

  if (leader.share >= 0.45) {
    return { dimension: "Focus", score: 8, evidence: `clear leader '${leader.id}' at ${Math.round(leader.share * 100)}%: ${summary}` };
  }
  return {
    dimension: "Focus",
    score: 5,
    evidence: `flat field, no region above 45%: ${summary}`,
    improve: "Attention is spread evenly, which reads as no hierarchy. Promote one region to hero and give it the room.",
  };
}