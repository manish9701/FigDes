/**
 * Plan-to-build fidelity scorer — the First-Pass Quality Contract gate.
 *
 * The contract: on every change, the matrix (consumer + enterprise screens ×
 * layout types × connectors × overflow × spacing × typography × a11y ×
 * plan-to-build fidelity) must hold. This module is the plan-to-build-fidelity
 * axis made deterministic and offline: given a plan (composition, regions,
 * product rules) plus a compiled program (operations, resolved boxes,
 * connector routes, violations), it scores whether the intended composition
 * was applied, every planned region exists with resolved geometry, connectors
 * match the planned links, and tokens/typography are bound.
 *
 * Scoring: eight signals with weights summing to 100. The verdict is PASS only
 * when the score clears the acceptance floor AND every hard gate holds
 * (composition applied, no missing regions, no dropped connectors, no
 * placeholders, type ≥ 11px, contrast passes, no overflow). Unknowns are
 * listed in `notVerified` and never zeroed — except a build that carries no
 * composition evidence at all, which fails honestly: a composition that
 * cannot be verified was not applied.
 *
 * Proportions: suite.ts's semantic-fidelity diagnostic (0–10, five signals)
 * asks whether the emitted Figma structure *means* what was built. This
 * scorer asks the earlier question: whether the build *is* what was planned.
 * Both are diagnostics reported alongside totals, never folded into them.
 */

export const FIDELITY_SCHEMA = "figdes-plan-fidelity-v1";
export const FIDELITY_VERSION = "fidelity-v1";

/** The type-and-space skill's floor: nothing measurable renders below it. */
export const MIN_TYPE_PX = 11;
/** WCAG AA floors, shared with the accessibility evaluator. */
export const CONTRAST_MIN_NORMAL = 4.5;
export const CONTRAST_MIN_LARGE = 3;
/** A screen below this score is not first-pass quality, whatever passed. */
export const FIDELITY_PASS_SCORE = 80;

export type FidelitySignalName =
  | "composition"
  | "regions"
  | "geometry"
  | "connectors"
  | "tokens"
  | "typography"
  | "spacing"
  | "contrast";

/** Weights sum to 100: the fidelity score reads as a percentage. */
export const FIDELITY_WEIGHTS: Record<FidelitySignalName, number> = {
  composition: 15,
  regions: 15,
  geometry: 15,
  connectors: 15,
  tokens: 10,
  typography: 10,
  spacing: 10,
  contrast: 10,
};

/** The contract's acceptance thresholds, in one auditable place. */
export const FIDELITY_ACCEPTANCE = {
  schema: FIDELITY_SCHEMA,
  version: FIDELITY_VERSION,
  minScore: FIDELITY_PASS_SCORE,
  minTypePx: MIN_TYPE_PX,
  minContrastNormal: CONTRAST_MIN_NORMAL,
  minContrastLarge: CONTRAST_MIN_LARGE,
  /** Sibling regions share one gap value; a second value breaks the rhythm. */
  maxDistinctGaps: 1,
  weights: { ...FIDELITY_WEIGHTS },
} as const;

export interface FidelityPlannedRegion {
  id: string;
  composition?: string;
  role?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  gap?: number;
}

export interface FidelityPlannedLink {
  from: string;
  to: string;
  id?: string;
  label?: string;
}

export interface FidelityPlan {
  composition?: string;
  regions: FidelityPlannedRegion[];
  links?: FidelityPlannedLink[];
  productRules?: string[];
  canvas?: { width: number; height: number };
}

export interface FidelityBuiltRegion {
  id: string;
  composition?: string;
  gap?: number;
}

/**
 * A measured text pair supplied by the caller (e.g. contrast measured
 * against the composited background). Authoritative when present; the
 * scorer otherwise derives pairs from fills and parent frames.
 */
export interface FidelityMeasuredText {
  id: string;
  size?: number;
  contrastRatio?: number | null;
  content?: string;
  /** Large text (≥24px, or bold ≥19px) clears 3:1 instead of 4.5:1. */
  large?: boolean;
  /** A documented exception on the node itself (issue #23 §4). */
  exempt?: boolean;
}

export interface FidelityBuild {
  operations: Array<Record<string, unknown>>;
  /** Overall compiled composition, when the caller computed one. */
  composition?: string | null;
  /** Built regions (e.g. from the compiled IR): id, composition and gap. */
  regions?: FidelityBuiltRegion[];
  /** Per-region compiled compositions, keyed by region id. */
  regionCompositions?: Record<string, string>;
  /** Resolved geometry: a Map, an [{id,x,y,w,h}] list, or an {id: box} record. */
  boxes?: unknown;
  /** Routed connectors with resolved endpoints, when the compiler returned them. */
  connectorRoutes?: Array<{ id?: string; from?: string; to?: string }>;
  /** Compiler / guard violations on the built program. */
  violations?: Array<{ rule?: string; message?: string }>;
  /** Caller-measured text pairs; authoritative for contrast. */
  texts?: FidelityMeasuredText[];
  canvas?: { width: number; height: number };
}

export interface FidelityResult {
  schema: typeof FIDELITY_SCHEMA;
  /** 0–100 across the eight weighted signals. */
  score: number;
  signals: Record<FidelitySignalName, number>;
  verdict: "PASS" | "FAIL";
  /** Every reason the verdict is FAIL. Empty if and only if verdict is PASS. */
  failures: string[];
  missingRegions: string[];
  droppedConnectors: string[];
  placeholderNodes: string[];
  subFloorTexts: string[];
  contrastFailures: string[];
  evidence: string[];
  /** What the offline evidence could not evaluate. Reported, never zeroed. */
  notVerified: string[];
}

export interface FidelityAcceptance {
  ok: boolean;
  failures: string[];
}

/** The acceptance verdict, naming every threshold breach. */
export function meetsAcceptance(result: FidelityResult): FidelityAcceptance {
  return { ok: result.verdict === "PASS", failures: [...result.failures] };
}

/* -------------------------------------------------------------------------- */
/* Reading loose build shapes                                                  */
/* -------------------------------------------------------------------------- */

/** Compiled ops carry fields top-level; interpreted traces nest them under args. */
function readField(op: Record<string, unknown>, key: string): unknown {
  if (op[key] !== undefined) return op[key];
  const args = op["args"];
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return (args as Record<string, unknown>)[key];
  }
  return undefined;
}

function readString(op: Record<string, unknown>, key: string): string | undefined {
  const v = readField(op, key);
  return typeof v === "string" ? v : undefined;
}

function readNumber(op: Record<string, unknown>, key: string): number | undefined {
  const v = readField(op, key);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function toBox(v: unknown): Box | null {
  if (v === null || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const x = typeof r["x"] === "number" ? r["x"] : 0;
  const y = typeof r["y"] === "number" ? r["y"] : 0;
  const w = typeof r["w"] === "number" ? r["w"] : typeof r["width"] === "number" ? r["width"] : NaN;
  const h = typeof r["h"] === "number" ? r["h"] : typeof r["height"] === "number" ? r["height"] : NaN;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { x, y, w, h };
}

/** Accepts a Map, a [{id|name, x, y, w|width, h|height}] list, or an {id: box} record. */
function normalizeBoxes(boxes: unknown): Map<string, Box> {
  const out = new Map<string, Box>();
  if (boxes === null || boxes === undefined) return out;
  const put = (id: string, v: unknown): void => {
    const b = toBox(v);
    if (id.length > 0 && b !== null) out.set(id, b);
  };
  if (typeof (boxes as { get?: unknown }).get === "function" && typeof (boxes as Map<string, unknown>).keys === "function") {
    for (const [k, v] of (boxes as Map<string, unknown>).entries()) put(String(k), v);
    return out;
  }
  if (Array.isArray(boxes)) {
    for (const entry of boxes) {
      if (entry === null || typeof entry !== "object") continue;
      const r = entry as Record<string, unknown>;
      const id = typeof r["id"] === "string" ? r["id"] : typeof r["name"] === "string" ? r["name"] : "";
      put(id, entry);
    }
    return out;
  }
  if (typeof boxes === "object") {
    for (const [k, v] of Object.entries(boxes as Record<string, unknown>)) put(k, v);
  }
  return out;
}

/** A documented exception on the node itself (issue #23 §4): only a stated reason counts. */
function readExceptionReason(op: Record<string, unknown>): string {
  const v = readField(op, "exception");
  if (typeof v === "string") return v.trim();
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const reason = (v as Record<string, unknown>)["reason"];
    if (typeof reason === "string") return reason.trim();
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* Contrast, offline: hex pairs against the composited background               */
/* -------------------------------------------------------------------------- */

function parseHex(value: string): [number, number, number] | null {
  const m = value.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function luminance(rgb: [number, number, number]): number {
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** WCAG contrast ratio for two hex colours; null when either is not a hex literal. */
export function contrastRatio(fg: string, bg: string): number | null {
  const f = parseHex(fg);
  const b = parseHex(bg);
  if (!f || !b) return null;
  const lf = luminance(f);
  const lb = luminance(b);
  const hi = Math.max(lf, lb);
  const lo = Math.min(lf, lb);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* Filler copy that must never reach a first-pass screen. */
const PLACEHOLDER_RE = /\b(lorem ipsum|todo|fixme\b|tbd\b|placeholder|untitled|sample text|xxx+|asdf+)\b/i;

const GEOMETRY_RULES = new Set(["geometry", "containment", "overflow"]);
const TOKEN_DEFINING = new Set(["createVariable", "createPaintStyle", "createTextStyle", "bindVariable"]);

function sameComp(a: string | undefined, b: string | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Scores plan-to-build fidelity. Deterministic, offline, dependency-free:
 * the same plan and build always produce the same result.
 */
export function scorePlanToBuildFidelity(plan: FidelityPlan, build: FidelityBuild): FidelityResult {
  const evidence: string[] = [];
  const notVerified: string[] = [];
  const failures: string[] = [];
  const missingRegions: string[] = [];
  const droppedConnectors: string[] = [];
  const placeholderNodes: string[] = [];
  const subFloorTexts: string[] = [];
  const contrastFailures: string[] = [];
  const signals: Record<FidelitySignalName, number> = {
    composition: 0, regions: 0, geometry: 0, connectors: 0,
    tokens: 0, typography: 0, spacing: 0, contrast: 0,
  };

  const ops = Array.isArray(build.operations) ? build.operations : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const op of ops) {
    const id = typeof op["id"] === "string" ? (op["id"] as string) : undefined;
    if (id !== undefined && !byId.has(id)) byId.set(id, op);
  }
  const violations = Array.isArray(build.violations) ? build.violations : [];
  const boxes = normalizeBoxes(build.boxes);
  const canvas = build.canvas ?? plan.canvas ?? null;
  const regions = Array.isArray(plan.regions) ? plan.regions : [];
  const links = Array.isArray(plan.links) ? plan.links : [];

  const isFrame = (op: Record<string, unknown>): boolean =>
    op["type"] === "createFrame" || op["type"] === "createSlide";

  const frameFor = (id: string): Record<string, unknown> | undefined => {
    const op = byId.get(id);
    return op !== undefined && isFrame(op) ? op : undefined;
  };

  const resolvedBox = (id: string): Box | null => {
    const b = boxes.get(id);
    if (b) return b;
    const frame = frameFor(id);
    if (!frame) return null;
    const x = readNumber(frame, "x") ?? 0;
    const y = readNumber(frame, "y") ?? 0;
    const w = readNumber(frame, "width") ?? readNumber(frame, "w");
    const h = readNumber(frame, "height") ?? readNumber(frame, "h");
    if (w === undefined || h === undefined) return null;
    return { x, y, w, h };
  };

  /* --- composition: the intended composition was applied ------------------- */
  const regionComp: Record<string, string> = { ...(build.regionCompositions ?? {}) };
  for (const r of build.regions ?? []) {
    if (typeof r.composition === "string" && regionComp[r.id] === undefined) regionComp[r.id] = r.composition;
  }
  const comparable = regions.filter((r) => typeof r.composition === "string" && r.composition.length > 0);
  const plannedComp = typeof plan.composition === "string" && plan.composition.length > 0 ? plan.composition : undefined;
  const builtComp = typeof build.composition === "string" && build.composition.length > 0 ? build.composition : undefined;
  const hasRegionCompData = comparable.length > 0 && Object.keys(regionComp).length > 0;
  if (plannedComp !== undefined && builtComp !== undefined) {
    if (sameComp(plannedComp, builtComp)) {
      const matched = hasRegionCompData
        ? comparable.filter((r) => sameComp(r.composition, regionComp[r.id])).length
        : comparable.length;
      signals.composition = hasRegionCompData ? Math.round((matched / comparable.length) * FIDELITY_WEIGHTS.composition * 10) / 10 : FIDELITY_WEIGHTS.composition;
      for (const r of comparable) {
        if (!sameComp(r.composition, regionComp[r.id])) {
          failures.push(`composition drift in '${r.id}': planned '${r.composition}', built '${regionComp[r.id] ?? "unknown"}'`);
        }
      }
      evidence.push(
        hasRegionCompData
          ? `composition: overall '${plannedComp}' applied; ${matched}/${comparable.length} regions keep their planned composition`
          : `composition: overall '${plannedComp}' applied`,
      );
    } else {
      signals.composition = 0;
      failures.push(`composition drift: planned '${plannedComp}', built '${builtComp}'`);
      evidence.push(`composition: planned '${plannedComp}' but the build resolved '${builtComp}'`);
    }
  } else if (hasRegionCompData) {
    const matched = comparable.filter((r) => sameComp(r.composition, regionComp[r.id])).length;
    signals.composition = Math.round((matched / comparable.length) * FIDELITY_WEIGHTS.composition * 10) / 10;
    for (const r of comparable) {
      if (!sameComp(r.composition, regionComp[r.id])) {
        failures.push(`composition drift in '${r.id}': planned '${r.composition}', built '${regionComp[r.id] ?? "unknown"}'`);
      }
    }
    evidence.push(`composition: ${matched}/${comparable.length} regions keep their planned composition`);
  } else {
    signals.composition = 0;
    failures.push("no compiled composition evidence: the build carries no overall or per-region composition to verify against the plan");
    evidence.push("composition: nothing to verify against — the build carries no composition evidence");
  }

  /* --- regions: every planned region exists with resolved geometry ---------- */
  if (regions.length === 0) {
    failures.push("the plan names no regions: there is nothing to verify the build against");
    evidence.push("regions: the plan names no regions");
  } else {
    let present = 0;
    for (const r of regions) {
      const box = resolvedBox(r.id);
      if (frameFor(r.id) !== undefined && box !== null && box.w > 0 && box.h > 0) {
        present += 1;
      } else {
        missingRegions.push(r.id);
        failures.push(`planned region '${r.id}' has no compiled frame with resolved geometry`);
      }
    }
    signals.regions = Math.round((present / regions.length) * FIDELITY_WEIGHTS.regions * 10) / 10;
    evidence.push(`regions: ${present}/${regions.length} planned regions exist with resolved geometry`);
  }

  /* --- geometry: resolved boxes are real and on-canvas; no overflow --------- */
  {
    let clean = 0;
    for (const r of regions) {
      const box = resolvedBox(r.id);
      if (box === null || box.w <= 0 || box.h <= 0) continue;
      if (canvas !== null) {
        const inside =
          box.x >= -1 && box.y >= -1 && box.x + box.w <= canvas.width + 1 && box.y + box.h <= canvas.height + 1;
        if (!inside) {
          failures.push(
            `region '${r.id}' spills past the canvas (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)} on ${canvas.width}x${canvas.height})`,
          );
          continue;
        }
      }
      clean += 1;
    }
    if (canvas === null && regions.length > 0) {
      notVerified.push("canvas bounds unknown: spill checks skipped (supply plan.canvas or build.canvas)");
    }
    const blocking = violations.filter((v) => GEOMETRY_RULES.has(String(v.rule ?? "")));
    for (const v of blocking) {
      failures.push(`build reports ${v.rule}: ${(v.message ?? "").slice(0, 160)}`);
    }
    const base = regions.length > 0 ? (clean / regions.length) * FIDELITY_WEIGHTS.geometry : 0;
    signals.geometry = Math.round(Math.max(0, base - Math.min(base, blocking.length * 5)) * 10) / 10;
    evidence.push(
      regions.length > 0
        ? `geometry: ${clean}/${regions.length} regions resolve on-canvas${blocking.length > 0 ? `; ${blocking.length} blocking geometry violation(s)` : "; no blocking geometry violations"}`
        : "geometry: no planned regions to verify",
    );
  }

  /* --- connectors: planned links are routed and attached -------------------- */
  {
    const builtPairs = new Map<string, string>();
    for (const route of build.connectorRoutes ?? []) {
      if (typeof route.from === "string" && typeof route.to === "string") {
        builtPairs.set(`${route.from}→${route.to}`, typeof route.id === "string" ? route.id : `${route.from}→${route.to}`);
      }
    }
    for (const op of ops) {
      if (op["type"] !== "createVector" || (op["fillArrows"] as unknown) !== true) continue;
      const from = readString(op, "from");
      const to = readString(op, "to");
      if (from !== undefined && to !== undefined && !builtPairs.has(`${from}→${to}`)) {
        builtPairs.set(`${from}→${to}`, typeof op["id"] === "string" ? (op["id"] as string) : `${from}→${to}`);
      }
    }
    if (links.length === 0) {
      signals.connectors = FIDELITY_WEIGHTS.connectors;
      evidence.push("connectors: no links planned, nothing to verify");
    } else {
      let matched = 0;
      for (const link of links) {
        const id = builtPairs.get(`${link.from}→${link.to}`);
        if (id === undefined) {
          droppedConnectors.push(`${link.from}→${link.to}`);
          failures.push(`planned link '${link.from}→${link.to}' has no routed connector in the build`);
          continue;
        }
        const unattaching = violations.find(
          (v) => v.rule === "connector" && typeof v.message === "string" && v.message.includes(`'${id}'`),
        );
        if (unattaching !== undefined) {
          droppedConnectors.push(`${link.from}→${link.to}`);
          failures.push(`connector '${id}' for planned link '${link.from}→${link.to}' is not attached: ${(unattaching.message ?? "").slice(0, 160)}`);
          continue;
        }
        matched += 1;
      }
      signals.connectors = Math.round((matched / links.length) * FIDELITY_WEIGHTS.connectors * 10) / 10;
      evidence.push(`connectors: ${matched}/${links.length} planned links are routed and attached`);
    }
  }

  /* --- tokens: declared variables are bound, not duplicated as hex ---------- */
  {
    const declaredHex = new Map<string, string>();
    const declaredNames = new Set<string>();
    for (const op of ops) {
      if (op["type"] !== "createVariable") continue;
      const name = readString(op, "name");
      const variableType = readString(op, "variableType");
      if (name === undefined) continue;
      if (variableType !== undefined && variableType.toUpperCase() !== "COLOR") continue;
      const values = readField(op, "values");
      if (values === null || typeof values !== "object" || Array.isArray(values)) continue;
      const entries = Object.entries(values as Record<string, unknown>);
      const mode = entries.some(([k]) => k === "default") ? "default" : entries.length === 1 ? entries[0]![0] : undefined;
      if (mode === undefined) continue;
      const value = (values as Record<string, unknown>)[mode];
      if (typeof value !== "string" || parseHex(value) === null) continue;
      declaredNames.add(name);
      const hex = value.trim().toUpperCase();
      if (declaredHex.has(hex)) declaredHex.delete(hex);
      else declaredHex.set(hex, name);
    }
    let bound = 0;
    let unbound = 0;
    let literals = 0;
    for (const op of ops) {
      if (op["type"] !== "bindVariable") {
        if (TOKEN_DEFINING.has(String(op["type"] ?? ""))) continue;
        for (const key of ["fill", "stroke"] as const) {
          const v = readField(op, key);
          if (typeof v !== "string") continue;
          if (v.includes("/") || declaredNames.has(v)) {
            bound += 1;
          } else if (parseHex(v) !== null) {
            const token = declaredHex.get(v.trim().toUpperCase());
            if (token !== undefined) {
              unbound += 1;
              failures.push(`fill '${v}' on '${String(op["id"] ?? op["type"])}' duplicates token '${token}' — bind the variable`);
            } else {
              literals += 1;
            }
          }
        }
        continue;
      }
      bound += 1;
    }
    const judged = bound + unbound;
    if (judged === 0) {
      signals.tokens = FIDELITY_WEIGHTS.tokens;
      evidence.push("tokens: no variables declared and no token references — nothing to verify");
    } else {
      signals.tokens = Math.round((bound / judged) * FIDELITY_WEIGHTS.tokens * 10) / 10;
      evidence.push(`tokens: ${bound}/${judged} fills and strokes resolve to declared variables (${literals} raw literals with no token to prefer)`);
    }
  }

  /* --- typography: every label clears the floor or carries an exception ------ */
  {
    const textOps = ops.filter((op) => op["type"] === "createText");
    if (textOps.length === 0) {
      signals.typography = FIDELITY_WEIGHTS.typography;
      evidence.push("typography: no text nodes to judge");
    } else {
      let ok = 0;
      let judged = 0;
      let boundStyles = 0;
      for (const op of textOps) {
        const id = String(op["id"] ?? readField(op, "id") ?? "text");
        const size = readNumber(op, "fontSize");
        if (size === undefined) {
          notVerified.push(`text '${id}' carries no measurable font size`);
          continue;
        }
        judged += 1;
        if (readString(op, "textStyleId") !== undefined) boundStyles += 1;
        if (size >= MIN_TYPE_PX || readExceptionReason(op).length > 0) {
          ok += 1;
        } else {
          subFloorTexts.push(id);
          failures.push(`text '${id}' renders at ${size}px, below the ${MIN_TYPE_PX}px floor with no documented exception`);
        }
      }
      signals.typography = judged > 0 ? Math.round((ok / judged) * FIDELITY_WEIGHTS.typography * 10) / 10 : FIDELITY_WEIGHTS.typography;
      evidence.push(
        judged > 0
          ? `typography: ${ok}/${judged} text nodes at or above ${MIN_TYPE_PX}px (or documented exceptions)${boundStyles > 0 ? `; ${boundStyles} bound to text styles` : ""}`
          : "typography: no measurable text nodes",
      );
    }
  }

  /* --- placeholders: filler copy never ships -------------------------------- */
  {
    for (const op of ops) {
      if (op["type"] !== "createText") continue;
      const id = String(op["id"] ?? "text");
      const content = readString(op, "content") ?? "";
      if (content.trim().length === 0 || PLACEHOLDER_RE.test(content)) {
        placeholderNodes.push(id);
        failures.push(`text '${id}' carries placeholder copy: "${content.slice(0, 60)}"`);
      }
    }
    if (placeholderNodes.length === 0) {
      evidence.push("placeholders: no filler copy in the build");
    }
  }

  /* --- spacing: one rhythm across the built regions -------------------------- */
  {
    const gaps = (build.regions ?? [])
      .map((r) => r.gap)
      .filter((g): g is number => typeof g === "number" && Number.isFinite(g) && g > 0);
    const distinct = [...new Set(gaps)].sort((a, b) => a - b);
    if (gaps.length < 2) {
      signals.spacing = FIDELITY_WEIGHTS.spacing;
      evidence.push("spacing: fewer than two built regions carry a gap — nothing to judge");
      if ((build.regions ?? []).length > 0 && gaps.length === 0) {
        notVerified.push("no built region gaps supplied: the spacing rhythm is unverified");
      }
    } else if (distinct.length === 1) {
      signals.spacing = FIDELITY_WEIGHTS.spacing;
      evidence.push(`spacing: one rhythm across ${gaps.length} built regions (${distinct[0]}px)`);
    } else if (distinct.length === 2) {
      signals.spacing = 4;
      failures.push(`two sibling-region gaps on one screen: ${distinct.join("px and ")}px — the spacing rhythm is broken`);
      evidence.push(`spacing: two distinct gaps (${distinct.join(", ")}px) across ${gaps.length} built regions`);
    } else {
      signals.spacing = 0;
      failures.push(`${distinct.length} different sibling-region gaps (${distinct.join(", ")}px): the spacing rhythm has collapsed`);
      evidence.push(`spacing: ${distinct.length} distinct gaps across ${gaps.length} built regions`);
    }
  }

  /* --- contrast: every measurable pair clears its floor ---------------------- */
  {
    const explicit = new Map<string, FidelityMeasuredText>();
    for (const t of build.texts ?? []) explicit.set(t.id, t);
    let pass = 0;
    let measured = 0;
    for (const op of ops) {
      if (op["type"] !== "createText") continue;
      const id = String(op["id"] ?? "text");
      const over = explicit.get(id);
      if (over?.exempt === true) {
        measured += 1;
        pass += 1;
        continue;
      }
      if (over !== undefined && typeof over.contrastRatio === "number" && Number.isFinite(over.contrastRatio)) {
        const size = over.size ?? readNumber(op, "fontSize") ?? MIN_TYPE_PX;
        const large = over.large ?? size >= 24;
        const min = large ? CONTRAST_MIN_LARGE : CONTRAST_MIN_NORMAL;
        measured += 1;
        if (over.contrastRatio >= min) {
          pass += 1;
        } else {
          contrastFailures.push(id);
          failures.push(`text '${id}' contrast ${over.contrastRatio.toFixed(2)}:1 below ${min}:1`);
        }
        continue;
      }
      const fill = readString(op, "fill");
      if (fill === undefined || parseHex(fill) === null) {
        if (over === undefined) notVerified.push(`text '${id}' has no resolvable fill for contrast`);
        continue;
      }
      const bg = resolveBackground(op, byId);
      if (bg === null) {
        notVerified.push(`text '${id}' has no resolvable background for contrast`);
        continue;
      }
      const ratio = contrastRatio(fill, bg);
      if (ratio === null) {
        notVerified.push(`text '${id}' fill/background pair is not measurable`);
        continue;
      }
      const size = over?.size ?? readNumber(op, "fontSize") ?? MIN_TYPE_PX;
      const weight = readNumber(op, "weight") ?? 400;
      const large = over?.large ?? (size >= 24 || (weight >= 600 && size >= 19));
      const min = large ? CONTRAST_MIN_LARGE : CONTRAST_MIN_NORMAL;
      measured += 1;
      if (ratio >= min) {
        pass += 1;
      } else {
        contrastFailures.push(id);
        failures.push(`text '${id}' contrast ${ratio.toFixed(2)}:1 below ${min}:1 (${fill} on ${bg})`);
      }
    }
    // Explicit pairs for texts the operations do not carry (measured externally).
    for (const t of explicit.values()) {
      if (byId.has(t.id) || typeof t.contrastRatio !== "number" || !Number.isFinite(t.contrastRatio)) continue;
      const size = t.size ?? MIN_TYPE_PX;
      const min = (t.large ?? size >= 24) ? CONTRAST_MIN_LARGE : CONTRAST_MIN_NORMAL;
      measured += 1;
      if (t.contrastRatio >= min || t.exempt === true) {
        pass += 1;
      } else {
        contrastFailures.push(t.id);
        failures.push(`text '${t.id}' contrast ${t.contrastRatio.toFixed(2)}:1 below ${min}:1`);
      }
    }
    if (measured === 0) {
      signals.contrast = FIDELITY_WEIGHTS.contrast;
      evidence.push("contrast: no measurable text/background pairs — nothing to verify");
    } else {
      signals.contrast = Math.round((pass / measured) * FIDELITY_WEIGHTS.contrast * 10) / 10;
      evidence.push(`contrast: ${pass}/${measured} measurable pairs clear their floor (4.5:1, 3:1 large)`);
    }
  }

  /* --- product rules: a contradiction with the plan is blocking --------------- */
  for (const v of violations) {
    if (v.rule === "product") {
      failures.push(`build contradicts a product rule: ${(v.message ?? "").slice(0, 160)}`);
    }
  }
  if (plan.productRules !== undefined && plan.productRules.length > 0) {
    const productHits = violations.filter((v) => v.rule === "product").length;
    if (productHits === 0) {
      evidence.push(`product rules: ${plan.productRules.length} stated rule(s), no contradictions in the build`);
    }
  }

  /* --- verdict -------------------------------------------------------------- */
  // Placeholders are a hard gate, not a gradient: the failure entries above
  // already force the verdict to FAIL. They carry no weight of their own, so
  // a screen with filler copy cannot price its way back over the floor.
  const score = Math.round(
    (signals.composition + signals.regions + signals.geometry + signals.connectors +
      signals.tokens + signals.typography + signals.spacing + signals.contrast) * 10,
  ) / 10;

  if (score < FIDELITY_PASS_SCORE) {
    failures.push(`fidelity score ${score} below the ${FIDELITY_PASS_SCORE} acceptance floor`);
  }

  return {
    schema: FIDELITY_SCHEMA,
    score,
    signals,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    missingRegions,
    droppedConnectors,
    placeholderNodes,
    subFloorTexts,
    contrastFailures,
    evidence,
    notVerified,
  };
}

/**
 * Walks the parent chain for the first resolvable hex fill. An empty fill
 * (`[]`, transparent) inherits upward; a token reference is unresolvable
 * offline; the canvas root defaults to white (the compiler's default look).
 */
function resolveBackground(op: Record<string, unknown>, byId: Map<string, Record<string, unknown>>): string | null {
  const seen = new Set<string>();
  let current: Record<string, unknown> | undefined = op;
  for (let depth = 0; depth < 12 && current !== undefined; depth += 1) {
    const parentId = typeof current["parent"] === "string" ? (current["parent"] as string) : undefined;
    if (parentId === undefined || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    const fill = readField(parent, "fill");
    if (typeof fill === "string") {
      if (parseHex(fill) !== null) return fill;
      return null;
    }
    current = parent;
  }
  return "#FFFFFF";
}
