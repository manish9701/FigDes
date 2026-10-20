/**
 * Stage 2 — the composition plan (issue #16, §Stage 2).
 *
 * ## What a plan owes its reader
 *
 * "A 1440x900 frame with three regions" is not a plan. A plan is a set of
 * regions where each one says **why it exists**, what it carries, how it is
 * sized, what it may overflow, and how it behaves when the viewport changes —
 * together with the answer to the questions a designer asks first:
 *
 *   - what should attract attention first?
 *   - what is the primary task?
 *   - which areas need the most canvas?
 *   - what is supporting information?
 *   - which relationships must be visually obvious?
 *
 * The plan is built on the same planner `plan_screen` uses, so the geometry it
 * promises is the geometry the build produces. What this module adds is the
 * part the planner does not carry: a region *tree* with parents, order, bounds,
 * layout mode, padding, gap, alignment, responsive behaviour, content
 * hierarchy, density, constraints, priority and interaction — and the content
 * slots that fill each region, so the screen is reviewable before a node
 * exists.
 */
import { planScreen, type ScreenIntent } from "../plan/planner";
import { defaultGutter, layoutRegions } from "../runtime/layout";
import { classifyInformation, classifyInfoItem, type InfoKind } from "../design/composition/derive";
import type { Composition } from "../runtime/layout";
import type { ContentSlot, CompositionPlan, NormalizedBrief, RegionSpec } from "./contracts";

/** Grid unit used when the brief does not name one. */
const GRID = 8;

/** Which region role a piece of information prefers, most preferred first. */
const KIND_REGION_PREFERENCE: Record<InfoKind, string[]> = {
  signal: ["status-rail", "secondary", "content", "inspector", "primary-visual"],
  attribute: ["secondary", "content", "inspector", "primary-visual"],
  option: ["content", "primary-visual", "secondary", "inspector"],
  relationship: ["primary-visual", "content", "secondary"],
  setting: ["inspector", "secondary", "content"],
  event: ["secondary", "content", "inspector"],
  detail: ["inspector", "secondary", "content"],
  unknown: ["secondary", "content", "primary-visual"],
};

/**
 * How many content items a region can hold.
 *
 * A region is not a bucket. A status rail is a *strip*: three readouts across
 * a band, not a list. Filling a 64px strip with eight items does not make a
 * denser screen, it makes a taller one — and a taller one runs off the canvas.
 * So every region has a capacity, and an item that does not fit goes somewhere
 * that can hold it.
 */
const REGION_CAPACITY: Record<string, number> = {
  "status-rail": 3,
  header: 3,
  navigation: 2,
  "primary-visual": 6,
  hero: 6,
  inspector: 6,
  content: 24,
  secondary: 12,
  footer: 4,
  custom: 12,
};

/**
 * Above this many items of one kind, the items stop being cards and become
 * rows.
 *
 * The product's own rule forbids a wall of repeated metric cards, and a dense
 * screen that answers with thirty cards is that wall. The same information
 * drawn as rows reads as a table, which is what thirty items actually are.
 */
const DENSE_THRESHOLD = 3;

/** A label longer than this cannot live inside a component that cannot wrap. */
const LONG_LABEL = 40;

/**
 * The height each primitive occupies in a flow.
 *
 * The compiler knows these exactly (a hug component knows its own size; the
 * fixed ones have a fixed height), so the pipeline uses the same numbers to
 * decide whether an item fits. An estimate that disagreed with the compiler
 * would put content off the canvas, which is the failure this whole stage
 * exists to prevent.
 */
const PRIMITIVE_HEIGHT: Record<string, number> = {
  metric: 90,
  modelRow: 90,
  panel: 90,
  timelineEvent: 90,
  deviceNode: 80,
  statusPill: 22,
  button: 40,
  text: 40,
  navItem: 36,
};

/**
 * The natural width of a primitive.
 *
 * The compiler knows these sizes exactly (a hug component measures its own
 * label; the fixed ones have a fixed width), so the pipeline uses the same
 * numbers to decide how many columns a region can afford. A column narrower
 * than the content it holds is how a heading ends up clipped.
 */
const PRIMITIVE_WIDTH: Record<string, number> = {
  statusPill: 120,
  button: 120,
  text: 160,
  navItem: 180,
  deviceNode: 128,
  metric: 200,
  modelRow: 200,
  panel: 200,
  timelineEvent: 200,
};

/* -------------------------------------------------------------------------- */

/**
 * The primitive that carries each kind of information.
 *
 * Two rules override the kind:
 *
 * - a long label becomes plain text, because a component's own label cannot
 *   wrap and a 66-character model id inside a 358px card overflows it;
 * - a dense region uses rows, because thirty cards are a wall and thirty rows
 *   are a table.
 */
function primitiveFor(kind: InfoKind, label: string, composition: Composition, dense: boolean): string {
  if (label.length > LONG_LABEL) {
    // A model id, an error message, a device name: technical, so it reads in
    // a monospaced face and wraps where the pipeline measured it to wrap.
    return "text";
  }
  if (dense) {
    switch (kind) {
      case "event":
        return "timelineEvent";
      case "relationship":
        return composition === "topology" || composition === "diagram" ? "deviceNode" : "modelRow";
      default:
        return "modelRow";
    }
  }
  switch (kind) {
    case "signal":
      return /health|status|state|online|offline|pressure|ready|degraded/i.test(label) ? "statusPill" : "metric";
    case "attribute":
      return "metric";
    case "option":
      // In a diagram, the things that are *in* the diagram are its nodes; in a
      // table, the same things are its rows.
      return composition === "topology" || composition === "diagram" ? "deviceNode" : "modelRow";
    case "relationship":
      // The relationship itself is what the diagram *shows*, so in a diagram it
      // is the field's label and the edges between the nodes; elsewhere it is a
      // panel that names it.
      return composition === "topology" || composition === "diagram" ? "sectionHeader" : "panel";
    case "setting":
      return "panel";
    case "event":
      return "timelineEvent";
    case "detail":
      return "panel";
    default:
      return "panel";
  }
}

function paddingOf(padding: number | { top?: number; right?: number; bottom?: number; left?: number } | undefined, grid: number) {
  if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === "number") return { top: padding, right: padding, bottom: padding, left: padding };
  return {
    top: padding.top ?? grid,
    right: padding.right ?? grid,
    bottom: padding.bottom ?? grid,
    left: padding.left ?? grid,
  };
}

function layoutModeFor(composition: Composition, layout: string | undefined): RegionSpec["layoutMode"] {
  if (layout === "grid" || layout === "masonry") return "grid";
  if (composition === "topology" || composition === "spatial" || composition === "diagram" || composition === "canvas") return "free";
  if (layout === "timeline" || composition === "timeline" || composition === "sequence") return "flow-horizontal";
  if (composition === "table") return "grid";
  return "flow-vertical";
}

/**
 * The empty band analysis.
 *
 * A composed screen does not have to fill the canvas — but an unexplained
 * third of it usually means the composition gave up half way. The measure is
 * the largest horizontal band of the canvas that no region covers.
 */
function largestEmptyBand(boxes: Array<{ x: number; y: number; w: number; h: number }>, width: number, height: number): number {
  if (boxes.length === 0) return 1;
  const bands: Array<{ top: number; bottom: number }> = [];
  for (const b of boxes) bands.push({ top: b.y, bottom: b.y + b.h });
  bands.sort((a, b) => a.top - b.top);
  let cursor = 0;
  let largest = 0;
  for (const band of bands) {
    if (band.top > cursor) largest = Math.max(largest, band.top - cursor);
    cursor = Math.max(cursor, band.bottom);
  }
  if (cursor < height) largest = Math.max(largest, height - cursor);
  return height === 0 ? 0 : largest / height;
}

/**
 * Builds the composition plan from a normalized brief.
 *
 * The planner does the classification and the geometry; this module turns the
 * result into a reviewable tree and adds the content slots, the canvas usage
 * analysis and the per-region contract.
 */
export function buildCompositionPlan(brief: NormalizedBrief, planId = "plan"): CompositionPlan {
  const canvas = { width: brief.viewport.width, height: brief.viewport.height, grid: GRID, name: brief.screen };

  const intent: ScreenIntent = {
    primaryDecision: brief.primaryDecision,
    goal: brief.purpose,
    audience: brief.audience,
    availableInformation: [...brief.requiredInformation, ...brief.optionalInformation],
    existingPatterns: brief.existingPatterns,
    ...(brief.visualDirection !== null ? { visualDirection: brief.visualDirection } : {}),
    ...(brief.desiredComposition !== undefined ? { desiredComposition: brief.desiredComposition } : {}),
    canvas: { width: canvas.width, height: canvas.height, grid: canvas.grid },
    name: canvas.name,
  };

  const plan = planScreen(intent);
  const warnings: string[] = [...plan.warnings];

  /* --- the screen needs somewhere to put its identity --------------------- */

  // The planner's shells are derived from the decision, and not every one of
  // them has a header: a monitoring screen is a status strip over a field, a
  // topology screen is a canvas. That is right for the *content* — but the
  // screen still has a name, a task and a primary action, and without a band
  // to hold them they land in the navigation rail, which is 208px wide and
  // meant for wayfinding. A title in a 53px column is not a title.
  //
  // So the pipeline adds the band when the plan has nowhere to put the
  // identity, and re-resolves the layout with it. The composition is the
  // pipeline's job; the planner's region list is its starting point.
  const shell = plan.regions.map((r) => ({
    id: r.id,
    role: r.role,
    composition: r.composition,
    width: r.width as number | "fill" | "hug",
    height: r.height as number | "fill" | "hug",
    grow: r.grow,
    gap: r.gap,
    padding: r.padding as number | undefined,
  }));
  const hasIdentityBand = shell.some((r) => r.role === "header" || r.role === "status-rail");
  if (!hasIdentityBand) {
    shell.unshift({
      id: "header",
      role: "header",
      composition: "editorial",
      width: "fill",
      height: 88,
      grow: 0,
      gap: 16,
      padding: 24,
    });
    warnings.push(
      "The plan had no band for the screen's identity, so the pipeline added a header: the name, the task and the primary action need somewhere to go that is not the navigation rail.",
    );
  }

  // The geometry is re-resolved with the same engine the compiler uses, so
  // the plan's numbers and the build's numbers are the same numbers.
  const laid = layoutRegions({
    regions: shell as unknown as Parameters<typeof layoutRegions>[0]["regions"],
    canvasW: canvas.width,
    canvasH: canvas.height,
    gutter: defaultGutter(canvas.grid),
  });
  const boxOf = new Map(laid.map((r) => [r.id, r]));

  const boxes = new Map(plan.boxes.map((b) => [b.name, b]));
  const hierarchy = [...plan.artDirection.hierarchy];
  const focalId = plan.artDirection.focal?.id ?? null;
  if (!hasIdentityBand) {
    hierarchy.push({
      rank: hierarchy.length + 1,
      id: "header",
      why: "the screen's identity and its primary action: chrome, and never the thing the eye lands on",
    });
  }

  /* --- regions ----------------------------------------------------------- */

  const regions: RegionSpec[] = plan.regions.map((r, index) => {
    const box = boxes.get(r.id);
    const rank = hierarchy.find((h) => h.id === r.id)?.rank ?? index + 1;
    const width = r.width as number | "fill" | "hug";
    const height = r.height as number | "fill" | "hug";
    const layoutMode = layoutModeFor(r.composition, (r as { layout?: string }).layout);
    const padding = paddingOf(r.padding as number | undefined, canvas.grid);
    const gap = r.gap ?? canvas.grid;
    const role = r.role;

    // Overflow: a region that holds a diagram may let its edges run out; a
    // region holding a table may not. The rule is per role, and it is written
    // down so the reviewer can disagree with it.
    const overflow: RegionSpec["constraints"]["overflow"] =
      role === "primary-visual" || role === "hero" ? "allow" : role === "navigation" || role === "header" ? "clip" : "forbid";

    return {
      id: r.id,
      role,
      composition: r.composition,
      parent: null,
      order: index,
      bounds: { x: box?.x ?? 0, y: box?.y ?? 0, w: box?.w ?? 0, h: box?.h ?? 0 },
      layoutMode,
      sizing: { width, height },
      grow: r.grow,
      padding,
      gap,
      align: { primary: "start", counter: "start" },
      responsive: {
        priority: rank,
        behavior:
          width === "fill"
            ? "fills the space the other regions leave; collapses last"
            : "keeps its declared size; collapses first when the viewport narrows",
      },
      contentHierarchy: [],
      density: gap <= 12 ? "high" : gap >= 32 ? "low" : "medium",
      relationships: [],
      primitives: [],
      constraints: { overflow },
      priority: rank,
      interaction: interactionFor(role),
      why: r.because,
      autoLayout: false,
    };
  });

  // The header the pipeline added, with the geometry the layout resolved.
  if (!hasIdentityBand) {
    const laid_ = boxOf.get("header");
    regions.unshift({
      id: "header",
      role: "header",
      composition: "editorial",
      parent: null,
      order: 0,
      bounds: { x: laid_?.x ?? 0, y: laid_?.y ?? 0, w: laid_?.w ?? canvas.width, h: laid_?.h ?? 88 },
      layoutMode: "flow-vertical",
      sizing: { width: "fill", height: 88 },
      grow: 0,
      padding: { top: 24, right: 24, bottom: 24, left: 24 },
      gap: 16,
      align: { primary: "start", counter: "start" },
      responsive: { priority: hierarchy.length, behavior: "keeps its band; collapses first when the viewport narrows" },
      contentHierarchy: [],
      density: "low",
      relationships: [],
      primitives: [],
      constraints: { overflow: "clip" },
      priority: hierarchy.length,
      interaction: "the screen's primary action, and its identity",
      why: "the screen's name, its task and the action it exists for: a band of its own, so the navigation rail can stay a wayfinding rail",
      autoLayout: false,
    });
    // The other regions moved down by the height of the band, so their
    // geometry is re-read from the layout rather than from the planner.
    for (const region of regions) {
      if (region.id === "header") continue;
      const box = boxOf.get(region.id);
      if (box === undefined) continue;
      region.bounds = { x: box.x, y: box.y, w: box.w, h: box.h };
    }
  }

  /* --- a region for the relationships ------------------------------------- */

  // A brief whose information is about relationships needs somewhere to *draw*
  // them. A table region cannot: a relationship drawn as a table row is a list,
  // not a diagram, and the planner picks the shell from the decision's
  // phrasing — so "inspect the cluster routing" plans a list even when the
  // brief's whole point is the routing.
  //
  // So the pipeline gives the relationships a region of their own, in the
  // composition that can draw them, and moves the rest of the information into
  // a supporting region beside it. The relationships become the focal
  // visualisation, which is what the brief asked for.
  const relationshipItems = brief.requiredInformation.filter((i) => classifyInfoItem(i) === "relationship");
  const hasDiagramRegion = regions.some((r) => r.composition === "topology" || r.composition === "spatial" || r.composition === "diagram");
  if (relationshipItems.length > 0 && !hasDiagramRegion) {
    const host = regions.find((r) => r.role === "primary-visual" || r.role === "content" || r.role === "secondary");
    if (host !== undefined) {
      // The host becomes the diagram: same place on the canvas, the
      // composition that can draw a relationship.
      host.composition = "topology";
      host.layoutMode = "free";
      host.role = "primary-visual";
      host.grow = 2;
      host.why = `the relationships the brief names (${relationshipItems.join(", ")}): a diagram, because a relationship drawn as a row is a list, not a relationship`;
      host.interaction = "select a node and follow the relationships out of it";
      host.constraints = { ...host.constraints, overflow: "allow" };
      // Everything else needs somewhere to live, or the diagram region ends up
      // holding a table of readouts around the diagram.
      const support: RegionSpec = {
        id: "support",
        role: "secondary",
        composition: "table",
        parent: null,
        order: host.order + 1,
        bounds: { x: host.bounds.x, y: host.bounds.y, w: host.bounds.w, h: host.bounds.h },
        layoutMode: "grid",
        sizing: { width: "fill", height: "fill" },
        grow: 1,
        padding: { top: 24, right: 24, bottom: 24, left: 24 },
        gap: 16,
        align: { primary: "start", counter: "start" },
        responsive: { priority: host.priority + 1, behavior: "fills the space the diagram leaves; collapses first when the viewport narrows" },
        contentHierarchy: [],
        density: "medium",
        relationships: [],
        primitives: [],
        constraints: { overflow: "forbid" },
        priority: host.priority + 1,
        interaction: "read the readouts that support the diagram",
        why: "the readouts, summaries and activity that support the diagram without competing with it",
        autoLayout: false,
      };
      regions.push(support);
      // The new region has to be in the hierarchy too, or the visual direction
      // does not reach it — the weight map is built from the hierarchy.
      hierarchy.push({
        rank: hierarchy.length + 1,
        id: "support",
        why: "the readouts that support the diagram: subordinate to it, and never competing with it",
      });
      support.priority = hierarchy.length;
      support.responsive.priority = hierarchy.length;
      warnings.push(
        `The brief names relationships (${relationshipItems.join(", ")}), so the composition gave them a diagram region ('${host.id}') and moved the supporting information into 'support'.`,
      );
      // The layout is re-resolved: the screen now has one more region, and the
      // numbers have to come from the engine rather than from the old plan.
      const relaid = layoutRegions({
        regions: regions.map((r) => ({
          id: r.id,
          role: r.role,
          composition: r.composition,
          width: r.sizing.width,
          height: r.sizing.height,
          grow: r.grow,
          gap: r.gap,
          padding: r.padding.top,
        })) as unknown as Parameters<typeof layoutRegions>[0]["regions"],
        canvasW: canvas.width,
        canvasH: canvas.height,
        gutter: defaultGutter(canvas.grid),
      });
      for (const region of regions) {
        const box = relaid.find((x) => x.id === region.id);
        if (box === undefined) continue;
        region.bounds = { x: box.x, y: box.y, w: box.w, h: box.h };
      }
    }
  }

  /* --- content slots ----------------------------------------------------- */

  const { slots: content, notPlaced } = planContent(brief, regions, plan.composition);
  const byRegion = new Map<string, ContentSlot[]>();
  for (const slot of content) {
    const list = byRegion.get(slot.regionId) ?? [];
    list.push(slot);
    byRegion.set(slot.regionId, list);
  }
  for (const region of regions) {
    const slots = (byRegion.get(region.id) ?? []).sort((a, b) => a.order - b.order);
    region.contentHierarchy = slots.map((s) => s.id);
    region.primitives = [...new Set(slots.map((s) => s.primitive))];
  }

  /* --- relationships ----------------------------------------------------- */

  const relationships = plan.artDirection.hierarchy;
  for (const region of regions) {
    region.relationships = relationships
      .filter((h) => h.id !== region.id)
      .map((h) => ({
        id: `rel-${region.id}-${h.id}`,
        to: h.id,
        meaning: h.why,
        importance: h.rank <= 2 ? "primary" : "secondary",
      }));
  }

  /* --- canvas usage ------------------------------------------------------ */

  const canvasArea = canvas.width * canvas.height;
  const coveredArea = regions.reduce((sum, r) => sum + r.bounds.w * r.bounds.h, 0);
  const coverage = canvasArea === 0 ? 0 : coveredArea / canvasArea;
  const empty = largestEmptyBand(regions.map((r) => r.bounds), canvas.width, canvas.height);
  const focal = regions.find((r) => r.id === focalId);
  const focalShare = focal && canvasArea > 0 ? (focal.bounds.w * focal.bounds.h) / canvasArea : 0;

  const usageNotes: string[] = [];
  if (coverage < 0.55) {
    usageNotes.push(
      `The regions cover ${Math.round(coverage * 100)}% of the canvas. Either the screen is deliberately spare, or the composition stopped short of the space it was given.`,
    );
  }
  if (empty > 0.25) {
    usageNotes.push(
      `A ${Math.round(empty * 100)}% horizontal band of the canvas is empty. On a screen this size that band reads as an unfinished composition rather than as breathing room.`,
    );
  }
  if (focal !== undefined && focalShare > 0 && focalShare < 0.08) {
    usageNotes.push(
      `The focal region '${focal.id}' occupies ${Math.round(focalShare * 100)}% of the canvas. The primary thing is too small to lead the screen.`,
    );
  }
  if (focal === undefined) {
    usageNotes.push("No region earns focal status. The screen has no first thing to look at.");
  }

  return {
    id: planId,
    canvas,
    composition: plan.composition,
    regions,
    content,
    focal: plan.artDirection.focal,
    hierarchy,
    usage: {
      canvasArea,
      coveredArea,
      coverage,
      largestEmptyBand: empty,
      focalShare,
      notes: usageNotes,
    },
    notPlaced,
    derivation: plan.derivation,
    artDirection: plan.artDirection,
    execution: plan.execution,
    warnings,
  };
}

function interactionFor(role: string): string | null {
  switch (role) {
    case "navigation":
      return "move between sections of the product";
    case "header":
      return "the screen's primary action, and its identity";
    case "primary-visual":
    case "hero":
      return "select and inspect what is shown here";
    case "inspector":
      return "read the detail of the current selection, and change it";
    case "content":
      return "read and act on the listed information";
    case "status-rail":
      return "read the state of the whole at a glance";
    default:
      return null;
  }
}

/**
 * Places the brief's information into regions.
 *
 * The information decides where it goes; the region decides how it is drawn.
 * Three constraints shape the placement:
 *
 * - **capacity.** A status rail is a strip, not a bucket. An item that does
 *   not fit the region it prefers goes to the region that can hold it.
 * - **density.** A region holding many items of one kind draws them as rows,
 *   because thirty cards are a wall and thirty rows are a table.
 * - **room.** The region has a measured height, and an item that does not fit
 *   in it is not drawn there. Optional information yields to the canvas;
 *   required information does not, and the overflow is reported instead of
 *   being hidden.
 *
 * An item that matches no region preference lands in the region with the most
 * room, because a stated requirement that is silently dropped is worse than
 * one that lands in the least specific place.
 */
/**
 * Places the brief's information into regions.
 *
 * The information decides where it goes; the region decides how it is drawn.
 * Three constraints shape the placement:
 *
 * - **preference.** Each kind of information prefers a kind of region: a
 *   relationship belongs in the visual field, a setting in the inspector, a
 *   signal in the strip that reports the state of everything.
 * - **density.** A region holding many items of one kind draws them as rows,
 *   because thirty cards are a wall and thirty rows are a table.
 * - **room.** A region has a measured height. The number of columns it uses is
 *   worked out from that height and the number of items, so the content fits
 *   the region instead of running past it. When even that is not enough,
 *   optional information yields to the canvas and required information is
 *   reported rather than quietly dropped.
 */
function planContent(brief: NormalizedBrief, regions: RegionSpec[], composition: Composition): {
  slots: ContentSlot[];
  notPlaced: Array<{ label: string; why: string }>;
} {
  const slots: ContentSlot[] = [];
  const notPlaced: Array<{ label: string; why: string }> = [];
  const all = [...brief.requiredInformation, ...brief.optionalInformation];
  const classified = classifyInformation(all);

  const isRequired = (text: string): boolean =>
    brief.requiredInformation.some((r) => r.toLowerCase() === text.toLowerCase());

  /* --- the identity and action slots, and their region -------------------- */

  // A page header carries the screen's name, what it is for, and the action it
  // exists for. The product mark belongs to the navigation rail, not the
  // header: putting it in the header spends a third of the band on a word the
  // user already knows.
  //
  // A screen with no header region has a status rail instead, and the rail
  // becomes the command bar. That is the same three items in a different
  // band, and it is the reason the rail holds so little.
  const headerRegion = regions.find((r) => r.role === "header") ?? regions.find((r) => r.role === "status-rail") ?? regions[0];
  const navRegion = regions.find((r) => r.role === "navigation");

  /* --- phase 1: where each item would like to go -------------------------- */

  /** The items assigned to each region, in order. */
  const assigned = new Map<string, Array<{ text: string; kind: ContentSlot["kind"]; primitive: string; required: boolean; weight: number }>>();
  const add = (regionId: string, entry: { text: string; kind: ContentSlot["kind"]; primitive: string; required: boolean; weight: number }): void => {
    const list = assigned.get(regionId) ?? [];
    list.push(entry);
    assigned.set(regionId, list);
  };

  // The identity and the action are placed first, so the room they take is
  // reserved before the data competes for it. A rail that fits three readouts
  // is a strip; a rail that fits three readouts *and* a title is a band that
  // grows, and a band that grows runs off the canvas.
  //
  // The *weight* is what decides what moves when the band is too small. The
  // name and the primary action are the screen's job, so they are the last
  // things to be moved; the description is supporting copy, so it goes first.
  if (headerRegion !== undefined) {
    add(headerRegion.id, { text: brief.screen, kind: "heading", primitive: "text", required: true, weight: 0 });
    add(headerRegion.id, { text: brief.purpose, kind: "heading", primitive: "text", required: true, weight: 3 });
    if (brief.primaryAction !== null) {
      add(headerRegion.id, { text: brief.primaryAction, kind: "action", primitive: "button", required: true, weight: 0 });
    }
  }

  for (const item of classified) {
    const regionId = pickRegion(item.kind, regions);
    if (regionId === null) continue;
    // The primitive follows the *region's* composition, not the screen's: a
    // device in a diagram is a node in the diagram, and the same word in a
    // table is a row in the table.
    const host = regions.find((r) => r.id === regionId);
    add(regionId, {
      text: item.text,
      kind: item.kind,
      primitive: primitiveFor(item.kind, item.text, host?.composition ?? composition, false),
      required: isRequired(item.text),
      weight: isRequired(item.text) ? 1 : 2,
    });
  }

  /* --- phase 2: fit each region, and move or drop what does not fit ------- */

  const innerHeight = (region: RegionSpec): number =>
    Math.max(0, region.bounds.h - region.padding.top - region.padding.bottom);

  /**
   * How many columns a region can use.
   *
   * The compiler packs a region's content into columns and wraps down. How
   * many columns it uses is the difference between a table that fits and a
   * list that runs off the bottom of the canvas, so the pipeline works it out
   * from the region's height and the number of items: enough columns for the
   * items to sit in the rows the region actually has.
   *
   * The width sets the ceiling. A column narrower than the content it holds
   * is how a heading ends up clipped, so a strip cannot be split into twelve
   * columns just because twelve items want to be in it.
   */
  const columnsFor = (region: RegionSpec, count: number, itemHeight: number, minWidth: number): number => {
    const inner = innerHeight(region);
    const rows = Math.max(1, Math.floor((inner + region.gap) / (itemHeight + region.gap)));
    const innerWidth = Math.max(0, region.bounds.w - region.padding.left - region.padding.right);
    const affordable = Math.max(1, Math.floor((innerWidth + region.gap) / (minWidth + region.gap)));
    return Math.max(1, Math.min(12, affordable, Math.ceil(count / rows)));
  };

  const maxHeight = (entries: Array<{ primitive: string }>): number =>
    entries.reduce((max, e) => Math.max(max, PRIMITIVE_HEIGHT[e.primitive] ?? 90), 0);

  const maxWidth = (entries: Array<{ primitive: string }>): number =>
    entries.reduce((max, e) => Math.max(max, PRIMITIVE_WIDTH[e.primitive] ?? 200), 0);

  /**
   * How many items a region can hold, and how it would arrange them.
   *
   * The capacity is the *widest* arrangement the region can afford: the
   * columns are recomputed from the final count, but the room a region has
   * for one more item is the room it has at its widest. A region holding
   * exactly three columns' worth of items still has room in a fourth.
   */
  const capacityOf = (region: RegionSpec, entries: Array<{ primitive: string }>): { rows: number; columns: number; capacity: number } => {
    if (entries.length === 0) return { rows: 1, columns: 1, capacity: 0 };
    const itemHeight = maxHeight(entries);
    const rows = Math.max(1, Math.floor((innerHeight(region) + region.gap) / (itemHeight + region.gap)));
    const innerWidth = Math.max(0, region.bounds.w - region.padding.left - region.padding.right);
    const minWidth = maxWidth(entries);
    const affordable = Math.max(1, Math.min(12, Math.floor((innerWidth + region.gap) / (minWidth + region.gap))));
    const columns = Math.max(1, Math.min(affordable, Math.ceil(entries.length / rows)));
    return { rows, columns, capacity: affordable * rows };
  };

  // Move what does not fit until it does, or until nothing can hold it.
  //
  // Optional information yields to the canvas: it is dropped, and reported.
  // Required information does not: it moves to a region that has room, and
  // only when no region has room is it reported as a blocker. A brief that
  // cannot be satisfied has to say so rather than build a screen that quietly
  // omits what the user asked for.
  for (let pass = 0; pass < 6; pass++) {
    let movedSomething = false;

    for (const region of regions) {
      const entries = assigned.get(region.id) ?? [];
      if (entries.length === 0) continue;
      const { capacity } = capacityOf(region, entries);
      if (entries.length <= capacity) continue;

      // The least important first: supporting copy before supporting data,
      // supporting data before required data, and the screen's name and its
      // primary action last, because those two *are* the screen.
      const ordered = entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => b.entry.weight - a.entry.weight || Number(a.entry.required) - Number(b.entry.required) || b.index - a.index)
        .map((x) => x.entry);
      while ((assigned.get(region.id) ?? []).length > capacity) {
        const candidate = ordered.shift();
        if (candidate === undefined) break;
        const others = regions
          .filter((r) => r.id !== region.id)
          .map((r) => {
            const list = assigned.get(r.id) ?? [];
            const room = capacityOf(r, list).capacity - list.length;
            return { region: r, room };
          })
          .filter((c) => c.room > 0)
          .sort((a, b) => b.room - a.room);
        const target = others[0];
        if (target !== undefined) {
          assigned.set(region.id, (assigned.get(region.id) ?? []).filter((e) => e !== candidate));
          add(target.region.id, candidate);
          movedSomething = true;
          continue;
        }
        // Nowhere left to put it.
        assigned.set(region.id, (assigned.get(region.id) ?? []).filter((e) => e !== candidate));
        notPlaced.push({
          label: candidate.text,
          why: candidate.required
            ? `No region on this screen has room for it. The brief asks for more than the canvas can hold.`
            : `'${region.id}' has no room for it, and supporting information yields to the canvas.`,
        });
      }
    }

    if (!movedSomething) break;
  }

  for (const region of regions) {
    const entries = assigned.get(region.id) ?? [];
    if (entries.length === 0) continue;
    const { columns } = capacityOf(region, entries);
    region.columns = columns;
  }

  /* --- phase 3: the slots -------------------------------------------------- */

  let order = 0;
  for (const region of regions) {
    const entries = assigned.get(region.id) ?? [];
    for (const entry of entries) {
      const value = brief.values[entry.text] ?? null;
      const heading = entry.kind === "heading" || entry.kind === "action";
      slots.push({
        id:
          entry.kind === "heading"
            ? entry.text === brief.screen
              ? "slot-heading-title"
              : entry.text === brief.purpose
                ? "slot-heading-description"
                : `slot-heading-${slug(entry.text)}`
            : entry.kind === "action"
              ? entry.text === brief.primaryAction
                ? "slot-action-primary"
                : `slot-action-${slug(entry.text)}`
              : `slot-${order + 1}-${slug(entry.text)}`,
        regionId: region.id,
        kind: entry.kind,
        label: entry.text,
        primitive: entry.primitive,
        value,
        order: heading ? -10 + order : order,
        because: heading
          ? entry.kind === "action"
            ? `The action the screen exists for: '${entry.text}'.`
            : "Names the screen and states its task in the user's words."
          : entry.required
            ? `Required for the decision: '${entry.text}'.`
            : `Supporting information: '${entry.text}', useful but not needed to act.`,
        illustrative: value === null,
      });
      order++;
    }
  }

  if (navRegion !== undefined && brief.product !== null) {
    slots.push({
      id: "slot-heading-eyebrow",
      regionId: navRegion.id,
      kind: "heading",
      label: brief.product,
      primitive: "text",
      value: null,
      order: -20,
      because: "Names the product at the top of the rail, where the user expects to find it.",
      illustrative: false,
    });
  }

  for (const [i, action] of brief.secondaryActions.entries()) {
    if (headerRegion === undefined) continue;
    slots.push({
      id: `slot-action-secondary-${i + 1}`,
      regionId: headerRegion.id,
      kind: "action",
      label: action,
      primitive: "button",
      value: null,
      order: 1001 + i,
      because: `A secondary action, subordinate to '${brief.primaryAction ?? "the primary action"}'.`,
      illustrative: false,
    });
  }

  /* --- density: a repeated readout is a row, not a card ------------------- */

  // Thirty items in one region cannot be thirty cards: that is the wall the
  // product rules forbid, and it is also a screen nobody can scan. The same
  // information drawn as rows reads as the table it actually is.
  //
  // The limit is on the whole screen, not on a region: two metric cards and a
  // table of everything else is an instrument; two metric cards in every
  // region is a card wall.
  let metrics = 0;
  for (const slot of slots) {
    if (slot.primitive !== "metric") continue;
    metrics++;
    if (metrics <= 2) continue;
    slot.primitive = "modelRow";
    slot.because = `${slot.because} Drawn as a row rather than a card: a screen may carry two metric cards, and more than that is a wall.`;
  }

  /* --- the states a data-dependent region has to express ------------------ */

  if (brief.states.length > 0) {
    const dataRegion =
      regions.find((r) => r.role === "content") ??
      regions.find((r) => r.role === "primary-visual") ??
      regions.find((r) => r.role === "secondary");
    if (dataRegion !== undefined) {
      slots.push({
        id: "slot-states",
        regionId: dataRegion.id,
        kind: "detail",
        label: brief.states[0]!,
        primitive: "statusPill",
        value: null,
        order: 900,
        because: `The states this region has to express: ${brief.states.join(", ")}. A screen that only ever shows the happy path is a screen that has not been designed.`,
        illustrative: false,
        states: brief.states,
      });
    }
  }

  return { slots, notPlaced };
}

/**
 * The region an item of this kind prefers.
 *
 * The first preference that exists wins; the fit is checked afterwards, when
 * the region's real height is known.
 */
function pickRegion(kind: InfoKind, regions: RegionSpec[]): string | null {
  for (const candidate of KIND_REGION_PREFERENCE[kind]) {
    const byId = regions.find((r) => r.id === candidate);
    if (byId) return byId.id;
    const byRole = regions.find((r) => r.role === candidate);
    if (byRole) return byRole.id;
  }
  const fallback = regions.find((r) => r.role === "content") ?? regions.find((r) => r.role === "secondary") ?? regions[0];
  return fallback?.id ?? null;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "item"
  );
}
