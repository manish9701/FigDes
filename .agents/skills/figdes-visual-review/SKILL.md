---
name: figdes-visual-review
description: Playbook for executing visual critique and compositional refinement.
---
# figdes-visual-review

This skill defines the operational playbook for visually judging a screen (or composition variants) and executing targeted refinements. 

## 1. The Core Loop
The visual review loop must be evidence-based and iterative:
1.  **Measurement**: Run `figdes_inspect_visual` to extract focal candidates, surface counts, and text hierarchy.
2.  **Screenshot Generation**: Whenever possible, run `render_design` (or `render_node`) to capture a visual snapshot. 
3.  **Critique**: Pass the measurement data and screen context into `critique_visual`.
4.  **Targeted Fixes**: Apply fixes via `figdes_use_figma` (Native Mode) for layout adjustments or `modify_design` (Semantic Mode).
5.  **Re-Evaluate**: Compare the new measurements. Stop when the quality threshold is reached.

## 2. Visual Critique Rubric
You must judge designs on the following vectors (do NOT rely solely on "largest object = focal point"):
*   **Focal Clarity**: Does the most important interactive or data element command attention via contrast, position, or whitespace isolation?
*   **Whitespace & Density**: Is space deliberate? Are edge densities balanced? Negative-space corridors must separate conceptual groups.
*   **Hierarchy**: Are `h1`, `h2`, `h3`, and body text distinguishable? Are secondary objects appropriately receded via opacity or size?
*   **Card-Wall Tendency**: Reject designs that lazily encapsulate every text node into a bordered white box. 
*   **Alignment & Repetition**: Are margins mathematically consistent? Do repeating elements use shared components?

## 3. Verdicts
The `critique_visual` tool should output explicit verdicts:
*   **PASS**: Ready for production.
*   **WATCH**: Functionally sound but aesthetically weak. Requires an Art Director pass.
*   **FAIL**: Severe structural, contrast, or hierarchy failures. Must be rebuilt.

## 4. Remediation Examples
*   *Fixing Card-Walls*: Natively remove box strokes/fills and increase `itemSpacing` (gap) to define relationships through proximity instead of borders.
*   *Fixing Focal Confusion*: Natively apply `opacity: 0.6` to secondary metadata, or increase `fontSize` and `fontWeigth` of the primary data point.
