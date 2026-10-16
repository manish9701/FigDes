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
  RADIUS_SCALE,
  isOnRadiusScale,
  nearestRadiusStep,
  type Finding,
  type NodeMetrics,
  type MetricsReport,
  type Operation,
} from "../../../shared/protocol";
import { contrastRatio, repairTextColour, requiredRatio, round2 } from "./contrast";

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
  { name: "text-route-collision", fn: textRouteCollision },
  { name: "connector-endpoint-ambiguous", fn: connectorEndpointAmbiguous },
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
  //
  // Generous, because repetition is now collapsed after the fact: the cap
  // exists to bound traversal, not to decide what the reviewer gets to see. At
  // 12 it was silently truncating a 64-node audit to 12 and the "+N more"
  // counts were the only record of the rest (issue #12, B3).
  const PER_RULE_CAP = 500;

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

  // Dedupe, then collapse repetition, then order by severity. Grouping before
  // ordering is what stops one repeated rule from occupying the top of the list
  // regardless of how minor it is.
  const trimmed = groupRepetitive(dedupe(out)).sort(compareFindings);

  // Attach an honest count of what was left out rather than silently dropping it.
  for (const f of trimmed) {
    const extra = suppressed[f.rule];
    if (extra) {
      f.evidence = { ...f.evidence, additionalOccurrences: extra, note: `+${extra} more of this rule were suppressed` };
    }
  }

  // Evidence provenance (P1): every finding carries source type, confidence,
  // target ids, coordinate space and rule version — so a stale or heuristic
  // result can never certify as geometry, and a local/absolute mismatch
  // downgrades instead of hard-failing (see overflow above).
  for (const f of trimmed) {
    if (f.ruleVersion === undefined) f.ruleVersion = RULE_VERSION;
    if (f.evidenceType === undefined) f.evidenceType = evidenceTypeFor(f.rule);
    if (f.coordinateSpace === undefined) {
      const spaces = f.nodeIds
        .map((id) => byId.get(id)?.coordSpace)
        .filter((s): s is NonNullable<typeof s> => s !== undefined);
      f.coordinateSpace = spaces.includes("local-unverified") ? "local-unverified" : spaces.includes("parent-local") ? "parent-local" : "legacy";
      if (f.coordinateSpace === "local-unverified" && f.confidence === "high") f.confidence = "low";
    }
  }

  return trimmed;
}

const RULE_VERSION = "figdes-evaluator-1";

function evidenceTypeFor(rule: string): Finding["evidenceType"] {
  switch (rule) {
    case "text-contrast":
    case "tiny-technical-text":
      return "accessibility";
    case "overflow":
    case "off-grid-geometry":
    case "off-scale-spacing":
    case "tap-target-size":
    case "duplicate-siblings":
    case "vector-stroke-system":
      return "geometry";
    case "unstyled-text":
    case "unnamed-frame-children":
    case "font-family-count":
      return "design-system";
    default:
      return "heuristic";
  }
}

/**
 * Ordering for the to-do list.
 *
 * **Severity first.** This was confidence-first, and it buried real defects.
 * The live audit of `EXO_HARD_TEST_CLUSTER_ROUTING_V03` (issue #12, B3) returned
 * twelve `unstyled-text` findings and nothing else, because that rule is
 * `high` confidence / `minor` severity: twelve cosmetic notes about text styles
 * outranked any overlap, contrast or tap-target defect, whatever their severity.
 *
 * Confidence is still meaningful, but as a tiebreak *within* a severity band —
 * which is what it always should have been. "We are certain this is a minor
 * cosmetic issue" is not a reason to read it before "this is a broken layout".
 */
function compareFindings(a: Finding, b: Finding): number {
  const sev = { critical: 0, serious: 1, minor: 2 };
  const conf = { high: 0, medium: 1, low: 2 };
  return sev[a.severity] - sev[b.severity] || conf[a.confidence] - conf[b.confidence] || a.rule.localeCompare(b.rule);
}

/**
 * How many affected nodes a grouped finding will list individually.
 *
 * The count is always exact; only the list is capped, because a 400-node file
 * should not put 400 ids in the context window to say "400 layers are unstyled".
 */
const GROUP_NODE_CAP = 40;

/**
 * Collapse findings that say the same thing about different nodes.
 *
 * A file with sixty unstyled text layers produced sixty findings, capped to
 * twelve, all identical apart from which layer they named — so the critic's
 * twelve slots were spent on one repeated note and the distinct problems in the
 * frame had nowhere to appear (issue #12, B3: "12 findings returned, all
 * `unstyled-text` ... indicating weak prioritization/deduplication").
 *
 * Only *point* findings group — ones that name exactly one node. A finding that
 * already lists several nodes (`duplicate-siblings`, `card-wall`) has grouped
 * itself and is left alone, which also means rules that aggregate deliberately
 * keep their existing titles and evidence.
 *
 * Grouping never loses a repair: `suggestedOperations` from every member is
 * unioned and deduplicated by target, so a grouped finding still fixes all the
 * nodes it claims to cover.
 */
function groupRepetitive(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  const passthrough: Finding[] = [];

  for (const f of findings) {
    if (f.nodeIds.length !== 1) {
      passthrough.push(f);
      continue;
    }
    // Confidence and severity are part of the identity: two contrast findings at
    // different ratios are different problems, while twelve unstyled labels are
    // the same one.
    const key = `${f.rule}|${f.confidence}|${f.severity}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(f);
    else groups.set(key, [f]);
  }

  const out: Finding[] = [...passthrough];

  for (const members of groups.values()) {
    if (members.length === 1) {
      out.push(members[0]!);
      continue;
    }
    out.push(collapse(members));
  }

  return out;
}

/** One finding standing for `members`, with the per-node repairs preserved. */
function collapse(members: Finding[]): Finding {
  const rep = members[0]!;
  const count = members.length;

  const ids: string[] = [];
  const seen = new Set<string>();
  const ops: Operation[] = [];
  const seenOps = new Set<string>();
  for (const m of members) {
    for (const id of m.nodeIds) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    for (const o of m.suggestedOperations ?? []) {
      const key = `${(o as { type?: string }).type}:${(o as { target?: string }).target ?? ""}`;
      if (seenOps.has(key)) continue;
      seenOps.add(key);
      ops.push(o);
    }
  }

  return {
    ...rep,
    // The representative's title names one layer, which would understate a
    // grouped finding, so the count leads and the example follows.
    title: `${count} nodes: ${stripLayerName(rep.title)}`,
    evidence: {
      ...rep.evidence,
      occurrences: count,
      grouped: true,
      example: rep.title,
      /** What each affected node looks like, when the samples differ. */
      samples: members
        .slice(0, 5)
        .map((m) => m.title)
        .join(" | "),
    },
    nodeIds: ids.slice(0, GROUP_NODE_CAP),
    ...(ops.length > 0 ? { suggestedOperations: ops } : { suggestedOperations: rep.suggestedOperations }),
  };
}

/**
 * Drop a leading quoted layer name from a title so it reads as a general
 * statement once it stands for several nodes.
 *
 * Only strips when the title actually opens with a quoted name. `"Row 3" is not
 * using a text style` becomes `is not using a text style`, and the representative
 * title is kept in `evidence.example` so nothing is lost.
 */
function stripLayerName(title: string): string {
  const m = /^"[^"]*"\s*(.*)$/.exec(title);
  return m?.[1] ? m[1] : title;
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

/**
 * The colour a viewer actually sees immediately behind a text node.
 *
 * ## Why this is not `n.background`
 *
 * The plugin composites ancestor fills, which is right for the common case. It
 * is blind to the case that dominates real UI: a control drawn as a *pair* of
 * siblings — a filled rectangle and a text layer sitting on top of it, both
 * parented to the region rather than to each other. The text's ancestor chain
 * then leads to the region and the page, so white button text on a dark button
 * was measured against warm-white and reported as 1.06:1 (issue #11).
 *
 * A false positive here is worse than a false negative: it sends a designer to
 * "fix" a button that is correct, and the repair darkens label text that was
 * already the right colour.
 *
 * Precedence follows paint order. Among the text's own siblings, an opaque one
 * that encloses the text's box and was painted *earlier* is behind the glyphs,
 * so it wins over the shared parent. Only when no such sibling exists does the
 * composited ancestor chain apply.
 *
 * The result names its provenance so the finding can be argued with: a reviewer
 * who disagrees with which surface counts can see which surface was chosen.
 */
function effectiveSurface(n: NodeMetrics, c: Ctx, fallback: string): { hex: string; via: string; concrete: boolean } {
  const siblings = n.parentId ? (c.childrenOf.get(n.parentId) ?? []) : [];
  const textZ = typeof n.zIndex === "number" ? n.zIndex : 0;
  const EPS = 1;

  let best: { node: NodeMetrics; z: number } | null = null;
  for (const s of siblings) {
    if (s.id === n.id || s.type === "TEXT") continue;
    if (typeof s.fill !== "string" || s.fill.length === 0) continue;
    // Only a surface that is opaque enough to *be* the backdrop counts; a 20%
    // tint is decoration, and treating it as opaque would invent a contrast bug.
    if (typeof s.fillAlpha === "number" && s.fillAlpha < 0.9) continue;
    const sZ = typeof s.zIndex === "number" ? s.zIndex : 0;
    if (sZ > textZ) continue; // painted after the text, so it covers it
    const encloses =
      s.x <= n.x + EPS && s.y <= n.y + EPS && s.x + s.w >= n.x + n.w - EPS && s.y + s.h >= n.y + n.h - EPS;
    if (!encloses) continue;
    // Later siblings are painted on top of earlier ones, so the highest zIndex
    // still below the text is the one actually nearest.
    if (!best || sZ > best.z) best = { node: s, z: sZ };
  }

  if (best) return { hex: best.node.fill!, via: `sibling surface '${best.node.name}'`, concrete: true };
  return { hex: fallback, via: "composited ancestor fills", concrete: false };
}

/** WCAG AA contrast. Arithmetic over colours already composited on the client. */
function textContrast(n: NodeMetrics, c: Ctx): Finding[] {
  if (n.type !== "TEXT" || !n.text?.color || !n.background) return [];
  if (n.text.family === "mixed" || !n.text.size) return [];
  // Invisible or empty text is not a contrast problem.
  if (n.text.content.trim().length === 0) return [];

  // Measured against what is actually behind the glyphs, not merely what is
  // behind the text node's parent.
  const surface = effectiveSurface(n, c, n.background);
  const ratio = contrastRatio(n.text.color, surface.hex);
  if (ratio === null) return [];

  // A ratio of exactly 1 from the *composited* path means the text colour and the
  // background resolved to the same value, which usually means the measurement is
  // wrong rather than the design — opacity, blending or an unresolved variable
  // that the client could not read. Reporting those floods the reviewer with fake
  // criticals.
  //
  // From a *concrete* sibling surface it means the opposite: there is a known
  // painted panel, the text is literally on top of it, and both resolve to the
  // same hex. That is invisible text, and it is exactly as real as any other
  // contrast defect — so it is reported.
  if (ratio <= 1.001 && !surface.concrete) return [];

  // Fully transparent text is invisible but not a contrast problem.
  if (n.text.length > 0 && n.text.content.trim().length === 0) return [];

  const bold = BOLD_STYLES.test(n.text.style ?? "");
  const required = requiredRatio(n.text.size, bold);
  if (ratio >= required) return [];

  // A measured, palette-safe repair, proposed with the finding.
  //
  // Without one this rule is arithmetic but unactionable, which is why
  // `refine_screen` skipped every contrast finding it raised: hard stress test
  // #10 found eight `#777777`-on-white labels at 4.48:1, applied zero fixes and
  // returned budget-exhausted. A high-confidence finding that arrives with no
  // `suggestedOperations` is invisible to every automated repair loop, and the
  // rule reads as noise rather than as work.
  //
  // The candidate moves the fill along its own hue towards the reachable end of
  // the lightness range, so the design keeps its voice. The achieved ratio is
  // reported in the evidence so the repair can be verified rather than trusted.
  const repair = repairTextColour(n.text.color, surface.hex, required);

  return [
    {
      rule: "text-contrast",
      confidence: "high",
      severity: ratio < 3 ? "critical" : "serious",
      title: `Text contrast ${round2(ratio)}:1 is below the WCAG AA minimum of ${required}:1`,
      evidence: {
        textColor: n.text.color,
        background: surface.hex,
        /** Which surface the measurement used, so the number can be argued with. */
        surfaceSource: surface.via,
        ratio: round2(ratio),
        required,
        fontSize: n.text.size,
        bold,
        layerName: n.name,
        ...(repair
          ? {
              proposedFill: repair.hex,
              proposedRatio: repair.ratio,
              repairVerified: repair.ratio >= required,
            }
          : {
              repairUnavailable:
                "No text colour reaches the required ratio against this surface. Change the surface, not the text.",
            }),
      },
      nodeIds: [n.id],
      ...(repair
        ? {
            suggestedOperations: validated([{ type: "setFill", target: n.id, fill: repair.hex }]),
          }
        : {}),
      guidance: repair
        ? `Set this layer's fill to ${repair.hex} to reach ${repair.ratio}:1, holding the hue and moving only lightness.`
        : "Lighten or darken the surface behind it — no text colour reaches this ratio on ${n.background} without changing the design's voice.",
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

  // A circle is not an off-scale rectangle.
  //
  // Issue #11 asked for dots and circles not to be misclassified. A status dot is
  // a frame whose radius is half its shortest side; that is the correct value for
  // that shape, and reporting it as drift is a false positive that also drags a
  // real repair (`setCornerRadius`) toward destroying the circle.
  const circular = withRadius.filter((s) => s.radius >= Math.min(s.w, s.h) / 2 - 0.5);
  const candidates = withRadius.filter((s) => !circular.includes(s));
  if (candidates.length < 2) return [];

  // Is anything in the group off-scale? Not "is anything off-scale *and* not the
  // majority" — that was the bug. With a 5px majority and two 4px values, the 4s
  // are on-scale, so the old check reported no drift and then proposed moving the
  // 4s to 5, i.e. onto the scale violation it was meant to prevent. A live retest
  // caught exactly that on the homepage.
  const drifted = candidates.filter((s) => !isOnRadiusScale(s.radius));
  const offScale = drifted.length > 0;

  // Two different questions, and they need different answers:
  //  - off-scale values are drift; snap each to the documented step nearest it.
  //  - on-scale values that merely disagree with their siblings are a hierarchy
  //    decision, not a defect. Matching the majority is offered, not asserted.
  //
  // The proposal never leaves the scale. When the majority itself is off-scale,
  // matching it would move correct values onto a value the scale does not have,
  // so the nearest step wins instead.
  const majorityOnScale = isOnRadiusScale(majority);
  const propose = (radius: number): number => (majorityOnScale ? majority : nearestRadiusStep(radius));

  const offendersToReport = offScale
    ? drifted
    : candidates.filter((s) => s.radius !== majority);
  if (offendersToReport.length === 0) return [];

  const otherValues = ranked
    .slice(1)
    .map(([v, count]) => `${v}px x${count}`)
    .join(", ");

  const proposed = propose;

  return [
    {
      rule: "radius-inconsistency",
      confidence: "high",
      severity: "minor",
      title: offScale
        ? `${offendersToReport.length} of ${withRadius.length} sized children of "${n.name}" use a corner radius that is not on the ${RADIUS_SCALE.slice(0, 4).join("/")}px scale`
        : `${offendersToReport.length} of ${withRadius.length} sized children of "${n.name}" use a different corner radius than their siblings`,
      evidence: {
        scale: RADIUS_SCALE.slice(0, 4).join("/") + "px",
        majorityRadius: majority,
        majorityOnScale: majorityOnScale,
        kind: offScale ? "off-scale" : "sibling-divergence",
        otherRadii: otherValues,
        circularExcluded: circular.map((o) => `${o.name}=${o.radius}px (circular)`).join(", ") || null,
        offenders: offendersToReport.map((o) => `${o.name}=${o.radius}px`).join(", "),
      },
      nodeIds: offendersToReport.map((o) => o.id),
      suggestedOperations: validated(
        offendersToReport.map((o) => ({ type: "setCornerRadius", target: o.id, radius: proposed(o.radius) })),
      ),
      guidance: offScale
        ? `Snap the off-scale values to the documented step nearest them (${offendersToReport
            .map((o) => `${o.radius}->${proposed(o.radius)}`)
            .join(", ")}).${majorityOnScale ? "" : ` The ${majority}px majority is itself off-scale, so it is not used as the target — fix it too.`}`
        : `Align these to the ${majority}px radius their siblings use, or keep them if the difference is a deliberate hierarchy.`,
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

/**
 * A label drawn *beside* a shape rather than inside it.
 *
 * ## Why this exists
 *
 * Hard stress test #10 flagged a green state dot as "colour only" while the word
 * ONLINE sat next to it as a sibling, and a primary action's background
 * rectangle as an unlabelled control while its caption sat beside it. Both are
 * the same mistake in the reviewer: it read one primitive node in isolation and
 * treated the absence of a *descendant* as the absence of a label.
 *
 * In real files a control is a *group* — a background rectangle with a caption
 * layered over it, or a dot with a word beside it. So a sibling text node that
 * sits within the same row (vertically overlapping) and whose centre falls
 * inside the shape's horizontal span counts as the label.
 *
 * The check is deliberately geometric rather than semantic: it does not guess
 * that "ONLINE" describes the dot, only that the two occupy the same row and
 * overlap horizontally. A label far away, in another column, or on a different
 * row is not accepted, so the finding still fires where it should.
 */
function hasSiblingLabel(n: NodeMetrics, c: Ctx): boolean {
  if (!n.parentId) return false;
  const siblings = c.childrenOf.get(n.parentId) ?? [];
  const right = n.x + n.w;
  const centreY = n.y + n.h / 2;
  const LABEL_PADDING = 4;

  for (const s of siblings) {
    if (s.id === n.id) continue;
    if (s.type !== "TEXT" || !s.text) continue;
    if (s.text.content.trim().length === 0) continue;

    const sCentreY = s.y + s.h / 2;
    // Same row: the two verticals overlap by most of the smaller box.
    const overlapY = Math.min(n.y + n.h, s.y + s.h) - Math.max(n.y, s.y);
    const minHeight = Math.min(n.h, s.h);
    if (overlapY <= 0 || overlapY < minHeight * 0.5) continue;

    // Horizontally adjacent or overlapping, with a small tolerance so a label
    // flush to the edge still counts.
    const horizontalGap = Math.max(0, Math.max(n.x - (s.x + s.w), s.x - right));
    if (horizontalGap > LABEL_PADDING * 4) continue;

    // Not a caption for something far above or below this row.
    if (Math.abs(sCentreY - centreY) > Math.max(n.h, s.h)) continue;
    return true;
  }
  return false;
}

/** True when the node is text, or has text, or has a label drawn beside it. */
function hasVisibleLabel(n: NodeMetrics, c: Ctx): boolean {
  return subtreeHasText(n, c) || hasSiblingLabel(n, c);
}

/** A control with no text anywhere inside it or beside it. */
function iconOnlyControl(n: NodeMetrics, c: Ctx): Finding[] {
  if (!INTERACTIVE.test(n.name)) return [];
  if (DECORATIVE.test(n.type) || n.type === "GROUP" || n.type === "TEXT") return [];
  if (hasVisibleLabel(n, c)) return [];

  return [
    {
      rule: "icon-only-control",
      confidence: "medium",
      severity: "serious",
      title: `"${n.name}" looks interactive but carries no text label`,
      evidence: { nodeType: n.type, size: `${n.w}x${n.h}`, searched: "subtree and adjacent siblings" },
      nodeIds: [n.id],
      guidance:
        "An icon alone is ambiguous to sighted users and invisible to assistive tech. Add a visible label beside or inside it, or at minimum a tooltip and an accessible name.",
    },
  ];
}

/** State communicated by colour alone: a status-ish node with no text. */
function colorOnlyState(n: NodeMetrics, c: Ctx): Finding[] {
  if (!/status|pill|badge|health|state|dot|indicator/i.test(n.name)) return [];
  if (n.type === "TEXT") return [];
  if (hasVisibleLabel(n, c)) return [];

  return [
    {
      rule: "color-only-state",
      confidence: "medium",
      severity: "serious",
      title: `"${n.name}" communicates state with no text`,
      evidence: { nodeType: n.type, fill: n.fill ?? null, searched: "subtree and adjacent siblings" },
      nodeIds: [n.id],
      guidance:
        "Colour alone does not survive color-blindness, greyscale or a glance. Put the state in words next to the colour: Healthy, Degraded, Error.",
    },
  ];
}

const MONO_FAMILIES = /mono|menlo|consolas|courier|sFMono|jetbrains|code/i;

/**
 * Whether a string carries information a user has to read.
 *
 * ## Why this exists
 *
 * Issue #11 found a homepage where the reviewer flagged twelve 9px technical
 * labels as too small — correctly, because they were latencies and shard
 * assignments, which are operational data and not decoration. But the rule had no
 * way to tell those from a 9px caption marking a decorative boundary, so the
 * only honest-looking response was to flag every one of them and say nothing
 * about what to change.
 *
 * So text is classified, and the classification decides the minimum. An
 * identifier, a latency, a count or a status is operational: it is read, not
 * glanced at, so it must clear the readable baseline. A caption or a separator
 * label is annotation: it is texture supporting something else, so a smaller size
 * is a legitimate choice and no finding is raised.
 */
type TextRole = "operational" | "annotation";

const OPERATIONAL_HINT =
  /\b\d+(?:\.\d+)?\s*(?:ms|s|%|mb|gb|tb|k|pb|b|f|x)?\b|\d+\s*[×x]\s*[a-z0-9]+|\b(?:ok|error|warn|fail(?:ed)?|online|offline|degraded|healthy|ready|busy|idle|pending|running|stopped|primary|replica|latency|throughput|shards?|nodes?|devices?|cluster|gpu|cpu|vram|ram|memory|tokens?\/s)\b|^\s*[-#]?\s*[a-z]{2,}[-_a-z0-9]*[-_a-z0-9]+\s*$/i;

const ANNOTATION_HINT = /\b(?:axis|caption|legend|figure|table|note|footnote|section|scroll|hint|label|separator|divider|gridline)\b/i;

function classifyTextRole(content: string, name: string): TextRole {
  const text = `${name} ${content}`;
  // An annotation hint wins over an incidental digit: "Grid 12 columns" is a
  // caption, even though it contains a number.
  if (ANNOTATION_HINT.test(text)) return "annotation";
  if (OPERATIONAL_HINT.test(text)) return "operational";
  // A bare short uppercase tag ("ONLINE", "PRIMARY") is state a user reads.
  if (content.length <= 24 && /^[A-Z0-9][A-Z0-9 \-./]*$/.test(content.trim())) return "operational";
  return "annotation";
}

/**
 * Minimum size for a role.
 *
 * Operational data must be readable at 100% zoom with no effort: 11px is the
 * floor the existing rule used. Annotation may go smaller, because it is not
 * meant to be read closely — but it still gets a floor, below which it stops
 * being texture and starts being noise.
 */
const MIN_SIZE: Record<TextRole, number> = { operational: 11, annotation: 9 };

/** Technical text set below the readable minimum for its role. */
function tinyTechnicalText(n: NodeMetrics): Finding[] {
  if (n.type !== "TEXT" || !n.text) return [];
  if (n.text.size === null || n.text.size === undefined) return [];
  if (!n.text.family || !MONO_FAMILIES.test(n.text.family)) return [];

  const content = n.text.content.trim();
  if (content.length === 0) return [];

  const role = classifyTextRole(content, n.name);
  const minimum = MIN_SIZE[role];
  if (n.text.size >= minimum) return [];

  // The recommended size is the floor, not the next step up: the rule reports
  // illegibility, and silently enlarging a layer changes the layout the designer
  // measured.
  const proposed = minimum;

  return [
    {
      rule: "tiny-technical-text",
      confidence: role === "operational" ? "high" : "low",
      severity: role === "operational" ? "serious" : "minor",
      title:
        role === "operational"
          ? `Operational text at ${n.text.size}px is below the readable minimum of ${minimum}px`
          : `Annotation text at ${n.text.size}px is below the ${minimum}px floor for its role`,
      evidence: {
        size: n.text.size,
        family: n.text.family,
        minimum,
        role,
        reasoning:
          role === "operational"
            ? "this text carries data a user has to read, not decoration"
            : "this text annotates something else, so a smaller size is a legitimate choice",
        content: content.slice(0, 40),
      },
      nodeIds: [n.id],
      // A concrete fix rather than advice. The previous rule had no operation at
      // all, which is why the repair loop skipped all twelve of them.
      suggestedOperations: validated([{ type: "setTextStyle", target: n.id, fontSize: proposed }]),
      guidance:
        role === "operational"
          ? `Raise this to ${proposed}px. It is ${content.slice(0, 30)}, which a user has to read — at ${n.text.size}px it is texture, not information.`
          : `This is annotation, so ${n.text.size}px is defensible down to ${minimum}px. If it must stay smaller, consider removing it.`,
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
const EXEMPT_CARD_CONTAINERS = /topolog|map|field|graph|inspector|rail|panel|band|decision|primary-visual|hero|status-rail|split-view|cluster-field|instrument-rail/i;

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
  // Semantic downgrade (P1 false-positive fix): peers with distinct labels are
  // distinct objects (devices, models, rows) — not a generic peer-card wall.
  // A true SaaS wall repeats the same metric-card shape AND the same kind of
  // content; topology/inspector members differ by label, stroke or content.
  const peerTexts = new Set(
    peers.flatMap((p) => {
      const kids = c.childrenOf.get(p.id) ?? [];
      const own = c.byId.get(p.id)?.text?.content?.trim() ?? "";
      const kidTexts = kids.map((k) => k.text?.content?.trim() ?? "").filter((t) => t.length > 0);
      return [...(own ? [own.slice(0, 40)] : []), ...kidTexts.map((t) => t.slice(0, 40))];
    }),
  );
  const distinctContent = peerTexts.size >= peers.length;
  return [
    {
      rule: "card-wall",
      confidence: distinctContent ? "low" : "medium",
      severity: "minor",
      title: `${peers.length} bordered cards cover ${Math.round(share * 100)}% of the screen${distinctContent ? " (distinct content — likely structured members, not peers)" : ""}`,
      evidence: { cards: peers.length, areaShare: Math.round(share * 100), peerParent: parentName, peerIds: peers.slice(0, 6).map((card) => card.id).join(","), distinctLabels: peerTexts.size },
      nodeIds: peers.slice(0, 12).map((card) => card.id),
      guidance:
        "Consider converting one card cluster into a visual field, chart, topology, or open composition. Cards are containers, not content.",
    },
  ];
}

/**
 * A structural rule rather than a duplicated object.
 *
 * A 1px divider, a column guide or a hairline separator is *supposed* to repeat
 * identically — that repetition is the rhythm. Hard stress test #10 reported a
 * table's row separators as "3 identical children", which is the reviewer
 * mistaking a table for three copies of something.
 *
 * Identified by shape, not by name, because a designer names the rows "Row 1",
 * "Row 2", "Row 3" and leaves the rules named "Line". A rule is anything that
 * spans most of its container's width while being too thin to carry content.
 */
/**
 * A repeated piece of row furniture rather than a duplicated object.
 *
 * A device list repeats one green status dot and the word ONLINE per row. That
 * repetition is the design: the dot means the same thing in every row, so making
 * it different in one row would be the defect. Reporting those as duplicates
 * pushes a designer to break the rhythm, and the live retest found exactly that —
 * two duplicate-sibling groups on the homepage, both intentional row furniture.
 *
 * Identified by role and scale, not by name alone, because a designer labels rows
 * "Row 1", "Row 2", "Row 3" and leaves the furniture named "Status Dot" or
 * nothing. The distinguishing property is that the node communicates state
 * rather than content: it is small relative to its parent, or it is a short
 * repeated label.
 */
function isRowFurniture(s: NodeMetrics, parentWidth: number, parentHeight: number): boolean {
  // Explicit intent, when the layer says so.
  if (INDICATOR_NAME.test(s.name)) return true;

  // A short, repeated text label next to a status is furniture: "ONLINE",
  // "HEALTHY", "READY". Long prose is content, and three identical paragraphs are
  // worth a second look.
  if (s.type === "TEXT" && s.text?.content) {
    const content = s.text.content.trim();
    if (content.length > 0 && content.length <= 16) return true;
  }

  // Small relative to its container. An indicator is a sliver of the row it sits
  // in — a status dot is typically under a tenth of the row's shorter side.
  // The threshold is deliberately tight: at a quarter, three 100px rectangles in
  // a 400px frame qualified as furniture and the rule stopped catching real
  // duplicates, which is the worse failure of the two.
  const smallerSide = Math.min(s.w, s.h);
  if (smallerSide > 0 && parentWidth > 0 && parentHeight > 0) {
    if (smallerSide <= Math.min(parentWidth, parentHeight) * 0.12) return true;
  }
  return false;
}

const INDICATOR_NAME = /status|pill|badge|health|state|dot|indicator|chip|led|online|offline/i;

function isStructuralSeparator(s: NodeMetrics, parentWidth: number): boolean {
  const thinEnough = s.h <= 2 || s.w <= 2;
  const spansContainer = parentWidth > 0 && s.w >= parentWidth * 0.6;
  const nameSaysSo = /divider|separator|rule|stroke|hairline|guide|border|spacer/i.test(s.name);
  const noContent = !s.text?.content?.trim();
  return noContent && (nameSaysSo || (thinEnough && spansContainer));
}

/** Siblings identical in type, size, fill and content. */
function duplicateSiblings(n: NodeMetrics, c: Ctx): Finding[] {
  const siblings = c.childrenOf.get(n.id);
  if (!siblings || siblings.length < 3) return [];

  // Separators are excluded before grouping: a table's rules are not copies of
  // an object, so counting them here only ever produces a false positive.
  const candidates = siblings.filter((s) => !isStructuralSeparator(s, n.w));
  if (candidates.length < 3) return [];

  const groups = new Map<string, NodeMetrics[]>();
  for (const s of candidates) {
    // Stroke and descendant text are part of identity: nodes that differ by
    // health ring or by label are distinct objects, not copies. Without this,
    // every topology map flagged its machines as duplicates.
    const kids = c.childrenOf.get(s.id) ?? [];
    const kidText = kids.map((k) => k.text?.content ?? "").filter((t) => t.length > 0).join("|").slice(0, 120);
    const stroke = s.stroke?.hex !== undefined ? `${s.stroke.hex}/${s.stroke.weight ?? 0}` : "-";
    const key = `${s.type}|${round2(s.w)}x${round2(s.h)}|${s.fill ?? "-"}|${stroke}|${s.text?.content || kidText || "-"}`;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }

  const out: Finding[] = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    // Repeating a piece of row furniture is the design, not a copy-paste error.
    // Every member must be furniture: one real card among three dots is a finding,
    // three dots among three dots is a list.
    if (group.every((s) => isRowFurniture(s, n.w, n.h))) continue;
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
  // Visited set, like every other tree walk in this file. A metrics payload can
  // name a node as its own parent — which a root node with a stale parentId does
  // — and an unguarded recursion over that is a stack overflow in the middle of
  // a review, reported as a crash rather than as a defect.
  const visited = new Set<string>();
  const visit = (m: NodeMetrics): void => {
    if (visited.has(m.id)) return;
    visited.add(m.id);
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

/* -------------------------------------------------------------------------- */
/* Route / label collisions                                                     */
/* -------------------------------------------------------------------------- */

/** Layer names that identify a connector rather than a decorative rule. */
const ROUTE_NAME = /\broute|connector|connection|\blink\b|\bedge\b|\btrace\b|\bspan\b|\bwire\b|\bpath\b/i;
/** Types a drawn connection can take in Figma. */
const ROUTE_TYPES = new Set(["VECTOR", "LINE", "ELLIPSE", "FRAME", "RECTANGLE", "VECTOR_NETWORK"]);

/**
 * A node that reads as a route line rather than as a shape.
 *
 * A topology connection is long, thin and mostly one axis. That is a stronger
 * signal than the layer name: FigDes emits connectors as `createVector` nodes
 * called "Vector", so name matching alone would miss every line it drew itself.
 * A name that says "route" still counts even for a short one, because a designer
 * labelling something "Route A/B" has told us what it is.
 */
function isRouteLine(m: NodeMetrics): boolean {
  if (!ROUTE_TYPES.has(m.type)) return false;
  const long = Math.max(m.w, m.h);
  const thin = Math.min(m.w, m.h);
  if (ROUTE_NAME.test(m.name)) return true;
  if (long < 100) return false;
  // Thin, or a high aspect ratio: an orthogonal route is long and flat.
  return thin <= 3 || long / Math.max(1, thin) >= 8;
}

/** Area of the overlap between two boxes, or 0 when they do not touch. */
function overlapArea(a: NodeMetrics, b: NodeMetrics): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * A label sitting across a route line.
 *
 * This is the defect the live render kept showing and no rule could see: on
 * `EXO_HARD_TEST_CLUSTER_ROUTING_V03` the Mac mini's "MEMORY TOO LOW" warning
 * sat directly on the topology's horizontal route, so it read as route
 * annotation rather than as a warning about the machine. The reviewer returned
 * twelve text-style notes and nothing about it, because nothing was measuring
 * whether a label and a line occupied the same pixels (issue #12, B3 and the
 * render note: "warning placement and route-label collision need fixing").
 *
 * Reported on the label, since the label is what has to move: a line is usually
 * the one thing in a topology that must stay put.
 *
 * Confidence is medium rather than high because "reads as annotation" is a
 * judgement; the *geometry* — they overlap — is measured, and that is stated in
 * the evidence so the finding can be argued with rather than taken on trust.
 */
function textRouteCollision(n: NodeMetrics, c: Ctx): Finding[] {
  if (n.type !== "TEXT" || !n.text) return [];
  if (n.text.content.trim().length === 0) return [];
  const siblings = c.childrenOf.get(n.parentId ?? "");
  if (!siblings || siblings.length < 2) return [];

  const hits: Array<{ route: NodeMetrics; area: number }> = [];
  for (const s of siblings) {
    if (s.id === n.id || !isRouteLine(s)) continue;
    // The line has to pass *through* the label, not graze its edge.
    //
    // Testing for depth of overlap is wrong for exactly the case that matters: a
    // 2px route crossing a 16px label shares only 2px vertically, which is the
    // whole reason the first version of this rule never fired. What separates a
    // collision from a neighbour is whether the line's centre falls within the
    // label's vertical span and then runs along it — the label is *on* the line.
    const lineCentre = s.h <= s.w ? s.y + s.h / 2 : s.x + s.w / 2;
    const withinSpan = s.h <= s.w ? lineCentre >= n.y && lineCentre <= n.y + n.h : lineCentre >= n.x && lineCentre <= n.x + n.w;
    if (!withinSpan) continue;
    const overlapAlong = s.h <= s.w
      ? Math.min(n.x + n.w, s.x + s.w) - Math.max(n.x, s.x)
      : Math.min(n.y + n.h, s.y + s.h) - Math.max(n.y, s.y);
    if (overlapAlong < n.w * 0.5 && overlapAlong < n.h * 0.5) continue;
    const area = overlapArea(n, s);
    if (area <= 0) continue;
    hits.push({ route: s, area });
  }
  if (hits.length === 0) return [];

  hits.sort((a, b) => b.area - a.area);
  const worst = hits[0]!.route;
  return [
    {
      rule: "text-route-collision",
      confidence: "medium",
      severity: "serious",
      title: `"${n.text.content.slice(0, 40)}" sits across the route line "${worst.name}"`,
      evidence: {
        labelId: n.id,
        labelBox: `${Math.round(n.w)}x${Math.round(n.h)} at (${Math.round(n.x)}, ${Math.round(n.y)})`,
        routeId: worst.id,
        routeType: worst.type,
        routeBox: `${Math.round(worst.w)}x${Math.round(worst.h)} at (${Math.round(worst.x)}, ${Math.round(worst.y)})`,
        overlapPx2: Math.round(hits[0]!.area),
        collidingRoutes: hits.length,
        reasoning:
          "the label's box and the route's box occupy the same pixels, so the label reads as annotation for the connection rather than as information about the node it belongs to",
      },
      nodeIds: [n.id],
      guidance:
        "Move the label clear of the route — above or below the line, or beside its own node — or give it a surface so it separates from the line behind it. Do not move the route: it is the one element in a topology whose position carries meaning.",
    },
  ];
}

/**
 * A route that stops inside a node rather than at its edge.
 *
 * A topology connection has to say what it means at the node it reaches. If the
 * line ends *on* the boundary, the reading is unambiguous — it connects. If it
 * ends a few pixels inside, the diagram is asserting nothing: the reader cannot
 * tell whether the line terminates at the card, passes behind it, or merely
 * happens to overlap. Measured on `EXO_HARD_TEST_CLUSTER_ROUTING_V03`, three
 * routes run x=520 to x=880 while the runtime card spans x=878–1122, so all three
 * stop 2px inside it and none of them says which (issue #13).
 *
 * Reported on the line, because the line is what is ambiguous, and the fix is
 * one of: extend it to the edge, end it at the centre with an explicit
 * terminator, or move it clear of the node entirely.
 */
function connectorEndpointAmbiguous(n: NodeMetrics, c: Ctx): Finding[] {
  if (!isRouteLine(n)) return [];
  const siblings = c.childrenOf.get(n.parentId ?? "");
  if (!siblings || siblings.length < 2) return [];

  // A straight line's endpoints are the midpoints of its two short ends.
  const horizontal = n.w >= n.h;
  const ends: Array<{ x: number; y: number; side: string }> = horizontal
    ? [
        { x: n.x, y: n.y + n.h / 2, side: "left" },
        { x: n.x + n.w, y: n.y + n.h / 2, side: "right" },
      ]
    : [
        { x: n.x + n.w / 2, y: n.y, side: "top" },
        { x: n.x + n.w / 2, y: n.y + n.h, side: "bottom" },
      ];

  // One pixel of slack, so a line that lands exactly on the boundary is fine.
  const INSIDE = 1;

  // A node that *contains* the route is its container, not a connection target.
  //
  // Ancestors alone were not enough: the connector is created directly under the
  // screen frame with the region beside it, so `Topology` never appeared in the
  // ancestor chain and still got matched — "Route \"orthogonal connector n0 ->
  // n1\" ends 83px inside \"Topology\"", on the live apply.
  //
  // Containment is the precise statement: if a node's bounds hold the whole
  // route, the route was drawn inside it and can never be anchoring to it.
  // Containment also subsumes the ancestor case, so this replaces that walk.
  const contains = (s: NodeMetrics): boolean =>
    s.x <= n.x && s.y <= n.y && s.x + s.w >= n.x + n.w && s.y + s.h >= n.y + n.h;

  const hits: Array<{ node: NodeMetrics; end: { x: number; y: number; side: string }; depth: number }> = [];

  for (const end of ends) {
    for (const s of siblings) {
      if (s.id === n.id || s.type === "TEXT") continue;
      if (contains(s)) continue;
      // Only a substantial node can be an anchor. Rules and labels are furniture.
      if (s.w < 40 || s.h < 24) continue;
      const insideX = end.x > s.x + INSIDE && end.x < s.x + s.w - INSIDE;
      const insideY = end.y > s.y + INSIDE && end.y < s.y + s.h - INSIDE;
      if (!insideX || !insideY) continue;
      const depth = Math.min(end.x - s.x, s.x + s.w - end.x, end.y - s.y, s.y + s.h - end.y);
      hits.push({ node: s, end, depth });
    }
  }
  if (hits.length === 0) return [];

  const worst = hits.sort((a, b) => a.depth - b.depth)[0]!;
  return [
    {
      rule: "connector-endpoint-ambiguous",
      confidence: "medium",
      severity: "serious",
      title: `Route "${n.name}" ends ${Math.round(worst.depth)}px inside "${worst.node.name}"`,
      evidence: {
        routeId: n.id,
        routeBox: `${Math.round(n.w)}x${Math.round(n.h)} at (${Math.round(n.x)}, ${Math.round(n.y)})`,
        endpoint: `${worst.end.side} at (${Math.round(worst.end.x)}, ${Math.round(worst.end.y)})`,
        targetId: worst.node.id,
        targetBox: `${Math.round(worst.node.w)}x${Math.round(worst.node.h)} at (${Math.round(worst.node.x)}, ${Math.round(worst.node.y)})`,
        insideByPx: Math.round(worst.depth),
        endpointsAffected: hits.length,
        reasoning: "the line stops inside the node's bounds rather than at its edge, so the diagram does not say whether the route connects to it, passes behind it, or simply overlaps it",
      },
      nodeIds: [n.id, worst.node.id],
      guidance:
        "End the route on the node's edge so the connection is explicit, or terminate it at the node's centre with an arrowhead. A line that ends inside a shape reads as a mistake in whichever direction the reader happens to assume.",
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