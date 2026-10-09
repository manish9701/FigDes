/**
 * Anti-patterns (spec §12, §14): what the composition must actively reject.
 * Shared by the planner (avoid list), the genericity evaluator (detection) and
 * the repair planner (fixes), so all three agree on what "generic" means.
 */

export interface AntiPatternDef {
  id: string;
  name: string;
  description: string;
  detect: string;
  therefore: string;
}

export const ANTI_PATTERNS: AntiPatternDef[] = [
  { id: "card-wall", name: "Card wall", description: "Many equal cards in a grid.", detect: "3+ equal bordered surfaces covering 40%+ of canvas", therefore: "Remove cards; promote one focal object; convert metrics to contextual annotations." },
  { id: "dashboard-syndrome", name: "Dashboard syndrome", description: "Sidebar + header + metric cards + chart + table without justification.", detect: "nav + header + metric cluster + chart/table co-occurring", therefore: "Choose the pattern the decision needs (instrument, topology, comparison) instead of the dashboard shell." },
  { id: "equal-weight", name: "Equal-weight regions", description: "Everything the same size/contrast; no entry point.", detect: "top two focal candidates within 0.05 or all regions identically sized", therefore: "Promote one region to hero size; subordinate the rest." },
  { id: "excess-rounding", name: "Excessive rounding", description: "Every object a rounded rectangle.", detect: "rounded surfaces >= filled surfaces", therefore: "Reserve radius for interactive/overlay surfaces; flatten structural frames." },
  { id: "excess-borders", name: "Excessive borders", description: "Every region boxed.", detect: "bordered share high with low surface variation", therefore: "Use whitespace and alignment to separate; borders only where containment is semantic." },
  { id: "excess-pills", name: "Excessive pills", description: "Status/controls pill-shaped without semantic reason.", detect: "pill radii on non-status elements", therefore: "Pills communicate state; controls use small radii." },
  { id: "generic-spacing", name: "Generic spacing", description: "Uniform gaps regardless of semantic relationship.", detect: "single gap value across unrelated region pairs", therefore: "Tight within clusters, wide between them; focal gets the most space." },
  { id: "empty-panels", name: "Empty panels", description: "Large containers with little meaningful content.", detect: "large surface with <2 text/child nodes", therefore: "Remove the container or fill it with the data it promises." },
  { id: "repeated-metrics", name: "Repeated metrics", description: "Isolated numbers instead of meaningful visualization.", detect: "4+ metric components with no trace/chart/topology", therefore: "Convert metrics into a trace, annotated topology or comparison rows." },
  { id: "ai-aesthetic", name: "Generic AI aesthetic", description: "Unnecessary gradients, glow, purple accents, floating cards.", detect: "gradient fills, glow effects, purple–blue accents on neutral product", therefore: "Flat restrained surfaces; state colour only where it means something." },
];
