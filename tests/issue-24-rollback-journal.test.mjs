/**
 * Issue 24 (checklist item 20) — truthful rollback for MIXED edits.
 *
 * ## Why this exists
 *
 * Before the pre-mutation journal, `rolledBack: true` was reported whenever the
 * created nodes were removed — even when an earlier operation had already
 * mutated a pre-existing node. That mutation was tracked in `ctx.modified` as
 * evidence but never journaled with its prior values, so a transaction that
 * changed the file's own card and THEN failed reported a cleanliness it had not
 * earned. The fix journals prior values for every existing-node mutation
 * (`journalProps` / `journalReparent` in operations.ts), restores them in
 * reverse order on failure, and only reports `rolledBack: true` when every
 * journaled mutation is verified restored AND every created node is confirmed
 * gone. Anything less is `rollbackStatus: "partial"` with the exact ids.
 *
 * ## What is verified here
 *
 *   (a) fail after mutating an existing node → prior values restored, full
 *       rollback (`rolledBack: true`).
 *   (b) fail after create + edit-existing + reparent → created node removed,
 *       the pre-existing node is back in its original parent at its original
 *       index with its original fill.
 *   (c) the user deletes the mutated node mid-transaction → partial rollback
 *       with the exact affected id in `unrestoredIds`, a recovery action in
 *       `rolledBackNote`, and `rolledBack` NOT true.
 *
 * Offline only, like every plugin-runtime test: the real `dist/code.js` bundle
 * runs against the mock document. Mid-transaction user interference in (c) is
 * simulated the only way this harness can honestly do it — a `loadFontAsync`
 * hook that deletes the node during the awaited gap between operations, which
 * is exactly the interleave window where a user can act.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPlugin, ask } from "./plugin-harness.mjs";

const FAILING_OP = { type: "setFill", target: "nope:404", fill: "#00FF00" };

/** The first card the mock document builds, with its original state captured. */
function firstCard(doc) {
  const card = doc.root.children[0];
  assert.equal(card.name, "Card", "the document mock must still put Card first");
  return card;
}

/* -------------------------------------------------------------------------- */
/* (a) fail after mutating an existing node                                     */
/* -------------------------------------------------------------------------- */

test("(a) a failed transaction restores journaled existing-node mutations and reports full rollback", async () => {
  const { figma, doc } = loadPlugin();
  const card = firstCard(doc);
  const cardId = card.id;
  const fillBefore = JSON.stringify(card.fills);
  const xBefore = card.x;
  const yBefore = card.y;
  const nameBefore = card.name;

  const reply = await ask(figma, "modify_design", {
    transactionId: "issue24_a",
    operations: [
      { type: "setFill", target: cardId, fill: "#FF0000" },
      { type: "setPosition", target: cardId, x: 42, y: 42 },
      { type: "renameNode", target: cardId, name: "Mutated card" },
      FAILING_OP,
    ],
  });

  assert.equal(reply.ok, true, `handler must return the failure payload, not throw: ${reply.error ?? ""}`);
  const data = reply.data;
  assert.equal(data.status, "failed");
  assert.equal(data.rolledBack, true, `a clean restore must claim a full rollback: ${JSON.stringify(data)}`);
  assert.equal(data.rollbackStatus, "full");
  assert.ok(data.restoredIds.includes(cardId), `the mutated node must be listed as restored: ${JSON.stringify(data)}`);
  assert.ok((data.unrestoredIds ?? []).length === 0, "nothing should be un-restorable in (a)");
  assert.match(data.error.rolledBackNote, /Full rollback/i);

  // Read back, never assume: the document holds the PRIOR values, not the
  // attempted ones.
  const restored = figma.__node(cardId);
  assert.ok(restored, "the card still exists after rollback");
  assert.equal(JSON.stringify(restored.fills), fillBefore, "the attempted fill must not survive");
  assert.equal(restored.x, xBefore, "the attempted x must not survive");
  assert.equal(restored.y, yBefore, "the attempted y must not survive");
  assert.equal(restored.name, nameBefore, "the attempted rename must not survive");
});

/* -------------------------------------------------------------------------- */
/* (b) fail after create + edit + reparent                                      */
/* -------------------------------------------------------------------------- */

test("(b) a mixed transaction removes its created nodes AND restores the pre-existing ones", async () => {
  const { figma, doc } = loadPlugin();
  const card = firstCard(doc);
  const cardId = card.id;
  const fillBefore = JSON.stringify(card.fills);

  const reply = await ask(figma, "create_design", {
    transactionId: "issue24_b",
    operations: [
      { type: "createFrame", id: "tmp", name: "Holding frame", width: 300, height: 200 },
      { type: "setFill", target: cardId, fill: "#FF0000" },
      { type: "appendChild", parent: "tmp", child: cardId },
      FAILING_OP,
    ],
  });

  const data = reply.data;
  assert.equal(data.status, "failed");
  assert.equal(data.rolledBack, true, `b must end in a full rollback: ${JSON.stringify(data)}`);
  assert.equal(data.rollbackStatus, "full");

  // The created frame is gone, and only it.
  assert.equal(data.removedIds.length, 1, `exactly one created node was removed: ${JSON.stringify(data)}`);
  assert.equal(figma.__node(data.removedIds[0]), null, "the created frame must be unresolvable after rollback");
  assert.ok(!data.removedIds.includes(cardId));

  // The pre-existing node is back where it started: same parent, same index,
  // same fill.
  const restored = figma.__node(cardId);
  assert.ok(restored, "the card still exists after rollback");
  assert.equal(restored.parent, doc.root, "the card must be reparented back to the Dashboard root");
  assert.equal(doc.root.children.indexOf(restored), 0, "the card must return to its original index");
  assert.equal(JSON.stringify(restored.fills), fillBefore, "the fill edit must be restored");
  assert.ok(data.restoredIds.includes(cardId), `the card must be listed as restored: ${JSON.stringify(data)}`);
});

/* -------------------------------------------------------------------------- */
/* (c) the user deletes the mutated node mid-transaction                        */
/* -------------------------------------------------------------------------- */

test("(c) a node deleted mid-transaction yields a partial rollback naming exactly the affected id", async () => {
  const { figma, doc } = loadPlugin();
  const card = firstCard(doc);
  const cardId = card.id;
  // `setTextContent` is the mutation that suspends on a font load; the helper
  // text lives inside the card but is never a journal target itself.
  const bodyId = card.children[1].id;
  assert.equal(card.children[1].type, "TEXT", "the mock's card must still hold a helper text");
  const charsBefore = card.children[1].characters;

  // Simulate user interference in the interleave window: while the plugin is
  // suspended awaiting a font load between operations, the node disappears.
  // (Create operations are hoisted to pass 1, so a create here would fire the
  // hook BEFORE the journaled mutation — a font suspend inside a pass-2
  // mutation is the correct, operation-ordered window.)
  const originalLoad = figma.loadFontAsync;
  figma.loadFontAsync = async (font) => {
    card.remove();
    return originalLoad(font);
  };

  const reply = await ask(figma, "modify_design", {
    transactionId: "issue24_c",
    operations: [
      // Journaled BEFORE the deletion: this mutation already committed, so the
      // failure report must say it could not be restored.
      { type: "setFill", target: cardId, fill: "#FF0000" },
      // Suspends on loadFontAsync; the hook deletes the card during the await.
      // The mutation itself still succeeds and is restorable.
      { type: "setTextContent", target: bodyId, content: "Edited while the user acted" },
      FAILING_OP,
    ],
  });

  const data = reply.data;
  assert.equal(data.status, "failed");
  assert.notEqual(data.rollbackStatus, "full", "the document cannot be cleanly restored after a user deletion");
  assert.equal(data.rolledBack, false, `"rolledBack" stays false unless every mutation is verified restored`);
  assert.ok(data.unrestoredIds.includes(cardId), `the deleted node must be named: ${JSON.stringify(data)}`);
  assert.ok(!data.restoredIds.includes(cardId), "a destroyed node must not be claimed as restored");

  // No created nodes means nothing may be claimed under `removedIds`, and the
  // user's deletion is certainly not reported as one of ours.
  assert.ok((data.removedIds ?? []).length === 0, `no created nodes existed: ${JSON.stringify(data)}`);

  // The report must carry both the exact evidence and a recovery action.
  assert.match(
    data.error.rolledBackNote,
    /could not restore/i,
    `the partial note must say what was not restored: ${data.error.rolledBackNote}`,
  );
  assert.match(
    data.error.rolledBackNote,
    /Recovery:/i,
    `an unrestored node needs a concrete recovery action: ${data.error.rolledBackNote}`,
  );

  // Ground truth in the document: the card is really gone, the surviving
  // mutation really was restored, and nothing else was disturbed.
  assert.equal(figma.__node(cardId), null, "the card remains deleted after the failed transaction");
  // The card is detached from the tree, so the live walk cannot see the text
  // inside it — assert through the node reference the test already holds.
  const body = card.children[1];
  assert.ok(body, "the text still exists inside its (detached) card");
  assert.equal(body.characters, charsBefore, "the successful mid-transaction edit must still roll back");
});

/* -------------------------------------------------------------------------- */
/* Honest up-front classification when a mutation cannot be undone              */
/* -------------------------------------------------------------------------- */

test("(d) a boolean operation journals its consumed sources as non-rollbackable up front", async () => {
  const { figma, doc } = loadPlugin();
  const card = firstCard(doc);
  const other = doc.root.children[1];

  // The mock has no boolean API, so the op fails after the journal records the
  // consumed sources — which is the failure shape that used to read as a lie.
  const reply = await ask(figma, "modify_design", {
    transactionId: "issue24_d",
    operations: [
      {
        type: "booleanOperation",
        operation: "union",
        targets: [card.id, other.id],
      },
    ],
  });

  const data = reply.data;
  assert.equal(data.status, "failed");
  assert.notEqual(data.rolledBack, true, "consumed sources cannot be reconstructed, so full is never claimable");
  // Both pre-existing sources are named in the partial-rollback report.
  assert.ok(data.unrestoredIds.includes(card.id), `source 1 must be named: ${JSON.stringify(data)}`);
  assert.ok(data.unrestoredIds.includes(other.id), `source 2 must be named: ${JSON.stringify(data)}`);
  // Neither was actually consumed (the boolean never ran), so both survive.
  assert.ok(figma.__node(card.id), "the source was never consumed and still exists");
});
