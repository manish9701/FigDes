/**
 * Before/after comparison for the render → critique → repair → render loop
 * (spec §16): measurable deltas as evidence, judgement left to the reviewer.
 */

export interface QualityComparison {
  scoreDelta: number;
  genericityDelta: number;
  resolved: string[];
  introduced: string[];
  summary: string;
}

export function compareQuality(input: {
  beforeScores: Record<string, number>;
  afterScores: Record<string, number>;
  beforeGenericity: number;
  afterGenericity: number;
  beforeIssues: string[];
  afterIssues: string[];
}): QualityComparison {
  const keys = [...new Set([...Object.keys(input.beforeScores), ...Object.keys(input.afterScores)])];
  const beforeAvg = keys.reduce((a, k) => a + (input.beforeScores[k] ?? 0), 0) / Math.max(1, keys.length);
  const afterAvg = keys.reduce((a, k) => a + (input.afterScores[k] ?? 0), 0) / Math.max(1, keys.length);
  const before = new Set(input.beforeIssues);
  const after = new Set(input.afterIssues);
  const resolved = [...before].filter((i) => !after.has(i));
  const introduced = [...after].filter((i) => !before.has(i));
  const scoreDelta = Math.round((afterAvg - beforeAvg) * 10) / 10;
  const genericityDelta = input.afterGenericity - input.beforeGenericity;
  const summary =
    scoreDelta > 0 && genericityDelta <= 0 && introduced.length === 0
      ? `Improved (+${scoreDelta} avg, genericity down ${Math.abs(genericityDelta)}). Judge the render before calling it done.`
      : `Changed (${scoreDelta >= 0 ? "+" : ""}${scoreDelta} avg, genericity ${genericityDelta <= 0 ? "down" : "up"} ${Math.abs(genericityDelta)}). Judge the render before calling it done.`;
  return { scoreDelta, genericityDelta, resolved, introduced, summary };
}
