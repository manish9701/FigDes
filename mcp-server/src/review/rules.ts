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
  { name: "vector-stroke-system", fn: vectorStrokeSystem },
  { name: "repeating-slide-layout", fn: repeatingSlideLayout },
  { name: "font-family-count", fn: fontFamilyCount },
  { name: "button-overload", fn: buttonOverload },
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

/** Child extends past its parent's box. Pure geometry, so high confidence — unless the coordinates are unverified. */
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

  // Unverified coordinate space (no absolute box existed at collection time):
  // report uncertainty at low confidence rather than a high-confidence hard
  // failure. Genuine overflow on canonical parent-local coordinates still
  // fails loud. Absent coordSpace is legacy payloads, kept as-is.
  if (n.coordSpace === "local-unverified") {
    return [
      {
        rule: "overflow",
        confidence: "low",
        severity: "minor",
        title: `"${n.name}" may extend past the edge of "${parent.name}" (unverified coordinates)`,
        evidence: {
          parentSize: `${parent.w}x${parent.h}`,
          childBox: `x=${round2(n.x)} y=${round2(n.y)} w=${n.w} h=${n.h}`,
          spills: spills.join(", "),
          coordinateSpace: "local-unverified",
        },
        nodeIds: [n.id],
        guidance: `Re-measure with canonical parent-local bounds before treating this as a defect.`,
      },
    ];
  }

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

/**
 * Under 44x44. "Looks interactive" is inferred from the name, hence medium.
 *
 * Static text is never a tap target by itself (handoff §6): a connector label
 * named "link …" or ordinary text is not a control. Semantic role/state
 * decides — a bare TEXT node has neither, so it is skipped like GROUP.
 */
function tinyTapTarget(n: NodeMetrics): Finding[] {
  if (!INTERACTIVE.test(n.name)) return [];
  if (DECORATIVE.test(n.type) || n.type === "GROUP" || n.type === "TEXT") return [];
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
 * canvas. Peer cards — same parent, similar size, in a plain container — trigger
 * the warning the spec asks for: convert a cluster into a visual field, chart,
 * topology or open composition.
 *
 * Semantic exclusions (quality-reliability P0): members of topology fields,
 * inspectors, rails, panels, bands and graphs are structure, not peer cards —
 * a topology with five device tiles is not a KPI wall. Dashboard shells
 * (navigation/header/content) stay fully scrutinized: no whitelist there.
 *
 * A warning, never a failure: sometimes the screen genuinely is a card grid,
 * and a critic that fails those is a critic that gets ignored.
 */
const EXEMPT_CARD_CONTAINERS = /topolog|map|field|graph|inspector|rail|panel|band|decision/i;

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
    if (isCard) {
      const parent = current.parentId ? c.byId.get(current.parentId) : undefined;
      const containerName = parent ? parent.name : "";
      // Structure members are not peer cards. The parent name carries the
      // role the metrics do not model; dashboards never match this pattern.
      if (!EXEMPT_CARD_CONTAINERS.test(containerName)) cards.push(current);
    }

    const kids = c.childrenOf.get(current.id);
    if (kids) stack.push(...kids);
  }

  if (cards.length < 3) return [];

  // Peers share a parent AND a size: three lookalikes in one container is a
  // wall; three lookalikes scattered across regions — or three differently
  // sized layout regions — is a system.
  const byParentSize = new Map<string, NodeMetrics[]>();
  for (const card of cards) {
    const key = `${card.parentId ?? ""}|${Math.round(card.w / 8)}x${Math.round(card.h / 8)}`;
    byParentSize.set(key, [...(byParentSize.get(key) ?? []), card]);
  }
  let peers: NodeMetrics[] = [];
  let peerParent = "";
  for (const group of byParentSize.values()) {
    if (group.length >= 3 && group.length > peers.length) {
      peers = group;
      peerParent = group[0]?.parentId ?? "";
    }
  }
  if (peers.length < 3) return [];

  const cardArea = peers.reduce((a, card) => a + card.w * card.h, 0);
  const share = cardArea / canvasArea;
  if (share < 0.4) return [];

  const parentName = peerParent ? (c.byId.get(peerParent)?.name ?? peerParent) : "screen";
  return [
    {
      rule: "card-wall",
      confidence: "medium",
      severity: "minor",
      title: `${peers.length} bordered cards cover ${Math.round(share * 100)}% of the screen`,
      evidence: { cards: peers.length, areaShare: Math.round(share * 100), peerParent: parentName, peerIds: peers.slice(0, 6).map((card) => card.id).join(",") },
      nodeIds: peers.slice(0, 12).map((card) => card.id),
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
 * Inconsistent stroke weights across sibling vector artwork.
 *
 * A logo family or diagram set drawn on one stroke system uses one or two
 * weights; five distinct hairlines across six siblings reads as accidental.
 * Parent-level (runs once per parent with 2+ stroked vectors) so a single
 * finding names the family, not six findings naming six vectors.
 */
function vectorStrokeSystem(n: NodeMetrics, c: Ctx): Finding[] {
  const siblings = c.childrenOf.get(n.id);
  if (!siblings) return [];
  const stroked = siblings.filter(
    (s) => (s.type === "VECTOR" || s.type === "BOOLEAN_OPERATION") && typeof s.stroke?.weight === "number",
  );
  if (stroked.length < 2) return [];
  const weights = [...new Set(stroked.map((s) => Math.round((s.stroke?.weight ?? 0) * 100) / 100))].sort((a, b) => a - b);
  if (weights.length <= 2) return [];
  return [
    {
      rule: "vector-stroke-system",
      confidence: "medium",
      severity: "minor",
      title: `${stroked.length} sibling vectors use ${weights.length} stroke weights (${weights.join(", ")})`,
      evidence: { vectors: stroked.length, weights: weights.join(", "), parentName: n.name },
      nodeIds: stroked.map((s) => s.id),
      guidance:
        "Unify the family on one stroke system (e.g. grid/4 regular, grid/8 hairline). Consistent strokes are what make separate marks read as one logo.",
    },
  ];
}

/**
 * Repeating slide-sized siblings with identical child counts.
 *
 * A deck where every 1920x1080 sibling holds the same structure is N copies
 * of one layout, not a narrative. Fires once per parent of slide-sized frames
 * so the fix is aimed at the deck, not at one slide.
 */
function repeatingSlideLayout(n: NodeMetrics, c: Ctx): Finding[] {
  const siblings = c.childrenOf.get(n.id);
  if (!siblings) return [];
  const slides = siblings.filter((s) => (s.type === "FRAME" || s.type === "SLIDE") && Math.abs(s.w - 1920) < 4 && Math.abs(s.h - 1080) < 4);
  if (slides.length < 3) return [];
  const childCounts = slides.map((s) => c.childrenOf.get(s.id)?.length ?? 0);
  const first = childCounts[0];
  if (first === undefined || !childCounts.every((v) => v === first)) return [];
  return [
    {
      rule: "repeating-slide-layout",
      confidence: "low",
      severity: "minor",
      title: `${slides.length} slides share the same structure (${first} children each)`,
      evidence: { slides: slides.length, childrenEach: first },
      nodeIds: slides.map((s) => s.id),
      guidance:
        "Vary the compositions across the arc: title, split, diagram, evidence, action. A deck is a sequence, and repetition flattens the narrative.",
    },
  ];
}

/**
 * More than three font families in one file (report §18 governance).
 *
 * A file-wide finding carried once by the first text node in document order:
 * three families is a system, four is the start of drift. Mixed-font nodes are
 * skipped rather than counted as a family, because "mixed" is a measurement
 * limit, not a typeface.
 */
function fontFamilyCount(n: NodeMetrics, c: Ctx): Finding[] {
  if (n.type !== "TEXT") return [];
  const byFamily = new Map<string, string[]>();
  for (const [id, m] of c.byId) {
    if (m.type !== "TEXT" || !m.text?.family) continue;
    if (m.text.family === "mixed") continue;
    const list = byFamily.get(m.text.family) ?? [];
    if (list.length < 12) list.push(id);
    byFamily.set(m.text.family, list);
  }
  if (byFamily.size <= 3) return [];
  const first = [...c.byId.values()].find((m) => m.type === "TEXT");
  if (!first || first.id !== n.id) return [];
  return [
    {
      rule: "font-family-count",
      confidence: "high",
      severity: "minor",
      title: `${byFamily.size} font families in one file (${[...byFamily.keys()].join(", ")})`,
      evidence: { families: [...byFamily.keys()].join(", "), count: byFamily.size },
      nodeIds: [...byFamily.values()].flat().slice(0, 12),
      guidance:
        "Consolidate on at most three families (display, body, mono). Extra families are usually pasted-in components that never got re-styled.",
    },
  ];
}

/** True when the node is a button by name or by component ancestry. */
function isButtonLike(m: NodeMetrics, c: Ctx): boolean {
  if (/button/i.test(m.name)) return true;
  if (m.type === "INSTANCE" && m.instanceOf) {
    const main = c.byId.get(m.instanceOf);
    if (main && /button/i.test(main.name) && (main.type === "COMPONENT" || main.type === "COMPONENT_SET")) return true;
  }
  return false;
}

/** True when a component-set (variants, not screen buttons) sits overhead. */
function insideComponentSet(m: NodeMetrics, c: Ctx): boolean {
  let current: NodeMetrics | undefined = m;
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = c.byId.get(current.parentId);
    if (!parent) break;
    if (parent.type === "COMPONENT_SET") return true;
    current = parent;
  }
  return false;
}

/**
 * More than five buttons on one screen (report §18 governance).
 *
 * Emitted once per topmost scanned tree so a six-button screen yields one
 * finding, not six. Variant sets are excluded: six variants of one button are
 * a component, not six competing actions.
 */
function buttonOverload(n: NodeMetrics, c: Ctx): Finding[] {
  let top: NodeMetrics = n;
  const seen = new Set<string>();
  while (top.parentId && c.byId.has(top.parentId) && !seen.has(top.parentId)) {
    seen.add(top.parentId);
    top = c.byId.get(top.parentId)!;
  }
  if (top.id !== n.id) return [];

  const buttons: string[] = [];
  const visit = (m: NodeMetrics): void => {
    if (isButtonLike(m, c) && !insideComponentSet(m, c) && buttons.length < 12) buttons.push(m.id);
    for (const child of c.childrenOf.get(m.id) ?? []) visit(child);
  };
  visit(top);
  if (buttons.length <= 5) return [];
  return [
    {
      rule: "button-overload",
      confidence: "medium",
      severity: "minor",
      title: `${buttons.length} buttons compete on "${top.name}"`,
      evidence: { buttons: buttons.length, screenName: top.name },
      nodeIds: buttons,
      guidance:
        "More than five buttons on one screen means no clear primary action. Promote one to primary, demote the rest to quiet links, or move secondary actions behind the primary flow.",
    },
  ];
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