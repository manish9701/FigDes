---
name: figdes-generate-design
description: Playbook for generating designs using the FigDes Native + Semantic modes.
---
# figdes-generate-design

This skill defines the operational playbook for generating new screens and modifying existing ones within the FigDes ecosystem.

## 1. The Tri-Mode Architecture
You have three execution paths. Choose the correct one:
*   **Semantic Mode (`create_design`)**: Use this for standard product UI, dashboards, data tables, and settings pages. It compiles intent into layout predictably and guarantees constraints.
*   **Native Mode (`figdes_use_figma`)**: Use this when visual composition, custom geometry, complex masking, or high-fidelity design requires direct Figma manipulation. It allows full unrestricted access via `await fig.*` methods.
*   **Hybrid Mode (Recommended)**: Plan structurally with `plan_screen`, generate core containers using `create_design`, and then refine specific hero areas, custom vectors, or complex components natively using `figdes_use_figma`.

## 2. The Execution Loop (Mandatory)
Never generate blindly. Always inspect and iterate:
1.  **Inspect First**: Run `inspect_design_system`, `inspect_selection`, and `inspect_file`. Know what tokens, colors, and components exist.
2.  **Art Direction**: Use `plan_screen` with the `artDirection` parameter explicitly filled out. Define spatial rhythm, typography, and reject generic SaaS layouts.
3.  **Variant Generation**: Output 2-4 composition candidates using the `alsoConsider` and `variants` parameters.
4.  **Execute**: Create the design via the appropriate Mode.
5.  **Review**: Run `figdes_inspect_visual` and `critique_visual` on the result.
6.  **Refine**: Fix the focal clarity, whitespace, contrast, and alignment based on the critique.

## 3. Native Mode Helper Reference
The `figdes_use_figma` tool runs a Node `vm`. **IMPORTANT: All `fig.*` commands execute asynchronous RPCs to the Figma plugin and MUST BE AWAITED.**
Example script:
```js
const page = await fig.page();
const frame = await fig.createFrame({ name: "Hero", width: 1440, height: 900 });
const title = await fig.createText({ name: "Title", content: "Welcome", fontSize: 48 });
await fig.append(frame, title);
const bounds = await fig.getBounds(title);
await fig.setPosition(title, { x: (1440 - bounds.width) / 2, y: 100 });
```

## 4. Failure Modes
*   **Generic Dashboards**: If a design devolves into a generic sidebar-and-KPI-card layout without a strong product reason, you have failed the art direction phase.
*   **Missing Awaits**: Forgetting `await` on `fig.*` calls will cause silent failures or promise exceptions.
*   **Blind Execution**: Overwriting existing components or ignoring existing tokens creates a disconnected file. Always `fig.find()` components first.
