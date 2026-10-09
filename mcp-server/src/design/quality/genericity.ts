/**
 * System 8 — Anti-Generic Design Evaluator (spec §14).
 *
 * A first-class quality gate: detects card-wall behavior, dashboard syndrome,
 * equal-weight regions, excessive rounding/borders/pills, generic spacing,
 * empty panels, repeated metrics and the generic AI aesthetic — then emits
 * targeted repairs instead of a vague "looks generic".
 *
 * Pure and deterministic: measured from boxes/operations/regions, never felt.
 */

export interface GenericityFinding {
  id: string;
  evidence: string;
  repair: string;
}

export interface GenericityReport {
  /** 0 (authored) … 100 (fully generic). */
  score: number;
  blocking: boolean;
  findings: GenericityFinding[];
  repairs: string[];
}

interface Box { id: string; x: number; y: number; w: number; h: number }
interface Op { id?: unknown; type?: string; width?: number; height?: number; stroke?: unknown; cornerRadius?: number; fill?: unknown }

/**
 * Semantic hints the callers know but bare operations do not carry.
 *
 * - `containers`: region ids whose members are layout containers, never peer
 *   cards (topology fields, inspectors), in addition to role-based exemption.
 * - `approvedTokens`: fills (hex or token names) never penalized for hue.
 *   An approved EXO semantic token is not "decorative violet" just because it
 *   is violet; unlisted accents still flag.
 */
export interface GenericitySemantics {
  containers?: string[];
  approvedTokens?: string[];
}

/**
 * Region roles whose members are layout containers, never peer cards.
 * Topology nodes, inspector sections, rails and split views are structure;
 * only unassigned content regions can form a peer-card wall. Navigation and
 * header are deliberately NOT exempt — dashboard shells stay scrutinized.
 */
const EXEMPT_CONTAINER_ROLES = new Set([
  "topology",
  "primary-visual",
  "hero",
  "inspector",
  "split-view",
  "status-rail",
]);

const GENERIC_BLOCKING = 70;

export function evaluateGenericity(input: {
  boxes: Map<string, { id: string; x: number; y: number; w: number; h: number }>;
  operations: Array<Record<string, unknown>>;
  regions: Array<{ id: string; role: string }>;
  composition?: string;
  fills?: string[];
  semantics?: GenericitySemantics;
}): GenericityReport {
  const boxes: Box[] = [...input.boxes.values()];
  const ops = input.operations as Op[];
  const findings: GenericityFinding[] = [];
  let score = 0;

  const regionById = new Map(input.regions.map((r) => [r.id, r]));
  const regionBoxById = new Map<string, Box>();
  for (const b of boxes) {
    if (regionById.has(b.id)) regionBoxById.set(b.id, b);
  }
  const extraContainers = new Set(input.semantics?.containers ?? []);

  /** Smallest region containing the box, or null when unlocated/outside. */
  const containerOf = (id: string | undefined, w: number, h: number): { id: string; role: string } | null => {
    if (typeof id !== "string" || !input.boxes.has(id)) return null;
    const b = input.boxes.get(id)!;
    let best: { id: string; role: string; area: number } | null = null;
    for (const [rid, rb] of regionBoxById) {
      if (rid === id) continue;
      if (b.x >= rb.x && b.y >= rb.y && b.x + b.w <= rb.x + rb.w && b.y + b.h <= rb.y + rb.h) {
        const area = rb.w * rb.h;
        if (!best || area < best.area) {
          const role = regionById.get(rid)?.role ?? "";
          best = { id: rid, role, area };
        }
      }
    }
    return best ? { id: best.id, role: best.role } : null;
  };

  const isExempt = (container: { id: string; role: string } | null): boolean => {
    if (!container) return false;
    return EXEMPT_CONTAINER_ROLES.has(container.role) || extraContainers.has(container.id);
  };

  // 1. Card wall: many equal PEER cards — same size, same unexempt container.
  //    Topology nodes, inspector sections and rails are structure, not peers.
  const cards = ops.filter((o) => {
    if (o.type !== "createFrame" && o.type !== "createRectangle") return false;
    const w = o.width ?? 0; const h = o.height ?? 0;
    const bordered = o.stroke !== undefined || (typeof o.cornerRadius === "number" && o.cornerRadius >= 4);
    return bordered && w > 40 && h > 24;
  });
  const peers = cards.filter((c) => {
    const id = typeof c.id === "string" ? c.id : undefined;
    return !isExempt(containerOf(id, c.width ?? 0, c.height ?? 0));
  });
  const peerGroups = new Map<string, { count: number; ids: string[] }>();
  for (const c of peers) {
    const key = `${Math.round((c.width ?? 0) / 8)}x${Math.round((c.height ?? 0) / 8)}`;
    const g = peerGroups.get(key) ?? { count: 0, ids: [] as string[] };
    g.count += 1;
    if (typeof c.id === "string") g.ids.push(c.id);
    peerGroups.set(key, g);
  }
  const biggest = [...peerGroups.values()].reduce((m, g) => Math.max(m, g.count), 0);
  if (biggest >= 3) {
    const group = [...peerGroups.entries()].find(([, g]) => g.count === biggest)!;
    score += 30;
    findings.push({
      id: "card-wall",
      evidence: `${biggest} equal peer-bordered surfaces at ${group[0]} (ids: ${group[1].ids.join(", ") || "unlocated ops"}; exempt containers excluded)`,
      repair: `Remove ${Math.max(1, biggest - 1)} cards; promote the runtime object; convert metrics into contextual annotations.`,
    });
  } else if (peers.length >= 3) {
    score += 12;
    findings.push({ id: "card-wall", evidence: `${peers.length} peer-bordered surfaces, mixed sizes`, repair: "Convert one cluster into a visual field, chart or topology." });
  }

  // 2. Dashboard syndrome: sidebar + header + metric cards + chart + table.
  const roles = new Set(input.regions.map((r) => r.role));
  const metrics = ops.filter((o) => o.type === "createText" && typeof (o as Record<string, unknown>).content === "string").length;
  if (roles.has("navigation") && roles.has("header") && metrics >= 3 && input.regions.length >= 4) {
    score += 20;
    findings.push({ id: "dashboard-syndrome", evidence: "nav + header + 3+ metrics + 4+ regions", repair: "Choose the pattern the decision needs (instrument/topology/comparison) instead of the dashboard shell." });
  }

  // 3. Equal-weight regions.
  const regionBoxes = boxes.filter((b) => input.regions.some((r) => r.id === b.id));
  if (regionBoxes.length >= 3) {
    const areas = regionBoxes.map((b) => Math.round((b.w * b.h) / 100) * 100);
    if (new Set(areas).size === 1) {
      score += 15;
      findings.push({ id: "equal-weight", evidence: "all regions identically sized", repair: "Promote one region to hero size; subordinate the rest." });
    }
  }

  // 4. Excessive rounding / borders.
  const surfaces = ops.filter((o) => (o.type === "createFrame" || o.type === "createRectangle") && o.fill !== undefined);
  const rounded = surfaces.filter((o) => typeof o.cornerRadius === "number" && o.cornerRadius > 0).length;
  if (surfaces.length > 0 && rounded >= surfaces.length && rounded >= 3) {
    score += 8;
    findings.push({ id: "excess-rounding", evidence: `${rounded}/${surfaces.length} surfaces rounded`, repair: "Flatten structural frames; reserve radius for interactive surfaces." });
  }

  // 5. Repeated metrics without visualization.
  const vectors = ops.filter((o) => o.type === "createVector").length;
  if (metrics >= 4 && vectors === 0 && (input.composition === "canvas" || input.composition === undefined)) {
    score += 10;
    findings.push({ id: "repeated-metrics", evidence: `${metrics} text readouts, no visualization`, repair: "Convert metrics into a trace, annotated topology or comparison rows." });
  }

  // 6. Generic AI aesthetic: gradients/glow/purple on neutral products.
  // Token-aware: an approved EXO semantic token is never penalized for hue —
  // only unlisted decorative accents flag.
  const approved = new Set((input.semantics?.approvedTokens ?? []).map((t) => String(t).toLowerCase()));
  const fills = (input.fills ?? []).map((f) => String(f).toLowerCase());
  const purple = fills.filter((f) => /8b5cf6|a855f7|7c3aed|9333ea|6366f1/.test(f) && !approved.has(f)).length;
  if (purple > 0) {
    score += 10;
    findings.push({ id: "ai-aesthetic", evidence: `${purple} unapproved purple/blue-violet accent fill(s)`, repair: "Use product state colour (action/health) instead of decorative violet." });
  }

  // 7. Unresolved composition.
  if (input.composition === "canvas" && input.regions.length >= 3) {
    score += 5;
    findings.push({ id: "unresolved-composition", evidence: "generic composition with 3+ regions", repair: "Name the decision; pick the pattern it needs." });
  }

  score = Math.min(100, score);
  return {
    score,
    blocking: score > GENERIC_BLOCKING,
    findings,
    repairs: [...new Set(findings.map((f) => f.repair))],
  };
}

/** Phase 9 threshold: Genericity > 70 → FAIL. Calibrate via benchmarks, not vibes. */
export const GENERICITY_FAIL_AT = 70;
