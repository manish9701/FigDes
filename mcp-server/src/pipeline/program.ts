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
 */
import type { CompositionPlan, ContentSlot, NormalizedBrief, RegionSpec } from "./contracts";

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

export function buildProgram(brief: NormalizedBrief, plan: CompositionPlan): BuiltProgram {
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

  const visualIntent: Record<string, unknown> = {
    ...(plan.focal !== null ? { focal: plan.focal.id } : {}),
    visualWeight: weights,
    ...(brief.visualDirection !== null ? { style: brief.visualDirection } : {}),
  };

  if (brief.data.illustrative) {
    notes.push(
      "The brief does not say the data is live, so every value on this screen is a placeholder and is marked illustrative. Real numbers were not invented.",
    );
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

/** Turns one content slot into a runtime call. */
function slotCall(slot: ContentSlot, region: RegionSpec, inner: number, brief: NormalizedBrief): ProgramCall | null {
  const id = slot.id;
  const parent = region.id;
  switch (slot.primitive) {
    case "text":
      return {
        fn: "text",
        id,
        parent,
        args: {
          text: slot.label,
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
    case "panel":
      return { fn: "panel", id, parent, args: { title: slot.label } };
    case "timelineEvent":
      return { fn: "timelineEvent", id, parent, args: { title: slot.label, date: "—" } };
    case "deviceNode":
      return { fn: "deviceNode", id, parent, args: { label: slot.label } };
    default:
      return null;
  }
}
