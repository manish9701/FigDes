/**
 * Relationship semantics (point C).
 *
 * The topology compiler can place nodes and route edges that are technically
 * correct and visually meaningless — a horizontal row of machines says nothing
 * about hierarchy, direction, grouping or importance. This module computes the
 * *meaning* of a graph before anything is placed:
 *
 *   - what each node represents (status: selected, pressured, degraded…)
 *   - why each edge exists (meaning + weight: critical, major, minor)
 *   - which relationships matter most (ranks derived from focal + status)
 *   - how geometry should express that (direction, clusters, directives)
 *
 * The output feeds native composition (the model writes placement following
 * the directives) and the composition planner's primary relationships. It is
 * geometry guidance with evidence, never coordinates.
 */

export type NodeStatus = "selected" | "healthy" | "degraded" | "offline" | "pressured" | "warning" | string;
export type EdgeWeight = "critical" | "major" | "minor";

export interface RelNode {
  id: string;
  label?: string;
  status?: NodeStatus;
  group?: string;
}

export interface RelEdge {
  from: string;
  to: string;
  meaning?: string;
  weight?: EdgeWeight;
  label?: string;
}

export interface RelCluster {
  id: string;
  members: string[];
  label: string;
}

export interface RelationshipSemantics {
  focalNode: string | null;
  nodeRanks: Record<string, 1 | 2 | 3>;
  edgeRanks: Record<string, EdgeWeight>;
  clusters: RelCluster[];
  direction: "flow" | "radial" | "layered";
  directives: string[];
  warnings: string[];
}

const FLOW_HINT = /serve|feed|deploy|push|flow|send|route|replicate|stream/i;

function degree(id: string, edges: RelEdge[]): number {
  return edges.filter((e) => e.from === id || e.to === id).length;
}

/**
 * Analyzes a graph's meaning. Pure and deterministic: the same graph always
 * yields the same ranks, so a repair can cite them and a re-render can verify.
 */
export function analyzeRelationships(nodes: RelNode[], edges: RelEdge[]): RelationshipSemantics {
  const warnings: string[] = [];
  const known = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter((e) => {
    const ok = known.has(e.from) && known.has(e.to);
    if (!ok) warnings.push(`Edge '${e.from} -> ${e.to}' names an unknown node and was excluded from ranking.`);
    return ok;
  });

  // Focal: explicit selection first, then distress (pressured/degraded), then
  // the most-connected node. A field with no focal point is the finding.
  const selected = nodes.find((n) => n.status === "selected");
  const distressed = nodes.find((n) => n.status === "pressured" || n.status === "degraded" || n.status === "warning");
  const focalNode =
    selected?.id ??
    distressed?.id ??
    [...nodes].sort((a, b) => degree(b.id, validEdges) - degree(a.id, validEdges))[0]?.id ??
    null;

  const neighbours = new Set<string>();
  if (focalNode) {
    for (const e of validEdges) {
      if (e.from === focalNode) neighbours.add(e.to);
      if (e.to === focalNode) neighbours.add(e.from);
    }
  }
  const nodeRanks: Record<string, 1 | 2 | 3> = {};
  for (const n of nodes) {
    if (n.id === focalNode) nodeRanks[n.id] = 1;
    else if (neighbours.has(n.id) || n.status === "pressured" || n.status === "degraded" || n.status === "offline" || n.status === "selected") nodeRanks[n.id] = 2;
    else nodeRanks[n.id] = 3;
  }

  const edgeRanks: Record<string, EdgeWeight> = {};
  validEdges.forEach((e, i) => {
    const key = `${e.from}->${e.to}#${i}`;
    if (e.weight === "critical" || e.weight === "major" || e.weight === "minor") {
      edgeRanks[key] = e.weight;
    } else if ((focalNode && (e.from === focalNode || e.to === focalNode)) || /critical|primary|main/i.test(e.meaning ?? "")) {
      edgeRanks[key] = "major";
    } else {
      edgeRanks[key] = "minor";
    }
    // Anonymous edges warn whatever their rank: importance never excuses an
    // unexplained line. Checked separately so focal-touching edges cannot
    // escape it through the ranking above.
    if (!e.label && !e.meaning) {
      warnings.push(`Edge '${e.from} -> ${e.to}' carries no meaning: label it (latency, flow, assignment) or remove it. An unexplained line is decoration.`);
    }
  });

  const byGroup = new Map<string, string[]>();
  for (const n of nodes) {
    const g = n.group?.trim() || "ungrouped";
    byGroup.set(g, [...(byGroup.get(g) ?? []), n.id]);
  }
  const clusters: RelCluster[] = [...byGroup.entries()].map(([g, members]) => ({
    id: g,
    members,
    label: g === "ungrouped" ? "ungrouped nodes" : g,
  }));

  const meanings = validEdges.map((e) => e.meaning ?? "").join(" ");
  const direction: "flow" | "radial" | "layered" = FLOW_HINT.test(meanings)
    ? "flow"
    : focalNode && neighbours.size >= 2
      ? "radial"
      : "layered";

  const directives: string[] = [];
  if (focalNode) {
    directives.push(`'${focalNode}' is the focal node (rank 1): largest, highest contrast, placed to be found first.`);
  } else {
    directives.push("No node earns focal status: the field will read as equal dots. Name the decision's subject.");
  }
  const critical = Object.entries(edgeRanks).filter(([, w]) => w === "critical");
  if (critical.length > 0) {
    directives.push(`${critical.length} critical edge(s) (${critical.slice(0, 3).map(([k]) => k).join(", ")}): strongest stroke, always labelled, routed first.`);
  }
  const minor = Object.values(edgeRanks).filter((w) => w === "minor").length;
  if (minor > 0) {
    directives.push(`${minor} minor edge(s): thin or dashed, quiet labels — they support, never compete.`);
  }
  if (clusters.length > 1) {
    directives.push(`${clusters.length} clusters (${clusters.map((c) => `'${c.label}'`).join(", ")}): separate with whitespace (48px+), not boxes; label each cluster once.`);
  }
  directives.push(
    direction === "flow"
      ? "Direction is flow: layer ranks left-to-right so the eye follows the work."
      : direction === "radial"
        ? "Direction is radial: focal centred, rank-2 neighbours in orbit, rank-3 at the edge."
        : "Direction is layered: rank 1 top/centre, rank 2 mid-field, rank 3 subordinate.",
  );

  return { focalNode, nodeRanks, edgeRanks, clusters, direction, directives, warnings };
}

/** One-paragraph brief for a native-builder prompt: meaning before geometry. */
export function describeSemantics(s: RelationshipSemantics): string {
  const parts = [
    s.focalNode ? `Focal: '${s.focalNode}'.` : "No focal node.",
    `Direction: ${s.direction}.`,
    s.clusters.length > 1 ? `Clusters: ${s.clusters.map((c) => `${c.label} (${c.members.length})`).join(", ")}.` : "Single cluster.",
  ];
  return `${parts.join(" ")} ${s.directives.join(" ")}`;
}
