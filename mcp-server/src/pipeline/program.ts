/**
 * Stage 5 — build the program (issue #16, §Stage 5).
 *
 * ## What the program is
 *
 * A declarative program for `design_runtime`: regions with their layout
 * contract, and content slots with the primitive that will carry them. No
 * coordinates. The layout engine computes the geometry, which is what keeps the
 * plan and the build in agreement.
 *
 * Three rules shape what goes in:
 *
 * 1. **Nothing is invented.** A metric without a real value gets a placeholder
 *    and is marked illustrative, because a screen that shows a confident number
 *    nobody supplied is a screen that lies.
 * 2. **Related content is related in the file too.** A region whose content is
 *    a column of fixed-extent components is built as a native auto-layout
 *    container, so a designer can re-lay it out in Figma instead of editing
 *    coordinates.
 * 3. **Text is sized, not hoped for.** Every text primitive gets an explicit
 *    wrapping width taken from the region it lives in, so a long model id or an
 *    error message wraps instead of pushing the layout apart.
 *
 * The honest number in rule 1 is stated once, not stamped on every value: the
 * disclosure policy (`disclosure.ts`, issue #23 §4) decides whether the screen
 * carries ONE concise caption marking the values illustrative — or none, when
 * the caller asked for a clean concept and the report carries the truth.
 */
import type { CompositionPlan, ContentSlot, NormalizedBrief, RegionSpec } from "./contracts";
import { decideDisclosure } from "./disclosure";
import type { VisualIntent } from "../../../shared/ir";

/** A runtime program call. */
export interface ProgramCall {
  fn: string;
  id?: string;
  parent?: string;
  args: Record<string, unknown>;
}

export interface BuiltProgram {
  program: {
    canvas: { name: string; width: number; height: number; grid: number };
    regions: ProgramCall[];
    content: ProgramCall[];
    visualIntent: Record<string, unknown>;
  };
  /** What the builder decided, and why. */
  notes: string[];
}

/** The region primitive for a role. Mirrors the planner's own mapping. */
function regionPrimitive(role: string): string {
  switch (role) {
    case "navigation":
      return "navigation";
    case "header":
      return "header";
    case "hero":
    case "primary-visual":
      return "hero";
    case "inspector":
      return "inspector";
    default:
      return "frame";
  }
}

/** The type-scale role a heading slot uses. */
function textRole(slot: ContentSlot): "eyebrow" | "title" | "subtitle" | "body" | "label" | "code" {
  if (slot.id.endsWith("eyebrow")) return "eyebrow";
  if (slot.id.endsWith("title")) return "title";
  if (slot.id.endsWith("description")) return "subtitle";
  if (slot.kind === "heading") return "title";
  return "body";
}

/**
 * Whether a string can wrap at all.
 *
 * A model identifier, a path, a hash or an error code has no break
 * opportunities, so wrapping it does nothing: the run is wider than the box
 * and the text runs past it. Such a string is truncated deliberately instead,
 * which keeps the layout where it was and says that the value on screen is
 * shorter than the value in the data.
 */
function isUnbreakable(text: string): boolean {
  const longest = text.split(/\s+/).reduce((max, run) => (run.length > max.length ? run : max), "");
  // A single word longer than this cannot fit a reasonable column, and no
  // amount of wrapping will help it.
  return longest.length > 28 && text.length <= longest.length + 2;
}

/** The value a metric shows when the brief supplied none. */
const NO_VALUE = "—";

/**
 * Sets every text primitive's wrapping width from the layout that was actually
 * resolved.
 *
 * ## Why this needs a second pass
 *
 * A text node's width has to be a promise: "this text wraps here". Guessing it
 * from the region's width is a guess — the region is not the column the text
 * lands in, and a header that packs three items across three columns gives the
 * title a third of the band, not all of it. Guessing wrong is not a cosmetic
 * problem either: the compiler compares the width it emitted against the box it
 * resolved, and a mismatch fails the whole build.
 *
 * So the pipeline compiles once, reads the width each text actually landed at,
 * and compiles again with those widths. The second pass resolves to the same
 * geometry (the column width does not depend on the text's content), so the
 * widths are stable rather than oscillating.
 */
export function applyMeasuredWidths(
  program: BuiltProgram["program"],
  boxes: Map<string, { id: string; x: number; y: number; w: number; h: number }>,
): { program: BuiltProgram["program"]; measured: number } {
  let measured = 0;
  const content = program.content.map((call) => {
    if (call.fn !== "text") return call;
    const box = boxes.get(call.id ?? "");
    if (box === undefined || !Number.isFinite(box.w) || box.w <= 0) return call;
    measured++;
    return { ...call, args: { ...call.args, maxWidth: Math.max(40, Math.round(box.w)) } };
  });
  return { program: { ...program, content }, measured };
}

export function buildProgram(
  brief: NormalizedBrief,
  plan: CompositionPlan,
  intelligence?: { intent: VisualIntent; notes: string[] },
): BuiltProgram {
  const notes: string[] = [];
  const slotsByRegion = new Map<string, ContentSlot[]>();
  for (const slot of plan.content) {
    const list = slotsByRegion.get(slot.regionId) ?? [];
    list.push(slot);
    slotsByRegion.set(slot.regionId, list);
  }

  const regions: ProgramCall[] = [];
  const content: ProgramCall[] = [];

  for (const region of plan.regions) {
    const slots = (slotsByRegion.get(region.id) ?? []).sort((a, b) => a.order - b.order);

    // A native auto-layout container needs children whose extent is known.
    // Text height is estimated, so a region holding text keeps absolute
    // placement — the plan says so rather than pretending.
    const allComponents = slots.length > 0 && slots.every((s) => s.primitive !== "text");
    const autoLayout = region.layoutMode === "flow-vertical" && allComponents;
    region.autoLayout = autoLayout;
    if (autoLayout) {
      notes.push(
        `Region '${region.id}' is built as a native auto-layout container: its ${slots.length} child item(s) have known extents, so Figma can re-lay them out.`,
      );
    } else if (allComponents && region.layoutMode !== "flow-vertical") {
      notes.push(
        `Region '${region.id}' holds components but keeps absolute placement: its composition is a ${region.layoutMode}, which is a grid rather than a stack.`,
      );
    }

    const inner = Math.max(40, region.bounds.w - region.padding.left - region.padding.right);

    regions.push({
      fn: regionPrimitive(region.role),
      id: region.id,
      args: {
        width: region.sizing.width,
        height: region.sizing.height,
        ...(region.grow > 0 ? { grow: region.grow } : {}),
        gap: region.gap,
        padding: region.padding.top,
        // The composition is not decoration: it is what tells the layout
        // engine that this region holds an instrument strip rather than a
        // paragraph, and dropping it turns a band into a single column.
        composition: region.composition,
        // Whether this region's content may leave it. The compiler refuses a
        // build whose content escapes a region that does not allow it, so the
        // plan has to say which regions may.
        overflow: region.constraints.overflow,
        ...(region.layoutMode === "grid" ? { layout: "grid" } : {}),
        // The column count was worked out from the region's height and the
        // number of items it holds, so the content fits instead of running
        // past the bottom of the canvas.
        ...(region.columns !== undefined && region.columns > 1 ? { columns: region.columns } : {}),
        ...(autoLayout ? { autoLayout: "vertical", layout: "flow" } : {}),
      },
    });

    for (const slot of slots) {
      const call = slotCall(slot, region, inner, brief);
      if (call !== null) content.push(call);
    }
  }

  /* --- relationships that are drawn, not just stated ---------------------- */

  // A relationship the user asked for has to be *drawn* as a relationship, and
  // it has to name the nodes it connects. A line between two guessed
  // coordinates is decoration; a connector between two named nodes is a
  // relationship, and the compiler routes it against the geometry those nodes
  // actually resolved to.
  const byLabel = new Map<string, string>();
  for (const slot of plan.content) byLabel.set(slot.label.toLowerCase(), slot.id);
  for (const slot of plan.content) byLabel.set(slot.id.toLowerCase(), slot.id);

  for (const [i, interaction] of brief.interactions.entries()) {
    const from = byLabel.get(interaction.from.toLowerCase());
    const to = byLabel.get(interaction.to.toLowerCase());
    if (from === undefined || to === undefined) {
      notes.push(
        `The interaction '${interaction.from}' → '${interaction.to}' was not drawn: it does not name two pieces of content on this screen. It is recorded in the brief and left for the composition to earn.`,
      );
      continue;
    }
    const parent = plan.content.find((s) => s.id === from)?.regionId ?? plan.regions[0]?.id;
    if (parent === undefined) continue;
    content.push({
      fn: "connector",
      id: `connector-${i + 1}`,
      parent,
      args: {
        from,
        to,
        label: interaction.kind,
        routing: "orthogonal",
      },
    });
    notes.push(`The relationship '${interaction.from}' → '${interaction.to}' is drawn as a connector between the two named nodes.`);
  }

  /* --- visual intent ------------------------------------------------------ */

  const weights: Record<string, number> = {};
  for (const h of plan.hierarchy) {
    const region = plan.regions.find((r) => r.id === h.id);
    const chrome = region?.role === "navigation" || region?.role === "header" || region?.role === "footer" || region?.role === "status-rail";
    weights[h.id] = chrome ? 0.15 : h.rank === 1 ? 0.9 : h.rank === 2 ? 0.6 : 0.35;
  }

  /**
   * Visual intent merge order (issue #22):
   * 1. the planner's own focal and per-region weights (composer of record);
   * 2. the skill layer's compiled intent — but only its density/manner fields
   *    that the runtime consumes (`shared/ir.ts` VisualIntentSchema). Style
   *    tokens (compiled, validated) replace the free-worded direction string
   *    when they exist: a resolved manner outranks the words it was derived
   *    from. When the compiled intent has no style, the brief's words ride
   *    along exactly as they did before this layer existed.
   * 3. focal/weights from the compiled intent never override the planner's —
   *    the compiler notes a discrepancy instead (see intelligence notes).
   */
  const compiled = intelligence?.intent;
  const visualIntent: Record<string, unknown> = {
    ...(plan.focal !== null ? { focal: plan.focal.id } : {}),
    visualWeight: weights,
    ...((compiled !== undefined && Object.keys(compiled).length > 0)
      ? { style: compiled.style ?? brief.visualDirection ?? undefined, density: compiled.density, rhythm: compiled.rhythm, alignment: compiled.alignment, depth: compiled.depth, contrast: compiled.contrast }
      : { ...(brief.visualDirection !== null ? { style: brief.visualDirection } : {}) }),
  };
  // Drop keys the compiled intent legitimately left unset, so the record never
  // carries explicit undefined values (strict intent parsing rejects those).
  for (const key of Object.keys(visualIntent)) {
    if ((visualIntent as Record<string, unknown>)[key] === undefined) delete (visualIntent as Record<string, unknown>)[key];
  }

  /* --- the one disclosure (issue #23 §4) ----------------------------------- */

  // The note below used to imply the screen itself was "marked illustrative".
  // Nothing was: no text node ever carried the caveat, and the gap between
  // that sentence and the screen is what pushed reviewers to demand labels on
  // every value — a caveat storm that trains the reader to skip the one
  // sentence that matters. The disclosure policy decides it exactly once:
  // one concise caption in one region, none when the caller asked for a
  // clean concept (the report keeps the truth) or the copy already discloses.
  // The note records the decision either way, so the report stays truthful
  // without the screen repeating itself.
  const disclosure = decideDisclosure(brief, plan);
  if (disclosure.call !== null) {
    content.push({
      fn: "text",
      id: disclosure.call.id,
      parent: disclosure.call.parent,
      args: { text: disclosure.call.text, role: "caption" },
    });
  }
  if (disclosure.note !== null) notes.push(disclosure.note);

  if (intelligence !== undefined && Object.keys(intelligence.intent).length > 0) {
    const fields = Object.keys(intelligence.intent).filter((k) => k !== "visualWeight");
    if (fields.length > 0) {
      notes.push(
        `The skill layer's compiled visual intent carried the build: ${fields.join(", ")}. ${intelligence.notes.length} compile note(s) name how each field was decided.`,
      );
    }
  } else if (intelligence !== undefined && intelligence.notes.length > 0) {
    notes.push(`The skill layer ran but compiled no canonical intent fields; the build uses default taste or the planner's own derivation. First note: ${intelligence.notes[0]}`);
  }

  return {
    program: {
      canvas: {
        name: plan.canvas.name,
        width: plan.canvas.width,
        height: plan.canvas.height,
        grid: plan.canvas.grid,
      },
      regions,
      content,
      visualIntent,
    },
    notes,
  };
}

/**
 * Parses a budget statement into the figures the memoryBudget primitive draws.
 *
 * Understands the shape the demo briefs state ("16 GB of 1.5 TB available") and
 * normalises the units to GB so the bar's fractions compare like with like.
 * Returns null for anything it cannot read — the caller falls back to a
 * labelled metric rather than inventing figures.
 */
function parseMemoryBudget(value: string | null): { used: number; total: number; remaining: number; unit: string } | null {
  if (value === null) return null;
  const match = value.match(/([\d.]+)\s*(B|KB|MB|GB|TB)\s+of\s+([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) return null;
  const toGB = (n: number, unit: string): number => {
    switch (unit.toUpperCase()) {
      case "TB": return n * 1024;
      case "GB": return n;
      case "MB": return n / 1024;
      case "KB": return n / (1024 * 1024);
      default: return n / (1024 * 1024 * 1024);
    }
  };
  const used = toGB(parseFloat(match[1]!), match[2]!);
  const total = toGB(parseFloat(match[3]!), match[4]!);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return { used, total, remaining: Math.max(0, total - used), unit: "GB" };
}

/** Turns one content slot into a runtime call. */
function slotCall(slot: ContentSlot, region: RegionSpec, inner: number, brief: NormalizedBrief): ProgramCall | null {  const id = slot.id;
  const parent = region.id;
  switch (slot.primitive) {
    case "text":
      return {
        fn: "text",
        id,
        parent,
        args: {
          // A text slot is the fallback primitive for long labels; when the
          // brief supplied a demo value for the information, dropping it would
          // ship the label with no answer under it — the "—" symptom. The
          // value rides on the same content, separated by an em dash.
          text: slot.value !== null ? `${slot.label} — ${slot.value}` : slot.label,
          role: textRole(slot),
          // The wrapping width is set from the resolved layout in a second
          // pass (see applyMeasuredWidths): the column a text lands in is not
          // the region's width, and guessing it makes the compiler's own
          // geometry check fail.
          ...(isUnbreakable(slot.label) ? { truncate: true } : {}),
        },
      };
    case "button":
      return {
        fn: "button",
        id,
        parent,
        args: {
          label: slot.label,
          variant: slot.kind === "action" && slot.id.includes("primary") ? "primary" : "secondary",
        },
      };
    case "metric":
      return {
        fn: "metric",
        id,
        parent,
        args: {
          label: slot.label,
          value: slot.value ?? NO_VALUE,
          ...(slot.value === null ? { valueStyle: "technical" } : {}),
        },
      };
    case "statusPill":
      return {
        fn: "statusPill",
        id,
        parent,
        args: { label: slot.label, ...(slot.states !== undefined ? { states: slot.states } : {}) },
      };
    case "modelRow":
      return {
        fn: "modelRow",
        id,
        parent,
        args: { title: slot.label, ...(slot.value !== null ? { value: slot.value } : {}) },
      };
    case "fitGauge": {
      // A verdict from the brief's own demo value: "Fits · 1.48 TB headroom"
      // becomes fits:true, verdict "Fits", detail "1.48 TB headroom". No value
      // means no evidence for a verdict — the honest fallback is the metric
      // placeholder, never a fabricated fit.
      const value = slot.value ?? "";
      const parts = value.split("·").map((s) => s.trim()).filter(Boolean);
      const fits = /\bfits\b/i.test(value) && !/does not fit|doesn'?t fit|no fit/i.test(value);
      if (value === "") return { fn: "metric", id, parent, args: { label: slot.label, value: NO_VALUE, valueStyle: "technical" } };
      return {
        fn: "fitGauge",
        id,
        parent,
        // The information label rides on the detail line, so the required
        // information stays findable on the screen — the gauge answers it.
        args: { fits, verdict: parts[0] ?? "Fits", detail: `${slot.label} — ${parts.slice(1).join(" · ")}` },
      };
    }
    case "memoryBudget": {
      // "16 GB of 1.5 TB available" becomes a budget bar: required 16, available
      // 1536 GB, headroom 1520. The units normalise to GB so the bar's fractions
      // are honest. Anything unparseable falls back to the labelled metric.
      const budget = parseMemoryBudget(slot.value);
      if (budget === null) {
        return { fn: "metric", id, parent, args: { label: slot.label, value: slot.value ?? NO_VALUE, ...(slot.value === null ? { valueStyle: "technical" } : {}) } };
      }
      return {
        fn: "memoryBudget",
        id,
        parent,
        // The readout states the figures, so the labels stay the figures too:
        // word labels ("Required / Available GB used") read as soup where the
        // numbers ("16 / 1536 GB used") read as a readout. The caption naming
        // the information is the title.
        args: { title: slot.label, ...budget },
      };
    }
    case "panel":
      return { fn: "panel", id, parent, args: { title: slot.label } };
    case "sectionHeader":
      return { fn: "sectionHeader", id, parent, args: { title: slot.label } };
    case "timelineEvent":
      return {
        fn: "timelineEvent",
        id,
        parent,
        // The event's when rides on the brief's demo value; a hardcoded dash
        // dropped it, so every timeline slot rendered the same dead "—".
        args: { title: slot.label, date: slot.value ?? "—" },
      };
    case "deviceNode":
      return { fn: "deviceNode", id, parent, args: { label: slot.label } };
    default:
      return null;
  }
}
