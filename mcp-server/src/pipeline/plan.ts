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
import { planScreen, resolveArchetype, type ScreenIntent } from "../plan/planner";
import { profileForProduct } from "../memory/profiles";
import { defaultGutter, layoutRegions, packContent } from "../runtime/layout";
// The compiler's own estimator: the plan states the room content needs with
// the same arithmetic the build applies (issue #25/#28 plan-side content fit).
// compile.ts imports nothing from the pipeline, so this direction is cycle-free.
import { estimateHeight, styleLook } from "../runtime/compile";
import type { ContentSpec } from "../../../shared/ir";
import { classifyInformation, classifyInfoItem, type InfoKind } from "../design/composition/derive";
import { compositionHintFor, descriptorsForRequestedComposition, COMPOSITION_VOCABULARY } from "../design/skills/composition";
import type { CompositionDescriptor } from "../design/skills/composition";
import type { Composition } from "../runtime/layout";
import type { VisualIntent } from "../../../shared/ir";
import type { ContentSlot, CompositionPlan, NormalizedBrief, RegionSpec } from "./contracts";
import { decideDisclosure } from "./disclosure";

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
  fitGauge: 56,
  memoryBudget: 90,
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
  fitGauge: 200,
  memoryBudget: 200,
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
 *
 * `intelligence` (issue #22) is the skill layer's compiled output. The plan is
 * the handoff point: the compiled intent rides on the plan to the report (so a
 * reviewer reads the manner next to the composition it produced), and when the
 * planner left no focal region and the plan has content regions, the
 * highest-rank payload region is named focal — an anti-generic skill's
 * acceptance criterion, filled where the planner's own derivation is silent.
 *
 * `steering` (issue #22 §3) is the alternatives engine's selection: a
 * composition the engine scored best across ≥3 materially different
 * hypotheses. It is applied only as the planner's own `desiredComposition`
 * hint — the planner keeps its viability rules — and only when the brief
 * itself did not state a composition, because a stated composition is a hard
 * constraint the engine may rank against but never replace.
 */
export function buildCompositionPlan(
  brief: NormalizedBrief,
  planId = "plan",
  intelligence?: { intent: VisualIntent; notes: string[] },
  steering?: { selectedComposition: Composition; provenance: string },
): CompositionPlan {
  const canvas = { width: brief.viewport.width, height: brief.viewport.height, grid: GRID, name: brief.screen };

  const steered = brief.desiredComposition === undefined ? steering?.selectedComposition : undefined;

  /**
   * The archetype is resolved the same way the planner resolves it (stated by
   * name, else inferred for deploy decisions under a profile that declares
   * the inference — issue #27), so its priority items become plan material:
   * they join the required information the plan and the content both carry.
   * Briefs that name no archetype resolve to no archetype, so every existing
   * plan is unchanged.
   */
  /**
   * The profile channel (issue #27): the brief's explicit `profile` id names
   * the product; the display `product` name is descriptive text that only
   * applies when it finds a registered profile. Unknown names stay neutral —
   * no profile, no inference, no product rules.
   */
  const pipelineProductResolution = profileForProduct(brief.profile ?? brief.product);
  const pipelineProductId = pipelineProductResolution !== undefined ? pipelineProductResolution.id : undefined;
  const archetype = resolveArchetype(brief.primaryDecision, brief.archetype ?? undefined, pipelineProductId);
  /**
   * A priority item the brief already covers is redundant, not additional: the
   * fixture says "fit verdict for the selected model" where the archetype says
   * "fit verdict", and keeping both builds the same readout twice — one of
   * them with no value, rendering a bare "—". Word-stem containment is the
   * match: "requires/required" and "fit verdict" should not hinge on inflection.
   */
  const stem = (s: string): string[] =>
    s.toLowerCase().split(/\W+/).map((t) => t.replace(/(es|ed|s)$/, "")).filter((t) => t.length > 2);
  const coveredBy = (a: string, b: string): boolean => {
    const at = stem(a);
    const bt = new Set(stem(b));
    return at.length > 0 && at.every((t) => bt.has(t));
  };
  const priorityItems = (archetype?.priority ?? []).filter(
    (p) =>
      !brief.requiredInformation.some(
        (r) => r.toLowerCase() === p.toLowerCase() || coveredBy(p, r) || coveredBy(r, p),
      ),
  );
  const briefForPlan =
    priorityItems.length > 0 ? { ...brief, requiredInformation: [...brief.requiredInformation, ...priorityItems] } : brief;

  const intent: ScreenIntent = {
    primaryDecision: brief.primaryDecision,
    goal: brief.purpose,
    audience: brief.audience,
    availableInformation: [...briefForPlan.requiredInformation, ...brief.optionalInformation],
    existingPatterns: brief.existingPatterns,
    // The archetype name is threaded so the plan records the same resolution.
    ...(brief.archetype !== null ? { archetype: brief.archetype } : {}),
    // The brief's own product declaration is the explicit profile channel
    // (issue #27): it names whose vocabulary/archetype inference applies and
    // which product rules can fire in previews.
    // The brief's own product declaration is the explicit profile channel
    // (issue #27): it names whose vocabulary/archetype inference applies and
    // which product rules can fire in previews. The explicit `profile` id
    // wins over the display `product` name; an unknown name resolves nothing.
    ...(pipelineProductResolution !== undefined
      ? { product: pipelineProductResolution.id, rules: pipelineProductResolution.rules }
      : {}),
    // Caller-declared states merge into the art direction's interaction
    // states (advisory only — no geometry impact). The brief's primaryAction
    // is deliberately NOT threaded as intent: the pipeline already places it
    // as an action slot in the header band, and passing it would add an extra
    // action region to every planned screen and change their resolved layout.
    ...(brief.states.length > 0 ? { states: brief.states } : {}),
    ...(brief.visualDirection !== null ? { visualDirection: brief.visualDirection } : {}),
    ...(brief.desiredComposition !== undefined
      ? { desiredComposition: brief.desiredComposition }
      : steered !== undefined
        ? { desiredComposition: steered }
        : {}),
    canvas: { width: canvas.width, height: canvas.height, grid: canvas.grid },
    name: canvas.name,
  };

  const plan = planScreen(intent);
  const warnings: string[] = [...plan.warnings];
  if (steered !== undefined && steering !== undefined) {
    warnings.push(steering.provenance);
  }

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

  /* --- the composition descriptor's plan-level hint (issue #24, item 3) ---- */

  /**
   * When the direction states a closed-vocabulary composition descriptor — or
   * the brief *requests* a composition that names one ('topology' asks for
   * topology-over-inspector; a plain composition word like 'table' contributes
   * nothing) — its concrete commitments are applied to the plan's real numbers
   * before the geometry resolves: `density` scales the regions' internal
   * gaps/paddings and `rhythm` sets a floor on the section-to-section spacing.
   * The requested composition has priority over the direction-compiled
   * descriptors, matching the receipt plan_screen records. Chrome (navigation,
   * header, footer, status rail) keeps the planner's spacing — a descriptor
   * about content density must not squeeze a navigation rail.
   * The geometry/negative-space strategies are prose commitments at skill
   * level; here they are recorded so the plan states them explicitly rather
   * than pretending they were applied where the plan has no field for them.
   * A brief-stated composition stays the hard shell; the descriptor only
   * shapes the manner inside it — same precedence the planner enforces.
   */
  let compositionHintNote: string | null = null;
  const requestedDescriptors = descriptorsForRequestedComposition(brief.desiredComposition);
  const compiledDescriptors =
    intelligence !== undefined && typeof intelligence.intent.composition === "string"
      ? intelligence.intent.composition.split("+").filter((d): d is CompositionDescriptor =>
          (COMPOSITION_VOCABULARY as readonly string[]).includes(d),
        )
      : [];
  if (requestedDescriptors.length > 0 || compiledDescriptors.length > 0) {
    // The requested composition is an explicit instruction, the direction's
    // words are manner — the same priority plan_screen records, so the two
    // paths cannot disagree about whether a hint was applied. A composition
    // name outside the vocabulary ('table', 'sequence') contributes nothing.
    const descriptors = [...requestedDescriptors, ...compiledDescriptors.filter((d) => !requestedDescriptors.includes(d))];
    const { hint } = compositionHintFor(
      descriptors,
      requestedDescriptors.length > 0
        ? `Requested composition '${brief.desiredComposition}'${compiledDescriptors.length > 0 ? " and the direction-compiled descriptor(s)" : ""}; applied to the plan's spacing before geometry resolves.`
        : "Compiled by the skill layer; applied to the plan's spacing before geometry resolves.",
    );
    const isChrome = (role: string): boolean => ["navigation", "header", "footer", "status-rail"].includes(role);
    for (const r of shell) {
      if (isChrome(r.role)) continue;
      const gap = r.gap ?? canvas.grid;
      const pad = r.padding ?? 24;
      if (hint.density === "airy") {
        r.gap = Math.max(gap, 32);
        r.padding = Math.max(pad, 24);
      } else if (hint.density === "calm") {
        r.gap = Math.max(gap, 24);
      } else if (hint.density === "dense") {
        r.gap = Math.min(gap, 12);
        r.padding = Math.min(pad, 16);
      }
      if (hint.rhythm === "generous") r.gap = Math.max(gap, 24);
    }
    compositionHintNote =
      `Composition descriptor '${hint.descriptor}' applied to the plan: density '${hint.density ?? "unchanged"}' scaled the non-chrome regions' internal spacing; ` +
      `${hint.rhythm !== undefined ? `rhythm '${hint.rhythm}' set a section-spacing floor; ` : ""}` +
      `${hint.geometryStrategy ?? "geometry unchanged"}; ${hint.negativeSpaceStrategy ?? "negative space unchanged"}.` +
      (hint.focalPosture !== undefined ? ` Focal posture: ${hint.focalPosture}.` : "") +
      (requestedDescriptors.length > 0 ? ` Source: requested composition '${brief.desiredComposition}'.` : "");
    warnings.push(compositionHintNote);
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

  const planned = planContent(briefForPlan, regions, plan.composition, archetype?.name);
  let content = planned.slots;
  const notPlaced = planned.notPlaced;

  /* --- the plan-side content fit (issues #25/#28) ------------------------- */

  /**
   * The plan and the build must agree about the room content needs.
   *
   * The compiler grows a fixed-height region whose content does not fit it
   * (fitRegionsToContent) — and until now that growth was invisible to the
   * plan: a 64px status rail or a 72px header holding the screen's title, its
   * description and its action grew to ~126-139px at build time, pushed every
   * fill band down, and the focal region resolved smaller than the share the
   * plan promised. The composition handoff (issue #28) rightly refuses that
   * build — the plan was the liar, not the build.
   *
   * So the plan now states the room up front, with the compiler's own
   * estimator, in three steps:
   *
   * 1. **mirror the emitted content.** For every slot, what program.ts's
   *    slotCall will actually emit — including the valueless-instrument
   *    policy (an illustrative slot with no value is omitted, or rendered as
   *    its label text when the information is required or the emptiness is
   *    the state). The slot keeps its declared primitive, so the build's own
   *    honest note about the decision still reads the same.
   * 2. **drop regions the build would leave empty.** A region whose every
   *    declared slot the policy omits would be built as an empty frame —
   *    wasted canvas, and its auto-layout request ("no children to lay out")
   *    is a violation that is pure noise. The region leaves the plan and the
   *    omission is recorded. A region whose every SURVIVING readout is a bare
   *    label (every real instrument omitted) is not a region either: the
   *    labels join the identity band — the same band the plan puts the
   *    screen's name in — and the emptied region is not built. The label-only
   *    slots keep their primitive, so the build still emits them, with its
   *    note, from the band that can hold them.
   * 3. **grow declared chrome to its content.** A region with a NUMBER
   *    declared height whose content estimates taller is grown to the
   *    estimate — never shrunk. Then the layout is re-resolved once with the
   *    corrected heights, so the fill bands absorb the growth exactly the way
   *    the build's own fit passes do, and the plan's usage numbers describe
   *    the screen that will actually be built.
   *
   * Same brief in, same plan out: the pass is arithmetic on the plan's own
   * numbers, no clock, no randomness.
   */
  const fitNotes: string[] = [];

  // The compiler's presentation multipliers, exactly as compileIR derives
  // them: the display-type scale from the contrast intent, and the preset look
  // from the manner the build will carry (the compiled intent's style, else
  // the brief's words).
  const fitLook = styleLook(intelligence?.intent.style ?? brief.visualDirection ?? undefined);
  const fitTitleScale =
    intelligence?.intent.contrast === "bold" ? 1.15 : intelligence?.intent.contrast === "muted" ? 0.9 : 1;

  /* 1. the emitted-content mirror per region ------------------------------- */

  const slotsOf = new Map<string, ContentSlot[]>();
  const specsOf = new Map<string, EmittedSpec[]>();
  for (const region of regions) {
    const slots = content.filter((s) => s.regionId === region.id).sort((a, b) => a.order - b.order);
    slotsOf.set(region.id, slots);
    specsOf.set(region.id, slots.map((s) => emittedSpecFor(s)).filter((s): s is EmittedSpec => s !== null));
  }

  /* 2. the emptied regions -------------------------------------------------- */

  /**
   * The identity band, by the same rule planContent places the screen's name
   * by: the header region, else the status rail, else the first region.
   */
  const identityBand =
    regions.find((r) => r.role === "header") ?? regions.find((r) => r.role === "status-rail") ?? regions[0];
  /** A slot whose valueless slotCall keeps a label-only text (never omitted). */
  const isLabelOnlySlot = (slot: ContentSlot): boolean =>
    slot.value === null &&
    slot.illustrative &&
    VALUELESS_PRIMITIVES.has(slot.primitive) &&
    (slot.because.startsWith("Required for the decision") || EMPTINESS_IS_STATE.test(`${slot.label} ${slot.because}`));

  const droppedRegions: RegionSpec[] = [];
  for (const region of regions) {
    const slots = slotsOf.get(region.id) ?? [];
    if (slots.length === 0) continue; // no declared content: not this pass's call
    const specs = specsOf.get(region.id) ?? [];
    const labelOnly = slots.filter((s) => specs.some((spec) => spec.id === s.id && spec.kind === "text") && isLabelOnlySlot(s));
    const realContent = specs.filter((spec) => !labelOnly.some((s) => s.id === spec.id));
    if (realContent.length > 0) continue;
    // Everything the build will emit from this region is bare labels (or
    // nothing at all). The labels — if any — join the identity band, which is
    // never dropped and never bare; the emptied region is not built.
    if (identityBand !== undefined && labelOnly.length > 0 && identityBand.id !== region.id) {
      for (const slot of labelOnly) {
        slot.regionId = identityBand.id;
        fitNotes.push(
          `'${region.id}' would hold nothing but the label of '${slot.id}' (${slot.label}): the label joins the identity band '${identityBand.id}', and the emptied region is not built.`,
        );
      }
      specsOf.set(identityBand.id, [...(specsOf.get(identityBand.id) ?? []), ...labelOnly.map((s) => emittedSpecFor(s)).filter((s): s is EmittedSpec => s !== null)]);
    }
    droppedRegions.push(region);
  }
  if (droppedRegions.length > 0) {
    const droppedIds = new Set(droppedRegions.map((r) => r.id));
    for (const region of droppedRegions) {
      for (const slot of slotsOf.get(region.id) ?? []) {
        notPlaced.push({
          label: slot.label,
          why: `'${slot.id}' is illustrative with no value, so no readout was emitted for it; its region '${region.id}' would have been an empty frame and is not built.`,
        });
      }
    }
    for (let i = regions.length - 1; i >= 0; i--) {
      if (droppedIds.has(regions[i]!.id)) regions.splice(i, 1);
    }
    content = content.filter((s) => !droppedIds.has(s.regionId));
    const keptHierarchy = hierarchy.filter((h) => !droppedIds.has(h.id));
    hierarchy.splice(0, hierarchy.length, ...keptHierarchy);
    if (focalId !== null && droppedIds.has(focalId)) {
      // The planner's focal region is gone with its content; the focal gap
      // -fill below names the next payload region instead of a dropped one.
      (plan.artDirection as { focal: unknown }).focal = null;
      warnings.push(
        `Plan content fit: the focal region '${focalId}' was dropped with its content; the plan names a new focal region from what is left.`,
      );
    }
    warnings.push(
      `Plan content fit: ${droppedRegions.map((r) => `'${r.id}'`).join(", ")} dropped from the plan — every content slot it carried is omitted by the valueless-instrument policy, so the build would have been an empty frame.`,
    );
  }

  /* the one disclosure rides in the region the build will place it in ------ */

  const disclosureDecision = decideDisclosure(brief, { regions, content } as unknown as CompositionPlan);
  if (disclosureDecision.call !== null) {
    specsOf.get(disclosureDecision.call.parent)?.push({
      kind: "text",
      id: disclosureDecision.call.id,
      text: disclosureDecision.call.text,
      role: "caption",
    });
  }

  /* 3. grow the declared chrome to its content ----------------------------- */

  const grownRegions: Array<{ id: string; from: number; to: number }> = [];
  for (const region of regions) {
    const declared = region.sizing.height;
    if (typeof declared !== "number") continue;
    // A free-composition region (topology, spatial, diagram) places its
    // content by algorithm, not by the flow packer, so the flow estimate does
    // not describe it; such a region is also never the fixed-height chrome
    // this pass exists for.
    if (region.layoutMode === "free") continue;
    const required = estimateRegionRequiredHeight(region, slotsOf.get(region.id) ?? [], specsOf.get(region.id) ?? [], fitLook, fitTitleScale, canvas.grid);
    if (required === null || required <= declared) continue;
    region.sizing.height = required;
    grownRegions.push({ id: region.id, from: declared, to: required });
  }
  for (const g of grownRegions) {
    fitNotes.push(
      `Region '${g.id}' declared ${g.from}px of height, but its content estimates to ~${g.to}px: the declared height is grown to the estimate so the build's own fit pass has nothing to reconcile, and the focal region keeps the share the plan gave it.`,
    );
  }

  // The geometry is re-resolved once with the corrected heights, using the
  // same engine and the same inputs the build will resolve from, and every
  // region's bounds are re-read — the fill bands absorb the chrome's growth
  // exactly as the compiler's fit passes do, so the plan's numbers (usage,
  // coverage, focal share) describe the screen that will be built.
  //
  // The grow weight is the one the interpreter will actually apply: the
  // program's visual weights become growth there (chrome 0.15 → grow 0, rank
  // 1 → grow 2, rank 2 → grow 1, otherwise grow 1, declared grow wins ties,
  // and the focal region grows hardest). A re-layout that used only the
  // declared grows would hand the fill space out on weights the build does
  // not use — the same plan-vs-build drift this pass exists to close.
  const chromeRole = (role: string): boolean =>
    role === "navigation" || role === "header" || role === "footer" || role === "status-rail";
  /** The focal region the build will grow to at least 2 — the plan's final focal, mirrored. */
  let focalForGrow: string | null = focalId !== null && !droppedRegions.some((r) => r.id === focalId) ? focalId : null;
  if (focalForGrow === null && regions.length >= 3) {
    const payload = [...hierarchy]
      .sort((a, b) => a.rank - b.rank)
      .map((h) => regions.find((r) => r.id === h.id))
      .find((r) => r !== undefined && r.role !== "navigation" && r.role !== "header" && r.role !== "footer" && r.role !== "status-rail");
    if (payload !== undefined) focalForGrow = payload.id;
  }
  const effectiveGrowOf = (region: RegionSpec): number => {
    let grow = region.grow;
    const rankEntry = hierarchy.find((h) => h.id === region.id);
    if (rankEntry !== undefined) {
      const weight = chromeRole(region.role) ? 0.15 : rankEntry.rank === 1 ? 0.9 : rankEntry.rank === 2 ? 0.6 : 0.35;
      grow = Math.max(grow, Math.round(weight * 2));
    }
    if (focalForGrow === region.id && grow < 2) grow = 2;
    return grow;
  };
  if (grownRegions.length > 0 || droppedRegions.length > 0) {
    const refit = layoutRegions({
      regions: regions.map((r) => ({
        id: r.id,
        role: r.role,
        composition: r.composition,
        width: r.sizing.width,
        height: r.sizing.height,
        grow: effectiveGrowOf(r),
        gap: r.gap,
        padding: r.padding.top,
      })) as unknown as Parameters<typeof layoutRegions>[0]["regions"],
      canvasW: canvas.width,
      canvasH: canvas.height,
      gutter: defaultGutter(canvas.grid),
    });
    for (const region of regions) {
      const box = refit.find((x) => x.id === region.id);
      if (box === undefined) continue;
      region.bounds = { x: box.x, y: box.y, w: box.w, h: box.h };
    }
    // The build's final word on a stack is integer-accumulated: the compiler's
    // canvas-fit pass re-stacks every column from the top with the rounded
    // heights whenever the column reaches the canvas edge — which any column
    // holding a fill region always does (the solver distributes to the edge
    // exactly). The plan's re-read applies the same integer stacking, so a
    // fractional fill share cannot turn a 32px gutter into a 33px one in the
    // plan's own numbers. A column without fills has integer heights already,
    // so this changes nothing there.
    const refitGutter = defaultGutter(canvas.grid);
    const refitColumns = new Map<number, RegionSpec[]>();
    for (const region of regions) {
      const list = refitColumns.get(region.bounds.x) ?? [];
      list.push(region);
      refitColumns.set(region.bounds.x, list);
    }
    for (const column of refitColumns.values()) {
      const ordered = [...column].sort((a, b) => a.bounds.y - b.bounds.y);
      let y = ordered[0]!.bounds.y;
      for (const region of ordered) {
        region.bounds.y = Math.round(y);
        y += region.bounds.h + refitGutter;
      }
    }
  }
  if (fitNotes.length > 0) {
    warnings.push(`Plan content fit (issue #25/#28): ${fitNotes.join(" ")}`);
  }

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
  /* --- the compiled intent and its focal gap-fill (issue #22) -------------- */

  let compiledFocal = plan.artDirection.focal;
  let focalFilledNote: string | null = null;
  if (compiledFocal === null && intelligence !== undefined && regions.length >= 3) {
    const payload = [...hierarchy]
      .sort((a, b) => a.rank - b.rank)
      .map((h) => regions.find((r) => r.id === h.id))
      .find((r) => r !== undefined && r.role !== "navigation" && r.role !== "header" && r.role !== "footer" && r.role !== "status-rail");
    if (payload !== undefined) {
      compiledFocal = { id: payload.id, why: `Named focal by the skill layer's gap-fill: the plan had no focal among ${regions.length} regions, so the highest-rank payload region takes it (issue #22 anti-generic criterion).` };
      focalFilledNote = `The plan had no focal region; the skill layer named '${payload.id}' (rank ${hierarchy.find((h) => h.id === payload.id)?.rank ?? "?"}) so the screen has a first thing to look at.`;
      warnings.push(focalFilledNote);
    }
  }

  const intentFields = Object.keys(intelligence?.intent ?? {}) as Array<keyof VisualIntent>;
  if (intelligence !== undefined && intentFields.length > 0) {
    warnings.push(
      `Compiled visual intent attached to the plan: ${intentFields.map((f) => `${f}`).join(", ")} — see the response payload's visualIntelligence.decisions for the why.`,
    );
  }

  const focal = regions.find((r) => r.id === (compiledFocal?.id ?? focalId ?? null));
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
    focal: compiledFocal,
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
    ...(intelligence !== undefined && intentFields.length > 0 ? { visualIntent: intelligence.intent } : {}),
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
function planContent(brief: NormalizedBrief, regions: RegionSpec[], composition: Composition, archetype?: string): {
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
      // EXO model-fit plans have purpose-built primitives for their two
      // structural needs — the fit verdict is a verdict pill and the
      // requires-vs-available fit is a budget bar, not a labelled card. The
      // archetype is what makes this a deployment decision, so no other plan
      // is affected.
      primitive: placementPrimitiveFor(item.text, archetype) ?? primitiveFor(item.kind, item.text, host?.composition ?? composition, false),
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
/**
 * The EXO placement primitives a model-fit plan asks for by name.
 *
 * The archetype's priority vocabulary ("fit verdict", "requires vs available")
 * is the plan's own words for these two structural needs, so the same phrases
 * route to the primitives that draw them: the verdict becomes a pill and the
 * resource fit becomes a budget bar. Returns null for anything else, so every
 * non-model-fit plan and every unrecognised label is unchanged.
 */
const EXO_PLACEMENT_PRIMITIVES: Array<[RegExp, string]> = [
  [/\bfit verdict\b/i, "fitGauge"],
  [/\brequir\w* vs available\b/i, "memoryBudget"],
];

function placementPrimitiveFor(label: string, archetype: string | undefined): string | null {
  if (archetype !== "model-fit" && archetype !== "deployment") return null;
  for (const [pattern, primitive] of EXO_PLACEMENT_PRIMITIVES) {
    if (pattern.test(label)) return primitive;
  }
  return null;
}

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

/* -------------------------------------------------------------------------- */
/* The plan-side content fit (issues #25/#28)                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the build will emit for one content slot, in the shape the compiler's
 * `estimateHeight` consumes.
 *
 * This is a deliberate mirror of program.ts's `slotCall` (the pipeline's own
 * builder) — NOT a second policy: program.ts owns the mapping and the
 * valueless-instrument policy, and this mirror exists only so the plan can
 * state the room the emitted content needs before anything is built. When the
 * builder's mapping changes, this mirror must follow it.
 */
type EmittedSpec =
  | { kind: "text"; id: string; text: string; role: string; maxWidth?: number; truncate?: boolean }
  | { kind: "component"; id: string; type: string; props: Record<string, unknown> };

/**
 * The valueless-instrument policy's own words (program.ts): a slot whose
 * emptiness is itself the reading keeps a label-only variant instead of being
 * omitted. Kept in step with program.ts's `EMPTINESS_IS_STATE`.
 */
const EMPTINESS_IS_STATE = /\bgates?\b|validation|checklist|pending|awaiting|not yet|no value|not run|in progress/i;

/**
 * The primitives whose value-less illustrative form the build's policy
 * disposes of (omit, or render label-only). `text`, `button`, `statusPill`,
 * `modelRow`, `panel`, `sectionHeader` and `deviceNode` always emit.
 */
const VALUELESS_PRIMITIVES = new Set(["metric", "timelineEvent", "fitGauge", "memoryBudget"]);

/** The type-scale role a heading slot uses — mirror of program.ts's textRole. */
function pipelineTextRole(slot: ContentSlot): string {
  if (slot.id.endsWith("eyebrow")) return "eyebrow";
  if (slot.id.endsWith("title")) return "title";
  if (slot.id.endsWith("description")) return "subtitle";
  if (slot.kind === "heading") return "title";
  return "body";
}

/** Whether a string can wrap at all — mirror of program.ts's isUnbreakable. */
function isUnbreakableLabel(text: string): boolean {
  const longest = text.split(/\s+/).reduce((max, run) => (run.length > max.length ? run : max), "");
  return longest.length > 28 && text.length <= longest.length + 2;
}

/** The status tone a value names — mirror of program.ts's toneFromValue. */
function pipelineToneFromValue(value: string): string {
  const s = value.toLowerCase();
  if (/^(success|healthy|info|neutral|warning|degraded|error|offline)$/.test(s)) return s;
  if (/\bfits?\b|\bready\b|\bok\b|success|healthy|connected|available/.test(s)) return "success";
  if (/fail|error|insufficient|exceed|offline|denied|unavailable|rejected/.test(s)) return "error";
  if (/warn|degraded|stale|partial|pending|loading|progress|attention|pressure/.test(s)) return "warning";
  if (/info|running|live|sync|refresh/.test(s)) return "info";
  return "neutral";
}

/**
 * Parses a budget statement — mirror of program.ts's parseMemoryBudget, so the
 * mirror knows when the build falls back to a labelled metric.
 */
function pipelineParseMemoryBudget(value: string | null): { used: number; total: number; remaining: number; unit: string } | null {
  if (value === null) return null;
  const match = value.match(/([\d.]+)\s*(B|KB|MB|GB|TB)\s+of\s+([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) return null;
  const toGB = (n: number, unit: string): number => {
    switch (unit.toUpperCase()) {
      case "TB": return n * 1024;
      case "GB": return n;
      case "MB": return n / (1024 * 1024);
      case "KB": return n / (1024 * 1024);
      default: return n / (1024 * 1024 * 1024);
    }
  };
  const used = toGB(parseFloat(match[1]!), match[2]!);
  const total = toGB(parseFloat(match[3]!), match[4]!);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return { used, total, remaining: Math.max(0, total - used), unit: "GB" };
}

/**
 * What the build emits for one slot — the `slotCall` mirror. `null` is the
 * honest "omitted": an illustrative slot with no value whose emptiness is not
 * itself a reading emits nothing at all.
 */
function emittedSpecFor(slot: ContentSlot): EmittedSpec | null {
  switch (slot.primitive) {
    case "text":
      return {
        kind: "text",
        id: slot.id,
        text: slot.value !== null ? `${slot.label} — ${slot.value}` : slot.label,
        role: pipelineTextRole(slot),
        ...(isUnbreakableLabel(slot.label) ? { truncate: true } : {}),
      };
    case "button":
      return {
        kind: "component",
        id: slot.id,
        type: "button",
        props: {
          label: slot.label,
          variant: slot.kind === "action" && slot.id.includes("primary") ? "primary" : "secondary",
        },
      };
    case "metric":
      if (slot.value === null && slot.illustrative) return valuelessPolicy(slot);
      return {
        kind: "component",
        id: slot.id,
        type: "metric",
        props: {
          label: slot.label,
          value: slot.value ?? "—",
          ...(slot.value === null ? { valueStyle: "technical" } : {}),
        },
      };
    case "statusPill":
      if (slot.value !== null) {
        return {
          kind: "component",
          id: slot.id,
          type: "statusPill",
          props: { label: `${slot.label} — ${slot.value}`, tone: pipelineToneFromValue(slot.value) },
        };
      }
      if (slot.states !== undefined) {
        return {
          kind: "component",
          id: slot.id,
          type: "statusPill",
          props: { label: `States — ${slot.states.join(" · ")}`, states: slot.states },
        };
      }
      return { kind: "component", id: slot.id, type: "statusPill", props: { label: slot.label } };
    case "modelRow":
      return {
        kind: "component",
        id: slot.id,
        type: "modelRow",
        props: { title: slot.label, ...(slot.value !== null ? { value: slot.value } : {}) },
      };
    case "fitGauge": {
      const value = slot.value ?? "";
      if (value === "") {
        if (slot.illustrative) return valuelessPolicy(slot);
        return {
          kind: "component",
          id: slot.id,
          type: "metric",
          props: { label: slot.label, value: "—", valueStyle: "technical" },
        };
      }
      const parts = value.split("·").map((s) => s.trim()).filter(Boolean);
      return {
        kind: "component",
        id: slot.id,
        type: "fitGauge",
        props: {
          fits: /\bfits\b/i.test(value) && !/does not fit|doesn'?t fit|no fit/i.test(value),
          verdict: parts[0] ?? "Fits",
          detail: `${slot.label} — ${parts.slice(1).join(" · ")}`,
        },
      };
    }
    case "memoryBudget": {
      if (pipelineParseMemoryBudget(slot.value) === null) {
        if (slot.value === null && slot.illustrative) return valuelessPolicy(slot);
        return {
          kind: "component",
          id: slot.id,
          type: "metric",
          props: { label: slot.label, value: slot.value ?? "—", ...(slot.value === null ? { valueStyle: "technical" } : {}) },
        };
      }
      return { kind: "component", id: slot.id, type: "memoryBudget", props: { title: slot.label } };
    }
    case "panel":
      return { kind: "component", id: slot.id, type: "panel", props: { title: slot.label } };
    case "sectionHeader":
      return { kind: "component", id: slot.id, type: "sectionHeader", props: { title: slot.label } };
    case "timelineEvent":
      if (slot.value === null && slot.illustrative) return valuelessPolicy(slot);
      return {
        kind: "component",
        id: slot.id,
        type: "timelineEvent",
        props: { title: slot.label, date: slot.value ?? "—" },
      };
    case "deviceNode":
      return { kind: "component", id: slot.id, type: "deviceNode", props: { label: slot.label } };
    default:
      return null;
  }
}

/** The valueless-instrument policy's two outcomes (program.ts's `valuelessInstrument`). */
function valuelessPolicy(slot: ContentSlot): EmittedSpec | null {
  const required = slot.because.startsWith("Required for the decision");
  const emptinessIsState = EMPTINESS_IS_STATE.test(`${slot.label} ${slot.because}`);
  if (required || emptinessIsState) {
    return { kind: "text", id: slot.id, text: slot.label, role: "body" };
  }
  return null;
}

/**
 * The column count the compiler will pack a region's content with — mirror of
 * emitContent's `columns` expression. The plan's own `columns` (worked out in
 * planContent) travels to the build and wins when it is more than one; when it
 * is one the compiler recomputes from the region's composition. The
 * screen-level composition grant is not mirrored: a region the grant would
 * give three columns is estimated in one column here, which estimates TALLER,
 * never shorter — the one direction this pass is allowed to err.
 */
function fallbackColumnsFor(region: RegionSpec, specs: EmittedSpec[]): number {
  const components = specs.filter((s) => s.kind === "component");
  const ROW_TYPES = new Set(["modelRow", "timelineEvent", "tableRow"]);
  const allRows = components.length > 0 && specs.every((s) => s.kind === "text" || (s.kind === "component" && ROW_TYPES.has(s.type)));
  const allText = specs.length > 0 && specs.every((s) => s.kind === "text");
  const granted = region.composition === "instrument" || region.composition === "table";
  return !granted || allRows || allText ? 1 : 3;
}

/**
 * The height a region's content needs, computed the way the build resolves it.
 *
 * Two passes, because the build has two compiles: the first estimates every
 * item at the region's inner width (the wrapping width is not known yet), the
 * second re-estimates the text at the column the first pass actually gave it
 * — which is what `applyMeasuredWidths` writes back and the final compile
 * estimates with. Each pass is packed with the same `packContent` the
 * compiler's flow path uses, in the same item order (texts first, then
 * components — `emitContent` builds its flow list that way), and the required
 * height is read off the packed content's bottom the way
 * `fitRegionsToContent` reads it: content bottom, minus the region top, plus
 * the bottom padding.
 *
 * Returns null when the region holds nothing to estimate.
 */
function estimateRegionRequiredHeight(
  region: RegionSpec,
  slots: ContentSlot[],
  specs: EmittedSpec[],
  look: ReturnType<typeof styleLook>,
  titleScale: number,
  grid: number,
): number | null {
  if (specs.length === 0) return null;
  const pad = region.padding;
  const gap = region.gap;
  const inner = {
    x: region.bounds.x + pad.left,
    y: region.bounds.y + pad.top,
    w: Math.max(0, region.bounds.w - pad.left - pad.right),
    h: Math.max(0, region.bounds.h - pad.top - pad.bottom),
  };
  if (inner.w <= 0) return null;
  // The compiler forces one column when it APPLIES the native auto-layout
  // request ("one column: Figma's vertical auto layout is a single stack").
  // The request exists when the region is a flow-vertical stack whose slots
  // all declare component primitives (program.ts's autoLayout flag); it is
  // GRANTED only when every emitted child really is a fixed-extent component
  // — a label-only readout is text the compiler cannot measure, and a
  // declined request keeps the columns the plan declared.
  const requestedAutoLayout =
    slots.length > 0 && slots.every((s) => s.primitive !== "text") && region.layoutMode === "flow-vertical";
  const granted = requestedAutoLayout && specs.length > 0 && specs.every((s) => s.kind === "component");
  const columns = granted
    ? 1
    : region.columns !== undefined && region.columns > 1
      ? region.columns
      : fallbackColumnsFor(region, specs);
  const asContentSpec = (s: EmittedSpec): ContentSpec => s as unknown as ContentSpec;
  const pack = (heights: number[]): Map<string, { x: number; y: number; w: number; h: number }> =>
    packContent({
      region: inner,
      items: specs.map((s, i) => ({ id: s.id, height: heights[i]! })),
      gap,
      columns,
    });
  // Pass 1: the widths pass — text estimated at the region's inner width.
  const first = pack(specs.map((s) => estimateHeight(asContentSpec(s), inner.w, 1, titleScale, grid, look)));
  // Pass 2: the wrapping widths the first pass resolved are the widths the
  // final compile estimates the text at.
  const second = pack(
    specs.map((s, i) => {
      if (s.kind !== "text") return first.get(s.id)?.h ?? 0;
      const box = first.get(s.id);
      const maxWidth = box !== undefined && box.w > 0 ? Math.max(40, Math.round(box.w)) : undefined;
      return estimateHeight(
        asContentSpec({ ...s, ...(maxWidth !== undefined ? { maxWidth } : {}) }),
        inner.w,
        1,
        titleScale,
        grid,
        look,
      );
    }),
  );
  let bottom = Number.NEGATIVE_INFINITY;
  for (const box of second.values()) bottom = Math.max(bottom, box.y + box.h);
  if (!Number.isFinite(bottom)) return null;
  return Math.ceil(bottom - region.bounds.y + pad.bottom);
}

