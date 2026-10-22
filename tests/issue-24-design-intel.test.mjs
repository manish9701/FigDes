/**
 * Issue #24 — design intelligence fixes (items 3, 9, 4).
 *
 * 1. **Composition intent (item 3)** — the `composition` field of the canonical
 *    `VisualIntent` was declared unsupported; the closed-vocabulary descriptors
 *    now compile into concrete composition decisions with provenance, and the
 *    ledger says "consumed" truthfully.
 * 2. **Variant intelligence (item 9)** — component resolution selects the
 *    best-matching variant of a component set instead of instancing the
 *    default blindly, with explainable reasons and a stated fallback bar.
 * 3. **Screenshot sanity QA (item 4)** — a dependency-free PNG inspector
 *    detects blank/uniform renders at the server boundary; heuristic findings
 *    are evidence with confidence, never hard failures.
 * * Imports point at the standard dist-test families (built by `npm run build:test`);
 * the design bundle includes `screenshot-qa.ts` (see the `build:design` file list).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import {
  compileVisualIntent,
  computeSignals,
  intentFieldLedger,
  VisualIntentSchema,
} from "../mcp-server/dist-test/design/skills/intent-compiler.js";
import {
  COMPOSITION_VOCABULARY,
  compositionHintFor,
  detectCompositionDescriptors,
} from "../mcp-server/dist-test/design/skills/composition.js";
import { buildCompositionPlan } from "../mcp-server/dist-test/design/composition/planner.js";
import { resolveComponents, matchVariant, isVariantSet, parseVariantProps } from "../mcp-server/dist-test/design/compiler/component-resolver.js";
import { analyzeScreenshot, screenshotFinding } from "../mcp-server/dist-test/design/quality/screenshot-qa.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

/** A normalized brief as the skills see it after the compiler's defensive defaults. */
function brief(overrides = {}) {
  return {
    id: "b24",
    screen: "Cluster health",
    product: "fenek-clusters",
    purpose: "watch the cluster and intervene when a node is under pressure",
    primaryDecision: "intervene or let the run continue",
    primaryAction: "drain the node",
    secondaryActions: [],
    requiredInformation: ["throughput", "latency p99", "error rate", "node pressure", "queue depth", "shard health"],
    optionalInformation: ["recent interventions"],
    values: {},
    data: { mode: "demo", notes: null, illustrative: true },
    interactions: [],
    viewport: { width: 1440, height: 900 },
    responsive: [],
    designSystemConstraints: [],
    references: { observations: [], assumptions: [] },
    visualDirection: null,
    antiGoals: [],
    states: [],
    scope: { create: [], edit: [], leaveUntouched: [] },
    existingPatterns: [],
    audience: "operator",
    archetype: null,
    desiredComposition: undefined,
    ...overrides,
  };
}

/* --- PNG encoding: the inverse of the inspector, written by hand ----------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Builds a real 8-bit RGB PNG with filter 0 scanlines, CRCs computed here. */
function makePng(width, height, pixelAt) {
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0); // filter type None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y);
      raw.push(r & 0xff, g & 0xff, b & 0xff);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */
/* 1. Composition intent (item 3)                                               */
/* -------------------------------------------------------------------------- */

test("the composition ledger entry is now consumed and names its consumer", () => {
  const ledger = intentFieldLedger();
  assert.equal(ledger.composition.status, "consumed");
  assert.ok(ledger.composition.consumer.includes("design/skills/composition.ts"));
  assert.ok(ledger.composition.consumer.includes("design/composition/planner.ts"));
  assert.ok(ledger.composition.effect.length > 20);
  // The ledger still covers every schema field.
  assert.deepEqual(new Set(Object.keys(VisualIntentSchema.shape)), new Set(Object.keys(ledger)));
});

test("the descriptor vocabulary is closed and detection honours negation", () => {
  assert.deepEqual([...COMPOSITION_VOCABULARY], ["asymmetric", "split", "centered", "radial", "dense-editorial", "topology-over-inspector"]);
  assert.deepEqual(detectCompositionDescriptors("asymmetric technical"), { applied: ["asymmetric"], excluded: [] });
  assert.deepEqual(detectCompositionDescriptors("not asymmetric"), { applied: [], excluded: ["asymmetric"] });
  assert.deepEqual(detectCompositionDescriptors("premium technical"), { applied: [], excluded: [] });
  assert.deepEqual(detectCompositionDescriptors("asymmetrical"), { applied: [], excluded: [] }, "no mid-word matches");
});

test("a composition descriptor compiles to decisions with provenance and a consumed intent field", () => {
  const art = compileVisualIntent(brief({ visualDirection: "asymmetric" }));
  assert.ok(art.signals.includes("composition-request"), `signals: ${art.signals.join(", ")}`);
  assert.equal(art.intent.composition, "asymmetric");
  const decision = art.decisions.find((d) => d.key === "visual-intent.composition");
  assert.ok(decision, `decisions: ${art.decisions.map((d) => d.key).join(", ")}`);
  assert.equal(decision.skill, "composition-strategy");
  assert.ok(decision.why.includes("'asymmetric'"), `provenance: ${decision.why}`);
  assert.ok(decision.why.includes("geometry"), "the why states the concrete commitments");
  // The direction skill handed the word off instead of calling it untranslated.
  assert.ok(art.notes.some((n) => n.includes("composition descriptor") && n.includes("asymmetric")), art.notes.join(" | "));
  // The compiled intent is still the runtime's own schema.
  assert.ok(VisualIntentSchema.safeParse(art.intent).success, JSON.stringify(art.intent));
});

test("an overlay descriptor stacks and can override density with the override kept in the trail", () => {
  const art = compileVisualIntent(brief({ visualDirection: "asymmetric dense-editorial" }));
  assert.equal(art.intent.composition, "asymmetric+dense-editorial");
  assert.equal(art.intent.density, "dense", `the overlay commits density: ${JSON.stringify(art.intent)}`);
  const override = art.decisions.find((d) => d.key === "density overridden");
  assert.ok(override, "the archetype's density stays in the trail");
  assert.ok(override.why.includes("asymmetric+dense-editorial"));
});

test("contradictory composition values: the first arrangement wins, the second is recorded", () => {
  const art = compileVisualIntent(brief({ visualDirection: "asymmetric centered" }));
  assert.equal(art.intent.composition, "asymmetric");
  assert.ok(art.notes.some((n) => n.includes("'centered'") && n.includes("recorded but not applied")), art.notes.join(" | "));
  assert.ok(VisualIntentSchema.safeParse(art.intent).success);
});

test("a caller-stated composition stays the hard constraint the descriptor shapes manner inside", () => {
  const art = compileVisualIntent(brief({ visualDirection: "asymmetric", desiredComposition: "topology" }));
  assert.equal(art.intent.composition, "asymmetric");
  const decision = art.decisions.find((d) => d.key === "visual-intent.composition");
  assert.ok(decision.why.includes("hard shell constraint"), `subordination recorded: ${decision.why}`);
  const archetype = art.decisions.find((d) => d.key === "archetype");
  assert.equal(archetype.hard, true, "the caller's composition is still the hard decision");
});

test("a negated descriptor compiles no composition field and fires no signal", () => {
  const art = compileVisualIntent(brief({ visualDirection: "not asymmetric" }));
  assert.equal(art.intent.composition, undefined, "a negated descriptor is never written");
  assert.ok(!art.signals.includes("composition-request"));
  const facts = computeSignals(brief({ visualDirection: "not asymmetric" }));
  assert.ok(!facts.signals.includes("composition-request"));
});

test("the planner consumes the composition hint with provenance", () => {
  const withoutHint = buildCompositionPlan({ pattern: null, focalId: null, hierarchy: [], regions: [] });
  const { hint } = compositionHintFor(["asymmetric"], "stated in the direction");
  const withHint = buildCompositionPlan({ pattern: null, focalId: null, hierarchy: [], regions: [], compositionHint: hint });
  assert.ok(withHint.geometry.strategy.includes("asymmetric"), withHint.geometry.strategy);
  assert.ok(withHint.geometry.rules.some((r) => r.includes("composition hint 'asymmetric'")), withHint.geometry.rules.join(" | "));
  assert.ok(withHint.negativeSpace.strategy.includes("composition hint 'asymmetric'"));
  assert.equal(withoutHint.geometry.strategy, "resolved layout geometry", "no hint, no override");

  const dense = compositionHintFor(["dense-editorial"], "stated in the direction").hint;
  const densePlan = buildCompositionPlan({ pattern: null, focalId: null, hierarchy: [], regions: [], compositionHint: dense });
  assert.equal(densePlan.density.level, "dense");
  assert.ok(densePlan.density.rationale.includes("composition hint 'dense-editorial'"), densePlan.density.rationale);
  assert.ok(densePlan.negativeSpace.strategy.includes("whitespace rhythm 'generous'"));
});

/* -------------------------------------------------------------------------- */
/* 2. Variant intelligence (item 9)                                             */
/* -------------------------------------------------------------------------- */

function knowledge(name, role, variants, extra = {}) {
  return {
    nodeId: `id-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    role,
    variants: variants.map((v) => ({ name: v })),
    dimensions: {},
    ...extra,
  };
}

const BUTTON_SET = knowledge("Primary Button", "button", [
  "state=default, size=md",
  "state=hover, size=md",
  "state=selected, size=md",
  "state=disabled, size=lg",
]);

test("variant parsing and set detection are honest about what they can read", () => {
  assert.deepEqual(parseVariantProps("state=selected, size=md"), { state: "selected", size: "md" });
  assert.deepEqual(parseVariantProps("icon=true"), { icon: "true" });
  assert.equal(isVariantSet(BUTTON_SET), true);
  assert.equal(isVariantSet(knowledge("Button", "button", [])), false);
  assert.equal(isVariantSet(knowledge("Button", "button", ["pressed"])), false, "a single property-less variant is not a set");
});

test("a state intent resolves the matching variant of a component set with a reason", () => {
  const plans = resolveComponents({
    known: [BUTTON_SET],
    needs: [{ regionId: "r1", role: "button", query: "primary", props: { state: "selected" } }],
  });
  assert.equal(plans.length, 1);
  const plan = plans[0];
  assert.equal(plan.reuseComponentId, BUTTON_SET.nodeId);
  assert.equal(plan.variant.name, "state=selected, size=md");
  assert.equal(plan.variant.score, 1);
  assert.ok(plan.variant.reasons.some((r) => r.includes("state='selected' exact match")), plan.variant.reasons.join("; "));
  assert.ok(plan.reason.includes("Variant 'state=selected, size=md' selected"), plan.reason);
  assert.equal(plan.manualVariantProps, undefined, "no manual edits needed");
});

test("a size intent matches too, and an unmodelled key is neutral but reported", () => {
  const match = matchVariant(BUTTON_SET.variants.map((v) => v.name), { state: "disabled", size: "lg" });
  assert.equal(match.selected, true);
  assert.equal(match.best.name, "state=disabled, size=lg");
  const partial = matchVariant(BUTTON_SET.variants.map((v) => v.name), { state: "hover", theme: "dark" });
  assert.equal(partial.best.name, "state=hover, size=md");
  assert.ok(partial.best.reasons.some((r) => r.includes("theme") && r.includes("not modelled")));
});

test("no variant match falls back to the default variant with manual edits and a fallback reason", () => {
  const plans = resolveComponents({
    known: [BUTTON_SET],
    needs: [{ regionId: "r2", role: "button", query: "primary", props: { state: "pressed" } }],
  });
  const plan = plans[0];
  assert.equal(plan.reuseComponentId, BUTTON_SET.nodeId, "reuse still wins at the component level");
  assert.equal(plan.variant, undefined, "no variant was selected");
  assert.deepEqual(plan.manualVariantProps, { state: "pressed" });
  assert.ok(plan.reason.includes("No variant of the set matches"), plan.reason);
  assert.ok(plan.reason.includes("0.6 bar"), `the stated bar is named: ${plan.reason}`);
});

test("a component that is not a set falls back to manual edits instead of a fake variant", () => {
  const plain = knowledge("Primary Button", "button", []);
  const plans = resolveComponents({
    known: [plain],
    needs: [{ regionId: "r3", role: "button", query: "primary", props: { state: "selected" } }],
  });
  const plan = plans[0];
  assert.equal(plan.variant, undefined);
  assert.deepEqual(plan.manualVariantProps, { state: "selected" });
  assert.ok(plan.reason.includes("no variant to select"), plan.reason);
});

test("without requested properties the resolver behaves exactly as before", () => {
  const plans = resolveComponents({ known: [BUTTON_SET], needs: [{ regionId: "r4", role: "button", query: "primary" }] });
  const plan = plans[0];
  assert.equal(plan.variant, undefined);
  assert.equal(plan.manualVariantProps, undefined);
  assert.ok(plan.reason.startsWith("Reuse"));
});

/* -------------------------------------------------------------------------- */
/* 3. Screenshot sanity QA (item 4)                                             */
/* -------------------------------------------------------------------------- */

test("a hand-built uniform PNG is suspect-uniform with the dominant colour reported", () => {
  const png = makePng(24, 24, () => [14, 98, 160]);
  const analysis = analyzeScreenshot(png);
  assert.equal(analysis.renderStatus, "suspect-uniform");
  assert.equal(analysis.dominantColor, "#0e62a0");
  assert.equal(analysis.colorCount, 1);
  assert.equal(analysis.dominantColorRatio, 1);
  assert.equal(analysis.luminanceVariance, 0);
  assert.ok(analysis.warnings.some((w) => w.code === "near-uniform"), analysis.warnings.map((w) => w.code).join(", "));
  assert.ok(analysis.warnings.every((w) => w.confidence < 1), "heuristics carry confidence below certainty");
});

test("a flat white PNG is suspect-blank, not just uniform", () => {
  const png = makePng(24, 24, () => [255, 255, 255]);
  const analysis = analyzeScreenshot(png);
  assert.equal(analysis.renderStatus, "suspect-blank");
  assert.equal(analysis.dominantColor, "#ffffff");
  assert.ok(analysis.warnings.some((w) => w.code === "near-blank"));
});

test("a varied PNG is ok with high luminance variance and no uniformity warning", () => {
  /* xorshift32: a tiny deterministic PRNG with full-tail randomness, so the
     sample variance lands near the uniform-ideal (~0.083 normalised). */
  let seed = 2463534242 >>> 0;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed % 256;
  };
  const png = makePng(32, 32, () => [next(), next(), next()]);
  const analysis = analyzeScreenshot(png);
  assert.equal(analysis.renderStatus, "ok");
  /* Fully random RGB peaks around 0.047 normalised (the luminance weights
     shrink the per-channel variance); 0.02 already means real signal — a flat
     fill measures 0. */
  assert.ok(analysis.luminanceVariance > 0.02, `variance: ${analysis.luminanceVariance}`);
  assert.ok(analysis.colorCount > 100, `colours: ${analysis.colorCount}`);
  assert.ok(analysis.dominantColorRatio < 0.05, `dominant share: ${analysis.dominantColorRatio}`);
  assert.equal(analysis.warnings.filter((w) => w.code === "near-uniform" || w.code === "near-blank").length, 0);
});

test("a horizontal gradient render is caught by column-band evidence without being called uniform", () => {
  const png = makePng(24, 16, (x) => [Math.floor((x / 23) * 255), 40, 40]);
  const analysis = analyzeScreenshot(png);
  assert.equal(analysis.renderStatus, "ok", "colour varies, so not uniform — but the bands say 'fill'");
  assert.ok(analysis.warnings.some((w) => w.code === "column-band"), analysis.warnings.map((w) => w.code).join(", "));
  assert.equal(analysis.uniformCols, analysis.sampledWidth, "every sampled column is one flat colour band");
});

test("non-PNG bytes report undecodable with a warning instead of throwing", () => {
  const analysis = analyzeScreenshot(new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(analysis.renderStatus, "undecodable");
  assert.ok(analysis.warnings.some((w) => w.code === "png-invalid"));
});

test("screenshot findings are heuristic evidence: low/medium severity, sub-gate confidence, caller decides", () => {
  const uniform = analyzeScreenshot(makePng(8, 8, () => [10, 10, 10]));
  const finding = screenshotFinding(uniform, { revisionId: "rev-1", reference: "focal frame" });
  assert.ok(finding, "a suspect render yields a finding");
  assert.equal(finding.ruleId, "screenshot.sanity");
  assert.equal(finding.category, "visual");
  assert.equal(finding.severity, "medium");
  assert.ok(finding.confidence < 0.6, "below the confirmed-defect bar: evidence, never a hard failure");
  assert.equal(finding.evidence[0].revisionId, "rev-1");
  assert.equal(finding.evidence[0].type, "screenshot-region");

  const varied = analyzeScreenshot(makePng(8, 8, (x, y) => [(x * 37) % 256, (y * 53) % 256, (x + y) * 5 % 256]));
  assert.equal(screenshotFinding(varied, { revisionId: "rev-1", reference: "focal frame" }), null, "a clean render is a measured no-finding");
});
