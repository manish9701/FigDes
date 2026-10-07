/**
 * The built-in EXO rule set (spec §29, §51).
 *
 * These are the project's *product truths*, written as checkable data rather
 * than prose in a prompt. That distinction is the whole reason they live here:
 * a rule the server cannot evaluate would be a comment, and a comment cannot
 * stop a design from contradicting the product.
 *
 * Every entry pairs the truth with the thing it forbids. "Devices auto-discover"
 * on its own is a fact nobody can act on; "therefore do not design a connect-device
 * wizard" is a constraint.
 *
 * Evidence kinds are limited to what `mcp-server/src/memory/guard.ts` can
 * actually measure. Anything requiring judgement is declared `manual`, which
 * surfaces the question to a human instead of guessing. A guard that guesses
 * wrong is worse than one that asks.
 */
import type { ProductRule } from "../../../shared/memory";

export const EXO_RULES: ProductRule[] = [
  {
    id: "exo.auto-discovery",
    rule: "Device discovery is automatic.",
    therefore: "Do not create manual device-pairing, \"connect device\", or QR-scan wizard UI.",
    severity: "fail",
    evidence: [
      { kind: "forbiddenText", pattern: "connect device|pair device|scan (the )?(qr|code)|add device|manually connect" },
    ],
    passesWhen: ["The screen shows discovered devices as already-present state", "Pairing appears only as an optional advanced path"],
  },
  {
    id: "exo.topology-detection",
    rule: "EXO reads network topology automatically.",
    therefore: "Display network state rather than asking the user to choose an interface or link type.",
    severity: "fail",
    evidence: [
      { kind: "forbiddenText", pattern: "select (a )?(network|interface)|choose (your )?(wi-?fi|ethernet|interface)|detect network" },
    ],
    passesWhen: ["Topology is shown as a discovered diagram", "Interface detail is read-only"],
  },
  {
    id: "exo.automatic-placement",
    rule: "Model placement and shard distribution are automatic.",
    therefore: "Show recommended placement rather than defaulting to manual shard dragging.",
    severity: "warn",
    evidence: [
      { kind: "forbiddenText", pattern: "drag (to )?(place|assign)|manually place|assign (a )?shard" },
    ],
    passesWhen: ["A recommendation is shown with the reasoning", "Manual placement exists but is not the default path"],
  },
  {
    id: "exo.developer-apis",
    rule: "EXO exposes standard developer APIs.",
    therefore: "Integration surfaces should speak in provider, endpoint and model profile, not bespoke nouns.",
    severity: "warn",
    evidence: [{ kind: "manual", question: "Does every integration surface map onto provider / endpoint / model profile?" }],
    passesWhen: ["Provider, endpoint and model profile are the visible nouns"],
  },
  {
    id: "exo.no-generic-saas",
    rule: "The product is a compute operating layer, not a generic chatbot or analytics SaaS.",
    therefore: "Avoid generic SaaS dashboard composition, especially repeated three-card metric rows.",
    severity: "fail",
    evidence: [
      { kind: "maxComponents", component: "metric", max: 2 },
      { kind: "forbidComposition", composition: "card-grid" },
      { kind: "forbiddenText", pattern: "\\b(ask ai|chat with|assistant|gpt)\\b" },
    ],
    passesWhen: ["Topology or a system visualisation is the largest object on screen", "Metrics are instrument readouts, not a card wall"],
  },
  {
    id: "exo.no-chat-as-primary",
    rule: "Chat is not the primary interaction.",
    therefore: "Do not make a prompt box the dominant element of a screen.",
    severity: "fail",
    evidence: [{ kind: "forbiddenText", pattern: "^(ask|ask exo|tell exo|chat|message exo)\\b" }],
    passesWhen: ["The screen's primary object is a system state, not a conversation"],
  },
  {
    id: "exo.no-excessive-cards",
    rule: "The interface should read as an instrument, not a stack of rounded containers.",
    therefore: "Prefer whitespace, rules and alignment over excessive rounded cards.",
    severity: "warn",
    evidence: [{ kind: "maxInstances", component: "panel", max: 6 }],
    passesWhen: ["Panels are visually distinct from their background", "Whitespace is doing the separating"],
  },
  {
    id: "exo.technical-typography",
    rule: "Machine data should read as machine data.",
    therefore: "Use a monospaced face for identifiers, latencies, hashes and addresses.",
    severity: "warn",
    evidence: [{ kind: "manual", question: "Are identifiers, latencies and addresses set in a monospaced face?" }],
    passesWhen: ["Technical values are monospaced and right-aligned where compared"],
  },
  {
    id: "exo.topology-explains-relationships",
    rule: "A topology must explain its relationships, not just show nodes.",
    therefore: "Every edge that exists in the layout must be drawn as a connector, and drawn connectors should carry labels.",
    severity: "warn",
    evidence: [
      { kind: "implies", ifMetric: "topologyNodes", ifOp: ">", ifValue: 1, thenMetric: "topologyEdges", thenOp: ">", thenValue: 0 },
      { kind: "implies", ifMetric: "topologyEdges", ifOp: ">", ifValue: 0, thenMetric: "labeledEdges", thenOp: ">", thenValue: 0 },
    ],
    passesWhen: ["Nodes are connected by routed, labelled edges", "A lone machine is the exception, visibly so"],
  },
  {
    id: "exo.critical-states-labeled",
    rule: "Critical states must have text labels, never colour alone.",
    therefore: "Every button, pill, row and device carries its state in words, and no interactive component is anonymous.",
    severity: "fail",
    evidence: [{ kind: "assert", metric: "unlabeledComponents", op: "==", value: 0 }],
    passesWhen: ["Every control names itself", "Status is readable with colour removed"],
  },
  {
    id: "exo.model-fit-context",
    rule: "Model fit must be judged against cluster context, never in isolation.",
    therefore: "A fit verdict is only meaningful beside required memory, available memory and the machines involved.",
    severity: "fail",
    evidence: [{ kind: "manual", question: "Does every fit verdict sit beside required memory, available memory and the candidate machines?" }],
    passesWhen: ["Requires/available/machine facts surround the verdict"],
  },
  {
    id: "exo.primary-action-dominant",
    rule: "The primary action must be visually dominant.",
    therefore: "One commit control leads; secondary actions retreat. Two equal primaries is not a hierarchy.",
    severity: "warn",
    evidence: [{ kind: "manual", question: "Is there exactly one visually dominant primary action?" }],
    passesWhen: ["The eye finds the commit control without reading"],
  },
  {
    id: "exo.selected-unambiguous",
    rule: "Selected state must be unambiguous.",
    therefore: "The focused node, row or nav item must read as selected at a glance, not on close inspection.",
    severity: "warn",
    evidence: [{ kind: "manual", question: "Can the selected item be identified without reading labels?" }],
    passesWhen: ["Selection survives a squint test"],
  },
];

/**
 * Rule set for a project with no memory of its own.
 *
 * Deliberately the EXO set rather than an empty array. An empty set would make
 * every guard run return PASS, which reads as approval when nothing was checked.
 */
export function defaultRules(): ProductRule[] {
  return EXO_RULES.map((r) => ({ ...r, evidence: [...r.evidence], passesWhen: [...r.passesWhen] }));
}