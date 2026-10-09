/**
 * Image-grounded visual findings + finding lifecycle (points B and D).
 *
 * Structural proxies (repeated sizes, bordered-surface share) can flag warning
 * signs, but they cannot tell whether a screen feels balanced or authored.
 * Only the rendered image can — and only the model looking at it can judge.
 * This module is the bookkeeping that makes that judgement reliable:
 *
 *   1. `VisualFinding`: one defect, seen in the image, with a stable id, a
 *      named area, a severity, and the node ids under that area.
 *   2. `localizeFinding`: maps a named area (canvas zones, region ids, focal)
 *      to measured node ids, so every repair targets real layers.
 *   3. `trackFindings`: compares prior findings against current ones and
 *      reports resolved / persisting / introduced with no fabricated verdicts.
 *   4. `repairForFinding`: turns a finding into a repair instruction that
 *      references the finding id and its nodes — the D-loop requirement that
 *      every repair cite a specific visual finding.
 *
 * Severity vocabulary is deliberately small: critical (blocks done), major
 * (must fix this pass), minor (polish when hierarchy holds).
 */

export type FindingSeverity = "critical" | "major" | "minor";
export type FindingStatus = "open" | "resolved";

export interface VisualFindingInput {
  /** Canvas zone, region id, or 'focal'. */
  area: string;
  defect: string;
  severity?: FindingSeverity;
}

export interface VisualFinding {
  /** Stable across renders for the same defect, so tracking works. */
  id: string;
  area: string;
  defect: string;
  severity: FindingSeverity;
  nodeIds: string[];
  repair: string;
  status: FindingStatus;
}

/** djb2: stable, tiny, deterministic. Collisions degrade to one merged finding. */
function stableId(defect: string, area: string): string {
  const s = `${area}|${defect}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `vf-${h.toString(16)}`;
}

interface Box { id: string; x: number; y: number; w: number; h: number }

/** Named canvas zones as fractions of the canvas. */
const ZONES: Record<string, { x: number; y: number; w: number; h: number }> = {
  full: { x: 0, y: 0, w: 1, h: 1 },
  top: { x: 0, y: 0, w: 1, h: 0.33 },
  bottom: { x: 0, y: 0.67, w: 1, h: 0.33 },
  left: { x: 0, y: 0, w: 0.33, h: 1 },
  right: { x: 0.67, y: 0, w: 0.33, h: 1 },
  center: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  "top-left": { x: 0, y: 0, w: 0.5, h: 0.5 },
  "top-right": { x: 0.5, y: 0, w: 0.5, h: 0.5 },
  "bottom-left": { x: 0, y: 0.5, w: 0.5, h: 0.5 },
  "bottom-right": { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
};

/**
 * Localizes a finding to measured node ids.
 *
 * `nodes` are measured boxes (id + geometry); `regions` map region ids to node
 * ids; `focalId` names the focal region. A zone area matches nodes whose
 * centre falls inside it; a region id matches that subtree; 'focal' matches
 * the focal region's nodes. Unknown areas match nothing rather than everything
 * — localizing to the whole file is how the wrong subtree gets edited.
 */
export function localizeFinding(input: {
  area: string;
  nodes: Array<{ id: string; x: number; y: number; w: number; h: number; parentId?: string | null }>;
  regions?: Array<{ id: string; nodeId?: string }>;
  focalId?: string;
  canvasW: number;
  canvasH: number;
  limit?: number;
}): string[] {
  const limit = input.limit ?? 6;
  const area = input.area.toLowerCase().trim();

  const region = (input.regions ?? []).find((r) => r.id.toLowerCase() === area);
  if (region) {
    const target = region.nodeId ?? region.id;
    const hits = input.nodes.filter((n) => n.id === target || n.parentId === target).map((n) => n.id);
    return hits.slice(0, limit);
  }

  let zone: { x: number; y: number; w: number; h: number } | null = ZONES[area] ?? null;
  if (!zone && area === "focal" && input.focalId) {
    const focal = (input.regions ?? []).find((r) => r.id === input.focalId);
    const target = focal?.nodeId ?? input.focalId;
    return input.nodes.filter((n) => n.id === target || n.parentId === target).map((n) => n.id).slice(0, limit);
  }
  if (!zone) return [];

  const rect = { x: zone.x * input.canvasW, y: zone.y * input.canvasH, w: zone.w * input.canvasW, h: zone.h * input.canvasH };
  const inside = (b: Box): boolean => {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
  };
  // A zone finding targets what is *in* the zone, not what contains it: the
  // canvas root spans every zone and would otherwise swallow all localization.
  const canvasArea = Math.max(1, input.canvasW * input.canvasH);
  const contained = (b: Box): boolean => area === "full" || (b.w * b.h) <= canvasArea * 0.8;
  return input.nodes
    .filter((n) => n.w > 0 && n.h > 0 && inside(n) && contained(n))
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .map((n) => n.id)
    .slice(0, limit);
}

/** Builds tracked findings from image-grounded inputs + measured geometry. */
export function makeFindings(input: {
  findings: VisualFindingInput[];
  nodes: Array<{ id: string; x: number; y: number; w: number; h: number; parentId?: string | null }>;
  regions?: Array<{ id: string; nodeId?: string }>;
  focalId?: string;
  canvasW: number;
  canvasH: number;
}): VisualFinding[] {
  return input.findings.map((f) => {
    const severity = f.severity ?? "major";
    const nodeIds = localizeFinding({
      area: f.area,
      nodes: input.nodes,
      ...(input.regions !== undefined ? { regions: input.regions } : {}),
      ...(input.focalId !== undefined ? { focalId: input.focalId } : {}),
      canvasW: input.canvasW,
      canvasH: input.canvasH,
    });
    const id = stableId(f.defect, f.area);
    return {
      id,
      area: f.area,
      defect: f.defect,
      severity,
      nodeIds,
      repair: repairForFinding({ id, area: f.area, defect: f.defect, severity, nodeIds }),
      status: "open" as const,
    };
  });
}

function repairForFinding(f: { id: string; area: string; defect: string; severity: FindingSeverity; nodeIds: string[] }): string {
  const where = f.nodeIds.length > 0 ? ` (${f.nodeIds.length} node(s): ${f.nodeIds.slice(0, 4).join(", ")}${f.nodeIds.length > 4 ? ", …" : ""})` : " (no measured nodes under this area — inspect first, do not guess)";
  const action =
    f.severity === "critical"
      ? "Restructure this area before anything else; polish nothing until it reads."
      : f.severity === "major"
        ? "Adjust emphasis, spacing or alignment in this area, then re-render."
        : "Polish when hierarchy holds; never before.";
  return `[${f.id}] ${f.area}: ${f.defect}${where}. ${action}`;
}

export interface FindingResolution {
  resolved: string[];
  persisting: string[];
  introduced: string[];
  summary: string;
}

/**
 * Adjudication (quality-reliability P1): a reviewer's verdict on a finding,
 * recorded WITHOUT erasing the original. Disputing a finding moves it to an
 * adjudicated list with rationale, reviewer and timestamp — the evidence is
 * retained so a wrong adjudication is itself reviewable.
 */
export type FindingDisposition = "open" | "confirmed" | "false-positive" | "intentional" | "unresolved";

export interface FindingAdjudication {
  findingId: string;
  disposition: Exclude<FindingDisposition, "open">;
  rationale: string;
  reviewer: string;
  at: number;
  /** Tested rule correction that makes this class stop firing (required for the gate to stop blocking on it). */
  ruleCorrection?: string;
}

export interface AdjudicationResult {
  /** Untouched originals, in input order. */
  findings: Array<{ id: string }>;
  /** Adjudications that matched a real finding id. */
  applied: FindingAdjudication[];
  /** Adjudications naming unknown ids — recorded, never silently dropped. */
  orphaned: FindingAdjudication[];
}

export function adjudicateFindings(
  findings: Array<{ id: string }>,
  adjudications: FindingAdjudication[],
): AdjudicationResult {
  const known = new Set(findings.map((f) => f.id));
  const applied: FindingAdjudication[] = [];
  const orphaned: FindingAdjudication[] = [];
  for (const a of adjudications) {
    (known.has(a.findingId) ? applied : orphaned).push(a);
  }
  return { findings: [...findings], applied, orphaned };
}

/**
 * Verifies whether the repair loop improved anything (point D).
 *
 * Matches by stable id: a prior finding absent now is resolved; present in
 * both is persisting; new ids are introduced. No image judgement is claimed —
 * the caller judged the render; this only tracks what the judgements say.
 */
export function trackFindings(prior: Array<{ id: string }>, current: Array<{ id: string }>): FindingResolution {
  const before = new Set(prior.map((f) => f.id));
  const after = new Set(current.map((f) => f.id));
  const resolved = [...before].filter((id) => !after.has(id));
  const persisting = [...before].filter((id) => after.has(id));
  const introduced = [...after].filter((id) => !before.has(id));
  const summary =
    resolved.length > 0 && persisting.length === 0 && introduced.length === 0
      ? `All ${resolved.length} prior finding(s) resolved with nothing new. Judge the render before calling it done.`
      : `${resolved.length} resolved, ${persisting.length} persisting, ${introduced.length} introduced. Judge the render before calling it done.`;
  return { resolved, persisting, introduced, summary };
}
