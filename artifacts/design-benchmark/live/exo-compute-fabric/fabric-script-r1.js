// EXO Compute Fabric — Pass 1+2 native build (composition + information).
// Runs inside the Figma plugin via figdes_use_figma. Builder: figdes.*,
// raw figma API where needed. All telemetry synthetic (bannered FIXTURE).
const PAPER = "#FFFDF9", INK = "#242521", GRAY = "#6F716A", FAINT = "#8A8C84";
const WHITE = "#FFFFFF", ACTION = "#0B6BCB", AMBER_BG = "#B26A001A", AMBER_TX = "#8A5200";
const RED = "#C43D2B", CARD_BR = "#E4E1D8", MONO = "JetBrains Mono";
const ids = [];
const keep = (n) => { ids.push(n.id); return n; };

const root = keep(figdes.frame({ name: "EXO Compute Fabric", width: 1440, height: 900, fill: PAPER }));

// ---- Rail (232) ----
const rail = keep(figdes.frame({ name: "Rail", parent: root, x: 0, y: 0, width: 232, height: 900, fill: INK }));
await figdes.text({ parent: rail, name: "Wordmark", text: "EXO Labs", x: 24, y: 24, size: 15, weight: 600, fill: WHITE });
await figdes.text({ parent: rail, name: "RailCaption", text: "COMPUTE", x: 24, y: 52, size: 10, weight: 500, letterSpacing: 2, fill: FAINT });
const nav = [["Topology", true], ["Models", false], ["Runs", false], ["Policies", false]];
let ny = 96;
for (const [label, active] of nav) {
  if (active) keep(figdes.rect({ name: "ActiveMarker", parent: rail, x: 0, y: ny - 4, width: 4, height: 28, fill: "#F2C94C" }));
  await figdes.text({ parent: rail, name: "Nav-" + label, text: label, x: 24, y: ny, size: 13, weight: active ? 600 : 400, fill: active ? WHITE : "#B9BBAE" });
  ny += 40;
}
await figdes.text({ parent: rail, name: "RailFoot", text: "local fabric · 5 nodes", x: 24, y: 856, size: 11, fill: FAINT });

// ---- Header (content x256) ----
await figdes.text({ parent: root, name: "ScreenTitle", text: "Inference fabric", x: 256, y: 26, size: 20, weight: 600, fill: INK });
const synPill = keep(figdes.frame({ name: "FixturePill", parent: root, x: 256, y: 56, width: 220, height: 22, fill: AMBER_BG, radius: 8 }));
await figdes.text({ parent: synPill, name: "FixtureLabel", text: "SYNTHETIC TELEMETRY", x: 8, y: 4, size: 11, weight: 500, fill: AMBER_TX });
const bnPill = keep(figdes.frame({ name: "BottleneckPill", parent: root, x: 1252, y: 26, width: 164, height: 30, fill: "#C43D2B1A", radius: 8 }));
await figdes.text({ parent: bnPill, name: "BottleneckLabel", text: "1 bottleneck", x: 12, y: 6, size: 12, weight: 600, fill: RED });

// ---- Map (256,112 824x600) ----
const map = keep(figdes.frame({ name: "TopologyField", parent: root, x: 256, y: 112, width: 824, height: 600, fill: WHITE, stroke: CARD_BR, strokeWeight: 1, radius: 12 }));
async function device(name, x, y, w, lines, strokeColor, strokeW) {
  const d = keep(figdes.frame({ name, parent: map, x, y, width: w, height: 92, fill: WHITE, stroke: strokeColor, strokeWeight: strokeW, radius: 8 }));
  let ty = 12;
  for (const [t, s, f, wt] of lines) {
    await figdes.text({ parent: d, name: name + "-" + t.slice(0, 12), text: t, x: 12, y: ty, size: s, weight: wt, family: f, fill: f === MONO ? GRAY : INK });
    ty += s + 8;
  }
  return d;
}
const hub = await device("hub-01", 44, 254, 150, [["hub-01", 12, "Inter", 600], ["1.8 TB · 78%", 11, MONO, 400]], CARD_BR, 1);
const n1 = await device("node-01", 304, 100, 160, [["node-01", 12, "Inter", 600], ["119/192 GB · 62%", 11, MONO, 400]], CARD_BR, 1);
const n2 = await device("node-02", 304, 408, 170, [["node-02 · BOTTLENECK", 12, "Inter", 600], ["90/96 GB · 94%", 11, MONO, 400]], RED, 3);
const n3 = await device("node-03", 600, 100, 150, [["node-03", 12, "Inter", 600], ["42/96 GB · 44%", 11, MONO, 400]], CARD_BR, 1);
const n4 = await device("node-04", 600, 408, 150, [["node-04", 12, "Inter", 600], ["49/96 GB · 51%", 11, MONO, 400]], CARD_BR, 1);
function link(a, b, label, color, weight, dash) {
  const ln = keep(figdes.connect(a, b, { parent: map, stroke: color, weight }));
  if (dash) { try { ln.dashPattern = dash; } catch (e) {} }
  return ln;
}
link(hub, n1, 0, "#8A8C84", 1.5); link(hub, n2, 0, RED, 2); link(n1, n3, 0, "#8A8C84", 1.5); link(n2, n4, 0, "#8A8C84", 1.5, [5, 5]);
async function edgeLabel(text, x, y) {
  await figdes.text({ parent: map, name: "Edge-" + text, text, x, y, size: 10, family: MONO, fill: GRAY });
}
await edgeLabel("12 GB/s", 232, 218);
await edgeLabel("0.5 GB/s eff.", 228, 372);
await edgeLabel("12 GB/s", 492, 218);
await edgeLabel("draining", 500, 372);

// ---- Inspector (1104,112 312x600) ----
const insp = keep(figdes.frame({ name: "BottleneckInspector", parent: root, x: 1104, y: 112, width: 312, height: 600, fill: WHITE, stroke: CARD_BR, strokeWeight: 1, radius: 12 }));
await figdes.text({ parent: insp, name: "InspTitle", text: "node-02", x: 20, y: 16, size: 16, weight: 600, fill: INK });
const dgPill = keep(figdes.frame({ name: "DegradedPill", parent: insp, x: 200, y: 16, width: 92, height: 22, fill: AMBER_BG, radius: 8 }));
await figdes.text({ parent: dgPill, name: "DegradedLabel", text: "degraded", x: 10, y: 4, size: 11, weight: 600, fill: AMBER_TX });
await figdes.text({ parent: insp, name: "WhyTitle", text: "Why it matters", x: 20, y: 56, size: 11, weight: 600, fill: GRAY });
await figdes.text({ parent: insp, name: "WhyBody", text: "Shard spill: KV cache overflows 96 GB card. Tokens wait; nothing else is saturated.", x: 20, y: 76, size: 12, fill: INK, width: 272, autoResize: "HEIGHT" });
let ry = 150;
async function row(label, value, danger) {
  await figdes.text({ parent: insp, name: "Row-" + label, text: label, x: 20, y: ry, size: 11, fill: GRAY });
  await figdes.text({ parent: insp, name: "Val-" + label, text: value, x: 20, y: ry + 18, size: 18, family: MONO, weight: 400, fill: danger ? RED : INK });
  ry += 62;
}
await row("Memory", "90/96 GB · 94%", true);
const barBg = keep(figdes.rect({ name: "MemBarBg", parent: insp, x: 20, y: ry - 14, width: 272, height: 8, fill: "#EFEDE6", radius: 4 }));
keep(figdes.rect({ name: "MemBarFill", parent: insp, x: 20, y: ry - 14, width: Math.round(272 * 0.94), height: 8, fill: RED, radius: 4 }));
await row("GPU", "97%", true);
await row("Queue depth", "38  (healthy < 4)", true);
await row("Token p99", "2.1 s  (SLO 0.4 s)", true);
await row("Throughput", "61 tok/s", false);
const verdict = keep(figdes.frame({ name: "PlacementVerdict", parent: insp, x: 20, y: ry + 6, width: 272, height: 66, fill: AMBER_BG, radius: 8 }));
await figdes.text({ parent: verdict, name: "VerdictText", text: "HOLD — do not add load. atlas-7b stays on node-02.", x: 12, y: 10, size: 12, weight: 600, fill: AMBER_TX, width: 248, autoResize: "HEIGHT" });

// ---- Decision band (256,736 1160x140) ----
const band = keep(figdes.frame({ name: "DecisionBand", parent: root, x: 256, y: 736, width: 1160, height: 140, fill: WHITE, stroke: CARD_BR, strokeWeight: 1, radius: 12 }));
const btn = keep(figdes.frame({ name: "DrainButton", parent: band, x: 24, y: 40, width: 190, height: 60, fill: INK, radius: 8 }));
await figdes.text({ parent: btn, name: "DrainLabel", text: "Drain node-02", x: 24, y: 20, size: 14, weight: 600, fill: WHITE });
await figdes.text({ parent: band, name: "Tradeoff", text: "Moves the 41 GB shard to node-01 (rises to 83%, headroom remains). ~90 s at 0.5 GB/s effective. No throughput gain claimed until pressure clears.", x: 238, y: 40, size: 12, fill: GRAY, width: 420, autoResize: "HEIGHT" });
await figdes.text({ parent: band, name: "Dismiss", text: "Dismiss", x: 238, y: 100, size: 12, weight: 500, fill: ACTION });

return { rootId: root.id, createdNodeIds: ids, nodeCount: ids.length };
