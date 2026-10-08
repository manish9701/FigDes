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
import type { CompileResult, ContentSpec, DesignIR, ResolvedBox, ResolvedRegion } from "../../../shared/ir";
import { canvasSize } from "../../../shared/ir";
import { normalizePath, normalizeVectorPath } from "../../../shared/path";
import { solveConstraints, type PlacedBox } from "./constraints";
import { routeConnector } from "./connectors";
import { coerceLogoMark, executeLogoPlan, logoConstructionGrid, logoMarkPath, opticalAlignDy, polygonPath, starPath, type LogoPlanStep } from "./marks";
import { resolveStyleTokens } from "./visual-presets";
import { inferComposition, packContent, planLayout, radial, forceDirected, defaultGutter } from "./layout";
import { runAlgorithm } from "./algorithms";

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
  }

  if (mechanics.numbers === "mono-first") look.valueMono = true;
  if (name === "technical-editorial" || name === "gallery-warm") look.headerScale = 1.15;
  if (mechanics.spacing === "12px-loose") look.panelPaddingScale = 1.5;
  if (mechanics.contrast === "bold") look.bodyWeight = 600;

  // Warmth tints the canvas when the program states no fill of its own. Named
  // paper tones, documented here: warm paper, blue-grey paper, otherwise unset.
  if (mechanics.warmth === "warm") look.rootFill = "#FAF6EF";
  else if (mechanics.warmth === "cool") look.rootFill = "#F0F3F5";

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

export function compileIR(ir: DesignIR): CompileResult {
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

  let regions = planLayout(ir, defaultGutter(canvas.grid) * rhythmScale);
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
  let reflowed = 0;

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

    const used = emitContent({ ir, region, content: children, inner, gap, operations, composition, violations, algorithms, boxes, typeScale, titleScale, look });
    if (used) algorithms[region.id] = used;
  }

  /* --------------------------------------------------------- relations --- */

  // Relations run after everything is placed, so an anchor may be a region or a
  // content node and the solver sees real geometry either way (spec §18).
  let constrained = 0;
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
    const solved = solveConstraints({
      boxes: [...boxes.values()],
      constraints: ir.relations.map((r) => ({ ...r })),
      parent: canvasBox,
      violations,
    });

    let moved = 0;
    for (const box of solved) {
      const prior = before.get(box.id);
      if (prior && (Math.abs(prior.x - box.x) > 0.5 || Math.abs(prior.y - box.y) > 0.5 || Math.abs(prior.w - box.w) > 0.5 || Math.abs(prior.h - box.h) > 0.5)) {
        moved += 1;
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
      } else {
        patchEmit(operations, box.id, { x: box.x, y: box.y, width: Math.max(1, Math.round(box.w)), height: Math.max(1, Math.round(box.h)) });
      }
    }

    // Regions may have been resized, so their own text has to follow.
    const reflow = relayoutRegionText({ ir, regions, boxes, operations, violations });

    regions = regions.map((r) => {
      const box = boxes.get(r.id);
      return box ? { ...r, x: box.x, y: box.y, w: box.w, h: box.h } : r;
    });

    constrained = moved;
    reflowed = reflow;
  }

  /* ------------------------------------------------------- connectors --- */

  if (ir.content.some((c) => c.kind === "connector")) {
    emitConnectors(ir, boxes, operations, violations, typeScale, deck);
  }

  /* ------------------------------------------------------ token refs --- */

  // A fill or stroke that is not a colour literal is a variable reference
  // ("exo/surface", "surface"), and the node gets bound instead of painted.
  // This is what "prefer tokens automatically" means mechanically: the model
  // writes the token name where a hex would go, and the binding is emitted for
  // it. Literals pass through untouched.
  bindTokenRefs(operations);

  /* -------------------------------------------------------- constraints --- */

  checkConstraints(ir, composition, violations);

  return {
    operations,
    regions,
    boxes,
    violations,
    stats: {
      regionCount: regions.length,
      contentCount: ir.content.length,
      operationCount: operations.length,
      layoutMs: Math.round((Date.now() - started) * 100) / 100,
      algorithms,
      constrained,
      reflowed,
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
 * Emits connectors as vector nodes.
 *
 * A connector compiles to `createVector` rather than a bespoke operation: the
 * route is solved here into path data, which then goes through the same
 * allowlisted, non-evaluating path pipeline as every other vector. Arrowheads are
 * closed subpaths inside that same path, so a connector is one node.
 */
function emitConnectors(
  ir: DesignIR,
  boxes: Map<string, PlacedBox>,
  operations: Operation[],
  violations: CompileResult["violations"],
  typeScale: number,
  deck: boolean,
): void {
  const connectors = ir.content.filter((c) => c.kind === "connector");
  const labels: Array<{ id: string; text: string; x: number; y: number; weight: number; parent: string }> = [];

  // Which region each content node belongs to. Needed in deck mode, where a
  // connector must live on the same slide as both of its endpoints.
  const home = new Map<string, string>();
  for (const region of ir.regions) {
    for (const child of region.children) home.set(child, region.id);
  }

  for (const spec of connectors) {
    if (spec.kind !== "connector") continue;

    // In deck mode a connector must live on the same slide as both endpoints.
    // A line cannot span two slides, so crossing one is a violation rather than
    // a silently misplaced vector.
    let parent = "root";
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
    }

    const route = routeConnector(spec, boxes.get(spec.from), boxes.get(spec.to));
    if (!route) {
      violations.push({
        rule: "connector",
        message: `Connector '${spec.id}' references unknown node(s): ${!boxes.has(spec.from) ? spec.from : ""}${!boxes.has(spec.from) && !boxes.has(spec.to) ? " and " : ""}${!boxes.has(spec.to) ? spec.to : ""}. Draw the nodes before connecting them.`,
      });
      continue;
    }

    let normalized;
    try {
      normalized = normalizePath(route.path);
    } catch (error) {
      violations.push({ rule: "connector", message: `Connector '${spec.id}' produced unusable geometry: ${(error as Error).message}` });
      continue;
    }

    operations.push(
      op({
        type: "createVector",
        id: spec.id,
        // Connectors attach to the root frame so they can span regions.
        parent,
        name: route.summary,
        x: normalized.x,
        y: normalized.y,
        width: normalized.width,
        height: normalized.height,
        path: normalized.path,
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
      labels.push({ id: `${spec.id}-label`, text: spec.label, x: route.labelAt.x, y: route.labelAt.y, weight: spec.strokeWeight, parent });
    }
  }

  // Labels are emitted after the lines so they sit on top of them in z-order.
  for (const label of labels) {
operations.push(
        op({
          type: "createText",
          id: label.id,
          parent: label.parent,
          name: `Label ${label.text.slice(0, 24)}`,
          x: label.x + 6,
          y: label.y - 14,
          content: label.text,
        fontSize: Math.round(11 * typeScale),
        weight: 600,
        family: "JetBrains Mono",
        fill: "#5A5C54",
      }),
    );
  }
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
}): string | undefined {
  const { ir, region, content, inner, gap, operations, composition, algorithms, boxes, typeScale, titleScale, look } = args;
  const grid = ir.canvas.grid;

  const textItems = content.filter((c) => c.kind === "text");
  const graphics = content.filter((c) => c.kind === "shape" || c.kind === "vector");
  const components = content.filter((c) => c.kind === "component");
  const connectors = content.filter((c) => c.kind === "connector");
  const drawable = [...textItems, ...graphics, ...components];

  if (drawable.length === 0) return undefined;

  // Metric cards are a grid; a topology map is a single centred graphic;
  // everything else is a vertical flow. Choosing per-composition is what stops
  // every screen looking like the same card wall.
  const columns = region.columns ?? (composition === "instrument" || composition === "table" ? 3 : 1);
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
  type GraphItem = Extract<ContentSpec, { kind: "shape" | "vector" | "component" }>;
  const graphItems: GraphItem[] = [...(graphics as GraphItem[]), ...graphDevices];
  const deviceSize = { w: grid * 16, h: grid * 10 };

  if (graphItems.length > 0 && graphicAlgorithm) {
    const algorithm = graphicAlgorithm === "force" ? "forceGraph" : graphicAlgorithm;
    algorithms[region.id] = algorithm;

    const nodes = graphItems.map((c, i) => ({ id: c.id, order: i }));
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
            bounds: { x: inner.x, y: inner.y, w: inner.w, h: inner.h },
            gap,
            levelGap: gap * 2,
            columns,
          }).points;

    const size = graphicSize(grid);
    for (const spec of graphItems) {
      const at = points.get(spec.id);
      if (!at) continue;
      // A device keeps its natural machine-tile size; abstract graphics share
      // one small square so dots and rings read as one system.
      const extent = spec.kind === "component" ? deviceSize : size;
      const box: ResolvedBox = {
        x: Math.round(at.x - extent.w / 2),
        y: Math.round(at.y - extent.h / 2),
        w: extent.w,
        h: extent.h,
      };
      // The recorded box and the drawn node share one optically-corrected box,
      // so connectors, relations and the returned geometry all agree.
      const placed: ResolvedBox = devicePlacementBox(box, spec);
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
        // the flat-edged tiles around them.
        const box: ResolvedBox = overshoot({ x: at.x - grid * 2, y: at.y - grid * 2, w: grid * 4, h: grid * 4 });
        boxes.set(spec.id, { id: spec.id, ...box });
        emitGraphic(spec, region, box, operations);
      }
    } else {
      const placed = packContent({
        region: inner,
        items: graphics.map((c) => ({ id: c.id, height: grid * 6 })),
        gap,
        columns,
      });

      for (const spec of graphics) {
        const box = placed.get(spec.id);
        if (!box) continue;
        const resolved: ResolvedBox = { ...box, h: grid * 6 };
        boxes.set(spec.id, { id: spec.id, ...resolved });
        emitGraphic(spec, region, resolved, operations);
      }
    }
  }

  /* --- text and components flow ------------------------------------------ */

  // Devices already placed by a graph algorithm must not flow as well, or every
  // machine would be drawn twice: once on the graph, once in a column.
  const placedIds = new Set(graphDevices.map((c) => c.id));
  const flow = [...textItems, ...components.filter((c) => !placedIds.has(c.id))];
  if (flow.length > 0) {
    if (requested === "grid") algorithms[region.id] = "grid";
    else if (requested === "masonry") algorithms[region.id] = "masonry";
    else if (!algorithms[region.id]) algorithms[region.id] = "flow";

    const flowColumns = requested === "masonry" ? columns : columns;

    if (requested === "masonry") {
      const points = runAlgorithm(
        "masonry",
        flow.map((c, i) => ({ id: c.id, order: i, height: estimateHeight(c, inner.w, typeScale, titleScale) })),
        [],
        { bounds: inner, gap, columns: flowColumns },
      ).points;

      for (const spec of flow) {
        const at = points.get(spec.id);
        if (!at) continue;
        const w = (inner.w - gap * (flowColumns - 1)) / flowColumns;
        const box: ResolvedBox = devicePlacementBox({ x: at.x, y: at.y, w, h: estimateHeight(spec, w, typeScale, titleScale) }, spec);
        boxes.set(spec.id, { id: spec.id, ...box });
        if (spec.kind === "text") emitText(spec, region, box, operations, typeScale, titleScale, look);
        else emitComponent(spec, region, box, operations, grid, typeScale, look);
      }
    } else {
      const placed = packContent({
        region: inner,
        items: flow.map((c) => ({ id: c.id, height: estimateHeight(c, inner.w, typeScale, titleScale) })),
        gap,
        columns: flowColumns,
      });

      for (const spec of flow) {
        const box = placed.get(spec.id);
        if (!box) continue;
        const final: ResolvedBox = devicePlacementBox(box, spec);
        boxes.set(spec.id, { id: spec.id, ...final });
        if (spec.kind === "text") emitText(spec, region, final, operations, typeScale, titleScale, look);
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

function emitText(
  spec: Extract<ContentSpec, { kind: "text" }>,
  region: ResolvedRegion,
  box: ResolvedBox,
  operations: Operation[],
  typeScale = 1,
  titleScale = 1,
  look: StyleLook = DEFAULT_LOOK,
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
      fontSize: Math.round((spec.size ?? scale.size) * typeScale * display),
      ...(spec.letterSpacing !== undefined ? { letterSpacing: spec.letterSpacing } : {}),
      ...(spec.fill !== undefined ? { fill: resolveToken(spec.fill) } : {}),
      width: Math.max(40, Math.round(spec.maxWidth ?? box.w)),
    }),
  );
}

function emitGraphic(spec: Extract<ContentSpec, { kind: "shape" | "vector" }>, region: ResolvedRegion, box: ResolvedBox, operations: Operation[]): void {
  // Polygons and stars are computed, not hand-drawn: the path builders in
  // marks.ts own the vertex math, and the result flows through the same vector
  // pipeline as a hand-written path.
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
      const tone = toneFor(p.tone ?? p.state ?? p.color);
      const label = str("label", "Status");
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: label,
          x: box.x,
          y: box.y,
          width: hugWidth(label, { fontSize: Math.round(11 * typeScale), paddingX: grid }),
          height: 22,
          fill: p.surface !== undefined ? str("surface", tone.bg) : tone.bg,
          cornerRadius: grid,
          padding: { top: 2, right: grid, bottom: 2, left: grid },
          layoutMode: "HORIZONTAL",
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Label", content: label, fontSize: fs(11), weight: 500, fill: tone.fg }));
      break;
    }

    case "deviceNode": {
      // Health is a stroke, selection is a heavier stroke in action blue.
      // Selection wins over health: the thing the user is looking at must be
      // unambiguous even when it is also degraded.
      const selected = p.selected === true;
      const stroke = selected ? "#0D99FF" : (healthStroke(p.health) ?? "#E0E0E0");
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: str("label", "Device"),
          x: box.x,
          y: box.y,
          width: grid * 16,
          height: grid * 10,
          fill: str("surface", "#FFFFFF"),
          stroke,
          strokeWeight: selected ? 3 : 1,
          radius: grid,
          layoutMode: "VERTICAL",
          padding: grid,
          itemSpacing: 4,
          ...(p.health === "offline" ? { opacity: 0.7 } : {}),
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Device", content: str("label", "Device"), fontSize: fs(12), weight: 600, fill: "#242521" }));
      if (str("memory")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Memory", content: str("memory"), fontSize: fs(10), family: "JetBrains Mono", fill: "#6F716A" }));
      }
      // Compute capability and shard assignment ride as caption lines: they are
      // facts about the machine, and facts belong with the machine, not in a
      // tooltip the user never opens.
      if (str("compute")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Compute", content: str("compute"), fontSize: fs(10), family: "JetBrains Mono", fill: "#6F716A" }));
      }
      if (str("shard")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Shard", content: `shard ${str("shard")}`, fontSize: fs(10), weight: 500, fill: "#0B6BCB" }));
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
          width: hugWidth(displayLabel, { fontSize: Math.round(14 * typeScale), paddingX: grid * 1.5 }),
          height: 36,
          fill: active ? "#F2C94C" : str("surface", "transparent"),
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
          fill: active ? "#242521" : str("color", "#6F716A"),
        }),
      );
      break;
    }

    case "divider": {
      operations.push(
        op({
          type: "createRectangle",
          id: spec.id,
          parent: parentHint,
          name: "Divider",
          x: box.x,
          y: box.y,
          width: Math.max(1, Math.round(box.w)),
          height: 1,
          fill: str("color", "#E0E0E0"),
        }),
      );
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
      };
      const look = looks[variant] ?? looks.primary!;
      const label = str("label", "Continue") + (look.suffix ?? "");
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: label,
          x: box.x,
          y: box.y,
          width: hugWidth(label, { fontSize: Math.round(13 * typeScale), paddingX: grid * 2 }),
          height: 40,
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
        operations.push(
          op({ type: "createText", parent: spec.id, name: "Action", x: Math.round(box.x + box.w - w), y: box.y + 4, content: action, fontSize: fs(12), weight: 500, fill: "#0B6BCB" }),
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
      operations.push(op({ type: "createText", parent: parentHint, name: "Section", content: str("title", str("label", "Section")).toUpperCase(), fontSize: fs(11), weight: 600, letterSpacing: 2, fill: "#6F716A" }));
      operations.push(
        op({
          type: "createRectangle",
          parent: parentHint,
          name: "Rule",
          width: Math.max(80, Math.round(box.w)),
          height: 1,
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
      // facts, one line each, no nested frames to maintain.
      const tone = toneFor(p.status);
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
          name: str("label", "Memory"),
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
      operations.push(
        op({ type: "createRectangle", parent: spec.id, name: "Track", x: box.x, y: box.y, width: barW, height: 8, fill: "#E8E6DF", cornerRadius: 4 }),
      );
      if (ratio > 0) {
        operations.push(
          op({
            type: "createRectangle",
            parent: spec.id,
            name: "Fill",
            x: box.x,
            y: box.y,
            width: Math.max(8, Math.round(barW * ratio)),
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
          content: `${str("usedLabel", String(used))} / ${str("totalLabel", String(total))}${str("unit", " GB")} used`,
          fontSize: fs(12),
          family: "JetBrains Mono",
          fill: tone.fg,
        }),
      );
      break;
    }

    case "fitGauge": {
      // A verdict pill: fits or does not fit, with the numbers that justify it.
      const fits = p.fits !== false;
      const tone = fits ? TONES.success! : TONES.error!;
      const label = str("label", fits ? "Fits" : "Does not fit");
      operations.push(
        op({
          type: "createFrame",
          id: spec.id,
          parent: parentHint,
          name: label,
          x: box.x,
          y: box.y,
          width: hugWidth(label, { fontSize: Math.round(13 * typeScale), paddingX: grid * 2 }),
          height: 40,
          fill: tone.bg,
          stroke: tone.fg,
          strokeWeight: 1,
          radius: grid,
          padding: { top: grid, right: grid * 2, bottom: grid, left: grid * 2 },
          layoutMode: "HORIZONTAL",
        }),
      );
      operations.push(op({ type: "createText", parent: spec.id, name: "Verdict", content: label, fontSize: fs(13), weight: 600, fill: tone.fg }));
      if (str("detail")) {
        operations.push(op({ type: "createText", parent: spec.id, name: "Detail", content: str("detail"), fontSize: fs(11), family: "JetBrains Mono", fill: tone.fg }));
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
      const surface = p.surface !== undefined ? str("surface", "transparent") : "#FBFAF6";
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
/* Constraints                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Product constraints from spec §29 / §51, checked rather than trusted.
 *
 * These are reported, not silently enforced: the model is told it drifted and
 * gets the chance to decide whether the constraint still applies.
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
 */
function patchEmit(operations: Operation[], id: string, patch: { x: number; y: number; width: number; height: number }): void {
  for (let i = operations.length - 1; i >= 0; i--) {
    const candidate = operations[i] as { type?: string; id?: string } & Record<string, unknown>;
    if (candidate.id !== id) continue;
    if (candidate.type !== "createFrame" && candidate.type !== "createRectangle" && candidate.type !== "createEllipse") continue;
    candidate.x = patch.x;
    candidate.y = patch.y;
    candidate.width = patch.width;
    candidate.height = patch.height;
    return;
  }
}

/**
 * Re-emits a region's text after a relation resized it.
 *
 * Text inside an auto-layout frame follows its container in Figma, but text
 * placed by absolute coordinates does not. This walks each region's text nodes
 * and nudges them by the region's delta so a `width: "fill"` hero does not leave
 * its headline stranded at the old x.
 *
 * Only the delta is applied. Re-flowing would require the plugin's measured
 * text metrics, which the server does not have; shifting by the delta is exact
 * and does not need them.
 */
function relayoutRegionText(args: {
  ir: DesignIR;
  regions: ResolvedRegion[];
  boxes: Map<string, PlacedBox>;
  operations: Operation[];
  violations: CompileResult["violations"];
}): number {
  const { ir, regions, boxes, operations } = args;
  let shifted = 0;

  for (const region of regions) {
    const textNodes = ir.content.filter((c) => c.kind === "text" && region.children.includes(c.id));
    for (const node of textNodes) {
      const box = boxes.get(node.id);
      if (!box) continue;

      // Re-pack the region's text from scratch: cheap, and correct even when the
      // resize changed how many lines a headline needs.
      const pad = normalizePadding(region.padding, ir.canvas.grid);
      const inner: ResolvedBox = {
        x: region.x + pad.left,
        y: region.y + pad.top,
        w: Math.max(0, region.w - pad.left - pad.right),
        h: Math.max(0, region.h - pad.top - pad.bottom),
      };
      const gap = region.gap ?? ir.canvas.grid;
      const columnWidth = inner.w;
      const target: ResolvedBox = { x: inner.x, y: inner.y, w: columnWidth, h: estimateHeight(node, columnWidth) };

      if (Math.abs(target.y - box.y) > 0.5 || Math.abs(target.x - box.x) > 0.5) {
        patchPosition(operations, node.id, target.x, target.y);
        shifted += 1;
      }
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
    if (candidate.type !== "createText" && candidate.type !== "createFrame" && candidate.type !== "createRectangle" && candidate.type !== "createEllipse") continue;
    candidate.x = Math.round(x);
    candidate.y = Math.round(y);
    return;
  }
}

/**
 * Estimates the width of a hug-sized pill, button or nav item.
 *
 * Figma has no shrink-to-content sizing for frames, so a compact auto-width
 * component has to be measured up front. Deliberately generous — a slightly
 * wide pill looks intentional, a clipped one looks broken.
 */
function hugWidth(text: string, { fontSize, paddingX }: { fontSize: number; paddingX: number }): number {
  const charWidth = fontSize * 0.56;
  return Math.ceil(Math.max(1, text.length) * charWidth + paddingX * 2);
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
function estimateHeight(spec: ContentSpec, width: number, typeScale = 1, titleScale = 1): number {
  if (spec.kind !== "text") {
    if (spec.kind === "component" && spec.type === "topologyMap") return Math.round(320 * typeScale);
    return spec.kind === "component" ? Math.round(90 * typeScale) : 32;
  }

  const scale = TYPE_SCALE[spec.role] ?? TYPE_SCALE.body!;
  const display = spec.role === "title" || spec.role === "eyebrow" ? titleScale : 1;
  const size = (spec.size ?? scale.size) * typeScale * display;
  const usable = Math.max(40, spec.maxWidth ?? width);
  const charsPerLine = Math.max(8, Math.floor(usable / (size * 0.55)));
  const lines = Math.max(1, Math.ceil(spec.text.length / charsPerLine));
  return Math.round(lines * size * 1.4 + 4);
}

function humanize(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}