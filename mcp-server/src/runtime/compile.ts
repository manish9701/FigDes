/**
 * IR → Figma operations (spec §41, §43).
 *
 * This is the compiler. It turns a declarative Design IR into the same
 * validated operation list the rest of the system already executes, so the IR
 * path inherits the existing transaction, rollback and allowlist guarantees for
 * free. There is no second execution model.
 *
 * Key property: the model never states coordinates. It states intent and the
 * layout engine computes the geometry.
 */
import { OperationSchema, parseColor, type Operation } from "../../../shared/protocol";
import type { CompileResult, ContentSpec, ConnectorRoute, DesignIR, ResolvedBox, ResolvedRegion } from "../../../shared/ir";
import { canvasSize } from "../../../shared/ir";
import { normalizePath, normalizeVectorPath } from "../../../shared/path";
import { solveConstraints, expectedRelationBox, type PlacedBox } from "./constraints";
import { checkIdentity } from "./identity";
import { CONNECTOR_CLEARANCE_MIN, arrowSpace, labelBoxAt, labelTangent, pickLabelPosition, routeConnectorClearance } from "./connectors";
import { coerceLogoMark, executeLogoPlan, logoConstructionGrid, logoMarkPath, opticalAlignDy, polygonPath, starPath, type LogoPlanStep } from "./marks";
import { resolveStyleTokens } from "./visual-presets";
import { fitStackToCanvas, inferComposition, MIN_STACK_REGION_H, packContent, planLayoutReflowed, radial, forceDirected, defaultGutter, separateOverlaps } from "./layout";
import { runAlgorithm } from "./algorithms";
import { isLibraryComponent, libraryDefFor, libraryMasterEmitted } from "./components";

/* -------------------------------------------------------------------------- */
/* Typography defaults                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A restrained editorial type scale.
 *
 * Sizes step geometrically so hierarchy reads without the model having to
 * invent one per screen. `ratio` is the multiplier between steps.
 *
 * Exported so the interpreter can compute emphasis against the same numbers
 * the compiler will use. Two sources of truth for type sizes would drift.
 */
export const TYPE_SCALE: Record<string, { size: number; weight: number; family?: string }> = {
  eyebrow: { size: 11, weight: 600, family: "Inter" },
  title: { size: 32, weight: 600, family: "Inter" },
  subtitle: { size: 18, weight: 500, family: "Inter" },
  body: { size: 14, weight: 400, family: "Inter" },
  label: { size: 12, weight: 500, family: "Inter" },
  value: { size: 28, weight: 600, family: "Inter" },
  caption: { size: 11, weight: 400, family: "Inter" },
  code: { size: 12, weight: 400, family: "JetBrains Mono" },
};

/**
 * The type ramp's readability floor (issue #25): nothing renders below it.
 *
 * The contrast intent scales display type (bold 1.15, muted 0.9), and a muted
 * eyebrow at the ramp's 11px step rounded to 10px — below the floor the
 * type-and-space skill declares and the completeness gate enforces, which
 * refused the whole build. The multipliers shape hierarchy; they do not
 * override the floor. Same number as design/quality/type-criteria.ts's
 * MIN_LABEL_PX, kept local so the runtime bundle stays decoupled from the
 * quality bundle.
 */
export const MIN_FONT_PX = 11;

/** The font size a text op emits: the ramp size through the deck/type/contrast multipliers, never below the floor. */
export function emittedFontSize(base: number, typeScale = 1, display = 1): number {
  return Math.max(MIN_FONT_PX, Math.round(base * typeScale * display));
}

/* -------------------------------------------------------------------------- */
/* Style look (FigDes §26)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a style preset changes in emitted operations.
 *
 * Identity-driven choices (nav tracking and case, value size, header scale)
 * key off the preset NAME, because "quiet-instrument" promising uppercase
 * tracked-out nav is the preset's manner, not a combinable mechanic. Everything
 * else keys off merged mechanics so compounds and bare directives work: warm
 * paper, mono-first numbers, generous padding, semibold body. Defaults reproduce
 * current behaviour exactly, so omitting style changes nothing.
 */
export interface StyleLook {
  navTracking: number;
  navUpper: boolean;
  valueMono: boolean;
  valueSize: number;
  headerScale: number;
  panelPaddingScale: number;
  bodyWeight: number;
  rootFill?: string;
}

const DEFAULT_LOOK: StyleLook = {
  navTracking: 0,
  navUpper: false,
  valueMono: false,
  valueSize: 28,
  headerScale: 1,
  panelPaddingScale: 1,
  bodyWeight: 400,
  // Light canvas unless a warmth preset says otherwise. Without this an
  // unfilled root exports as transparency (black in PNGs).
  rootFill: "#FFFFFF",
};

export function styleLook(raw: string | string[] | undefined): StyleLook {
  if (raw === undefined) return { ...DEFAULT_LOOK };
  const { preset, mechanics } = resolveStyleTokens(raw);
  const look: StyleLook = { ...DEFAULT_LOOK };
  const name = preset?.name;

  if (name === "quiet-instrument") {
    look.navTracking = 50;
    look.navUpper = true;
    look.valueSize = 32;
  } else if (name === "technical-editorial" || name === "gallery-warm") {
    look.navTracking = 20;
    look.headerScale = 1.15;
  } else if (name === "calm-technical") {
    // Subtle, geometry-free: values step up one weight class and headers
    // breathe slightly more. No spacing, alignment or colour change, which is
    // what keeps this preset safe for automatic assignment.
    look.valueSize = 30;
    look.headerScale = 1.05;
  } else if (name === "high-contrast-ops") {
    // Bold contrast is load-bearing here: body text steps to semibold and
    // headers gain presence so state reads across the room.
    look.headerScale = 1.1;
  } else if (name === "editorial-bold") {
    look.navTracking = 20;
    look.headerScale = 1.3;
    look.valueSize = 34;
  }

  if (mechanics.numbers === "mono-first") look.valueMono = true;
  if (mechanics.spacing === "12px-loose") look.panelPaddingScale = 1.5;
  if (mechanics.contrast === "bold") look.bodyWeight = 600;

  // Warmth tints the canvas when the program states no fill of its own. Named
  // paper tones, documented here: warm paper, blue-grey paper, otherwise white.
  // A default is required, not optional: an unfilled root exports as
  // transparency (black in PNGs), so "no fill stated" must never mean black.
  if (mechanics.warmth === "warm") look.rootFill = "#FAF6EF";
  else if (mechanics.warmth === "cool") look.rootFill = "#F0F3F5";
  else look.rootFill = "#FFFFFF";

  return look;
}

/* -------------------------------------------------------------------------- */
/* Optical correction (FigDes §10)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Mathematical alignment is not enough: a human designer routinely applies
 * optical corrections, and the difference between aligned and *looking*
 * aligned is the difference between mid and pro.
 *
 * Two rules, both bounded and both documented, applied at placement time so
 * relations, connectors and the returned boxes all agree with what is drawn.
 * A post-pass that moved ops after layout would desync them, which is worse
 * than no correction at all.
 */
export const OPTICAL_OVERSHOOT = 0.02;

function overshoot(box: ResolvedBox): ResolvedBox {
  const dx = Math.max(1, Math.round(box.w * OPTICAL_OVERSHOOT));
  const dy = Math.max(1, Math.round(box.h * OPTICAL_OVERSHOOT));
  return { x: box.x - dx, y: box.y - dy, w: box.w + dx * 2, h: box.h + dy * 2 };
}

/**
 * A stroked frame's paint straddles its edge, so a 3px stroke eats 1px of gap
 * on every side compared to its 1px siblings. Expanding by half the excess
 * keeps the gap rhythm the layout computed, instead of letting heavy strokes
 * silently tighten it.
 */
function strokeTrueSize(box: ResolvedBox, weight: number): ResolvedBox {
  if (weight <= 1) return box;
  const pad = (weight - 1) / 2;
  return { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
}

/**
 * Optical box for a device node at placement time.
 *
 * A selected device draws a 3px action-blue ring; without this correction the
 * ring would eat into the computed gap. Read from the same props the emitter
 * reads, so the recorded box and the drawn frame can never disagree.
 */
function devicePlacementBox(box: ResolvedBox, spec: ContentSpec): ResolvedBox {
  if (spec.kind === "component" && spec.type === "deviceNode" && (spec.props as Record<string, unknown>).selected === true) {
    return strokeTrueSize(box, 3);
  }
  return box;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Compiles a design IR into Figma operations.
 *
 * ## The coordinate-space contract
 *
 * Two spaces, and mixing them is how a screen ends up with a region in one
 * place and its contents in another:
 *
 * - **Resolved boxes are page-absolute.** Everything the layout engine
 *   computes — a region's frame, a child's position — is measured from the
 *   canvas origin. One space, one origin, no ambiguity.
 * - **Emitted operations are parent-local.** Figma's `x`/`y` on a child is
 *   relative to its parent, so the operations carry the difference between the
 *   child's absolute box and its parent's origin.
 *
 * The two are reconciled by `verifyOperationTrace`, which replays the emitted
 * operations and compares them with the resolved boxes. That check is
 * blocking: a program whose operations and geometry disagree is not a screen,
 * it is a plan for one.
 *
 * ## Text heights
 *
 * A text node's height is measured when the caller can measure it (the plugin
 * owns the font and the metrics) and estimated otherwise. The estimate is a
 * character-count heuristic: close enough to place a screen, nowhere near
 * close enough to be the truth, which is why the measured path exists.
 */
export function compileIR(ir: DesignIR, textMetrics?: Map<string, { width: number; height: number }>): CompileResult {
  const started = Date.now();
  const violations: CompileResult["violations"] = [];
  const operations: Operation[] = [];
  const algorithms: Record<string, string> = {};

  const canvas = ir.canvas;
  const composition = inferComposition(ir.regions);

  /**
   * Intent mechanics that live in the compiler rather than the interpreter.
   *
   * The interpreter already applied density (grid scale) and weight/focal
   * (growth). What remains is presentation: rhythm scales gutters but not the
   * spacing system; strong alignment snaps regions to the grid; bold contrast
   * lifts display type; depth elevates chrome regions. Each is one multiplier
   * in one place, reported nowhere because the geometry speaks for itself —
   * except in tests, where the numbers are asserted directly.
   */
  const intent = ir.visualIntent;
  const look = styleLook(ir.visualIntent?.style);
  const rhythmScale = intent?.rhythm === "generous" ? 1.25 : intent?.rhythm === "tight" ? 0.75 : 1;
  const titleScale =
    intent?.contrast === "bold" ? 1.15 : intent?.contrast === "muted" ? 0.9 : 1;
  const alignGrid = intent?.alignment === "strong" ? Math.max(1, Math.round(canvas.grid)) : 0;

  // Normalise input before anything reads it.
  //
  // `compileIR` is reachable with a hand-built object — `compile_ir` validates
  // through zod first, but tests and internal callers do not — and every one of
  // these collections is optional in the schema with a default. Reading an
  // absent one produced a TypeError naming an internal function ("cannot read
  // properties of undefined (reading 'length')" from `emitContent`) instead of
  // naming the bad input. `planLayout` additionally spreads each region into a
  // ResolvedRegion, so a missing `children` would be baked into the resolved
  // geometry and surface much later as a stray layout fault.
  for (const region of ir.regions) {
    if (!Array.isArray(region.children)) region.children = [];
  }
  if (!Array.isArray(ir.content)) ir.content = [];
  if (!Array.isArray(ir.tokens)) ir.tokens = [];
  if (!Array.isArray(ir.relations)) ir.relations = [];
  if (!Array.isArray(ir.links)) ir.links = [];

  // Identity is checked before anything reads the program, because every other
  // stage keys off ids. A duplicate id collapses two nodes into one `boxes`
  // entry, so by the time geometry is resolved the collision is invisible and
  // surfaces as a position mismatch with no cause. Naming it here is the
  // difference between "move this region" and "these two things are the same
  // name" (issue #12, A8).
  violations.push(...checkIdentity(ir));

  // The shell layout may itself have had to repair an overflowing stack (the
  // canvas-fit reflow inside `layoutRegions`); counted so `reflowed` reports
  // every automatic geometry change, not just relation-driven ones.
  //
  // `bands` collects the horizontal bands the shell formed (a fill/grow canvas
  // region beside fixed-width siblings, e.g. map + inspector). The fit passes
  // below consume them: members of one band grow together, capped at the band
  // height, so the band stays one cohesive row inside the canvas instead of the
  // inspector growing past the bottom edge or the map silently shrinking alone.
  // Declared relations decline banding in the shell (the solver owns geometry
  // there), so an empty list is the normal state for unchanged programs.
  const bands: Array<{ members: readonly string[]; capH: number; heightKind: "fill" | "numeric" | "hug" }> = [];
  const shell = planLayoutReflowed(ir, defaultGutter(canvas.grid) * rhythmScale, {
    // A relation that declares its width or height hands the geometry to the
    // solver, so the shell declines banding — including the honest refusal of
    // a relation that cannot fit. But a bare positioning pin (rightOf with no
    // sizes) used to switch banding off too, leaving the fill region at full
    // canvas width and the pinned region at anchor.x + anchor.w = off-canvas.
    // A pin that owns no size declares no geometry, so the shell bands the
    // row normally and the pin keeps the placement it asked for.
    reflow: ir.relations.every((r) => r.width === undefined && r.height === undefined),
    bandsOut: (collected) => bands.push(...collected),
  });
  let regions = shell.regions;
  let reflowed = shell.reflowed;
  // Whether a requested native auto-layout container was honoured. Reported
  // on `stats` so a declined request is a fact in the payload, not just a
  // violation line — and the violation is always kept alongside it.
  let nativeLayoutApplied = true;
  /** Ids of regions whose frames were emitted as native auto-layout containers. */
  const appliedAutoLayout = new Set<string>();
  // How many measured text nodes are laid out by a native auto-layout
  // container. Zero when no container was applied or none of its children is
  // text — the payload then says the layout stands on estimates or components.
  let measuredTextUsed = 0;
  if (alignGrid > 0) {
    regions = regions.map((r) => ({
      ...r,
      x: Math.round(r.x / alignGrid) * alignGrid,
      y: Math.round(r.y / alignGrid) * alignGrid,
      w: Math.max(alignGrid, Math.round(r.w / alignGrid) * alignGrid),
      h: Math.max(alignGrid, Math.round(r.h / alignGrid) * alignGrid),
    }));
  }
  if (intent?.depth === "layered" || intent?.depth === "subtle") {
    const chrome = new Set(["secondary", "inspector"]);
    if (intent.depth === "layered") chrome.add("panel");
    regions = regions.map((r) =>
      chrome.has(r.role) && r.elevation === 0 ? { ...r, elevation: 1 } : r,
    );
  }
  const regionIds = new Set(ir.regions.map((r) => r.id));

  // Content declared but never parented to a region is adopted rather than
  // dropped. The runtime interpreter already defaults an unparented call to the
  // first region, so a program that reaches `compileIR` through `design_runtime`
  // never arrives in this state; a hand-written IR sent to `compile_ir` does,
  // because `RegionSchema.children` defaults to []. The live consequence was
  // that such a node was never emitted *and* every connector naming it reported
  // "unknown node", which is a misleading diagnosis for a node that is right
  // there in `content`. Adopting matches the interpreter, and is reported rather
  // than done silently.
  //
  // than done silently.
  {
    const claimed = new Set(ir.regions.flatMap((r) => r.children));
    const orphans = ir.content.filter((c) => !claimed.has(c.id) && c.kind !== "connector");
    if (orphans.length > 0 && ir.regions.length > 0) {
      const host = ir.regions[0]!;
      host.children.push(...orphans.map((c) => c.id));
      violations.push({
        rule: "content-parent",
        message: `${orphans.length} content node(s) were declared without a parent region and were placed in '${host.id}': ${orphans
          .slice(0, 6)
          .map((c) => `'${c.id}'`)
          .join(", ")}${orphans.length > 6 ? ", …" : ""}. Add a parent to place them deliberately.`,
      });
    }
  }

  /**
   * Deck mode: one region, one slide.
   *
   * Slides are fixed 1920x1080 and cannot be resized, so region geometry is not
   * computed but assigned. Type is scaled by 1920/1440 because 32px titles drawn
   * for a desktop canvas read as fine print on a slide.
   */
  const deck = ir.canvas.deck === true;
  const typeScale = deck ? 1920 / 1440 : 1;

  if (deck) {
    regions = regions.map((r) => ({ ...r, x: 0, y: 0, w: 1920, h: 1080 }));
  }

  /* -------------------------------------------------------------- root --- */

  if (deck) {
    // No root frame: each region is its own slide. Slides cannot be resized or
    // repositioned, so no x/y/width/height is emitted for them at all.
    for (const region of regions) {
      operations.push(
        op({
          type: "createSlide",
          id: region.id,
          name: humanize(region.id),
          ...(canvas.fill !== undefined ? { background: resolveToken(canvas.fill) } : {}),
        }),
      );
    }
  } else {
    operations.push(
      op({
        type: "createFrame",
        id: "root",
        name: canvas.name,
        width: canvas.width,
        height: canvas.height,
        // Warmth tints the canvas only when the program states no fill: an
        // explicit fill always wins over manner.
        ...(canvas.fill !== undefined ? { fill: resolveToken(canvas.fill) } : look.rootFill !== undefined ? { fill: look.rootFill } : {}),
      }),
    );

    if (canvas.newPage) {
      operations.push(op({ type: "setPage", target: "root", page: canvas.name }));
    }
  }

  /* ------------------------------------------------------------ tokens --- */

  // Tokens come before the nodes that reference them, so a later global
  // refinement is a single edit in Figma rather than a sweep (spec §22).
  emitTokens(ir, operations);

  /* ------------------------------------------------------------ regions --- */

  if (!deck) {
    for (const region of regions) {
      // A native auto-layout container: Figma stacks the children itself, so
      // the region survives being re-laid-out by a designer.
      //
      // It is only honoured when the children have a *known* extent. A
      // component's height is either fixed or hugged, and both are exact; an
      // instance carries its measured extents explicitly. A text node's height
      // is exact only when it was measured at the width it will be drawn at
      // (`textMetrics`, filled by the runtime's measure-then-recompile second
      // pass) — an estimate from a character-count heuristic would push every
      // sibling below it away from where the plan promised it would be. So a
      // region holding unmeasured text keeps absolute placement, and says why.
      const children = ir.content.filter((c) => region.children.includes(c.id));
      const wantsAutoLayout = (region as { autoLayout?: string }).autoLayout === "vertical";
      const flowRegion = region.layout === "flow";
      const isMeasuredText = (c: ContentSpec): boolean =>
        c.kind === "text" && (textMetrics?.get(c.id)?.height ?? 0) > 0;
      const fixedExtentChildren =
        children.length > 0 &&
        children.every((c) => c.kind === "component" || c.kind === "instance" || isMeasuredText(c));
      const autoLayout = wantsAutoLayout && flowRegion && fixedExtentChildren;
      if (wantsAutoLayout && !autoLayout) {
        // Declined, not silently passed: the violation below stays, and the
        // stats flag records the decline for callers that gate on the payload.
        nativeLayoutApplied = false;
        const unmeasuredText = children.filter((c) => c.kind === "text" && !isMeasuredText(c)).map((c) => `'${c.id}'`);
        const estimatedGraphics = children
          .filter((c) => c.kind !== "component" && c.kind !== "instance" && c.kind !== "text")
          .map((c) => `'${c.id}'`);
        violations.push({
          rule: "auto-layout",
          message:
            `Region '${region.id}' asked for a native auto-layout container, which was not applied: ` +
            (flowRegion ? "" : `its layout is '${region.layout}', not a flow. `) +
            (children.length === 0 ? "it has no children to lay out. " : "") +
            (unmeasuredText.length > 0
              ? `its text (${unmeasuredText.join(", ")}) has only estimated heights — measure it first (the runtime measures text between its two compile passes), so Figma's own layout moves nothing. `
              : "") +
            (estimatedGraphics.length > 0 ? `it holds graphics (${estimatedGraphics.join(", ")}) whose extent is estimated rather than measured, so Figma's own layout would move them. ` : ""),
        });
      }
      if (autoLayout) {
        // One column: Figma's vertical auto layout is a single stack, and the
        // flow placement below already computes the same stack.
        region.columns = 1;
        // Every measured text child in this region is now laid out by Figma
        // itself rather than by the estimate path — counted so the payload says
        // how much of the layout stands on measurements.
        measuredTextUsed += children.filter((c) => c.kind === "text").length;
        appliedAutoLayout.add(region.id);
      }

      operations.push(
        op({
          type: "createFrame",
          id: region.id,
          parent: "root",
          name: humanize(region.id),
          x: region.x,
          y: region.y,
          width: Math.max(1, Math.round(region.w)),
          height: Math.max(1, Math.round(region.h)),
          fill: region.fill !== undefined ? resolveToken(region.fill) : [],
          ...(region.radius !== undefined ? { cornerRadius: region.radius } : {}),
          ...(autoLayout
            ? {
                layoutMode: "VERTICAL",
                itemSpacing: region.gap ?? canvas.grid,
                padding: normalizePadding(region.padding, canvas.grid),
                primaryAxisAlignItems: "MIN",
                counterAxisAlignItems: "MIN",
              }
            : {}),
        }),
      );
      // Elevation is depth you can see: a soft shadow on the region frame.
      // Kept subtle by construction (12px blur per level, low opacity) because
      // the identity forbids heavy shadow texture.
      if (region.elevation > 0) {
        operations.push(
          op({
            type: "setEffect",
            target: region.id,
            effect: "drop-shadow",
            offsetY: 4 * region.elevation,
            radius: 12 * region.elevation,
            opacity: 0.12,
          }),
        );
      }
      // A declared columns grid gives the region an alignment structure
      // without hand-placed gutters. Hidden so renders stay clean; the
      // designer toggles visibility in Figma when constructing.
      if (region.gridColumns !== undefined) {
        operations.push(
          op({
            type: "setLayoutGrid",
            target: region.id,
            pattern: "COLUMNS",
            count: region.gridColumns,
            gutter: region.gridGutter ?? canvas.grid * 3,
            visible: false,
          }),
        );
      }
    }
  }

  /* -------------------------------------------------------- composition --- */

  // Every placed box is tracked so relations and connectors can name content as
  // well as regions.
  const boxes = new Map<string, PlacedBox>();
  const canvasBox: PlacedBox = { id: "root", x: 0, y: 0, w: canvasSize(canvas.width, 1440), h: canvasSize(canvas.height, 900) };
  /**
   * Ids whose relations the solver refused, so they have no resolved position.
   *
   * Declared here rather than inside the relations block because the geometry
   * assertions run afterwards and must skip them. Declaring it in the relations
   * block would make "did this relation hold?" unanswerable for exactly the
   * relations that were never attempted.
   */
  const unresolvedRelations: string[] = [];
  for (const region of regions) boxes.set(region.id, { id: region.id, x: region.x, y: region.y, w: region.w, h: region.h });

  // A region with several children flows them; a region holding one graphic
  // (topology, chart) is left for that graphic's own placement.
  for (const region of regions) {
    const children = ir.content.filter((c) => region.children.includes(c.id));
    if (children.length === 0) continue;

    const pad = normalizePadding(region.padding, canvas.grid);
    const gap = region.gap ?? canvas.grid;
    const inner: ResolvedBox = {
      x: region.x + pad.left,
      y: region.y + pad.top,
      w: Math.max(0, region.w - pad.left - pad.right),
      h: Math.max(0, region.h - pad.top - pad.bottom),
    };

    const used = emitContent({ ir, region, content: children, inner, gap, operations, composition, violations, algorithms, boxes, typeScale, titleScale, look, textMetrics, inAutoLayout: appliedAutoLayout.has(region.id) });
    if (used) algorithms[region.id] = used;
  }

  // Regions grow to fit their content; regions below shift down. Text nodes
  // auto-resize in Figma but region frames do not, so without this a headline
  // taller than its header spilled into the region below and read as clipped.
  // Only growth, never shrinkage; side rails (starting above) never shift.
  if (!deck) {
    fitRegionsToContent({ regions, boxes, operations, grid: canvas.grid, canvasH: canvasSize(canvas.height, 900), bands });
    // …and then the other direction: `solveAxis` handed the leftover to `fill`
    // before any `hug` sibling had been measured, so the fill region can be
    // holding space that a region below it is about to need.
    fitFillRegions({ regions, boxes, operations, canvasH: canvasSize(canvas.height, 900), gutter: canvas.grid * 4, grid: canvas.grid, bands });
  }
  /* --------------------------------------------------------- relations --- */

  // Relations run after everything is placed, so an anchor may be a region or a
  // content node and the solver sees real geometry either way (spec §18).
  let constrained = 0;
  /**
   * Ids whose geometry the relation solver set, possibly empty (no relations).
   * Declared here because the automatic canvas-fit pass after this block must
   * treat them as frozen whether or not relations ran.
   */
  const solverTouched = new Set<string>();
  if (ir.relations.length > 0 && deck) {
    // Relations name anchors that may live on other slides. Positioning content
    // against a box on a different slide would silently misplace it, so deck
    // mode declines the whole list rather than applying half of it.
    violations.push({
      rule: "relation",
      message: `${ir.relations.length} relation(s) were skipped: relations position boxes against each other, which is meaningless across slides. Place content with layout and padding instead.`,
    });
  }
  if (ir.relations.length > 0 && !deck) {
    const before = snapshot(boxes);
    // Region geometry as the shell layout left it, before the solver moves it.
    // Flow laid text out against these boxes, so the delta is what text needs to
    // travel with its region. Without it, text stays behind at the old origin.
    const regionBefore = new Map(regions.map((r) => [r.id, { x: r.x, y: r.y, w: r.w, h: r.h }]));
    // A node the model positioned itself is authoritative: the solver already
    // gave it the position asked for, and re-applying a delta on top of that
    // would double the move.
    const explicitlyPlaced = new Set(ir.relations.map((r) => r.id));
    const solved = solveConstraints({
      boxes: [...boxes.values()],
      constraints: ir.relations.map((r) => ({ ...r })),
      parent: canvasBox,
      violations,
      unresolved: unresolvedRelations,
    });

    let moved = 0;
    for (const box of solved) {
      const prior = before.get(box.id);
      if (prior && (Math.abs(prior.x - box.x) > 0.5 || Math.abs(prior.y - box.y) > 0.5 || Math.abs(prior.w - box.w) > 0.5 || Math.abs(prior.h - box.h) > 0.5)) {
        moved += 1;
        solverTouched.add(box.id);
      }
      boxes.set(box.id, box);
    }

    // Region frames were already emitted, so a moved region needs a follow-up
    // setPosition. Content is emitted per-node below, so it is patched in place
    // instead of re-created.
    for (const box of solved) {
      const prior = before.get(box.id);
      if (!prior) continue;
      const changed =
        Math.abs(prior.x - box.x) > 0.5 ||
        Math.abs(prior.y - box.y) > 0.5 ||
        Math.abs(prior.w - box.w) > 0.5 ||
        Math.abs(prior.h - box.h) > 0.5;
      if (!changed) continue;

      if (regionIds.has(box.id)) {
        operations.push(op({ type: "setPosition", target: box.id, x: box.x, y: box.y }));
        if (Math.abs(prior.w - box.w) > 0.5 || Math.abs(prior.h - box.h) > 0.5) {
          operations.push(op({ type: "setSize", target: box.id, width: Math.max(1, Math.round(box.w)), height: Math.max(1, Math.round(box.h)) }));
        }

        // Carry the region's children with it.
        //
        // Content was packed against the region where the shell layout left it,
        // so moving the region moves its frame and leaves its contents behind.
        // `relayoutRegionText` below rescues TEXT nodes only, which left every
        // component stranded: a relation that moved an inspector to the right of
        // the canvas left its status pill at the bottom of the stage. The new
        // containment check reports this as a geometry violation rather than
        // letting it reach Figma.
        const dx = box.x - prior.x;
        const dy = box.y - prior.y;
        const resized = Math.abs(prior.w - box.w) > 0.5 || Math.abs(prior.h - box.h) > 0.5;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || resized) {
          const region = ir.regions.find((r) => r.id === box.id);
          const childIds = region?.children ?? [];
          if (childIds.length === 0) continue;

          // Translate into the new origin, then re-pack if the region also
          // changed size: children were packed against the old inner box, so a
          // narrower panel would otherwise keep 1168px-wide cards in a 320px
          // frame. Repacking preserves each child's measured height and its
          // declaration order, so the arrangement is the same one the layout
          // would have produced had the region been this size all along.
          const origin = { x: box.x, y: box.y };
          const moved: Array<{ id: string; box: PlacedBox }> = [];
          for (const childId of childIds) {
            const child = boxes.get(childId);
            if (!child) continue;
            const next: PlacedBox = { ...child, x: child.x + dx, y: child.y + dy };
            moved.push({ id: childId, box: next });
          }

          if (resized) {
            const pad = normalizePadding(region?.padding, canvas.grid);
            const gap = (region as { gap?: number } | undefined)?.gap ?? canvas.grid;
            const inner: ResolvedBox = {
              x: box.x + pad.left,
              y: box.y + pad.top,
              w: Math.max(0, box.w - pad.left - pad.right),
              h: Math.max(0, box.h - pad.top - pad.bottom),
            };
            // Re-pack into the region's *own* column count.
            //
            // This hardcoded 1, so shrinking a four-column metrics row to make
            // room for an inspector stacked its four cards in a single column
            // that then overflowed the region (issue #13, live apply gate).
            // The re-pack has to reproduce the layout that would have happened
            // had the region been this size all along, and that layout had four
            // columns in it.
            const columns = repackColumns(region ?? {}, moved.length);
            if (columns !== null) {
              const repacked = packContent({
                region: inner,
                items: moved.map((m) => ({ id: m.id, height: m.box.h })),
                gap,
                columns,
              });
              for (const m of moved) {
                const at = repacked.get(m.id);
                // Width follows the new inner box: a card packed into a 1168px
                // stage must not stay 1168px wide inside a 320px inspector.
                if (at) m.box = { ...m.box, x: at.x, y: at.y, w: at.w };
              }
            }
          }

          for (const m of moved) {
            boxes.set(m.id, m.box);
            patchEmit(
              operations,
              m.id,
              {
                x: m.box.x,
                y: m.box.y,
                width: Math.max(1, Math.round(m.box.w)),
                height: Math.max(1, Math.round(m.box.h)),
              },
              origin,
            );
          }
        }
      } else {
        // Content moved by a relation is patched in place — and in the same
        // coordinate space its create op was emitted in: **parent-local**.
        //
        // The layout computes canvas-absolute boxes, but a create op parented
        // to a region stores the position relative to that region's origin
        // (Figma's convention, which every emitter follows). Patching with the
        // absolute box and no `origin` wrote the region's own offset into the
        // child: a `label-wide` constrained inside a region at x=248 landed at
        // op x=1448 — twice the offset, well outside the region it belonged
        // to — and then failed containment for a move nobody asked for.
        const homeRegion = ir.regions.find((r) => r.children.includes(box.id));
        const parentBox = homeRegion ? boxes.get(homeRegion.id) : undefined;
        patchEmit(
          operations,
          box.id,
          { x: box.x, y: box.y, width: Math.max(1, Math.round(box.w)), height: Math.max(1, Math.round(box.h)) },
          // The parent's *current* origin (the solver may have moved the region
          // first — `boxes` already holds its solved geometry), falling back to
          // canvas space only when the node has no region to be local to.
          parentBox ? { x: parentBox.x, y: parentBox.y } : undefined,
        );
      }
    }

    // Regions may have been resized, so their own text has to follow.
    const reflow = relayoutRegionText({ ir, regions, boxes, operations, violations, regionBefore, explicitlyPlaced });

    regions = regions.map((r) => {
      const box = boxes.get(r.id);
      return box ? { ...r, x: box.x, y: box.y, w: box.w, h: box.h } : r;
    });

    constrained = moved;
    reflowed += reflow;
  }

  /* --------------------------------------------------- canvas-fit reflow --- */

  // The last pass that could move region origins ran above, so this is the
  // final word on the region stack, and it runs on the geometry everything else
  // (connectors, text, containment) will be measured against.
  //
  // Growth passes (`fitRegionsToContent`) and the relation solver can leave a
  // stack past the canvas edge; `fitFillRegions` only shrinks `fill` regions,
  // so an all-fixed stack had nothing to pull it back — the exact stress-case
  // failure this file's `assertResolvedGeometry` was written to *report*. This
  // pass is the automatic repair that turns that report into a fix: shrink the
  // fixed heights toward their content floors and re-stack. Repairs count in
  // `reflowed`, so the payload says the compiler changed geometry on its own
  // initiative.
  //
  // Regions the relation solver positioned are frozen: their geometry is the
  // contract the relations declare, and `checkRelation` already reports one
  // that lands off-canvas rather than silently reinterpreting it.
  let redistribution: { pixels: number; bands: number; note?: string; notes: string[] } = { pixels: 0, bands: 0, notes: [] };
  if (!deck) {
    reflowed += canvasFitReflow({
      regions,
      boxes,
      operations,
      canvasH: canvasSize(canvas.height, 900),
      canvasW: canvasSize(canvas.width, 1440),
      gutter: defaultGutter(canvas.grid) * rhythmScale,
      grid: canvas.grid,
      frozen: ir.relations.length > 0 ? solverTouched : undefined,
    });

    // Vertical redistribution of sparse band space (issue #25, remaining item 1).
    //
    // Every earlier pass fits content INTO the space the bands resolved with;
    // none asks the mirror question — is the space far bigger than the content,
    // and should the content not sit in it? The live fixtures all passed the
    // structural checks while their content hugged the region's top-left and
    // 60-90% of the canvas below stayed one empty band. After every region's
    // height is final, a band whose content fills at most 60% of it gets the
    // leftover split around the content block: centred, per the intent —
    // `alignment: "strong"` keeps the top-anchored placement it declared.
    // Boxes move WITH their emitted operations (patched parent-local), so the
    // trace check keeps proving them; no region box, fill/hug/grow declaration
    // or content extent is stretched, so every containment check stays true.
    redistribution = redistributeBandSpace({
      regions,
      boxes,
      operations,
      grid: canvas.grid,
      alignmentStrong: intent?.alignment === "strong",
      autoLayout: appliedAutoLayout,
      relations: ir.relations,
      ir,
      textMetrics,
    });
    // The payload's one-line summary, in the intentNotes style: what was
    // redistributed, where. Refusals live on `notes` — a band left sparse says
    // why it was left.
    if (redistribution.pixels > 0 && redistribution.bands > 0) {
      redistribution.note = `canvas redistribution: ${redistribution.pixels}px of empty band height given back as breathing room across ${redistribution.bands} sparse band(s).`;
    }
  }

  /* ------------------------------------------------------- connectors --- */

  let connectorRoutes: ConnectorRoute[] = [];
  if (ir.content.some((c) => c.kind === "connector")) {
    connectorRoutes = emitConnectors(ir, boxes, operations, violations, typeScale, deck);
  }

  /* ------------------------------------------------------ token refs --- */

  // A fill or stroke that is not a colour literal is a variable reference
  // ("exo/surface", "surface"), and the node gets bound instead of painted.
  // This is what "prefer tokens automatically" means mechanically: the model
  // writes the token name where a hex would go, and the binding is emitted for
  // it. Literals pass through untouched.
  // Before that pass runs, a design that *declares* its own colour variables
  // gets its matching literals bound to them (bindPaletteToTokens): a program
  // that says "this surface is exo/surface = #23241F" and then paints
  // #23241F/raw hex everywhere was reporting its own palette and still
  // shipping one-off fills — exactly the drift issue #20's reuse requirement
  // names. Only exact, unambiguous hex matches bind; literals whose value two
  // declared variables share are left alone.
  bindPaletteToTokens(operations);
  bindTokenRefs(operations);

  /* -------------------------------------------------------- constraints --- */

  // Run last, on the geometry that is actually returned and actually drawn.
  // Anything earlier would be checking a layout that later passes still move.
  let traceMismatches = 0;
  if (!deck) {
    assertResolvedGeometry(
      ir,
      regions,
      boxes,
      canvasSize(canvas.width, 1440),
      canvasSize(canvas.height, 900),
      violations,
      unresolvedRelations,
    );
    traceMismatches = verifyOperationTrace(operations, boxes, violations);
  }

  checkConstraints(ir, composition, violations);
  if (!deck) checkTextFit(ir, regions, boxes, typeScale, titleScale, violations);

  // A plan whose geometry is not what was asked for is a plan that will draw
  // the wrong thing, so it is marked inapplicable rather than merely annotated.
  // The operations are still returned: the caller can inspect and repair the
  // plan, it just cannot present it as a screen.
  //
  // Only the structural rules gate applicability. A product-constraint warning
  // ("this looks like a card wall") is a judgement about the design, not a
  // statement that the coordinates are wrong.
  const BLOCKING = new Set([
    "geometry",
    "relation",
    "operation-trace",
    "connector",
    "content-parent",
    "identity",
    // Emitted text width contradicting the resolved box is the same class of
    // lie as an operation-trace mismatch, just on one axis: the screen would
    // wrap text at a width the layout never promised.
    "text-bounds",
    // Content that escapes the region that owns it is a structural defect, and
    // the review engine cannot see it: by the time the screen exists, the
    // content and the region have already drifted apart. A region that allows
    // overflow reports it as "containment-allowed" instead, which is advisory.
    "containment",
    // Product guardrails are declared as constraints, so violating one is the
    // program contradicting itself. Blocking here is what makes X08 agree with
    // the documented severity.
    "maxMetricCards",
    "noGenericCardGrid",
    "noChatAsPrimary",
    // Raised by the product guard, which `executeRuntime` runs on every build.
    // A design that contradicts a product truth does not ship silently.
    "product",
  ]);
  const inapplicableReasons = violations.filter((v) => BLOCKING.has(v.rule)).map((v) => v.message);

  return {
    operations,
    regions,
    boxes,
    violations,
    applicable: inapplicableReasons.length === 0,
    inapplicableReasons,
    connectorRoutes,
    stats: {
      regionCount: regions.length,
      contentCount: ir.content.length,
      operationCount: operations.length,
      layoutMs: Math.round((Date.now() - started) * 100) / 100,
      algorithms,
      constrained,
      reflowed,
      traceMismatches,
      nativeLayoutApplied,
      measuredTextUsed,
      // Sparse-band vertical redistribution (issue #25): present whenever a band
      // qualified for redistribution — even when it was left alone, the notes
      // say why — absent when no band was sparse at all.
      ...(redistribution.pixels > 0 || redistribution.notes.length > 0 ? { redistribution } : {}),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Token references                                                          */
/* -------------------------------------------------------------------------- */

/** True when a string is a colour the plugin can paint directly. */
function isColorLiteral(value: string): boolean {
  if (value.trim().toLowerCase() === "transparent") return true;
  try {
    parseColor(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fill for a surface that may be "transparent".
 *
 * Figma has no transparent paint — it is the absence of fill. Emitting the
 * string "transparent" compiles cleanly but fails the live commit
 * ("Unrecognized color"), the same dry-green/commit-red class as the
 * metric-parent and sectionHeader-action defects. Map it to [] here so no
 * primitive can emit it again.
 */
function surfaceFill(value: unknown, fallback: string | never[]): string | never[] {
  if (typeof value === "string" && value.trim().toLowerCase() === "transparent") return [];
  return typeof value === "string" ? value : fallback;
}

/**
 * Rewrites variable references into bindings.
 *
 * Runs last so every node it targets already exists in the operation list:
 * binds are appended, never interleaved, which keeps creation before binding
 * without needing to understand the plan. An op without an id is given one,
 * because a binding needs something to address.
 */
function bindTokenRefs(operations: Operation[]): void {
  const binds: Operation[] = [];

  for (let i = 0; i < operations.length; i++) {
    const candidate = operations[i] as { type?: string; id?: string; fill?: unknown; stroke?: unknown } & Record<string, unknown>;
    if (candidate.type === "bindVariable") continue;

    for (const [key, field] of [["fill", "fills"], ["stroke", "strokes"]] as const) {
      const value = candidate[key];
      if (typeof value !== "string" || isColorLiteral(value)) continue;

      if (candidate.id === undefined) {
        candidate.id = `bind-target-${i}`;
      }
      candidate[key] = key === "fill" ? [] : "#000000";
      binds.push(
        op({
          type: "bindVariable",
          target: candidate.id,
          field,
          variable: value,
        }),
      );
      // No violation reported: binding is the desired behaviour, not a problem.
      // If the variable does not exist the plugin fails loudly at execution,
      // naming the fix.
    }
  }

  operations.push(...binds);
}

/**
 * Binds hardcoded colour literals to the variables the design itself declared.
 *
 * `bindTokenRefs` handles token *names*; this handles the other half of reuse:
 * the compiler's own palette constants (and any raw hex the caller used) that
 * match a colour variable the same program declares with `seed_exo_system` or
 * a `variable` primitive. The result is that a repeated UI pattern painted
 * with one-off hexes ends up on the file's variables instead — the token
 * adoption issue #20 asks for — without changing any visible colour.
 *
 * Only unambiguous single-mode colour values bind. A literal two variables
 * share, or a variable whose chosen mode is not a colour literal, is left as
 * a literal; binding the wrong token is worse than shipping the hex.
 */
function bindPaletteToTokens(operations: Operation[]): void {
  // Variables are defined by createVariable ops in declaration order; only a
  // single-mode value is unambiguous, and "default" is preferred when present.
  const byHex = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const candidate of operations) {
    const c = candidate as { type?: string; id?: string; name?: string; variableType?: string; values?: Record<string, unknown> };
    if (c.type !== "createVariable" || typeof c.name !== "string") continue;
    if (c.variableType !== undefined && String(c.variableType).toUpperCase() !== "COLOR") continue;
    const values = c.values;
    if (!values) continue;
    const modes = Object.keys(values);
    const mode = modes.includes("default") ? "default" : modes.length === 1 ? modes[0]! : undefined;
    if (mode === undefined) continue;
    const value = values[mode];
    if (typeof value !== "string" || !isColorLiteral(value)) continue;
    const hex = value.trim().toUpperCase();
    if (byHex.has(hex)) {
      // A second variable claiming the same value makes the hex ambiguous:
      // mark it, and the bind step leaves those literals as literals.
      ambiguous.add(hex);
      byHex.delete(hex);
      continue;
    }
    if (ambiguous.has(hex)) continue;
    byHex.set(hex, c.name);
  }
  if (byHex.size === 0) return;

  // Token definitions themselves are definitions, not painted nodes.
  const SELF_DEFINING = new Set(["createVariable", "createPaintStyle", "createTextStyle", "bindVariable"]);
  const binds: Operation[] = [];
  for (let i = 0; i < operations.length; i++) {
    const candidate = operations[i] as { type?: string; id?: string; fill?: unknown; stroke?: unknown } & Record<string, unknown>;
    if (SELF_DEFINING.has(candidate.type ?? "")) continue;
    for (const [key, field] of [["fill", "fills"], ["stroke", "strokes"]] as const) {
      const value = candidate[key];
      if (typeof value !== "string" || !isColorLiteral(value)) continue;
      const hex = value.trim().toUpperCase();
      if (ambiguous.has(hex)) continue;
      const variable = byHex.get(hex);
      if (variable === undefined) continue;
      if (candidate.id === undefined) candidate.id = `bind-target-${i}`;
      candidate[key] = key === "fill" ? [] : "#000000";
      binds.push(op({ type: "bindVariable", target: candidate.id, field, variable }));
    }
  }
  operations.push(...binds);
}

/* -------------------------------------------------------------------------- */
/* Tokens, styles, variables                                                   */
/* -------------------------------------------------------------------------- */

function emitTokens(ir: DesignIR, operations: Operation[]): void {
  for (const token of ir.tokens) {
    if (token.kind === "token") {
      const modes = Object.keys(token.values);
      operations.push(
        op({
          type: "createVariable",
          id: token.id,
          name: token.name,
          variableType: token.type,
          ...(token.collection !== undefined ? { collection: token.collection } : {}),
          ...(token.scopes !== undefined ? { scopes: token.scopes } : {}),
          ...(token.description !== undefined ? { description: token.description } : {}),
          values: modes.length === 0 ? { default: token.type === "number" ? 0 : token.type === "boolean" ? false : "#000000" } : token.values,
        }),
      );
      continue;
    }

    if (token.kind === "textStyle") {
      operations.push(
        op({
          type: "createTextStyle",
          id: token.id,
          name: token.name,
          family: token.family,
          weight: token.weight,
          fontSize: token.fontSize,
          ...(token.lineHeight !== undefined ? { lineHeight: token.lineHeight } : {}),
          ...(token.letterSpacing !== undefined ? { letterSpacing: token.letterSpacing } : {}),
          ...(token.fill !== undefined ? { fill: resolveToken(token.fill) } : {}),
        }),
      );
      continue;
    }

    operations.push(
      op({
        type: "createPaintStyle",
        id: token.id,
        name: token.name,
        color: token.color,
        opacity: token.opacity,
      }),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Connectors                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Shifts a normalised connector path by (dx, dy).
 *
 * `normalizePath` frames the route at its own top-left, so a node padded by
 * strokeWeight/2 on every side would leave the path glued to the node's top
 * and left edges — half the stroke hanging outside the bounds that are
 * supposed to enclose it. Shifting every coordinate by the pad centres the
 * route in its padded node. Only M/L/Z occur here (the normaliser flattens
 * curves), so numbers strictly alternate x, y after each command.
 */
function shiftNormalizedPath(path: string, dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return path;
  const r3 = (n: number): number => Math.round(n * 1000) / 1000;
  const out: string[] = [];
  let axis = 0;
  for (const token of path.split(" ")) {
    if (token === "M" || token === "L" || token === "Z") {
      out.push(token);
      axis = 0;
      continue;
    }
    const n = Number(token);
    if (!Number.isFinite(n)) {
      out.push(token);
      continue;
    }
    out.push(String(r3(n + (axis === 0 ? dx : dy))));
    axis = 1 - axis;
  }
  return out.join(" ");
}

/**
 * The start and end of a routed connector's main path.
 *
 * Reads the two moveto/lineto coordinates rather than re-deriving them, so the
 * check measures what was actually emitted rather than what the router believed
 * it emitted. Only the first subpath is read: arrowheads ride as closed
 * subpaths after it, and their corners are not the route's ends — measuring
 * them claimed a headed edge ended ~10px off its node, which is exactly the
 * false "route solved against stale geometry" defect this check exists to catch.
 */
function routeEndpoints(path: string): Array<{ x: number; y: number }> {
  const main = path.split(" M ")[0] ?? path;
  const numbers = main.match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!numbers || numbers.length < 4) return [];
  const n = (i: number): number => Number(numbers[i]);
  return [
    { x: n(0), y: n(1) },
    { x: n(numbers.length - 2), y: n(numbers.length - 1) },
  ];
}

/**
 * Emits connectors as vector nodes.
 *
 * A connector compiles to `createVector` rather than a bespoke operation: the
 * route is solved here into path data, which then goes through the same
 * allowlisted, non-evaluating path pipeline as every other vector. Arrowheads are
 * closed subpaths inside that same path, so a connector is one node.
 *
 * Returns each routed connector's resolved endpoints and label anchor, so the
 * result carries the same evidence the dispatch-time preflight re-proves.
 */
function emitConnectors(
  ir: DesignIR,
  boxes: Map<string, PlacedBox>,
  operations: Operation[],
  violations: CompileResult["violations"],
  typeScale: number,
  deck: boolean,
): ConnectorRoute[] {
  const connectors = ir.content.filter((c) => c.kind === "connector");
  const labels: Array<{ id: string; text: string; x: number; y: number; weight: number; parent: string }> = [];
  // Reserved label lanes, canvas-absolute: every accepted caption claims its
  // box so later edges route theirs around it instead of stacking on it.
  const reserved: Array<{ x: number; y: number; w: number; h: number }> = [];
  const routes: ConnectorRoute[] = [];

  // Which region each content node belongs to. Needed in deck mode, where a
  // connector must live on the same slide as both of its endpoints.
  const home = new Map<string, string>();
  for (const region of ir.regions) {
    for (const child of region.children) home.set(child, region.id);
  }
  // Regions are never obstacles: every edge lives inside one, so measuring a
  // route against its own parent's box would flag every connector in the file.
  // Only placed content (machines, cards, pills) can be crossed or overlapped.
  const regionIds = new Set(ir.regions.map((r) => r.id));
  const nodeBoxes = new Map([...boxes].filter(([id]) => !regionIds.has(id)));

  for (const spec of connectors) {
    if (spec.kind !== "connector") continue;

    // A connector lives with its endpoints. In deck mode that is load-bearing
    // (a line cannot span slides, so crossing one is a violation rather than
    // a silently misplaced vector). Outside deck mode a connector joining two
    // nodes inside one region parents to that region, so it moves with the
    // region instead of orphaning at the root. Coordinates below are
    // parent-local either way, so the region's origin is subtracted from the
    // absolute route geometry when it is the parent.
    let parent = "root";
    const origin = { x: 0, y: 0 };
    if (deck) {
      const fromHome = home.get(spec.from);
      const toHome = home.get(spec.to);
      if (fromHome === undefined || toHome === undefined || fromHome !== toHome) {
        violations.push({
          rule: "connector",
          message: `Connector '${spec.id}' crosses slides ('${spec.from}' on '${fromHome ?? "?"}', '${spec.to}' on '${toHome ?? "?"}'). Connectors must stay inside one slide.`,
        });
        continue;
      }
      parent = fromHome;
    } else {
      const fromHome = home.get(spec.from);
      const toHome = home.get(spec.to);
      if (fromHome !== undefined && fromHome === toHome) {
        const regionBox = boxes.get(fromHome);
        if (regionBox) {
          parent = fromHome;
          origin.x = regionBox.x;
          origin.y = regionBox.y;
        }
      }
    }

    const fromBox = boxes.get(spec.from);
    const toBox = boxes.get(spec.to);
    // Route clearance: the default route is solved as always, then
    // deterministic Z-stair reroutes run when it passes *through* a third-party
    // node. The chosen route is what is emitted, whatever it was; a crossing
    // it could not shake after bounded effort is a named violation, never a
    // silent line over a box.
    const solved = routeConnectorClearance(spec, fromBox, toBox, nodeBoxes, CONNECTOR_CLEARANCE_MIN);
    let route = solved?.result ?? null;
    if (!route) {
      // Distinguish "you never drew it" from "you drew it but it got no
      // geometry". Collapsing both into "unknown node" sent the reader looking
      // for a missing node that was sitting right there in `content` — the live
      // defect behind hard stress test #10, where `device-a` and `model` were
      // both declared and both reported unknown.
      const declared = new Set(ir.content.map((c) => c.id));
      const describe = (id: string): string =>
        declared.has(id)
          ? `'${id}' (declared in content but never placed — give it a parent region)`
          : `'${id}' (not declared anywhere in this IR)`;
      const missing = [!boxes.has(spec.from) ? spec.from : null, !boxes.has(spec.to) ? spec.to : null].filter((v): v is string => v !== null);
      violations.push({
        rule: "connector",
        message: `Connector '${spec.id}' references ${missing.map(describe).join(" and ")}. Draw the nodes before connecting them.`,
      });
      continue;
    }

    // Route-through-node is the hard class: a segment entering a node box it
    // does not connect is named as a `connector` violation (blocking) so the
    // dispatcher's preflight gates the plan on it, instead of letting the
    // screen ship with edges drawn over machines. What remains after bounded
    // reroutes is the best variant found, not a silent best.
    if (solved && solved.through.length > 0) {
      const names = solved.through.slice(0, 4).map((n) => `'${n}'`).join(", ");
      violations.push({
        rule: "connector",
        message: `Connector '${spec.id}': route of '${spec.from}' to '${spec.to}' passes through node ${names}. Move the node(s) off the edge or reroute with routing:'straight'.`,
      });
    }

    // Node-edge clearance: an edge that passes close to a third-party node —
    // without entering it — reads as ambiguity. Reported for the route that was
    // actually chosen; when a reroute cleared a crossing the message says so
    // rather than repeating the old geometry's complaint.
    if (route && fromBox && toBox) {
      const offenders = solved?.halo ?? [];
      if (offenders.length > 0) {
        const names = offenders.slice(0, 4).map((n) => `'${n}'`).join(", ");
        const reroutLine = solved?.detoured && solved.through.length === 0 ? ", so it was rerouted clear of them" : "";
        violations.push({
          rule: "layout",
          message: `Connector '${spec.id}' passes within ${CONNECTOR_CLEARANCE_MIN}px of ${names}${offenders.length > 4 ? ` and ${offenders.length - 4} more` : ""} on its default routing${reroutLine}. Move the node(s) off the edge or reroute with routing:'straight'.`,
        });
      }
    }

    let normalized;
    try {
      normalized = normalizePath(route.path);
    } catch (error) {
      violations.push({ rule: "connector", message: `Connector '${spec.id}' produced unusable geometry: ${(error as Error).message}` });
      continue;
    }

    // Endpoints must actually touch the nodes they claim to connect, measured
    // against the final geometry. Routing already clips to the box edges, so a
    // line landing far from both nodes means the box the router used was not the
    // box that ended up in the file — which is what issue #11 asked to prove
    // rather than assume.
    if (fromBox && toBox) {
      const endpoints = routeEndpoints(route.path);
      routes.push({ id: spec.id, from: spec.from, to: spec.to, endpoints, ...(route.labelAt !== undefined ? { labelAt: route.labelAt } : {}) });
      const hull = {
        x: Math.min(fromBox.x, toBox.x),
        y: Math.min(fromBox.y, toBox.y),
        right: Math.max(fromBox.x + fromBox.w, toBox.x + toBox.w),
        bottom: Math.max(fromBox.y + fromBox.h, toBox.y + toBox.h),
      };
      const REACH = 2;
      for (const p of endpoints) {
        if (p.x >= hull.x - REACH && p.x <= hull.right + REACH && p.y >= hull.y - REACH && p.y <= hull.bottom + REACH) continue;
        violations.push({
          rule: "connector",
          message: `Connector '${spec.id}' has an endpoint at (${Math.round(p.x)}, ${Math.round(p.y)}), outside both '${spec.from}' and '${spec.to}'. The route was not solved against the final node geometry.`,
        });
        break;
      }
    }

    // A short gap cannot show arrowheads: heads that cover the whole chord
    // read as decoration on nothing, so the router draws a plain line and says
    // so in the summary. That silence used to be total — restated here as an
    // advisory finding, so "no direction cue" is a visible decision with a fix,
    // not a mystery. Advisory (`layout`, never blocking): a short gap is a
    // spacing judgement, not broken geometry.
    if (route.arrowheadsOmitted) {
      violations.push({
        rule: "layout",
        message: `Connector '${spec.id}' is shorter than its arrowheads need, so it is drawn as a plain line without heads. Separate '${spec.from}' and '${spec.to}' to show direction, or set arrowEnd:false to own the plain line.`,
      });
    }

    const pad = (spec.strokeWeight ?? 1) / 2;
    operations.push(
      op({
        type: "createVector",
        id: spec.id,
        parent,
        name: route.summary,
        // Vector bounds must enclose the stroke: a stroked vector's paint
        // straddles its path by half the weight on every side, so the node is
        // padded by strokeWeight/2 against the raw path bounds and the path is
        // shifted into the centre of its padded node. Without this a 3px
        // critical edge clips half its ink at the node edge.
        x: normalized.x - origin.x - pad,
        y: normalized.y - origin.y - pad,
        width: normalized.width + pad * 2,
        height: normalized.height + pad * 2,
        path: shiftNormalizedPath(normalized.path, pad, pad),
        stroke: spec.stroke !== undefined ? resolveToken(spec.stroke) : "#8A8C84",
        strokeWeight: spec.strokeWeight,
        fill: [],
        ...(spec.dashPattern !== undefined ? { dashPattern: spec.dashPattern } : {}),
        // An arrowhead is a filled triangle, so the vector needs a fill as well
        // as a stroke. Without one the heads would render as outlines.
        fillArrows: true,
      }),
    );

    if (spec.label && route.labelAt) {
      // Collision-aware caption: try the free side above the edge first, then
      // around it, never on top of a node or another caption. The obstacles are
      // the final placed boxes (relations already ran), so a label anchored near
      // a moved node still clears it.
      const obstacles = [...nodeBoxes.values()].map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
      const at = pickLabelPosition(route.labelAt, labelTangent(route.points), spec.label, obstacles, reserved);
      reserved.push(labelBoxAt(at.x, at.y, spec.label));
      labels.push({ id: `${spec.id}-label`, text: spec.label, x: at.x - origin.x, y: at.y - origin.y, weight: spec.strokeWeight, parent });
      const entry = routes.find((r) => r.id === spec.id);
      if (entry) entry.labelAt = at;
    }
  }

  // Z-order: vectors first, captions after. Operation order is paint order, so
  // every connector line paints above node fills/frames (emitted earlier, in
  // the content pass) and every caption paints above its line. A connector is
  // kind-distinct from decorative borders and rules: its name states the routed
  // edge, and no shape/vector/line decoration emission sets `fillArrows`.
  for (const label of labels) {
operations.push(
        op({
          type: "createText",
          id: label.id,
          parent: label.parent,
          name: `Label ${label.text.slice(0, 24)}`,
          x: Math.round(label.x * 100) / 100,
          y: Math.round(label.y * 100) / 100,
          content: label.text,
        fontSize: Math.round(11 * typeScale),
        weight: 600,
        family: "JetBrains Mono",
        fill: "#5A5C54",
      }),
    );
  }
  return routes;
}

/* -------------------------------------------------------------------------- */
/* Content emission                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Places a region's children and emits their operations.
 *
 * The arrangement comes from `region.layout`, which is what makes the §17
 * algorithms reachable from a program. `flow` and `grid` keep the existing
 * vertical-stack behaviour; the rest delegate to `algorithms.ts`.
 *
 * Returns the algorithm actually used, or undefined when there was nothing to
 * place. Every placed box is recorded so relations and connectors can name it.
 */
function emitContent(args: {
  ir: DesignIR;
  region: ResolvedRegion;
  content: ContentSpec[];
  inner: ResolvedBox;
  gap: number;
  operations: Operation[];
  composition: string;
  violations: CompileResult["violations"];
  algorithms: Record<string, string>;
  boxes: Map<string, PlacedBox>;
  /** Multiplier for type and hug-measured components. 1 outside deck mode. */
  typeScale: number;
  /** Contrast-intent multiplier for display type. 1 unless contrast is bold/muted. */
  titleScale: number;
  /** Preset look: nav voice, value numerals, header scale, panel padding. */
  look: StyleLook;
  /** Measured text heights, when the caller could measure them. */
  textMetrics?: Map<string, { width: number; height: number }>;
  /**
   * True when this region's frame is a native auto-layout container.
   *
   * Text inside it is emitted with `textAutoResize: "HEIGHT"` so the node
   * wraps at its emitted width and Figma's own layout stacks it — which is
   * exact only because the gate required every text child to be measured.
   */
  inAutoLayout?: boolean;
}): string | undefined {
  const { ir, region, content, inner, gap, operations, composition, violations, algorithms, boxes, typeScale, titleScale, look, textMetrics, inAutoLayout } = args;
  const grid = ir.canvas.grid;

  const textItems = content.filter((c) => c.kind === "text");
  const graphics = content.filter((c) => c.kind === "shape" || c.kind === "vector");
  const components = content.filter((c) => c.kind === "component");
  const instances = content.filter((c) => c.kind === "instance");
  const connectors = content.filter((c) => c.kind === "connector");
  // Instances are fixed-extent members of the flow, placed like components;
  // they only differ at emission (createInstance against the live file).
  const drawable = [...textItems, ...graphics, ...components, ...instances];

  if (drawable.length === 0) return undefined;

  // Metric cards are a grid; a topology map is a single centred graphic;
  // everything else is a vertical flow. Choosing per-composition is what stops
  // every screen looking like the same card wall. The region's own composition
  // counts too: a status rail is an instrument strip no matter what the screen
  // around it inferred as — without this, a rail on a spatial screen collapsed
  // to one column and its pills overflowed the rail.
  const regionComposition = (region as { composition?: string }).composition;
  const grantGrid = composition === "instrument" || composition === "table" || regionComposition === "instrument" || regionComposition === "table";
  // Rows read across: a table of model rows laid in three columns is a card
  // wall wearing a table's name. When every flowing component is row-like,
  // stack full-width regardless of the grid grant.
  const ROW_TYPES = new Set(["modelRow", "timelineEvent", "tableRow"]);
  const allRows = components.length > 0 && [...textItems, ...components].every((c) => c.kind === "text" || (c.kind === "component" && ROW_TYPES.has(c.type)));
  // Destinations run across, not down. A nav rail and a mobile bottom bar hold
  // nothing but nav items, and a column of them is not navigation — four tabs
  // stacked in a 72px footer is a list that happens to be inside a bar. On a
  // 390x844 canvas that pushed the footer from 72px to 168px and took the last
  // two tabs off the canvas entirely (issue #12, R2: "devices resolves at y=824
  // and settings at y=864" in a footer at y=772).
  //
  // `packContent` fills row-major, so one column per item is exactly a row. A
  // hug nav item then draws at its own width inside its own column, which keeps
  // the rhythm even and leaves the rail left-aligned rather than stretched.
  const flowing = [...textItems, ...components, ...instances];
  // Destinations run across only when they are a *bar*. A region of nav items
  // that is tall is a rail and must stack: the live apply rendered a 220x900
  // side rail with four tabs crammed into the top 36px, the second hidden behind
  // the active pill, because "all nav items go in one row" had no idea which of
  // the two it was looking at.
  //
  // A bar is a footer, or any navigation region short enough to be one — a
  // mobile bottom nav. A rail is `height: "fill"` or a tall fixed height, and
  // stacks. Issue #12 fixed the mobile case and this widens it back to only the
  // mobile case.
  const allNav = flowing.length > 0 && flowing.every((c) => c.kind === "component" && c.type === "navItem");
  const navIsBar = region.role === "footer" || (typeof region.height === "number" && region.height <= 120);
  // Prose is one column. A grid grant exists to arrange *cards and rows* side by
  // side; handing the same three columns to a region's text made a single body
  // paragraph resolve 114px wide on a 390px phone (issue #12, R2/A9: narrow
  // typography stress). A region with no components has nothing to grid.
  const allText = flowing.length > 0 && flowing.every((c) => c.kind === "text");
  const columns = region.columns ?? (allNav && navIsBar ? Math.max(1, flowing.length) : !grantGrid || allRows || allText ? 1 : 3);
  const requested = region.layout;

  /* --- graphics routed through a §17 algorithm ---------------------------- */

  const graphicAlgorithm =
    requested === "flow" || requested === "grid"
      ? null
      : requested === "topology"
        ? ir.links.length > 0
          ? "tree"
          : "cluster"
        : requested;

  // Device nodes join algorithmic placement: a topology region holds machines,
  // not abstract dots, and stacking them in a column would defeat the layout the
  // caller asked for. Other components keep flowing; a metric card has no
  // business in a force graph.
  const graphDevices =
    graphicAlgorithm && graphicAlgorithm !== "masonry"
      ? components.filter((c) => c.kind === "component" && c.type === "deviceNode")
      : [];
  // Devices placed by the graph algorithm must survive into the flow probe:
  // the band the flow pass will occupy is computed over exactly the list that
  // pass will pack, so the reserve and the pack can never disagree.
  const placedIds = new Set(graphDevices.map((c) => c.id));
  const flowItems = [...textItems, ...components.filter((c) => !placedIds.has(c.id)), ...instances.filter((c) => !placedIds.has(c.id))];
  type GraphItem = Extract<ContentSpec, { kind: "shape" | "vector" | "component" }>;
  const graphItems: GraphItem[] = [...(graphics as GraphItem[]), ...graphDevices];
  const deviceSize = { w: grid * 16, h: grid * 10 };

  if (graphItems.length > 0 && graphicAlgorithm) {
    const algorithm = graphicAlgorithm === "force" ? "forceGraph" : graphicAlgorithm;
    algorithms[region.id] = algorithm;

    const nodes = graphItems.map((c, i) => ({ id: c.id, order: i }));
    // Graph nodes have real extent (128x80 devices), but algorithms return
    // centres spaced by `gap` alone — a 32px pitch under 128px nodes overlaps
    // by construction, and overlap separation then shoved the fan into a
    // vertical chain with edges crossing through nodes. Pitch by node size.
    const hasDevices = graphDevices.length > 0;
    const nodeGap = hasDevices ? deviceSize.w + gap : gap;
    // Arrowheads need room: a connector shorter than its heads loses them with
    // only a warning, so pitch device levels far enough apart that the heaviest
    // edge keeps its direction. A 1px edge needs 20px, a 3px critical edge 50px;
    // the +4 margin survives the selection-ring expansion applied later.
    const edgeNodeIds = new Set(graphItems.map((c) => c.id));
    const heaviestEdge = ir.content.reduce(
      (m, c) =>
        c.kind === "connector" && edgeNodeIds.has(c.from) && edgeNodeIds.has(c.to)
          ? Math.max(m, typeof c.strokeWeight === "number" ? c.strokeWeight : 1)
          : m,
      1,
    );
    const levelClearance = Math.max(gap * 2, arrowSpace(heaviestEdge) + 4);
    const nodeLevelGap = hasDevices ? deviceSize.h + levelClearance : gap * 2;

    // The flow band (a title, a legend, pills) stacks from the region's top in
    // the flow pass that follows, so a ladder that spans the full inner box
    // would climb over it. Probe the same packing the flow pass will run and
    // reserve exactly the band it occupies: the graph then owns what remains,
    // and a spread ladder and a title can no longer collide.
    let flowBandH = 0;
    if (flowItems.length > 0) {
      const flowProbe = packContent({
        region: inner,
        items: flowItems.map((c) => ({ id: c.id, height: estimateHeight(c, inner.w, typeScale, titleScale, grid, look, textMetrics) })),
        gap,
        columns,
      });
      for (const box of flowProbe.values()) {
        flowBandH = Math.max(flowBandH, box.y + box.h - inner.y);
      }
      // A crowded flow band must never squeeze the graph out entirely: keep at
      // least one row's extent so the algorithm has somewhere to place its
      // nodes and the squeeze surfaces as a placement warning, not as regions
      // the diagram never fit in.
      flowBandH = Math.min(flowBandH, Math.max(0, inner.h - nodeLevelGap));
    }
    const graphInner: ResolvedBox = { x: inner.x, y: inner.y + flowBandH, w: inner.w, h: Math.max(0, inner.h - flowBandH) };

    // Spread the tree ladder into the space the region actually has.
    //
    // The floor pitch keeps arrowheads alive (levelClearance), but it only ever
    // *adds* clearance above node height: a 4-level graph on a tall hero left
    // three quarters of the region empty while sibling gaps stayed at the
    // minimum, forcing cross links to thread between 8-12px gutters. Two
    // bounded runs of the same deterministic algorithm make the pitch a
    // decision instead of a floor: the probe fixes structure (deeper levels and
    // leaf columns read off the same layout), then both pitches expand to span
    // what remains — capped so no box can ever leave the bounds (a pitch
    // beyond `(inner.h - nodeH) / rows` pushes the centred first row's box
    // above the region) and floored at the clearance so a tight region keeps
    // exactly the old behaviour rather than overlapping.
    let levelPitch = nodeLevelGap;
    let columnPitch = nodeGap;
    // `tidyTree` never reaches this block: region.layout has no such value and
    // `topology` resolves to tree/cluster above, so the union excludes it.
    if (algorithm === "tree") {
      const structureHead = runAlgorithm(algorithm, nodes, ir.links, {
        bounds: graphInner,
        gap: nodeGap,
        levelGap: nodeLevelGap,
        columns,
        ...(hasDevices ? { nodeSize: deviceSize } : {}),
      });
      const deepest = typeof (structureHead.detail as { depth?: number } | undefined)?.depth === "number" ? (structureHead.detail as { depth: number }).depth : 0;
      const rows = Math.max(1, deepest + 1);
      let leafCols = 1;
      let minX = Infinity;
      let maxX = -Infinity;
      let finite = false;
      for (const p of structureHead.points.values()) {
        if (!Number.isFinite(p.x)) continue;
        finite = true;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
      }
      if (finite && nodeGap > 0) leafCols = Math.max(1, Math.round((maxX - minX) / nodeGap) + 1);
      const nodeExtent = hasDevices ? deviceSize : graphicSize(grid);
      if (rows >= 2 && graphInner.h > nodeExtent.h) {
        levelPitch = Math.max(nodeLevelGap, (graphInner.h - nodeExtent.h) / rows);
      }
      if (leafCols >= 2 && graphInner.w > nodeExtent.w) {
        columnPitch = Math.max(nodeGap, (graphInner.w - nodeExtent.w) / leafCols);
      }
    }
    // Non-tree algorithms keep their existing pitch derivation: the spread is
    // a tree property (levels and leaf columns), and `levelGap` on other
    // routes means something else (timeline lanes).

    // `forceGraph` is served by the existing simulator; the rest are in
    // algorithms.ts. Both return centres, which the caller turns into boxes.
    const points =
      algorithm === "forceGraph"
        ? forceDirected(
            nodes,
            ir.links,
            { center: { x: inner.x + inner.w / 2, y: inner.y + inner.h / 2 }, radius: Math.max(40, Math.min(inner.w, inner.h) / 3) },
          )
        : runAlgorithm(algorithm, nodes, ir.links, {
            bounds: graphInner,
            gap: columnPitch,
            levelGap: levelPitch,
            columns,
            ...(hasDevices ? { nodeSize: deviceSize } : {}),
          }).points;

    const size = graphicSize(grid);
    // NaN guard: a misbehaving algorithm (unknown name falling through to a
    // mismatched default) must degrade to a deterministic column, never emit
    // non-finite coordinates into Figma operations.
    let nanFallbacks = 0;
    const finitePoints = new Map<string, { x: number; y: number }>();
    graphItems.forEach((spec, i) => {
      const at = points.get(spec.id);
      if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) {
        finitePoints.set(spec.id, at);
      } else {
        nanFallbacks++;
        finitePoints.set(spec.id, {
          x: graphInner.x + graphInner.w / 2,
          y: graphInner.y + grid * 10 + i * (deviceSize.h + (hasDevices ? levelClearance : gap)),
        });
      }
    });
    if (nanFallbacks > 0) {
      violations.push({
        rule: "layout",
        message: `${nanFallbacks} node(s) got non-finite coordinates from '${algorithm}'; placed in a fallback column instead.`,
      });
    }
    const sepBoxes: Array<{ id: string; x: number; y: number; w: number; h: number }> = [];
    for (const spec of graphItems) {
      const at = finitePoints.get(spec.id);
      if (!at) continue;
      // A device keeps its natural machine-tile size; abstract graphics share
      // one small square so dots and rings read as one system. A line keeps a
      // tight row: its height is the stroke it draws, not the square — the
      // emitter draws exactly this, so the recorded box matches it.
      const extent = spec.kind === "component" ? deviceSize : isLineShape(spec) ? { w: size.w, h: lineStrokeHeight(spec) } : size;
      sepBoxes.push({
        id: spec.id,
        x: Math.round(at.x - extent.w / 2),
        y: Math.round(at.y - extent.h / 2),
        w: extent.w,
        h: extent.h,
      });
    }
    // Algorithms place centres without knowing tile sizes; separate real boxes
    // so a tight tree cannot pile 128px tiles on 24px slots (live defect).
    // Integer coordinates: fractional drift from halving shifts is invisible
    // precision that only pollutes grid-alignment checks downstream.
    for (const b of sepBoxes) { b.x = Math.round(b.x); b.y = Math.round(b.y); }
    const sep = separateOverlaps(sepBoxes, { x: graphInner.x, y: graphInner.y, w: graphInner.w, h: graphInner.h }, hasDevices ? levelClearance : gap);
    if (sep.remaining > 0) {
      violations.push({
        rule: "layout",
        message: `${sep.remaining} graph pair(s) still overlap after separation in '${region.id}'.`,
      });
    }
    for (const spec of graphItems) {
      const placed0 = sepBoxes.find((b) => b.id === spec.id);
      if (!placed0) continue;
      placed0.x = Math.round(placed0.x);
      placed0.y = Math.round(placed0.y);
      // The recorded box and the drawn node share one optically-corrected box,
      // so connectors, relations and the returned geometry all agree.
      const placed: ResolvedBox = devicePlacementBox({ x: placed0.x, y: placed0.y, w: placed0.w, h: placed0.h }, spec);
      boxes.set(spec.id, { id: spec.id, ...placed });
      if (spec.kind === "component") emitComponent(spec, region, placed, operations, grid, typeScale, look);
      else if (spec.kind === "shape" || spec.kind === "vector") emitGraphic(spec, region, placed, operations);
    }
  } else if (graphics.length > 0) {
    // Default: three or more graphics in a visual region read as a topology, so
    // they get a radial arrangement rather than a boring column.
    const isTopology = graphics.length >= 3 || region.role === "primary-visual" || region.role === "hero";

    if (isTopology) {
      algorithms[region.id] = "radial";
      const centre = { x: inner.x + inner.w / 2, y: inner.y + inner.h / 2 };
      const radius = Math.max(40, Math.min(inner.w, inner.h) / 2 - grid * 4);
      const spots = radial(graphics, centre, radius);

      for (const spec of graphics) {
        const at = spots.get(spec.id);
        if (!at) continue;
        // Dots overshoot their mathematical box so they read the same size as
        // the flat-edged tiles around them. A line is exempt from the
        // overshoot: its row is already tight (see lineStrokeHeight), and
        // padding it would break the agreement with what is emitted.
        const box: ResolvedBox = isLineShape(spec)
          ? { x: at.x - grid * 2, y: at.y, w: grid * 4, h: lineStrokeHeight(spec) }
          : overshoot({ x: at.x - grid * 2, y: at.y - grid * 2, w: grid * 4, h: grid * 4 });
        boxes.set(spec.id, { id: spec.id, ...box });
        emitGraphic(spec, region, box, operations);
      }
    } else {
      const placed = packContent({
        region: inner,
        // A line reserves its stroke height, not the graphic square: packing
        // it at 48px and emitting it at 2px would disagree by construction.
        items: graphics.map((c) => ({ id: c.id, height: isLineShape(c) ? lineStrokeHeight(c) : grid * 6 })),
        gap,
        columns,
      });

      for (const spec of graphics) {
        const box = placed.get(spec.id);
        if (!box) continue;
        const resolved: ResolvedBox = { ...box, h: isLineShape(spec) ? lineStrokeHeight(spec) : grid * 6 };
        boxes.set(spec.id, { id: spec.id, ...resolved });
        emitGraphic(spec, region, resolved, operations);
      }
    }
  }

  /* --- text and components flow ------------------------------------------ */

  // Devices already placed by a graph algorithm must not flow as well, or every
  // machine would be drawn twice: once on the graph, once in a column.
  const flow = flowItems;
  if (flow.length > 0) {
    if (requested === "grid") algorithms[region.id] = "grid";
    else if (requested === "masonry") algorithms[region.id] = "masonry";
    else if (!algorithms[region.id]) algorithms[region.id] = "flow";

    const flowColumns = requested === "masonry" ? columns : columns;

    if (requested === "masonry") {
      const points = runAlgorithm(
        "masonry",
        flow.map((c, i) => ({ id: c.id, order: i, height: estimateHeight(c, inner.w, typeScale, titleScale, grid, look, textMetrics) })),
        [],
        { bounds: inner, gap, columns: flowColumns },
      ).points;

      for (const spec of flow) {
        const at = points.get(spec.id);
        if (!at) continue;
        const w = (inner.w - gap * (flowColumns - 1)) / flowColumns;
        const box: ResolvedBox = devicePlacementBox({ x: at.x, y: at.y, w, h: estimateHeight(spec, w, typeScale, titleScale, grid, look, textMetrics) }, spec);
        const final = resolvedSize(spec, box, grid, typeScale, look);
        boxes.set(spec.id, { id: spec.id, ...final });
        if (spec.kind === "text") emitText(spec, region, final, operations, violations, typeScale, titleScale, look, inAutoLayout);
        else if (spec.kind === "instance") emitInstance(spec, region, final, operations);
        else emitComponent(spec, region, final, operations, grid, typeScale, look);
      }
    } else {
      const placed = packContent({
        region: inner,
        items: flow.map((c) => ({ id: c.id, height: estimateHeight(c, inner.w, typeScale, titleScale, grid, look, textMetrics) })),
        gap,
        columns: flowColumns,
      });

      for (const spec of flow) {
        const box = placed.get(spec.id);
        if (!box) continue;
        const final = resolvedSize(spec, devicePlacementBox(box, spec), grid, typeScale, look);
        boxes.set(spec.id, { id: spec.id, ...final });
        if (spec.kind === "text") emitText(spec, region, final, operations, violations, typeScale, titleScale, look, inAutoLayout);
        else if (spec.kind === "instance") emitInstance(spec, region, final, operations);
        else emitComponent(spec, region, final, operations, grid, typeScale, look);
      }
    }
  }

  // Connectors are resolved after the whole screen is placed, since they may
  // reference nodes in other regions. Recorded here so the caller knows they
  // were seen.
  if (connectors.length > 0) return algorithms[region.id] ?? "flow";

  return algorithms[region.id];
}

/** The narrowest text layer the compiler will emit or record. */
const TEXT_MIN_WIDTH = 40;

/**
 * The width a text layer is emitted at AND its resolved box records.
 *
 * One formula, two consumers (`emitText`, `resolvedSize`), because the last
 * version had two: the emitter wrote `max(40, maxWidth ?? box.w)` while the
 * resolved box recorded `min(box.w, maxWidth)` — so a `maxWidth` larger than
 * the packed column, or smaller than the 40px floor, produced an emitted width
 * that contradicted the geometry the trace check compares against, and the text
 * wrapped at a width the layout never promised.
 *
 * The column always caps the request (a `maxWidth` larger than the space is not
 * a request to overflow), and the 40px floor applies in BOTH places so a
 * maxWidth of 20 in a 120px column emits and records 40 — consistent, if
 * degenerate. Applying the formula to its own output is stable, which is what
 * makes emit-time re-derivation from the resolved box safe.
 *
 * A column that is itself degenerate (0-wide: padding and gap squeezed the
 * content out) is NOT floored up: the zero-extent check must still see it, so
 * a squeezed-out child keeps resolving to zero and the "no room for it"
 * finding keeps firing. Flooring that would paper over a real squeeze as a
 * fake 40px box.
 */
function textEmittedWidth(spec: Extract<ContentSpec, { kind: "text" }>, columnW: number): number {
  const requested = spec.maxWidth !== undefined && spec.maxWidth > 0 ? Math.min(spec.maxWidth, columnW) : columnW;
  return Math.max(TEXT_MIN_WIDTH, Math.round(requested));
}

function emitText(
  spec: Extract<ContentSpec, { kind: "text" }>,
  region: ResolvedRegion,
  box: ResolvedBox,
  operations: Operation[],
  violations: CompileResult["violations"],
  typeScale = 1,
  titleScale = 1,
  look: StyleLook = DEFAULT_LOOK,
  inAutoLayout = false,
): void {
  box = { ...box, x: box.x - region.x, y: box.y - region.y };
  const scale = TYPE_SCALE[spec.role] ?? TYPE_SCALE.body!;
  // Display roles answer contrast intent: bold contrast lifts headlines, muted
  // contrast quiets them. Body text is never touched — emphasis that moves
  // everything moves nothing.
  const display = spec.role === "title" || spec.role === "eyebrow" ? titleScale : 1;
  // A bold-contrast preset sets body in semibold: load-bearing words read as
  // load-bearing. Display roles keep their scale voice; only body moves.
  const weight = spec.weight ?? (spec.role === "body" && look.bodyWeight === 600 ? 600 : scale.weight);

  operations.push(
    op({
      type: "createText",
      id: spec.id,
      parent: region.id,
      name: spec.text.slice(0, 40) || "Text",
      x: box.x,
      y: box.y,
      content: spec.text,
      family: spec.family ?? scale.family ?? "Inter",
      style: weightToStyle(weight),
      // Slides are 1920 wide against a 1440 design canvas; unscaled type reads as
      // fine print from the back of the room.
      fontSize: emittedFontSize((spec.size ?? scale.size) * typeScale, display),
      ...(spec.letterSpacing !== undefined ? { letterSpacing: spec.letterSpacing } : {}),
      ...(spec.fill !== undefined ? { fill: resolveToken(spec.fill) } : {}),
      // The file's own text style, when the program named one: the design
      // system, bound rather than redrawn.
      ...(spec.textStyleId !== undefined ? { textStyleId: spec.textStyleId } : {}),
      width: textEmittedWidth(spec, box.w),
      // A deliberately truncated text: the box stays the size the layout
      // reserved and the text is cut with an ellipsis, which is the honest
      // rendering of a string that cannot wrap.
      //
      // Inside a native auto-layout container the text wraps at its emitted
      // width and lets Figma compute its height (`HEIGHT`): the container
      // stacks the result, so the recorded estimates and the drawn rows agree
      // by construction. This is exact only because the container's gate
      // required every text child to be measured.
      ...(spec.truncate === true ? { textAutoResize: "TRUNCATE" as const } : inAutoLayout ? { textAutoResize: "HEIGHT" as const } : {}),
    }),
  );

  // Drift guard: the resolved box must already carry this exact width
  // (`resolvedSize` applies the same formula), so a disagreement here means a
  // path skipped the resolution step. Reported as a blocking violation rather
  // than shipping geometry the trace check would call a lie. A degenerate
  // column is exempt: its zero extent is a deliberate finding, not a drift.
  if (box.w > 0.5 && Math.abs(box.w - textEmittedWidth(spec, box.w)) > 0.5) {
    violations.push({
      rule: "text-bounds",
      message: `Text '${spec.id}' would be emitted ${textEmittedWidth(spec, box.w)}px wide but its resolved box is ${Math.round(box.w)}px wide — the emitted width and the resolved geometry disagree. Fix the width source so both use one formula.`,
    });
  }
}

/**
 * Tight height for a horizontal line mark.
 *
 * A line is one-dimensional, so its bounds are the stroke itself: the height
 * encloses half the stroke weight on each side of the path, which is where a
 * stroked vector's paint actually lands. Callers lay the line out at exactly
 * this height and emit it at exactly this height, so the recorded box and the
 * drawn node agree by construction rather than by coincidence.
 */
function lineStrokeHeight(spec: Extract<ContentSpec, { kind: "shape" | "vector" }>): number {
  return Math.max(1, Math.round(typeof spec.strokeWeight === "number" ? spec.strokeWeight : 1));
}

/** True for a shape that is a mark, not a surface. */
function isLineShape(spec: ContentSpec): spec is Extract<ContentSpec, { kind: "shape" }> {
  return spec.kind === "shape" && spec.shape === "line";
}

function emitGraphic(spec: Extract<ContentSpec, { kind: "shape" | "vector" }>, region: ResolvedRegion, box: ResolvedBox, operations: Operation[]): void {
  // Shapes and vectors are emitted **relative to their region**, like text and
  // components. The plugin assigns `node.x = op.x`, and Figma's `x` is
  // parent-relative, so an absolute coordinate here lands the node at its own
  // canvas position *inside* the frame — displaced by the region's origin, which
  // for a panel at (232, 96) means 232px right and 96px down of where the layout
  // put it.
  //
  // This was the only emitter still passing absolute coordinates, which is why
  // the trace check reported it as a mismatch rather than as broken output:
  // "'trace-1' ends up at (216, 80) relative to parent 'topology', which is
  // canvas (448, 176), but its resolved box is (216, 80)" (issue #12, A1).
  // Nothing caught it earlier because polygons and stars compute their path from
  // the absolute box and then normalise it, which happens to land them back on
  // the right node-local origin — the bug only bit the plain rect/ellipse/vector
  // paths.
  box = { ...box, x: box.x - region.x, y: box.y - region.y };

  // Polygons and stars are computed, not hand-drawn: the path builders in
  // marks.ts own the vertex math, and the result flows through the same vector
  // pipeline as a hand-written path. The path is built in parent-local space to
  // match the box just converted above.
  if (spec.kind === "shape" && (spec.shape === "polygon" || spec.shape === "star")) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const r = Math.max(1, Math.min(box.w, box.h) / 2);
    const raw = spec.shape === "polygon" ? polygonPath(cx, cy, r, spec.sides, spec.rotation) : starPath(cx, cy, r, spec.innerRatio, spec.sides, spec.rotation);

    let normalized;
    try {
      normalized = normalizePath(raw);
    } catch {
      // The builders are deterministic, so this is unreachable in practice; the
      // fallback keeps one bad mark from failing a whole screen.
      return;
    }

    operations.push(
      op({
        type: "createVector",
        id: spec.id,
        parent: region.id,
        name: spec.shape,
        x: normalized.x,
        y: normalized.y,
        width: normalized.width,
        height: normalized.height,
        path: normalized.path,
        stroke: spec.stroke !== undefined ? resolveToken(spec.stroke) : "#111111",
        strokeWeight: spec.strokeWeight ?? 1.5,
        fill: spec.fill !== undefined ? resolveToken(spec.fill) : [],
        ...(spec.opacity !== undefined ? { opacity: spec.opacity } : {}),
      }),
    );
    return;
  }

  if (spec.kind === "shape" && spec.shape === "line") {
    // A line is a mark, not a surface: emitting it as a rectangle drew a
    // 352x48 bar for what the author meant as a rule. It compiles to a
    // horizontal createVector centred in its row, with tight bounds that
    // enclose half the stroke on each side (a stroked vector's paint straddles
    // its path). The layout reserves exactly this height (see the graphics
    // branches in emitContent), so the trace check holds by construction.
    const w = Math.max(1, Math.round(box.w));
    const h = lineStrokeHeight(spec);
    const cy = Math.round((h / 2) * 1000) / 1000;
    operations.push(
      op({
        type: "createVector",
        id: spec.id,
        parent: region.id,
        name: "line",
        x: box.x,
        y: box.y,
        width: w,
        height: h,
        path: `M 0 ${cy} L ${w} ${cy}`,
        stroke: spec.stroke !== undefined ? resolveToken(spec.stroke) : "#111111",
        ...(spec.strokeWeight !== undefined ? { strokeWeight: spec.strokeWeight } : {}),
        fill: [],
      }),
    );
    return;
  }

  if (spec.kind === "shape") {
    operations.push(
      op({
        type: spec.shape === "ellipse" ? "createEllipse" : "createRectangle",
        id: spec.id,
        parent: region.id,
        name: spec.shape,
        x: box.x,
        y: box.y,
        width: Math.max(1, Math.round(box.w)),
        height: Math.max(1, Math.round(box.h)),
        ...(spec.fill !== undefined ? { fill: resolveToken(spec.fill) } : {}),
        ...(spec.stroke !== undefined ? { stroke: resolveToken(spec.stroke) } : {}),
        ...(spec.strokeWeight !== undefined ? { strokeWeight: spec.strokeWeight } : {}),
        ...(spec.radius !== undefined ? { cornerRadius: spec.radius } : {}),
        ...(spec.opacity !== undefined ? { opacity: spec.opacity } : {}),
      }),
    );
    return;
  }

  // Vectors compile to a frame plus a vector child; the path data is carried
  // through as a validated operation rather than executed as code. Beziers
  // survive via the preserving normaliser; arc-bearing paths fall back to the
  // flattened pipeline (correct, denser) because arcs are outside Figma's
  // vector-path grammar.
  let vectorPath = spec.path;
  try {
    const normalized = normalizeVectorPath(spec.path);
    vectorPath = normalized.path;
  } catch {
    try {
      vectorPath = normalizePath(spec.path).path;
    } catch {
      vectorPath = spec.path;
    }
  }
  operations.push(
    op({
      type: "createVector",
      id: spec.id,
      parent: region.id,
      name: "Vector",
      x: box.x,
      y: box.y,
      width: Math.max(1, Math.round(box.w)),
      height: Math.max(1, Math.round(box.h)),
      path: vectorPath,
      stroke: spec.stroke !== undefined ? resolveToken(spec.stroke) : "#111111",
      strokeWeight: spec.strokeWeight,
      fill: spec.fill !== undefined ? resolveToken(spec.fill) : [],
      ...(spec.windingRule !== undefined ? { windingRule: spec.windingRule } : {}),
      ...(spec.strokeCap !== undefined ? { strokeCap: spec.strokeCap } : {}),
      ...(spec.strokeJoin !== undefined ? { strokeJoin: spec.strokeJoin } : {}),
      ...(spec.closed !== undefined ? { closed: spec.closed } : {}),
      ...(spec.dashPattern !== undefined ? { dashPattern: spec.dashPattern } : {}),
    }),
  );
}

/**
 * Emits an instance of a component that already exists in the live file.
 *
 * The compile is offline, so the component is named, not resolved: the plugin's
 * `createInstance` executor resolves the id at execution time and fails loudly
 * if the component is gone — which is the correct failure, because an instance
 * of nothing is not a design. Variant properties travel as a separate
 * `setVariant` op (the plugin merges them into the instance's existing
 * component properties), so a component-set instance lands on its requested
 * state instead of the default one.
 */
function emitInstance(
  spec: Extract<ContentSpec, { kind: "instance" }>,
  region: ResolvedRegion,
  box: ResolvedBox,
  operations: Operation[],
): void {
  operations.push(
    op({
      type: "createInstance",
      id: spec.id,
      parent: region.id,
      componentId: spec.componentId,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      x: Math.max(0, Math.round(box.x)),
      y: Math.max(0, Math.round(box.y)),
    }),
  );
  if (spec.variant && Object.keys(spec.variant).length > 0) {
    operations.push(op({ type: "setVariant", target: spec.id, variant: spec.variant }));
  }
}

function emitComponentInstance(
  spec: Extract<ContentSpec, { kind: "component" }>,
  region: ResolvedRegion,
  box: ResolvedBox,
  operations: Operation[],
): void {
  // `box` is already region-relative here: emitComponent subtracts the region
  // origin before dispatching, so these coordinates are parent-local and the
  // operation trace agrees with the resolved geometry by construction.
  const label = typeof spec.props.label === "string" && spec.props.label.length > 0 ? spec.props.label : undefined;
  operations.push(
    op({
      type: "createInstance",
      id: spec.id,
      parent: region.id,
      componentId: spec.componentId!,
      ...(label !== undefined ? { properties: { label } } : {}),
      x: Math.max(0, Math.round(box.x)),
      y: Math.max(0, Math.round(box.y)),
    }),
  );
  if (spec.variant && Object.keys(spec.variant).length > 0) {
    operations.push(op({ type: "setVariant", target: spec.id, variant: spec.variant }));
  }
}

function emitComponent(
  spec: Extract<ContentSpec, { kind: "component" }>,
  region: ResolvedRegion,
  box: ResolvedBox,
  operations: Operation[],
  grid: number,
  typeScale = 1,
  look: StyleLook = DEFAULT_LOOK,
): void {
  const p = spec.props;
  // Layout boxes are absolute on the canvas; emitted child operations are
  // relative to their Figma parent.
  box = { ...box, x: box.x - region.x, y: box.y - region.y };
  /** Components are created inside their region unless they declare elsewhere. */
  const parentHint = region.id;
  /** Slide type scale, applied to every hardcoded size in this function. */
  const fs = (n: number): number => Math.round(n * typeScale);
  const str = (k: string, fallback = ""): string => {
    const v = p[k];
    return typeof v === "string" ? v : fallback;
  };
  const num = (k: string, fallback: number): number => {
    const v = p[k];
    return typeof v === "number" ? v : fallback;
  };
  /**
   * The screen-level style, kept distinct from the `button` case's local `look`.
   * `hugSize` measures with the screen's typography, so it must not receive a
   * single button's variant palette.
   */
  const styleLook = look;

  // Reuse escape hatch (issue #24): a live component id means the file already
  // has this UI, so instance it instead of redrawing it. The label travels as
  // a TEXT property override; the frame+text path below is the fallback when
  // no component was named.
  if (
    (spec.type === "button" || spec.type === "statusPill" || spec.type === "navItem" || isLibraryComponent(spec.type)) &&
    typeof spec.componentId === "string" &&
    spec.componentId.length > 0
  ) {
    emitComponentInstance(spec, region, box, operations);
    return;
  }

  // Component-generation v1 library (issue #24): when asked (`asComponent`),
  // emit the ensure-once `exo/<type>` master and instance it, so every use
  // site links to the same componentId and a shared change propagates.
  // Otherwise the frame fallback below draws identical outer geometry.
  if (isLibraryComponent(spec.type) && p.asComponent === true) {
    const def = libraryDefFor(spec.type)!;
    if (!libraryMasterEmitted(operations, spec.type)) {
      for (const candidate of def.masterOps(grid)) operations.push(op(candidate));
    }
    const label = typeof p.label === "string" && p.label.length > 0 ? p.label : undefined;
    operations.push(
      op({
        type: "createInstance",
        id: spec.id,
        parent: parentHint,
        componentId: def.masterId,
        ...(label !== undefined ? { properties: { label } } : {}),
        x: Math.max(0, Math.round(box.x)),
        y: Math.max(0, Math.round(box.y)),
      }),
    );
    const variant = def.variantFor(p as Record<string, unknown>);
    if (variant && Object.keys(variant).length > 0) {
      operations.push(op({ type: "setVariant", target: spec.id, variant }));
    }
    return;
  }

  switch (spec.type) {
    case "metric": {
      // A metric is a container plus three text layers: label, value, delta.
      // `valueStyle: "technical"` (or mono:true) sets the value in a monospaced
      // face: machine figures should read as machine figures, not marketing type.
      // A mono-first preset forces tabular numerals everywhere, because an
      // instrument that mixes proportional and tabular figures looks broken.
      const technical = look.valueMono || p.mono === true || (typeof p.valueStyle === "string" && p.valueStyle.toLowerCase() === "technical");
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("label", "Metric"),
          x: box.x,
          y: box.y,
          width: Math.max(80, Math.round(box.w)),
          height: Math.max(60, Math.round(box.h || grid * 14)),
          fill: str("surface", "#FFFFFF"),
          cornerRadius: num("radius", grid),
          layoutMode: "VERTICAL",
          padding: grid * 2,
          itemSpacing: grid,
          counterAxisAlignItems: "MIN",
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Label", content: str("label", "Metric"), fontSize: fs(12), fill: "#6F716A" }));
      operations.push(
        op({
          type: "createText",
          parent: spec.id,
          name: "Value",
          content: str("value", "0"),
          fontSize: fs(look.valueSize),
          weight: 600,
          ...(technical ? { family: "JetBrains Mono" } : {}),
          fill: "#242521",
        }),
      );
      if (str("delta")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Delta", content: str("delta"), fontSize: fs(11), fill: "#2D7A4D" }));
      }
      break;
    }

    case "statusPill": {
      // Measured, not symbolic: a hug frame still needs a concrete width.
      // `tone` selects the colour pair; the label always stays as text, because
      // state communicated by colour alone is invisible to some readers.
      const tone = stateTone(p.tone ?? p.state ?? p.color);
      const label = str("label", "Status");
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: label,
          x: box.x,
          y: box.y,
          width: hugSize(spec, grid, typeScale, look)?.w ?? hugWidth(label, { fontSize: Math.round(11 * typeScale), paddingX: grid }),
          height: hugSize(spec, grid, typeScale, look)?.h ?? 22,
          fill: p.surface !== undefined ? str("surface", tone.bg) : tone.bg,
          cornerRadius: grid,
          padding: { top: 4, right: grid, bottom: 4, left: grid },
          layoutMode: "HORIZONTAL",
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Label", content: label, fontSize: fs(11), weight: 500, fill: tone.fg }));
      break;
    }

    case "deviceNode": {
      // Health is a stroke, selection is a heavier stroke in action blue.
      // Selection wins over health: the thing the user is looking at must be
      // unambiguous even when it is also degraded. `status` is accepted as an
      // alias for `health` — authors write the product word, not the schema word.
      const selected = p.selected === true;
      const health = typeof p.health === "string" ? p.health : typeof p.status === "string" ? p.status : undefined;
      const stroke = selected ? "#0D99FF" : health !== undefined ? stateTone(health).fg : "#E0E0E0";
      // The drawn tile is the resolved box, not the intrinsic constant: a
      // selected node carries a 3px ring whose placement box is 2px larger on
      // each axis, and emitting the constant here disagreed with the recorded
      // geometry (operation-trace defect on live topology frames).
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("label", "Device"),
          x: box.x,
          y: box.y,
          width: Math.max(1, Math.round(box.w)),
          height: Math.max(1, Math.round(box.h)),
          fill: str("surface", "#FFFFFF"),
          stroke,
          strokeWeight: selected ? 3 : 1,
          radius: grid,
          layoutMode: "VERTICAL",
          padding: grid,
          itemSpacing: 4,
          ...(health !== undefined && /offline|unavailable/.test(health.toLowerCase()) ? { opacity: 0.7 } : {}),
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Device", content: str("label", "Device"), fontSize: fs(12), weight: 600, fill: "#242521" }));
      if (str("memory")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Memory", content: str("memory"), fontSize: fs(11), family: "JetBrains Mono", fill: "#6F716A" }));
      }
      // Compute capability and shard assignment ride as caption lines: they are
      // facts about the machine, and facts belong with the machine, not in a
      // tooltip the user never opens.
      if (str("compute")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Compute", content: str("compute"), fontSize: fs(11), family: "JetBrains Mono", fill: "#6F716A" }));
      }
      if (str("shard")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Shard", content: `shard ${str("shard")}`, fontSize: fs(11), weight: 500, fill: "#0B6BCB" }));
      }
      break;
    }

    case "navItem": {
      // `state: "active"` (or active:true) is the wayfinding signal: a filled
      // marker the eye finds without reading. Disabled items fade but stay
      // legible, so the rail still communicates the full structure.
      // A preset's typography reaches nav labels as tracking and case: an
      // instrument shouts in tracked-out capitals, an editorial murmurs in
      // sentence case. An explicit letterSpacing on the call would already have
      // been a text primitive; nav items take their voice from the preset.
      const state = typeof p.state === "string" ? p.state.toLowerCase() : p.active === true ? "active" : "default";
      const active = state === "active";
      const disabled = state === "disabled";
      const rawLabel = str("label", "Item");
      const displayLabel = look.navUpper ? rawLabel.toUpperCase() : rawLabel;
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("label", "Nav item"),
          x: box.x,
          y: box.y,
          width: hugSize(spec, grid, typeScale, look)?.w ?? hugWidth(displayLabel, { fontSize: Math.round(14 * typeScale), paddingX: grid * 1.5, letterSpacing: look.navTracking }),
          height: hugSize(spec, grid, typeScale, look)?.h ?? 36,
          fill: active ? NAV_ACTIVE_FILL : surfaceFill(p.surface, []),
          radius: grid / 2,
          padding: { top: grid, right: grid * 1.5, bottom: grid, left: grid * 1.5 },
          layoutMode: "HORIZONTAL",
          ...(disabled ? { opacity: 0.5 } : {}),
        }),
      );
      operations.push(
        op({
          type: "createText",
          parent: spec.id,
          name: "Label",
          content: displayLabel,
          fontSize: fs(14),
          ...(active ? { weight: 600 } : {}),
          ...(look.navTracking > 0 ? { letterSpacing: look.navTracking } : {}),
          // A label colour that works on a light surface is invisible on a dark
          // one. `#6F716A` on white is a quiet secondary; on the `#111111` nav
          // rail it measured 3.82:1 and failed WCAG AA — a defect in the design
          // this component generates, not a threshold to lower (issue #14 B1).
          //
          // So the default follows the surface it is being drawn on. An explicit
          // `props.color` still wins: the author knows what they are doing.
          //
          // The active item is a third case, and the one that broke. Its
          // backdrop is the accent pill it is painted on, not the rail behind
          // the pill — so following the rail paints the label accent-yellow on
          // an accent-yellow pill. Measured on the live frame: 1.0:1, and the
          // word simply was not there (issue L05). The rail test only applies
          // to an inactive item, which really is sitting on the rail.
          fill: active
            ? NAV_ACTIVE_LABEL
            : str("color", onDarkSurface(region) ? "#A8ABA0" : "#6F716A"),
        }),
      );
      break;
    }

    case "divider": {
      // A hairline is a 1px rectangle, not a vector line: Figma has no line
      // primitive, and a 1px rect measures exactly what it draws, so the trace
      // check holds by construction. The 1px rect is ONLY the horizontal
      // hairline — a vertical rule swaps the axes (thin wide, tall high)
      // instead of collapsing to a dot.
      const orientation = typeof p.orientation === "string" ? p.orientation.toLowerCase() : "horizontal";
      const weight = Math.max(1, Math.round(num("strokeWeight", 1)));
      if (orientation === "vertical") {
        operations.push(
          op({
            type: "createRectangle",
            id: spec.id,
            parent: parentHint,
            name: "Divider",
            x: box.x,
            y: box.y,
            width: weight,
            height: Math.max(1, Math.round(box.h)),
            fill: str("color", "#E0E0E0"),
          }),
        );
        break;
      }
      operations.push(
        op({
          type: "createRectangle",
          id: spec.id,
          parent: parentHint,
          name: "Divider",
          x: box.x,
          y: box.y,
          width: Math.max(1, Math.round(box.w)),
          height: weight,
          fill: str("color", "#E0E0E0"),
        }),
      );
      break;
    }

    case "iconButton":
    case "textInput":
    case "select":
    case "checkbox":
    case "switch":
    case "tabs":
    case "badge":
    case "tooltip":
    case "menu":
    case "dialog":
    case "navigationItem":
    case "tableRow": {
      // Frame fallback for the v1 library (issue #24): the same anatomy as the
      // master, drawn inline with identical outer geometry, for callers that
      // did not ask for a real component (`asComponent !== true`).
      const libDef = libraryDefFor(spec.type)!;
      for (const candidate of libDef.fallbackOps({ id: spec.id, parent: parentHint, box, props: p as Record<string, unknown>, grid, typeScale })) {
        operations.push(op(candidate));
      }
      break;
    }

    case "button": {
      // Variants are visual contracts: primary commits, secondary retreats,
      // destructive warns, quiet disappears into the layout, loading admits it
      // is busy. A button that looks primary but acts secondary is a lie the
      // user discovers by clicking.
      const variant = typeof p.variant === "string" ? p.variant.toLowerCase() : "primary";
      const looks: Record<string, { surface: string; color: string; stroke?: string; opacity?: number; suffix?: string }> = {
        primary: { surface: "#242521", color: "#FFFFFF" },
        secondary: { surface: "#FFFFFF", color: "#242521", stroke: "#242521" },
        destructive: { surface: "#D13415", color: "#FFFFFF" },
        quiet: { surface: "transparent", color: "#242521" },
        loading: { surface: "#242521", color: "#FFFFFF", opacity: 0.6, suffix: "…" },
        // Disabled is a real state, not a restyle: muted fill at reduced
        // opacity, so it reads as unavailable rather than as a quiet button.
        disabled: { surface: "#E5E3DC", color: "#8A8C84", opacity: 0.4 },
      };
      // An unknown variant must never silently promote to primary: a button
      // that looks primary but acts secondary is the lie this table exists to
      // prevent. Secondary retreats safely, so it is the fallback.
      const look = looks[variant] ?? looks.secondary!;
      const label = str("label", "Continue") + (look.suffix ?? "");
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: label,
          x: box.x,
          y: box.y,
          width: hugSize(spec, grid, typeScale, styleLook)?.w ?? hugWidth(label, { fontSize: Math.round(13 * typeScale), paddingX: grid * 2 }),
          height: hugSize(spec, grid, typeScale, styleLook)?.h ?? 40,
          fill: look.surface,
          ...(look.stroke !== undefined ? { stroke: look.stroke, strokeWeight: 1 } : {}),
          ...(look.opacity !== undefined ? { opacity: look.opacity } : {}),
          radius: grid,
          padding: { top: grid, right: grid * 2, bottom: grid, left: grid * 2 },
          layoutMode: "HORIZONTAL",
        }),
      );
      operations.push(
        op({ type: "createText", parent: spec.id, name: "Label", content: label, fontSize: fs(13), weight: 600, fill: look.color }),
      );
      break;
    }

    case "sectionHeader": {
      const title = str("title", "Section");
      // Editorial presets give headers a larger voice: the section title is
      // the decision stated, and it should read as one.
      operations.push(op({ type: "createText", id: spec.id, parent: parentHint, name: title, x: box.x, y: box.y, content: title, fontSize: fs(Math.round(18 * look.headerScale)), weight: 600, fill: "#242521" }));
      // An action ("View all") right-aligns in the same band, so the header
      // carries its own navigation instead of needing a second row.
      if (str("action")) {
        const action = str("action");
        const w = hugWidth(action, { fontSize: Math.round(12 * typeScale), paddingX: 0 });
        // Parented to the region, not to the title text: Figma rejects TEXT
        // as a parent, and the coordinates are region-relative either way.
        // (Live defect: every screen using sectionHeader+action failed commit
        // while dry-runs stayed green, because only Figma validates parents.)
        operations.push(
          op({ type: "createText", parent: parentHint, name: "Action", x: Math.round(box.x + box.w - w), y: box.y + 4, content: action, fontSize: fs(12), weight: 500, fill: "#0B6BCB" }),
        );
      }
      break;
    }

    case "logoMark": {
      // A deterministic geometric mark, centred in its box.
      //
      // `mark` names one of twelve marks drawn on a shared optical grid; `size`
      // is a fraction of the box (1 fills it). The wordmark is a separate text
      // primitive with letterSpacing -- a mark plus tracked-out capitals is the
      // whole logo, and keeping the two apart means either can be refined alone.
      // Bezier shoulders (shield, lens, arc) survive via the preserving
      // normaliser; arc-heavy marks (ring, orbit, grid) flatten correctly.
      const mark = coerceLogoMark(p.mark);
      const fraction = typeof p.size === "number" ? Math.min(1, Math.max(0.1, p.size)) : 0.8;
      const r = (Math.min(box.w, box.h) / 2) * fraction;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;

      let normalized;
      try {
        try {
          normalized = normalizeVectorPath(logoMarkPath(mark, cx, cy, r));
        } catch {
          normalized = normalizePath(logoMarkPath(mark, cx, cy, r));
        }
      } catch {
        break;
      }

      // Open-subpath marks (chevron, wave, arc) are strokes; closed ones fill.
      const stroked = mark === "chevron" || mark === "wave" || mark === "arc";
      operations.push(
        op({
          type: "createVector",
          id: spec.id,
          parent: parentHint,
          name: `Logo ${mark}`,
          x: normalized.x,
          y: normalized.y,
          width: normalized.width,
          height: normalized.height,
          path: normalized.path,
          stroke: str("color", "#242521"),
          strokeWeight: num("strokeWeight", Math.max(1, Math.round(grid / 4))),
          fill: stroked ? [] : str("surface", "#242521"),
          fillArrows: !stroked,
        }),
      );
      break;
    }

    case "logoGrid": {
      // Construction guides: grid lines plus bounding square on a hairline
      // stroke, so the mark's proportions are inspectable rather than asserted.
      const fraction = typeof p.size === "number" ? Math.min(1, Math.max(0.1, p.size)) : 0.8;
      const r = (Math.min(box.w, box.h) / 2) * fraction;
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const divisions = typeof p.divisions === "number" ? Math.max(2, Math.min(12, Math.round(p.divisions))) : 4;
      let gpath: string;
      try {
        gpath = logoConstructionGrid(0, 0, r, divisions);
        const n = normalizeVectorPath(gpath);
        gpath = n.path;
        operations.push(
          op({
            type: "createVector",
            id: spec.id,
            parent: parentHint,
            name: "Logo grid",
            x: cx - r,
            y: cy - r,
            width: Math.max(1, Math.round(r * 2)),
            height: Math.max(1, Math.round(r * 2)),
            path: gpath,
            stroke: str("color", "#0D99FF"),
            strokeWeight: 1,
            fill: [],
            dashPattern: [4, 4],
          }),
        );
      } catch {
        break;
      }
      break;
    }

    case "logoLockup": {
      // A complete lockup: mark above, tracked-out wordmark below, optically
      // aligned. Round marks overshoot so they read at cap height.
      const mark = coerceLogoMark(p.mark);
      const wordmark = str("wordmark", str("title", str("text", "EXO")));
      const markR = Math.min(box.w, box.h * 0.6) / 2;
      const cx = box.x + box.w / 2;
      const cy = box.y + markR + grid;
      const kind = mark === "prism" ? "pointed" : mark === "bars" || mark === "chevron" ? "flat" : "round";
      const dy = opticalAlignDy(kind, markR);
      let normalized;
      try {
        try {
          normalized = normalizeVectorPath(logoMarkPath(mark, cx, cy + dy, markR));
        } catch {
          normalized = normalizePath(logoMarkPath(mark, cx, cy + dy, markR));
        }
      } catch {
        break;
      }
      const stroked = mark === "chevron" || mark === "wave" || mark === "arc";
      operations.push(
        op({
          type: "createVector",
          id: `${spec.id}-mark`,
          parent: parentHint,
          name: `Logo ${mark}`,
          x: normalized.x,
          y: normalized.y,
          width: normalized.width,
          height: normalized.height,
          path: normalized.path,
          stroke: str("color", "#242521"),
          strokeWeight: num("strokeWeight", Math.max(1, Math.round(grid / 4))),
          fill: stroked ? [] : str("surface", "#242521"),
          fillArrows: !stroked,
        }),
      );
      operations.push(
        op({
          type: "createText",
          parent: parentHint,
          name: "Wordmark",
          content: wordmark.toUpperCase(),
          fontSize: fs(Math.max(12, Math.round(markR * 0.45))),
          weight: 600,
          letterSpacing: Math.round(markR * 0.18),
          textAlignHorizontal: "CENTER",
          fill: str("color", "#242521"),
        }),
      );
      break;
    }

    case "vectorPlan": {
      // A constructed path from plan steps: silhouette -> cutout -> mirror ->
      // refine. Operands compose here; boolean subtraction itself runs in
      // Figma via booleanGroup so the cut stays editable.
      const rawSteps: unknown[] = Array.isArray(p.steps) ? (p.steps as unknown[]) : [];
      const steps: LogoPlanStep[] = [];
      for (const raw of rawSteps.slice(0, 24)) {
        if (!raw || typeof raw !== "object") continue;
        const s = raw as Record<string, unknown>;
        if (s.op === "silhouette" && typeof s.mark === "string") {
          steps.push({
            op: "silhouette",
            mark: coerceLogoMark(s.mark),
            cx: typeof s.cx === "number" ? s.cx : box.x + box.w / 2,
            cy: typeof s.cy === "number" ? s.cy : box.y + box.h / 2,
            r: typeof s.r === "number" ? s.r : Math.min(box.w, box.h) / 2,
          });
        } else if (s.op === "path" && typeof s.path === "string") {
          steps.push({ op: "path", path: s.path });
        } else if (s.op === "cutout" && typeof s.path === "string") {
          steps.push({ op: "cutout", path: s.path });
        } else if (s.op === "mirror") {
          steps.push({ op: "mirror", axis: s.axis === "horizontal" ? "horizontal" : "vertical", center: typeof s.center === "number" ? s.center : box.x + box.w / 2 });
        } else if (s.op === "translate") {
          steps.push({ op: "translate", dx: typeof s.dx === "number" ? s.dx : 0, dy: typeof s.dy === "number" ? s.dy : 0 });
        } else if (s.op === "snap") {
          steps.push({ op: "snap", grid: typeof s.grid === "number" ? s.grid : 4 });
        }
      }
      if (steps.length === 0) break;
      let result;
      try {
        result = executeLogoPlan(steps);
      } catch {
        break;
      }
      let vpath = result.path;
      try {
        vpath = normalizeVectorPath(result.path).path;
      } catch {
        try {
          vpath = normalizePath(result.path).path;
        } catch {
          break;
        }
      }
      const b = { x: box.x, y: box.y, w: Math.max(1, Math.round(box.w)), h: Math.max(1, Math.round(box.h)) };
      operations.push(
        op({
          type: "createVector",
          id: spec.id,
          parent: parentHint,
          name: "Vector plan",
          x: b.x,
          y: b.y,
          width: b.w,
          height: b.h,
          path: vpath,
          stroke: str("color", "#242521"),
          strokeWeight: num("strokeWeight", 1.5),
          fill: str("surface", "#242521"),
          fillArrows: true,
        }),
      );
      break;
    }

    case "booleanGroup": {
      // Native boolean of already-emitted siblings. Targets name content ids
      // in the same program; the two-pass executor resolves forward refs, and
      // Figma refuses loudly when a target is missing or unparented.
      const operation = p.operation === "subtract" || p.operation === "intersect" || p.operation === "exclude" ? p.operation : "union";
      const targets: string[] = Array.isArray(p.targets) ? (p.targets as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 50) : [];
      if (targets.length < 2) break;
      operations.push(
        op({
          type: "booleanOperation",
          id: spec.id,
          name: str("title", `${operation} ${targets.length}`),
          operation,
          targets,
        }),
      );
      break;
    }

    case "flowNode": {
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("label", str("title", "Step")),
          x: box.x,
          y: box.y,
          width: Math.max(120, Math.round(box.w)),
          height: Math.max(48, Math.round(box.h || grid * 9)),
          fill: str("surface", "#FFFFFF"),
          stroke: str("color", "#0D99FF"),
          strokeWeight: 1.5,
          radius: num("radius", grid),
          layoutMode: "VERTICAL",
          padding: grid * 1.5,
          itemSpacing: 2,
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Label", content: str("label", str("title", "Step")), fontSize: fs(14), weight: 600, fill: "#242521" }));
      if (str("detail", str("body"))) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Detail", content: str("detail", str("body")), fontSize: fs(12), fill: "#6F716A" }));
      }
      break;
    }

    case "decisionDiamond": {
      const cx = box.x + box.w / 2;
      const cy = box.y + (box.h || grid * 12) / 2;
      const w = Math.max(60, box.w / 2);
      const h = Math.max(40, (box.h || grid * 12) / 2);
      const diamond = `M ${f1(cx)} ${f1(cy - h / 2)} L ${f1(cx + w / 2)} ${f1(cy)} L ${f1(cx)} ${f1(cy + h / 2)} L ${f1(cx - w / 2)} ${f1(cy)} Z`;
      let dpath = diamond;
      try {
        dpath = normalizeVectorPath(diamond).path;
      } catch {
        /* absolute fallback is already canonical */
      }
      operations.push(
        op({
          type: "createVector",
          id: `${spec.id}-diamond`,
          parent: parentHint,
          name: "Decision",
          x: Math.round(cx - w / 2),
          y: Math.round(cy - h / 2),
          width: Math.round(w),
          height: Math.round(h),
          path: dpath,
          stroke: str("color", "#FF8A00"),
          strokeWeight: 1.5,
          fill: str("surface", "#FFFBEB"),
        }),
      );
      operations.push(op({ type: "createText", parent: parentHint, name: "Question", content: str("label", str("title", "Decide")), fontSize: fs(13), weight: 600, fill: "#242521" }));
      break;
    }

    case "timelineEvent": {
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("date", "Event"),
          x: box.x,
          y: box.y,
          width: Math.max(160, Math.round(box.w)),
          height: Math.max(48, Math.round(box.h || grid * 9)),
          fill: "#00000000",
          layoutMode: "VERTICAL",
          padding: 0,
          itemSpacing: 2,
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Date", content: str("date", "Now"), fontSize: fs(11), weight: 600, family: "JetBrains Mono", fill: "#0D99FF" }));
      operations.push(op({ type: "createText", parent: spec.id, name: "Title", content: str("title", str("label", "Milestone")), fontSize: fs(14), weight: 600, fill: "#242521" }));
      if (str("body", str("detail"))) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Body", content: str("body", str("detail")), fontSize: fs(12), fill: "#6F716A" }));
      }
      break;
    }

    case "chartBar":
    case "chartLine":
    case "chartPie": {
      // Chart scaffolds: axes plus geometry from labelled values. Values are
      // flat numbers; shares are { label, value } rows. Editable vectors and
      // text, never baked images.
      const title = str("title", str("label", "Chart"));
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: title,
          x: box.x,
          y: box.y,
          width: Math.max(200, Math.round(box.w)),
          height: Math.max(120, Math.round(box.h || grid * 24)),
          fill: str("surface", "#FFFFFF"),
          stroke: "#E8E6DF",
          strokeWeight: 1,
          radius: num("radius", grid),
          layoutMode: "VERTICAL",
          padding: grid * 1.5,
          itemSpacing: grid,
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Title", content: title, fontSize: fs(14), weight: 600, fill: "#242521" }));
      const values: number[] = Array.isArray(p.values)
        ? (p.values as unknown[]).filter((v): v is number => typeof v === "number").slice(0, 24)
        : Array.isArray(p.shares)
          ? (p.shares as unknown[])
              .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>).value : undefined))
              .filter((v): v is number => typeof v === "number")
              .slice(0, 12)
          : [4, 7, 5, 9];
      const labels: string[] = Array.isArray(p.labels) ? (p.labels as unknown[]).filter((l): l is string => typeof l === "string").slice(0, values.length) : [];
      const max = Math.max(1, ...values);
      const chartW = Math.max(160, Math.round(box.w) - grid * 3);
      const chartH = 120;
      if (spec.type === "chartBar") {
        const n = Math.max(1, values.length);
        const bw = Math.max(8, Math.floor(chartW / n) - 8);
        values.forEach((v, i) => {
          const h = Math.max(4, Math.round((v / max) * chartH));
          operations.push(
            op({
              type: "createRectangle",
              parent: spec.id,
              name: labels[i] ?? `Bar ${i + 1}`,
              width: bw,
              height: h,
              fill: i === values.indexOf(max) ? str("accent", "#0D99FF") : "#DCEBFF",
              cornerRadius: 3,
            }),
          );
        });
      } else if (spec.type === "chartLine") {
        const pts = values.map((v, i) => {
          const x = values.length === 1 ? chartW / 2 : (chartW * i) / (values.length - 1);
          const y = chartH - (v / max) * chartH;
          return `${i === 0 ? "M" : "L"} ${Math.round(x)} ${Math.round(y)}`;
        });
        operations.push(
          op({
            type: "createVector",
            parent: spec.id,
            name: "Series",
            x: box.x,
            y: box.y,
            width: chartW,
            height: chartH,
            path: pts.join(" "),
            stroke: str("accent", "#0D99FF"),
            strokeWeight: 2,
            fill: [],
          }),
        );
      } else {
        const total = values.reduce((a, b) => a + b, 0) || 1;
        let acc = 0;
        const palette = ["#0D99FF", "#FF8A00", "#16A34A", "#A855F7", "#F43F5E", "#6F716A"];
        values.forEach((v, i) => {
          const share = Math.round((v / total) * 100);
          acc += share;
          operations.push(
            op({
              type: "createText",
              parent: spec.id,
              name: `Share ${i + 1}`,
              content: `${labels[i] ?? `Slice ${i + 1}`} · ${share}%`,
              fontSize: fs(12),
              family: "JetBrains Mono",
              fill: palette[i % palette.length]!,
            }),
          );
        });
      }
      if (str("caption")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Caption", content: str("caption"), fontSize: fs(11), fill: "#6F716A" }));
      }
      break;
    }

    case "callout":
    case "annotation": {
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: spec.type === "callout" ? "Callout" : "Annotation",
          x: box.x,
          y: box.y,
          width: Math.max(140, Math.round(box.w)),
          height: Math.max(40, Math.round(box.h || grid * 8)),
          fill: spec.type === "callout" ? "#FFF7E5" : "#F0F7FF",
          stroke: spec.type === "callout" ? "#FF8A00" : "#0D99FF",
          strokeWeight: 1,
          radius: num("radius", grid / 2),
          layoutMode: "VERTICAL",
          padding: grid,
          itemSpacing: 2,
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Text", content: str("text", str("body", str("label", "Note"))), fontSize: fs(spec.type === "callout" ? 13 : 12), weight: spec.type === "callout" ? 600 : 400, fill: "#242521" }));
      if (str("detail")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Detail", content: str("detail"), fontSize: fs(11), fill: "#6F716A" }));
      }
      break;
    }

    case "sectionDivider": {
      // Orientation mirrors `divider`: horizontal keeps the 1px rule under the
      // label; vertical draws the rule tall and thin beside it. The 1px rect
      // is a hairline-only shape — a vertical section divider is a rule, not
      // a dot, so the axes swap instead of reusing the horizontal geometry.
      const orientation = typeof p.orientation === "string" ? p.orientation.toLowerCase() : "horizontal";
      const weight = Math.max(1, Math.round(num("strokeWeight", 1)));
      operations.push(op({ type: "createText", parent: parentHint, name: "Section", content: str("title", str("label", "Section")).toUpperCase(), fontSize: fs(11), weight: 600, letterSpacing: 2, fill: "#6F716A" }));
      if (orientation === "vertical") {
        operations.push(
          op({
            type: "createRectangle",
            parent: parentHint,
            name: "Rule",
            width: weight,
            height: Math.max(32, Math.round(box.h)),
            fill: "#E8E6DF",
          }),
        );
        break;
      }
      operations.push(
        op({
          type: "createRectangle",
          parent: parentHint,
          name: "Rule",
          width: Math.max(80, Math.round(box.w)),
          height: weight,
          fill: "#E8E6DF",
        }),
      );
      break;
    }

    case "quoteBlock": {
      operations.push(op({ type: "createText", parent: parentHint, name: "Quote", content: `“${str("quote", str("text", str("body", "Design is intelligence made visible.")))}”`, fontSize: fs(28), weight: 600, fill: "#242521" }));
      if (str("author", str("caption"))) {
        operations.push(op({ type: "createText", parent: parentHint, name: "Attribution", content: `— ${str("author", str("caption"))}`, fontSize: fs(13), fill: "#6F716A" }));
      }
      break;
    }

    case "imageFrame": {
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("caption", str("alt", "Image")),
          x: box.x,
          y: box.y,
          width: Math.max(160, Math.round(box.w)),
          height: Math.max(120, Math.round(box.h || grid * 24)),
          fill: "#EDEBE4",
          radius: num("radius", grid),
          clipsContent: true,
          layoutMode: "VERTICAL",
          padding: 0,
          itemSpacing: 0,
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Placeholder", content: str("alt", "Image") + (str("src") ? ` · ${str("src")}` : ""), fontSize: fs(12), family: "JetBrains Mono", fill: "#6F716A" }));
      if (str("caption")) {
        operations.push(op({ type: "createText", parent: parentHint, name: "Caption", content: str("caption"), fontSize: fs(11), fill: "#6F716A" }));
      }
      break;
    }

    case "slideMaster": {
      // A reusable master: background, title slot, footer. Stamped as a
      // component so slides built from it stay in sync.
      operations.push(
        op({
          type: "createComponent",
          id: spec.id,
          parent: parentHint,
          name: str("title", str("name", "Slide master")),
          width: 1920,
          height: 1080,
          fill: str("background", "#FFFFFF"),
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Title slot", content: str("title", "Title"), fontSize: fs(72), weight: 700, fill: "#242521" }));
      if (str("footer")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Footer", content: str("footer"), fontSize: fs(20), fill: "#6F716A" }));
      }
      break;
    }

    case "deckOutline": {
      // A narrative outline rendered as an inspectable list. The planner turns
      // acts into differently-composed slides; this keeps the arc visible in
      // the file so a deck reads as a sequence, not N copies of one layout.
      const acts: string[] = Array.isArray(p.acts) ? (p.acts as unknown[]).filter((a): a is string => typeof a === "string").slice(0, 12) : [];
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("title", "Deck outline"),
          x: box.x,
          y: box.y,
          width: Math.max(200, Math.round(box.w)),
          height: Math.max(80, Math.round(box.h || grid * (8 + acts.length * 4))),
          fill: "#00000000",
          layoutMode: "VERTICAL",
          padding: 0,
          itemSpacing: grid / 2,
        }),
      );
      if (str("title")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Title", content: str("title"), fontSize: fs(14), weight: 600, fill: "#242521" }));
      }
      acts.forEach((act, i) => {
        operations.push(op({ type: "createText", parent: spec.id, name: `Act ${i + 1}`, content: `${i + 1}. ${act}`, fontSize: fs(13), fill: "#242521" }));
      });
      break;
    }

    case "stat": {
      operations.push(op({ type: "createText", parent: parentHint, name: "Number", content: str("value", str("number", "42")), fontSize: fs(64), weight: 700, fill: str("color", "#242521") }));
      if (str("label")) {
        operations.push(op({ type: "createText", parent: parentHint, name: "Label", content: str("label"), fontSize: fs(14), fill: "#6F716A" }));
      }
      break;
    }

    case "bullets": {
      const items: string[] = Array.isArray(p.items) ? (p.items as unknown[]).filter((i): i is string => typeof i === "string").slice(0, 12) : [];
      const title = str("title");
      if (title) {
        operations.push(op({ type: "createText", parent: parentHint, name: "Title", content: title, fontSize: fs(20), weight: 600, fill: "#242521" }));
      }
      for (const item of items) {
        operations.push(op({ type: "createText", parent: parentHint, name: "Bullet", content: `•  ${item}`, fontSize: fs(16), fill: "#242521" }));
      }
      break;
    }

    case "modelRow": {
      // A real row: title, status in its tone colour, memory in mono. Three
      // facts, one line each, no nested frames to maintain. Status reads
      // product language ("fits", "insufficient memory"), not just tones.
      const tone = stateTone(p.status);
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("title", "Model"),
          x: box.x,
          y: box.y,
          width: Math.max(80, Math.round(box.w)),
          height: Math.max(40, Math.round(box.h || grid * 9)),
          fill: str("surface", "#FFFFFF"),
          stroke: "#E8E6DF",
          strokeWeight: 1,
          radius: num("radius", grid),
          layoutMode: "VERTICAL",
          padding: grid * 1.5,
          itemSpacing: 2,
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Title", content: str("title", "Model"), fontSize: fs(14), weight: 600, fill: "#242521" }));
      if (str("status")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Status", content: str("status"), fontSize: fs(12), weight: 500, fill: tone.fg }));
      }
      if (str("memory")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Memory", content: str("memory"), fontSize: fs(12), family: "JetBrains Mono", fill: "#6F716A" }));
      }
      break;
    }

    case "shardBlock": {
      // One shard: a compact captioned block. The shard id is mono (it is an
      // identifier), the machine is plain text (it is a name).
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("label", str("shard", "Shard")),
          x: box.x,
          y: box.y,
          width: Math.max(80, Math.round(box.w)),
          height: Math.max(40, Math.round(box.h || grid * 8)),
          fill: str("surface", "#FFFFFF"),
          stroke: "#E8E6DF",
          strokeWeight: 1,
          radius: num("radius", grid / 2),
          layoutMode: "VERTICAL",
          padding: grid,
          itemSpacing: 2,
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Shard", content: str("shard", str("label", "shard-0")), fontSize: fs(12), weight: 600, family: "JetBrains Mono", fill: "#242521" }));
      if (str("machine")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Machine", content: `→ ${str("machine")}`, fontSize: fs(11), fill: "#6F716A" }));
      }
      if (str("memory")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Memory", content: str("memory"), fontSize: fs(11), family: "JetBrains Mono", fill: "#6F716A" }));
      }
      break;
    }

    case "memoryBudget": {
      // Used/total as a bar plus a mono readout. The bar is two rectangles;
      // the text states the numbers, because a bar without numbers is decoration.
      const total = num("total", 0);
      const used = num("used", 0);
      const ratio = total > 0 ? Math.min(1, Math.max(0, used / total)) : 0;
      const tone = ratio >= 1 ? TONES.error! : ratio >= 0.85 ? TONES.warning! : TONES.success!;
      const barW = Math.max(80, Math.round(box.w));
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("title", str("label", "Memory")),
          x: box.x,
          y: box.y,
          width: barW,
          height: Math.max(40, Math.round(box.h || grid * 7)),
          fill: str("surface", "#FFFFFF"),
          radius: num("radius", grid / 2),
          layoutMode: "VERTICAL",
          padding: grid,
          itemSpacing: grid / 2,
        }),
      );
      if (str("title")) {
        operations.push(
          op({ type: "createText", parent: spec.id, name: "Title", content: str("title"), fontSize: fs(12), fill: "#555555" }),
        );
      }
      // The track and its fill live in their own bar frame: a frame without
      // auto-layout holds the overlay (the fill drawn over the track), and both
      // children are parent-local — a canvas-absolute x inside a parented frame
      // lands displaced by the frame's origin, which is how the track
      // overflowed its own budget card.
      operations.push(
        op({
          type: "createFrame",
          id: `${spec.id}-bar`,
          parent: spec.id,
          name: "Track",
          width: Math.max(40, barW - grid * 2),
          height: 8,
          fill: "#E8E6DF",
          radius: 4,
        }),
      );
      if (ratio > 0) {
        operations.push(
          op({
            type: "createRectangle",
            parent: `${spec.id}-bar`,
            name: "Fill",
            x: 0,
            y: 0,
            width: Math.max(8, Math.round((barW - grid * 2) * ratio)),
            height: 8,
            fill: tone.fg,
            cornerRadius: 4,
          }),
        );
      }
      operations.push(
        op({
          type: "createText",
          parent: spec.id,
          name: "Readout",
          content: `${str("usedLabel", String(used))} / ${str("totalLabel", String(total))} ${str("unit", "GB").trim()} used`,
          fontSize: fs(12),
          family: "JetBrains Mono",
          fill: tone.fg,
        }),
      );
      break;
    }

    case "fitGauge": {
      // A verdict with the numbers that justify it, sized to the column it was
      // packed into — never wider: a hug-width block that overruns its column
      // slides under the neighbouring panel, and no region-level overflow
      // check can see a content-level sibling collision. The detail line wraps
      // instead (HEIGHT auto-resize at the column's inner width).
      const fits = p.fits !== false;
      const tone = fits ? TONES.success! : TONES.error!;
      const label = str("label", fits ? "Fits" : "Does not fit");
      const detail = str("detail", "");
      const width = Math.max(72, Math.round(box.w));
      const innerW = Math.max(40, width - grid * 4);
      const lines = detail ? Math.max(1, Math.ceil((detail.length * Math.round(11 * typeScale) * 0.62) / innerW)) : 0;
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: label,
          x: box.x,
          y: box.y,
          width,
          height: Math.max(40, Math.round(box.h || (detail ? grid * 2 + 20 + lines * 15 : 40))),
          fill: tone.bg,
          stroke: tone.fg,
          strokeWeight: 1,
          radius: grid,
          padding: { top: grid, right: grid * 2, bottom: grid, left: grid * 2 },
          layoutMode: "VERTICAL",
          itemSpacing: grid / 2,
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Verdict", content: label, fontSize: fs(13), weight: 600, fill: tone.fg }));
      if (detail) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Detail", content: detail, fontSize: fs(11), family: "JetBrains Mono", fill: tone.fg, width: innerW, textAutoResize: "HEIGHT" }));
      }
      break;
    }

    case "compatibilityMatrix": {
      // Model-by-machine fit rows. One row per entry: model, machine, verdict in
      // its tone. A matrix grid would be prettier and far harder to read at a
      // glance; rows scan.
      const rows: unknown[] = Array.isArray(p.rows) ? (p.rows as unknown[]) : [];
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("title", "Compatibility"),
          x: box.x,
          y: box.y,
          width: Math.max(80, Math.round(box.w)),
          height: Math.max(40, Math.round(box.h || grid * (6 + rows.length * 4))),
          fill: str("surface", "#FFFFFF"),
          stroke: "#E8E6DF",
          strokeWeight: 1,
          radius: num("radius", grid),
          layoutMode: "VERTICAL",
          padding: grid * 1.5,
          itemSpacing: grid / 2,
        }),
      );
      if (str("title")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Title", content: str("title"), fontSize: fs(14), weight: 600, fill: "#242521" }));
      }
      rows.slice(0, 20).forEach((raw, i) => {
        if (!raw || typeof raw !== "object") return;
        const row = raw as Record<string, unknown>;
        const model = typeof row.model === "string" ? row.model : `model-${i + 1}`;
        const machine = typeof row.machine === "string" ? row.machine : "?";
        const verdict = typeof row.verdict === "string" ? row.verdict : "";
        const tone = /fit|pass|yes|ok/i.test(verdict) ? TONES.success! : /no|fail|never/i.test(verdict) ? TONES.error! : TONES.neutral!;
        operations.push(
          op({
            type: "createText",
            parent: spec.id,
            name: `Row ${i + 1}`,
            content: `${model} → ${machine} · ${verdict}`,
            fontSize: fs(12),
            family: "JetBrains Mono",
            fill: tone.fg,
          }),
        );
      });
      break;
    }

    case "topologyMap": {
      // Topology is the product's primary spatial explanation, not a generic
      // panel. Build real editable nodes and native vector relationships.
      const surface = p.surface !== undefined ? surfaceFill(p.surface, "#FBFAF6") : "#FBFAF6";
      const pad = Math.round(grid * 3);
      const w = Math.max(240, Math.round(box.w));
      const h = Math.max(220, Math.round(box.h || grid * 30));
      operations.push(op({
        type: "createFrame",
        id: spec.id,
        parent: parentHint,
        name: str("title", "Compute topology"),
        x: box.x,
        y: box.y,
        width: w,
        height: h,
        fill: surface,
        radius: 0,
        clipsContent: false,
      }));
      if (str("title")) {
        operations.push(op({
          type: "createText",
          parent: spec.id,
          name: "Title",
          x: 0,
          y: 0,
          content: str("title"),
          fontSize: fs(11),
          family: "JetBrains Mono",
          weight: 600,
          letterSpacing: 20,
          fill: "#5A5C54",
        }));
      }

      const rawNodes: unknown[] = Array.isArray(p.nodes) ? p.nodes as unknown[] : [];
      const nodes = rawNodes
        .filter((n): n is Record<string, unknown> => !!n && typeof n === "object")
        .slice(0, 6)
        .map((n, i) => ({
          id: typeof n.id === "string" ? n.id : `node-${i + 1}`,
          label: typeof n.label === "string" ? n.label : `Node ${i + 1}`,
          detail: typeof n.detail === "string" ? n.detail : "",
          role: typeof n.role === "string" ? n.role : i === 1 ? "runtime" : "device",
        }));

      const nodeCount = Math.max(1, nodes.length);
      const usableW = Math.max(180, w - pad * 2);
      const y = Math.max(90, Math.round(h * 0.52));
      const nodeW = Math.min(250, Math.max(170, Math.floor(usableW / nodeCount - grid * 4)));
      const nodeH = 104;
      const gapX = nodeCount > 1 ? Math.max(28, Math.floor((usableW - nodeW * nodeCount) / (nodeCount - 1))) : 0;
      const startX = Math.round((w - (nodeW * nodeCount + gapX * Math.max(0, nodeCount - 1))) / 2);
      const centers = new Map<string, { x: number; y: number }>();

      nodes.forEach((n, i) => {
        const x = startX + i * (nodeW + gapX);
        const cy = y + nodeH / 2;
        centers.set(n.id, { x: x + nodeW / 2, y: cy });
        const isRuntime = n.role === "runtime";
        operations.push(op({
          type: "createFrame",
          id: n.id,
          parent: spec.id,
          name: n.label,
          x,
          y,
          width: nodeW,
          height: nodeH,
          fill: isRuntime ? "#242521" : "#FFFFFF",
          stroke: isRuntime ? "#242521" : "#D9D8D0",
          strokeWeight: 1,
          radius: 0,
          layoutMode: "VERTICAL",
          padding: grid * 2,
          itemSpacing: grid,
        }));
        operations.push(op({
          type: "createText",
          parent: n.id,
          name: "Label",
          content: n.label,
          fontSize: fs(isRuntime ? 20 : 18),
          weight: 600,
          fill: isRuntime ? "#FFFFFF" : "#242521",
        }));
        if (n.detail) {
          operations.push(op({
            type: "createText",
            parent: n.id,
            name: "Detail",
            content: n.detail,
            fontSize: fs(11),
            family: "JetBrains Mono",
            fill: isRuntime ? "#E7E7E1" : "#6F716A",
          }));
        }
      });

      const rawEdges: unknown[] = Array.isArray(p.edges) ? p.edges as unknown[] : [];
      rawEdges.slice(0, 12).forEach((e, i) => {
        if (!e || typeof e !== "object") return;
        const edge = e as Record<string, unknown>;
        const from = typeof edge.from === "string" ? edge.from : "";
        const to = typeof edge.to === "string" ? edge.to : "";
        const a = centers.get(from) ?? centers.get(nodes.find(n => n.label === from)?.id ?? "");
        const b = centers.get(to) ?? centers.get(nodes.find(n => n.label === to)?.id ?? "");
        if (!a || !b) return;
        const left = Math.min(a.x, b.x);
        const width = Math.max(1, Math.abs(b.x - a.x));
        operations.push(op({
          type: "createVector",
          parent: spec.id,
          name: `Topology link ${i + 1}`,
          x: left,
          y: a.y,
          width,
          height: 1,
          path: "M 0 0 L " + width + " 0",
          stroke: "#9B9D95",
          strokeWeight: 1,
          strokeCap: "ROUND",
        }));
      });
      break;
    }

    case "panel":
    case "placementMap":
    default: {
      // Generic container. A topology map is emitted as a titled region so the
      // node structure stays semantic and editable rather than baked pixels.
      // `tone` tints the surface without needing a second primitive.
      // Panels are already borderless by construction, so an open/borderless
      // preset changes nothing here; generous spacing widens the padding.
      const surface = p.surface !== undefined ? str("surface", "#FFFDF9") : p.tone !== undefined ? toneFor(p.tone).bg : "#FFFDF9";
      const pad = Math.round(grid * 2 * look.panelPaddingScale);
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("title", spec.type),
          x: box.x,
          y: box.y,
          width: Math.max(80, Math.round(box.w)),
          height: Math.max(40, Math.round(box.h || grid * 12)),
          fill: surface,
          radius: num("radius", grid),
          layoutMode: "VERTICAL",
          padding: pad,
          itemSpacing: grid,
        }),
      );
      if (str("title")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Title", content: str("title"), fontSize: fs(14), weight: 600, fill: "#242521" }));
      }
      break;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Post-layout geometry assertions                                              */
/* -------------------------------------------------------------------------- */

/** Slack allowed on a canvas edge before a region counts as spilling. */
const CANVAS_TOLERANCE = 1;

/**
 * Proves the layout actually produced the geometry the program asked for.
 *
 * ## Why this pass exists
 *
 * The shell layout stacks regions and the relation solver moves them, but
 * neither checked the result. Hard stress test #10 produced a dry run with zero
 * warnings and zero violations whose inspector started at y=1239 on a 1100px
 * canvas: three fixed-height regions overflowed the canvas, the relation pushed
 * the inspector past the right edge, and nothing said so. A layout engine that
 * can emit geometry it does not endorse is worse than no engine, because the
 * numbers look authoritative.
 *
 * So every resolved region is checked against the canvas, and every declared
 * relation is re-measured against the geometry that came out the other end. The
 * relation check is the important half: the solver reports only unknown anchors
 * and cycles, so a relation it silently failed to honour — because the anchor
 * moved afterwards, or because a later fit pass reflowed the box — was
 * indistinguishable from one it applied.
 *
 * Reported as violations rather than thrown, because the caller still gets a
 * usable operation list and a repairable report.
 */
function assertResolvedGeometry(
  ir: DesignIR,
  regions: ResolvedRegion[],
  boxes: Map<string, PlacedBox>,
  canvasW: number,
  canvasH: number,
  violations: CompileResult["violations"],
  /** Relations the solver refused, which therefore have no position to check. */
  unresolvedRelations: readonly string[] = [],
  /** The box relations are measured against — the canvas. */
  parent: PlacedBox = { id: "root", x: 0, y: 0, w: canvasW, h: canvasH },
): void {
  const span = (r: ResolvedRegion): string => `${Math.round(r.w)}x${Math.round(r.h)} at (${Math.round(r.x)}, ${Math.round(r.y)})`;

  for (const region of regions) {
    if (!Number.isFinite(region.x) || !Number.isFinite(region.y) || !Number.isFinite(region.w) || !Number.isFinite(region.h)) {
      violations.push({
        rule: "geometry",
        message: `Region '${region.id}' resolved to a non-finite box (${span(region)}). It will not be drawn.`,
      });
      continue;
    }

    // A zero-extent region is the symptom of an over-constrained stack: the
    // fixed heights already consumed the canvas, so the flexible one was handed
    // nothing. Reporting "height 0" is the only clue that the sum was wrong.
    if (region.w <= 0 || region.h <= 0) {
      violations.push({
        rule: "geometry",
        message: `Region '${region.id}' resolved to ${span(region)}. The canvas is ${canvasW}x${canvasH}: the regions above it do not leave room for it. Reduce a fixed height or height:'fill' a single region.`,
      });
      continue;
    }

    const spills: string[] = [];
    if (region.x < -CANVAS_TOLERANCE) spills.push("left");
    if (region.y < -CANVAS_TOLERANCE) spills.push("top");
    if (region.x + region.w > canvasW + CANVAS_TOLERANCE) spills.push("right");
    if (region.y + region.h > canvasH + CANVAS_TOLERANCE) spills.push("bottom");
    if (spills.length > 0) {
      violations.push({
        rule: "geometry",
        message: `Region '${region.id}' spills past the ${spills.join(" and ")} edge of the ${canvasW}x${canvasH} canvas: ${span(region)}.`,
      });
    }
  }

  // Content must live inside the region that owns it.
  //
  // Checking regions against the canvas says nothing about whether the text and
  // components inside them were placed inside it. A region can be perfect and
  // its contents still spill past its edge, which is what the reviewer then
  // reports as `overflow` on a frame the compiler considered sound. Measured
  // from the resolved box, so it moves with the layout.
  const homeOf = new Map<string, string>();
  for (const region of ir.regions) for (const child of region.children) homeOf.set(child, region.id);
  for (const region of regions) {
    for (const child of region.children) {
      const box = boxes.get(child);
      if (!box || box.w <= 0 || box.h <= 0) continue;
      const outside =
        box.x < region.x - CANVAS_TOLERANCE ||
        box.y < region.y - CANVAS_TOLERANCE ||
        box.x + box.w > region.x + region.w + CANVAS_TOLERANCE ||
        box.y + box.h > region.y + region.h + CANVAS_TOLERANCE;
      if (!outside) continue;
      // A region that explicitly allows overflow is a field that may carry a
      // diagram past its frame; the overflow is reported, but it does not
      // refuse the build.
      const allows = (region as { overflow?: string }).overflow === "allow";
      violations.push({
        // Its own rule. Blocking by default: content that escapes its region
        // is a structural defect, not a density problem, and the review engine
        // cannot see it - the review reads a built screen, where the content
        // and the region have already drifted apart. A region that allows
        // overflow says so, and then the finding is advisory.
        rule: allows ? "containment-allowed" : "containment",
        message: `Content '${child}' is placed at (${Math.round(box.x)}, ${Math.round(box.y)}) ${Math.round(box.w)}x${Math.round(box.h)}, outside its region '${region.id}' which spans (${Math.round(region.x)}, ${Math.round(region.y)}) ${span(region)}.${allows ? " The region allows overflow, so this is reported rather than refused." : ""}`,
      });
    }
  }

  // Every declared relation must survive into the final geometry. Measured, not
  // assumed: the solver can apply a relation and a later fit pass can undo it.
  //
  // Relations the solver *refused* are excluded. A cycle has no solution, so
  // there is nothing to measure against; re-measuring it reported the shell
  // layout's fallback position as if it were a failed attempt, which contradicted
  // the cycle diagnostic that had already said nothing was applied (issue #12,
  // R3: "reported fallback coordinates still show a/b/c at x=0 and subsequent
  // relation violations").
  for (const relation of ir.relations) {
    if (unresolvedRelations.includes(relation.id)) continue;
    const box = boxes.get(relation.id);
    if (!box) continue;
    for (const problem of checkRelation(relation, box, boxes, parent, canvasW, canvasH)) {
      violations.push({ rule: "relation", message: problem });
    }
  }

  // A box with no area is not a design decision, it is an arithmetic accident:
  // padding plus gap larger than the parent leaves a child measured at zero
  // width, and it was being emitted as such. X07 saw resolved child widths
  // reach zero with only an overflow complaint alongside.
  //
  // Reported separately because "this region does not fit" and "this child
  // does not exist" call for different fixes, and a designer reading only the
  // first would resize the region and be back here.
  for (const region of regions) {
    for (const child of region.children) {
      const box = boxes.get(child);
      if (!box) continue;
      if (box.w > 0.5 && box.h > 0.5) continue;
      violations.push({
        rule: "geometry",
        message: `Content '${child}' resolved to ${Math.round(box.w)}x${Math.round(box.h)} inside '${region.id}' — padding and gap leave no room for it. Reduce the region's padding or gap, or give the region more space.`,
      });
    }
  }
  for (const region of regions) {
    if (region.w > 0.5 && region.h > 0.5) continue;
    violations.push({
      rule: "geometry",
      message: `Region '${region.id}' resolved to ${Math.round(region.w)}x${Math.round(region.h)} — it has no area and will not be drawn.`,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Operation trace / resolved box agreement                                   */
/* -------------------------------------------------------------------------- */

/** Slack allowed when comparing an emitted position to the resolved box. */
const TRACE_TOLERANCE = 1;

/**
 * Proves the operation list and the resolved boxes describe the same screen.
 *
 * ## The defect this exists for
 *
 * Issue #11 found an IR that "reports requested region boxes but emits
 * operations with different positions/sizes, including unexpected width
 * expansion and cumulative vertical offsets". Comparing the two naively does
 * not work, and the reason is the reason it was hard to see: **they are in
 * different coordinate spaces.**
 *
 * A resolved box is canvas-absolute. An emitted operation is positioned relative
 * to its Figma parent, because Figma stores child coordinates that way. A
 * metric card at canvas x=304 inside a region at x=272 is emitted at x=32, and
 * both are right. A naive comparison reports a 272px disagreement and the
 * honest checker gets ignored.
 *
 * So the parent origin is folded in before comparing, and the check names both
 * spaces in its failure message. Anything still out by more than a pixel after
 * that is a genuine disagreement: a layout computed one box and the emitter
 * used another.
 *
 * Returns the number of mismatches so the caller can refuse to present an
 * inconsistent plan as applicable.
 */
function verifyOperationTrace(
  operations: Operation[],
  boxes: Map<string, PlacedBox>,
  violations: CompileResult["violations"],
): number {
  // Canvas origin of each parentable node, derived from the resolved boxes.
  const originOf = new Map<string, { x: number; y: number }>([["root", { x: 0, y: 0 }]]);
  for (const [id, box] of boxes) originOf.set(id, { x: box.x, y: box.y });

  const resolveOrigin = (parentId: unknown, seen = new Set<string>()): { x: number; y: number } => {
    if (typeof parentId !== "string") return { x: 0, y: 0 };
    if (seen.has(parentId)) return { x: 0, y: 0 };
    seen.add(parentId);
    return originOf.get(parentId) ?? { x: 0, y: 0 };
  };

  let mismatches = 0;

  // Final geometry per node, as the trace actually leaves it.
  //
  // A `createFrame` emits where the shell layout put the region; a relation then
  // moves it with `setPosition`. Comparing the create against the resolved box
  // would report every relation as a mismatch. So mutations are replayed in
  // order and the *final* state is what gets compared — which is also the only
  // thing the user will see in Figma.
  interface FinalGeom {
    parent: unknown;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  }
  const finalState = new Map<string, FinalGeom>();

  for (const op of operations) {
    if (typeof op.type !== "string") continue;
    const record = op as unknown as Record<string, unknown>;
    const type = op.type;

    if (type.startsWith("create")) {
      const id = typeof record.id === "string" ? record.id : undefined;
      if (!id) continue;
      finalState.set(id, {
        parent: record.parent,
        ...(typeof record.x === "number" ? { x: record.x } : {}),
        ...(typeof record.y === "number" ? { y: record.y } : {}),
        ...(typeof record.width === "number" ? { w: record.width } : {}),
        ...(typeof record.height === "number" ? { h: record.height } : {}),
      });
      continue;
    }

    if (type !== "setPosition" && type !== "setSize") continue;
    const id = typeof record.target === "string" ? record.target : undefined;
    if (!id) continue;
    const state = finalState.get(id);
    if (!state) continue;
    if (typeof record.x === "number") state.x = record.x;
    if (typeof record.y === "number") state.y = record.y;
    if (typeof record.width === "number") state.w = record.width;
    if (typeof record.height === "number") state.h = record.height;
  }

  for (const [id, state] of finalState) {
    // The root frame is the canvas itself and has no resolved box to match.
    if (id === "root") continue;
    const box = boxes.get(id);
    if (!box) continue;

    const origin = resolveOrigin(state.parent);
    if (typeof state.x === "number" && typeof state.y === "number") {
      const canvasX = state.x + origin.x;
      const canvasY = state.y + origin.y;
      if (Math.abs(canvasX - box.x) > TRACE_TOLERANCE || Math.abs(canvasY - box.y) > TRACE_TOLERANCE) {
        mismatches++;
        violations.push({
          rule: "operation-trace",
          message: `'${id}' ends up at (${Math.round(state.x)}, ${Math.round(state.y)}) relative to parent '${String(state.parent ?? "root")}', which is canvas (${Math.round(canvasX)}, ${Math.round(canvasY)}), but its resolved box is (${Math.round(box.x)}, ${Math.round(box.y)}). The operation trace and the resolved geometry disagree.`,
        });
        continue;
      }
    }

    // Height is optional: Figma auto-sizes text, so a text op legitimately has
    // none. Width and height are compared independently so a missing dimension
    // cannot mask a wrong one.
    if (typeof state.w === "number" && Math.abs(state.w - box.w) > TRACE_TOLERANCE) {
      mismatches++;
      violations.push({
        rule: "operation-trace",
        message: `'${id}' is emitted ${Math.round(state.w)} wide but its resolved box is ${Math.round(box.w)} wide.`,
      });
    }
    if (typeof state.h === "number" && Math.abs(state.h - box.h) > TRACE_TOLERANCE) {
      mismatches++;
      violations.push({
        rule: "operation-trace",
        message: `'${id}' is emitted ${Math.round(state.h)} tall but its resolved box is ${Math.round(box.h)} tall.`,
      });
    }
  }

  return mismatches;
}

/**
 * Re-measures one relation against the geometry that was actually produced.
 *
 * Every clause is checked, not just the anchor. The previous version looked at
 * `rightOf` and `below` and returned `null` for everything else, which made an
 * edge-positioned relation unverifiable: X01 declared
 * `{ right: 0, top: 0, width: 300 }`, the inspector landed at y=366 instead of
 * y=0, and the compile came back `applicable: true` with zero violations. A false
 * pass is worse than a false failure — it produces a screen that looks
 * deliberate and is not (issue #13, "false-success risk in relation handling").
 *
 * The expected geometry comes from `expectedRelationBox`, which is the same
 * function the solver uses, so the check cannot drift away from the behaviour
 * it is checking.
 *
 * Returns every problem rather than the first: a relation that missed its anchor
 * usually missed its size too, and one error at a time turns one typo into
 * several round trips.
 */
function checkRelation(
  relation: DesignIR["relations"][number],
  box: PlacedBox,
  boxes: Map<string, PlacedBox>,
  parent: PlacedBox,
  canvasW: number,
  canvasH: number,
): string[] {
  const TOLERANCE = 1;
  const problems: string[] = [];
  const declared = describeRelation(relation);

  for (const anchorId of [relation.rightOf, relation.below]) {
    if (anchorId !== undefined && !boxes.has(anchorId)) {
      problems.push(`Relation '${relation.id}' names unknown anchor '${anchorId}'; no position was applied.`);
    }
  }

  const expected = expectedRelationBox(relation, parent, (id) => boxes.get(id), {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
  });
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE;

  if (expected) {
    if (!near(box.x, expected.x)) {
      problems.push(`Relation '${relation.id}' (${declared}) asked for x=${Math.round(expected.x)} but the box resolved to x=${Math.round(box.x)}. The relationship was not honoured.`);
    }
    if (!near(box.y, expected.y)) {
      problems.push(`Relation '${relation.id}' (${declared}) asked for y=${Math.round(expected.y)} but the box resolved to y=${Math.round(box.y)}. The relationship was not honoured.`);
    }
    if (Number.isFinite(expected.w) && !near(box.w, expected.w)) {
      problems.push(`Relation '${relation.id}' (${declared}) asked for width ${Math.round(expected.w)} but the box resolved to ${Math.round(box.w)}. The size was not honoured.`);
    }
    if (Number.isFinite(expected.h) && !near(box.h, expected.h)) {
      problems.push(`Relation '${relation.id}' (${declared}) asked for height ${Math.round(expected.h)} but the box resolved to ${Math.round(box.h)}. The size was not honoured.`);
    }
  }

  // Canvas containment is checked whatever the clause was: a relation that *is*
  // honoured can still land off-canvas.
  if (box.x + box.w > canvasW + CANVAS_TOLERANCE) {
    problems.push(`Relation '${relation.id}' (${declared}) resolved to x=${Math.round(box.x)} on a ${canvasW}px canvas, so ${Math.round(box.x + box.w - canvasW)}px of it is off-canvas.`);
  }
  if (box.y + box.h > canvasH + CANVAS_TOLERANCE) {
    problems.push(`Relation '${relation.id}' (${declared}) resolved to y=${Math.round(box.y)} on a ${canvasH}px canvas, so ${Math.round(box.y + box.h - canvasH)}px of it is off-canvas.`);
  }

  return problems;
}

/** A one-line rendering of the clauses a relation declares, for diagnostics. */
function describeRelation(r: DesignIR["relations"][number]): string {
  const parts: string[] = [];
  if (r.rightOf !== undefined) parts.push(`rightOf ${r.rightOf}`);
  if (r.below !== undefined) parts.push(`below ${r.below}`);
  if (r.alignTo !== undefined) parts.push(`alignTo ${r.alignTo}`);
  if (r.left !== undefined) parts.push(`left ${r.left}`);
  if (r.top !== undefined) parts.push(`top ${r.top}`);
  if (r.right !== undefined) parts.push(`right ${r.right}`);
  if (r.bottom !== undefined) parts.push(`bottom ${r.bottom}`);
  if (r.gap !== undefined) parts.push(`gap ${r.gap}`);
  if (r.inset !== undefined) parts.push(`inset ${r.inset}`);
  if (r.width !== undefined) parts.push(`width ${r.width}`);
  if (r.height !== undefined) parts.push(`height ${r.height}`);
  return parts.length > 0 ? parts.join(", ") : "no clauses";
}

/* -------------------------------------------------------------------------- */
/* Constraints                                                                 */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Typography fit                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mean glyph width as a fraction of font size. The estimate lives in
 * `estimateTextRunWidth` (tracking- and uppercase-aware); this constant remains
 * for readers comparing the two heuristics' bases.
 */
const MEAN_GLYPH_RATIO = 0.55;

/**
 * Text that cannot fit the box it was given.
 *
 * ## Why a clean compile is not evidence
 *
 * A 320px viewport holding a long title, an unbroken model identifier and a long
 * error code compiled to `applicable: true` with zero violations (X03). Nothing
 * was wrong with the geometry — every box was on canvas and inside its region.
 * The problem is that the *text* does not fit inside the box, which is a
 * property of the string and the width together, and no structural check looks
 * at it.
 *
 * The specific failure is an unbreakable run: `qwen3-32b-instruct-quantized.gguf`
 * has no space in it, so no amount of wrapping helps and it either overflows or
 * is silently truncated. Reporting "this string is 340px of glyphs in a 288px box"
 * is actionable; reporting nothing and letting Figma clip it is not.
 *
 * Non-blocking by design: a clipped model name is ugly, a false refusal to
 * build a screen because one label is long is worse. It is a `typography`
 * finding, not a geometry one.
 */
function checkTextFit(
  ir: DesignIR,
  regions: ResolvedRegion[],
  boxes: Map<string, PlacedBox>,
  typeScale: number,
  titleScale: number,
  violations: CompileResult["violations"],
): void {
  const specs = new Map(
    ir.content
      .filter((c): c is Extract<typeof c, { kind: "text" }> => c.kind === "text")
      .map((c) => [c.id, c]),
  );

  for (const region of regions) {
    for (const child of region.children) {
      const spec = specs.get(child);
      const box = boxes.get(child);
      if (!spec || !box) continue;

      const scale = TYPE_SCALE[spec.role] ?? TYPE_SCALE.body!;
      const display = spec.role === "title" || spec.role === "eyebrow" ? titleScale : 1;
      const fontSize = emittedFontSize((spec.size ?? scale.size) * typeScale, display);

      // Longest run with no break opportunity: a word, a URL, a stack trace, a
      // path. Spaces give the layout somewhere to wrap; these do not.
      const runs = spec.text.split(/\s+/).filter((r) => r.length > 0);
      let longest = "";
      for (const r of runs) if (r.length > longest.length) longest = r;
      // Shared width estimate (tracking + uppercase aware), so this check
      // agrees with the measurement the layout and the emitters used.
      const runWidth = Math.ceil(estimateTextRunWidth(longest, fontSize, spec.letterSpacing ?? 0));

      if (runWidth <= box.w + 1) continue;

      // A deliberately truncated text is not a typography failure: the author
      // chose to cut it rather than let it overflow. It is still worth saying
      // so — the value on screen is shorter than the value in the data — but
      // it is a different finding from "this will overflow".
      if (spec.truncate === true) {
        violations.push({
          rule: "text-truncated",
          message:
            `Text '${child}' is truncated at ${Math.round(box.w)}px: the run "${longest.slice(0, 48)}" measures about ${runWidth}px and cannot wrap. ` +
            `The box holds the value, not the whole value.`,
        });
        continue;
      }

      violations.push({
        rule: "typography",
        message:
          `Text '${child}' holds the unbreakable run "${longest.slice(0, 48)}", which measures about ${runWidth}px at ${Math.round(fontSize)}px inside a ${Math.round(box.w)}px box. ` +
          `It cannot wrap, so it will be clipped or overflow. Shorten it, allow a break, truncate it deliberately, or give it a wider box.`,
      });
    }
  }
}

/**
 * Product constraints from spec §29 / §51.
 *
 * ## Severity, which is the point of this function
 *
 * These are **hard blockers**. Declaring `maxMetricCards: 2` is a statement about
 * the product, not a suggestion about the screen: a program that declares the
 * constraint and then ships four metric cards has not "drifted slightly", it has
 * built the thing the constraint forbids. X08 reported four cards against a
 * limit of two and the compile came back `applicable: true`, so the constraint
 * was advisory in practice while reading as mandatory in the IR.
 *
 * The cost of being wrong in this direction is bounded — the author sees the
 * violation and removes the constraint or the cards — while the cost of the
 * other direction is a product truth quietly not enforced. Blocking is the
 * recoverable error.
 *
 * They keep their own rule names rather than sharing one bucket, because the
 * name is what tells a reader which constraint failed.
 */
function checkConstraints(ir: DesignIR, composition: string, violations: CompileResult["violations"]): void {
  const c = ir.constraints;
  if (!c) return;

  const metrics = ir.content.filter((x) => x.kind === "component" && x.type === "metric");
  const text = ir.content.filter((x) => x.kind === "text").map((x) => (x.kind === "text" ? x.text : ""));
  const joined = text.join(" ").toLowerCase();

  if (c.maxMetricCards !== undefined && metrics.length > c.maxMetricCards) {
    violations.push({
      rule: "maxMetricCards",
      message: `${metrics.length} metric cards requested but the limit is ${c.maxMetricCards}.`,
    });
  }

  if (c.noGenericCardGrid && composition === "canvas" && ir.regions.length <= 2) {
    violations.push({
      rule: "noGenericCardGrid",
      message: "Constraint forbids a generic card grid, but the layout resolved to a plain canvas with no semantic regions.",
    });
  }

  if (c.noChatAsPrimary && /chat|message|conversation/.test(joined) && composition !== "instrument") {
    violations.push({
      rule: "noChatAsPrimary",
      message: "Product constraint says chat must not be the primary interaction, but chat copy is present in a non-instrument layout.",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Component taste                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Status tones, shared by statusPill, deviceNode health and modelRow status.
 *
 * One mapping for every component that communicates state, because three
 * different greens for "healthy" across three components is how a file starts
 * disagreeing with itself. `soft` backgrounds keep the tone readable without
 * shouting; the text carries the meaning, never colour alone.
 */
const TONES: Record<string, { fg: string; bg: string }> = {
  success: { fg: "#1E6B3A", bg: "#2D7A4D1A" },
  healthy: { fg: "#1E6B3A", bg: "#2D7A4D1A" },
  warning: { fg: "#8A5200", bg: "#B26A001A" },
  degraded: { fg: "#8A5200", bg: "#B26A001A" },
  error: { fg: "#A32A12", bg: "#D134151A" },
  offline: { fg: "#A32A12", bg: "#D134151A" },
  info: { fg: "#0B6BCB", bg: "#0D99FF1A" },
  neutral: { fg: "#5A5C54", bg: "#6F716A1A" },
};

/** Resolves a tone name to its colours, defaulting to neutral rather than failing. */
function toneFor(v: unknown): { fg: string; bg: string } {
  if (typeof v === "string" && TONES[v.toLowerCase()]) return TONES[v.toLowerCase()]!;
  return TONES.neutral!;
}

/**
 * Product-language states mapped onto tones.
 *
 * Authors write "fits", "insufficient memory", "stale" — the words the product
 * uses — not the tone vocabulary. Exact tone names win; recognised product
 * language maps onto the nearest tone; anything else stays neutral rather
 * than guessing. Narrow on purpose: a mapping that fires on substrings of
 * ordinary prose would invent meaning.
 */
function stateTone(v: unknown): { fg: string; bg: string } {
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (TONES[s]) return TONES[s]!;
    if (/\bfits?\b|\bready\b|\bok\b|success|healthy|connected|available/.test(s)) return TONES.success!;
    if (/fail|error|insufficient|exceed|offline|denied|unavailable|rejected/.test(s)) return TONES.error!;
    if (/warn|degraded|stale|partial|pending|loading|progress|attention|pressure/.test(s)) return TONES.warning!;
    if (/info|running|live|sync|refresh/.test(s)) return TONES.info!;
  }
  return TONES.neutral!;
}

/** Health of a machine to its stroke colour. */
function healthStroke(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const tone = TONES[v.toLowerCase()];
  return tone ? tone.fg : undefined;
}

/**
 * Node size for algorithm-placed graphics.
 *
 * Algorithms return centres, so the caller owns the extent. A vector carrying a
 * sparkline needs more room than a dot in a node-link diagram, but the caller
 * cannot know which is which without inspecting path data, so this is a single
 * consistent size that every algorithm shares.
 */
function graphicSize(grid: number): { w: number; h: number } {
  return { w: grid * 4, h: grid * 4 };
}

function snapshot(boxes: Map<string, PlacedBox>): Map<string, PlacedBox> {
  const out = new Map<string, PlacedBox>();
  for (const [id, box] of boxes) out.set(id, { ...box });
  return out;
}

/**
 * Rewrites position and size on an already-emitted create operation.
 *
 * Relations run after emission, so a moved content node cannot simply be
 * re-created. Patching the original op keeps the operation list minimal (which
 * matters: the model may inspect it) and avoids emitting a redundant
 * `setPosition` for a node that has not been created yet in Figma's timeline.
 *
 * `origin` is the parent's canvas position, and it is not optional decoration:
 * a create op parented to a region stores **parent-local** coordinates (Figma's
 * convention, which the emitters follow), while everything the layout computes
 * is canvas-absolute. Passing a canvas box without the origin writes the node at
 * twice its offset — which is exactly the "cumulative vertical offsets" and
 * "unexpected width expansion" issue #11 reported from the operation trace.
 */
function patchEmit(
  operations: Operation[],
  id: string,
  patch: { x: number; y: number; width: number; height: number },
  origin?: { x: number; y: number },
): void {
  const localX = origin ? patch.x - origin.x : patch.x;
  const localY = origin ? patch.y - origin.y : patch.y;
  // Every create type that owns a box, not just the frame-shaped ones.
  //
  // This list omitted `createText` and `createVector`, so when a relation
  // resized a region, its text and vector operations kept the geometry they were
  // emitted with: "'h-title' is emitted 1140 wide but its resolved box is 820"
  // and a route vector left 240px above where it actually drew (issue #13, live
  // apply gate). The resolved boxes were right and the operations were stale, so
  // the mismatch check was reporting a real disagreement — the fix was here, not
  // in the check. `createInstance` joined for the same reason: an instance is a
  // flow child with its own x/y against its parent region, so a pass that moves
  // content inside its region (vertical redistribution, issue #25) or a relation
  // that moves it left the instance behind and the trace check called the
  // geometry a lie. width/height are written too and simply ignored by the
  // executor for instances, which size from their component.
  const PATCHABLE = new Set(["createFrame", "createRectangle", "createEllipse", "createText", "createVector", "createComponent", "createInstance"]);
  for (let i = operations.length - 1; i >= 0; i--) {
    const candidate = operations[i] as { type?: string; id?: string; parent?: unknown } & Record<string, unknown>;
    if (candidate.id !== id) continue;
    if (!candidate.type || !PATCHABLE.has(candidate.type)) continue;
    // A root-parented node has no offset to subtract; anything else is
    // parent-local and must be converted.
    const parentIsRoot = candidate.parent === undefined || candidate.parent === "root";
    candidate.x = parentIsRoot ? patch.x : localX;
    candidate.y = parentIsRoot ? patch.y : localY;
    candidate.width = patch.width;
    // Text auto-resizes to its content in Figma, so a height would be a second,
    // competing answer. Vectors need theirs or the path is scaled.
    if (candidate.type !== "createText") candidate.height = patch.height;
    return;
  }
}

/**
 * How many columns a region's children should re-pack into, or null when they
 * must not be re-packed at all.
 *
 * The same decision `emitContent` makes, read back from the region rather than
 * recomputed, so a re-pack after a resize lands on the arrangement the region
 * would have had all along.
 *
 * **Graph layouts return null.** A `cluster`, `tree`, `radial`, `force`,
 * `timeline` or `topology` region's children were placed by an algorithm whose
 * whole job is their arrangement; re-packing them as a stack throws that away.
 * It also failed *silently*: re-packing a cluster stretched three 128px device
 * nodes to the full 820px inner width, and because the emitted operation was
 * patched to match, the resolved box and the trace agreed — the trace check
 * reported nothing while the topology had become a column of full-width bars.
 * A silent design regression is the worst kind, so the exclusion is explicit.
 *
 * Such a region keeps its algorithm's placement when narrowed. If nodes then
 * escape it, the containment check says so rather than the layout quietly
 * reinterpreting itself.
 */
function repackColumns(region: { columns?: number; layout?: string; role?: string }, childCount: number): number | null {
  const GRAPH_LAYOUTS = new Set(["cluster", "tree", "radial", "force", "timeline", "topology"]);
  if (region.layout !== undefined && GRAPH_LAYOUTS.has(region.layout)) return null;
  if (typeof region.columns === "number" && region.columns > 0) return Math.min(region.columns, Math.max(1, childCount));
  // A grid or masonry region with no declared count: fit what is there.
  if (region.layout === "grid" || region.layout === "masonry") {
    return Math.max(1, Math.min(6, Math.round(Math.sqrt(Math.max(1, childCount)))));
  }
  // Everything else is a single column: a nav rail, an inspector list, a header.
  return region.role === "footer" || region.role === "navigation" ? Math.max(1, childCount) : 1;
}

/**
 * Grows regions to fit their placed content and shifts regions below down.
 *
 * A region whose content bottom clears its frame extends downward by the
 * difference (plus bottom padding); every region starting at or below the old
 * bottom edge moves down by the same amount, carrying its content boxes. Only
 * growth: nothing shrinks, side rails never shift, and deck slides (fixed
 * 1920x1080) are excluded by the caller. Region frame ops are patched in
 * place and the boxes map is updated, so connectors resolved afterwards anchor
 * to the final geometry.
 *
 * Band members (`bands`, from the shell's horizontal banding) grow as one
 * object rather than each to its own content: their heights are shared — the
 * tallest member requirement wins, exactly as the band was resolved — and the
 * growth is capped at the band's height. Without the cap, an inspector whose
 * content ran taller than the band grew the region past the canvas bottom;
 * with it, the band stays one cohesive row inside the canvas and any remaining
 * overflow is the containment finding `assertResolvedGeometry` reports, never
 * a canvas escape. One exception (issue #25 Phase B): a band whose height is
 * no member's declaration (a hug band) is not capped at the shell's floor —
 * it grows to its content, so a content-only band hugs instead of pinning its
 * content against a 1px frame.
 */
function fitRegionsToContent(args: {
  regions: ResolvedRegion[];
  boxes: Map<string, PlacedBox>;
  operations: Operation[];
  grid: number;
  /** Canvas height, the ceiling a hug band's content-driven growth may not pass. */
  canvasH: number;
  bands?: ReadonlyArray<{ members: readonly string[]; capH: number; heightKind: "fill" | "numeric" | "hug" }>;
}): void {
  const { regions, boxes, operations, grid } = args;

  // Band membership by id; the first band naming a region owns it (the shell
  // never puts a region in two bands).
  const bandOf = new Map<string, { members: readonly string[]; capH: number; heightKind: "fill" | "numeric" | "hug" }>();
  for (const band of args.bands ?? []) {
    for (const id of band.members) {
      if (!bandOf.has(id)) bandOf.set(id, band);
    }
  }
  /** Bands still to process: the band grows once, at its first member. */
  const pendingBands = new Set(args.bands ?? []);

  /** The lowest box the region's own children reach (canvas-absolute), or `-Infinity` when it holds none. */
  const contentBottomOf = (region: ResolvedRegion): number => {
    let bottom = Number.NEGATIVE_INFINITY;
    for (const child of region.children) {
      const box = boxes.get(child);
      if (box) bottom = Math.max(bottom, box.y + box.h);
    }
    return bottom;
  };

  const ordered = [...regions].sort((a, b) => a.y - b.y || a.x - b.x);
  const origBottom = new Map(ordered.map((r) => [r.id, r.y + r.h]));
  const grown: Array<{ bottom: number; dy: number }> = [];

  const shiftBox = (id: string, dy: number): void => {
    const box = boxes.get(id);
    if (box) boxes.set(id, { ...box, y: box.y + dy });
  };

  const patchRegionFrame = (region: ResolvedRegion): void => {
    const frame = boxes.get(region.id);
    if (frame) boxes.set(region.id, { ...frame, y: region.y, h: region.h });
    patchEmit(operations, region.id, { x: region.x, y: region.y, width: region.w, height: region.h });
  };

  for (const region of ordered) {
    const origY = region.y;
    const dy = grown.filter((g) => g.bottom <= origY).reduce((sum, g) => sum + g.dy, 0);
    if (dy !== 0) {
      region.y = origY + dy;
      shiftBox(region.id, dy);
      for (const child of region.children) shiftBox(child, dy);
      patchRegionFrame(region);
    }
    const band = bandOf.get(region.id);
    if (band) {
      if (!pendingBands.delete(band)) continue;
      // The band is one row: measure every member against the (shared,
      // post-shift) band top and let the tallest requirement set the height —
      // the same rule the shell used to resolve the band. The cap is a maximum,
      // never a shrink: a band already taller than its cap (alignment rounding)
      // keeps its resolved height.
      const members = band.members
        .map((id) => regions.find((r) => r.id === id))
        .filter((m): m is ResolvedRegion => Boolean(m));
      if (members.length < 2) continue;
      const requireds = members.map((m) => {
        const pad = normalizePadding(m.padding, grid);
        const bottom = contentBottomOf(m);
        return bottom === Number.NEGATIVE_INFINITY ? m.h : Math.max(m.h, bottom - m.y + pad.bottom);
      });
      const curH = Math.max(...members.map((m) => m.h));
      // What the band may grow to. A fill or numeric band stated its height:
      // the cap is that claim, honoured exactly as before. A hug band stated
      // nothing (issue #25 Phase B, sparse-band repair): no member declared
      // `fill` or a fixed height, so the band's height must follow its content.
      // The shell resolves a hug band at its 1px floor because content is
      // unmeasured there, and the old cap — the resolved height itself — pinned
      // it collapsed while its content stood outside (reported as containment).
      // It grows to what its members hold, capped by the canvas bottom the way
      // `fitStackToCanvas` floors are; the fit passes below then hand whatever
      // the canvas can still afford to the bands that DO own content (the fill
      // member's leftover shrinks only by what the hug band now really needs).
      const cap =
        band.heightKind === "hug"
          ? Math.max(1, args.canvasH - Math.min(...members.map((m) => m.y)))
          : band.capH;
      const target = Math.max(curH, Math.min(Math.max(...requireds), cap));
      if (target > curH + 0.5) {
        const dyGrow = Math.round(target) - curH;
        if (dyGrow > 0) {
          for (const m of members) {
            m.h = Math.round(target);
            patchRegionFrame(m);
          }
          // Regions below shift once for the whole band: an entry per member
          // would move them once per member.
          const first = members[0]!;
          grown.push({ bottom: origBottom.get(first.id) ?? origY + curH, dy: dyGrow });
        }
      }
      continue;
    }
    const pad = normalizePadding(region.padding, grid);
    const contentBottom = contentBottomOf(region);
    if (contentBottom === Number.NEGATIVE_INFINITY) continue;
    const required = contentBottom - region.y + pad.bottom;
    if (required > region.h) {
      region.h = Math.round(required);
      patchRegionFrame(region);
      grown.push({ bottom: origBottom.get(region.id) ?? origY + region.h, dy: region.h - (origBottom.get(region.id)! - origY) });
    }
  }
}

/**
 * Shrinks `fill` regions to the slot actually available to them.
 *
 * `solveAxis` treats a `hug` region as zero when it hands out the leftover
 * space, because its real height is only known after its content is measured.
 * That is the right call in isolation and wrong in a stack: the leftover
 * includes space the hug region is about to need, so `fill` claims it, the hug
 * region then grows into it, and everything below is pushed off the canvas.
 *
 * Measured on a 390x844 phone layout — header 64, content `fill`, a 22px status
 * rail, footer 72. The rail is `hug`, so `fill` was given 612px; the rail grew
 * to 22 and the footer landed at y=794, ending 22px past an 844px canvas. The
 * overflow was exactly the rail's height, which is the signature of this bug.
 *
 * So this is the mirror of `fitRegionsToContent`: that pass grows a region when
 * its content needs more, this one shrinks it when its siblings need the space.
 * Both are one-directional on purpose — a `fill` region is a claim on the
 * remainder, and the remainder is by definition what is left after everything
 * else has been given what it asked for.
 *
 * With `bands` (the shell's horizontal banding) the screen is modelled as rows
 * instead of columns: a band spans columns, so a column pass cannot see that a
 * band member shrinking must be matched by every member of its band. Rows keep
 * the band cohesive — a fill-height member gives the space back (same rule as
 * ever), and the whole band moves down to the new height, so the row stays one
 * row inside the canvas.
 *
 * Content that genuinely does not fit is not hidden: the containment check
 * reports it, which is the honest outcome for a screen whose regions and
 * contents disagree about how much room there is.
 */
function fitFillRegions(args: {
  regions: ResolvedRegion[];
  boxes: Map<string, PlacedBox>;
  operations: Operation[];
  canvasH: number;
  gutter: number;
  grid: number;
  bands?: ReadonlyArray<{ members: readonly string[]; capH: number }>;
}): void {
  const { regions, boxes, operations, canvasH, gutter } = args;

  const shiftBox = (id: string, dy: number): void => {
    const box = boxes.get(id);
    if (box) boxes.set(id, { ...box, y: box.y + dy });
  };

  /**
   * How much room this region's own content needs.
   *
   * This is the floor. An earlier version floored at 1px, and the result was a
   * 1px-tall topology panel with all four of its metric cards reported as
   * outside it — trading one visible overflow for a pile of meaningless ones.
   * A fill region cannot give back space its content is standing in; the space
   * simply does not exist, and the geometry check above says so.
   */
  const contentFloor = (region: ResolvedRegion): number => {
    const pad = normalizePadding(region.padding, args.grid);
    let bottom = Number.NEGATIVE_INFINITY;
    for (const child of region.children) {
      const box = boxes.get(child);
      if (box) bottom = Math.max(bottom, box.y + box.h);
    }
    if (bottom === Number.NEGATIVE_INFINITY) return 1;
    return Math.max(1, Math.ceil(bottom - region.y + pad.bottom));
  };

  if (args.bands && args.bands.length > 0) {
    /* Band-aware rows ------------------------------------------------------ */

    // One row per shared top edge. The shell bands members at exactly the same
    // y, so clustering by y groups band members together and keeps every other
    // region its own row. A row counts as a band only when every member belongs
    // to a resolved band; anything else falls back to per-region fill
    // shrinkage, which is the column pass's own rule.
    const bandIds = new Set<string>();
    for (const band of args.bands) for (const id of band.members) bandIds.add(id);

    const rows: Array<{ regions: ResolvedRegion[]; band: boolean }> = [];
    for (const r of [...regions].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.regions[0]!.y - r.y) < 0.5) {
        last.regions.push(r);
        if (!bandIds.has(r.id)) last.band = false;
      } else {
        rows.push({ regions: [r], band: bandIds.has(r.id) });
      }
    }

    const rowHeight = (row: { regions: ResolvedRegion[] }): number => Math.max(...row.regions.map((r) => r.h));
    const rowTotal = rows.reduce((sum, row) => sum + rowHeight(row), 0) + gutter * Math.max(0, rows.length - 1);
    let overflow = rowTotal - canvasH;

    if (overflow > 0) {
      for (const row of rows) {
        if (overflow <= 0) break;
        const members = row.regions;
        if (row.band && members.length >= 2) {
          // The band shrinks as one height, floored at what any member's content
          // is standing in. Only a fill-height member triggers it: the same
          // "only a fill region gives space back" rule the per-column pass
          // applies, so a band without one still owns its declared height here.
          const fillMember = members.find((m) => m.height === "fill");
          if (!fillMember) continue;
          const curH = Math.max(...members.map((m) => m.h));
          const floorMax = Math.max(...members.map((m) => contentFloor(m)));
          const take = Math.min(overflow, curH - floorMax);
          if (take <= 0) continue;
          const newH = Math.max(floorMax, Math.round(curH - take));
          overflow -= curH - newH;
          for (const m of members) {
            m.h = newH;
            const frame = boxes.get(m.id);
            if (frame) boxes.set(m.id, { ...frame, h: newH });
            patchEmit(operations, m.id, { x: m.x, y: m.y, width: m.w, height: newH });
          }
          continue;
        }
        for (const region of members) {
          if (overflow <= 0) break;
          if (region.height !== "fill") continue;
          const take = Math.min(overflow, region.h - contentFloor(region));
          if (take <= 0) continue;
          region.h = Math.round(region.h - take);
          overflow -= take;
          const frame = boxes.get(region.id);
          if (frame) boxes.set(region.id, { ...frame, h: region.h });
          patchEmit(operations, region.id, { x: region.x, y: region.y, width: region.w, height: region.h });
        }
      }
    }

    // Re-stack rows from the top so the space comes off the right place. Band
    // members move together (they share a top), carrying their content, exactly
    // as growth shifts regions down in `fitRegionsToContent`.
    let y = 0;
    for (const row of rows) {
      for (const region of row.regions) {
        const dy = Math.round(y) - region.y;
        if (dy !== 0) {
          region.y = Math.round(y);
          for (const id of [region.id, ...region.children]) shiftBox(id, dy);
          patchEmit(operations, region.id, { x: region.x, y: region.y, width: region.w, height: region.h });
        }
      }
      y += rowHeight(row) + gutter;
    }
    return;
  }

  // Columns, not one list. A side-rail shell puts a full-height nav rail at x=0
  // and stacks the content beside it at x=contentX; summing both into one stack
  // made the rail's 900px compete with the content column for the same 900px of
  // canvas and collapsed regions to nothing.
  const columns = new Map<number, ResolvedRegion[]>();
  for (const r of regions) {
    const list = columns.get(r.x);
    if (list) list.push(r);
    else columns.set(r.x, [r]);
  }

  for (const stack of columns.values()) {
    const ordered = [...stack].sort((a, b) => a.y - b.y);

    // One overflow number for the whole stack, not one per region: the fixed
    // regions were measured correctly, the `fill` region was simply given the
    // leftover and the leftover did not account for the `hug` sibling that had
    // not been measured yet. Only the fill region can give the space back.
    const total = ordered.reduce((sum, r) => sum + r.h, 0) + gutter * Math.max(0, ordered.length - 1);
    let overflow = total - canvasH;
    if (overflow <= 0) continue;

    for (const region of ordered) {
      if (overflow <= 0) break;
      if (region.height !== "fill") continue;
      const take = Math.min(overflow, region.h - contentFloor(region));
      if (take <= 0) continue;
      region.h = Math.round(region.h - take);
      overflow -= take;
      const frame = boxes.get(region.id);
      if (frame) boxes.set(region.id, { ...frame, h: region.h });
      patchEmit(operations, region.id, { x: region.x, y: region.y, width: region.w, height: region.h });
    }

    // Re-stack from the top so the space comes off the right place. Regions below
    // the shrunken one move up, carrying their content, exactly as growth shifts
    // them down in `fitRegionsToContent`.
    let y = 0;
    for (const region of ordered) {
      const dy = Math.round(y) - region.y;
      if (dy !== 0) {
        region.y = Math.round(y);
        for (const id of [region.id, ...region.children]) shiftBox(id, dy);
        patchEmit(operations, region.id, { x: region.x, y: region.y, width: region.w, height: region.h });
      }
      y += region.h + gutter;
    }
  }
}

/**
 * The automatic canvas-fit pass: shrinks an overflowing region stack back
 * inside the canvas and re-stacks it.
 *
 * This is the repair counterpart of the geometry *report* in
 * `assertResolvedGeometry`. Every earlier pass is one-directional by design —
 * `fitRegionsToContent` only grows, `fitFillRegions` only shrinks `fill`
 * regions — so a stack of fixed heights that grew (or was declared) past the
 * canvas edge reached the checks with nothing left to fix it, and the compile
 * could only refuse a screen a reflow would have saved.
 *
 * Shrinking is water-filled toward a per-region floor (see `fitStackToCanvas`):
 * first toward `MIN_STACK_REGION_H` so no region is crushed below usable, and
 * — only if even that cannot fit — toward whatever the region's own content
 * needs. If the content genuinely does not fit the canvas, the overflow
 * survives and the geometry check reports it honestly; a repair that hides a
 * real overflow would be worse than the report.
 *
 * Issue #30 adds the horizontal counterpart: a ROW of side-by-side regions
 * whose combined widths run past the right canvas edge is repaired by peeling
 * width off the right (see below), so one overflow class no longer depends on
 * which axis it happens to point at.
 *
 * Returns how many regions changed, which the caller reports as `reflowed` —
 * a repair the compiler made on its own initiative is part of the payload's
 * story, not something to hide.
 */
function canvasFitReflow(args: {
  regions: ResolvedRegion[];
  boxes: Map<string, PlacedBox>;
  operations: Operation[];
  canvasH: number;
  canvasW: number;
  gutter: number;
  grid: number;
  /** Ids the relation solver positioned; their geometry is contract, not adjustable. */
  frozen?: ReadonlySet<string>;
}): number {
  const { regions, boxes, operations, canvasH, canvasW, gutter, grid, frozen } = args;

  const shiftBox = (id: string, dy: number): void => {
    const box = boxes.get(id);
    if (box) boxes.set(id, { ...box, y: box.y + dy });
  };

  // Columns, not one list — same reasoning as `fitFillRegions`: a side-rail
  // shell's full-height rail must not compete with its content column for the
  // same canvas height.
  const columns = new Map<number, ResolvedRegion[]>();
  for (const r of regions) {
    if (frozen?.has(r.id)) continue;
    const list = columns.get(r.x);
    if (list) list.push(r);
    else columns.set(r.x, [r]);
  }

  /** The height a region's own content needs, or null when it holds none. */
  const contentNeed = (region: ResolvedRegion): number | null => {
    const pad = normalizePadding(region.padding, grid);
    let bottom = Number.NEGATIVE_INFINITY;
    for (const child of region.children) {
      const box = boxes.get(child);
      if (box) bottom = Math.max(bottom, box.y + box.h);
    }
    if (bottom === Number.NEGATIVE_INFINITY) return null;
    return Math.max(1, Math.ceil(bottom - region.y + pad.bottom));
  };

  // A region cannot give back space its content is standing in — the repair
  // would trade one overflow report for a pile of containment findings.
  // Fill and hug regions MAY give back space down to their content need: a
  // fill region's "take the leftover space" contract is exactly what overflows
  // when an earlier region grows (a 142px header pushed a 184px fill inspector
  // to (290,736) on a 900px canvas and nothing could pull it back because both
  // fills were declared untouchable). What they must not give back is the room
  // their own content is standing in, so the floor is the content need.
  const shrinkableOf = (region: ResolvedRegion, floor: "usable" | "content"): boolean => {
    const need = contentNeed(region);
    if (need === null) return region.height !== "fill" && region.height !== "hug" && (floor === "usable" ? region.h > MIN_STACK_REGION_H : region.h > 1);
    const minH = floor === "usable" ? Math.max(MIN_STACK_REGION_H, need) : Math.max(1, need);
    return region.h > minH + 0.5;
  };
  const floorOf = (region: ResolvedRegion, floor: "usable" | "content"): number => {
    const need = contentNeed(region);
    if (need === null) return floor === "usable" ? MIN_STACK_REGION_H : 1;
    return floor === "usable" ? Math.max(MIN_STACK_REGION_H, need) : Math.max(1, need);
  };

  let changed = 0;
  for (const stack of columns.values()) {
    // A frozen (relation-placed) region sharing this column makes re-stacking
    // unsafe — a shrunken stack could slide onto or under the frozen region —
    // so the column keeps its geometry and the checks report any real spill.
    if (regions.some((r) => r.x === stack[0]!.x && frozen?.has(r.id))) continue;
    const ordered = [...stack].sort((a, b) => a.y - b.y);
    const beforeGeom = new Map(ordered.map((r) => [r.id, { y: r.y, h: r.h }]));
    const bottom = Math.max(...ordered.map((r) => r.y + r.h));
    // Pull back to the canvas edge, not to 1px short of spilling past it.
    const overflow = bottom - canvasH + CANVAS_TOLERANCE;
    if (overflow <= 0) continue;

    // Two attempts: first respect a usable minimum per region; if the canvas
    // genuinely cannot afford that, fit beats aesthetics and the floor drops
    // to what each region's content needs.
    for (const floor of ["usable", "content"] as const) {
      const refit = fitStackToCanvas({
        heights: ordered.map((r) => r.h),
        shrinkable: ordered.map((r) => shrinkableOf(r, floor)),
        mins: ordered.map((r) => floorOf(r, floor)),
        canvasH: canvasH,
        gutter,
      });
      if (refit.changed === 0) continue;
      ordered.forEach((region, i) => {
        region.h = Math.round(refit.heights[i]!);
      });
      break;
    }

    // Re-stack from the top, carrying content and patching the already-emitted
    // region frames (region ops are root-parented, so no origin conversion).
    let y = ordered[0]!.y;
    for (const region of ordered) {
      const dy = Math.round(y) - region.y;
      const was = beforeGeom.get(region.id)!;
      const moved = dy !== 0 || Math.abs(was.h - region.h) > 0.5;
      if (moved) {
        region.y = Math.round(y);
        // Height-only repairs (dy = 0, the region shrank in place) must patch
        // too, or the op keeps the old height and the trace check calls the
        // geometry a lie.
        patchEmit(operations, region.id, { x: region.x, y: region.y, width: region.w, height: region.h });
      }
      // The region's own resolved box carries the refit geometry as well: the
      // trace check folds the emitted op against this box, so a box still at
      // the old height contradicts the patched op.
      const selfBox = boxes.get(region.id);
      if (selfBox) boxes.set(region.id, { ...selfBox, x: region.x, y: region.y, w: region.w, h: region.h });
      for (const id of region.children) shiftBox(id, dy);
      y += region.h + gutter;
    }
    const newBottom = Math.max(...ordered.map((r) => r.y + r.h));
    if (newBottom < bottom - 0.5 || ordered.some((r) => {
      const was = beforeGeom.get(r.id)!;
      return Math.abs(was.y - r.y) > 0.5 || Math.abs(was.h - r.h) > 0.5;
    })) {
      changed += ordered.length;
    }
  }

  /* ------------------------- rows: the horizontal mirror (issue #30) ------------------------- */

  // The same repair right for the other axis. A row of side-by-side regions
  // whose widths run past the RIGHT canvas edge used to be unrepairable — the
  // columns loop only shrinks heights — so `assertResolvedGeometry` could only
  // refuse a wide fixed-width row a repair would have saved.
  //
  // Rows peel width from the right, NOT proportionally, for a geometric
  // reason: an interior region's width contributes nothing to the row's max
  // right edge, so shrinking it would narrow the design without moving that
  // edge one pixel. Only the region that currently OWNS the max right edge
  // does. Width is taken right-to-left, each region down to its floor, until
  // the edge is inside the canvas or the row genuinely cannot fit.

  /** The width a region's own content needs (children's right edge + pad.right), or null when it holds none. */
  const widthNeed = (region: ResolvedRegion): number | null => {
    const pad = normalizePadding(region.padding, grid);
    let right = Number.NEGATIVE_INFINITY;
    for (const child of region.children) {
      const box = boxes.get(child);
      if (box) right = Math.max(right, box.x + box.w);
    }
    if (right === Number.NEGATIVE_INFINITY) return null;
    return Math.max(1, Math.ceil(right - region.x + pad.right));
  };

  const rows = new Map<number, ResolvedRegion[]>();
  for (const r of regions) {
    if (frozen?.has(r.id)) continue;
    const list = rows.get(r.y);
    if (list) list.push(r);
    else rows.set(r.y, [r]);
  }

  for (const row of rows.values()) {
    // Same rule as columns: a frozen (relation-placed) region sharing this row
    // makes width repair unsafe — its geometry is the contract the relations
    // declare — so the row keeps its geometry and the checks report any spill.
    if (regions.some((r) => r.y === row[0]!.y && frozen?.has(r.id))) continue;
    const rightmost = [...row].sort((a, b) => b.x + b.w - (a.x + a.w));
    const beforeW = new Map(row.map((r) => [r.id, r.w]));
    const maxRight = Math.max(...row.map((r) => r.x + r.w));
    // The exact spill past the edge — no tolerance inflation. A row that ends
    // flush (or within the checker's tolerance) is clean, and peeling a pixel
    // off it would trade true geometry for a 1px-short lie the tiling tests
    // would catch. fitStackToCanvas's vertical math makes the same choice.
    const overflow = maxRight - canvasW;
    if (overflow <= 0) continue;

    let shrunk = false;
    // Two floors, the same ladder as heights: usable minimum first, then —
    // only if the canvas genuinely cannot afford that — what the content
    // itself needs, so the repair cannot mint containment findings.
    for (const floor of ["usable", "content"] as const) {
      let remaining = overflow;
      for (const region of rightmost) {
        if (remaining <= 1e-6) break;
        const need = widthNeed(region);
        const minW =
          floor === "usable"
            ? need === null
              ? MIN_STACK_REGION_H
              : Math.max(MIN_STACK_REGION_H, need)
            : need === null
              ? 1
              : Math.max(1, need);
        const headroom = region.w - minW;
        if (headroom < 1) continue;
        const take = Math.min(Math.ceil(remaining), Math.floor(headroom));
        if (take < 1) continue;
        region.w = Math.max(minW, Math.round(region.w - take));
        remaining -= take;
        shrunk = true;
      }
      if (remaining <= 1e-6) break;
    }
    if (!shrunk) continue;

    // Patch what changed: region frames keep their origin (nothing moved),
    // the resolved boxes carry the refit width, and children stay exactly
    // where they were — the content floor guaranteed they still fit.
    for (const region of row) {
      const was = beforeW.get(region.id)!;
      if (Math.abs(was - region.w) > 0.5) {
        const selfBox = boxes.get(region.id);
        if (selfBox) boxes.set(region.id, { ...selfBox, x: region.x, y: region.y, w: region.w, h: region.h });
        patchEmit(operations, region.id, { x: region.x, y: region.y, width: region.w, height: region.h });
      }
    }
    changed += row.length;
  }
  return changed;
}

/* -------------------------------------------------------------------------- */
/* Vertical redistribution of sparse band space (issue #25)                     */
/* -------------------------------------------------------------------------- */

/**
 * A band counts as sparse — worth redistributing around — when its content
 * fills at most this share of the band's inner height. Above that the leftover
 * is the band's breathing room, already honest; below it the band is one
 * content cluster at the top with the rest empty, which is the pattern the
 * Phase B vision pass recorded on every live fixture.
 */
const SPARSE_CONTENT_SHARE = 0.6;

/**
 * Splits a sparse band's leftover height around its content instead of leaving
 * all of it below the content.
 *
 * ## Why this exists
 *
 * The geometry pipeline was one-directional: regions are sized, content is
 * packed from each region's top-left, and the fit passes grow or shrink the
 * *frame* — nothing ever re-asks where the content should sit inside the final
 * frame. So a 1440x900 inspector whose content measured ~250px drew a content
 * cluster at the top-left and ~650px of empty canvas below it: structurally
 * clean (every containment check passed) and visibly sparse. The Phase B vision
 * evidence recorded exactly that on every live fixture.
 *
 * The mechanism is bounded and honest. A band qualifies when its flow content
 * fills at most `SPARSE_CONTENT_SHARE` of its inner height; the content block
 * then moves to the vertical centre of the space it actually has — the leftover
 * is split above and below, never scaled away. Nothing else changes: no region
 * box, no declared fill/hug/grow semantics, no content size, no invented
 * content. Boxes and operations move together (children are patched
 * parent-local, exactly as `fitRegionsToContent` moves them with their region),
 * so `verifyOperationTrace` keeps proving the two agree.
 *
 * Refusals are reported, not silent:
 * - `visualIntent.alignment: "strong"` declares deliberate top-anchored flow —
 *   the band keeps its placement and says so.
 * - content that already escapes the band is left alone: redistributing it
 *   would trade sparsity for containment findings.
 * - regions arranged by a graph/grid algorithm or held by Figma's own
 *   auto-layout place their own children; redistribution does not overrule
 *   them, it notes them.
 * - a band whose content is pinned by a declared relation keeps the placement
 *   the solver settled: moving it again would make `checkRelation` fail.
 */
function redistributeBandSpace(args: {
  regions: ResolvedRegion[];
  boxes: Map<string, PlacedBox>;
  operations: Operation[];
  grid: number;
  /** True when `visualIntent.alignment` is `"strong"`: declared placement wins. */
  alignmentStrong: boolean;
  /** Regions emitted as native auto-layout containers; Figma stacks their children. */
  autoLayout: ReadonlySet<string>;
  /** Declared relations: any band they touch keeps the solver's placement. */
  relations: DesignIR["relations"];
  /** The IR, read for content kinds (text vs exact-extent children). */
  ir: DesignIR;
  /** Measured text heights, when the caller could measure them. */
  textMetrics?: Map<string, { width: number; height: number }>;
}): { pixels: number; bands: number; notes: string[] } {
  const { regions, boxes, operations, grid, alignmentStrong, autoLayout, relations, ir, textMetrics } = args;
  const out = { pixels: 0, bands: 0, notes: [] as string[] };
  const contentById = new Map(ir.content.map((c) => [c.id, c]));

  // Every id a relation positions or anchors — a band holding any of them is
  // not redistributed, because the relation solver's geometry is contract and
  // re-asking it makes the declared relation report as violated.
  const relationTouched = new Set<string>();
  for (const relation of relations) {
    relationTouched.add(relation.id);
    if (relation.rightOf !== undefined) relationTouched.add(relation.rightOf);
    if (relation.below !== undefined) relationTouched.add(relation.below);
  }

  for (const region of regions) {
    if (region.children.length === 0) continue;
    const children = region.children
      .map((id) => boxes.get(id))
      .filter((b): b is PlacedBox => b !== undefined);
    if (children.length === 0) continue;

    const pad = normalizePadding(region.padding, grid);
    const innerTop = region.y + pad.top;
    const innerBottom = region.y + region.h - pad.bottom;
    const innerH = innerBottom - innerTop;
    if (innerH <= 0) continue;

    let contentTop = Number.POSITIVE_INFINITY;
    let contentBottom = Number.NEGATIVE_INFINITY;
    for (const child of children) {
      contentTop = Math.min(contentTop, child.y);
      contentBottom = Math.max(contentBottom, child.y + child.h);
    }

    // Content that already escapes its band is left where it is: this pass
    // trades empty space for balance, never balance for a containment finding.
    if (contentTop < innerTop - 0.5 || contentBottom > innerBottom + 0.5) {
      out.notes.push(
        `band '${region.id}' kept its layout: its content does not fit the band, so redistribution would trade sparsity for containment findings.`,
      );
      continue;
    }

    const topGap = contentTop - innerTop;
    const bottomGap = innerBottom - contentBottom;
    const contentH = contentBottom - contentTop;
    if (contentH > SPARSE_CONTENT_SHARE * innerH) continue; // not sparse — nothing to give back

    if (region.layout !== "flow") {
      out.notes.push(
        `band '${region.id}' is arranged by the '${region.layout}' algorithm, so its children keep the placement the algorithm chose.`,
      );
      continue;
    }
    // Any region that ASKED for a native auto-layout container is skipped,
    // whether the request was honoured or declined. Honoured: Figma stacks the
    // children itself and the recorded boxes must agree with it. Declined: the
    // runtime measures text between its two compile passes, and a request that
    // flips from declined to honoured between passes would otherwise move the
    // content twice — centred on the estimate, top-anchored once measured.
    if (autoLayout.has(region.id) || (region as { autoLayout?: string }).autoLayout === "vertical") {
      out.notes.push(
        `band '${region.id}' asked for a native auto-layout container, so its children keep the stacking Figma owns.`,
      );
      continue;
    }
    if (relationTouched.has(region.id) || region.children.some((id) => relationTouched.has(id))) {
      out.notes.push(`band '${region.id}' holds relation-pinned content, so it keeps the placement the relation solver settled.`);
      continue;
    }
    // Text whose height is still the character-count estimate is skipped, the
    // same doctrine the auto-layout gate applies: an estimate is not exact
    // enough to balance against, and the runtime's measure-then-recompile pass
    // would otherwise move the content twice — centred on the estimate, moved
    // again once measured. A region with no text (components and instances
    // have exact extents) does not need this gate.
    const unmeasuredText = region.children.filter((id) => {
      const child = contentById.get(id);
      return child !== undefined && child.kind === "text" && (textMetrics?.get(id)?.height ?? 0) === 0;
    });
    if (unmeasuredText.length > 0) {
      out.notes.push(
        `band '${region.id}' holds text with only estimated heights (${unmeasuredText.map((id) => `'${id}'`).join(", ")}), so it keeps absolute placement until the text is measured.`,
      );
      continue;
    }
    if (alignmentStrong) {
      out.notes.push(`band '${region.id}' kept its top-anchored flow: visualIntent alignment 'strong' declares the placement.`);
      continue;
    }

    const slack = topGap + bottomGap;
    if (slack < 2) continue; // already balanced (or too tight to move meaningfully)
    // Centre the content block in the space it has. The clamp keeps every child
    // inside the band even when the gaps are asymmetric.
    let dy = Math.round((bottomGap - topGap) / 2);
    dy = Math.max(-topGap, Math.min(dy, bottomGap));
    if (Math.abs(dy) < 1) continue;

    for (const child of children) {
      const moved: PlacedBox = { ...child, y: child.y + dy };
      boxes.set(child.id, moved);
      // Parent-local patch: the create op carries the position relative to the
      // region origin, so the origin travels with it.
      patchEmit(
        operations,
        child.id,
        { x: moved.x, y: moved.y, width: Math.max(1, Math.round(moved.w)), height: Math.max(1, Math.round(moved.h)) },
        { x: region.x, y: region.y },
      );
    }
    out.pixels += Math.abs(dy);
    out.bands += 1;
  }

  return out;
}

/**
 * Carries a region's text along when a relation moves or resizes that region.
 *
 * Flow placed each text node against the region's pre-relation box, so the node
 * is already correct *relative to its region* and only needs the region's own
 * translation applied on top. Re-packing the text here would be both wrong and
 * unnecessary: the server has no measured text metrics, so any re-pack would
 * guess line counts and silently change wrapping.
 *
 * The earlier version of this function reset every text node in the region to
 * `inner.y`, which stacked an entire region's copy on a single line whenever a
 * program used any relation at all. That is the failure this now prevents.
 *
 * Nodes the model placed with their own relation are left alone: the solver
 * already moved them to the position asked for.
 */
function relayoutRegionText(args: {
  ir: DesignIR;
  regions: ResolvedRegion[];
  boxes: Map<string, PlacedBox>;
  operations: Operation[];
  violations: CompileResult["violations"];
  /** Region geometry before the solver ran. */
  regionBefore: Map<string, { x: number; y: number; w: number; h: number }>;
  /** Ids the model positioned with an explicit relation. */
  explicitlyPlaced: Set<string>;
}): number {
  const { ir, regions, boxes, operations, regionBefore, explicitlyPlaced } = args;
  let shifted = 0;

  for (const region of regions) {
    const was = regionBefore.get(region.id);
    if (!was) continue;
    const dx = region.x - was.x;
    const dy = region.y - was.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

    const textNodes = ir.content.filter((c) => c.kind === "text" && region.children.includes(c.id));
    for (const node of textNodes) {
      if (explicitlyPlaced.has(node.id)) continue;
      const box = boxes.get(node.id);
      if (!box) continue;
      const x = box.x + dx;
      const y = box.y + dy;
      if (Math.abs(x - box.x) < 0.5 && Math.abs(y - box.y) < 0.5) continue;
      box.x = x;
      box.y = y;
      patchPosition(operations, node.id, x, y);
      shifted += 1;
    }
  }

  // Reported through stats rather than violations: a reflow is the constraint
  // working, not a rule being broken, and emitting it as a violation would make
  // every constrained screen look like it had failed something.
  return shifted;
}

function patchPosition(operations: Operation[], id: string, x: number, y: number): void {
  for (let i = operations.length - 1; i >= 0; i--) {
    const candidate = operations[i] as { type?: string; id?: string } & Record<string, unknown>;
    if (candidate.id !== id) continue;
    // createVector is included because chart and logo geometry emit vector
    // nodes with an x/y of their own; patchEmit (which re-writes a node
    // wholesale) already learned this — this narrower patch had not, and a
    // moved region that produced vector content kept its stale coordinates.
    if (
      candidate.type !== "createText" &&
      candidate.type !== "createFrame" &&
      candidate.type !== "createRectangle" &&
      candidate.type !== "createEllipse" &&
      candidate.type !== "createVector"
    )
      continue;
    candidate.x = Math.round(x);
    candidate.y = Math.round(y);
    return;
  }
}

/** Uppercase runs measure wider than the mixed-case mean the 0.56 ratio assumes. */
const UPPERCASE_WIDTH_FACTOR = 1.08;

/** A run of letters already in caps (so a preset transform will widen it). */
function upperFactor(text: string): number {
  return text.length > 0 && text === text.toUpperCase() && /[A-Z]/.test(text) ? UPPERCASE_WIDTH_FACTOR : 1;
}

/**
 * Estimated rendered width of a one-line text run, in px.
 *
 * One source of truth for every width estimate the compiler makes (`hugWidth`,
 * `estimateHeight`'s wrap arithmetic, `checkTextFit`), because two estimates
 * that disagree is exactly the drift the trace check exists to catch.
 *
 * Two things the older estimates ignored, both visible as silent clipping:
 *
 *  - `letterSpacing`, which shared/ir.ts documents in PIXELS and the plugin
 *    applies as `{ unit: "PIXELS" }` — Figma adds it after every glyph, so a
 *    tracked label is `length × tracking` px wider than its untracked self,
 *    not a negligible percentage.
 *  - uppercase transforms (`navUpper` and friends): caps glyphs run roughly 8%
 *    wider than the mixed-case mean, a modest, bounded correction measured on
 *    the tracked-rail live artifact rather than a font-metric pretence.
 */
export function estimateTextRunWidth(text: string, fontSize: number, letterSpacing = 0): number {
  const len = Math.max(1, text.length);
  return len * fontSize * 0.56 * upperFactor(text) + Math.max(0, letterSpacing) * len;
}

/**
 * Estimates the width of a hug-sized pill, button or nav item.
 *
 * Figma has no shrink-to-content sizing for frames, so a compact auto-width
 * component has to be measured up front. Deliberately generous — a slightly
 * wide pill looks intentional, a clipped one looks broken.
 */
function hugWidth(text: string, { fontSize, paddingX, letterSpacing = 0 }: { fontSize: number; paddingX: number; letterSpacing?: number }): number {
  return Math.ceil(estimateTextRunWidth(text, fontSize, letterSpacing) + paddingX * 2);
}

/** Two-decimal coordinate formatting for computed diagram geometry. */
function f1(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Serialises a parsed polyline into Figma's VectorPath data format.
 *
 * Unused in the compiler itself — the plugin re-serialises from the path string
 * at execution time — but exported so the format has a single documented
 * definition and can be asserted in tests.
 */
export function toVectorPathData(points: Array<{ x: number; y: number }>): VectorPath {
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]!.x} ${points[i]!.y}`;
  return { windingRule: "NONE", data: `${d} Z` };
}

/** Routes every candidate through the allowlist; an invalid op is a bug here. */
function op(candidate: unknown): Operation {
  const parsed = OperationSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Compiler produced an invalid operation (${issue?.path.join(".")}: ${issue?.message}). This is a bug in the IR compiler, not in the input.`,
    );
  }
  return parsed.data;
}

function resolveToken(token: string | number): string {
  return typeof token === "number" ? String(token) : token;
}

function normalizePadding(
  padding: Region_pad,
  grid: number,
): { top: number; right: number; bottom: number; left: number } {
  if (padding === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof padding === "number") return { top: padding, right: padding, bottom: padding, left: padding };
  return {
    top: padding.top ?? grid,
    right: padding.right ?? grid,
    bottom: padding.bottom ?? grid,
    left: padding.left ?? grid,
  };
}

type Region_pad = number | { top: number; right: number; bottom: number; left: number } | undefined;

function weightToStyle(weight: number): string {
  if (weight >= 800) return "ExtraBold";
  if (weight >= 700) return "Bold";
  if (weight >= 600) return "SemiBold";
  if (weight >= 500) return "Medium";
  return "Regular";
}

/**
 * Estimates a text layer's height so packing can place it.
 *
 * Rough on purpose: the text node auto-resizes to its content in Figma, so this
 * only needs to be close enough for the layout to look right. Reported
 * characters-per-line assumes the region's width.
 */
/**
 * Heights for components whose emitted height is already known exactly.
 *
 * The generic component estimate is 90px, which is right for a card and badly
 * wrong for a hairline: a `divider` emits a 1px rectangle, so reserving 90px of
 * flow space per rule made every hairline-driven editorial layout drift further
 * apart as the column filled up, and pushed the last rows off the canvas.
 *
 * Only components with a deterministic emitted height appear here. Anything that
 * genuinely sizes to its content keeps the generic estimate, so this narrows the
 * error rather than replacing the heuristic.
 */
const FIXED_COMPONENT_HEIGHT: Record<string, number> = {
  divider: 1,
  sectionDivider: 32,
  statusPill: 22,
  button: 40,
  // Component-generation v1 fixed heights (issue #24): the emitter draws
  // these extents exactly, so the layout reserves them.
  iconButton: 40,
  textInput: 64,
  select: 40,
  checkbox: 24,
  switch: 28,
  tabs: 40,
  badge: 22,
  tooltip: 64,
  menu: 132,
  dialog: 220,
  navigationItem: 36,
  tableRow: 48,
};

/**
 * The compiler's own content-height estimator, exported for the pipeline's
 * plan-side content-fit pass (issue #25/#28): the plan must state the room the
 * content needs with the SAME arithmetic the build will apply, or the plan's
 * declared chrome heights drift from the built ones and the composition
 * handoff refuses the build the plan itself set up. No behaviour change here —
 * the function is exactly the private estimator, now visible.
 */
export function estimateHeight(spec: ContentSpec, width: number, typeScale = 1, titleScale = 1, grid = 8, look: StyleLook = DEFAULT_LOOK, textMetrics?: Map<string, { width: number; height: number }>): number {
  if (spec.kind !== "text") {
    if (spec.kind === "component") {
      if (spec.type === "topologyMap") return Math.round(320 * typeScale);
      // A hug component knows its own height exactly — it is the same number the
      // emitter will draw. Using the generic 90px estimate here is what made the
      // layout reserve 90px of column for a 36px nav item.
      const hug = hugSize(spec, grid, typeScale, look);
      if (hug) return hug.h;
      if (spec.type === "divider") {
        // Orientation-aware: a horizontal hairline reserves its own stroke
        // weight (1px by default); a vertical rule defaults to a grid*8 span
        // because a 1px-tall box would emit a dot, not a rule.
        const props = spec.props as Record<string, unknown>;
        if (typeof props.orientation === "string" && props.orientation.toLowerCase() === "vertical") {
          return Math.max(1, Math.round(grid * 8));
        }
        return Math.max(1, Math.round(typeof props.strokeWeight === "number" ? props.strokeWeight : 1));
      }
      const fixed = FIXED_COMPONENT_HEIGHT[spec.type];
      return Math.round((fixed ?? 90) * typeScale);
    }
    if (spec.kind === "instance") {
      // The caller measured the component and passed its extents explicitly;
      // the layout reserves exactly that, because the drawn node is that tall.
      return Math.max(1, Math.round(spec.height));
    }
    return 32;
  }

  const measured = textMetrics?.get(spec.id);
  if (measured !== undefined && measured.height > 0) {
    // The measurement is the truth, and it already includes the type scale,
    // because the plugin measured the string at the size it will be drawn.
    return Math.max(1, Math.round(measured.height));
  }

  const scale = TYPE_SCALE[spec.role] ?? TYPE_SCALE.body!;
  const display = spec.role === "title" || spec.role === "eyebrow" ? titleScale : 1;
  const size = emittedFontSize((spec.size ?? scale.size) * typeScale, display);
  const usable = Math.max(40, spec.maxWidth ?? width);
  // Per-character pitch includes the tracking (pixels, added after every glyph)
  // and the uppercase widening a preset transform will apply — a tracked caps
  // label wraps earlier than its untracked lowercase self, and every estimate
  // that ignored this clipped its last word (the letter-spaced rail labels).
  const pitch = Math.max(1, size * 0.55 * upperFactor(spec.text) + Math.max(0, spec.letterSpacing ?? 0));
  const charsPerLine = Math.max(8, Math.floor(usable / pitch));
  const lines = Math.max(1, Math.ceil(spec.text.length / charsPerLine));
  return Math.round(lines * size * 1.4 + 4);
}

/**
 * The width the layout resolved to, after the item's own width contract.
 *
 * Two things override the column cell, and in both cases the *resolved box* has
 * to move rather than the emitter, or the two disagree and the trace check
 * reports it:
 *
 *  - a `maxWidth` on a text spec. `maxWidth` is a promise about where the text
 *    wraps; a 260px budget against a 358px column produced "emitted 260 wide but
 *    its resolved box is 358 wide" on every narrow-typography stress run (issue
 *    #12, additional issue 4: "maxWidth / fixed requested text width is not
 *    reflected consistently in resolved geometry").
 *
 *  - a hug component's intrinsic size. The layout already reserved that height
 *    (see `estimateHeight`), so nothing above or below shifts.
 */
function resolvedSize(
  spec: ContentSpec,
  box: ResolvedBox,
  grid: number,
  typeScale: number,
  look: StyleLook,
): ResolvedBox {
  if (spec.kind === "component") {
    const hug = hugSize(spec, grid, typeScale, look);
    if (hug) return { ...box, ...hug };
    // The fit gauge sizes to its column, and the detail line wraps: the
    // recorded height must be the wrapped estimate the emitter will emit, or
    // the operation trace calls the geometry a lie.
    if (spec.type === "fitGauge" && box.w > 0.5) {
      const detail = typeof spec.props.detail === "string" ? spec.props.detail : "";
      const innerW = Math.max(40, Math.round(box.w) - grid * 4);
      const lines = detail ? Math.max(1, Math.ceil((detail.length * Math.round(11 * typeScale) * 0.62) / innerW)) : 0;
      return { ...box, w: Math.round(box.w), h: Math.max(40, detail ? grid * 2 + 20 + lines * 15 : 40) };
    }
    // A divider draws at its own thin extent, not the column cell: without
    // this the trace would compare a 1px hairline (or a narrow vertical rule)
    // against a full-width box and call it a lie.
    if (spec.type === "divider") {
      const props = spec.props as Record<string, unknown>;
      const weight = Math.max(1, Math.round(typeof props.strokeWeight === "number" ? props.strokeWeight : 1));
      if (typeof props.orientation === "string" && props.orientation.toLowerCase() === "vertical") {
        return { ...box, w: weight, h: Math.max(1, Math.round(box.h)) };
      }
      return { ...box, h: weight };
    }
    return box;
  }
  if (spec.kind === "instance") {
    // Explicit extents win over the column cell: the drawn node is the
    // component's measured size, so the recorded box must be that size, or
    // the operation trace reports the disagreement.
    return { ...box, w: Math.max(1, Math.round(spec.width)), h: Math.max(1, Math.round(spec.height)) };
  }
  if (spec.kind === "text") {
    // Same formula the emitter uses (`textEmittedWidth`): the resolved box is
    // the emitted width, by construction rather than by coincidence. The 40px
    // floor applies here too, so a narrow column and a tiny maxWidth cannot
    // make the two answers disagree — except for a degenerate column, which
    // keeps its raw (zero) extent so the no-room check still sees it.
    if (box.w <= 0.5) return box;
    return { ...box, w: textEmittedWidth(spec, box.w) };
  }
  return box;
}

/**
 * Whether a region is dark enough that its contents need light text.
 *
 * Uses relative luminance rather than a hex-black test, so a deep navy rail and
 * a warm near-black both count, and a mid-grey chrome surface does not. The
 * threshold is deliberately conservative: a surface at or below 0.2 luminance is
 * treated as dark, which catches the `#111111` rail without catching the
 * `#F7F5EF` canvas.
 *
 * This is what lets a component pick a readable default instead of forcing every
 * author to override `props.color` by hand — the live review measured the
 * generated nav labels at 3.82:1, and lowering the WCAG threshold would have
 * hidden a real defect rather than fixed it.
 */
function onDarkSurface(region: ResolvedRegion): boolean {
  const fill = region.fill;
  if (typeof fill !== "string") return false;
  const hex = /^#([0-9a-f]{6})$/i.exec(fill.trim())?.[1];
  if (!hex) return false;
  const toLinear = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const r = toLinear(parseInt(hex.slice(0, 2), 16) / 255);
  const g = toLinear(parseInt(hex.slice(2, 4), 16) / 255);
  const b = toLinear(parseInt(hex.slice(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b <= 0.2;
}

/**
 * The active nav marker and the label painted on it.
 *
 * These live together on purpose. They were two literals in the `navItem`
 * emitter and both were `#F2C94C`, so the active item drew accent-yellow text
 * on an accent-yellow pill: 1.0:1, and the label was invisible on the live
 * frame (issue L05). A pair like that cannot be checked by eye at the two
 * separate call sites, which is why it drifted in the first place — the same
 * reason `hugSize` became a single source of truth.
 *
 * `#111111` on `#F2C94C` measures 11.9:1, well clear of the 4.5:1 requirement.
 * It is deliberately not derived from the rail: the pill's fill is the same
 * whichever rail it sits on, so a rail-relative label colour would be right
 * only half the time.
 */
const NAV_ACTIVE_FILL = "#F2C94C";
const NAV_ACTIVE_LABEL = "#111111";

/**
 * The size a hug component actually draws at, or null for components that fill
 * their column.
 *
 * ## The bug this removes
 *
 * Nav items, status pills and buttons size themselves to their content, and they
 * computed that size at emit time (`hugWidth(...)`, a literal `36`) while the
 * layout reserved a generic 90px grid cell. Two independent answers to one
 * question, which is exactly what the trace check exists to catch — and it did,
 * loudly: a dense five-region dashboard reported thirteen mismatches of the form
 * "'nav-0' is emitted 64 wide but its resolved box is 168 wide" (issue #12, A1
 * and acceptance criterion 2).
 *
 * The compiler was *reporting* the disagreement honestly. What was wrong was
 * that two answers existed. Now one function answers it, the layout reserves
 * that space, and the node is emitted at it — so the resolved box, the operation
 * and the pixels in Figma are the same number by construction rather than by
 * coincidence.
 *
 * Hug still wins over the column cell: a 36px nav item drawn 90px tall because
 * it happened to land in a three-column grid is not what `hug` means.
 */
function hugSize(
  spec: Extract<ContentSpec, { kind: "component" }>,
  grid: number,
  typeScale = 1,
  look: StyleLook = DEFAULT_LOOK,
): { w: number; h: number } | null {
  const str = (k: string, fallback = ""): string => {
    const v = spec.props[k];
    return typeof v === "string" ? v : fallback;
  };
  switch (spec.type) {
    // Only components that genuinely size to their *content* belong here.
    //
    // `modelRow` was briefly added to this list and that was wrong: a table row
    // spans its column, and hug-sizing it made every row in a table a different
    // width. `tests/challenge-regressions.test.mjs` caught it, which is the point
    // of that test — a "one source of truth" refactor is exactly the kind of
    // change that can quietly redefine what a component means.
    case "navItem": {
      const label = look.navUpper ? str("label", "Item").toUpperCase() : str("label", "Item");
      // The preset's nav tracking reaches the label at emit time, so the hug
      // estimate must carry it too: a tracked rail label measured untracked
      // hugged narrower than the text it holds, and the last word clipped.
      return { w: hugWidth(label, { fontSize: Math.round(14 * typeScale), paddingX: grid * 1.5, letterSpacing: look.navTracking }), h: Math.round(36 * typeScale) };
    }
    case "statusPill": {
      const label = str("label", "Status");
      return { w: hugWidth(label, { fontSize: Math.round(11 * typeScale), paddingX: grid }), h: Math.round(22 * typeScale) };
    }
    case "button": {
      const label = str("label", "Button");
      return { w: hugWidth(label, { fontSize: Math.round(13 * typeScale), paddingX: grid * 2 }), h: Math.round(40 * typeScale) };
    }
    // Component-generation v1 hug parts (issue #24): intrinsic sizes matching
    // the master anatomy, so the layout reserves what the emitter draws.
    case "iconButton": {
      return { w: Math.round(40 * typeScale), h: Math.round(40 * typeScale) };
    }
    case "checkbox": {
      const label = str("label", "Option");
      return { w: hugWidth(label, { fontSize: Math.round(14 * typeScale), paddingX: grid }), h: Math.round(24 * typeScale) };
    }
    case "switch": {
      const label = str("label", "Enabled");
      return { w: Math.round(36 * typeScale) + hugWidth(label, { fontSize: Math.round(14 * typeScale), paddingX: grid / 2 }), h: Math.round(28 * typeScale) };
    }
    case "badge": {
      const label = str("label", "Status");
      return { w: hugWidth(label, { fontSize: Math.round(11 * typeScale), paddingX: grid }), h: Math.round(22 * typeScale) };
    }
    case "navigationItem": {
      const label = str("label", "Item");
      return { w: hugWidth(label, { fontSize: Math.round(14 * typeScale), paddingX: grid * 1.5 }), h: Math.round(36 * typeScale) };
    }
    case "deviceNode": {
      // Fixed intrinsic: a device node reserves grid*16 x grid*10 wherever it
      // lands, so the layout never records the full column width for one
      // (issue #13, X11). The emitter draws the resolved box it is handed.
      return { w: Math.round(grid * 16 * typeScale), h: Math.round(grid * 10 * typeScale) };
    }
    case "fitGauge": {
      // Not a hug component any more: the block sizes to the column it was
      // packed into (a hug block that overruns its column slides under the
      // neighbouring panel), and the detail wraps — resolvedSize computes the
      // wrapped height with the same formula the emitter uses.
      return null;
    }
    default:
      return null;
  }
}

function humanize(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}