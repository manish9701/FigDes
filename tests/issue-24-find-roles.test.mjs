/**
 * Issue 24 (checklist item 15) — the semantic role vocabulary.
 *
 * ## Why this exists
 *
 * `find_node`'s roles are what turn "modify the toggle on this screen" into a
 * real node id. Seven roles covered the budget of the first pass; every other
 * surface fell back to raw ids or substring guesses. This file exercises the
 * extended vocabulary end to end through the bundled plugin: each role must
 * find the node whose name carries its keyword, with a reason that names the
 * evidence — and, just as important, must NOT match when the surface is absent,
 * because a confident-looking wrong id is exactly the wrong-subtree edit the
 * tool exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPlugin, ask } from "./plugin-harness.mjs";

/**
 * One assertion sweep: build a few deliberately-named nodes, then resolve each
 * role and check the best match's name, score and that the reason explains WHY.
 * A role whose surface is absent must come back empty ("confident or silent").
 */
test("the extended role vocabulary resolves named surfaces with evidence", async () => {
  const { figma } = loadPlugin();

  const build = await ask(figma, "create_design", {
    transactionId: "issue24_roles_build",
    operations: [
      { type: "createFrame", id: "toggle", name: "Enabled toggle", width: 120, height: 40 },
      { type: "createFrame", id: "dropdown", name: "Region dropdown", width: 200, height: 40 },
      { type: "createFrame", id: "card", name: "Usage card", width: 320, height: 180 },
      { type: "createFrame", id: "empty", name: "No results", width: 400, height: 300 },
      { type: "createText", id: "cancel", name: "Cancel", content: "Cancel", fontSize: 14 },
      { type: "createText", id: "stat", name: "Uptime stat", content: "99.9%", fontSize: 28 },
      { type: "createText", id: "sub", name: "Model subtitle heading", content: "Selected runs", fontSize: 12 },
      { type: "createFrame", id: "header", name: "Table header row", width: 320, height: 32 },
      { type: "createFrame", id: "crumbs", name: "Breadcrumb trail", width: 300, height: 20 },
    ],
  });
  assert.equal(build.ok, true, `build failed: ${build.error ?? JSON.stringify(build)}`);

  const cases = [
    { role: "toggle", expectName: "Enabled toggle" },
    { role: "dropdownSelector", expectName: "Region dropdown" },
    { role: "cardContainer", expectName: "Usage card", also: { name: "Usage" } },
    { role: "emptyState", expectName: "No results" },
    { role: "secondaryAction", expectName: "Cancel" },
    { role: "metric", expectName: "Uptime stat" },
    { role: "sectionHeading", expectName: "Model subtitle heading" },
    { role: "tableHeader", expectName: "Table header row" },
    { role: "breadcrumb", expectName: "Breadcrumb trail" },
  ];

  for (const { role, expectName, also = {} } of cases) {
    const reply = await ask(figma, "find_node", { role, ...also });
    assert.equal(reply.ok, true, `find_node ${role} failed: ${reply.error ?? ""}`);
    assert.ok(
      reply.data.matches.length > 0,
      `role ${role} must resolve something for ${expectName}; got none`,
    );
    const top = reply.data.matches[0];
    assert.equal(
      top.name,
      expectName,
      `role ${role} should top-score "${expectName}", got "${top.name}" (${top.reason})`,
    );
    assert.ok(top.score > 0, `role ${role} winner must carry a score`);
    assert.match(top.reason, new RegExp(`role ${role}`), `the reason must name the role's evidence for ${role}`);
    // The unknown role error message stays derived from the table, so callers
    // always see the full vocabulary.
  }

  // Confident-or-silent: a role with no surface on screen must not weakly
  // attach to whatever text happens to be nearest. ("toggle" is excluded
  // because the build above intentionally put a toggle on this screen.)
  for (const role of ["loadingIndicator", "paginationControl", "footerNavigation"]) {
    const blank = await ask(figma, "find_node", {
      role,
      screen: "Page 1",
      name: "zzz-nothing-matches-this",
    });
    assert.equal(blank.ok, true);
    assert.equal(blank.data.matches.length, 0, `the silent role contract extends to absent surfaces: ${role}`);
  }
});

test("the unknown-role error reports the extended vocabulary as it was", async () => {
  const { figma } = loadPlugin();
  const reply = await ask(figma, "find_node", { role: "teleporter" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Unknown role.*Known roles/s);
  // A sample of the new vocabulary must be present in the honest error.
  assert.match(reply.error, /secondaryAction/);
  assert.match(reply.error, /emptyState/);
  assert.match(reply.error, /cardContainer/);
});
