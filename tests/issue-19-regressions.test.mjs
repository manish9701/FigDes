/**
 * Issue #19 regressions — binding existing text styles to existing text nodes.
 *
 * Live context: the review of `V2 · Consumer · 02 Model library` (frame
 * 358:1551) passed on geometry/contrast after repair, but the audit kept
 * reporting 23 `unstyled-text` notes. There was no operation that could fix
 * them: `createText` accepts a `textStyleId`, but no mutating operation binds
 * a style to a node that already exists — so every audit repair loop could
 * only ever re-report the same finding. That is the gap `setTextStyle`
 * closes.
 *
 * The last test locks the contrast numbers the live repair relied on, so a
 * future palette change cannot silently re-break the acceptance evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, ask } from "./plugin-harness.mjs";
import { validateTransaction } from "../mcp-server/dist-test/reliability/preflight.js";
import { contrastRatio } from "../mcp-server/dist-test/shared/contrast.js";

/** First TEXT node in the harness document (Dashboard card title). */
function firstTextId(doc) {
  const card = doc.root.children[0];
  const title = card.children[0];
  assert.equal(title.type, "TEXT");
  return title.id;
}

test("setTextStyle binds an existing style by name", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = firstTextId(d);

  const created = await ask(f, "create_design", {
    operations: [{ type: "createTextStyle", name: "EXO/Nav", family: "Inter", weight: 400, fontSize: 13 }],
  });
  assert.equal(created.data.status, "success");
  const style = d.textStyles.find((s) => s.name === "EXO/Nav");
  assert.ok(style, "the style exists");

  const reply = await ask(f, "modify_design", {
    operations: [{ type: "setTextStyle", target, style: "EXO/Nav" }],
  });
  assert.equal(reply.data.status, "success", `failed: ${JSON.stringify(reply.data.error ?? {})}`);
  assert.equal(f.__node(target).textStyleId, style.id, "the node carries the style id");
});

test("setTextStyle binds by id", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = firstTextId(d);

  await ask(f, "create_design", {
    operations: [{ type: "createTextStyle", name: "EXO/Body", family: "Inter", weight: 400, fontSize: 15 }],
  });
  const style = d.textStyles.find((s) => s.name === "EXO/Body");
  assert.ok(style, "the style exists");

  const reply = await ask(f, "modify_design", {
    operations: [{ type: "setTextStyle", target, style: style.id }],
  });
  assert.equal(reply.data.status, "success", `failed: ${JSON.stringify(reply.data.error ?? {})}`);
  assert.equal(f.__node(target).textStyleId, style.id);
});

test("setTextStyle with an unknown style fails without touching the node", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = firstTextId(d);
  assert.equal(f.__node(target).textStyleId, "", "starts unbound");

  const reply = await ask(f, "modify_design", {
    operations: [{ type: "setTextStyle", target, style: "EXO/DoesNotExist" }],
  });
  assert.equal(reply.data.status, "failed");
  assert.equal(reply.data.rolledBack, true, "nothing was mutated, so rollback is trivially complete");
  assert.match(String(reply.data.error.message), /not found/i, "names the problem");
  assert.match(String(reply.data.error.message), /createTextStyle|seed_exo_system/i, "says how to create the style first");
  assert.equal(f.__node(target).textStyleId, "", "the node is still unbound");
});

test("setTextStyle on a non-text node fails", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const frameId = d.root.children[0].id;
  assert.equal(f.__node(frameId).type, "FRAME");

  const reply = await ask(f, "modify_design", {
    operations: [{ type: "setTextStyle", target: frameId, style: "anything" }],
  });
  assert.equal(reply.data.status, "failed");
  assert.match(String(reply.data.error.message), /TEXT/i);
});

test("a failed transaction restores the prior style binding", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = firstTextId(d);

  await ask(f, "create_design", {
    operations: [
      { type: "createTextStyle", name: "StyleA", fontSize: 12 },
      { type: "createTextStyle", name: "StyleB", fontSize: 14 },
    ],
  });
  const styleA = d.textStyles.find((s) => s.name === "StyleA");
  const styleB = d.textStyles.find((s) => s.name === "StyleB");
  assert.ok(styleA && styleB, "both styles exist");

  const first = await ask(f, "modify_design", {
    operations: [{ type: "setTextStyle", target, style: "StyleA" }],
  });
  assert.equal(first.data.status, "success");
  assert.equal(f.__node(target).textStyleId, styleA.id);

  // Rebind, then fail on a later op: the StyleA binding must come back.
  const failed = await ask(f, "modify_design", {
    operations: [
      { type: "setTextStyle", target, style: "StyleB" },
      { type: "setFill", target: "no-such-node", fill: "#FF0000" },
    ],
  });
  assert.equal(failed.data.status, "failed");
  assert.equal(failed.data.rolledBack, true, "the prior binding was restored");
  assert.equal(f.__node(target).textStyleId, styleA.id, "StyleB did not stick");
});

test("preflight accepts setTextStyle against a real node id", () => {
  const result = validateTransaction([{ type: "setTextStyle", target: "358:1554", style: "EXO/Nav" }]);
  assert.equal(result.ok, true, `unexpected preflight issues: ${JSON.stringify(result.issues)}`);
});

test("issue-19 repair colours clear WCAG AA on their actual surfaces", () => {
  // Measured live on 358:1551: sidebar texts sit on #EEECE5, main-column
  // texts on #F7F6F2. The applied repairs must clear 4.5:1 on the surface
  // they were actually measured against — not just "a" surface.
  const sidebar = [
    ["#6C6B64", "358:1554"],
    ["#6C6B64", "358:1562"],
    ["#6C6B64", "358:1563"],
    ["#6C6B64", "358:1565"],
  ];
  for (const [fg, node] of sidebar) {
    const ratio = contrastRatio(fg, "#EEECE5");
    assert.ok(ratio !== null && ratio >= 4.5, `${node}: ${fg} on #EEECE5 measures ${ratio}`);
  }
  const main = [
    ["#72716A", "358:1555"],
    ["#72716A", "358:1557"],
    ["#72716A", "358:1561"],
  ];
  for (const [fg, node] of main) {
    const ratio = contrastRatio(fg, "#F7F6F2");
    assert.ok(ratio !== null && ratio >= 4.5, `${node}: ${fg} on #F7F6F2 measures ${ratio}`);
  }
  // And the repairs are surface-specific: swapping them must NOT pass, which
  // is why the reviewer proposes two different fills.
  const swapped = contrastRatio("#72716A", "#EEECE5");
  assert.ok(swapped !== null && swapped < 4.5, `the main-column fill must fail on the sidebar surface, measured ${swapped}`);
});
