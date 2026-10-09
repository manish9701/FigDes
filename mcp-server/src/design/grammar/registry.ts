/** Grammar registry: one import point for patterns, matcher and anti-patterns. */
export { VISUAL_PATTERNS, type VisualPattern, type PatternDensity } from "./patterns";
export { matchPattern, bestPattern, type PatternMatch, type DecisionKind } from "./matcher";
export { ANTI_PATTERNS, type AntiPatternDef } from "./anti-patterns";
