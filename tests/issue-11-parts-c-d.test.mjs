/**
 * Moodboards, tags and change requests (issue #11, Parts C and D).
 *
 * The moodboard acceptance criteria are almost all negatives — "inactive by
 * default", "does not leak", "conflicts are surfaced rather than silently
 * merged" — and negatives are exactly what a happy-path test fails to check. So
 * each of those is asserted by constructing the situation where the property
 * would break and confirming the system refuses.
 *
 * Pure modules only: no Figma session is required, which is deliberate. The
 * guarantees here are about what enters a context and what a record claims, and
 * both are decided before anything touches a document.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "figdes-mb-"));
process.env.DESIGN_AGENT_MEMORY_DIR = dir;

const { assembleContext, claimsConflict, DEFAULT_CONTEXT_BUDGET } = await import("../mcp-server/dist-test/moodboard/context.js");
const { buildBrief, measureFrame } = await import("../mcp-server/dist-test/moodboard/analysis.js");
const { reconcileTargets, loadFeedback, saveFeedback, upsertRequest } = await import("../mcp-server/dist-test/feedback/store.js");
const { canTransition, transition, IllegalTransitionError } = await import("../mcp-server/dist-test/feedback/model.js");

test.after(() => rmSync(dir, { recursive: true, force: true }));

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const observation = (id, kind, claim, { approved = true, confidence = 0.8, moodboardId = "mb-1" } = {}) => ({
  id,
  moodboardId,
  kind,
  claim,
  confidence,
  provenance: "measured",
  evidence: { area: "header", sourceNodeId: "1:1" },
  approved,
  editedByUser: false,
});

const moodboard = (id = "mb-1", overrides = {}) => ({
  id,
  project: "exo",
  title: `Board ${id}`,
  sources: [{ kind: "figma-node", nodeId: "1:1", label: "Frame 1", readable: true }],
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const brief = (moodboardId, observations, overrides = {}) => ({
  moodboardId,
  observations,
  partial: false,
  unreadableSources: [],
  analysedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const attachment = (id, taskId, overrides = {}) => ({
  id,
  moodboardId: "mb-1",
  project: "exo",
  taskId,
  influence: "balanced",
  scope: "task",
  roles: [],
  exclusions: [],
  targetNodeIds: [],
  attachedAt: "2026-01-01T00:00:00.000Z",
  expiresAfterTask: true,
  ...overrides,
});

const library = (attachments = [], overrides = {}) => ({
  version: 1,
  project: "exo",
  moodboards: [moodboard()],
  briefs: [brief("mb-1", [observation("o1", "palette", "Surfaces are light and warm."), observation("o2", "typography", "Type steps 32/18/14px.")])],
  attachments,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const profile = (rules = []) => ({ project: "exo", rules, updatedAt: "2026-01-01T00:00:00.000Z" });

/* -------------------------------------------------------------------------- */
/* Part C — inactive by default                                                */
/* -------------------------------------------------------------------------- */

test("C: a saved moodboard contributes nothing to any task", () => {
  // The library is full of approved observations and nothing is attached. The
  // only correct answer is silence.
  const context = assembleContext({ library: library(), profile: profile(), taskId: "task-a" });
  assert.equal(context.text, "");
  assert.equal(context.entries.length, 0);
  assert.match(context.inactiveNote, /No moodboard is attached/);
  assert.deepEqual(context.attachedMoodboardIds, []);
});

test("C: only the approved profile applies without an attachment", () => {
  const context = assembleContext({
    library: library(),
    profile: profile([{ observationId: "o1", moodboardId: "mb-1", kind: "palette", claim: "Warm paper surfaces." }]),
    taskId: "task-a",
  });
  assert.equal(context.entries.length, 1);
  assert.equal(context.entries[0].kind, "profile-rule");
  assert.match(context.text, /Warm paper surfaces/);
});

test("C: unapproved observations never enter a context", () => {
  const lib = library([attachment("att-1", "task-a")]);
  lib.briefs[0].observations[0].approved = false;
  const context = assembleContext({ library: lib, profile: profile(), taskId: "task-a" });
  assert.ok(!context.text.includes("Surfaces are light and warm"), "an unapproved observation was injected");
  assert.match(context.text, /Type steps/);
});

/* -------------------------------------------------------------------------- */
/* Part C — no leak between tasks                                             */
/* -------------------------------------------------------------------------- */

test("C: an attachment cannot leak into another task", () => {
  const lib = library([attachment("att-1", "task-a")]);
  const mine = assembleContext({ library: lib, profile: profile(), taskId: "task-a" });
  const theirs = assembleContext({ library: lib, profile: profile(), taskId: "task-b" });

  assert.match(mine.text, /Surfaces are light and warm/);
  assert.equal(theirs.text, "", "task-b must not see task-a's reference");
  assert.equal(theirs.attachedMoodboardIds.length, 0);
});

test("C: a component-scoped attachment that covers nothing requested is dropped", () => {
  const lib = library([attachment("att-1", "task-a", { scope: "components", targetNodeIds: ["9:9"] })]);
  const context = assembleContext({ library: lib, profile: profile(), taskId: "task-a", targetNodeIds: ["1:2"] });
  assert.equal(context.text, "");
  assert.ok(context.dropped.some((d) => d.reason === "out-of-scope"));
});

test("C: a component-scoped attachment applies when it covers a requested node", () => {
  const lib = library([attachment("att-1", "task-a", { scope: "components", targetNodeIds: ["9:9"] })]);
  const context = assembleContext({ library: lib, profile: profile(), taskId: "task-a", targetNodeIds: ["9:9", "1:2"] });
  assert.match(context.text, /Surfaces are light and warm/);
});

/* -------------------------------------------------------------------------- */
/* Part C — influence, roles, exclusions, budget                              */
/* -------------------------------------------------------------------------- */

test("C: subtle influence takes fewer observations than strong", () => {
  const many = Array.from({ length: 8 }, (_, i) => observation(`o${i}`, "palette", `Observation ${i}`));
  const lib = (influence) => library([attachment("att-1", "task-a", { influence })], { briefs: [brief("mb-1", many)] });

  const subtle = assembleContext({ library: lib("subtle"), profile: profile(), taskId: "task-a" });
  const strong = assembleContext({ library: lib("strong"), profile: profile(), taskId: "task-a" });

  const count = (c) => c.entries.filter((e) => e.kind === "attached-observation").length;
  assert.ok(count(subtle) < count(strong), `subtle ${count(subtle)} should be fewer than strong ${count(strong)}`);
  assert.ok(subtle.dropped.some((d) => d.reason === "influence"));
});

test("C: a typography-only attachment does not carry a palette observation", () => {
  const lib = library([attachment("att-1", "task-a", { roles: ["typography"] })]);
  const context = assembleContext({ library: lib, profile: profile(), taskId: "task-a" });
  assert.ok(!context.text.includes("Surfaces are light and warm"), "a palette claim leaked past a typography role");
  assert.match(context.text, /Type steps/);
  assert.ok(context.dropped.some((d) => d.reason === "role-excluded"));
});

test("C: an excluded trait is never injected", () => {
  const lib = library([attachment("att-1", "task-a", { exclusions: ["warm"] })]);
  const context = assembleContext({ library: lib, profile: profile(), taskId: "task-a" });
  assert.ok(!context.text.includes("Surfaces are light and warm"), "an excluded claim was injected");
  assert.ok(context.dropped.some((d) => d.reason === "exclusion"));
});

test("C: the budget is enforced and what was dropped is reported", () => {
  const many = Array.from({ length: 40 }, (_, i) => observation(`o${i}`, "palette", `A fairly long observation number ${i} about surfaces`));
  const lib = library([attachment("att-1", "task-a", { influence: "strong" })], { briefs: [brief("mb-1", many)] });
  const context = assembleContext({ library: lib, profile: profile(), taskId: "task-a", budget: 400 });

  assert.ok(context.used <= 400, `used ${context.used} against a 400 budget`);
  assert.ok(context.dropped.some((d) => d.reason === "budget"), "dropping for budget must be reported, not silent");
  assert.ok(DEFAULT_CONTEXT_BUDGET > 0);
});

/* -------------------------------------------------------------------------- */
/* Part C — conflicts surfaced                                                */
/* -------------------------------------------------------------------------- */

test("C: a conflict with the approved profile is surfaced, not silently merged", () => {
  const lib = library([attachment("att-1", "task-a")]);
  lib.briefs[0].observations[0].claim = "Surfaces should be dark and high contrast.";
  const context = assembleContext({
    library: lib,
    profile: profile([{ observationId: "p1", moodboardId: "mb-0", kind: "palette", claim: "Surfaces should be light." }]),
    taskId: "task-a",
  });

  assert.equal(context.conflicts.length, 1, "the conflict was not reported");
  assert.match(context.conflicts[0].resolution, /profile wins/);
  assert.match(context.conflicts[0].profileRule, /light/);
});

test("C: a strong-influence conflict records which way it went", () => {
  const lib = library([attachment("att-1", "task-a", { influence: "strong" })]);
  lib.briefs[0].observations[0].claim = "Surfaces should be dark and high contrast.";
  const context = assembleContext({
    library: lib,
    profile: profile([{ observationId: "p1", moodboardId: "mb-0", kind: "palette", claim: "Surfaces should be light." }]),
    taskId: "task-a",
  });
  assert.match(context.conflicts[0].resolution, /attached reference wins/);
});

test("C: conflict detection is not trigger-happy", () => {
  // Sharing a word is not a conflict, and two claims on different axes are not
  // either. A detector that cries wolf gets ignored, and then the real one is
  // missed too.
  assert.equal(claimsConflict("Warm paper surfaces throughout.", "A warm typographic voice at small sizes."), false);
  assert.equal(claimsConflict("Sharp square corners on cards.", "Identifiers set in a monospaced face."), false);
  // Real tensions, on the same axis and opposite values.
  assert.equal(claimsConflict("Light interface.", "Dark mode support."), true);
  assert.equal(claimsConflict("Cool blue-grey palette.", "Warm paper tones."), true);
  assert.equal(claimsConflict("A dense grid throughout.", "An airy, open layout."), true);
});

/* -------------------------------------------------------------------------- */
/* Part C — provenance and partial analysis                                   */
/* -------------------------------------------------------------------------- */

test("C: provenance survives into the injected line", () => {
  const lib = library([attachment("att-1", "task-a")]);
  lib.briefs[0].observations[0].provenance = "inferred";
  const context = assembleContext({ library: lib, profile: profile(), taskId: "task-a" });
  assert.match(context.text, /inferred/);
  assert.match(context.text, /mb-1\/o1/, "the observation must be traceable back to its origin");
});

test("C: a partial brief says so in the context", () => {
  const lib = library([attachment("att-1", "task-a")], { briefs: [brief("mb-1", [observation("o1", "palette", "Surfaces are light.")], { partial: true, unreadableSources: ["Frame 2: not readable"] })] });
  const context = assembleContext({ library: lib, profile: profile(), taskId: "task-a" });
  assert.match(context.text, /partial analysis/);
});

test("C: an unreadable source is never presented as analysed", () => {
  const sources = [
    { kind: "figma-node", nodeId: "1:1", label: "Frame 1", readable: true },
    { kind: "figma-node", nodeId: "1:2", label: "Frame 2", readable: false, unreadableReason: "no access" },
  ];
  const result = buildBrief({ moodboardId: "mb-1", sources, measured: [], proposed: [] });
  assert.equal(result.partial, true);
  assert.equal(result.observations.length, 0, "an unreadable source must produce no observations");
  assert.match(result.unreadableSources[0], /no access/);
});

test("C: a caller-supplied observation is downgraded from measured to inferred", () => {
  // The caller is the agent reading an image. It did not measure anything, and a
  // claim wearing the authority of a measurement would sail into the profile.
  const result = buildBrief({
    moodboardId: "mb-1",
    sources: [{ kind: "figma-node", nodeId: "1:1", label: "F", readable: true }],
    measured: [],
    proposed: [{ id: "p1", moodboardId: "mb-1", kind: "palette", claim: "Looks warm.", confidence: 0.6, provenance: "measured", approved: false, editedByUser: false }],
  });
  assert.equal(result.observations[0].provenance, "inferred");
});

test("C: measurement produces measured observations from real values", () => {
  const frame = {
    id: "1:1",
    name: "Header",
    nodes: [
      { id: "n1", type: "FRAME", name: "Card", fill: "#FAF6EF", w: 200, h: 80, x: 0, y: 0 },
      { id: "n2", type: "FRAME", name: "Card", fill: "#FAF6EF", w: 200, h: 80, x: 220, y: 0 },
      { id: "n3", type: "TEXT", name: "Title", w: 100, h: 20, x: 10, y: 10, text: { content: "Machines", size: 32, family: "Inter", color: "#242521" }, background: "#FAF6EF" },
      { id: "n4", type: "TEXT", name: "Body", w: 100, h: 16, x: 10, y: 40, text: { content: "Online", size: 14, family: "Inter", color: "#8A8C84" }, background: "#FAF6EF" },
    ],
  };
  const source = { kind: "figma-node", nodeId: "1:1", label: "Header", readable: true };
  const out = measureFrame(source, frame);

  assert.ok(out.length >= 3, `expected several measured observations, got ${out.length}`);
  assert.ok(out.every((o) => o.provenance === "measured"));
  assert.ok(out.every((o) => o.evidence?.sourceNodeId === "1:1"), "every observation must cite its source");

  const contrast = out.find((o) => /WCAG AA/.test(o.claim));
  assert.ok(contrast, "a contrast count is measurable and should be reported");
  assert.equal(contrast.evidence.measurement.illegible, 1, "#8A8C84 on #FAF6EF genuinely fails");
});

/* -------------------------------------------------------------------------- */
/* Part D — change request status machine                                      */
/* -------------------------------------------------------------------------- */

const changeRequest = (overrides = {}) => ({
  id: "cr-1",
  project: "exo",
  request: "Make these three buttons consistent",
  kind: "consistency",
  targets: [
    { nodeId: "1:1", name: "Deploy", nodeType: "FRAME" },
    { nodeId: "1:2", name: "Cancel", nodeType: "FRAME" },
  ],
  constraints: [],
  status: "proposed",
  proposedOperations: [],
  unresolvedTargets: [],
  verified: false,
  notes: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("D: a change request cannot be marked applied without verification", () => {
  // The issue's "created successfully must be distinct from passed visual QA",
  // as a type-level rule rather than a promise.
  const approved = transition(changeRequest(), "approved");
  assert.throws(() => transition(approved, "applied"), /without verification/);
});

test("D: a verified request can be marked applied", () => {
  const approved = transition(changeRequest({ verified: true }), "approved");
  const applied = transition(approved, "applied");
  assert.equal(applied.status, "applied");
});

test("D: illegal status moves are refused", () => {
  assert.equal(canTransition("proposed", "applied"), false);
  assert.equal(canTransition("proposed", "approved"), true);
  assert.equal(canTransition("rejected", "approved"), true);
  assert.throws(() => transition(changeRequest(), "applied"), IllegalTransitionError);
});

/* -------------------------------------------------------------------------- */
/* Part D — targets survive rename, flag deletion                              */
/* -------------------------------------------------------------------------- */

test("D: a rename does not break a target", () => {
  // Resolution is by id, which is the property that makes the feature usable.
  const request = changeRequest();
  const result = reconcileTargets(request, new Set(["1:1", "1:2"]));
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.request.status, "proposed");
});

test("D: a deleted target needs re-resolution rather than a substitute", () => {
  const request = changeRequest();
  const result = reconcileTargets(request, new Set(["1:1"]));
  assert.deepEqual(result.unresolved, ["1:2"]);
  assert.equal(result.request.status, "needs-re-resolution");
  assert.deepEqual(result.request.unresolvedTargets, ["1:2"]);
  assert.ok(result.request.notes.some((n) => /will not substitute a similar-looking node/.test(n)));
});

test("D: re-resolving restores the request to a workable state", () => {
  const request = changeRequest();
  const broken = reconcileTargets(request, new Set(["1:1"])).request;
  assert.equal(broken.status, "needs-re-resolution");

  const fixed = {
    ...broken,
    targets: broken.targets.map((t) => (t.nodeId === "1:2" ? { ...t, nodeId: "1:9", name: "Cancel (renamed)" } : t)),
    unresolvedTargets: [],
    status: "proposed",
  };
  const after = reconcileTargets(fixed, new Set(["1:1", "1:9"]));
  assert.deepEqual(after.unresolved, []);
});

test("D: feedback history round-trips through the store", () => {
  const { file } = loadFeedback("exo");
  const saved = saveFeedback("exo", upsertRequest(file, changeRequest()));
  const reread = loadFeedback("exo").file;
  assert.equal(reread.requests.length, 1);
  assert.equal(reread.requests[0].request, "Make these three buttons consistent");
  assert.equal(reread.requests[0].targets[0].nodeId, "1:1");
  assert.ok(saved.updatedAt);
});

test("D: a corrupt feedback file degrades to empty and says so", () => {
  // Losing history silently would read as "this project has no requests".
  writeFileSync(join(dir, "broken.feedback.json"), "{ not json", "utf8");
  const { file, problem } = loadFeedback("broken");
  assert.equal(file.requests.length, 0);
  assert.match(problem, /could not be read/);
});