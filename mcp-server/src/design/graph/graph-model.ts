/**
 * Graph model + validation (blueprint §6.2).
 *
 * A node graph can look completely plausible while being structurally wrong,
 * so the blueprint insists on testing the data model rather than trusting the
 * picture. What existed here: missing endpoints were detected at compile time,
 * a self-loop was silently dropped, a duplicate edge became two separate
 * connectors, and a disconnected component was laid out in the forest without
 * comment. Nodes, edges, clusters and ports were not distinct semantic
 * entities — ports did not exist at all, and edges carried only coordinates,
 * so moving a node could not re-route anything.
 *
 * This module adds the model the rest of the graph code should be measured
 * against, and keeps it pure so it is testable without Figma:
 *
 * - `GraphModel` with `nodes`, `edges`, `clusters`, `ports`;
 * - edges anchored by **identity** (`fromNodeId`/`fromPortId`), never by
 *   coordinates, so `anchorEdges` can re-route after a node moves;
 * - `validateGraph` covering missing endpoints, duplicate edges, self-loops,
 *   duplicate ports, unknown clusters and disconnected components;
 * - `connectedComponents` so "is this actually one fabric?" is answerable.
 */

export interface GraphPort {
  id: string;
  nodeId: string;
  /** Position on the node, as a fraction of its box. */
  anchor: { x: number; y: number };
  side?: "top" | "right" | "bottom" | "left";
}

export interface GraphNode {
  id: string;
  /** Cluster membership, by cluster id. */
  clusterId?: string;
  /** Populated by a layout pass; edges never store this. */
  bounds?: { x: number; y: number; width: number; height: number };
  label?: string;
}

export interface GraphEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  /** Optional port identities. Resolution is by identity, never by coordinate. */
  fromPortId?: string;
  toPortId?: string;
  label?: string;
}

export interface GraphCluster {
  id: string;
  label?: string;
}

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters?: GraphCluster[];
  ports?: GraphPort[];
}

export type GraphDefectKind =
  | "missing-endpoint"
  | "duplicate-edge"
  | "self-loop"
  | "unknown-port"
  | "port-node-mismatch"
  | "unknown-cluster"
  | "disconnected-component"
  | "isolated-node"
  | "edge-without-id";

export interface GraphDefect {
  kind: GraphDefectKind;
  severity: "critical" | "high" | "medium";
  message: string;
  edgeIds: string[];
  nodeIds: string[];
}

export interface GraphValidation {
  valid: boolean;
  defects: GraphDefect[];
  /** Components, largest first. Length > 1 means the graph is not connected. */
  components: string[][];
  stats: { nodes: number; edges: number; clusters: number; ports: number; components: number; isolated: number };
}

const edgeKey = (from: string, to: string, fromPort?: string, toPort?: string): string =>
  `${from}::${fromPort ?? "*"}->${to}::${toPort ?? "*"}`;

/** Undirected duplicate detection: A→B and B→A are the same relationship. */
function undirectedKey(e: GraphEdge): string {
  const forward = `${e.fromNodeId}|${e.toNodeId}|${e.fromPortId ?? "*"}|${e.toPortId ?? "*"}`;
  const backward = `${e.toNodeId}|${e.fromNodeId}|${e.toPortId ?? "*"}|${e.fromPortId ?? "*"}`;
  return forward < backward ? forward : backward;
}

export function connectedComponents(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string[][] {
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const edge of edges) {
    if (!adjacency.has(edge.fromNodeId) || !adjacency.has(edge.toNodeId)) continue;
    adjacency.get(edge.fromNodeId)!.add(edge.toNodeId);
    adjacency.get(edge.toNodeId)!.add(edge.fromNodeId);
  }
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const queue = [node.id];
    const component: string[] = [];
    seen.add(node.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const next of adjacency.get(current) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    components.push(component.sort());
  }
  return components.sort((a, b) => b.length - a.length);
}

/**
 * Validates the whole graph. `allowSelfLoops` and `requireConnected` make the
 * policy explicit at the call site rather than buried in a heuristic — a
 * topology that legitimately allows a node to link to itself says so.
 */
export function validateGraph(graph: GraphModel, options: { allowSelfLoops?: boolean; requireConnected?: boolean } = {}): GraphValidation {
  const defects: GraphDefect[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const clusterIds = new Set((graph.clusters ?? []).map((c) => c.id));
  const ports = graph.ports ?? [];
  const portById = new Map<string, GraphPort>();
  const seenPorts = new Set<string>();

  for (const port of ports) {
    const ownerKey = `${port.nodeId}::${port.anchor.x},${port.anchor.y},${port.side ?? ""}`;
    if (seenPorts.has(ownerKey)) {
      defects.push({
        kind: "unknown-port",
        severity: "medium",
        message: `Duplicate port definition on node "${port.nodeId}" at the same anchor.`,
        edgeIds: [],
        nodeIds: [port.nodeId],
      });
    }
    seenPorts.add(ownerKey);
    portById.set(port.id, port);
    if (!nodeIds.has(port.nodeId)) {
      defects.push({
        kind: "missing-endpoint",
        severity: "critical",
        message: `Port "${port.id}" is attached to unknown node "${port.nodeId}".`,
        edgeIds: [],
        nodeIds: [port.nodeId],
      });
    }
  }

  const seenDirected = new Map<string, GraphEdge>();
  const seenUndirected = new Map<string, GraphEdge>();

  for (const edge of graph.edges) {
    if (!edge.id || edge.id.trim().length === 0) {
      defects.push({
        kind: "edge-without-id",
        severity: "high",
        message: `Edge ${edge.fromNodeId}→${edge.toNodeId} has no id, so it cannot be referenced, tracked or re-anchored.`,
        edgeIds: [],
        nodeIds: [edge.fromNodeId, edge.toNodeId],
      });
    }
    const missing: string[] = [];
    if (!nodeIds.has(edge.fromNodeId)) missing.push(edge.fromNodeId);
    if (!nodeIds.has(edge.toNodeId)) missing.push(edge.toNodeId);
    if (missing.length > 0) {
      defects.push({
        kind: "missing-endpoint",
        severity: "critical",
        message: `Edge "${edge.id || "(unnamed)"}" references unknown node(s): ${missing.join(", ")}. A connector drawn to a node that does not exist is a lie about the topology.`,
        edgeIds: [edge.id].filter(Boolean),
        nodeIds: missing,
      });
      continue;
    }
    if (edge.fromNodeId === edge.toNodeId && options.allowSelfLoops !== true) {
      defects.push({
        kind: "self-loop",
        severity: "medium",
        message: `Edge "${edge.id}" links "${edge.fromNodeId}" to itself. Pass allowSelfLoops if this relationship is real; otherwise it is a data error that would draw a zero-length connector.`,
        edgeIds: [edge.id],
        nodeIds: [edge.fromNodeId],
      });
    }
    const directed = edgeKey(edge.fromNodeId, edge.toNodeId, edge.fromPortId, edge.toPortId);
    const priorDirected = seenDirected.get(directed);
    if (priorDirected) {
      defects.push({
        kind: "duplicate-edge",
        severity: "high",
        message: `Edge "${edge.id}" duplicates "${priorDirected.id}" exactly (${edge.fromNodeId}→${edge.toNodeId}). One relationship must be one edge.`,
        edgeIds: [priorDirected.id, edge.id],
        nodeIds: [edge.fromNodeId, edge.toNodeId],
      });
    } else {
      seenDirected.set(directed, edge);
    }
    const undirected = undirectedKey(edge);
    const priorUndirected = seenUndirected.get(undirected);
    if (priorUndirected && priorUndirected.id !== edge.id) {
      defects.push({
        kind: "duplicate-edge",
        severity: "high",
        message: `Edges "${priorUndirected.id}" and "${edge.id}" express the same relationship in both directions (${edge.fromNodeId}↔${edge.toNodeId}).`,
        edgeIds: [priorUndirected.id, edge.id],
        nodeIds: [edge.fromNodeId, edge.toNodeId],
      });
    } else {
      seenUndirected.set(undirected, edge);
    }

    for (const [portId, owner] of [[edge.fromPortId, edge.fromNodeId], [edge.toPortId, edge.toNodeId]] as const) {
      if (portId === undefined) continue;
      const port = portById.get(portId);
      if (!port) {
        defects.push({
          kind: "unknown-port",
          severity: "high",
          message: `Edge "${edge.id}" references unknown port "${portId}".`,
          edgeIds: [edge.id],
          nodeIds: [owner],
        });
      } else if (port.nodeId !== owner) {
        defects.push({
          kind: "port-node-mismatch",
          severity: "critical",
          message: `Edge "${edge.id}" anchors port "${portId}" on "${edge.fromNodeId === owner ? edge.toNodeId : edge.fromNodeId}", but that port belongs to "${port.nodeId}".`,
          edgeIds: [edge.id],
          nodeIds: [port.nodeId],
        });
      }
    }
  }

  for (const node of graph.nodes) {
    if (node.clusterId !== undefined && !clusterIds.has(node.clusterId)) {
      defects.push({
        kind: "unknown-cluster",
        severity: "medium",
        message: `Node "${node.id}" claims membership in unknown cluster "${node.clusterId}".`,
        edgeIds: [],
        nodeIds: [node.id],
      });
    }
  }

  const validEdges = graph.edges.filter((e) => nodeIds.has(e.fromNodeId) && nodeIds.has(e.toNodeId));
  const components = connectedComponents(graph.nodes, validEdges);
  const linked = new Set(validEdges.flatMap((e) => [e.fromNodeId, e.toNodeId]));
  const isolated = graph.nodes.filter((n) => !linked.has(n.id)).map((n) => n.id);

  if (components.length > 1) {
    // A single isolated node beside a connected group is an island worth
    // naming; many components usually means the layout dropped edges.
    if (isolated.length === isolatedCount(components) && isolated.length <= 1 && components.length === 2) {
      defects.push({
        kind: "isolated-node",
        severity: "medium",
        message: `Node "${isolated[0]}" has no edges: it renders as a floating object with no relationship to anything.`,
        edgeIds: [],
        nodeIds: isolated,
      });
    } else {
      defects.push({
        kind: "disconnected-component",
        severity: options.requireConnected === true ? "high" : "medium",
        message: `Graph is not connected: ${components.length} component(s), sizes ${components.map((c) => c.length).join(", ")}. A disconnected sub-graph usually means edges were dropped by the layout rather than by intent.`,
        edgeIds: [],
        nodeIds: components.slice(1).flat(),
      });
    }
  }

  return {
    valid: defects.every((d) => d.severity === "medium"),
    defects,
    components,
    stats: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      clusters: (graph.clusters ?? []).length,
      ports: ports.length,
      components: components.length,
      isolated: isolated.length,
    },
  };
}

function isolatedCount(components: string[][]): number {
  return components.filter((c) => c.length === 1).length;
}

/* -------------------------------------------------------------------------- */
/* Identity-anchored edges                                                      */
/* -------------------------------------------------------------------------- */

export interface AnchoredEndpoint {
  x: number;
  y: number;
  /** How the endpoint was resolved — surfaces silent coordinate fallbacks. */
  via: "port" | "node-center" | "node-edge";
}

export interface AnchoredEdge {
  id: string;
  from: AnchoredEndpoint;
  to: AnchoredEndpoint;
  label?: string;
}

/**
 * Resolves every edge endpoint from **node identity and current bounds**, so
 * moving a node re-anchors its edges. This is the capability the connectors
 * code explicitly disclaimed as impossible in Figma — it is not impossible
 * for the model, only for the baked vector path. Keeping the anchored form
 * alongside the baked connector is what makes the relationship recoverable.
 */
export function anchorEdges(graph: GraphModel, options: { inset?: number } = {}): AnchoredEdge[] {
  const inset = options.inset ?? 0;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const portById = new Map((graph.ports ?? []).map((p) => [p.id, p]));

  const resolve = (nodeId: string, portId: string | undefined, peerCenter: { x: number; y: number } | null): AnchoredEndpoint | null => {
    const node = nodeById.get(nodeId);
    if (!node?.bounds) return null;
    const box = node.bounds;
    if (portId !== undefined) {
      const port = portById.get(portId);
      if (port && port.nodeId === nodeId) {
        return { x: box.x + port.anchor.x * box.width, y: box.y + port.anchor.y * box.height, via: "port" };
      }
    }
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (peerCenter === null) return { x: cx, y: cy, via: "node-center" };
    // Clip the centre-to-centre line to the node's edge, so the connector
    // starts at the boundary instead of running under the node.
    const dx = peerCenter.x - cx;
    const dy = peerCenter.y - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy, via: "node-center" };
    const halfW = Math.max(1, box.width / 2 - inset);
    const halfH = Math.max(1, box.height / 2 - inset);
    const scale = Math.min(halfW / Math.max(1e-6, Math.abs(dx)), halfH / Math.max(1e-6, Math.abs(dy)));
    return { x: cx + dx * scale, y: cy + dy * scale, via: "node-edge" };
  };

  const centerOf = (nodeId: string): { x: number; y: number } | null => {
    const node = nodeById.get(nodeId);
    if (!node?.bounds) return null;
    return { x: node.bounds.x + node.bounds.width / 2, y: node.bounds.y + node.bounds.height / 2 };
  };

  const out: AnchoredEdge[] = [];
  for (const edge of graph.edges) {
    const fromCenter = centerOf(edge.fromNodeId);
    const toCenter = centerOf(edge.toNodeId);
    const from = resolve(edge.fromNodeId, edge.fromPortId, toCenter);
    const to = resolve(edge.toNodeId, edge.toPortId, fromCenter);
    if (!from || !to) continue;
    const anchored: AnchoredEdge = { id: edge.id, from, to };
    if (edge.label !== undefined) anchored.label = edge.label;
    out.push(anchored);
  }
  return out;
}

/**
 * After a node moves, only that node's endpoints change. Comparing the two
 * anchored sets proves the re-route happened — and proves it did *not* touch
 * unrelated edges, which is the property Figma's baked vectors cannot give.
 */
export function movedNodeEffects(
  before: readonly AnchoredEdge[],
  after: readonly AnchoredEdge[],
  movedNodeId: string,
  graph: GraphModel,
): { changedEdgeIds: string[]; unchangedEdgeIds: string[]; incidentEdgeIds: string[] } {
  const beforeById = new Map(before.map((e) => [e.id, e]));
  const incident = new Set(
    graph.edges.filter((e) => e.fromNodeId === movedNodeId || e.toNodeId === movedNodeId).map((e) => e.id),
  );
  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const edge of after) {
    const prior = beforeById.get(edge.id);
    const same = prior !== undefined && prior.from.x === edge.from.x && prior.from.y === edge.from.y && prior.to.x === edge.to.x && prior.to.y === edge.to.y;
    if (same) unchanged.push(edge.id);
    else changed.push(edge.id);
  }
  return {
    changedEdgeIds: changed.filter((id) => incident.has(id)),
    unchangedEdgeIds: unchanged,
    incidentEdgeIds: [...incident],
  };
}
