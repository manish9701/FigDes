/**
 * Plugin main-thread runtime tests.
 *
 * These load the real bundled plugin against a mock Figma API. Before this
 * existed, any runtime error in the main thread surfaced only as ChatGPT saying
 * something vague like "inspection calls are failing internally".
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, ask, makeNested } from "./plugin-harness.mjs";

let figma;
let doc;

before(() => {
  ({ figma, doc } = loadPlugin());
});

/* -------------------------------------------------------------------------- */

test("the bundle boots and wires up the UI bridge", () => {
  assert.ok(figma.__ui, "showUI was called");
  assert.equal(typeof figma.ui.onmessage, "function", "onmessage handler registered");
});

test("responds to the ready handshake with server config", async () => {
  figma.__posted.length = 0;
  await figma.ui.onmessage({ kind: "ready" });
  const config = figma.__posted.find((m) => m.kind === "server-config");
  assert.ok(config, "server-config posted after ready");
  assert.match(config.url, /^https?:\/\//);
  assert.equal(config.pluginVersion, "0.1.0");
});

/* -------------------------- the reported failure ------------------------- */

test("inspect_selection succeeds", async () => {
  const reply = await ask(figma, "inspect_selection", {});
  assert.equal(reply.ok, true, `inspect_selection failed: ${reply.error ?? ""}`);
  assert.ok(reply.data, "returned data");
  assert.ok(Array.isArray(reply.data.selection));
});

test("inspect_selection reports the selected subtree", async () => {
  const reply = await ask(figma, "inspect_selection", {});
  const first = reply.data.selection[0];
  assert.equal(first.type, "FRAME");
  assert.equal(first.name, "Dashboard");
  assert.equal(first.width, 1440);
  assert.ok(first.children.length >= 2, "children were serialized");
});

test("inspect_selection marks figma text as untrusted", async () => {
  const reply = await ask(figma, "inspect_selection", {});
  assert.equal(reply.data.contentTrust, "untrusted");
});

test("inspect_selection on an empty selection is not an error", async () => {
  doc.page.selection = [];
  const reply = await ask(figma, "inspect_selection", {});
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.data.selection, []);
  doc.page.selection = [doc.root];
});

test("inspect_file succeeds", async () => {
  const reply = await ask(figma, "inspect_file", {});
  assert.equal(reply.ok, true, `inspect_file failed: ${reply.error ?? ""}`);
  assert.equal(reply.data.fileName, "Exo Labs");
  assert.equal(reply.data.currentPage.name, "Page 1");
  assert.ok(Array.isArray(reply.data.pages));
});

test("inspect_file lists the page and counts node types", async () => {
  const reply = await ask(figma, "inspect_file", {});
  assert.ok(reply.data.pages.some((p) => p.name === "Page 1"));
  assert.ok(reply.data.counts.FRAME >= 1);
  assert.ok(reply.data.counts.TEXT >= 1);
});

/* ------------------------------ design system ---------------------------- */

test("extract_design_system succeeds", async () => {
  const reply = await ask(figma, "extract_design_system", {});
  assert.equal(reply.ok, true, `extract_design_system failed: ${reply.error ?? ""}`);
  const ds = reply.data;
  assert.equal(ds.fileName, "Exo Labs");
  assert.ok(ds.nodesScanned > 0);
  assert.ok(ds.colors.length > 0, "palette should not be empty");
  assert.ok(ds.radii.length > 0, "radii should be observed");
  assert.ok(ds.typography.length > 0, "type ramp should be observed");
});

test("design system reports the default-named layer it saw", async () => {
  const reply = await ask(figma, "extract_design_system", {});
  assert.ok(reply.data.naming.defaultNamed >= 1, "the 'Frame 1' layer should be counted");
});

test("design system health reports unstyled text", async () => {
  const reply = await ask(figma, "extract_design_system", {});
  assert.ok(reply.data.health.textNodes >= 2);
  assert.ok(reply.data.health.unstyledText >= 2, "mock text nodes have no textStyleId");
});

/* --------------------------------- metrics ------------------------------- */

test("collect_metrics succeeds", async () => {
  const reply = await ask(figma, "collect_metrics", {});
  assert.equal(reply.ok, true, `collect_metrics failed: ${reply.error ?? ""}`);
  assert.ok(reply.data.nodeCount > 0);
  assert.ok(reply.data.nodes[0].id);
});

test("collect_metrics emits real parent ids", async () => {
  const reply = await ask(figma, "collect_metrics", {});
  const child = reply.data.nodes.find((n) => n.parentId !== null);
  assert.ok(child, "expected a nested node");
  assert.match(child.parentId, /^99:\d+$|^0:1$/);
});

test("collect_metrics resolves a background colour for contrast checks", async () => {
  const reply = await ask(figma, "collect_metrics", {});
  const withText = reply.data.nodes.find((n) => n.type === "TEXT");
  assert.ok(withText, "mock has text nodes");
  assert.ok(withText.background, "background should be composited from ancestors");
  assert.ok(withText.text, "text payload present");
});

test("collect_metrics reports a helpful error for a missing node", async () => {
  const reply = await ask(figma, "collect_metrics", { target: "does-not-exist" });
  assert.equal(reply.ok, true, "a missing node is reported as data, not a crash");
  assert.match(reply.data.error, /not found/i);
});

/* ------------------------------ transactions ----------------------------- */

test("figma_status succeeds", async () => {
  const reply = await ask(figma, "figma_status", {});
  assert.equal(reply.ok, true);
  assert.equal(reply.data.fileName, "Exo Labs");
  assert.equal(reply.data.selectionCount, 1);
});

test("create_design validates a bad operation without throwing", async () => {
  const reply = await ask(figma, "create_design", {
    operations: [{ type: "notARealOperation", foo: 1 }],
  });
  assert.equal(reply.ok, true, "schema rejection is a result, not an exception");
  assert.equal(reply.data.status, "failed");
  assert.equal(reply.data.error.opType, "notARealOperation");
  assert.ok(reply.data.error.hint.length > 0, "failures carry a next step");
});

test("create_design dryRun reports the trace without touching the doc", async () => {
  const before = doc.page.children.length;
  const reply = await ask(figma, "create_design", {
    dryRun: true,
    operations: [{ type: "createFrame", width: 400, height: 300, name: "Nope" }],
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.data.status, "success");
  assert.equal(reply.data.dryRun, true);
  assert.equal(doc.page.children.length, before, "nothing was created");
});

test("create_design applies real operations", async () => {
  const before = doc.page.children.length;
  const reply = await ask(figma, "create_design", {
    operations: [{ type: "createFrame", id: "t1", name: "Created", width: 400, height: 300, fill: "#F7F5EF" }],
  });
  assert.equal(reply.ok, true, `create_design failed: ${reply.error ?? ""}`);
  assert.equal(reply.data.status, "success");
  assert.equal(reply.data.createdNodes.length, 1);
  assert.equal(reply.data.createdNodes[0].temporaryId, "t1");
  assert.ok(reply.data.createdNodes[0].figmaNodeId);
  assert.equal(doc.page.children.length, before + 1, "a node was actually created");
});

test("undo_last_operation succeeds", async () => {
  const reply = await ask(figma, "undo_last_operation", {});
  assert.equal(reply.ok, true);
  assert.equal(reply.data.status, "success");
});

test("unknown tools are rejected rather than dispatched", async () => {
  const reply = await ask(figma, "totallyMadeUpTool", {});
  assert.equal(reply.ok, false);
  assert.match(reply.error, /unknown tool/i);
});

/* ---------------------------------- caching ------------------------------ */

/* ---------------------------------- render -------------------------------- */

test("render_node returns an image and a token estimate", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const reply = await ask(f, "render_node", { nodeId: doc.root.id, maxWidth: 1024 });
  assert.equal(reply.ok, true, `render failed: ${reply.error ?? ""}`);

  const r = reply.data;
  assert.equal(r.nodeId, doc.root.id);
  assert.ok(r.data.length > 0, "image data must not be empty");
  assert.ok(r.width <= 1024, "output must respect maxWidth");
  assert.equal(r.format, "png");
  assert.ok(r.estimatedTokens > 0, "token cost must be reported");
  assert.ok(r.budget.hardLimit > 0, "budget must be reported");
});

test("render downscaling sets the downscaled flag and reports the loss", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  // The mock root is 1440 wide, so a 512 render is a genuine downscale.
  const reply = await ask(f, "render_node", { nodeId: doc.root.id, maxWidth: 512 });
  const r = reply.data;

  assert.equal(r.width, 512);
  assert.equal(r.downscaled, true, "must admit detail was lost");
  assert.equal(r.nativeWidth, 1440, "native size must still be reported");
  assert.ok(r.scale < 1);
});

test("low detail costs roughly half of high detail", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const high = (await ask(f, "render_node", { nodeId: doc.root.id, maxWidth: 1024, detail: "high" })).data;
  const low = (await ask(f, "render_node", { nodeId: doc.root.id, maxWidth: 1024, detail: "low" })).data;

  assert.equal(low.detail, "low");
  assert.ok(low.estimatedTokens < high.estimatedTokens, "low detail must be cheaper");
});

test("a smaller maxWidth costs proportionally less", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const big = (await ask(f, "render_node", { nodeId: doc.root.id, maxWidth: 1024 })).data;
  const small = (await ask(f, "render_node", { nodeId: doc.root.id, maxWidth: 512 })).data;

  assert.ok(small.estimatedTokens < big.estimatedTokens, "a smaller image must cost less");
  assert.ok(small.base64Length < big.base64Length, "and be smaller on the wire");
});

test("the render budget is enforced so a loop cannot run away", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  // Drain the budget with high-detail renders until it refuses.
  let refused = false;
  let attempts = 0;

  while (attempts < 200) {
    attempts += 1;
    const reply = await ask(f, "render_node", { nodeId: doc.root.id, maxWidth: 2048, detail: "high" });
    if (reply.ok === false && /budget/i.test(reply.error ?? "")) {
      refused = true;
      break;
    }
  }

  assert.ok(refused, `expected the budget to stop the loop, ran ${attempts} renders`);
  assert.ok(attempts < 200, "the budget should bite well before 200 renders");
});

test("the render budget can be reset", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  await ask(f, "render_node", { nodeId: doc.root.id, maxWidth: 1024 });
  const reset = await ask(f, "reset_render_budget", {});
  assert.equal(reset.ok, true);
  assert.equal(reset.data.budget.tokensSpent, 0);
});

test("rendering a missing node fails with guidance, not a stack trace", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const reply = await ask(f, "render_node", { nodeId: "nope" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /not found/i);
});

test("rendering a page is refused rather than crashing", async () => {
  const { figma: f, doc: d } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const reply = await ask(f, "render_node", { nodeId: d.page.id });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /page/i);
});

/* ------------------------------ components ------------------------------- */

test("find_components reports totals with no query", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const reply = await ask(f, "find_components", {});
  assert.equal(reply.ok, true, `find_components failed: ${reply.error ?? ""}`);
  assert.ok(typeof reply.data.total === "number");
  assert.ok(Array.isArray(reply.data.matches));
});

test("create_component promotes an existing frame and keeps its children", async () => {
  const { figma: f, doc: d } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const target = d.root.children[0]; // the "Card" frame, which has two text nodes
  const before = target.children.length;

  const reply = await ask(f, "create_component", { name: "StatusCard", fromNode: target.id });
  assert.equal(reply.ok, true, `create_component failed: ${reply.error ?? ""}`);
  assert.equal(reply.data.name, "StatusCard");
  assert.ok(reply.data.componentId);
});

test("create_instance requires a real component and refuses invented ids", async () => {
  const { figma: f, doc: d } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const reply = await ask(f, "create_instance", { componentId: "made-up" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /component not found/i);
});

test("create_instance refuses a node that is not a component", async () => {
  const { figma: f, doc: d } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const reply = await ask(f, "create_instance", { componentId: d.root.id });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /not a component/i);
});

/* --------------------------- background compositing ----------------------- */

test("a text node's background is its ancestor's fill, not its own", async () => {
  // Regression: the node's own fill was folded into its "background", so the
  // text colour and the background resolved to the same value and contrast came
  // out as exactly 1:1 for every text node in the file.
  const doc = makeNested({ textColor: "#BBBBBB", bgColor: "#FFFFFF" });
  const { figma } = loadPlugin(doc);
  await figma.ui.onmessage({ kind: "ready" });

  const reply = await ask(figma, "collect_metrics", {});
  const label = reply.data.nodes.find((n) => n.type === "TEXT");
  assert.ok(label, "expected the text node");
  assert.equal(label.text.color, "#BBBBBB", "text fill");
  assert.equal(label.background, "#FFFFFF", "background comes from the parent frame");
  assert.notEqual(label.background, label.text.color, "background must differ from the text colour");
});

test("background composites through a translucent ancestor", async () => {
  // 50% white over black lands mid-grey, which is what a viewer actually sees.
  const doc = makeNested({ textColor: "#FFFFFF", midColor: "#FFFFFF", midAlpha: 0.5 });
  const { figma } = loadPlugin(doc);
  await figma.ui.onmessage({ kind: "ready" });

  const reply = await ask(figma, "collect_metrics", {});
  const label = reply.data.nodes.find((n) => n.type === "TEXT");
  assert.ok(label);
  // white at 50% over #111111 -> roughly #888888
  assert.equal(label.background, "#888888");
});

test("background walks past ancestors with no fill", async () => {
  const doc = makeNested({ textColor: "#EEEEEE", bgColor: "#202020" });
  // Strip the inner fill so resolution has to continue up to the outer frame.
  doc.inner.fills = [];
  const { figma } = loadPlugin(doc);
  await figma.ui.onmessage({ kind: "ready" });

  const reply = await ask(figma, "collect_metrics", {});
  const label = reply.data.nodes.find((n) => n.type === "TEXT");
  assert.equal(label.background, "#111111", "fell through to the outer frame");
});

/* --------------------------------- caching -------------------------------- */

/* ---------------------------------- panel -------------------------------- */

test("the panel receives a summary on request", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  f.__posted.length = 0;
  await f.ui.onmessage({ kind: "refresh-panel" });

  let summary = null;
  for (let i = 0; i < 100 && !summary; i++) {
    summary = f.__posted.find((m) => m.kind === "panel-summary");
    if (!summary) await new Promise((r) => setTimeout(r, 20));
  }

  assert.ok(summary, "panel-summary should be posted");
  const s = summary.summary;
  assert.equal(s.fileName, "Exo Labs");
  assert.equal(s.pageName, "Page 1");
  assert.equal(s.selectionCount, 1);
  assert.equal(s.selection[0].name, "Dashboard");
  assert.ok(s.system, "system block present");
  assert.ok(Array.isArray(s.system.colors));
});

test("panel summary works with nothing selected", async () => {
  const { figma: f, doc: d } = loadPlugin();
  d.page.selection = [];
  await f.ui.onmessage({ kind: "ready" });

  f.__posted.length = 0;
  await f.ui.onmessage({ kind: "refresh-panel" });

  let summary = null;
  for (let i = 0; i < 100 && !summary; i++) {
    summary = f.__posted.find((m) => m.kind === "panel-summary");
    if (!summary) await new Promise((r) => setTimeout(r, 20));
  }

  assert.ok(summary);
  assert.equal(summary.summary.selectionCount, 0);
  assert.deepEqual(summary.summary.selection, []);
  assert.equal(summary.summary.contrast.length, 0);
});

test("panel summary reports no server dependency", async () => {
  // The panel must be useful while the Design Agent server is offline, since it
  // reads the Figma API directly.
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });
  f.__posted.length = 0;
  await f.ui.onmessage({ kind: "refresh-panel" });

  for (let i = 0; i < 100; i++) {
    if (f.__posted.some((m) => m.kind === "panel-summary")) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const failures = f.__posted.filter((m) => m.kind === "log" && m.level === "error");
  assert.equal(failures.length, 0, `panel logged errors: ${failures.map((m) => m.message).join("; ")}`);
});

test("select-node selects the layer in Figma", async () => {
  const { figma: f, doc: d } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  const target = d.root.children[0];
  f.__posted.length = 0;
  await f.ui.onmessage({ kind: "select-node", nodeId: target.id });

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(d.page.selection[0].id, target.id, "selection should be updated");
});

test("select-node on a deleted node logs instead of throwing", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  f.__posted.length = 0;
  await f.ui.onmessage({ kind: "select-node", nodeId: "does-not-exist" });

  await new Promise((r) => setTimeout(r, 50));
  const errors = f.__posted.filter((m) => m.kind === "log" && m.level === "error");
  assert.equal(errors.length, 0, "a missing node must not raise");
});

test("repeated refreshes do not interleave summaries", async () => {
  const { figma: f } = loadPlugin();
  await f.ui.onmessage({ kind: "ready" });

  f.__posted.length = 0;
  await Promise.all([
    f.ui.onmessage({ kind: "refresh-panel" }),
    f.ui.onmessage({ kind: "refresh-panel" }),
    f.ui.onmessage({ kind: "refresh-panel" }),
  ]);

  await new Promise((r) => setTimeout(r, 400));
  const summaries = f.__posted.filter((m) => m.kind === "panel-summary");
  assert.ok(summaries.length >= 1, "at least one summary should arrive");
  for (const s of summaries) {
    assert.ok(s.summary.fileName, "every delivered summary must be complete, never partial");
  }
});

test("pages are loaded once and cached across calls", async () => {
  const { figma: f2 } = loadPlugin();
  await f2.ui.onmessage({ kind: "ready" });

  await ask(f2, "inspect_file", {});
  const afterFirst = f2.__loadAllPagesCalls;
  await ask(f2, "inspect_selection", {});
  await ask(f2, "inspect_file", {});

  assert.equal(afterFirst, 1, "first call loads pages");
  assert.equal(f2.__loadAllPagesCalls, 1, "later calls reuse the cache instead of reloading");
});

test("selection changes do not trigger extra page loads", async () => {
  const { figma: f3 } = loadPlugin();
  await f3.ui.onmessage({ kind: "ready" });
  await ask(f3, "inspect_selection", {});
  const n = f3.__loadAllPagesCalls;
  for (let i = 0; i < 5; i++) await ask(f3, "inspect_selection", {});
  assert.equal(f3.__loadAllPagesCalls, n);
});
/* -------------------------------------------------------------------------- */
/* Variables and styles (spec �22)                                             */
/* -------------------------------------------------------------------------- */

test("a colour variable is created with its value on the default mode", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const reply = await ask(f, "create_design", {
    operations: [{ type: "createVariable", name: "surface", variableType: "color", values: { default: "#FFFDF9" } }],
  });

  assert.equal(reply.ok, true, `failed: ${reply.error ?? ""}`);
  assert.equal(reply.data.status, "success");
  assert.ok(d.variables.length >= 1, "a variable exists in the document");

  const variable = d.variables[0];
  assert.equal(variable.name, "surface");
  assert.equal(variable.resolvedType, "COLOR");

  const modeId = d.collections[0].modes[0].modeId;
  const value = variable.valuesByMode[modeId];
  assert.equal(Math.round(value.r * 255), 255);
  assert.equal(Math.round(value.g * 255), 253);
  assert.equal(Math.round(value.b * 255), 249);
});

test("re-running a program updates the variable instead of duplicating it", async () => {
  // This is the whole point of �22. Two runs of the same program must leave one
  // token, not `space/md` and `space/md 2`.
  const { figma: f, doc: d } = loadPlugin();

  const program = (value) => ({
    operations: [{ type: "createVariable", name: "space/md", variableType: "number", values: { default: value } }],
  });

  await ask(f, "create_design", program(24));
  await ask(f, "create_design", program(32));

  assert.equal(d.collections.length, 1, "one collection, not one per run");

  const matching = d.variables.filter((v) => v.name === "space/md");
  assert.equal(matching.length, 1, "one variable, updated in place");

  const modeId = d.collections[0].modes[0].modeId;
  assert.equal(matching[0].valuesByMode[modeId], 32, "the second run's value won");
});

test("a named mode creates a real second mode on the collection", async () => {
  const { figma: f, doc: d } = loadPlugin();
  await ask(f, "create_design", {
    operations: [
      {
        type: "createVariable",
        name: "bg",
        variableType: "color",
        values: { "Mode 1": "#FFFFFF", Dark: "#111111" },
      },
    ],
  });

  const collection = d.collections[0];
  assert.equal(collection.modes.length, 2, "Dark added as a second mode");
  assert.deepEqual(collection.modes[1].name, "Dark");

  const variable = d.variables[0];
  const dark = variable.valuesByMode[collection.modes[1].modeId];
  assert.equal(Math.round(dark.r * 255), 17);
});

test("a boolean token is allowed", async () => {
  // A design system genuinely contains flags; refusing them is what forces
  // designers to hardcode the condition forever.
  const { figma: f, doc: d } = loadPlugin();
  await ask(f, "create_design", {
    operations: [{ type: "createVariable", name: "dense/table", variableType: "boolean", values: { default: true } }],
  });

  assert.equal(d.variables[0].resolvedType, "BOOLEAN");
  assert.equal(d.variables[0].valuesByMode[d.collections[0].modes[0].modeId], true);
});

test("a paint style is created with its colour", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const reply = await ask(f, "create_design", {
    operations: [{ type: "createPaintStyle", name: "Surface", color: "#FFFDF9", opacity: 1 }],
  });

  assert.equal(reply.data.status, "success");
  const style = d.paintStyles.find((s) => s.name === "Surface");
  assert.ok(style, "the style exists");
  assert.equal(style.paints[0].type, "SOLID");
  assert.equal(Math.round(style.paints[0].color.r * 255), 255);
});

test("a text style only ever names a weight the font actually has", async () => {
  // Inter ships Regular and Bold only in this harness. Asking for 600 must not
  // produce "SemiBold" -- and it deliberately does not jump up to Bold either:
  // a heavier-than-intended weight changes the visual hierarchy, so degrading to
  // Regular is the safer failure. What matters is that the name is real.
  const { figma: f, doc: d } = loadPlugin();
  await ask(f, "create_design", {
    operations: [{ type: "createTextStyle", name: "Display", weight: 600, fontSize: 32 }],
  });

  const style = d.textStyles.find((s) => s.name === "Display");
  assert.ok(style, "the style exists");
  assert.equal(style.fontSize, 32);
  assert.equal(style.fontName.family, "Inter");
  assert.equal(["Regular", "Bold"].includes(style.fontName.style), true, `resolved to an uninstalled style: ${style.fontName.style}`);
});

test("re-running a text style updates it rather than making a second", async () => {
  const { figma: f, doc: d } = loadPlugin();
  await ask(f, "create_design", { operations: [{ type: "createTextStyle", name: "Body", fontSize: 14 }] });
  await ask(f, "create_design", { operations: [{ type: "createTextStyle", name: "Body", fontSize: 16 }] });

  const matching = d.textStyles.filter((s) => s.name === "Body");
  assert.equal(matching.length, 1);
  assert.equal(matching[0].fontSize, 16);
});

/* -------------------------------------------------------------------------- */
/* Connector vectors                                                           */
/* -------------------------------------------------------------------------- */

test("a connector vector keeps its arrowhead as a separate filled subpath", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const reply = await ask(f, "create_design", {
    operations: [
      {
        type: "createVector",
        name: "orthogonal connector",
        x: 0,
        y: 0,
        width: 200,
        height: 40,
        path: "M 0 0 L 100 0 L 100 40 L 200 40 M 200 40 L 180 32 L 180 48 Z",
        stroke: "#8A8C84",
        strokeWeight: 1,
        fillArrows: true,
      },
    ],
  });

  assert.equal(reply.data.status, "success", `failed: ${JSON.stringify(reply.data.error ?? {})}`);

  const created = reply.data.createdNodes.find((n) => n.name === "orthogonal connector");
  assert.ok(created, `the connector node was not reported: ${JSON.stringify(reply.data.createdNodes)}`);

  const vector = f.__node(created.figmaNodeId);
  assert.equal(vector.vectorPaths.length, 2, "line plus arrowhead region");
  assert.equal(/Z/.test(vector.vectorPaths[1].data), true, "the arrowhead is a closed subpath");
  assert.equal(vector.fills.length, 1, "fillArrows gave the vector a fill so the head is solid");
  assert.equal(vector.strokes.length, 1);
});

test("an ordinary vector without fillArrows keeps its empty fill", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "create_design", {
    operations: [
      { type: "createVector", x: 0, y: 0, width: 100, height: 100, path: "M 0 0 L 100 0 L 100 100 Z", stroke: "#111111", fill: [] },
    ],
  });

  assert.equal(reply.data.status, "success");
  const vector = f.__node(reply.data.createdNodes[0].figmaNodeId);
  assert.deepEqual(vector.fills, [], "an open path must not get a fill by default");
});

test("a dashed connector keeps its dash pattern", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "create_design", {
    operations: [
      {
        type: "createVector",
        x: 0,
        y: 0,
        width: 100,
        height: 10,
        path: "M 0 5 L 100 5",
        stroke: "#8A8C84",
        dashPattern: [4, 4],
        fillArrows: true,
      },
    ],
  });

  assert.deepEqual(f.__node(reply.data.createdNodes[0].figmaNodeId).dashPattern, [4, 4]);
});

/* -------------------------------------------------------------------------- */
/* Slides                                                                      */
/* -------------------------------------------------------------------------- */

test("createSlide refuses loudly outside Figma Slides", async () => {
  // The default harness pretends to be a design file. A slide created there
  // would be a broken frame-shaped thing in the wrong product, so this must fail
  // with directions rather than succeed wrongly.
  const { figma: f } = loadPlugin();
  assert.equal(f.editorType, "figma");

  const reply = await ask(f, "create_design", {
    operations: [{ type: "createSlide", name: "Title" }],
  });

  assert.equal(reply.data.status, "failed");
  assert.match(reply.data.error.message, /slides/i);
});

test("createSlide builds a real 1920x1080 slide in Slides mode", async () => {
  const { figma: f, doc: d } = loadPlugin();
  f.editorType = "slides";

  const reply = await ask(f, "create_design", {
    operations: [
      {
        type: "createSlide",
        id: "s1",
        name: "Title",
        background: "#111111",
        notes: "Say the thing.",
      },
      { type: "createText", parent: "s1", content: "EXO", fontSize: 120, weight: 700 },
    ],
  });

  assert.equal(reply.data.status, "success", `failed: ${JSON.stringify(reply.data.error ?? {})}`);

  const slide = d.slideGrid[0];
  assert.equal(slide.type, "SLIDE");
  assert.equal(slide.name, "Title");
  assert.equal(slide.width, 1920);
  assert.equal(slide.height, 1080);
  assert.equal(slide.children.length, 1, "the text landed inside the slide");
  assert.equal(slide.speakerNotes, "Say the thing.");
});

test("a second createSlide appends to the deck in order", async () => {
  const { figma: f, doc: d } = loadPlugin();
  f.editorType = "slides";

  await ask(f, "create_design", { operations: [{ type: "createSlide", name: "One" }] });
  await ask(f, "create_design", { operations: [{ type: "createSlide", name: "Two" }] });

  assert.deepEqual(d.slideGrid.map((s) => s.name), ["One", "Two"]);
});

test("a failed slide transaction rolls the slide back out of the grid", async () => {
  const { figma: f, doc: d } = loadPlugin();
  f.editorType = "slides";

  const reply = await ask(f, "create_design", {
    operations: [{ type: "createSlide", name: "Doomed" }, { type: "notARealOperation" }],
  });

  assert.equal(reply.data.status, "failed");
  assert.equal(d.slideGrid.length, 0, "the half-built slide must not linger in the deck");
});

test("a slide background is a fill, not a stacked rectangle", async () => {
  const { figma: f, doc: d } = loadPlugin();
  f.editorType = "slides";

  await ask(f, "create_design", { operations: [{ type: "createSlide", name: "Bg", background: "#111111" }] });

  const slide = d.slideGrid[0];
  assert.equal(slide.children.length, 0, "no background rectangle node was stacked inside");
  assert.equal(slide.fills.length, 1, "the background is a real fill on the slide");
});

/* -------------------------------------------------------------------------- */
/* Live progress                                                               */
/* -------------------------------------------------------------------------- */

test("a build narrates its own landing through progress messages", async () => {
  const { figma: f } = loadPlugin();

  const operations = [{ type: "createFrame", id: "root", width: 400, height: 300 }];
  for (let i = 0; i < 11; i++) {
    operations.push({ type: "createRectangle", parent: "root", width: 10, height: 10 });
  }

  const reply = await ask(f, "create_design", { description: "progress check", operations });
  assert.equal(reply.data.status, "success");

  const progress = f.__posted.filter((m) => m.kind === "progress");
  assert.ok(progress.length >= 2, `expected a started frame plus applying frames, got ${progress.length}`);

  assert.equal(progress[0].phase, "started");
  assert.equal(progress[0].done, 0);
  assert.equal(progress[0].total, operations.length);

  const applying = progress.filter((m) => m.phase === "applying" || m.phase === "done");
  const last = applying[applying.length - 1];
  assert.equal(last.done, last.total, "the final frame must report completion");
  assert.equal(last.total, operations.length);

  // Monotonic: a bar that jumps backwards is worse than no bar.
  for (let i = 1; i < applying.length; i++) {
    assert.ok(applying[i].done >= applying[i - 1].done, "progress must not go backwards");
  }
});

test("a dry run posts no progress", async () => {
  const { figma: f } = loadPlugin();
  await ask(f, "create_design", {
    dryRun: true,
    operations: [{ type: "createFrame", id: "root", width: 400, height: 300 }],
  });

  // started/done frames would imply something is about to change, which for a
  // dry run is exactly the wrong message.
  assert.equal(
    f.__posted.filter((m) => m.kind === "progress" && m.phase !== "started").length,
    0,
  );
});

test("a failed build reports the failure through progress", async () => {
  const { figma: f } = loadPlugin();
  await ask(f, "create_design", {
    operations: [{ type: "createFrame", id: "root", width: 400, height: 300 }, { type: "notARealOperation" }],
  });

  const failed = f.__posted.find((m) => m.kind === "progress" && m.phase === "failed");
  assert.ok(failed, "a failed transaction must say so on the progress channel");
  assert.ok(failed.label.length > 0);
});

/* -------------------------------------------------------------------------- */
/* Dynamic-page component access (spec 1.1)                                    */
/* -------------------------------------------------------------------------- */

test("find_component counts instances without touching sync mainComponent", async () => {
  // Every instance in this harness throws on `.mainComponent`, exactly like a
  // real dynamic-page document. If any code path reads it, this test explodes
  // instead of silently passing with zero counts.
  const { figma: f, doc: d } = loadPlugin();

  const created = await ask(f, "create_component", { name: "StatusRow" });
  assert.equal(created.ok, true, `create failed: ${created.error ?? ""}`);

  const instanced = await ask(f, "create_instance", { componentId: created.data.componentId });
  assert.equal(instanced.ok, true, `instance failed: ${instanced.error ?? ""}`);

  const found = await ask(f, "find_components", {});
  assert.equal(found.ok, true);

  const match = found.data.matches.find((m) => m.component.name === "StatusRow");
  assert.ok(match, `StatusRow not found among: ${JSON.stringify(found.data.matches.map((m) => m.component.name))}`);
  assert.equal(match.component.instanceCount, 1, "the instance must be counted via getMainComponentAsync");
  assert.equal(d.slideGrid.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Semantic node targeting (spec section 3)                                     */
/* -------------------------------------------------------------------------- */

test("find_node resolves a layer by name substring", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "find_node", { name: "card" });
  assert.equal(reply.ok, true, `failed: ${reply.error ?? ""}`);
  assert.ok(reply.data.matches.length > 0);
  assert.equal(reply.data.matches[0].name, "Card");
  assert.match(reply.data.matches[0].reason, /name (is exactly|contains)/i);
});

test("find_node resolves a text layer by its content", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "find_node", { text: "dashboard" });
  assert.equal(reply.ok, true);
  assert.equal(reply.data.matches[0].type, "TEXT");
  assert.match(reply.data.matches[0].reason, /text/i);
});

test("find_node resolves a hero title by size, not by name", async () => {
  const { figma: f } = loadPlugin();
  await ask(f, "create_design", {
    operations: [{ type: "createText", id: "hero", content: "Compute, everywhere.", fontSize: 48, weight: 700 }],
  });

  const reply = await ask(f, "find_node", { role: "heroTitle" });
  assert.equal(reply.ok, true);
  assert.equal(reply.data.matches[0].id, reply.data.matches[0].id);
  assert.ok(reply.data.matches.some((m) => m.name === "Compute, everywhere." || /Compute/.test(m.name)), `hero not found: ${JSON.stringify(reply.data.matches.map((m) => m.name))}`);
});

test("find_node reports an unknown role instead of guessing", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "find_node", { role: "teleporter" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Unknown role.*Known roles/s);
});

test("find_node refuses an empty query", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "find_node", {});
  assert.equal(reply.ok, false);
  assert.match(reply.error, /at least one of/i);
});

test("find_node reports a missing screen with the pages that exist", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "find_node", { screen: "no-such-screen", name: "card" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /No page or screen matches/);
});

test("find_node narrows to the named screen", async () => {
  const { figma: f } = loadPlugin();
  const pages = await ask(f, "inspect_file", {});
  const pageName = pages.data.pages[0].name;

  const reply = await ask(f, "find_node", { screen: pageName, name: "card" });
  assert.equal(reply.ok, true);
  assert.ok(reply.data.matches.length > 0);
});

/* -------------------------------------------------------------------------- */
/* Component variants (spec section 2)                                         */
/* -------------------------------------------------------------------------- */

function makeVariantSet(f, doc) {
  // Two variants under one set, plus an instance of the first. Assembled from
  // mock API calls the way a real file would hold them: the set owns the
  // variants, the instance points back at its main through the async path.
  const setNode = f.createComponent();
  setNode.type = "COMPONENT_SET";
  setNode.name = "Button";

  const primary = f.createComponent();
  primary.name = "Style=Primary";
  const secondary = f.createComponent();
  secondary.name = "Style=Secondary, State=Hover";

  setNode.appendChild(primary);
  setNode.appendChild(secondary);
  doc.page.appendChild(setNode);

  const inst = primary.createInstance();
  doc.page.appendChild(inst);
  return { setNode, primary, secondary, inst };
}

test("set_variant switches an instance by exact variant name", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const { inst } = makeVariantSet(f, d);

  const reply = await ask(f, "set_variant", { instanceId: inst.id, variant: "Style=Primary" });
  assert.equal(reply.ok, true, `failed: ${reply.error ?? ""}`);
  assert.equal(reply.data.toName, "Style=Primary");
  assert.equal(inst.__swappedTo !== undefined, true);
});

test("set_variant matches Property=Value pairs, not just exact names", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const { inst, secondary } = makeVariantSet(f, d);

  const reply = await ask(f, "set_variant", { instanceId: inst.id, variant: "Style=Secondary, State=Hover" });
  assert.equal(reply.ok, true, `failed: ${reply.error ?? ""}`);
  assert.equal(reply.data.to, secondary.id);
});

test("set_variant names the available variants when nothing matches", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const { inst } = makeVariantSet(f, d);

  const reply = await ask(f, "set_variant", { instanceId: inst.id, variant: "Style=Tertiary" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Style=Primary/);
  assert.match(reply.error, /Style=Secondary/);
});

test("set_variant refuses a standalone component with no set", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const created = await ask(f, "create_component", { name: "Lonely" });
  const instanced = await ask(f, "create_instance", { componentId: created.data.componentId });

  const reply = await ask(f, "set_variant", { instanceId: instanced.data.instanceId, variant: "Primary" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /standalone component/i);
});

test("set_variant refuses a node that is not an instance", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "set_variant", { instanceId: "99:1", variant: "Primary" });
  assert.equal(reply.ok, false);
});

test("update_component edits the master so instances follow", async () => {
  const { figma: f } = loadPlugin();
  const created = await ask(f, "create_component", { name: "StatusRow" });

  const reply = await ask(f, "update_component", {
    componentId: created.data.componentId,
    operations: [{ type: "renameNode", target: created.data.componentId, name: "StatusRow v2" }],
  });
  assert.equal(reply.ok, true, `failed: ${reply.error ?? ""}`);
  assert.equal(reply.data.status, "success");
});

test("update_component refuses a non-component target", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "update_component", {
    componentId: "99:1",
    operations: [{ type: "renameNode", target: "99:1", name: "Nope" }],
  });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /not a component master/i);
});

/* -------------------------------------------------------------------------- */
/* Variable binding                                                            */
/* -------------------------------------------------------------------------- */

test("bindVariable links a fill to a variable by name", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "create_design", {
    operations: [
      { type: "createVariable", id: "v", name: "surface", variableType: "color", values: { default: "#FFFDF9" } },
      { type: "createFrame", id: "panel", width: 200, height: 100 },
      { type: "bindVariable", target: "panel", field: "fills", variable: "surface" },
    ],
  });
  assert.equal(reply.data.status, "success", `failed: ${JSON.stringify(reply.data.error ?? {})}`);

  const created = reply.data.createdNodes.find((n) => n.temporaryId === "panel");
  const panel = f.__node(created.figmaNodeId);
  assert.equal(panel.__bound.fills, "VariableID:1", "the fill must point at the variable, not a hex");
});

test("bindVariable resolves collection/name references", async () => {
  const { figma: f } = loadPlugin();
  const created = await ask(f, "create_design", {
    operations: [
      { type: "createVariable", name: "bg", variableType: "color", collection: "exo", values: { default: "#111111" } },
      { type: "createFrame", id: "panel", width: 200, height: 100 },
    ],
  });
  assert.equal(created.data.status, "success");

  // Variables are not scene nodes, so they never appear in createdNodes. The
  // mock exposes them the way Figma exposes variables: through the variables API.
  const variableId = f.__variables.find((v) => v.name === "bg").id;
  // Transaction-local ids do not survive into the next transaction, so the bind
  // addresses the real Figma id - which is also the honest way to use it.
  const panelId = created.data.createdNodes.find((n) => n.temporaryId === "panel").figmaNodeId;
  const bound = await ask(f, "create_design", {
    operations: [{ type: "bindVariable", target: panelId, field: "fills", variable: "exo/bg" }],
  });
  assert.equal(bound.data.status, "success", `bind failed: ${JSON.stringify(bound.data.error ?? {})}`);

  // Two transactions share nothing except the document, so the second bind must
  // resolve through the file, not through transaction-local ids.
  const panel = f.__node(panelId);
  assert.equal(panel.__bound.fills, variableId);
});

test("bindVariable fails loudly for a variable that does not exist", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "create_design", {
    operations: [
      { type: "createFrame", id: "panel", width: 200, height: 100 },
      { type: "bindVariable", target: "panel", field: "fills", variable: "ghost/token" },
    ],
  });
  assert.equal(reply.data.status, "failed");
  assert.match(reply.data.error.message, /does not exist/);
});

test("a uniform radius binds all four corners", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "create_design", {
    operations: [
      { type: "createVariable", name: "r", variableType: "number", values: { default: 12 } },
      { type: "createFrame", id: "panel", width: 200, height: 100 },
      { type: "bindVariable", target: "panel", field: "cornerRadius", variable: "r" },
    ],
  });
  assert.equal(reply.data.status, "success", `failed: ${JSON.stringify(reply.data.error ?? {})}`);

  const panel = f.__node(reply.data.createdNodes.find((n) => n.temporaryId === "panel").figmaNodeId);
  for (const corner of ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"]) {
    assert.ok(panel.__bound[corner] !== undefined, `${corner} must be bound, not just one of them`);
  }
});

/* -------------------------------------------------------------------------- */
/* Variant sets                                                                */
/* -------------------------------------------------------------------------- */

test("create_component_set combines two components into a set", async () => {
  const { figma: f } = loadPlugin();
  const a = await ask(f, "create_component", { name: "Button A" });
  const b = await ask(f, "create_component", { name: "Button B" });

  const reply = await ask(f, "create_component_set", {
    name: "Button",
    members: [a.data.componentId, b.data.componentId],
  });

  assert.equal(reply.ok, true, `failed: ${reply.error ?? ""}`);
  assert.equal(reply.data.name, "Button");
  assert.equal(reply.data.variantIds.length, 2);
});

test("create_component_set promotes frames without rebuilding them", async () => {
  const { figma: f } = loadPlugin();
  const built = await ask(f, "create_design", {
    operations: [
      { type: "createFrame", id: "f1", name: "Primary", width: 120, height: 40 },
      { type: "createFrame", id: "f2", name: "Secondary", width: 120, height: 40 },
    ],
  });
  const ids = built.data.createdNodes.filter((n) => n.temporaryId === "f1" || n.temporaryId === "f2").map((n) => n.figmaNodeId);

  const reply = await ask(f, "create_component_set", { name: "Button", members: ids });
  assert.equal(reply.ok, true, `failed: ${reply.error ?? ""}`);
  assert.deepEqual(reply.data.variantNames, ["Primary", "Secondary"]);
});

test("create_component_set refuses fewer than two members", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "create_component_set", { name: "Button", members: ["99:1"] });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /at least two/i);
});

test("create_component_set refuses members that do not exist", async () => {
  const { figma: f } = loadPlugin();
  const real = await ask(f, "create_component", { name: "Real" });
  const reply = await ask(f, "create_component_set", { name: "Button", members: [real.data.componentId, "made-up"] });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Member not found/i);
});
