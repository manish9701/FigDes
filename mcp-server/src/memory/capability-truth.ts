/**
 * The EXO capability-truth guard (issue #20, workstream 8).
 *
 * The design guard (`rules-exo.ts`) checks how a screen behaves; this module
 * checks what a screen *claims*. Those are different failures: a screen can
 * pass every design truth and still present Enterprise fleet controls, SSO,
 * audit logs, metering or multi-cluster support as shipped functionality when
 * no confirmed build has those features — and nothing in the file will stop
 * that, because the claim is true in the file.
 *
 * How it holds honest ground while infrastructure changes underneath it:
 *
 *  - the registry below states each capability's status explicitly
 *    (`confirmed` | `proposed` | `estimate`), rather than a prompt's opinion;
 *  - the source of truth is a pinned EXO target build, and it is NOT pinned in
 *    this repo — so the report says `unpinned` and every consequential claim
 *    is treated as needing visible uncertainty ("proposed", "planned",
 *    "estimate", "concept", "need to confirm") until a build is pinned;
 *  - model-fit claims must travel with their facts (required memory, available
 *    memory, the machines assessed) or be marked as estimates — a bare
 *    "fits"/"recommended" verdict presented as a fact is a claim the UI
 *    cannot back;
 *  - `trust_remote_code` capabilities, if exposed, must carry the explicit
 *    opt-in and its caution; and an instance presented as "ready" must not
 *    rely on a transport success alone (an HTTP 200 whose payload reports a
 *    timeout is a not-ready instance) — that is the same rule the transaction
 *    ledger already enforces for Figma mutations, applied to EXO's own
 *    semantics.
 *
 * Machine-checkable where the text allows it, `manual` elsewhere: the verdict
 * is designed to be *weaker* when evidence is missing, never stronger.
 */

export type CapabilityStatus = "confirmed" | "proposed" | "estimate";

export interface ExoCapability {
  id: string;
  /** The words a screen would use to present the capability. */
  label: string;
  status: CapabilityStatus;
  note: string;
  /** How UI language would surface one of these on a screen. */
  pattern: RegExp;
}

/**
 * The unconfirmed-unless-pinned enterprise set. These are the screens' most
 * expensive claims to make wrongly: a user provisioning "SSO" from a mockup
 * reads the interface as an invoice.
 */
export const EXO_CAPABILITIES: ExoCapability[] = [
  {
    id: "enterprise.fleet-controls",
    label: "Enterprise fleet controls",
    status: "proposed",
    note: "Fleet-wide device management appears in brief fixtures but is not confirmed against any pinned EXO build. Presented as shipped, it is a false claim; presenting it requires a Proposed/Planned marker.",
    pattern: /\b(fleet|assigned fleet|fleet management|manage all (devices|clusters)|enterprise)\b/i,
  },
  {
    id: "enterprise.roles",
    label: "Roles and permissions",
    status: "proposed",
    note: "Not confirmed against a pinned build.",
    pattern: /\b(roles?|permissions?|member management|admin console)\b/i,
  },
  {
    id: "enterprise.sso",
    label: "SSO",
    status: "proposed",
    note: "Not confirmed against a pinned build.",
    pattern: /\b(sso|single sign[- ]?on|saml|oidc)\b/i,
  },
  {
    id: "enterprise.policies",
    label: "Policies",
    status: "proposed",
    note: "Not confirmed against a pinned build.",
    pattern: /\b(policies?|policy enforcement)\b/i,
  },
  {
    id: "enterprise.audit",
    label: "Audit log",
    status: "proposed",
    note: "Not confirmed against a pinned build. Appears as optionalInformation in brief fixtures — a fixture is a brief, not a build.",
    pattern: /\b(audit log|audit trail|activity log)\b/i,
  },
  {
    id: "enterprise.metering",
    label: "Metering",
    status: "proposed",
    note: "Not confirmed against a pinned build.",
    pattern: /\b(metering|usage[- ]based|token spend|billing)\b/i,
  },
  {
    id: "enterprise.multi-cluster",
    label: "Multi-cluster support",
    status: "proposed",
    note: "Not confirmed against a pinned build.",
    pattern: /\b(multi[- ]cluster|cross[- ]cluster|multi[- ]node cluster)\b/i,
  },
  {
    id: "product.offline-operation",
    label: "Offline operation",
    status: "estimate",
    note: "EXO runs models locally, but what specifically works with the network down is a behaviour claim, not an architecture claim — it needs the pinned build, not a marketing assertion.",
    pattern: /\b(works? offline|offline mode|no (internet|network) required)\b/i,
  },
];

/** Explicit-uncertainty vocabulary that makes a proposed capability presentation acceptable. */
const UNCERTAINTY_MARKERS = /\b(proposed|planned|concept|roadmap|coming soon|future|design proposal|need (engineering )?to confirm|unverified|estimate|assumed|mock( +data)?|sample( +data)?|placeholder)\b/i;

/** Text that names a custom-model capability requiring explicit opt-in and caution. */
const TRUST_REMOTE_CODE = /trust[_ ]?remote[_ ]?code/i;

/** Text presenting an asynchronous instance as ready. */
const INSTANCE_READY = /\b((engine|instance|model|shard) (is |now )?(ready|running|live|available))\b/i;

/** How "ready" must be qualified in the same material to read as checked, not assumed. */
const READINESS_QUALIFIERS = /\b(poll|health|handshake|payload|states?|api (return|reports)|job|ready when|confirmed)\b/i;

export interface ExoCapabilitySource {
  /** True once a target EXO build/commit has been verified as the source of truth. */
  pinned: boolean;
  /** The pinned build identifier, when one exists. */
  build: string | null;
  note: string;
}

/**
 * The source-of-truth pin. NOT pinned in this repo: setting it true requires a
 * real EXO build identifier verified against the product, and the guard is
 * deliberately stricter (all consequential claims need visible uncertainty)
 * until that exists.
 */
export const EXO_CAPABILITY_SOURCE: ExoCapabilitySource = {
  pinned: false,
  build: null,
  note: "No EXO target build or commit is pinned as the source of truth. Every capability that is not a standing product truth must carry visible uncertainty until one is.",
};

/** Pins the source of truth after a caller verified a build. Refuses an empty pin. */
export function pinCapabilitySource(build: string): ExoCapabilitySource {
  const trimmed = build.trim();
  if (trimmed.length === 0) {
    throw new Error("pinCapabilitySource refuses an empty build id: pinning nothing looks like having pinned something.");
  }
  EXO_CAPABILITY_SOURCE.pinned = true;
  EXO_CAPABILITY_SOURCE.build = trimmed;
  EXO_CAPABILITY_SOURCE.note = `Source of truth pinned to EXO build ${trimmed}. Capability status is assessed against that build; claims beyond it still need visible uncertainty.`;
  return EXO_CAPABILITY_SOURCE;
}

export interface CapabilityFinding {
  id: string;
  severity: "fail" | "warn" | "manual";
  message: string;
  why: string;
  fix: string;
  /** Which capability the finding is about, plus the matched text. */
  matched: { capability: string; status: CapabilityStatus; text: string } | null;
}

export interface CapabilityTruthReport {
  verdict: "PASS" | "WARNING" | "FAIL" | "INDETERMINATE";
  findings: CapabilityFinding[];
  source: ExoCapabilitySource;
  reason: string;
}

/**
 * Checks a screen's text material for claims the product cannot back.
 *
 * The input is deliberately just the words on the screen (texts and layer
 * names): the check is whether the *language* asserts a capability, and a
 * text scan answers it without geometry or render-dependence.
 */
export function checkCapabilityTruth(input: { texts: string[]; nodeNames?: string[] }): CapabilityTruthReport {
  const material = [...input.texts.map((t) => t.trim()), ...(input.nodeNames ?? []).map((n) => n.trim())].filter((t) => t.length > 0);
  const findings: CapabilityFinding[] = [];

  const hasUncertaintyMarker = material.some((t) => UNCERTAINTY_MARKERS.test(t));
  const pinned = EXO_CAPABILITY_SOURCE.pinned;

  for (const capability of EXO_CAPABILITIES) {
    const matched = material.find((t) => capability.pattern.test(t));
    if (matched === undefined) continue;
    if (capability.status === "confirmed") continue; // a standing product truth can be stated flatly

    // A proposed/estimated capability is presentable, but its uncertainty
    // must be VISIBLE on the same screen, not implied by the registry.
    if (hasUncertaintyMarker && !pinned) {
      findings.push({
        id: `capability.${capability.id}.marked-uncertain`,
        severity: "manual",
        message: `"${capability.label}" appears and the screen carries an uncertainty marker, but no EXO build is pinned, so the marker itself cannot be verified against product behaviour.`,
        why: capability.note,
        fix: `Pin the target EXO build (pinCapabilitySource) and re-check this claim against it; keep the marker visible in the meantime.`,
        matched: { capability: capability.id, status: capability.status, text: matched },
      });
      continue;
    }
    if (hasUncertaintyMarker && pinned) continue; // marker present and a build is pinned: claim is traceable
    findings.push({
      id: `capability.${capability.id}.presented-as-shipped`,
      severity: "fail",
      message: `"${capability.label}" (${capability.status}) is presented as available with no visible "proposed"/"planned"/"estimate" marker, and EXO_CAPABILITY_SOURCE is ${pinned ? `pinned to ${EXO_CAPABILITY_SOURCE.build}` : "not pinned"}.`,
      why: capability.note,
      fix: pinned
        ? "Confirm the capability against the pinned build, or mark it Proposed/Planned/Estimate visibly in the UI."
        : "Mark the claim visibly as Proposed/Planned/Estimate/Concept, or remove it until the target build is pinned and the feature is confirmed.",
      matched: { capability: capability.id, status: capability.status, text: matched },
    });
  }

  /* -- model-fit claims ----------------------------------------------------- */

  const fitClaims = material.filter((t) => /\b(fits? on|fits|fit verdict|compatible with|recommended for|fits in memory)\b/i.test(t));
  for (const claim of fitClaims) {
    const optsIn = /\b(required|needs?|mem(ory)?|vram|gb)\b/i.test(claim) || material.some((t) => /\b(mem(ory)?|vram|gb)\b/i.test(t));
    const machines = /\b(machines?|devices?|nodes?|clusters?|topology|shards?)\b/i.test(claim) || material.some((t) => /\b(machines?|devices?|nodes?|clusters?|topology|shards?)\b/i.test(t));
    const uncertaintyHere = UNCERTAINTY_MARKERS.test(claim) || material.some((t) => UNCERTAINTY_MARKERS.test(t));
    if (optsIn && machines && uncertaintyHere) continue;
    findings.push({
      id: "product.fit-claim-without-context",
      severity: optsIn && machines ? "warn" : "fail",
      message: `A model-fit claim ("${claim.slice(0, 80)}") must carry the configuration assessed — required memory, available memory, the candidate machines — and mark what is estimated.`,
      why: `exo.model-fit-context: a fit verdict is only meaningful beside the facts that produced it, and an unpinned target makes every such verdict an estimate.`,
      fix: "Show required/available memory and the machines beside the verdict, and mark estimates as estimates.",
      matched: null,
    });
  }

  /* -- trust_remote_code ---------------------------------------------------- */

  for (const claim of material.filter((t) => TRUST_REMOTE_CODE.test(t))) {
    const hasOptIn = /\b(opt[- ]?in|explicit(ly)? (enable|allow)|advanced setting|security (warning|caution)|oli|unchecked code|arbitrary code risk)\b/i.test(claim) || material.some((t) => /\b(opt[- ]?in|security (warning|caution)|arbitrary code)\b/i.test(t));
    if (hasOptIn) continue;
    findings.push({
      id: "product.trust-remote-code-unmarked",
      severity: "warn",
      message: `A custom-model option mentioning trust_remote_code must carry explicit opt-in and its caution, or the option is not exposed.`,
      why: "Running arbitrary custom-model code is a security-boundary behaviour; presenting it as a quiet setting hides the decision the user is making.",
      fix: "Show the opt-in explicitly with the caution beside it, or remove the option from the screen.",
      matched: null,
    });
  }

  /* -- readiness semantics -------------------------------------------------- */

  for (const claim of material.filter((t) => INSTANCE_READY.test(t))) {
    const qualified = READINESS_QUALIFIERS.test(claim) || material.some((t) => READINESS_QUALIFIERS.test(t));
    if (qualified) continue;
    findings.push({
      id: "product.async-readiness-assumed",
      severity: "warn",
      message: `"${claim.slice(0, 80)}" states readiness without naming how it is checked. A successful HTTP response alone is not proof an asynchronous instance is ready — the payload may report a timeout.`,
      why: "The same semantics the transaction ledger enforces for Figma mutations: transport success and work complete are different claims, and the one must not substitute for the other.",
      fix: "Show the readiness check next to the state (payload state, poll result, or health probe), not the transport's success.",
      matched: null,
    });
  }

  const fails = findings.filter((f) => f.severity === "fail").length;
  const warns = findings.filter((f) => f.severity === "warn").length;
  let verdict: CapabilityTruthReport["verdict"];
  let reason: string;
  if (!pinned && material.length > 0 && findings.some((f) => f.id.endsWith("marked-uncertain"))) {
    verdict = "INDETERMINATE";
    reason = "No EXO build is pinned, so even marked claims cannot be traced to product behaviour. Pin the target build to settle them.";
  } else if (fails > 0) {
    verdict = "FAIL";
    reason = `${fails} confirmed-unbacked capability claim(s) and ${warns} context-poor claim(s).`;
  } else if (findings.length > 0) {
    verdict = "WARNING";
    reason = `${findings.length} capability claim(s) need their facts beside them.`;
  } else {
    verdict = "PASS";
    reason = material.length === 0 ? "No text material to check: no claim was asserted on screen." : `${pinned ? `Checked against ${EXO_CAPABILITY_SOURCE.build}.` : "No consequential claim found on this material."}`;
  }
  // A run over empty material judges nothing: INDETERMINATE beats a pass.
  if (material.length === 0) {
    verdict = "INDETERMINATE";
    reason = "No text material was supplied, so no capability claim could be checked.";
  }
  return { verdict, findings, source: { ...EXO_CAPABILITY_SOURCE }, reason };
}
