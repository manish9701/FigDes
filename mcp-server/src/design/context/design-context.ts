/**
 * System 5 — Design Context Memory (spec §11).
 *
 * A product-level context object: what the product is, how it should look,
 * what it must avoid, and which tokens/components/patterns carry that taste.
 * The second screen for the same product receives the same context without
 * rediscovering everything from scratch (Phase 2 acceptance).
 *
 * This module owns the *shape* and the merge logic. Persistence stays with the
 * existing project-memory store (`memory/store.ts`): context is derived from
 * discovery + recorded notes, never a second source of truth.
 */
import type { DesignDiscovery } from "../discovery/index";
import type { ComponentKnowledge } from "../system/component-intelligence";
import type { TokenSystem } from "../system/token-intelligence";
import type { TypographySystem } from "../system/typography";

export type VisualDirection = "spatial-field" | "editorial-focus" | "technical-instrument" | "custom";

export interface DesignDecision {
  id: string;
  decision: string;
  reason?: string;
}

export interface DesignConstraint {
  id: string;
  constraint: string;
}

export interface AntiPattern {
  id: string;
  pattern: string;
  therefore: string;
}

export interface BrandRule {
  id: string;
  rule: string;
}

export interface PatternKnowledge {
  id: string;
  name: string;
  whenToUse: string;
}

export interface DesignContext {
  productName: string;
  audience: string[];
  productDescription: string;
  designIntent: string;
  visualDirection: VisualDirection;
  typography: TypographySystem | null;
  tokens: TokenSystem | null;
  components: ComponentKnowledge[];
  patterns: PatternKnowledge[];
  existingScreens: Array<{ id: string; name: string }>;
  decisions: DesignDecision[];
  constraints: DesignConstraint[];
  antiPatterns: AntiPattern[];
  brandRules: BrandRule[];
}

/** EXO defaults: discovered/approved values override these, never the reverse. */
export function exoDefaultContext(): DesignContext {
  return {
    productName: "EXO",
    audience: ["operator", "developer", "engineer"],
    productDescription: "Local-first compute fabric: devices, models and live inference.",
    designIntent: "technical, calm, spatial, precise",
    visualDirection: "technical-instrument",
    typography: null,
    tokens: null,
    components: [],
    patterns: [],
    existingScreens: [],
    decisions: [],
    constraints: [],
    antiPatterns: [
      { id: "exo.no-card-wall", pattern: "generic SaaS dashboard / card wall", therefore: "Use spatial relationships and instrument surfaces instead of equal cards." },
      { id: "exo.no-chat-first", pattern: "chat-first layout", therefore: "Chat is not primary; the runtime object is." },
      { id: "exo.no-gradient-noise", pattern: "unnecessary gradients / glow / visual noise", therefore: "Restrained surfaces, thin rules, meaningful state colour only." },
    ],
    brandRules: [
      { id: "exo.light-surfaces", rule: "Prefer light surfaces with dark runtime accents." },
      { id: "exo.restraint", rule: "Restrained typography; technical values monospaced." },
    ],
  };
}

/**
 * Builds a context from discovery plus already-recorded product notes.
 * Recorded notes (decisions/constraints/anti-patterns) win over defaults;
 * discovery fills tokens/typography/components/screens.
 */
export function buildDesignContext(input: {
  discovery?: DesignDiscovery | null;
  productName?: string;
  audience?: string[];
  visualDirection?: VisualDirection;
  tokens?: TokenSystem | null;
  typography?: TypographySystem | null;
  components?: ComponentKnowledge[];
  decisions?: DesignDecision[];
  constraints?: DesignConstraint[];
  antiPatterns?: AntiPattern[];
  brandRules?: BrandRule[];
}): DesignContext {
  const base = exoDefaultContext();
  return {
    productName: input.productName ?? base.productName,
    audience: input.audience ?? base.audience,
    productDescription: base.productDescription,
    designIntent: base.designIntent,
    visualDirection: input.visualDirection ?? base.visualDirection,
    typography: input.typography ?? base.typography,
    tokens: input.tokens ?? base.tokens,
    components: input.components ?? [],
    patterns: base.patterns,
    existingScreens: (input.discovery?.screens ?? []).map((s) => ({ id: s.id, name: s.name })),
    decisions: input.decisions ?? [],
    constraints: input.constraints ?? [],
    antiPatterns: [...base.antiPatterns, ...(input.antiPatterns ?? [])],
    brandRules: [...base.brandRules, ...(input.brandRules ?? [])],
  };
}

/** Compact prompt fragment: what the planner and compiler actually need. */
export function contextBrief(ctx: DesignContext): string {
  const lines = [
    `Product: ${ctx.productName} — ${ctx.designIntent}.`,
    `Direction: ${ctx.visualDirection}. Audience: ${ctx.audience.join(", ")}.`,
    `Avoid: ${ctx.antiPatterns.map((a) => a.pattern).join("; ")}.`,
  ];
  if (ctx.decisions.length > 0) lines.push(`Decisions: ${ctx.decisions.map((d) => d.decision).join("; ")}.`);
  if (ctx.typography) lines.push(`Type: ${ctx.typography.primary} / mono ${ctx.typography.mono}.`);
  return lines.join(" ");
}
