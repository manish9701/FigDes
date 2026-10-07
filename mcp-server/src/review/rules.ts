/**
 * Design critic rules (spec §8, §9, §25).
 *
 * Every rule is a pure function over measured facts. Two properties matter more
 * than coverage:
 *
 *  1. No invented scores. The spec asks for `Hierarchy 84/100`; that number
 *     cannot be computed honestly, so this engine reports findings with the
 *     measurements that triggered them plus a coarse confidence band instead.
 *
 *  2. Confidence has to mean something. "high" is reserved for rules that are
 *     arithmetic or exact comparison. Anything that involves a judgement about
 *     intent is medium, and therefore never auto-fixes.
 */
import {
  OperationSchema,
  isDefaultLayerName,
  type Finding,
  type NodeMetrics,
  type MetricsReport,
  type Operation,
} from "../../../shared/protocol";
import { contrastRatio, requiredRatio, round2 } from "./contrast";

const BOLD_STYLES = /bold|black|heavy/i;
const INTERACTIVE = /button|btn|link|toggle|switch|checkbox|radio|tab|chip|cta|close|action/i;
/** Children whose size strongly implies they are decoration, not layout. */
const DECORATIVE = /^(LINE|VECTOR|ELLIPSE|POLYGON|STAR)$/;

export type RuleSet = "review" | "audit";

interface Ctx {
  byId: Map<string, NodeMetrics>;
  childrenOf: Map<string, NodeMetrics[]>;
  baseSpacing: number;
  dominantRadius: number | null;
}

export interface RuleOptions {
  /** Report scan metadata for the caller. */
  scan?: { pageLoads: number; pagesCached: boolean };
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                       */
/* -------------------------------------------------------------------------- */

const REVIEW_RULES: Array<{ name: string; fn: (n: NodeMetrics, c: Ctx) => Finding[] }> = [
  { name: "text-contrast", fn: textContrast },
  { name: "overflow", fn: overflow },
  { name: "radius-inconsistency", fn: siblingRadiusMismatch },
  { name: "default-layer-name", fn: defaultLayerName },
  { name: "tap-target-size", fn: tinyTapTarget },
  { name: "off-grid-geometry", fn: offGridGeometry },
  { name: "text-outside-autolayout", fn: textOutsideAutoLayout },
  { name: "off-scale-spacing", fn: offScaleSpacing },
  { name: "duplicate-siblings", fn: duplicateSiblings },
  { name: "icon-only-control", fn: iconOnlyControl },
  { name: "color-only-state", fn: colorOnlyState },
  { name: "tiny-technical-text", fn: tinyTechnicalText },
  { name: "card-wall", fn: cardWall },
];

const AUDIT_RULES: Array<{ name: string; fn: (n: NodeMetrics, c: Ctx) => Finding[] }> = [
  { name: "unstyled-text", fn: unstyledText },
  { name: "unnamed-frame-children", fn: unnamedFrameChildren },
];

export function runRules(metrics: MetricsReport, ruleset: RuleSet): Finding[] {
  const nodes = metrics.nodes.filter((n) => n.visible);
  if (nodes.length === 0) return [];

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // One rule, one finding. A file-wide sweep over thousands of nodes can emit
  // hundreds of instances of the same problem; the critic is a to-do list, so
  // cap each rule and state plainly that it was capped. Repeating the same
  // finding 400 times would crowd out the distinct problems in the context
  // window and read as noise rather than signal.
  const PER_RULE_CAP = 12;

  const childrenOf = new Map<string, NodeMetrics[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = childrenOf.get(n.parentId);
    if (list) list.push(n);
    else childrenOf.set(n.parentId, [n]);
  }

  const ctx: Ctx = {
    byId,
    childrenOf,
    baseSpacing: inferBase([
      ...nodes.flatMap((n) => (typeof n.itemSpacing === "number" ? [n.itemSpacing] : [])),
      ...nodes.flatMap((n) => (n.padding ? [n.padding.top, n.padding.left] : [])),
    ]),
    dominantRadius: dominant(nodes.flatMap((n) => (typeof n.radius === "number" && n.radius > 0 ? [n.radius] : []))),
  };

  const rules = ruleset === "audit" ? AUDIT_RULES : REVIEW_RULES;
  const perRule: Record<string, number> = {};
  const suppressed: Record<string, number> = {};
  const out: Finding[] = [];

  for (const n of nodes) {
    for (const rule of rules) {
      for (const finding of rule.fn(n, ctx)) {
        const seen = perRule[finding.rule] ?? 0;
        if (seen >= PER_RULE_CAP) {
          suppressed[finding.rule] = (suppressed[finding.rule] ?? 0) + 1;
          continue;
        }
        perRule[finding.rule] = seen + 1;
        out.push(finding);
      }
    }
  }

  const trimmed = dedupe(out).sort(compareFindings);

  // Attach an honest count of what was left out rather than silently dropping it.
  for (const f of trimmed) {
    const extra = suppressed[f.rule];
    if (extra) {
      f.evidence = { ...f.evidence, additionalOccurrences: extra, note: `+${extra} more of this rule were suppressed` };
    }
  }

  return trimmed;
}

function compareFindings(a: Finding, b: Finding): number {
  const conf = { high: 0, medium: 1, low: 2 };
  const sev = { critical: 0, serious: 1, minor: 2 };
  return conf[a.confidence] - conf[b.confidence] || sev[a.severity] - sev[b.severity] || a.rule.localeCompare(b.rule);
}

export function summarise(findings: Finding[]) {
  const byRule: Record<string, number> = {};
  let high = 0;
  let medium = 0;
  let low = 0;
  let critical = 0;

  for (const f of findings) {
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
    if (f.confidence === "high") high += 1;
    else if (f.confidence === "medium") medium += 1;
    else low += 1;
    if (f.severity === "critical") critical += 1;
  }

  return { total: findings.length, high, medium, low, critical, byRule };
}

/* -------------------------------------------------------------------------- */
/* High-confidence rules                                                        */
/* -------------------------------------------------------------------------- */

/** WCAG AA contrast. Arithmetic over colours already composited on the client. */
function textContrast(n: NodeMetrics): Finding[] {
  if (n.type !== "TEXT" || !n.text?.color || !n.background) return [];
  if (n.text.family === "mixed" || !n.text.size) return [];
  // Invisible or empty text is not a contrast problem.
  if (n.text.content.trim().length === 0) return [];

  const ratio = contrastRatio(n.text.color, n.background);
  if (ratio === null) return [];

  // A ratio of exactly 1 means the text colour and the background resolved to
  // the same value, which means the measurement is wrong, not the design.
  // Reporting those as critical accessibility failures would be worse than
  // staying quiet, so the finding is skipped.
  if (ratio <= 1.001) return [];

  // Fully transparent text is invisible but not a contrast problem.
  if (n.text.length > 0 && n.text.content.trim().length === 0) return [];

  const bold = BOLD_STYLES.test(n.text.style ?? "");
  const required = requiredRatio(n.text.size, bold);
  if (ratio >= required) return [];

  return [
    {
      rule: "text-contrast",
      confidence: "high",
      severity: ratio < 3 ? "critical" : "serious",
      title: `Text contrast ${round2(ratio)}:1 is below the WCAG AA minimum of ${required}:1`,
      evidence: {
        textColor: n.text.color,
        background: n.background,
        ratio: round2(ratio),
        required,
        fontSize: n.text.size,
        bold,
        layerName: n.name,
      },
      nodeIds: [n.id],
      guidance:
        "Darken or lighten the text fill, or lighten the surface behind it. Stay inside the palette already used by this file rather than introducing a new hue.",
    },
  ];
}

/** Child extends past its parent's box. Pure geometry, so high confidence. */
function overflow(n: NodeMetrics, c: Ctx): Finding[] {
  if (!n.parentId || n.type === "PAGE" || n.type === "DOCUMENT") return [];
  const parent = c.byId.get(n.parentId);
  if (!parent || parent.type === "PAGE") return [];

  // Figma reports child x/y relative to the parent, so the child's box is
  // directly comparable with the parent's size.
  const right = n.x + n.w;
  const bottom = n.y + n.h;
  const spills: string[] = [];
  if (right > parent.w + 0.5) spills.push("right");
  if (bottom > parent.h + 0.5) spills.push("bottom");
  if (n.x < -0.5) spills.push("left");
  if (n.y < -0.5) spills.push("top");
  if (spills.length === 0) return [];

  return [
    {
      rule: "overflow",
      confidence: "high",
      severity: "serious",
      title: `"${n.name}" extends past the edge of "${parent.name}"`,
      evidence: {
        parentSize: `${parent.w}x${parent.h}`,
        childBox: `x=${round2(n.x)} y=${round2(n.y)} w=${n.w} h=${n.h}`,
        spills: spills.join(", "),
      },
      nodeIds: [n.id],
      guidance: `Shrink or reposition it so it stays inside "${parent.name}", or turn on clip content if the overhang is intentional.`,
    },
  ];
}

/**
 * Sibling frames disagree on radius.
 *
 * Evaluated on the parent, and reports the minority children. Checking each
 * child against its siblings separately would emit N findings for one problem.
 */
function siblingRadiusMismatch(n: NodeMetrics, c: Ctx): Finding[] {
  const siblings = c.childrenOf.get(n.id);
  if (!siblings || siblings.length < 2) return [];

  const withRadius = siblings.filter((s): s is NodeMetrics & { radius: number } => typeof s.radius === "number" && s.radius > 0);
  if (withRadius.length < 2) return [];
  if ([...new Set(withRadius.map((s) => s.radius))].length < 2) return [];

  const counts = new Map<number, number>();
  for (const s of withRadius) counts.set(s.radius, (counts.get(s.radius) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const majority = ranked[0]![0];
  const offenders = withRadius.filter((s) => s.radius !== majority);
  if (offenders.length === 0) return [];

  const otherValues = ranked
    .slice(1)
    .map(([v, count]) => `${v}px x${count}`)
    .join(", ");

  return [
    {
      rule: "radius-inconsistency",
      confidence: "high",
      severity: "minor",
      title: `${offenders.length} of ${withRadius.length} sized children of "${n.name}" use a non-standard corner radius`,
      evidence: {
        majorityRadius: majority,
        otherRadii: otherValues,
        offenders: offenders.map((o) => `${o.name}=${o.radius}px`).join(", "),
      },
      nodeIds: offenders.map((o) => o.id),
      suggestedOperations: validated(
        offenders.map((o) => ({ type: "setCornerRadius", target: o.id, radius: majority })),
      ),
      guidance: `Align these to the ${majority}px radius their siblings use.`,
    },
  ];
}

/** Figma's own default names. Detected from the name, not from a client flag. */
function defaultLayerName(n: NodeMetrics): Finding[] {
  if (!isDefaultLayerName(n.name)) return [];
  if (n.type === "PAGE" || n.type === "DOCUMENT") return [];
  return [
    {
      rule: "default-layer-name",
      confidence: "high",
      severity: "minor",
      title: `Layer "${n.name}" still has a default name`,
      evidence: { layerName: n.name, nodeType: n.type },
      nodeIds: [n.id],
      guidance:
        "Rename it after its role, for example \"Deployment Card\" or \"Throughput Value\", following the naming style already used in this file.",
    },
  ];
}

/** Text not bound to a text style. */
function unstyledText(n: NodeMetrics): Finding[] {
  if (n.type !== "TEXT" || !n.text || n.text.styled) return [];
  return [
    {
      rule: "unstyled-text",
      confidence: "high",
      severity: "minor",
      title: `"${n.name}" is not using a text style`,
      evidence: { family: n.text.family, size: n.text.size, style: n.text.style, layerName: n.name },
      nodeIds: [n.id],
      guidance: "Apply or create a text style so this can be updated centrally.",
    },
  ];
}

/** Most children of a frame still unnamed. Reported once per frame. */
function unnamedFrameChildren(n: NodeMetrics, c: Ctx): Finding[] {
  const children = c.childrenOf.get(n.id);
  if (!children || children.length < 3) return [];

  const defaults = children.filter((ch) => isDefaultLayerName(ch.name));
  if (defaults.length < Math.ceil(children.length / 2)) return [];

  return [
    {
      rule: "unnamed-frame-children",
      confidence: "high",
      severity: "minor",
      title: `${defaults.length} of ${children.length} children of "${n.name}" have default names`,
      evidence: { defaults: defaults.length, total: children.length },
      nodeIds: defaults.map((d) => d.id),
      guidance: "Name these layers after their role so the file stays navigable for everyone.",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Medium-confidence rules                                                      */
/* -------------------------------------------------------------------------- */

/** Under 44x44. "Looks interactive" is inferred from the name, hence medium. */
function tinyTapTarget(n: NodeMetrics): Finding[] {
  if (!INTERACTIVE.test(n.name)) return [];
  if (DECORATIVE.test(n.type) || n.type === "GROUP") return [];
  if (n.w >= 44 && n.h >= 44) return [];

  return [
    {
      rule: "tap-target-size",
      confidence: "medium",
      severity: "serious",
      title: `"${n.name}" reads as interactive but measures only ${n.w}x${n.h}`,
      evidence: { width: n.w, height: n.h, recommended: 44, nodeType: n.type },
      nodeIds: [n.id],
      guidance:
        "Grow the hit area to at least 44x44, or wrap the visual in an invisible 44x44 frame so the target is large without changing the appearance.",
    },
  ];
}

/**
 * True when any text exists in the node's subtree, including itself.
 *
 * Iterative rather than recursive: a 14-deep frame tree would blow the stack
 * otherwise, and this runs on every candidate node.
 */
function subtreeHasText(n: NodeMetrics, c: Ctx): boolean {
  const stack: NodeMetrics[] = [n];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.text && current.text.content.trim().length > 0) return true;
    const kids = c.childrenOf.get(current.id);
    if (kids) stack.push(...kids);
  }
  return false;
}

/** A control with no text anywhere inside it. */
function iconOnlyControl(n: NodeMetrics, c: Ctx): Finding[] {
  if (!INTERACTIVE.test(n.name)) return [];
  if (DECORATIVE.test(n.type) || n.type === "GROUP" || n.type === "TEXT") return [];
  if (subtreeHasText(n, c)) return [];

  return [
    {
      rule: "icon-only-control",
      confidence: "medium",
      severity: "serious",
      title: `"${n.name}" looks interactive but contains no text label`,
      evidence: { nodeType: n.type, size: `${n.w}x${n.h}` },
      nodeIds: [n.id],
      guidance:
        "An icon alone is ambiguous to sighted users and invisible to assistive tech. Add a visible label, or at minimum a tooltip and an accessible name.",
    },
  ];
}

/** State communicated by colour alone: a status-ish node with no text. */
function colorOnlyState(n: NodeMetrics, c: Ctx): Finding[] {
  if (!/status|pill|badge|health|state|dot|indicator/i.test(n.name)) return [];
  if (n.type === "TEXT") return [];
  if (subtreeHasText(n, c)) return [];

  return [
    {
      rule: "color-only-state",
      confidence: "medium",
      severity: "serious",
      title: `"${n.name}" communicates state with no text`,
      evidence: { nodeType: n.type, fill: n.fill ?? null },
      nodeIds: [n.id],
      guidance:
        "Colour alone does not survive color-blindness, greyscale or a glance. Put the state in words next to the colour: Healthy, Degraded, Error.",
    },
  ];
}

const MONO_FAMILIES = /mono|menlo|consolas|courier|sFMono|jetbrains|code/i;

/** Technical text set below a readable size. */
function tinyTechnicalText(n: NodeMetrics): Finding[] {
  if (n.type !== "TEXT" || !n.text) return [];
  if (n.text.size === null || n.text.size >= 11) return [];
  if (!n.text.family || !MONO_FAMILIES.test(n.text.family)) return [];

  return [
    {
      rule: "tiny-technical-text",
      confidence: "medium",
      severity: "minor",
      title: `Monospaced text at ${n.text.size}px is below the readable minimum`,
      evidence: { size: n.text.size, family: n.text.family, minimum: 11, content: n.text.content.slice(0, 40) },
      nodeIds: [n.id],
      guidance: "Minimum readable technical text is 11px. Identifiers and latencies smaller than that are texture, not information.",
    },
  ];
}

/**
 * The card-wall failure mode (FigDes §21).
 *
 * Counts bordered rectangles (frames/rectangles/components with both a fill and
 * a stroke or a radius that reads as a card) and measures their share of the
 * canvas. Three or more equal-weight cards, or cards covering most of the
 * screen, trigger the warning the spec asks for: convert a cluster into a
 * visual field, chart, topology or open composition.
 *
 * A warning, never a failure: sometimes the screen genuinely is a card grid,
 * and a critic that fails those is a critic that gets ignored.
 */
function cardWall(n: NodeMetrics, c: Ctx): Finding[] {
  // One screen, one verdict: only the top-level frame is judged, so a file
  // with five screens produces five findings, not five hundred.
  if (n.depth !== 0 || (n.type !== "FRAME" && n.type !== "COMPONENT")) return [];

  const canvasArea = Math.max(1, n.w * n.h);
  const cards: NodeMetrics[] = [];
  const stack: NodeMetrics[] = [n];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.id)) continue;
    seen.add(current.id);

    const isCard =
      (current.type === "FRAME" || current.type === "RECTANGLE" || current.type === "COMPONENT" || current.type === "INSTANCE") &&
      current.id !== n.id &&
      ((current.stroke !== undefined && current.stroke !== null) || (typeof current.radius === "number" && current.radius >= 4)) &&
      current.w > 40 &&
      current.h > 24;
    if (isCard) cards.push(current);

    const kids = c.childrenOf.get(current.id);
    if (kids) stack.push(...kids);
  }

  if (cards.length < 3) return [];

  const cardArea = cards.reduce((a, card) => a + card.w * card.h, 0);
  const share = cardArea / canvasArea;
  if (share < 0.4) return [];

  return [
    {
      rule: "card-wall",
      confidence: "medium",
      severity: "minor",
      title: `${cards.length} bordered cards cover ${Math.round(share * 100)}% of the screen`,
      evidence: { cards: cards.length, areaShare: Math.round(share * 100) },
      nodeIds: cards.slice(0, 12).map((card) => card.id),
      guidance:
        "Consider converting one card cluster into a visual field, chart, topology, or open composition. Cards are containers, not content.",
    },
  ];
}

/** Siblings identical in type, size, fill and content. */
function duplicateSiblings(n: NodeMetrics, c: Ctx): Finding[] {
  const siblings = c.childrenOf.get(n.id);
  if (!siblings || siblings.length < 3) return [];

  const groups = new Map<string, NodeMetrics[]>();
  for (const s of siblings) {
    const key = `${s.type}|${round2(s.w)}x${round2(s.h)}|${s.fill ?? "-"}|${s.text?.content ?? "-"}`;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }

  const out: Finding[] = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    const first = group[0]!;
    out.push({
      rule: "duplicate-siblings",
      confidence: "medium",
      severity: "minor",
      title: `${group.length} identical children in "${n.name}"`,
      evidence: {
        count: group.length,
        size: `${first.w}x${first.h}`,
        fill: first.fill ?? null,
        content: first.text?.content ?? null,
        parentName: n.name,
      },
      nodeIds: group.map((g) => g.id),
      guidance:
        "These look like copies of the same thing. Promote one to a component and replace the rest with instances, or delete the ones you do not need.",
    });
  }
  return out;
}

/**
 * Position that does not sit on the inferred spacing grid.
 *
 * Only position is checked, never size. Content-driven elements are routinely
 * 100px or 250px wide without that being a defect, so testing w/h produced
 * noise on almost every frame. Misalignment is the real problem.
 */
function offGridGeometry(n: NodeMetrics, c: Ctx): Finding[] {
  if (c.baseSpacing === 0 || n.depth === 0) return [];

  const base = c.baseSpacing;
  const offenders: string[] = [];
  if (!onGrid(n.x, base)) offenders.push("x");
  if (!onGrid(n.y, base)) offenders.push("y");
  if (offenders.length === 0) return [];

  return [
    {
      rule: "off-grid-geometry",
      confidence: "medium",
      severity: "minor",
      title: `"${n.name}" is not aligned to the ${base}px grid`,
      evidence: { x: round2(n.x), y: round2(n.y), base, offenders: offenders.join(",") },
      nodeIds: [n.id],
      guidance: `Snap ${offenders.join(" and ")} to the nearest multiple of ${base}px, or leave it if this element is intentionally off-grid.`,
    },
  ];
}

/** Absolutely positioned text inside a frame that uses auto layout. */
function textOutsideAutoLayout(n: NodeMetrics, c: Ctx): Finding[] {
  if (n.type !== "TEXT" || !n.parentId) return [];
  const parent = c.byId.get(n.parentId);
  if (!parent?.layoutMode || parent.layoutMode === "NONE") return [];

  return [
    {
      rule: "text-outside-autolayout",
      confidence: "medium",
      severity: "minor",
      title: `"${n.name}" is absolutely positioned inside the auto-layout frame "${parent.name}"`,
      evidence: { parentLayout: parent.layoutMode, x: round2(n.x), y: round2(n.y) },
      nodeIds: [n.id],
      guidance:
        "Auto layout normally owns child position. Either accept that this one layer is pinned, or restructure so the text takes part in the layout.",
    },
  ];
}

/** Padding that is not a multiple of the base unit. */
function offScaleSpacing(n: NodeMetrics, c: Ctx): Finding[] {
  if (c.baseSpacing === 0 || !n.padding) return [];

  const base = c.baseSpacing;
  const bad = Object.entries(n.padding).filter(
    ([, value]) => typeof value === "number" && value !== 0 && !onGrid(value, base),
  ) as Array<[string, number]>;

  if (bad.length === 0) return [];

  return [
    {
      rule: "off-scale-spacing",
      confidence: "medium",
      severity: "minor",
      title: `"${n.name}" has padding that is off the ${base}px scale`,
      evidence: { base, offenders: bad.map(([s, v]) => `${s}=${v}`).join(", ") },
      nodeIds: [n.id],
      guidance: `Round ${bad.map(([s]) => s).join(", ")} to the nearest ${base}px multiple.`,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

function onGrid(value: number, base: number): boolean {
  if (base <= 0) return true;
  return Math.abs(value / base - Math.round(value / base)) < 0.02;
}

function dominant(values: number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Guess the base unit of a spacing system.
 *
 * Returns the LARGEST unit that explains the observed values, not the smallest.
 * Iterating ascending would label an 8px-grid file as a 2px grid, which then
 * makes every off-grid rule silently never fire. Candidate bases are the
 * observed values themselves (the real base is almost always one of them) plus
 * the common 10/8/4/2 steps. Zero means no consistent base was found, and
 * callers must then make no grid claims at all.
 */
export function inferBase(values: number[]): number {
  const positives = values.filter((v) => Number.isFinite(v) && v > 0);
  if (positives.length === 0) return 0;

  // A base of 1 would accept every integer, which is not a spacing system but
  // the absence of one. Restrict to plausible steps and return 0 when none fit,
  // so the grid rules stay silent rather than endorsing everything as aligned.
  const plausible = new Set([2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24]);
  const distinct = [...new Set(positives.map((v) => Math.round(v * 100) / 100))];
  const candidates = [...new Set([...distinct, 8, 4, 2])]
    .filter((c) => plausible.has(c))
    .sort((a, b) => b - a);

  const total = positives.length;
  for (const base of candidates) {
    const on = positives.filter((v) => onGrid(v, base)).length;
    if (on / total >= 0.8) return base;
  }
  return 0;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = `${f.rule}:${f.nodeIds.slice().sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Parse candidate operations against the allowlist. Anything that would not
 * validate is dropped rather than shipped, so `suggestedOperations` can never
 * bypass OperationSchema.
 */
export function validated(candidates: unknown[]): Operation[] | undefined {
  const ok: Operation[] = [];
  for (const c of candidates) {
    const parsed = OperationSchema.safeParse(c);
    if (parsed.success) ok.push(parsed.data);
  }
  return ok.length > 0 ? ok : undefined;
}