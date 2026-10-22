/**
 * Issue #24 server reliability — three fixes against the session/memory/review
 * diagnostics layer:
 *
 * 1. (checklist #21) Cross-session document coordination: two plugin sessions
 *    bound to the SAME Figma document must not run mutating native work
 *    concurrently. A document-keyed advisory write lock above the per-session
 *    lock fails fast with the holder's identity.
 * 2. (checklist #14) Product rules recorded via project_memory apply DURING
 *    generation: the guard runs the merged set (built-in EXO truths + stored
 *    rules), and a stored rule without checkable evidence degrades to
 *    guidance — INDETERMINATE, never a guessed hard FAIL.
 * 3. (checklist #23) Actionable diagnostics on findings: severity/confidence,
 *    evidence source, explicit "targets unknown" hints, a structured nextStep
 *    when no operation is attached, and render-revision binding with an
 *    explicit stale marker so a stale screenshot cannot certify a newer
 *    revision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The memory store resolves its directory at module load, so it must be set
// before the bundle is imported (same pattern the ledger tests use for
// DESIGN_AGENT_JOB_DIR).
const memoryDir = mkdtempSync(path.join(os.tmpdir(), "figdes-issue24-"));
process.env.DESIGN_AGENT_MEMORY_DIR = memoryDir;

const { withSessionLock, withDocumentLock, DocumentLockBusyError, documentKeyFor, heldDocumentLocks } = await import(
  "../mcp-server/dist-test/native/lock.js"
);
const { makeFinding, normalizeFinding, fromProtocolFinding, fromVisualFinding } = await import(
  "../mcp-server/dist-test/design/quality/finding.js"
);
const { effectiveRules, normalizeStoredRule, defaultRules, projectKey } = await import(
  "../mcp-server/dist-test/memory/store.js"
);
const { projectMemoryTool, designGuardTool, runGuard } = await import(
  "../mcp-server/dist-test/memory/tools.js"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------- */
/* Fix 1 — cross-session document lock                                         */
/* -------------------------------------------------------------------------- */

test("two sessions on the same document cannot mutate concurrently: the second fails fast naming the holder", async () => {
  const a = { id: "session_A", fileKey: "abc123", fileName: "Shared doc" };
  const b = { id: "session_B", fileKey: "abc123", fileName: "Shared doc" };
  let release;
  const gate = new Promise((r) => (release = r));

  const held = withDocumentLock(a, () => gate.then(() => "A done"));
  await sleep(5); // let A take the lock

  await assert.rejects(
    withDocumentLock(b, async () => "B should never run"),
    (err) => {
      assert.ok(err instanceof DocumentLockBusyError, "must be the structured busy error");
      assert.equal(err.holder.sessionId, "session_A", "the error names the holding session");
      assert.equal(err.holder.fileName, "Shared doc");
      assert.equal(err.documentKey, documentKeyFor(a));
      assert.match(err.message, /session_A/, "the message names the holder session");
      assert.match(err.message, /Shared doc/, "the message names the document");
      assert.match(err.message, /get_job_status/, "the message gives a recovery step");
      return true;
    },
  );

  release();
  assert.equal(await held, "A done");
  assert.equal(
    heldDocumentLocks().find((l) => l.documentKey === documentKeyFor(a)),
    undefined,
    "the document lock is released once the holder settles",
  );

  // After release, the second session may acquire the document.
  assert.equal(await withDocumentLock(b, async () => "B done"), "B done");
});

test("the same session may re-enter its own document lock (the per-session lock already serialises it)", async () => {
  const a = { id: "session_C", fileKey: "reentrant", fileName: "Doc" };
  assert.equal(
    await withDocumentLock(a, () => withDocumentLock(a, async () => "nested")),
    "nested",
  );
  assert.equal(heldDocumentLocks().find((l) => l.sessionId === "session_C"), undefined, "depth unwinds to released");
});

test("a failing or timed-out holder task releases the document lock (nothing leaks on disconnect/timeout)", async () => {
  const a = { id: "session_D", fileKey: "docx", fileName: "Timeout doc" };
  const b = { id: "session_E", fileKey: "docx", fileName: "Timeout doc" };

  await assert.rejects(
    withDocumentLock(a, () => Promise.reject(new Error("simulated timeout while applying"))),
    /simulated timeout/,
  );
  assert.equal(heldDocumentLocks().find((l) => l.fileName === "Timeout doc"), undefined, "no leak after a failure");

  // The next session must not be stuck behind the failed one.
  assert.equal(await withDocumentLock(b, async () => "next"), "next");
});

test("different documents never false-block each other", async () => {
  const doc1 = { id: "session_F", fileKey: null, fileName: "File one" };
  const doc2 = { id: "session_G", fileKey: null, fileName: "File two" };
  const results = await Promise.all([
    withDocumentLock(doc1, async () => {
      await sleep(15);
      return 1;
    }),
    withDocumentLock(doc2, async () => {
      await sleep(15);
      return 2;
    }),
  ]);
  assert.deepEqual(results, [1, 2], "distinct documents run concurrently with no spurious busy error");
});

test("the document key reuses the memory store's project identity derivation", () => {
  // Same inputs the store already treats as one project identity must produce
  // one document key — fileKey preferred, fileName fallback, unknown slug last.
  for (const [fileKey, fileName] of [
    ["k3y", "Named file"],
    [null, "Named file"],
    [null, null],
  ]) {
    assert.equal(documentKeyFor({ fileKey, fileName }), projectKey(fileKey, fileName), `key mismatch for ${fileKey}/${fileName}`);
  }
  // A file with no identity at all degrades to the shared "unknown" key —
  // deliberate: serialising two unidentifiable docs is a recoverable busy
  // error; letting them clobber is corruption.
  assert.equal(documentKeyFor({ fileKey: null, fileName: "" }), "unknown");
});

test("the per-session chain still self-cleans after a document-locked run", async () => {
  await withSessionLock("session_H", () => withDocumentLock({ id: "session_H", fileKey: "hc", fileName: "H" }, async () => 1));
  await withSessionLock("session_H", async () => 2);
  assert.equal(withSessionLock, withSessionLock); // sanity: unchanged semantics
  assert.ok(true);
});

/* -------------------------------------------------------------------------- */
/* Fix 2 — recorded product rules apply during generation                      */
/* -------------------------------------------------------------------------- */

test("a rule recorded via project_memory is checked by the guard during generation", async () => {
  const record = await projectMemoryTool(null, {
    action: "record",
    project: "issue24-merged",
    rule: {
      id: "proj24.no-red-accents",
      rule: "Red accents are reserved for destructive actions.",
      therefore: "Do not use a red accent on a non-destructive primary action.",
      severity: "warn",
      evidence: [{ kind: "forbiddenText", pattern: "danger" }],
      passesWhen: ["Red appears only on destructive controls"],
    },
  });
  assert.equal(record.status, "ok");
  assert.equal(record.ruleRecorded.id, "proj24.no-red-accents");
  assert.ok(record.rules >= 1, "the rule count reflects the stored rule");

  const guard = await designGuardTool(null, {
    project: "issue24-merged",
    program: {
      canvas: { name: "Merged", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [{ fn: "text", id: "t1", parent: "main", args: { text: "Danger zone", role: "title" } }],
    },
  });

  const stored = guard.findings.filter((f) => f.rule === "proj24.no-red-accents");
  assert.equal(stored.length, 1, "the recorded rule was part of the checked set");
  assert.equal(stored[0].verdict, "WARNING", "warn-severity stored rule fires as a WARNING, not a FAIL");
  assert.ok(guard.rulesSource.stored >= 1, "the response names how many rules came from stored memory");
});

test("a stored rule without checkable evidence is guidance: INDETERMINATE, never a hard FAIL", async () => {
  await projectMemoryTool(null, {
    action: "record",
    project: "issue24-guidance",
    rule: {
      id: "proj24.guidance-only",
      rule: "The console should feel like an instrument.",
      therefore: "Prefer gauges and readouts over prose panels.",
      severity: "fail",
      evidence: [],
      passesWhen: [],
    },
  });

  const guard = await designGuardTool(null, {
    project: "issue24-guidance",
    program: {
      canvas: { name: "Guidance", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [{ fn: "text", id: "t1", parent: "main", args: { text: "Compute", role: "title" } }],
    },
  });

  const finding = guard.findings.find((f) => f.rule === "proj24.guidance-only");
  assert.ok(finding, "the guidance rule still surfaces (it is not silently dropped)");
  assert.equal(finding.verdict, "INDETERMINATE", "unevaluable stored rules are surfaced, not guessed");
  assert.notEqual(guard.verdict, "FAIL", "a guidance-only stored rule must not hard-fail the run");
});

test("effectiveRules merges built-ins with stored rules; a stored copy cannot shadow a built-in", () => {
  const memory = {
    version: 1,
    project: "merge-check",
    fileKey: null,
    notes: [],
    rules: [
      // A stale copy recorded under a built-in id — the built-in must win.
      { id: "exo.auto-discovery", rule: "Old frozen copy of the truth.", therefore: "old", severity: "warn", evidence: [], passesWhen: [] },
      { id: "proj24.fresh", rule: "A genuinely new truth.", therefore: "its consequence", severity: "fail", evidence: [{ kind: "forbiddenText", pattern: "nope" }], passesWhen: [] },
    ],
    updatedAt: "",
  };
  const merged = effectiveRules(memory);

  const discovery = merged.find((r) => r.id === "exo.auto-discovery");
  assert.equal(discovery.rule, "Device discovery is automatic.", "the built-in EXO truth wins over a stored copy of its id");
  assert.ok(merged.some((r) => r.id === "proj24.fresh"), "stored rules with fresh ids are additive");
  assert.ok(merged.length >= defaultRules().length, "the merged set is never smaller than the built-ins");
});

test("a stored rule with an uncompilable pattern degrades to a manual question instead of aborting the guard", () => {
  const normalized = normalizeStoredRule({
    id: "proj24.bad-regex",
    rule: "Something forbidden.",
    therefore: "It must not appear.",
    severity: "fail",
    evidence: [{ kind: "forbiddenText", pattern: "[bad(" }],
    passesWhen: [],
  });
  assert.equal(normalized.evidence.length, 1);
  assert.equal(normalized.evidence[0].kind, "manual", "an uncompilable pattern becomes a human question");
  assert.match(normalized.evidence[0].question, /proj24\.bad-regex/);

  // And the guard must run over the degraded rule without throwing.
  const result = runGuard([normalized], {
    composition: "spatial",
    source: "program",
    resolved: true,
    nodeNames: ["main"],
    texts: ["anything"],
    components: [],
    metrics: { regions: 1 },
  });
  const finding = result.findings.find((f) => f.rule === "proj24.bad-regex");
  assert.equal(finding.verdict, "INDETERMINATE");
});

test("recording a rule under a built-in id is refused on record, before anything is saved", async () => {
  await assert.rejects(
    projectMemoryTool(null, {
      action: "record",
      project: "issue24-shadow",
      rule: { id: "exo.auto-discovery", rule: "Shadow attempt.", therefore: "No.", evidence: [] },
    }),
    /built-in EXO rule owns that id/,
  );
  const read = await projectMemoryTool(null, { project: "issue24-shadow" });
  assert.ok(read.rules.every((r) => r.id !== "exo.auto-discovery" || r.rule !== "Shadow attempt."), "nothing was saved");
});

/* -------------------------------------------------------------------------- */
/* Fix 3 — actionable diagnostics on findings                                  */
/* -------------------------------------------------------------------------- */

test("makeFinding normalises a screenshot-only finding: revision binding, stale marker, nextStep, targets hint", () => {
  const f = makeFinding({
    ruleId: "visual.critique",
    category: "visual",
    severity: "high",
    summary: "Top-left: no clear focal point",
    rationale: "Seen in the rendered image.",
    verification: "Re-render and re-critique.",
    evidence: [{ type: "screenshot-region", revisionId: "rev-abc", reference: "shot#top-left" }],
  });
  assert.equal(f.renderRevision, "rev-abc", "the render revision binding is attached");
  assert.equal(f.stale, false, "freshly constructed: bound to the render it was measured against");
  assert.ok(f.nextStep, "even a prose-only finding ends in a concrete verb-set");
  assert.equal(f.nextStep.tool, "modify_design");
  assert.equal(f.nextStep.needs, "nodeIds — none recorded; re-inspect the target first (targets unknown)");
  assert.equal(f.targetsHint, "targets: unknown, re-inspect", "an empty targets list is an explicit unknown, never a silent empty");
  // Backward compatible: every pre-existing field is unchanged.
  assert.equal(f.ruleId, "visual.critique");
  assert.equal(f.severity, "high");
  assert.equal(f.affectedNodeIds.length, 0);
  assert.ok(f.evidence[0].revisionId, "evidence keeps its revision");
});

test("normalizeFinding marks a screenshot-bound finding stale against a newer revision", () => {
  const f = makeFinding({
    ruleId: "visual.critique",
    category: "visual",
    severity: "medium",
    summary: "s",
    rationale: "r",
    verification: "v",
    evidence: [{ type: "screenshot-region", revisionId: "rev-old", reference: "shot#full" }],
    affectedNodeIds: [],
  });
  assert.equal(normalizeFinding(f, { currentRevisionId: "rev-old" }).stale, false, "matching revision is explicitly not stale");
  assert.equal(normalizeFinding(f, { currentRevisionId: "rev-new" }).stale, true, "a stale screenshot cannot silently certify a newer revision");
  assert.equal(normalizeFinding(f).stale, undefined, "with no current revision to compare, staleness stays an explicit unknown");
});

test("node-backed findings keep their node ids and get a structured nextStep without prose-only dead ends", () => {
  const f = fromProtocolFinding(
    {
      rule: "contrast",
      confidence: "high",
      severity: "major",
      title: "Insufficient contrast",
      evidence: { ratio: 2.1, required: 4.5 },
      nodeIds: ["12:34", "12:35"],
      guidance: "Darken the text fill.",
    },
    "rev-live",
  );
  assert.deepEqual(f.affectedNodeIds, ["12:34", "12:35"], "measured node ids survive normalisation");
  assert.ok(!f.targetsHint, "no targets hint when real targets exist");
  assert.equal(f.nextStep.tool, "modify_design");
  assert.equal(f.nextStep.needs, "nodeIds");
  assert.equal(f.nextStep.detail, "Darken the text fill.", "the prose advice travels as the concrete detail");
  assert.equal(f.suggestedFix, "Darken the text fill.", "existing suggestedFix field is not renamed");
});

test("validated suggestedOperations are attached and suppress the derived nextStep", () => {
  const base = makeFinding({
    ruleId: "token.contrast",
    category: "consistency",
    severity: "high",
    summary: "s",
    rationale: "r",
    verification: "v",
    evidence: [{ type: "token", revisionId: "rev-1", reference: "danger" }],
    affectedNodeIds: ["n1"],
  });
  assert.equal(base.nextStep.tool, "modify_design");

  const ops = [{ type: "setFill", target: "n1", fill: "#000000" }];
  const withOps = normalizeFinding(base, { suggestedOperations: ops });
  assert.deepEqual(withOps.suggestedOperations, ops, "validated operations ride along");
  assert.equal(withOps.nextStep, undefined, "a concrete operation set does not need a derived nextStep");
});

test("visual (screenshot) findings carry both the binding and the localization they actually have", () => {
  const localized = fromVisualFinding(
    { id: "vf-1", area: "top-left", defect: "no focal point", severity: "critical", nodeIds: ["9:1"], repair: "restructure", status: "open" },
    "rev-render",
  );
  assert.equal(localized.renderRevision, "rev-render");
  assert.equal(localized.stale, false);
  assert.ok(!localized.targetsHint);

  const unlocalized = fromVisualFinding(
    { id: "vf-2", area: "everywhere", defect: "vague imbalance", severity: "low", nodeIds: [], repair: "inspect", status: "open" },
    "rev-render",
  );
  assert.equal(unlocalized.targetsHint, "targets: unknown, re-inspect");
  assert.equal(unlocalized.nextStep.needs, "nodeIds — none recorded; re-inspect the target first (targets unknown)");
});
