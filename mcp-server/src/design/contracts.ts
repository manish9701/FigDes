/**
 * FigDes canonical pipeline contracts (handoff §1).
 *
 * One shared intermediate representation so every subsystem stops inventing
 * its own data shape. All schemas are additive: existing modules keep working,
 * new pipeline stages validate against these.
 *
 *   brief → visual direction → composition candidates → DesignIR →
 *   native Figma rendering → RenderEvidence → CritiqueFinding →
 *   RepairTrace → final gate → benchmark artifacts
 *
 * DesignIR itself stays canonical in `shared/ir.ts` — this module references
 * it rather than duplicating it.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* DesignBrief (handoff §1)                                                     */
/* -------------------------------------------------------------------------- */

export const DesignBriefSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(500),
  product: z.string().min(1).max(500),
  platform: z.enum(["figma-design", "figma-slides", "figma-both"]).default("figma-design"),
  viewport: z.object({ width: z.number().positive().max(100000), height: z.number().positive().max(100000) }).optional(),
  audience: z.string().max(2000).default(""),
  userContext: z.string().max(5000).default(""),
  goal: z.string().min(1).max(5000),
  /** The single decision this screen must help the user make. */
  primaryDecision: z.string().min(1).max(2000),
  contentInventory: z.array(z.object({
    id: z.string().min(1).max(200),
    label: z.string().min(1).max(500),
    priority: z.enum(["primary", "secondary", "supporting"]).default("supporting"),
  })).default([]),
  entities: z.array(z.string().min(1).max(200)).default([]),
  relationships: z.array(z.object({
    kind: z.enum(["connectsTo", "dependsOn", "assignedTo", "flowsTo", "contains", "comparesWith"]),
    from: z.string().min(1).max(200),
    to: z.string().min(1).max(200),
    label: z.string().max(500).optional(),
  })).default([]),
  interactions: z.array(z.string().min(1).max(500)).default([]),
  states: z.array(z.string().min(1).max(200)).default([]),
  accessibility: z.array(z.string().min(1).max(500)).default([]),
  brandConstraints: z.array(z.string().min(1).max(500)).default([]),
  references: z.array(z.string().min(1).max(1000)).default([]),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).default([]),
  unknowns: z.array(z.string().min(1).max(1000)).default([]),
  assumptions: z.array(z.string().min(1).max(1000)).default([]),
});

export type DesignBrief = z.infer<typeof DesignBriefSchema>;

/* -------------------------------------------------------------------------- */
/* VisualDirection (handoff §1)                                                 */
/* -------------------------------------------------------------------------- */

export const CompositionCandidateSchema = z.object({
  id: z.string().min(1).max(200),
  family: z.string().min(1).max(200),
  rationale: z.string().min(1).max(5000),
  structureSketch: z.string().max(5000).default(""),
  scores: z.record(z.number().min(0).max(10)).default({}),
});

export type CompositionCandidate = z.infer<typeof CompositionCandidateSchema>;

export const VisualDirectionSchema = z.object({
  selectedFamily: z.string().min(1).max(200),
  rationale: z.string().min(1).max(5000),
  focalPoint: z.string().max(2000).default(""),
  hierarchy: z.string().max(5000).default(""),
  density: z.enum(["airy", "balanced", "dense"]).default("balanced"),
  whitespace: z.string().max(2000).default(""),
  typographyVoice: z.string().max(2000).default(""),
  typeScale: z.string().max(2000).default(""),
  colorTreatment: z.string().max(2000).default(""),
  surfaceTreatment: z.string().max(2000).default(""),
  assetStrategy: z.string().max(2000).default(""),
  productSignature: z.string().max(2000).default(""),
  referenceEvidence: z.array(z.string().max(1000)).default([]),
  referenceProvenance: z.array(z.string().max(1000)).default([]),
  tokens: z.array(z.string().max(200)).default([]),
  /** At least two rejected alternatives with reasons when the choice mattered. */
  rejectedAlternatives: z.array(z.object({
    family: z.string().min(1).max(200),
    reason: z.string().min(1).max(2000),
  })).default([]),
  candidates: z.array(CompositionCandidateSchema).max(10).default([]),
});

export type VisualDirection = z.infer<typeof VisualDirectionSchema>;

/* -------------------------------------------------------------------------- */
/* RenderEvidence (handoff §1)                                                  */
/* -------------------------------------------------------------------------- */

export const RenderEvidenceSchema = z.object({
  pageId: z.string().max(200).optional(),
  frameId: z.string().min(1).max(200),
  screenshotArtifact: z.string().max(1000).optional(),
  screenshotReference: z.string().max(1000).optional(),
  capturedAt: z.number().int().positive(),
  viewportWidth: z.number().positive().max(100000).optional(),
  viewportHeight: z.number().positive().max(100000).optional(),
  nativeWidth: z.number().positive().max(100000).optional(),
  nativeHeight: z.number().positive().max(100000).optional(),
  commit: z.string().max(200).optional(),
  pluginVersion: z.string().max(100).optional(),
  runId: z.string().max(200),
  /** IR revision/hash this render depicts. The gate binds PASS to a match. */
  irRevision: z.string().min(1).max(200),
  renderNumber: z.number().int().min(1),
  affectedNodeIds: z.array(z.string().max(200)).default([]),
  humanInspected: z.boolean().default(false),
  changesSincePrevious: z.array(z.string().max(1000)).default([]),
});

export type RenderEvidence = z.infer<typeof RenderEvidenceSchema>;

/* -------------------------------------------------------------------------- */
/* CritiqueFinding (handoff §1)                                                 */
/* -------------------------------------------------------------------------- */

export const CritiqueFindingSchema = z.object({
  id: z.string().min(1).max(200),
  rule: z.string().min(1).max(200),
  category: z.string().max(200).default(""),
  severity: z.enum(["critical", "serious", "minor"]),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceType: z.enum(["screenshot", "screenshot-crop", "geometry", "structural", "token"]),
  screenshotCrop: z.string().max(1000).optional(),
  geometry: z.string().max(2000).optional(),
  semanticIds: z.array(z.string().max(200)).default([]),
  nativeIds: z.array(z.string().max(200)).default([]),
  impact: z.string().max(5000).default(""),
  repairHypothesis: z.string().max(5000).default(""),
  expectedImprovement: z.string().max(2000).default(""),
  verification: z.string().max(2000).default(""),
  verified: z.boolean().default(false),
});

export type CritiqueFinding = z.infer<typeof CritiqueFindingSchema>;

/* -------------------------------------------------------------------------- */
/* RepairTrace (handoff §1)                                                     */
/* -------------------------------------------------------------------------- */

export const RepairTraceSchema = z.object({
  id: z.string().min(1).max(200),
  findingIds: z.array(z.string().min(1).max(200)).min(1),
  operations: z.array(z.record(z.unknown())).default([]),
  beforeScores: z.record(z.number()).default({}),
  afterScores: z.record(z.number()).default({}),
  regressions: z.array(z.string().max(1000)).default([]),
  renderIds: z.array(z.string().max(200)).default([]),
  outcome: z.enum(["resolved", "improved", "unchanged", "regressed"]),
  notes: z.array(z.string().max(2000)).default([]),
});

export type RepairTrace = z.infer<typeof RepairTraceSchema>;

/* -------------------------------------------------------------------------- */
/* Live benchmark artifact (handoff §9)                                         */
/* -------------------------------------------------------------------------- */

export const LiveBenchmarkCaseSchema = z.object({
  caseId: z.string().min(1).max(200),
  /** Fixture values are clearly marked — never real-looking invented data. */
  fixtures: z.array(z.object({ key: z.string(), value: z.string(), fixture: z.literal(true) })).default([]),
  candidateDirection: VisualDirectionSchema.partial().optional(),
  irRevision: z.string().max(200).optional(),
  operationManifest: z.array(z.record(z.unknown())).default([]),
  nativeFrameId: z.string().max(200).optional(),
  screenshotReference: z.string().max(1000).optional(),
  structuralFindings: z.array(z.string().max(1000)).default([]),
  visualFindings: z.array(CritiqueFindingSchema.partial()).default([]),
  visualScores: z.record(z.number()).optional(),
  repairs: z.array(RepairTraceSchema.partial()).default([]),
  unresolved: z.array(z.string().max(1000)).default([]),
  runtimeMs: z.number().min(0).optional(),
  commit: z.string().max(200).optional(),
});

export type LiveBenchmarkCase = z.infer<typeof LiveBenchmarkCaseSchema>;

export const REQUIRED_LIVE_CASE_FIELDS = [
  "caseId",
  "fixtures",
  "operationManifest",
  "structuralFindings",
  "repairs",
  "unresolved",
] as const;
