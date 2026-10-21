/**
 * Shared screen fixtures for the layout-compilation geometry checks.
 *
 * Issue #20, workstream 2: "deterministic geometry checks with explicit
 * tolerances and fixtures for common patterns (navigation, sidebars, cards,
 * tables, forms, dialogs, dense data rows)". Before this module the scene
 * classes existed only as ad-hoc hand-built IRs scattered across the issue
 * #12/#13 matrices and the gauntlet; a new rule could not replay against a
 * stable nav/sidebar/dialog without copy-pasting someone's test.
 *
 * Every fixture is a *runtime program* (the same shape a model authors), so
 * the fixtures compile through the real compiler — not a special harness — and
 * every one is a compliant composition: they pin what "correct" resolves to.
 * The deliberately defective fixture at the end (`seeded-overlap`) is the
 * false-negative control: the checker must catch it.
 *
 * All content is marked [fixture]. Programs are deterministic: same input,
 * same boxes, every run.
 */

export const FIXTURES = {
  "navigation-rail": {
    canvas: { name: "Nav fixture", width: 1440, height: 900, grid: 8, fill: "#FFFDF9" },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 240, fill: "#111111" } },
      { fn: "hero", id: "main", args: { width: "fill", height: "fill", padding: 32, gap: 16 } },
    ],
    relations: [{ id: "main", rightOf: "nav", gap: 0, width: "fill" }],
    content: [
      { fn: "navItem", id: "n1", parent: "nav", args: { label: "Home [fixture]", state: "active" } },
      { fn: "navItem", id: "n2", parent: "nav", args: { label: "Machines [fixture]" } },
      { fn: "navItem", id: "n3", parent: "nav", args: { label: "Models [fixture]" } },
      { fn: "navItem", id: "n4", parent: "nav", args: { label: "Runs [fixture]" } },
      { fn: "sectionHeader", id: "h1", parent: "main", args: { title: "Compute [fixture]", action: "View all" } },
      { fn: "metric", id: "m1", parent: "main", args: { label: "Devices [fixture]", value: "3 [fixture]" } },
      { fn: "metric", id: "m2", parent: "main", args: { label: "Memory [fixture]", value: "312 GB [fixture]" } },
    ],
  },

  "sidebar-detail": {
    canvas: { name: "Sidebar fixture", width: 1440, height: 900, grid: 8, fill: "#FFFDF9" },
    regions: [
      { fn: "navigation", id: "nav", args: { width: 220, fill: "#111111" } },
      { fn: "hero", id: "workspace", args: { width: "fill", height: "fill", padding: 32 } },
      { fn: "inspector", id: "detail", args: { width: 360, height: "fill", padding: 24 } },
    ],
    relations: [
      { id: "workspace", rightOf: "nav", gap: 0, width: 860 },
      { id: "detail", rightOf: "workspace", gap: 0, width: 360 },
    ],
    content: [
      { fn: "navItem", id: "n1", parent: "nav", args: { label: "Machines [fixture]", state: "selected" } },
      { fn: "navItem", id: "n2", parent: "nav", args: { label: "Models [fixture]" } },
      { fn: "sectionHeader", id: "w1", parent: "workspace", args: { title: "Machine list [fixture]", action: "Filter" } },
      { fn: "modelRow", id: "r1", parent: "workspace", args: { label: "Mac Studio [fixture]", detail: "M3 Ultra 192 GB [fixture]", status: "online" } },
      { fn: "modelRow", id: "r2", parent: "workspace", args: { label: "Laptop [fixture]", detail: "96 GB [fixture]", status: "degraded" } },
      { fn: "sectionHeader", id: "d1", parent: "detail", args: { title: "Details [fixture]", action: "Close" } },
      { fn: "text", id: "t1", parent: "detail", args: { text: "192 GB unified memory [fixture]", role: "body" } },
    ],
  },

  "peer-cards": {
    canvas: { name: "Cards fixture", width: 1440, height: 900, grid: 8, fill: "#FFFDF9" },
    regions: [{ fn: "hero", id: "board", args: { width: "fill", height: "fill", padding: 32, gap: 24, columns: 2 } }],
    content: [
      { fn: "sectionHeader", id: "h1", parent: "board", args: { title: "Fleet status [fixture]", action: "View all" } },
      { fn: "panel", id: "p1", parent: "board", args: { title: "Mac Studio [fixture]", surface: "#FFFFFF" } },
      { fn: "panel", id: "p2", parent: "board", args: { title: "Laptop [fixture]", surface: "#FFFFFF" } },
      { fn: "statusPill", id: "s1", parent: "p1", args: { label: "Online [fixture]", tone: "healthy" } },
      { fn: "statusPill", id: "s2", parent: "p2", args: { label: "Degraded [fixture]", tone: "warning" } },
    ],
  },

  "data-table": {
    canvas: { name: "Table fixture", width: 1440, height: 900, grid: 8, fill: "#FFFDF9" },
    regions: [{ fn: "hero", id: "list", args: { width: "fill", height: "fill", padding: 24, gap: 12 } }],
    content: [
      { fn: "sectionHeader", id: "h1", parent: "list", args: { title: "Models [fixture]", action: "Compare" } },
      { fn: "modelRow", id: "r1", parent: "list", args: { label: "atlas-7b [fixture]", detail: "41 GB · Q4 [fixture]", status: "installed" } },
      { fn: "modelRow", id: "r2", parent: "list", args: { label: "qwen-coder [fixture]", detail: "4.4 GB · Q4 [fixture]", status: "installed" } },
      { fn: "modelRow", id: "r3", parent: "list", args: { label: "llama-70b [fixture]", detail: "140 GB · Q8 [fixture]", status: "available" } },
      { fn: "modelRow", id: "r4", parent: "list", args: { label: "phi-mini [fixture]", detail: "2.2 GB · Q4 [fixture]", status: "available" } },
    ],
  },

  "dense-rows": {
    canvas: { name: "Dense rows fixture", width: 1440, height: 900, grid: 8, fill: "#FFFDF9" },
    regions: [{ fn: "hero", id: "list", args: { width: "fill", height: "fill", padding: 8, gap: 6 } }],
    content: [
      { fn: "sectionHeader", id: "h1", parent: "list", args: { title: "Events [fixture]", action: "Export" } },
      ...Array.from({ length: 8 }, (_, i) => ({
        fn: "modelRow",
        id: `row-${i + 1}`,
        parent: "list",
        args: { label: `event-${String(i + 1).padStart(2, "0")} [fixture]`, detail: `node-0${(i % 4) + 1} [fixture]`, status: i % 3 === 0 ? "degraded" : "online" },
      })),
    ],
  },

  form: {
    canvas: { name: "Form fixture", width: 1200, height: 800, grid: 8, fill: "#FFFDF9" },
    regions: [{ fn: "hero", id: "form", args: { width: "fill", height: "fill", padding: 32, gap: 20 } }],
    content: [
      { fn: "sectionHeader", id: "h1", parent: "form", args: { title: "Add machine [fixture]", action: "Cancel" } },
      { fn: "text", id: "l1", parent: "form", args: { text: "Machine name [fixture]", role: "label" } },
      { fn: "shape", id: "f1", parent: "form", args: { shape: "rect", fill: "#FFFFFF", radius: 8 } },
      { fn: "text", id: "l2", parent: "form", args: { text: "Endpoint [fixture]", role: "label" } },
      { fn: "shape", id: "f2", parent: "form", args: { shape: "rect", fill: "#FFFFFF", radius: 8 } },
      { fn: "button", id: "save", parent: "form", args: { label: "Save machine [fixture]", variant: "primary" } },
    ],
  },

  dialog: {
    // A dialog composed as its own small canvas: title, body, actions row.
    // Regions are placed by the shell layout, so a modal overlay is out of
    // scope for a deterministic fixture — the pattern under test is the
    // dialog's own structure, contained and traceable.
    canvas: { name: "Dialog fixture", width: 800, height: 560, grid: 8, fill: "#FFFDF9" },
    regions: [{ fn: "hero", id: "dialog", args: { width: 480, height: 320, padding: 24, gap: 16, fill: "#FFFFFF" } }],
    content: [
      { fn: "sectionHeader", id: "d1", parent: "dialog", args: { title: "Remove machine? [fixture]", action: "Cancel" } },
      { fn: "text", id: "b1", parent: "dialog", args: { text: "node-02 [fixture] leaves the cluster. Models placed on it move automatically. [fixture]", role: "body" } },
      { fn: "button", id: "confirm", parent: "dialog", args: { label: "Remove [fixture]", variant: "destructive" } },
    ],
  },

};

/**
 * Review-level fixtures (issue #20, workstream 3).
 *
 * The compiler self-heals a missing relation — the rail and a `fill` region
 * resolve side by side even when the program never says so — so a *collision*
 * negative control has to live where collisions actually exist: the review
 * rules, over measured node trees. These reports are deterministic, replayable
 * fixtures for BOTH directions the issue demands: real collisions that must be
 * reported, and intentional containment/layering that must NOT be.
 *
 * Geometries are parent-local px, in the shape the plugin's walker produces.
 */
export const REVIEW_FIXTURES = {
  /**
   * DEFECT — two sibling frames covering each other, neither containing the
   * other's tree position. Must be reported with both node ids and the
   * sibling collision classification.
   */
  "sibling-overlap": {
    target: "root",
    scope: "Sibling overlap fixture",
    nodes: [
      { id: "root", name: "Root", type: "FRAME", parentId: null, x: 0, y: 0, w: 1200, h: 800, visible: true, fill: "#FFFDF9", background: "#FFFDF9" },
      { id: "card-a", name: "Ledger", type: "FRAME", parentId: "root", x: 0, y: 0, w: 400, h: 400, visible: true, fill: "#FFFFFF", background: "#FFFDF9" },
      { id: "card-b", name: "Overlay", type: "FRAME", parentId: "root", x: 200, y: 200, w: 400, h: 400, visible: true, fill: "#111111", background: "#FFFDF9" },
    ],
    nodeCount: 3,
    truncated: false,
    scanBudget: 2000,
    scan: { pageLoads: 0, pagesCached: true },
  },

  /**
   * INTENTIONAL — a full-bleed backdrop painted first, with content drawn on
   * top of it. The paint-order exception is the one legitimate overlap; it
   * must produce no sibling-overlap finding (the issue-14 regression pair,
   * carried here as the reusable fixture).
   */
  "intentional-backdrop": {
    target: "root",
    scope: "Backdrop fixture",
    nodes: [
      { id: "root", name: "Root", type: "FRAME", parentId: null, x: 0, y: 0, w: 1200, h: 800, visible: true, fill: "#FFFDF9", background: "#FFFDF9" },
      { id: "backdrop", name: "Background", type: "FRAME", parentId: "root", x: 0, y: 0, w: 1200, h: 800, visible: true, fill: "#111111", background: "#FFFDF9" },
      { id: "content", name: "Board", type: "FRAME", parentId: "root", x: 240, y: 160, w: 720, h: 480, visible: true, fill: "#FFFFFF", background: "#111111" },
    ],
    nodeCount: 3,
    truncated: false,
    scanBudget: 2000,
    scan: { pageLoads: 0, pagesCached: true },
  },

  /**
   * INTENTIONAL — text inside its card, a badge inside its avatar row: every
   * child sits within its parent's box. `overflow` and the sibling rules must
   * stay silent; containment is the normal case, not a defect.
   */
  "intentional-containment": {
    target: "root",
    scope: "Containment fixture",
    nodes: [
      { id: "root", name: "Root", type: "FRAME", parentId: null, x: 0, y: 0, w: 1200, h: 800, visible: true, fill: "#FFFDF9", background: "#FFFDF9" },
      { id: "card", name: "Model card", type: "FRAME", parentId: "root", x: 32, y: 32, w: 400, h: 200, visible: true, fill: "#FFFFFF", background: "#FFFDF9" },
      { id: "title", name: "Row title", type: "TEXT", parentId: "card", x: 16, y: 24, w: 200, h: 18, visible: true, background: "#FFFFFF", text: { content: "atlas-7b [fixture]", length: 18, truncated: false, size: 18, family: "Inter", style: "Semi Bold", color: "#111111", styled: true } },
      { id: "badge", name: "Status badge", type: "FRAME", parentId: "card", x: 16, y: 64, w: 78, h: 22, visible: true, fill: "#2D7A4D", background: "#FFFFFF" },
    ],
    nodeCount: 4,
    truncated: false,
    scanBudget: 2000,
    scan: { pageLoads: 0, pagesCached: true },
  },
};

/** Per-fixture expected invariants, asserted by the geometry test. */
export const EXPECTED = {
  "navigation-rail": {
    // The nav region must resolve as a rail: narrower than the bar/rail bar.
    navMaxWidth: Math.min(500, 1440 * 0.4),
    navId: "nav",
  },
  "data-table": { rowIds: ["r1", "r2", "r3", "r4"] },
  "dense-rows": { rowIds: Array.from({ length: 8 }, (_, i) => `row-${i + 1}`) },
  form: { fieldIds: ["f1", "f2"] },
  dialog: { dialogId: "dialog", canvas: { width: 800, height: 560 } },
  "peer-cards": { cardIds: ["p1", "p2"] },
};
