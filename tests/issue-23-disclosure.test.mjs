/**
 * Issue #23 §4 — the disclosure policy, re-pinned: production screens are
 * clean by default.
 *
 * What is under test is a sentence about honesty with its polarity reversed:
 * a screen whose values are not live says NOTHING on its surface unless the
 * caller explicitly passed `onScreenDisclosure: true` — and the truth never
 * disappears, because the report keeps recording the illustrative data mode.
 * The opt-in still places exactly one caption (never per-value labels), and
 * the product-critic's repair instruction must stop telling the loop to paint
 * captions back onto the screen. Product facts are untouched by the policy,
 * so the last test re-runs the product-critic on an invented live-telemetry
 * claim and expects the same critical verdict as before.
 *
 * The fixtures are offline: brief → program (the plan is hand-built, since
 * the disclosure is a program-stage decision). No Figma, no render.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBrief } from "../mcp-server/dist-test/pipeline/brief.js";
import { buildProgram } from "../mcp-server/dist-test/pipeline/program.js";
import {
  DISCLOSURE_ID,
  DISCLOSURE_TEXT,
  alreadyDiscloses,
} from "../mcp-server/dist-test/pipeline/disclosure.js";
import { evaluateProductCritic } from "../mcp-server/dist-test/design/quality/product-critic.js";

/* -------------------------------------------------------------------------- */
/* Harness — the smallest plan buildProgram can consume                       */
/* -------------------------------------------------------------------------- */

/** A region the way the planner would emit one; only the fields the program reads. */
function region(id, role, overrides = {}) {
  return {
    id,
    role,
    composition: "instrument",
    parent: null,
    order: 0,
    bounds: { x: 0, y: 0, w: 1440, h: 420 },
    layoutMode: "flow-vertical",
    sizing: { width: "fill", height: "fill" },
    grow: 1,
    padding: { top: 24, right: 24, bottom: 24, left: 24 },
    gap: 12,
    align: { primary: "start", counter: "start" },
    responsive: { priority: 1, behavior: "stack" },
    contentHierarchy: [],
    density: "medium",
    relationships: [],
    primitives: [],
    constraints: { overflow: "clip" },
    priority: 1,
    interaction: null,
    why: `${id} carries the screen's work`,
    autoLayout: false,
    ...overrides,
  };
}

/** A content slot; illustrative by default, because demo fixtures are. */
function slot(regionId, label, overrides = {}) {
  const id = `${regionId}:${label.toLowerCase().replace(/\W+/g, "-")}`.slice(0, 48);
  return {
    id,
    regionId,
    kind: "signal",
    label,
    primitive: overrides.primitive ?? "metric",
    value: overrides.value ?? null,
    order: overrides.order ?? 0,
    because: "the brief named it",
    illustrative: overrides.illustrative ?? true,
    ...(overrides.states !== undefined ? { states: overrides.states } : {}),
  };
}

function plan(...parts) {
  const regions = [];
  const content = [];
  let order = 0;
  for (const part of parts) {
    if (part.id && part.role) {
      regions.push({ ...part, order: order++ });
    } else {
      content.push(part);
    }
  }
  return {
    id: "issue23-plan",
    canvas: { name: "Issue 23 disclosure", width: 1440, height: 900, grid: 8 },
    composition: "instrument",
    regions,
    content,
    notPlaced: [],
    focal: regions.find((r) => r.role === "primary-visual") ? { id: regions.find((r) => r.role === "primary-visual").id, why: "the data the screen qualifies" } : null,
    hierarchy: regions.map((r, i) => ({ rank: i + 1, id: r.id, why: r.why })),
    usage: { canvasArea: 1296000, coveredArea: 600000, coverage: 0.46, largestEmptyBand: 0.1, focalShare: 0.4, notes: [] },
    derivation: null,
    artDirection: null,
    execution: null,
    warnings: [],
  };
}

/** normalizeBrief + buildProgram, the pair the disclosure decision lives between. */
function run(planSpec, briefExtra = {}) {
  const { brief, assumptions } = normalizeBrief({
    screen: "Fleet Overview",
    purpose: "See cluster health and decide where to intervene",
    primaryDecision: "monitor fleet health and decide where to intervene",
    primaryAction: "Open cluster",
    dataMode: "demo",
    ...briefExtra,
  });
  return { brief, assumptions, built: buildProgram(brief, planSpec) };
}

/** The disclosure-shaped calls in a built program. */
function disclosureCalls(built) {
  return built.program.content.filter(
    (c) => c.id === DISCLOSURE_ID || c.args?.text === DISCLOSURE_TEXT,
  );
}

const header = region("header", "header", { sizing: { width: "fill", height: 72 }, grow: 0 });
const scope = region("scope", "primary-visual");
const footer = region("footer", "footer", { sizing: { width: "fill", height: 48 }, grow: 0 });

// No footer: the opted-in disclosure must fall to the data region (fixture for
// the opt-in body assertions); the next test covers the footer-preferred ladder.
const defaultPlan = plan(
  header,
  scope,
  slot("scope", "cluster health", { value: "Degraded" }),
  slot("scope", "GPU throughput", { value: "42 TFLOPS", order: 1 }),
);

/* -------------------------------------------------------------------------- */
/* (a) the default production screen carries NO disclosure                    */
/* -------------------------------------------------------------------------- */

test("(a) the default illustrative screen paints ZERO disclosure nodes, and the trace still records the data mode", () => {
  const { brief, built } = run(defaultPlan);

  assert.equal(brief.data.illustrative, true, "a demo screen must be recorded as illustrative");
  assert.equal(brief.onScreenDisclosure, false, "the default is a clean screen");
  assert.equal(disclosureCalls(built).length, 0, `a production screen carries no caveat: found ${disclosureCalls(built).length}`);

  // The truth does not disappear: the one build note records the illustrative
  // data mode AND names the opt-in that would bring the caption back.
  const notes = built.notes.filter((n) => /disclosure|illustrative/i.test(n));
  assert.equal(notes.length, 1, `expected one data-mode note, found ${notes.length}: ${notes.join(" | ")}`);
  assert.match(notes[0], /screens are clean by default/);
  assert.match(notes[0], /onScreenDisclosure/);
});

test("(a) onScreenDisclosure:true places exactly ONE node — beside the data, never the chrome", () => {
  const { brief, assumptions, built } = run(defaultPlan, { onScreenDisclosure: true });

  assert.equal(brief.onScreenDisclosure, true, "the request must reach the program as stated");
  assert.ok(
    assumptions.some((a) => a.id === "assume-on-screen-disclosure" && a.source === "stated"),
    "the explicit ask is recorded with provenance",
  );

  const calls = disclosureCalls(built);
  assert.equal(calls.length, 1, `expected exactly one disclosure, found ${calls.length}`);
  const only = calls[0];
  assert.equal(only.fn, "text");
  assert.equal(only.args.text, DISCLOSURE_TEXT);
  assert.equal(only.args.role, "caption");
  // It qualifies the data it sits on: the region with the most illustrative
  // values (both slots are illustrative), never the header.
  assert.equal(only.parent, "scope", "the disclosure lands on the data region, not the chrome");
  assert.notEqual(only.parent, header.id, "a caveat in the header reads as a system error");

  const notes = built.notes.filter((n) => /disclosure/i.test(n));
  assert.equal(notes.length, 1, `expected one disclosure note, found ${notes.length}: ${notes.join(" | ")}`);
  assert.match(notes[0], /one concise disclosure/);
  assert.match(notes[0], /as explicitly requested/);
});

test("(a) when the plan carries a footer, the opted-in disclosure is footer-adjacent", () => {
  const footerPlan = plan(header, scope, slot("scope", "cluster health", { value: "Degraded" }), footer);
  const { built: withFooter } = run(footerPlan, { onScreenDisclosure: true });
  assert.equal(disclosureCalls(withFooter).length, 1);
  assert.equal(disclosureCalls(withFooter)[0].parent, footer.id, "a footer region wins the placement ladder");
});

test("(a) cleanConcept wins over onScreenDisclosure: the contradiction resolves toward the cleaner screen", () => {
  const { brief, built } = run(defaultPlan, { cleanConcept: true, onScreenDisclosure: true });
  assert.equal(brief.cleanConcept, true);
  assert.equal(brief.onScreenDisclosure, false, "the no-caption request wins");
  assert.equal(disclosureCalls(built).length, 0);
});

/* -------------------------------------------------------------------------- */
/* (b) cleanConcept suppresses the disclosure but not the record               */
/* -------------------------------------------------------------------------- */

test("(b) cleanConcept:true emits zero on-screen disclosures, and the brief/trace still record illustrative", () => {
  const { brief, assumptions, built } = run(defaultPlan, { cleanConcept: true });

  assert.equal(brief.cleanConcept, true, "the request must reach the program as stated");
  assert.equal(brief.data.illustrative, true, "the data mode is still illustrative — suppression is not a lie");
  assert.ok(
    assumptions.some((a) => a.id === "assume-clean-concept" && a.source === "stated"),
    "the clean-concept request is recorded with provenance",
  );

  assert.equal(disclosureCalls(built).length, 0, "a clean concept carries no on-screen caveat");

  // The trace keeps the truth: the build notes still say the values are
  // illustrative without placing a node for it.
  assert.ok(
    built.notes.some((n) => /illustrative/.test(n)),
    `the trace must still record the illustrative data mode; notes were: ${built.notes.join(" | ")}`,
  );
  assert.equal(
    built.program.content.filter((c) => c.args?.text === DISCLOSURE_TEXT).length,
    0,
    "no node carries the disclosure copy at all",
  );
});

/* -------------------------------------------------------------------------- */
/* (c) a live screen says nothing — and emits no caveat noise at all           */
/* -------------------------------------------------------------------------- */

test("(c) a live-data screen carries zero disclosures and zero caveat notes", () => {
  const { brief, built } = run(defaultPlan, { dataMode: "live", dataNotes: "streamed from the cluster's own metrics service" });

  assert.equal(brief.data.illustrative, false, "live data is not illustrative");
  assert.equal(disclosureCalls(built).length, 0, "a live screen owes no disclosure");
  assert.equal(
    built.notes.filter((n) => /illustrative|disclosure/i.test(n)).length,
    0,
    `a live screen must not accrue caveat notes; notes were: ${built.notes.join(" | ")}`,
  );
});

/* -------------------------------------------------------------------------- */
/* (d) opted-in copy that already discloses never gets a second disclosure     */
/* -------------------------------------------------------------------------- */

test("(d) opted-in content that already carries a disclosure phrase is not disclosed twice", () => {
  const disclosingPlan = plan(
    header,
    scope,
    slot("scope", "Sample cluster snapshot", { value: "42 TFLOPS" }),
    slot("scope", "GPU throughput", { value: "8", order: 1 }),
    footer,
  );
  const { built } = run(disclosingPlan, { onScreenDisclosure: true });

  assert.equal(disclosureCalls(built).length, 0, "no second disclosure next to one the copy already carries");
  assert.ok(
    built.notes.some((n) => /already/.test(n)),
    `the note should say the dedupe happened; notes were: ${built.notes.join(" | ")}`,
  );
});

test("(d) the marker set recognises the ordinary disclosure words, and nothing else", () => {
  for (const phrase of [
    DISCLOSURE_TEXT,
    "sample data from the bench",
    "demo capture",
    "mock data",
    "placeholder value",
    "not live telemetry",
    "illustrative values",
    "synthetic cluster snapshot",
  ]) {
    assert.ok(alreadyDiscloses(phrase), `"${phrase}" already discloses`);
  }
  for (const phrase of ["GPU throughput", "cluster health", "42 TFLOPS", "shard assignment"]) {
    assert.equal(alreadyDiscloses(phrase), false, `"${phrase}" does not disclose`);
  }
  // proposed/planned/concept are capability markers in capability-truth.ts,
  // deliberately NOT data-disclosure markers here.
  assert.ok(alreadyDiscloses("mock"), "the bare word mock still discloses");
});

/* -------------------------------------------------------------------------- */
/* (e) the critic's repair instruction now rewords, it no longer paints        */
/* -------------------------------------------------------------------------- */

test("(e) the product-critic's fix demands honest rewording — it must not teach painting a caveat", () => {
  const report = evaluateProductCritic({
    revisionId: "rev-issue23",
    liveDataConnected: false,
    liveImplyingTerms: ["live telemetry"],
    renderedLabels: ["GPU memory", "Live telemetry gathered from every shard", "Model throughput"],
  });
  const finding = report.findings.find((f) => f.ruleId === "product.claims-live-data-without-source");

  assert.ok(finding, `expected the live-data finding; findings were: ${report.findings.map((f) => f.ruleId).join(", ")}`);
  assert.match(finding.suggestedFix, /[Rr]eword the live-sounding labels/);
  assert.doesNotMatch(finding.suggestedFix, /add a single concise disclosure|add .*Illustrative values/i, "the repair loop must not be sent back to paint captions");
  assert.doesNotMatch(finding.suggestedFix, /every value|each value|label every/i, "the fix must not demand per-value labels");
  assert.match(finding.suggestedFix, /onScreenDisclosure/, "the only caption path left is the explicit request");
  assert.match(finding.verification, /no label or value on the screen claims a live connection/i);
  assert.doesNotMatch(finding.verification, /exactly one concise disclosure qualifying/i, "verification no longer asks for the painted caption by default");
});

/* -------------------------------------------------------------------------- */
/* (f) nothing was weakened: an invented live claim still fails                */
/* -------------------------------------------------------------------------- */

test("(f) an invented live-data claim still fails at critical severity", () => {
  const report = evaluateProductCritic({
    revisionId: "rev-issue23-f",
    liveDataConnected: false,
    liveImplyingTerms: ["live telemetry"],
    renderedLabels: ["GPU memory", "Live telemetry from every shard"],
  });
  const finding = report.findings.find((f) => f.ruleId === "product.claims-live-data-without-source");

  assert.ok(finding, "the unbacked live claim must still be caught");
  assert.equal(finding.severity, "critical", "a live claim with no source is still a critical product failure");
  assert.match(finding.summary, /implies live data/);
  // The repair contract moved from painting captions to rewording; the
  // severity did not. An invented fact is not forgiven — it is still called
  // what it is.
  assert.ok(finding.severity !== "medium" && finding.severity !== "low");
});
