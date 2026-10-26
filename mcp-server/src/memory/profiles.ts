/**
 * Product design profiles (GitHub issue #27 — project-aware, domain-agnostic).
 *
 * ## Why this module exists
 *
 * The core design intelligence — hierarchy, composition, legibility, interaction
 * clarity, accessibility, responsive behaviour, semantic primitives, design-system
 * reuse, evidence-backed review — is reusable across products and domains. What is
 * NOT global is one product's vocabulary, capability claims, screen archetypes and
 * acceptance rules. Those live here, in a named profile, resolved for the ACTIVE
 * project before planning and review — never as privileged defaults in the engine.
 *
 * Before this module, `rules-exo` was imported as a global default: every fresh
 * project, whatever it was, was guarded by EXO's product truths and every plan
 * preview could fire `exo.no-generic-saas`. That is the cross-project leak issue
 * #27 names. EXO still exists — as an ordinary, named profile.
 *
 * ## Resolution order (most specific wins)
 *
 * 1. `explicit`  — the task brief names the profile (`profile: "exo"`).
 * 2. `memory`    — the project recorded its profile via project_memory.
 * 3. `implied`   — the project's stored rules use a built-in profile's rule-id
 *                  namespace (continuity for memories seeded before this
 *                  boundary existed; an `exo.*` id implies the exo profile).
 * 4. `key-seeded`— the project key names the product, the same mechanism (and
 *                  the same honesty limits) the store's default notes use.
 * 5. none        — general, domain-neutral defaults with NO product rules.
 */
import type { ProductRule, ProjectMemory, ProjectProfileRef } from "../../../shared/memory";
import { EXO_RULES } from "./rules-exo";

/** The shape one product profile declares. */
export interface ProductProfileSpec {
  id: string;
  label: string;
  /** What the product is, in one line. Feeds project context, not acceptance. */
  domain: string;
  /** The product truths design_guard and plan previews check for this project. */
  rules: ProductRule[];
  /**
   * Named archetype inference: when a decision maps to one of THIS product's
   * known screens, resolve it. Applies only while this profile is active —
   * an unrelated product's "deployment" screen must not inherit EXO's
   * model-fit priorities.
   */
  archetypeInference: boolean;
  /**
   * This product's lifecycle vocabulary for monitored/launched objects, keyed
   * by decision kind. A general project gets none: it names its own states.
   */
  runtimeStates: Partial<Record<string, string[]>>;
  /**
   * The placement truth a `deploy` decision carries for THIS product, or null
   * when the product does not state one (a general deployment screen states
   * placement neutrally: what runs, required vs available, the fit verdict).
   */
  placementTruth: string | null;
  /** The rule id that guards the metric-card-wall composition, when the product declares one. */
  metricWallRuleId: string | null;
  /**
   * The capability-claim registry this profile's screens are judged against,
   * or null when the profile declares none (issue #27). The claim registry is
   * product data — what a "shipped" claim can mean — so only the profile that
   * owns it can have its screens judged by it; everyone else gets NOT
   * EVALUATED with the reason, never another product's claims.
   */
  capabilityRegistry: string | null;
}

export const EXO_PROFILE: ProductProfileSpec = {
  id: "exo",
  label: "EXO",
  domain: "Local-first compute fabric: devices, models and live inference.",
  rules: EXO_RULES,
  archetypeInference: true,
  runtimeStates: {
    deploy: [
      "model downloading",
      "model preparing",
      "model fitting",
      "model loading",
      "device unavailable",
      "cluster degraded",
    ],
    topology: [
      "device connecting",
      "model downloading",
      "model preparing",
      "model fitting",
      "model loading",
      "inference running",
      "device unavailable",
      "cluster degraded",
    ],
    monitor: [
      "device connecting",
      "model downloading",
      "model preparing",
      "model fitting",
      "model loading",
      "inference running",
      "device unavailable",
      "cluster degraded",
    ],
  },
  placementTruth:
    "placement is recommended automatically, never arranged by dragging shards by hand",
  metricWallRuleId: "exo.no-generic-saas",
  capabilityRegistry: "exo",
};

/** Every built-in product profile, by id. EXO is an ordinary entry. */
export const PRODUCT_PROFILES: Record<string, ProductProfileSpec> = {
  exo: EXO_PROFILE,
};

export const PRODUCT_PROFILE_IDS = Object.keys(PRODUCT_PROFILES);

/** Looks a profile spec up by id. `undefined` for an unknown product.
 *  Ids are lower-case; brief-declared products ("EXO") resolve by case-insensitive
 *  id so a product's own name still finds its profile. Explicit `profile:` tool
 *  arguments are validated against the exact ids instead (assertKnownProfile). */
export function profileForProduct(product: string | null | undefined): ProductProfileSpec | undefined {
  if (!product) return undefined;
  return PRODUCT_PROFILES[product] ?? PRODUCT_PROFILES[product.toLowerCase()];
}

/** Throws when `product` names no built-in profile, listing the known ones. */
export function assertKnownProfile(product: string | null | undefined): void {
  if (!product) return;
  if (PRODUCT_PROFILES[product] === undefined) {
    throw new Error(
      `Unknown project profile '${product}'. Known profiles: ${PRODUCT_PROFILE_IDS.join(", ")}. ` +
        "A project with no profile plans under general, domain-neutral defaults; product rules are recorded per project via project_memory.",
    );
  }
}

/**
 * Errors when with exo implied by an `exo.*` rule id in the stored set.
 * Deliberately prefix-scoped: the `exo.*` namespace is EXO's — a project
 * recording under it is speaking about THAT product, which is the one
 * honest marker a legacy memory file carried.
 */
function impliedProductFromStoredRules(memory: ProjectMemory | null | undefined): string | null {
  if ((memory?.rules ?? []).some((r) => typeof r?.id === "string" && r.id.startsWith("exo."))) return "exo";
  return null;
}

/**
 * The key seed (issue #27): a project whose key NAMES a product as its own
 * word ("exo-fleet") seeds that product's profile and identity — the same
 * mechanism the EXO notes' seed always used. Word boundaries matter:
 * "nexo-crm" is not an EXO project.
 */
export function keySeedsProfile(key: string | null | undefined): string | null {
  const k = key ?? "";
  for (const id of PRODUCT_PROFILE_IDS) {
    if (new RegExp(`\\b${id}\\b`).test(k)) return id;
  }
  return null;
}

/**
 * The product id whose profile is active for this project, or null for a
 * general, domain-neutral project. See the module header for the order.
 */
export function resolveActiveProduct(memory: ProjectMemory | null | undefined, explicit?: string | null): string | null {
  if (explicit !== undefined && explicit !== null) {
    assertKnownProfile(explicit);
    return explicit;
  }
  if (!memory) return null;
  const recorded = memory.profile?.product;
  if (recorded) {
    assertKnownProfile(recorded);
    return recorded;
  }
  const implied = impliedProductFromStoredRules(memory);
  if (implied) return implied;
  // Key seeding — mirrors the store's default notes (`key.includes("exo")`):
  // a project whose key names the product IS that product's project, as far
  // as seeding goes. Unrelated keys stay unrelated.
  if ((memory.project ?? "").includes("exo")) return "exo";
  return null;
}

/** What a profile resolution looked like — reported with plans and guard runs. */
export interface ResolvedProfile {
  /** The resolved product id, or null for a general domain-neutral project. */
  product: string | null;
  /** The spec, or null when no profile applies. */
  spec: ProductProfileSpec | null;
  /** The product truths active for this project (empty when general). */
  rules: ProductRule[];
  /** Which rule ids are active — what plan previews and vetoes can reference. */
  ruleIds: string[];
  /** How the profile was resolved. */
  source: "explicit" | "memory" | "implied" | "key-seeded" | "none";
  /** The project's own description of itself, when recorded. */
  ref: ProjectProfileRef | null;
}

/**
 * Resolves the active project design profile.
 *
 * Pure: reads nothing from disk. Callers hand it the memory they already
 * loaded, plus (optionally) the profile the task brief named.
 */
export function resolveProfile(opts: { memory?: ProjectMemory | null; explicit?: string | null } = {}): ResolvedProfile {
  const memory = opts.memory ?? null;
  const source =
    opts.explicit !== undefined && opts.explicit !== null
      ? "explicit"
      : memory?.profile?.product
        ? "memory"
        : impliedProductFromStoredRules(memory)
          ? "implied"
          : (memory?.project ?? "").includes("exo")
            ? "key-seeded"
            : "none";
  const product = resolveActiveProduct(memory, opts.explicit);
  const spec = profileForProduct(product) ?? null;
  return {
    product,
    spec,
    rules: spec ? spec.rules : [],
    ruleIds: spec ? spec.rules.map((r) => r.id) : [],
    source,
    ref: memory?.profile ?? null,
  };
}
