/**
 * The apply-path benchmark workload.
 *
 * A realistic screen: nested frames, auto-layout, text, rectangles, ellipses,
 * strokes and corner radii — the shape `design_runtime` emits, not a synthetic
 * loop of identical no-op operations.
 *
 * Sections are emitted in priority order and generation stops the moment the
 * requested size is reached, so a 15-operation workload really is 15 operations
 * rather than a truncated 175-op screen. A section is only ever skipped when the
 * budget runs out, never the other way round.
 */
export function screen(prefix, targetOps) {
  const ops = [];
  const push = (op) => { ops.push(op); };
  const N = (n) => `${prefix}_${n}`;
  // A group is emitted only when the whole group fits, so a section never lands
  // half-built (a card with a value but no label) and the requested size is hit
  // exactly rather than overshot at a section boundary.
  const fits = (n) => ops.length + n <= targetOps;

  push({ type: "createFrame", id: N("root"), name: "Screen", width: 1440, height: 960, fill: "#0B0B0C", layoutMode: "VERTICAL", padding: 24, itemSpacing: 16 });
  push({ type: "createFrame", id: N("nav"), parent: N("root"), name: "Nav", width: 220, height: 200, fill: "#141416", layoutMode: "VERTICAL", padding: 12, itemSpacing: 8 });
  push({ type: "createFrame", id: N("body"), parent: N("root"), name: "Body", width: 1150, height: 760, fill: "#111113", layoutMode: "VERTICAL", padding: 20, itemSpacing: 14 });

  const labels = ["Overview", "Fleet", "Models", "Usage", "Billing", "Settings", "Activity", "Members"];
  for (const [i, label] of labels.entries()) {
    if (!fits(2)) break;
    push({ type: "createFrame", id: N(`nav${i}`), parent: N("nav"), name: `Nav ${label}`, width: 196, height: 36, fill: i === 0 ? "#F2C94C" : "#1D1D20", cornerRadius: 8, layoutMode: "HORIZONTAL", padding: 10, primaryAxisAlignItems: "CENTER" });
    push({ type: "createText", id: N(`navt${i}`), parent: N(`nav${i}`), name: `Nav label ${label}`, content: label, fontSize: 13, fill: i === 0 ? "#111111" : "#C9C9CE", family: "Inter", weight: i === 0 ? 700 : 400 });
  }

  const cards = [["Active nodes", "128"], ["Healthy", "124"], ["Warnings", "3"], ["Spend today", "$41.20"], ["p95 latency", "182ms"], ["Regions", "7"]];
  for (const [i, [label, value]] of cards.entries()) {
    if (!fits(4)) break;
    push({ type: "createFrame", id: N(`card${i}`), parent: N("body"), name: `Card ${label}`, width: 270, height: 120, fill: "#16161A", cornerRadius: 12, stroke: "#26262B", strokeWeight: 1, layoutMode: "VERTICAL", padding: 16, itemSpacing: 8 });
    push({ type: "createText", id: N(`cardl${i}`), parent: N(`card${i}`), name: `Label ${label}`, content: label, fontSize: 11, fill: "#8E8E96", family: "Inter" });
    push({ type: "createText", id: N(`cardv${i}`), parent: N(`card${i}`), name: `Value ${label}`, content: value, fontSize: 24, fill: "#F5F5F7", family: "Inter", weight: 600 });
    push({ type: "createRectangle", id: N(`cardb${i}`), parent: N(`card${i}`), name: `Bar ${label}`, width: 238, height: 4, fill: "#2A2A30", cornerRadius: 2 });
  }

  if (fits(1)) push({ type: "createFrame", id: N("chart"), parent: N("body"), name: "Chart", width: 1150, height: 360, fill: "#141417", cornerRadius: 12, layoutMode: "VERTICAL", padding: 16 });
  if (fits(1)) push({ type: "createText", id: N("chartt"), parent: N("chart"), name: "Chart title", content: "Requests per hour", fontSize: 13, fill: "#C9C9CE", family: "Inter", weight: 600 });
  for (let i = 0; i < 40 && fits(1); i++) {
    push({ type: "createRectangle", id: N(`bar${i}`), parent: N("chart"), name: `Bar ${i}`, width: 40, height: 40 + ((i * 17) % 120), fill: i % 3 === 0 ? "#F2C94C" : "#3A3A42", cornerRadius: 4 });
  }
  if (fits(1)) push({ type: "createEllipse", id: N("dot"), parent: N("chart"), name: "Status dot", width: 10, height: 10, fill: "#5CD98A" });
  if (fits(1)) push({ type: "createText", id: N("foot"), parent: N("root"), name: "Footer", content: "Exo Consumer · Home", fontSize: 11, fill: "#6E6E76", family: "Inter" });

  // Top up with nested rows so the requested size is hit exactly.
  let extra = 0;
  while (ops.length < targetOps) {
    const i = extra++;
    push({ type: "createFrame", id: N(`x${i}`), parent: N("body"), name: `Row ${i}`, width: 270, height: 90, fill: "#151519", cornerRadius: 10, layoutMode: "VERTICAL", padding: 12 });
    if (fits(1)) push({ type: "createText", id: N(`xt${i}`), parent: N(`x${i}`), name: `Row text ${i}`, content: `Row ${i}`, fontSize: 12, fill: "#C9C9CE", family: "Inter" });
    if (fits(1)) push({ type: "createRectangle", id: N(`xb${i}`), parent: N(`x${i}`), name: `Row bar ${i}`, width: 200, height: 6, fill: "#2A2A30", cornerRadius: 3 });
  }
  return ops;
}
