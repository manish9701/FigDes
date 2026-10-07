/**
 * WCAG contrast math.
 *
 * Re-exported from `shared/contrast.ts` so the critic and the plugin panel can
 * never disagree about whether a colour pair passes.
 */
export {
  parseHex,
  relativeLuminance,
  contrastRatio,
  requiredRatio,
  round2,
  evaluateTextContrast,
  isBoldStyle,
  type RGB,
} from "../../../shared/contrast";