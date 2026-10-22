/**
 * The disclosure policy (issue #23 §4 — "reduce repetitive caveats without
 * faking product truth").
 *
 * ## The problem it decides
 *
 * Illustrative data stays honest only when the screen says so once. The
 * pressure runs the other way: every reviewer that cannot find the word
 * "sample" asks for labels, and labels multiply — a header, every panel, every
 * data row and the footer each carrying the same caveat is not honesty, it is
 * noise, and noise teaches the reader to skip exactly the sentence that keeps
 * the screen honest.
 *
 * So the policy produces one verdict, not a count of places to write in:
 *
 * - **Nothing to disclose, nothing shown.** The disclosure exists only when
 *   the screen carries values that are not live (`brief.data.illustrative`)
 *   *and* there are values on the screen to qualify. A live screen, or a
 *   structural screen with no values, carries none.
 * - **Clean concepts are requested, not invented.** The caller can ask for
 *   clean visual exploration (`cleanConcept: true`, normalized with its own
 *   provenance in `brief.ts`). The on-screen disclosure is suppressed entirely
 *   and the report keeps the truth instead: the brief, the assumption record
 *   and the build note still say the values are illustrative. Truthfulness
 *   moves to the report; it never disappears.
 * - **At most one, in one region.** One caption: a footer region when the
 *   plan has one, else the region carrying the most illustrative values (the
 *   data the disclosure qualifies), else the last region with content — and
 *   never navigation or header chrome, where a caveat reads as a system
 *   error rather than a data note.
 * - **Deduped against the copy itself.** If the content already names the
 *   data sample/demo/illustrative/mock/placeholder/not-live, no second
 *   disclosure is added. The marker vocabulary mirrors capability-truth.ts's
 *   `UNCERTAINTY_MARKERS`, narrowed to data words: proposed/planned/concept
 *   are *capability* markers that qualify a feature claim, not a statement
 *   that today's values are fixtures.
 *
 * Product facts are never weakened here and nothing here grants them: the
 * policy only ever adds the caveat, and the product-critic and capability
 * truth guards remain the judges of an invented capability claim.
 */
import type { CompositionPlan, NormalizedBrief } from "./contracts";

/** The id the single disclosure node carries, so verification can find it again. */
export const DISCLOSURE_ID = "data-disclosure";

/**
 * The one concise disclosure copy.
 *
 * One sentence, deliberately: it names what the values are and denies the
 * one thing a reader could wrongly conclude (a live connection). A second
 * sentence would be the start of the caveat storm this policy exists to end.
 */
export const DISCLOSURE_TEXT = "Illustrative values — the screen is not connected to live data.";

/**
 * Copy that already tells the reader the values are not live.
 *
 * Mirror of capability-truth.ts's UNCERTAINTY_MARKERS, narrowed to the words
 * that actually disclose data provenance (deliberately excluding
 * proposed/planned/concept/roadmap, which qualify capability claims).
 * DISCLOSURE_TEXT matches this too, so a rebuilt screen never doubles up.
 */
export const DISCLOSURE_MARKERS =
  /\b(sample|demo|mock( +data)?|illustrative|not +live|placeholder|synthetic|fictional)\b/i;

/** True when a string already tells the reader the values are not live. */
export function alreadyDiscloses(text: string): boolean {
  return DISCLOSURE_MARKERS.test(text);
}

export interface DisclosureDecision {
  /**
   * The single on-screen disclosure, when the policy places one: `parent`
   * names the one region the caption qualifies, `text` is the fixed copy.
   */
  call: { id: typeof DISCLOSURE_ID; parent: string; text: typeof DISCLOSURE_TEXT } | null;
  /**
   * Why the policy decided this, in the build note's words. `null` only when
   * there is nothing to record at all (the data is live and no caveat was
   * ever owed) — a note that says "no disclosure needed" would itself be
   * caveat noise.
   */
  note: string | null;
}

/**
 * Decides the one disclosure for a screen — or none.
 *
 * Deterministic by construction: the same brief and plan always produce the
 * same decision, because the parent is chosen by a fixed ladder (footer,
 * then the region with the most illustrative values, then the last region
 * with content) and ties resolve to the earliest region in plan order.
 */
export function decideDisclosure(
  brief: NormalizedBrief,
  plan: CompositionPlan,
): DisclosureDecision {
  // Not illustrative: nothing on the screen could read as live, so any
  // caveat would be inventing an apology for data that does not have one.
  if (!brief.data.illustrative) {
    return { call: null, note: null };
  }

  // A structural screen carries no values, so there is nothing to qualify.
  if (plan.content.length === 0) {
    return {
      call: null,
      note: "Data is illustrative, but the screen carries no values, so no disclosure was placed; the report records the illustrative data mode.",
    };
  }

  // Clean concept: the suppression is the caller's explicit request, so the
  // note says exactly what was traded away and where the truth went.
  if (brief.cleanConcept === true) {
    return {
      call: null,
      note: "Data is illustrative, but a clean concept was requested: the on-screen disclosure is suppressed and the report alone records that the values are not live.",
    };
  }

  // Dedupe against the copy the screen already carries. Scanning labels and
  // values (the material that could read as live) keeps the check honest: a
  // disclosure phrase buried in a data note does not disclose anything.
  const materials = plan.content.map((slot) => `${slot.label} ${slot.value ?? ""}`);
  const disclosed = materials.find((material) => alreadyDiscloses(material));
  if (disclosed !== undefined) {
    return {
      call: null,
      note: `Data is illustrative; the content already says so ("${disclosed.trim().slice(0, 60)}"), so no second disclosure was added.`,
    };
  }

  const parent = placement(plan);
  if (parent === null) {
    return {
      call: null,
      note: "Data is illustrative, but the plan names no region to place the disclosure in; the report records the illustrative data mode.",
    };
  }

  return {
    call: { id: DISCLOSURE_ID, parent, text: DISCLOSURE_TEXT },
    note: `Data is illustrative: one concise disclosure was placed once, in region '${parent}'. It is the only on-screen caveat; the report carries the full data provenance, and per-value labels were not added.`,
  };
}

/**
 * The placement ladder, in preference order. Returns a region id or null.
 *
 * 1. A footer region — footer-adjacent is where a data caveat reads as a note
 *    rather than an alarm, which is why it is the first choice.
 * 2. The region carrying the most illustrative values — the single caption
 *    sits on the data it qualifies instead of floating near it. Ties resolve
 *    to the earlier region, which keeps the choice stable across rebuilds.
 * 3. The last region with content — a screen whose values are all real still
 *    carries declared data (mode demo/unknown), so the caption lands at the
 *    bottom of the content rather than in the header.
 */
function placement(plan: CompositionPlan): string | null {
  const regions = plan.regions ?? [];
  const footer = regions.find((region) => region.role === "footer");
  if (footer !== undefined) return footer.id;

  const illustrativeCount = new Map<string, number>();
  for (const slot of plan.content) {
    if (slot.illustrative !== true) continue;
    illustrativeCount.set(slot.regionId, (illustrativeCount.get(slot.regionId) ?? 0) + 1);
  }
  if (illustrativeCount.size > 0) {
    let best: { id: string; count: number } | null = null;
    for (const region of regions) {
      const count = illustrativeCount.get(region.id) ?? 0;
      if (count === 0) continue;
      // Earlier regions win ties: the replacement is strictly greater-than,
      // so iterating in plan order is the tie-break.
      if (best === null || count > best.count) best = { id: region.id, count };
    }
    if (best !== null) return best.id;
  }

  const lastWithContent = [...regions]
    .reverse()
    .find((region) => plan.content.some((slot) => slot.regionId === region.id));
  return lastWithContent?.id ?? regions[regions.length - 1]?.id ?? null;
}
