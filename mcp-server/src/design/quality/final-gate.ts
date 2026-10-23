/**
 * Visual Quality Gate + iteration/discovery budgets (spec §18, §19, §20).
 *
 * Extends the existing quality gate (`review/quality.ts`) into the final
 * `FinalQualityReport` with eight scored dimensions, and owns the loop budgets:
 * initial build (1) + major visual review (1) + repair passes (1–3) with a
 * maximum of 4 renders. Past the budget the screen is FAIL/REVIEW with a useful
 * reason — never an infinite loop.
 *
 * Issue #23 adds the truthfulness layer this report used to lack:
 *
 *  - a `gates` enumeration — every gate the final QA knows about, with its
 *    actual status (`ran` | `skipped` | `failed` | `notEvaluated`) — so a
 *    report can no longer present itself as a verdict without saying which
 *    checks produced it;
 *  - a three-valued `verdict` (`PASS` | `FAIL` | `BLOCKED`) that can never be
 *    PASS while a required gate is skipped, errored, or never evaluated:
 *    FAIL when a gate ran and found a blocker, BLOCKED when it could not run
 *    for environmental reasons (no plugin session, no live file);
 *  - a `stamp` binding the verdict to the exact plugin build and transaction
 *    (`shared/protocol` already bakes the builds; this reuses it instead of
 *    stamping in parallel). An unstamped verdict cannot PASS.
 */
import type { GenericityReport } from "./genericity";
import { SERVER_BUILD } from "../../../../shared/protocol";

export interface FinalScores {
  hierarchy: number;
  composition: number;
  typography: number;
  readability: number;
  density: number;
  distinctiveness: number;
  genericity: number;
  productFit: number;
}

export interface FinalQualityReport {
  status: "PASS" | "REVIEW" | "FAIL";
  scores: FinalScores;
  blockingIssues: string[];
  repairHistory: string[];
  renderEvidence: Array<{ render: number; note: string }>;
  reason: string;
  /**
   * Adjudicated issues (quality-reliability P1): moved out of blocking with
   * rationale retained, never erased. Only false-positive/intentional rulings
   * WITH a tested rule correction stop blocking; anything else stays.
   */
  adjudicated: string[];
  /**
   * The issue-#23 truthful overall verdict. `status` above is the coarse
   * outcome existing callers consume; this is the one to read for "can the
   * final QA be called done": PASS, FAIL, or BLOCKED — never PASS while a
   * required gate is skipped, errored, or never evaluated.
   */
  verdict: FinalVerdict;
  /** Every reason the verdict is not PASS, named per status line and per gate. */
  verdictReasons: string[];
  /** Which gates the final QA actually ran, and their status. */
  gates: GateRecord[];
  /** The build/session stamp binding this verdict to plugin build + transaction. */
  stamp: GateStamp;
}

export interface GateAdjudication {
  /** Case-insensitive substring matched against blocking-issue text. */
  key: string;
  disposition: "false-positive" | "intentional" | "confirmed" | "unresolved";
  rationale: string;
  reviewer: string;
  /** Tested rule correction for this class. Required to stop blocking. */
  ruleCorrection?: string;
}

/* -------------------------------------------------------------------------- */
/* Truthful final QA (issue #23): gates, verdict, stamp                        */
/* -------------------------------------------------------------------------- */

export type FinalVerdict = "PASS" | "FAIL" | "BLOCKED";

/**
 * What actually happened to a named gate: it ran (cleanly or finding nothing
 * beyond its detail), it could not run for environmental reasons, it ran and
 * found a blocker, or it was never evaluated at all.
 */
export type GateStatus = "ran" | "skipped" | "failed" | "notEvaluated";

export interface GateRecord {
  name: string;
  status: GateStatus;
  /**
   * A required gate that is `skipped`, `failed` or `notEvaluated` can never
   * PASS the verdict. Non-required gates report truthfully without holding
   * the verdict hostage.
   */
  required: boolean;
  /** What actually happened, in one sentence. */
  detail?: string;
}

/** The build pair a verdict was measured under (`tools.buildCompatibility`). */
export type BuildCompatibility = "same-commit" | "different-commit" | "unverifiable";

/** The gates that must report `ran` before the verdict may say PASS. */
export const REQUIRED_GATES: readonly string[] = [
  "evidence-backed-scores",
  "render-evidence",
  "structural-blockers",
  "genericity",
  "accessibility",
  // Issue #23 (c): the verdict must be tied to the exact plugin build and the
  // transaction that produced the screen, using the stamps the codebase already
  // bakes (`shared/protocol`'s SERVER_BUILD and the session's build field).
  "session-stamp",
];

export interface GateStamp {
  /** The server build answering — baked by scripts/build-server.mjs. */
  serverBuild: string;
  /** The plugin build observed on the session (`StatusResult.build`). */
  pluginBuild: string | null;
  /** The transactionId of the build that produced the screen under judgement. */
  transactionId: string | null;
  /** The revision the gate is judging. */
  revision: string | null;
}

/** Phase 9 thresholds. Calibrate through benchmark tests, not vibes. */
export const FINAL_THRESHOLDS = {
  genericityFailAbove: 70,
  hierarchyReviewBelow: 60,
  readabilityFailBelow: 70,
  productFitReviewBelow: 60,
} as const;

export const ITERATION_BUDGET = {
  initialBuilds: 1,
  majorReviews: 1,
  minRepairPasses: 1,
  maxRepairPasses: 3,
  maxRenders: 4,
} as const;

export const DISCOVERY_BUDGET = {
  phases: ["current page + relevant context", "semantic component/style search", "expand only if confidence is low"] as const,
} as const;

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Evaluates the final gate from the extended critique + structural state.
 * All inputs are 0–100 evidence-backed numbers supplied by the caller (score
 * dimensions ×10, genericity inverted); this function only applies thresholds.
 *
 * Honesty rules (handoff §8):
 * - missing evidence-backed scores (including genericity) never PASS — FAIL.
 * - a stale/mismatched screenshot revision never PASS — FAIL.
 * - critical blockers override aggregate scores.
 * - budget exhaustion never converts REVIEW to PASS — FAIL.
 */
export function evaluateFinalGate(input: {
  scores: Partial<FinalScores>;
  genericity?: GenericityReport | null;
  blockingIssues?: string[];
  repairHistory?: string[];
  renders?: number;
  renderNotes?: string[];
  /** True only when a fresh rendered screenshot was inspected after the final repair. */
  visualEvidenceVerified?: boolean;
  /**
   * Revision binding (handoff §8): the IR revision the gate is judging vs the
   * revision the screenshot evidence actually depicts. A mismatch or a missing
   * evidence revision is a stale screenshot and FAILs — a caller-attested
   * boolean alone is not enough to PASS.
   */
  expectedRevision?: string;
  evidenceRevision?: string | null;
  /**
   * Interaction-state evidence (general-use quality lift), opt-in by shape.
   *
   * A screen with zero declared states (one hover, one selected, one
   * non-default tone) reads as unfinished even when every structural check
   * passes. When the caller measures state signals and reports
   * `states.declared === 0`, the gate refuses PASS — it downgrades to REVIEW
   * with the reason named, never FAIL, because a stateless screen can still
   * be genuinely complete (a static slide, a placeholder).
   */
  states?: { declared: number };
  /**
   * Accessibility coverage (issue #20, workstream 7), opt-in by shape.
   *
   * The blueprint's accessibility evaluator produces findings and a list of
   * what was NOT checked — and the gate that actually runs (this one) had no
   * accessibility dimension at all, so contrast and target-size failures
   * never blocked. Now: one or more accessibility findings blocks PASS, and
   * outstanding (notChecked) accessibility checks also refuse a clean PASS —
   * evaluating nothing is not the same as passing everything.
   */
  accessibility?: { findings: number; notChecked: string[] };
  /**
   * Adjudicated issues stop blocking only as false-positive/intentional WITH
   * a tested rule correction and retained rationale. Confirmed, unresolved,
   * or correction-less rulings keep blocking. The moved issues land in
   * `report.adjudicated`, never vanish.
   * adjudications?: GateAdjudication[];
   */
  adjudications?: GateAdjudication[];
  /**
   * Caller-enumerated gate records (issue #23). A stage that belongs to another
   * module — for example the illustrative/sample disclosure policy landing in
   * the preflight-quality workstream — reports the gate it ran here; supplied
   * records replace derived records by name, unknown names are appended, and
   * the three-valued verdict applies to them exactly as to derived gates.
   */
  gates?: GateRecord[];
  /**
   * The session/build stamp (issue #23 (c)). The server build is baked into
   * this bundle by scripts/build-server.mjs; the caller supplies the plugin
   * build it observed on the session and the transactionId of the build that
   * produced the screen. A verdict that cannot name both cannot be PASS: it is
   * describing code and a transaction it cannot tie its claims to.
   */
  stamp?: { pluginBuild?: string | null; transactionId?: string | null };
  /**
   * Build provenance (issue #26): the server/plugin build pair the screen was
   * measured under. `same-commit` keeps the verdict reachable; anything else
   * refuses PASS (a different build fails the verdict, an untraceable one
   * blocks it). Absent means "not measured here": read-only and offline
   * callers that never touched a live file are unaffected.
   */
  buildCompatibility?: BuildCompatibility;
}): FinalQualityReport {
  const scores: FinalScores = {
    hierarchy: clamp(input.scores.hierarchy ?? 50),
    composition: clamp(input.scores.composition ?? 50),
    typography: clamp(input.scores.typography ?? 50),
    readability: clamp(input.scores.readability ?? 50),
    density: clamp(input.scores.density ?? 50),
    distinctiveness: clamp(input.scores.distinctiveness ?? 50),
    genericity: clamp(input.genericity ? 100 - input.genericity.score : (input.scores.genericity ?? 50)),
    productFit: clamp(input.scores.productFit ?? 50),
  };
  const blocking = [...(input.blockingIssues ?? [])];
  const requiredScoreKeys: Array<keyof FinalScores> = ["hierarchy", "composition", "typography", "readability", "density", "distinctiveness", "genericity", "productFit"];
  const missingScores = requiredScoreKeys.filter((key) => {
    if (key === "genericity") return input.genericity == null && typeof input.scores.genericity !== "number";
    return typeof input.scores[key] !== "number";
  });
  if (missingScores.length > 0) blocking.push(`Missing evidence-backed scores: ${missingScores.join(", ")}.`);
  // Revision binding: PASS requires evidence depicting the judged revision.
  const staleEvidence =
    input.expectedRevision !== undefined &&
    (input.evidenceRevision == null || input.evidenceRevision === "" || input.evidenceRevision !== input.expectedRevision);
  if (input.expectedRevision !== undefined) {
    if (input.evidenceRevision == null || input.evidenceRevision === "") {
      blocking.push(`Stale screenshot: no evidence revision for expected revision "${input.expectedRevision}".`);
    } else if (input.evidenceRevision !== input.expectedRevision) {
      blocking.push(`Stale screenshot: evidence revision "${input.evidenceRevision}" does not match expected revision "${input.expectedRevision}".`);
    }
  }
  if (input.genericity && input.genericity.score > FINAL_THRESHOLDS.genericityFailAbove) {
    blocking.push(`Genericity ${input.genericity.score}/100 exceeds ${FINAL_THRESHOLDS.genericityFailAbove}: ${input.genericity.findings.map((f) => f.id).join(", ")}`);
  }
  if (scores.readability < FINAL_THRESHOLDS.readabilityFailBelow) {
    blocking.push(`Readability ${scores.readability} below ${FINAL_THRESHOLDS.readabilityFailBelow}.`);
  }
  const renders = input.renders ?? 0;
  if (renders > ITERATION_BUDGET.maxRenders) {
    blocking.push(`Render budget exhausted (${renders}/${ITERATION_BUDGET.maxRenders}). Stop and report.`);
  }
  const adjudicated: string[] = [];
  const remaining = blocking.filter((issue) => {
    const ruling = (input.adjudications ?? []).find(
      (a) =>
        (a.disposition === "false-positive" || a.disposition === "intentional") &&
        a.ruleCorrection !== undefined &&
        a.ruleCorrection.length > 0 &&
        issue.toLowerCase().includes(a.key.toLowerCase()),
    );
    if (ruling) {
      adjudicated.push(`${issue} — adjudicated ${ruling.disposition} by ${ruling.reviewer}: ${ruling.rationale} [correction: ${ruling.ruleCorrection}]`);
      return false;
    }
    return true;
  });
  const a11yFailures = input.accessibility?.findings ?? 0;
  const a11yBlocking = a11yFailures > 0 ? [`Accessibility: ${a11yFailures} finding(s) below WCAG thresholds.`] : [];

  /* ---- truthfulness layer (issue #23): gates, stamp, verdict -------------- */
  //
  // Derived from this function's own inputs — never invented: a gate reports
  // `ran` only when the argument that measures it was actually supplied, and
  // the caller may supply records that win by name. `status` below keeps its
  // existing semantics untouched; `verdict` is the never-PASS-on-skip mapping.
  const gates = deriveGateRecords(input, {
    missingScores,
    staleEvidence,
    structuralFailures: remaining.length,
  });
  const stamp: GateStamp = {
    serverBuild: SERVER_BUILD,
    pluginBuild: input.stamp?.pluginBuild ?? null,
    transactionId: input.stamp?.transactionId ?? null,
    revision: input.expectedRevision ?? null,
  };
  const attachTruth = (report: Omit<FinalQualityReport, "verdict" | "verdictReasons" | "gates" | "stamp">): FinalQualityReport => {
    const build = {
      ...(input.buildCompatibility !== undefined ? { compatibility: input.buildCompatibility } : {}),
      stamped: stamp.pluginBuild !== null && stamp.transactionId !== null,
    };
    const verdict = verdictFor(report.status, gates, build);
    return { ...report, gates, stamp, verdict, verdictReasons: reasonsFor(report, gates, build) };
  };

  if (remaining.length > 0 || a11yBlocking.length > 0) {
    return attachTruth({
      status: "FAIL",
      scores,
      blockingIssues: [...remaining, ...a11yBlocking],
      repairHistory: input.repairHistory ?? [],
      renderEvidence: (input.renderNotes ?? []).map((note, i) => ({ render: i + 1, note })),
      reason: a11yBlocking.length > 0
        ? "Blocking issues remain, including accessibility findings below WCAG thresholds. Repair and re-render within budget."
        : "Blocking visual-quality issues remain. Repair and re-render within budget.",
      adjudicated,
    });
  }
  const a11yNotChecked = input.accessibility?.notChecked ?? [];
  const needsReview =
    input.visualEvidenceVerified !== true ||
    scores.hierarchy < FINAL_THRESHOLDS.hierarchyReviewBelow ||
    scores.productFit < FINAL_THRESHOLDS.productFitReviewBelow;
  const stateless = input.states !== undefined && input.states.declared === 0;
  if (needsReview || stateless || a11yNotChecked.length > 0) {
    return attachTruth({
      status: "REVIEW",
      scores,
      blockingIssues: [],
      repairHistory: input.repairHistory ?? [],
      renderEvidence: (input.renderNotes ?? []).map((note, i) => ({ render: i + 1, note })),
      reason: a11yNotChecked.length > 0
        ? `Accessibility could not be fully verified (not checked: ${a11yNotChecked.join("; ")}), so a clean PASS is not available — verify those manually.`
        : input.visualEvidenceVerified !== true
          ? "Structural checks are incomplete as final evidence: inspect a fresh rendered screenshot before marking PASS."
          : stateless
            ? "No interaction states declared: add at least one hover, selected or non-default state so the screen reads as finished."
            : "No blocking issues, but hierarchy or product fit needs a human look before done.",
      adjudicated,
    });
  }
  return attachTruth({
    status: "PASS",
    scores,
    blockingIssues: [],
    repairHistory: input.repairHistory ?? [],
    renderEvidence: (input.renderNotes ?? []).map((note, i) => ({ render: i + 1, note })),
    reason: "No blocking issues; hierarchy and product fit hold.",
    adjudicated,
  });
}

/**
 * Enumerates the gates the final QA knows about, from the inputs it was given
 * (issue #23 (a)). Nothing is reported `ran` that was never supplied, and a
 * caller-supplied record (for instance the sample-disclosure policy gate
 * landing in another workstream) replaces the derived record with the same
 * name — the caller is the one that actually ran its stage.
 */
function deriveGateRecords(
  input: {
    visualEvidenceVerified?: boolean;
    expectedRevision?: string;
    evidenceRevision?: string | null;
    blockingIssues?: string[];
    genericity?: GenericityReport | null;
    accessibility?: { findings: number; notChecked: string[] };
    states?: { declared: number };
    stamp?: { pluginBuild?: string | null; transactionId?: string | null };
    gates?: GateRecord[];
    scores: Partial<FinalScores>;
    buildCompatibility?: BuildCompatibility;
  },
  measured: { missingScores: string[]; staleEvidence: boolean; structuralFailures: number },
): GateRecord[] {
  const records: GateRecord[] = [];

  /* session-stamp --------------------------------------------------------- */
  const pluginBuild = input.stamp?.pluginBuild ?? null;
  const transactionId = input.stamp?.transactionId ?? null;
  const stamped =
    typeof pluginBuild === "string" && pluginBuild.length > 0 &&
    typeof transactionId === "string" && transactionId.length > 0;
  records.push({
    name: "session-stamp",
    status: stamped ? "ran" : "notEvaluated",
    required: true,
    detail: stamped
      ? `verdict tied to plugin build '${pluginBuild}', transaction '${transactionId}' (server build ${SERVER_BUILD})`
      : `the verdict cannot be tied to a plugin build and transaction: no stamp was supplied (server build ${SERVER_BUILD})`,
  });

  /* render-evidence ------------------------------------------------------- */
  if (input.visualEvidenceVerified === true) {
    records.push({
      name: "render-evidence",
      status: measured.staleEvidence ? "failed" : "ran",
      required: true,
      detail: measured.staleEvidence
        ? "the screenshot evidence does not depict the revision under judgement"
        : input.expectedRevision !== undefined
          ? `rendered evidence was inspected for revision '${input.evidenceRevision}'`
          : "rendered evidence attested by the caller (no revision binding was supplied to measure it against)",
    });
  } else if (input.visualEvidenceVerified === false) {
    records.push({ name: "render-evidence", status: "failed", required: true, detail: "the caller attested the visual evidence did not verify" });
  } else {
    records.push({
      name: "render-evidence",
      status: "notEvaluated",
      required: true,
      detail: "no rendered screenshot was inspected (program-only or offline run) — the gate cannot claim a render it never saw",
    });
  }

  /* structural-blockers --------------------------------------------------- */
  if (measured.structuralFailures > 0) {
    records.push({ name: "structural-blockers", status: "failed", required: true, detail: `${measured.structuralFailures} blocker(s) remain after adjudication` });
  } else if (input.blockingIssues !== undefined) {
    records.push({ name: "structural-blockers", status: "ran", required: true, detail: "the structural/product blocker list was supplied and stood empty after adjudication" });
  } else {
    records.push({ name: "structural-blockers", status: "notEvaluated", required: true, detail: "no structural/product blocker list was supplied — nothing shows the rules ran" });
  }

  /* genericity ------------------------------------------------------------ */
  if (input.genericity != null) {
    records.push({ name: "genericity", status: "ran", required: true, detail: `anti-generic audit ran (score ${input.genericity.score})` });
  } else if (typeof input.scores?.genericity === "number") {
    records.push({ name: "genericity", status: "ran", required: true, detail: "genericity supplied as an evidence-backed score" });
  } else {
    records.push({ name: "genericity", status: "notEvaluated", required: true, detail: "no genericity audit was supplied" });
  }

  /* accessibility --------------------------------------------------------- */
  if (input.accessibility === undefined) {
    records.push({ name: "accessibility", status: "notEvaluated", required: true, detail: "no accessibility evaluation was supplied — contrast and target size were never measured" });
  } else if (input.accessibility.findings > 0) {
    records.push({ name: "accessibility", status: "failed", required: true, detail: `${input.accessibility.findings} finding(s) below WCAG thresholds` });
  } else if ((input.accessibility.notChecked ?? []).length > 0) {
    records.push({ name: "accessibility", status: "skipped", required: true, detail: `could not run: ${input.accessibility.notChecked.slice(0, 3).join("; ")}` });
  } else {
    records.push({ name: "accessibility", status: "ran", required: true, detail: "every supplied accessibility check ran and passed" });
  }

  /* evidence-backed-scores ------------------------------------------------ */
  records.push(
    measured.missingScores.length === 0
      ? { name: "evidence-backed-scores", status: "ran", required: true, detail: "all eight evidence-backed scores were supplied" }
      : { name: "evidence-backed-scores", status: "notEvaluated", required: true, detail: `missing evidence-backed scores: ${measured.missingScores.join(", ")}` },
  );

  /* build-compatibility (issue #26) ----------------------------------------- */
  //
  // Only enumerated when the caller measured it: read-only and offline runs
  // never touch a live file, so an absent pair is "not measured here", not a
  // refusal. A supplied pair is required — a verdict measured under the wrong
  // build is not a verdict about this repository.
  if (input.buildCompatibility !== undefined) {
    records.push(
      input.buildCompatibility === "same-commit"
        ? { name: "build-compatibility", status: "ran", required: true, detail: "the server and plugin builds are a same-commit pair" }
        : input.buildCompatibility === "different-commit"
          ? { name: "build-compatibility", status: "failed", required: true, detail: "the server and plugin builds differ: the measures may not describe this repository's behaviour" }
          : { name: "build-compatibility", status: "skipped", required: true, detail: "the plugin build cannot be tied to a commit: the run cannot certify this repository" },
    );
  }

  /* interaction-states (opt-in by shape, informational) ------------------- */
  records.push(
    input.states !== undefined
      ? { name: "interaction-states", status: "ran", required: false, detail: input.states.declared === 0 ? "zero interaction states declared" : `${input.states.declared} state signal(s) supplied` }
      : { name: "interaction-states", status: "notEvaluated", required: false, detail: "no interaction-state evidence was supplied (opt-in by shape)" },
  );

  /* caller-supplied records win by name; unknown names are appended -------- */
  for (const supplied of input.gates ?? []) {
    const at = records.findIndex((record) => record.name === supplied.name);
    if (at >= 0) records[at] = supplied;
    else records.push(supplied);
  }
  return records;
}

/**
 * The verdict mapping (issue #23 (b), hardened by issue #26): any required
 * gate that is skipped or never evaluated holds the verdict at BLOCKED — the
 * gate could not run, so the run is incomplete rather than bad — and any gate
 * that ran and found a blocker makes the verdict FAIL. REVIEW status (a check
 * ran, the outcome is withheld for evidence a human or a live session must
 * supply) is also BLOCKED, with the name of what is outstanding.
 *
 * The `build` provenance refuses PASS on top of the gates, so a caller that
 * overrides the gate records cannot launder a mismatched build into PASS:
 * `different-commit` FAILs (the measures may describe other code),
 * `unverifiable` BLOCKEDs (nothing ties the run to a commit), and an absent
 * stamp BLOCKEDs (the verdict names no transaction it certifies). Read-only
 * inspection callers omit `build` and are unaffected.
 */
export function verdictFor(
  status: FinalQualityReport["status"],
  gates: readonly GateRecord[],
  build?: { compatibility?: BuildCompatibility | null; stamped?: boolean },
): FinalVerdict {
  if (status === "FAIL" || gates.some((gate) => gate.status === "failed")) return "FAIL";
  const compatibility = build?.compatibility ?? null;
  if (compatibility !== null && compatibility !== "same-commit") {
    return compatibility === "different-commit" ? "FAIL" : "BLOCKED";
  }
  if (build?.stamped === false) return "BLOCKED";
  if (
    status === "PASS" &&
    !gates.some((gate) => gate.required && (gate.status === "skipped" || gate.status === "notEvaluated"))
  ) return "PASS";
  return "BLOCKED";
}

/** Never-PASS reasons, one per forcing line — the narrative behind the verdict. */
export function reasonsFor(
  report: { status: FinalQualityReport["status"]; reason: string },
  gates: readonly GateRecord[],
  build?: { compatibility?: BuildCompatibility | null; stamped?: boolean },
): string[] {
  const reasons: string[] = [];
  if (report.status === "FAIL") reasons.push(`blocking outcome: ${report.reason}`);
  if (report.status === "REVIEW") reasons.push(`certification withheld: ${report.reason}`);
  for (const gate of gates) {
    if (gate.status === "failed") reasons.push(`${gate.name}: ran and found a blocker — ${gate.detail ?? ""}`);
    else if (gate.required && (gate.status === "skipped" || gate.status === "notEvaluated")) reasons.push(`${gate.name}: ${gate.status} — ${gate.detail ?? ""}`);
  }
  const compatibility = build?.compatibility ?? null;
  if (compatibility !== null && compatibility !== "same-commit" && !reasons.some((r) => r.startsWith("build-compatibility:"))) {
    reasons.push(
      compatibility === "different-commit"
        ? "build-compatibility: the server and plugin builds differ — the verdict cannot certify this repository"
        : "build-compatibility: the plugin build cannot be tied to a commit — the verdict cannot certify this repository",
    );
  }
  if (build?.stamped === false && !reasons.some((r) => r.startsWith("session-stamp:"))) {
    reasons.push("session-stamp: the verdict is unstamped — no plugin build and transaction it certifies");
  }
  return reasons;
}
