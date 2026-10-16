/**
 * Identity preflight: is every name in the program unique, and does every
 * reference resolve?
 *
 * ## Why this is its own pass
 *
 * A duplicate id is not a cosmetic problem. Every other box in the compiler is
 * keyed by id — `boxes` is a `Map<string, PlacedBox>`, relations resolve anchors
 * by looking ids up, connectors route between the boxes they name, and emitted
 * operations use the id as the node reference. So two content items called
 * `same` collapse into one map entry: the second one is silently dropped from
 * layout, the relation anchors to whichever was written last, and the operation
 * list ends up with two operations carrying the same id.
 *
 * The live stress run (issue #12, A8) found exactly this — "Duplicate content ID
 * `same` is not explicitly reported and produces two emitted operations with the
 * same ID" — and the diagnosis was a geometry mismatch rather than the actual
 * cause. A wrong position and a name collision produce the same downstream
 * symptom, so the collision has to be named before it can be found.
 *
 * The existing `preflight.ts` also checks id uniqueness, but it runs against
 * *operations* on the way to Figma. By then the damage is done: geometry has
 * been resolved against a corrupted map and the caller is reading geometry
 * violations. This runs against the *program*, before layout, so the message can
 * be about the thing the author actually wrote.
 */
import type { DesignIR } from "../../../shared/ir";

export type IdentityViolation = { rule: "identity"; message: string };

/**
 * Every uniqueness and reference problem in one pass, in declaration order.
 *
 * Returning all of them at once is deliberate. A model that reuses ids usually
 * reuses them more than once, and one message per round trip turns one typo into
 * four round trips and four more typos.
 */
export function checkIdentity(ir: DesignIR): IdentityViolation[] {
  const out: IdentityViolation[] = [];
  const regions = ir.regions ?? [];
  const content = ir.content ?? [];
  const tokens = (ir.tokens ?? []).filter((t): t is Extract<typeof t, { kind: "token" }> => t.kind === "token");
  const relations = ir.relations ?? [];
  const links = ir.links ?? [];

  /* ---- uniqueness, per collection --------------------------------------- */

  const regionDupes = duplicates(regions.map((r) => r.id));
  for (const [id, where] of regionDupes) {
    out.push({ rule: "identity", message: `Region id '${id}' is declared ${where}. Region ids must be unique — two regions with one id collapse into one box, and the second is silently dropped.` });
  }

  const contentDupes = duplicates(content.map((c) => c.id));
  for (const [id, where] of contentDupes) {
    out.push({ rule: "identity", message: `Content id '${id}' is declared ${where}. Content ids must be unique — operations are emitted per id, so a repeated id emits two operations for one node.` });
  }

  const tokenDupes = duplicates(tokens.map((t) => t.id));
  for (const [id, where] of tokenDupes) {
    out.push({ rule: "identity", message: `Token id '${id}' is declared ${where}. Token ids must be unique.` });
  }

  // Two tokens with the same *name* bind to the same Figma variable, so the
  // second silently wins and any colour that referenced the first now points
  // somewhere else. That is the "tokens drift silently" failure in A10.
  const tokenNameDupes = duplicates(tokens.map((t) => t.name));
  for (const [name, where] of tokenNameDupes) {
    out.push({ rule: "identity", message: `Token name '${name}' is declared ${where}. Two tokens with one name bind to the same variable, so the later definition silently overwrites the earlier.` });
  }

  /* ---- cross-collection collisions -------------------------------------- */

  // Regions and content share one id space: a region and a content item with the
  // same id emit two `createFrame`s under one node reference.
  const regionIds = new Set(regions.map((r) => r.id));
  for (const c of content) {
    if (regionIds.has(c.id)) {
      out.push({ rule: "identity", message: `Id '${c.id}' is used by both a region and a content item. Ids share one namespace across the whole program.` });
    }
  }

  /* ---- dangling references ---------------------------------------------- */

  const contentIds = new Set(content.map((c) => c.id));
  const known = new Set<string>([...regionIds, ...contentIds]);

  for (const region of regions) {
    for (const childId of region.children ?? []) {
      if (!known.has(childId)) {
        out.push({ rule: "identity", message: `Region '${region.id}' lists child '${childId}', which is not a region or content item.` });
      }
    }
  }

  // A content id claimed by two regions is ambiguous: the orphan-adoption path
  // would attach it to whichever region was read first.
  const claimed = new Map<string, string[]>();
  for (const region of regions) {
    for (const childId of region.children ?? []) {
      claimed.set(childId, [...(claimed.get(childId) ?? []), region.id]);
    }
  }
  for (const [childId, owners] of claimed) {
    if (owners.length > 1) {
      out.push({ rule: "identity", message: `Content '${childId}' is a child of ${owners.map((o) => `'${o}'`).join(" and ")}. A node has exactly one parent.` });
    }
  }

  for (const link of links) {
    for (const [side, id] of [["from", link.from], ["to", link.to]] as const) {
      if (!known.has(id)) {
        out.push({ rule: "identity", message: `Link ${side} '${id}' does not resolve to a region or content item.` });
      }
    }
  }

  /* ---- conflicting relations -------------------------------------------- */

  // Two relations constraining one node are contradictory by construction: the
  // solver applies them in turn and the last one silently wins. That is how
  // "expected x=1048, resolved x=316" happens without any cycle involved.
  const relationTargets = new Map<string, number>();
  for (const r of relations) relationTargets.set(r.id, (relationTargets.get(r.id) ?? 0) + 1);
  for (const [id, n] of relationTargets) {
    if (n > 1) {
      out.push({ rule: "identity", message: `Node '${id}' has ${n} relations. A node is positioned by one relation; extra relations are applied in order and the last one silently wins.` });
    }
  }

  /* ---- value validation -------------------------------------------------- */

  // A variable created from an unparseable value is worse than one that was
  // never created: it binds, it fills with a default, and every reference to it
  // silently resolves to the wrong colour or number. X02 declared `#ZZZZZZ` as
  // a colour token and nothing said so — the identity check caught the duplicate
  // id beside it and went quiet about the value.
  for (const t of tokens) {
    const where = `Token '${t.name}' (id '${t.id}')`;
    if (Object.keys(t.values).length === 0) {
      out.push({ rule: "identity", message: `${where} declares no values, so it creates a variable nothing can reference.` });
    }
    for (const [mode, value] of Object.entries(t.values)) {
      if (value === undefined || value === null || value === "") {
        out.push({ rule: "identity", message: `${where} has an empty value for mode '${mode}'. A variable with no value cannot be bound.` });
        continue;
      }
      if (t.type === "color" && !isColorValue(String(value))) {
        out.push({
          rule: "identity",
          message: `${where} declares ${mode}='${value}', which is not a colour. Use #RRGGBB, #RGB, #RRGGBBAA, rgb(r,g,b), rgba(r,g,b,a) or 'transparent'.`,
        });
      } else if (t.type === "number" && !Number.isFinite(typeof value === "number" ? value : Number(value))) {
        out.push({ rule: "identity", message: `${where} declares ${mode}='${value}', which is not a number.` });
      } else if (t.type === "boolean" && typeof value !== "boolean") {
        out.push({ rule: "identity", message: `${where} declares ${mode}='${value}', which is not a boolean.` });
      } else if (t.type === "string" && typeof value !== "string") {
        out.push({ rule: "identity", message: `${where} declares ${mode}=${JSON.stringify(value)}, which is not a string.` });
      }
    }
  }

  return out;
}

/** Colour forms the plugin can actually paint, or bind to a variable. */
function isColorValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return true;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return true;
  if (/^rgba?\(\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(v)) return true;
  // A variable reference rather than a literal: resolved at bind time.
  return /^[a-z][\w./-]*$/.test(v);
}

/**
 * Ids appearing more than once, as `id -> "at positions 1, 4"`.
 *
 * Positions rather than counts because "declared twice" does not tell the author
 * which two declarations to merge, and the fix is to rename one of them.
 */
function duplicates(ids: string[]): Map<string, string> {
  const at = new Map<string, number[]>();
  ids.forEach((id, i) => {
    at.set(id, [...(at.get(id) ?? []), i]);
  });
  const out = new Map<string, string>();
  for (const [id, positions] of at) {
    if (positions.length > 1) {
      out.set(id, `${positions.length} times (entries ${positions.map((p) => p + 1).join(", ")})`);
    }
  }
  return out;
}
