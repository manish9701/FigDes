/**
 * System 6 — Visual Grammar Engine, pattern library (spec §12).
 *
 * FigDes understands primitives; it needs to understand design patterns. Each
 * pattern is reusable composition judgement (purpose, focal strategy, hierarchy
 * / geometry / spacing rules, density, relationships, anti-patterns) without
 * being a rigid template.
 */

export type PatternDensity = "sparse" | "balanced" | "dense";

export interface VisualPattern {
  id: string;
  name: string;
  purpose: string;
  suitableFor: string[];
  focalStrategy: string;
  hierarchyRules: string[];
  geometryRules: string[];
  spacingRules: string[];
  density: PatternDensity;
  allowedComponents: string[];
  relationshipRules: string[];
  antiPatterns: string[];
  examples?: string[];
}

export const VISUAL_PATTERNS: VisualPattern[] = [
  {
    id: "spatial-topology",
    name: "SpatialTopology",
    purpose: "Show relationships between physical devices, runtime processes, models and workloads.",
    suitableFor: ["topology", "fleet connectivity", "weak-link analysis", "placement decisions"],
    focalStrategy: "One dominant focal node; supporting nodes positioned spatially around it.",
    hierarchyRules: ["Focal node largest and highest contrast", "clusters read before members", "labels support, never define, relationships"],
    geometryRules: ["Open field, no card grid", "distance encodes affinity", "connectors routed and labelled"],
    spacingRules: ["Whitespace separates clusters, not boxes", "32px+ around focal object", "tight within clusters"],
    density: "balanced",
    allowedComponents: ["deviceNode", "topologyMap", "statusPill", "connector"],
    relationshipRules: ["Every edge labelled (latency, flow, assignment)", "unlabeled lines are decoration and must go"],
    antiPatterns: ["equal-sized cards", "card grid", "unlabeled connector spaghetti", "boxed node grid"],
    examples: ["EXO compute topology", "fleet connectivity"],
  },
  {
    id: "monitoring-instrument",
    name: "MonitoringInstrument",
    purpose: "Watch live state over time with traces, states and one intervention point.",
    suitableFor: ["monitor", "runtime telemetry", "health tracking", "throughput"],
    focalStrategy: "One continuous primary signal surface owns the canvas.",
    hierarchyRules: ["Live signal first", "status rail at a glance", "underlying data beneath, subordinate"],
    geometryRules: ["Continuous instrument surface before cards", "aligned readouts", "rails and traces"],
    spacingRules: ["Status rail compact (56-64px)", "24px between signal and data", "no card stacks"],
    density: "balanced",
    allowedComponents: ["metric", "statusPill", "chart", "eventRow", "button"],
    relationshipRules: ["Signal-to-source traceable", "state markers on the trace, not beside it"],
    antiPatterns: ["KPI card walls", "static dashboards pretending to be live", "multiple competing rails"],
  },
  {
    id: "object-inspector",
    name: "ObjectInspector",
    purpose: "Understand one object deeply with surrounding state that gives it meaning.",
    suitableFor: ["inspect", "device detail", "model detail", "diagnosis"],
    focalStrategy: "The subject gets the largest uninterrupted surface.",
    hierarchyRules: ["Subject first", "context frames, never competes", "actions subordinate to understanding"],
    geometryRules: ["Subject:primary surface 2x context", "context in one rail", "no equal-weight side panels"],
    spacingRules: ["32px around subject", "24px gaps to context", "dense inside inspector rows"],
    density: "balanced",
    allowedComponents: ["sectionHeader", "statusPill", "metric", "button", "modelRow"],
    relationshipRules: ["Context rows reference the subject explicitly", "no orphaned panels"],
    antiPatterns: ["raw specification dumps", "equal-weight side panels"],
  },
  {
    id: "configuration-workbench",
    name: "ConfigurationWorkbench",
    purpose: "Set something with the effect visible beside the control — never a leap of faith.",
    suitableFor: ["configure", "policy editing", "deployment setup"],
    focalStrategy: "The consequence preview is the visual headline; controls stay quiet.",
    hierarchyRules: ["Preview first", "controls in one readable column", "commit action unambiguous"],
    geometryRules: ["Controls fixed 480px column", "preview fills the rest", "order reads as sequence"],
    spacingRules: ["16px between controls", "24px to preview", "blast-radius callout near commit"],
    density: "balanced",
    allowedComponents: ["input", "toggle", "button", "preview", "sectionHeader"],
    relationshipRules: ["Every control maps to a visible preview change", "consequence-free toggles forbidden"],
    antiPatterns: ["wizard card stacks", "controls with no live consequence preview", "settings mazes"],
  },
  {
    id: "editorial-focus",
    name: "EditorialFocus",
    purpose: "Make one decision obvious through scale, typography and whitespace.",
    suitableFor: ["announcement", "verdict", "recommendation", "model fit decision"],
    focalStrategy: "Oversized focal region with offset supporting context; no equal-width grid.",
    hierarchyRules: ["Headline decides", "evidence subordinate", "one action"],
    geometryRules: ["Focal 55%+ of canvas", "supporting context offset, never mirrored", "typography does hierarchy work, not borders"],
    spacingRules: ["Generous whitespace as the hierarchy", "compressed supporting clusters", "no uniform gaps"],
    density: "sparse",
    allowedComponents: ["heading", "body", "button", "statusPill"],
    relationshipRules: ["Evidence points at the verdict", "no competing panels"],
    antiPatterns: ["three equal cards", "marketing-card grid", "decorative symmetry"],
  },
  {
    id: "comparison-field",
    name: "ComparisonField",
    purpose: "Choose between options or read differences as differences.",
    suitableFor: ["select", "compare", "model choice", "regression review"],
    focalStrategy: "Options aligned on identical structure; the meaningful difference is dominant.",
    hierarchyRules: ["Compared rows read across", "verdict column unmissable", "detail beside, subordinate"],
    geometryRules: ["Two subjects side by side on identical structure", "aligned rows, not cards", "one verdict treatment"],
    spacingRules: ["Tight row rhythm (12px)", "24px between subjects", "verdict separated by weight, not distance"],
    density: "balanced",
    allowedComponents: ["modelRow", "table", "statusPill", "button"],
    relationshipRules: ["Same schema both sides", "differences highlighted, similarities quiet"],
    antiPatterns: ["marketing cards", "decorative symmetry without semantic comparison", "single numbers without history"],
  },
  {
    id: "relationship-graph",
    name: "RelationshipGraph",
    purpose: "Reveal structure in connected data where position carries meaning.",
    suitableFor: ["dependencies", "shard assignment", "model placement", "lineage"],
    focalStrategy: "Selected node + its edges dominate; the rest recedes.",
    hierarchyRules: ["Selected neighbourhood first", "secondary hops visually quieter", "labels on edges, names on nodes"],
    geometryRules: ["Force/cluster layout", "edge paths routed, crossings minimized", "no boxed lists pretending to be graphs"],
    spacingRules: ["Breathing room along edges", "labels offset from lines", "clusters separated by space"],
    density: "balanced",
    allowedComponents: ["deviceNode", "connector", "statusPill"],
    relationshipRules: ["Placement encodes assignment", "memory budget / fit verdict near the selection"],
    antiPatterns: ["node lists without edges", "unlabeled lines", "manual shard dragging as default"],
  },
  {
    id: "timeline-flow",
    name: "TimelineFlow",
    purpose: "Order events, deployments or activity along a single axis.",
    suitableFor: ["activity", "audit", "deployments", "event review"],
    focalStrategy: "The axis is the hero; items hang off it in density order.",
    hierarchyRules: ["Time order is the hierarchy", "needs-follow-up items surfaced", "filters before listing"],
    geometryRules: ["Single horizontal or vertical axis", "dense scannable rows", "no undifferentiated log dumps"],
    spacingRules: ["12px row rhythm", "group gaps at day/deploy boundaries", "detail pane fixed, not inline"],
    density: "dense",
    allowedComponents: ["eventRow", "filter", "statusPill", "detail"],
    relationshipRules: ["Each row links to actor + cause", "selection opens detail, never navigates away"],
    antiPatterns: ["raw log dumps", "undifferentiated logs", "prose documentation pages"],
  },
  {
    id: "command-surface",
    name: "CommandSurface",
    purpose: "Act on a subset: bulk selection with group actions and visible scope.",
    suitableFor: ["fleet management", "bulk actions", "pool rebalance"],
    focalStrategy: "Selection scope + primary action dominate; the roster stays scannable.",
    hierarchyRules: ["Scope first (what is selected)", "action second", "roster third"],
    geometryRules: ["Filters top", "roster as dense field", "actions pinned, always visible"],
    spacingRules: ["Compact command bar", "12px roster rhythm", "totals row anchored"],
    density: "dense",
    allowedComponents: ["filter", "table", "button", "statusPill"],
    relationshipRules: ["Actions show affected count", "no destructive action without scope confirmation"],
    antiPatterns: ["one screen per machine", "tables without totals", "hidden consequences"],
  },
  {
    id: "data-workspace",
    name: "DataWorkspace",
    purpose: "Work with dense data: filter, scan, compare, act — without page-hopping.",
    suitableFor: ["explore", "fleet", "team", "capacity planning"],
    focalStrategy: "The result field dominates; filters and detail frame it.",
    hierarchyRules: ["Results scannable at a glance", "filters narrow before listing", "detail on selection"],
    geometryRules: ["Filters 64px strip", "results fill", "detail 360px rail", "density before containers"],
    spacingRules: ["12px result rhythm", "16px filter padding", "24px to detail"],
    density: "dense",
    allowedComponents: ["filter", "table", "statusPill", "button"],
    relationshipRules: ["Filter state visible in results header", "bulk selection where actions exist"],
    antiPatterns: ["card galleries where rows scan better", "empty decorative heroes"],
  },
  {
    id: "canvas-workspace",
    name: "CanvasWorkspace",
    purpose: "Create: a work surface with the actions that apply to the current selection.",
    suitableFor: ["author", "compose", "provision", "policy canvas"],
    focalStrategy: "The work surface is the screen; controls frame it.",
    hierarchyRules: ["Canvas first", "selection actions second", "chrome minimal"],
    geometryRules: ["Canvas fills", "controls 320px rail", "no settings-card workspace"],
    spacingRules: ["32px canvas padding", "24px control gaps", "toolbar quiet"],
    density: "balanced",
    allowedComponents: ["canvas", "button", "input", "sectionHeader"],
    relationshipRules: ["Controls always reflect selection", "no orphaned toolbars"],
    antiPatterns: ["toolbar-heavy chrome", "settings-card workspace"],
  },
  {
    id: "object-detail",
    name: "ObjectDetail",
    purpose: "One location, site or pool: is it healthy, and what needs action?",
    suitableFor: ["site", "pool", "device group", "capacity headroom"],
    focalStrategy: "Subject hero with roster + alerts in orbit.",
    hierarchyRules: ["Health verdict first", "roster second", "alerts third"],
    geometryRules: ["Subject surface dominant", "roster dense", "recommendation callout near verdict"],
    spacingRules: ["Headroom signal large", "growth trend beneath", "recommendation separated by weight"],
    density: "balanced",
    allowedComponents: ["metric", "statusPill", "table", "button"],
    relationshipRules: ["Roster rows link to members", "totals always present"],
    antiPatterns: ["fleet views scoped by accident", "gauges without numbers", "tables without totals"],
  },
  {
    id: "exploration-surface",
    name: "ExplorationSurface",
    purpose: "Find something: narrowing filters above a dense, scannable field.",
    suitableFor: ["search", "browse", "API explorer", "audit trail"],
    focalStrategy: "The field of results is the content; the filter strip is chrome.",
    hierarchyRules: ["Filters orient", "results answer", "detail confirms"],
    geometryRules: ["Filter strip 64px", "results dense field", "code sample / detail beside selection"],
    spacingRules: ["12px result rhythm", "endpoint + sample aligned", "auth state always visible"],
    density: "dense",
    allowedComponents: ["filter", "table", "button", "codeSample"],
    relationshipRules: ["Selection previews without navigation", "copy affordance on the right call"],
    antiPatterns: ["prose documentation pages", "settings mazes"],
  },
];
