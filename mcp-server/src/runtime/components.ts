/**
 * Component-generation v1 library (issue #24).
 *
 * Reusable component definitions for the twelve generated UI parts: button,
 * icon-button, text-input, select, checkbox, switch, tabs, badge/status,
 * tooltip/menu, dialog, navigation-item and table-row.
 *
 * Each definition carries three things:
 *
 * 1. **Anatomy** — the frame (auto-layout padding/gap), icon slot, label and
 *    state layers the master is built from, so every instance of a type is
 *    assembled identically instead of re-drawn per screen.
 * 2. **Variants / properties / states** — the closed vocabularies an instance
 *    may take. Variant values reuse `VARIANT_VALUES` from primitive-schema
 *    (one source of truth, not a copy), and the state tables are the same
 *    mappings the interpreter's `STATE_TABLES` is built from (imported there,
 *    not duplicated).
 * 3. **Ensure-once masters** — `masterOpsFor` builds the `createComponent`
 *    master plus its children; the compiler emits it once per program (deduped
 *    by master id) and every use site becomes a `createInstance` against that
 *    master, so a shared change propagates: one master edit reaches every
 *    instance. Variant selection travels as `setVariant` (component-set) or
 *    TEXT property overrides, never as a redraw.
 *
 * When a caller does not ask for a real component (`asComponent !== true`)
 * the same definition draws a simplified frame fallback with identical outer
 * geometry, so layout never depends on which path was taken.
 */
import { VARIANT_VALUES } from "./primitive-schema";

/* -------------------------------------------------------------------------- */
/* Definition shape                                                             */
/* -------------------------------------------------------------------------- */

/** Plain (unvalidated) operation candidates; the compiler validates via `op()`. */
export type OpCandidate = Record<string, unknown>;

export interface LibraryComponentDef {
  /** IR component type this definition serves. */
  type: string;
  /** Master component name in the file (`exo/<type>`). */
  masterName: string;
  /** Stable transaction-local master id, so every instance links to one master. */
  masterId: string;
  description: string;
  /** Anatomy layers, in build order: frame, icon slot, label, state layers. */
  anatomy: string[];
  /** Closed variant vocabulary (reuses VARIANT_VALUES where it applies). */
  variants: readonly string[];
  /** Component properties and their closed values. */
  properties: Record<string, readonly string[]>;
  /** State-strip names this component expands (interpreter STATE_TABLES keys). */
  states: readonly string[];
  /** Master intrinsic size. */
  masterSize: { width: number; height: number };
  /** Master ops: createComponent + children (ids prefixed with the master id). */
  masterOps: (grid: number) => OpCandidate[];
  /** Instance-site fallback: a frame with the same outer geometry (ids prefixed). */
  fallbackOps: (args: {
    id: string;
    parent: string;
    box: { x: number; y: number; w: number; h: number };
    props: Record<string, unknown>;
    grid: number;
    typeScale: number;
  }) => OpCandidate[];
  /** Variant selection for setVariant, from instance props (undefined = default). */
  variantFor: (props: Record<string, unknown>) => Record<string, string> | undefined;
}

/* -------------------------------------------------------------------------- */
/* Shared vocabularies                                                          */
/* -------------------------------------------------------------------------- */

/**
 * State expansion per library type, in the component's own state vocabulary.
 * The interpreter spreads these into `STATE_TABLES`, so a `states: [...]`
 * strip exercises the real rendering paths rather than a parallel system.
 */
export const LIBRARY_STATE_TABLES: Record<string, Record<string, Record<string, unknown>>> = {
  button: {
    default: {},
    hover: { variant: "primary" },
    pressed: { variant: "primary" },
    focused: { variant: "secondary" },
    disabled: { variant: "disabled" },
    loading: { variant: "loading" },
    error: { variant: "destructive" },
    success: { variant: "primary" },
  },
  iconButton: {
    default: {},
    hover: { variant: "primary" },
    pressed: { variant: "primary" },
    focused: { variant: "secondary" },
    disabled: { variant: "disabled" },
    loading: { variant: "loading" },
  },
  textInput: {
    default: {},
    focused: { state: "focused" },
    disabled: { state: "disabled" },
    error: { state: "error" },
    success: { state: "success" },
    empty: { state: "empty" },
  },
  select: {
    default: {},
    focused: { state: "focused" },
    disabled: { state: "disabled" },
    error: { state: "error" },
    empty: { state: "empty" },
  },
  checkbox: {
    default: {},
    selected: { checked: true },
    disabled: { state: "disabled" },
    error: { state: "error" },
  },
  switch: {
    default: {},
    selected: { checked: true },
    disabled: { state: "disabled" },
  },
  tabs: {
    default: {},
    selected: { selected: 0 },
    disabled: { state: "disabled" },
  },
  badge: {
    default: {},
    selected: {},
    disabled: { tone: "neutral" },
    loading: { label: "Loading…", tone: "info" },
    empty: { label: "Empty", tone: "neutral" },
    error: { tone: "error" },
    success: { tone: "success" },
  },
  tooltip: {
    default: {},
    hover: {},
    focused: {},
    disabled: { state: "disabled" },
  },
  menu: {
    default: {},
    hover: {},
    selected: { selected: 0 },
    disabled: { state: "disabled" },
  },
  dialog: {
    default: {},
    focused: {},
    error: { variant: "destructive" },
    success: { variant: "primary" },
  },
  navigationItem: {
    default: {},
    selected: { state: "active" },
    focused: {},
    disabled: { state: "disabled" },
    success: { state: "active" },
  },
  tableRow: {
    default: {},
    selected: { selected: true },
    disabled: { state: "disabled" },
    error: { status: "error" },
    success: { status: "fits" },
  },
};

/** Tone vocabulary for status-carrying parts (mirrors the compiler's TONES keys). */
const TONE_VALUES = ["success", "healthy", "warning", "degraded", "danger", "error", "info", "neutral", "offline", "unavailable"] as const;

/* -------------------------------------------------------------------------- */
/* Small builders                                                               */
/* -------------------------------------------------------------------------- */

const str = (props: Record<string, unknown>, k: string, fallback = ""): string =>
  typeof props[k] === "string" ? (props[k] as string) : fallback;

function variantProp(props: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const k of ["variant", "state", "tone", "status"]) {
    const v = props[k];
    if (typeof v === "string" && v.length > 0) out[k[0]!.toUpperCase() + k.slice(1)] = v;
  }
  if (typeof props.checked === "boolean") out.Checked = props.checked ? "true" : "false";
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Default variant selector: forwards the instance's state props as variant properties. */
function variantFor(props: Record<string, unknown>): Record<string, string> | undefined {
  return variantProp(props);
}

function masterNameFor(type: string): string {
  return `exo/${type.replace(/([A-Z])/g, (c) => `-${c.toLowerCase()}`)}`;
}

function masterHeader(type: string, width: number, height: number): OpCandidate {
  return { type: "createComponent", id: `master-${type}`, name: masterNameFor(type), width, height };
}

/* -------------------------------------------------------------------------- */
/* Library                                                                      */
/* -------------------------------------------------------------------------- */

function buttonDef(): LibraryComponentDef {
  return {
    type: "button",
    masterName: "exo/button",
    masterId: "master-button",
    description: "A labelled action with an optional icon slot.",
    anatomy: ["frame H auto-layout pad 8/16 gap 8", "icon slot 16x16", "label text 13/600", "loading/disabled opacity layer"],
    variants: VARIANT_VALUES,
    properties: { variant: VARIANT_VALUES, size: ["sm", "md", "lg"] },
    states: Object.keys(LIBRARY_STATE_TABLES.button!),
    masterSize: { width: 160, height: 40 },
    masterOps: (grid) => [
      masterHeader("button", 160, 40),
      { type: "createFrame", parent: "master-button", name: "Button", width: 160, height: 40, fill: "#242521", cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 8, right: 16, bottom: 8, left: 16 }, itemSpacing: 8 },
      { type: "createRectangle", parent: "master-button", name: "Icon slot", width: 16, height: 16, fill: [] },
      { type: "createText", parent: "master-button", name: "Label", content: "Continue", fontSize: 13, weight: 600, fill: "#FFFFFF" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => {
      const label = str(props, "label", "Continue");
      return [
        { type: "createFrame", id, parent, name: label, x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 40, fill: "#242521", cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 8, right: 16, bottom: 8, left: 16 }, itemSpacing: 8 },
        { type: "createText", parent: id, name: "Label", content: label, fontSize: Math.round(13 * typeScale), weight: 600, fill: "#FFFFFF" },
      ];
    },
    variantFor: (props) => {
      const v = typeof props.variant === "string" ? props.variant : undefined;
      return v ? { Variant: v } : undefined;
    },
  };
}

function iconButtonDef(): LibraryComponentDef {
  return {
    type: "iconButton",
    masterName: "exo/icon-button",
    masterId: "master-iconButton",
    description: "A square button carrying only an icon.",
    anatomy: ["frame 40x40 auto-layout centred", "icon slot 16x16"],
    variants: VARIANT_VALUES,
    properties: { variant: VARIANT_VALUES, size: ["sm", "md", "lg"], icon: ["*"] },
    states: Object.keys(LIBRARY_STATE_TABLES.iconButton!),
    masterSize: { width: 40, height: 40 },
    masterOps: (grid) => [
      masterHeader("iconButton", 40, 40),
      { type: "createFrame", parent: "master-iconButton", name: "Icon button", width: 40, height: 40, fill: "#242521", cornerRadius: grid, layoutMode: "HORIZONTAL", padding: 12, itemSpacing: 0 },
      { type: "createRectangle", parent: "master-iconButton", name: "Icon slot", width: 16, height: 16, fill: "#FFFFFF" },
    ],
    fallbackOps: ({ id, parent, box, props, grid }) => [
      { type: "createFrame", id, parent, name: str(props, "icon", "Icon button"), x: Math.round(box.x), y: Math.round(box.y), width: 40, height: 40, fill: "#242521", cornerRadius: grid, layoutMode: "HORIZONTAL", padding: 12 },
      { type: "createRectangle", parent: id, name: "Icon slot", width: 16, height: 16, fill: "#FFFFFF" },
    ],
    variantFor: (props) => {
      const v = typeof props.variant === "string" ? props.variant : undefined;
      return v ? { Variant: v } : undefined;
    },
  };
}

function textInputDef(): LibraryComponentDef {
  return {
    type: "textInput",
    masterName: "exo/text-input",
    masterId: "master-textInput",
    description: "A labelled field: caption above, box with placeholder text.",
    anatomy: ["frame V auto-layout pad 0 gap 4", "caption text 11", "box frame H pad 8/12 gap 8 stroke", "placeholder text 14"],
    variants: ["default", "focused", "disabled", "error", "success"],
    properties: { state: ["default", "focused", "disabled", "error", "success", "empty"], size: ["sm", "md", "lg"] },
    states: Object.keys(LIBRARY_STATE_TABLES.textInput!),
    masterSize: { width: 240, height: 64 },
    masterOps: (grid) => [
      masterHeader("textInput", 240, 64),
      { type: "createFrame", parent: "master-textInput", name: "Field", width: 240, height: 64, fill: [], layoutMode: "VERTICAL", padding: 0, itemSpacing: 4 },
      { type: "createText", parent: "master-textInput", name: "Caption", content: "Label", fontSize: 11, weight: 500, fill: "#6F716A" },
      { type: "createFrame", parent: "master-textInput", name: "Box", width: 240, height: 40, fill: "#FFFFFF", stroke: "#D9D8D0", strokeWeight: 1, cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 }, itemSpacing: 8 },
      { type: "createText", parent: "master-textInput", name: "Placeholder", content: "Placeholder", fontSize: 14, fill: "#8A8C84" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => [
      { type: "createFrame", id, parent, name: str(props, "label", "Field"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 64, fill: [], layoutMode: "VERTICAL", padding: 0, itemSpacing: 4 },
      { type: "createText", parent: id, name: "Caption", content: str(props, "label", "Label"), fontSize: Math.round(11 * typeScale), weight: 500, fill: "#6F716A" },
      { type: "createFrame", parent: id, name: "Box", width: Math.max(1, Math.round(box.w)), height: 40, fill: "#FFFFFF", stroke: "#D9D8D0", strokeWeight: 1, cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 } },
      { type: "createText", parent: id, name: "Placeholder", content: str(props, "placeholder", str(props, "value", "Placeholder")), fontSize: Math.round(14 * typeScale), fill: "#8A8C84" },
    ],
    variantFor,
  };
}

function selectDef(): LibraryComponentDef {
  return {
    type: "select",
    masterName: "exo/select",
    masterId: "master-select",
    description: "A closed select: value text plus a chevron slot.",
    anatomy: ["frame H auto-layout pad 8/12 gap 8 stroke", "value text 14", "chevron slot 12x12"],
    variants: ["default", "focused", "disabled", "error"],
    properties: { state: ["default", "focused", "disabled", "error", "empty"] },
    states: Object.keys(LIBRARY_STATE_TABLES.select!),
    masterSize: { width: 240, height: 40 },
    masterOps: (grid) => [
      masterHeader("select", 240, 40),
      { type: "createFrame", parent: "master-select", name: "Select", width: 240, height: 40, fill: "#FFFFFF", stroke: "#D9D8D0", strokeWeight: 1, cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 }, itemSpacing: 8 },
      { type: "createText", parent: "master-select", name: "Value", content: "Choose…", fontSize: 14, fill: "#242521" },
      { type: "createRectangle", parent: "master-select", name: "Chevron slot", width: 12, height: 12, fill: "#8A8C84" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => [
      { type: "createFrame", id, parent, name: str(props, "label", "Select"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 40, fill: "#FFFFFF", stroke: "#D9D8D0", strokeWeight: 1, cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 }, itemSpacing: 8 },
      { type: "createText", parent: id, name: "Value", content: str(props, "value", str(props, "placeholder", "Choose…")), fontSize: Math.round(14 * typeScale), fill: "#242521" },
      { type: "createRectangle", parent: id, name: "Chevron slot", width: 12, height: 12, fill: "#8A8C84" },
    ],
    variantFor,
  };
}

function checkboxDef(): LibraryComponentDef {
  return {
    type: "checkbox",
    masterName: "exo/checkbox",
    masterId: "master-checkbox",
    description: "A 16px box plus label; checked fills the box.",
    anatomy: ["frame H auto-layout pad 0 gap 8", "box 16x16 rect stroke", "label text 14"],
    variants: ["unchecked", "checked", "disabled", "indeterminate"],
    properties: { checked: ["true", "false"], state: ["default", "disabled", "error"] },
    states: Object.keys(LIBRARY_STATE_TABLES.checkbox!),
    masterSize: { width: 180, height: 24 },
    masterOps: () => [
      masterHeader("checkbox", 180, 24),
      { type: "createFrame", parent: "master-checkbox", name: "Checkbox", width: 180, height: 24, fill: [], layoutMode: "HORIZONTAL", padding: 0, itemSpacing: 8 },
      { type: "createRectangle", parent: "master-checkbox", name: "Box", width: 16, height: 16, fill: "#FFFFFF", stroke: "#242521", strokeWeight: 1 },
      { type: "createText", parent: "master-checkbox", name: "Label", content: "Option", fontSize: 14, fill: "#242521" },
    ],
    fallbackOps: ({ id, parent, box, props, typeScale }) => [
      { type: "createFrame", id, parent, name: str(props, "label", "Checkbox"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 24, fill: [], layoutMode: "HORIZONTAL", padding: 0, itemSpacing: 8 },
      { type: "createRectangle", parent: id, name: "Box", width: 16, height: 16, fill: props.checked === true ? "#242521" : "#FFFFFF", stroke: "#242521", strokeWeight: 1 },
      { type: "createText", parent: id, name: "Label", content: str(props, "label", "Option"), fontSize: Math.round(14 * typeScale), fill: "#242521" },
    ],
    variantFor,
  };
}

function switchDef(): LibraryComponentDef {
  return {
    type: "switch",
    masterName: "exo/switch",
    masterId: "master-switch",
    description: "A 36x20 track with a thumb, plus label.",
    anatomy: ["frame H auto-layout pad 0 gap 8", "track 36x20 rounded rect", "thumb 14 ellipse", "label text 14"],
    variants: ["off", "on", "disabled"],
    properties: { checked: ["true", "false"], state: ["default", "disabled"] },
    states: Object.keys(LIBRARY_STATE_TABLES.switch!),
    masterSize: { width: 200, height: 28 },
    masterOps: () => [
      masterHeader("switch", 200, 28),
      { type: "createFrame", parent: "master-switch", name: "Switch", width: 200, height: 28, fill: [], layoutMode: "HORIZONTAL", padding: 0, itemSpacing: 8 },
      { type: "createRectangle", parent: "master-switch", name: "Track", width: 36, height: 20, fill: "#D9D8D0", cornerRadius: 10 },
      { type: "createEllipse", parent: "master-switch", name: "Thumb", width: 14, height: 14, fill: "#FFFFFF" },
      { type: "createText", parent: "master-switch", name: "Label", content: "Enabled", fontSize: 14, fill: "#242521" },
    ],
    fallbackOps: ({ id, parent, box, props, typeScale }) => [
      { type: "createFrame", id, parent, name: str(props, "label", "Switch"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 28, fill: [], layoutMode: "HORIZONTAL", padding: 0, itemSpacing: 8 },
      { type: "createRectangle", parent: id, name: "Track", width: 36, height: 20, fill: props.checked === true ? "#242521" : "#D9D8D0", cornerRadius: 10 },
      { type: "createEllipse", parent: id, name: "Thumb", width: 14, height: 14, fill: "#FFFFFF" },
      { type: "createText", parent: id, name: "Label", content: str(props, "label", "Enabled"), fontSize: Math.round(14 * typeScale), fill: "#242521" },
    ],
    variantFor,
  };
}

function tabsDef(): LibraryComponentDef {
  return {
    type: "tabs",
    masterName: "exo/tabs",
    masterId: "master-tabs",
    description: "A row of three tab frames; the selected tab carries the fill.",
    anatomy: ["frame H auto-layout pad 4 gap 4", "3x tab frame pad 8/12", "tab label text 13"],
    variants: ["default", "disabled"],
    properties: { selected: ["0", "1", "2"], state: ["default", "disabled"] },
    states: Object.keys(LIBRARY_STATE_TABLES.tabs!),
    masterSize: { width: 320, height: 40 },
    masterOps: (grid) => [
      masterHeader("tabs", 320, 40),
      { type: "createFrame", parent: "master-tabs", name: "Tabs", width: 320, height: 40, fill: [], layoutMode: "HORIZONTAL", padding: 4, itemSpacing: 4 },
      { type: "createFrame", parent: "master-tabs", name: "Tab 1", width: 100, height: 32, fill: "#242521", cornerRadius: grid / 2, layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 } },
      { type: "createText", parent: "master-tabs", name: "Tab label 1", content: "Tab 1", fontSize: 13, weight: 600, fill: "#FFFFFF" },
      { type: "createFrame", parent: "master-tabs", name: "Tab 2", width: 100, height: 32, fill: [], cornerRadius: grid / 2, layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 } },
      { type: "createText", parent: "master-tabs", name: "Tab label 2", content: "Tab 2", fontSize: 13, fill: "#6F716A" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => {
      const items: string[] = Array.isArray(props.items) ? (props.items as unknown[]).filter((v): v is string => typeof v === "string").slice(0, 6) : ["Tab 1", "Tab 2", "Tab 3"];
      const selected = typeof props.selected === "number" ? props.selected : 0;
      return [
        { type: "createFrame", id, parent, name: "Tabs", x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 40, fill: [], layoutMode: "HORIZONTAL", padding: 4, itemSpacing: 4 },
        ...items.flatMap((item, i): OpCandidate[] => [
          { type: "createFrame", parent: id, name: `Tab ${i + 1}`, width: 100, height: 32, fill: i === selected ? "#242521" : [], cornerRadius: grid / 2, layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 } },
          { type: "createText", parent: id, name: `Tab label ${i + 1}`, content: item, fontSize: Math.round(13 * typeScale), ...(i === selected ? { weight: 600 } : {}), fill: i === selected ? "#FFFFFF" : "#6F716A" },
        ]),
      ];
    },
    variantFor,
  };
}

function badgeDef(): LibraryComponentDef {
  return {
    type: "badge",
    masterName: "exo/badge",
    masterId: "master-badge",
    description: "A hug status badge: dot plus word, never colour alone.",
    anatomy: ["frame H hug auto-layout pad 4/8 gap 6", "dot 6 ellipse", "label text 11/500"],
    variants: [...TONE_VALUES],
    properties: { tone: [...TONE_VALUES], state: ["default", "disabled", "loading", "empty", "error", "success"] },
    states: Object.keys(LIBRARY_STATE_TABLES.badge!),
    masterSize: { width: 120, height: 22 },
    masterOps: (grid) => [
      masterHeader("badge", 120, 22),
      { type: "createFrame", parent: "master-badge", name: "Badge", width: 120, height: 22, fill: "#6F716A1A", cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 4, right: grid, bottom: 4, left: grid }, itemSpacing: 6 },
      { type: "createEllipse", parent: "master-badge", name: "Dot", width: 6, height: 6, fill: "#5A5C54" },
      { type: "createText", parent: "master-badge", name: "Label", content: "Status", fontSize: 11, weight: 500, fill: "#5A5C54" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => [
      { type: "createFrame", id, parent, name: str(props, "label", "Badge"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 22, fill: "#6F716A1A", cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 4, right: grid, bottom: 4, left: grid }, itemSpacing: 6 },
      { type: "createEllipse", parent: id, name: "Dot", width: 6, height: 6, fill: "#5A5C54" },
      { type: "createText", parent: id, name: "Label", content: str(props, "label", "Status"), fontSize: Math.round(11 * typeScale), weight: 500, fill: "#5A5C54" },
    ],
    variantFor,
  };
}

function tooltipDef(): LibraryComponentDef {
  return {
    type: "tooltip",
    masterName: "exo/tooltip",
    masterId: "master-tooltip",
    description: "A floating note: title plus supporting line.",
    anatomy: ["frame V auto-layout pad 8/12 gap 4 fill dark", "title text 12/600", "body text 11"],
    variants: ["default", "dark"],
    properties: { placement: ["top", "right", "bottom", "left"], state: ["default", "disabled"] },
    states: Object.keys(LIBRARY_STATE_TABLES.tooltip!),
    masterSize: { width: 200, height: 64 },
    masterOps: (grid) => [
      masterHeader("tooltip", 200, 64),
      { type: "createFrame", parent: "master-tooltip", name: "Tooltip", width: 200, height: 64, fill: "#242521", cornerRadius: grid, layoutMode: "VERTICAL", padding: { top: 8, right: 12, bottom: 8, left: 12 }, itemSpacing: 4 },
      { type: "createText", parent: "master-tooltip", name: "Title", content: "Hint", fontSize: 12, weight: 600, fill: "#FFFFFF" },
      { type: "createText", parent: "master-tooltip", name: "Body", content: "Supporting detail.", fontSize: 11, fill: "#A8ABA0" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => [
      { type: "createFrame", id, parent, name: str(props, "label", "Tooltip"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 64, fill: "#242521", cornerRadius: grid, layoutMode: "VERTICAL", padding: { top: 8, right: 12, bottom: 8, left: 12 }, itemSpacing: 4 },
      { type: "createText", parent: id, name: "Title", content: str(props, "label", "Hint"), fontSize: Math.round(12 * typeScale), weight: 600, fill: "#FFFFFF" },
      { type: "createText", parent: id, name: "Body", content: str(props, "body", "Supporting detail."), fontSize: Math.round(11 * typeScale), fill: "#A8ABA0" },
    ],
    variantFor,
  };
}

function menuDef(): LibraryComponentDef {
  return {
    type: "menu",
    masterName: "exo/menu",
    masterId: "master-menu",
    description: "A vertical list of three item rows.",
    anatomy: ["frame V auto-layout pad 4 gap 2", "3x item frame H pad 8/12 gap 8", "item label text 14"],
    variants: ["default", "open"],
    properties: { open: ["true", "false"], state: ["default", "disabled"], selected: ["0", "1", "2"] },
    states: Object.keys(LIBRARY_STATE_TABLES.menu!),
    masterSize: { width: 220, height: 132 },
    masterOps: (grid) => [
      masterHeader("menu", 220, 132),
      { type: "createFrame", parent: "master-menu", name: "Menu", width: 220, height: 132, fill: "#FFFFFF", stroke: "#D9D8D0", strokeWeight: 1, cornerRadius: grid, layoutMode: "VERTICAL", padding: 4, itemSpacing: 2 },
      { type: "createFrame", parent: "master-menu", name: "Item 1", width: 212, height: 40, fill: [], layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 } },
      { type: "createText", parent: "master-menu", name: "Item label 1", content: "First", fontSize: 14, fill: "#242521" },
      { type: "createFrame", parent: "master-menu", name: "Item 2", width: 212, height: 40, fill: [], layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 } },
      { type: "createText", parent: "master-menu", name: "Item label 2", content: "Second", fontSize: 14, fill: "#242521" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => {
      const items: string[] = Array.isArray(props.items) ? (props.items as unknown[]).filter((v): v is string => typeof v === "string").slice(0, 6) : ["First", "Second", "Third"];
      return [
        { type: "createFrame", id, parent, name: "Menu", x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 40 * items.length + 12, fill: "#FFFFFF", stroke: "#D9D8D0", strokeWeight: 1, cornerRadius: grid, layoutMode: "VERTICAL", padding: 4, itemSpacing: 2 },
        ...items.flatMap((item, i): OpCandidate[] => [
          { type: "createFrame", parent: id, name: `Item ${i + 1}`, width: Math.max(1, Math.round(box.w) - 8), height: 40, fill: [], layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 } },
          { type: "createText", parent: id, name: `Item label ${i + 1}`, content: item, fontSize: Math.round(14 * typeScale), fill: "#242521" },
        ]),
      ];
    },
    variantFor,
  };
}

function dialogDef(): LibraryComponentDef {
  return {
    type: "dialog",
    masterName: "exo/dialog",
    masterId: "master-dialog",
    description: "A modal: title, body and an action row.",
    anatomy: ["frame V auto-layout pad 24 gap 16", "title text 18/600", "body text 14", "action row frame H gap 8", "2x action frame"],
    variants: VARIANT_VALUES,
    properties: { variant: VARIANT_VALUES },
    states: Object.keys(LIBRARY_STATE_TABLES.dialog!),
    masterSize: { width: 360, height: 220 },
    masterOps: (grid) => [
      masterHeader("dialog", 360, 220),
      { type: "createFrame", parent: "master-dialog", name: "Dialog", width: 360, height: 220, fill: "#FFFFFF", cornerRadius: grid, layoutMode: "VERTICAL", padding: 24, itemSpacing: 16 },
      { type: "createText", parent: "master-dialog", name: "Title", content: "Confirm", fontSize: 18, weight: 600, fill: "#242521" },
      { type: "createText", parent: "master-dialog", name: "Body", content: "Are you sure?", fontSize: 14, fill: "#5A5C54" },
      { type: "createFrame", parent: "master-dialog", name: "Actions", width: 312, height: 40, fill: [], layoutMode: "HORIZONTAL", padding: 0, itemSpacing: 8 },
      { type: "createFrame", parent: "master-dialog", name: "Primary", width: 150, height: 40, fill: "#242521", cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 8, right: 16, bottom: 8, left: 16 } },
      { type: "createText", parent: "master-dialog", name: "Primary label", content: "Confirm", fontSize: 13, weight: 600, fill: "#FFFFFF" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => [
      { type: "createFrame", id, parent, name: str(props, "title", "Dialog"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 220, fill: "#FFFFFF", cornerRadius: grid, layoutMode: "VERTICAL", padding: 24, itemSpacing: 16 },
      { type: "createText", parent: id, name: "Title", content: str(props, "title", "Confirm"), fontSize: Math.round(18 * typeScale), weight: 600, fill: "#242521" },
      { type: "createText", parent: id, name: "Body", content: str(props, "body", "Are you sure?"), fontSize: Math.round(14 * typeScale), fill: "#5A5C54" },
      { type: "createFrame", parent: id, name: "Actions", width: Math.max(1, Math.round(box.w) - 48), height: 40, fill: [], layoutMode: "HORIZONTAL", padding: 0, itemSpacing: 8 },
      { type: "createFrame", parent: id, name: "Primary", width: 150, height: 40, fill: "#242521", cornerRadius: grid, layoutMode: "HORIZONTAL", padding: { top: 8, right: 16, bottom: 8, left: 16 } },
      { type: "createText", parent: id, name: "Primary label", content: str(props, "action", "Confirm"), fontSize: Math.round(13 * typeScale), weight: 600, fill: "#FFFFFF" },
    ],
    variantFor: (props) => {
      const v = typeof props.variant === "string" ? props.variant : undefined;
      return v ? { Variant: v } : undefined;
    },
  };
}

function navigationItemDef(): LibraryComponentDef {
  return {
    type: "navigationItem",
    masterName: "exo/navigation-item",
    masterId: "master-navigationItem",
    description: "One navigable row: active marker plus label.",
    anatomy: ["frame H auto-layout pad 8/12 gap 8", "marker 4x20 rect", "label text 14"],
    variants: ["default", "active", "disabled"],
    properties: { state: ["default", "active", "selected", "disabled", "loading"], active: ["true", "false"] },
    states: Object.keys(LIBRARY_STATE_TABLES.navigationItem!),
    masterSize: { width: 200, height: 36 },
    masterOps: (grid) => [
      masterHeader("navigationItem", 200, 36),
      { type: "createFrame", parent: "master-navigationItem", name: "Nav item", width: 200, height: 36, fill: [], cornerRadius: grid / 2, layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 }, itemSpacing: 8 },
      { type: "createRectangle", parent: "master-navigationItem", name: "Marker", width: 4, height: 20, fill: [] },
      { type: "createText", parent: "master-navigationItem", name: "Label", content: "Item", fontSize: 14, fill: "#6F716A" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => {
      const active = props.state === "active" || props.active === true;
      return [
        { type: "createFrame", id, parent, name: str(props, "label", "Nav item"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 36, fill: active ? "#F2C94C" : [], cornerRadius: grid / 2, layoutMode: "HORIZONTAL", padding: { top: 8, right: 12, bottom: 8, left: 12 }, itemSpacing: 8 },
        { type: "createRectangle", parent: id, name: "Marker", width: 4, height: 20, fill: active ? "#111111" : [] },
        { type: "createText", parent: id, name: "Label", content: str(props, "label", "Item"), fontSize: Math.round(14 * typeScale), ...(active ? { weight: 600 } : {}), fill: active ? "#111111" : "#6F716A" },
      ];
    },
    variantFor,
  };
}

function tableRowDef(): LibraryComponentDef {
  return {
    type: "tableRow",
    masterName: "exo/table-row",
    masterId: "master-tableRow",
    description: "One table row: title, value and a status word.",
    anatomy: ["frame H auto-layout pad 12 gap 16", "title text 14/600", "value text 12 mono", "status text 11"],
    variants: ["default", "selected", "disabled"],
    properties: { status: ["fits", "does-not-fit", "healthy", "degraded", "offline", "error", "warning"] },
    states: Object.keys(LIBRARY_STATE_TABLES.tableRow!),
    masterSize: { width: 560, height: 48 },
    masterOps: (grid) => [
      masterHeader("tableRow", 560, 48),
      { type: "createFrame", parent: "master-tableRow", name: "Row", width: 560, height: 48, fill: "#FFFFFF", stroke: "#E0E0E0", strokeWeight: 1, cornerRadius: grid / 2, layoutMode: "HORIZONTAL", padding: 12, itemSpacing: 16 },
      { type: "createText", parent: "master-tableRow", name: "Title", content: "llama-70b", fontSize: 14, weight: 600, fill: "#242521" },
      { type: "createText", parent: "master-tableRow", name: "Value", content: "4 shards", fontSize: 12, family: "JetBrains Mono", fill: "#6F716A" },
      { type: "createText", parent: "master-tableRow", name: "Status", content: "fits", fontSize: 11, weight: 500, fill: "#0B6BCB" },
    ],
    fallbackOps: ({ id, parent, box, props, grid, typeScale }) => [
      { type: "createFrame", id, parent, name: str(props, "title", "Row"), x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: 48, fill: "#FFFFFF", stroke: "#E0E0E0", strokeWeight: 1, cornerRadius: grid / 2, layoutMode: "HORIZONTAL", padding: 12, itemSpacing: 16 },
      { type: "createText", parent: id, name: "Title", content: str(props, "title", "llama-70b"), fontSize: Math.round(14 * typeScale), weight: 600, fill: "#242521" },
      { type: "createText", parent: id, name: "Value", content: str(props, "value", "4 shards"), fontSize: Math.round(12 * typeScale), family: "JetBrains Mono", fill: "#6F716A" },
      { type: "createText", parent: id, name: "Status", content: str(props, "status", "fits"), fontSize: Math.round(11 * typeScale), weight: 500, fill: "#0B6BCB" },
    ],
    variantFor,
  };
}

export const COMPONENT_LIBRARY: Record<string, LibraryComponentDef> = {
  button: buttonDef(),
  iconButton: iconButtonDef(),
  textInput: textInputDef(),
  select: selectDef(),
  checkbox: checkboxDef(),
  switch: switchDef(),
  tabs: tabsDef(),
  badge: badgeDef(),
  tooltip: tooltipDef(),
  menu: menuDef(),
  dialog: dialogDef(),
  navigationItem: navigationItemDef(),
  tableRow: tableRowDef(),
};

/** All library types, including the navigation-item and table-row additions. */
export const LIBRARY_COMPONENT_TYPES = Object.keys(COMPONENT_LIBRARY);

/** True when the type has a reusable master definition. */
export function isLibraryComponent(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMPONENT_LIBRARY, type);
}

/** The definition for a library type, or undefined for hand-drawn components. */
export function libraryDefFor(type: string): LibraryComponentDef | undefined {
  return COMPONENT_LIBRARY[type];
}

/**
 * True when the master for this type is already emitted in this operation
 * list. Masters dedupe by master id (one `exo/<type>` master per program),
 * so the Nth instance links to the same componentId as the first — which is
 * what makes a shared change propagate to every instance.
 */
export function libraryMasterEmitted(operations: readonly unknown[], type: string): boolean {
  const def = COMPONENT_LIBRARY[type];
  if (!def) return false;
  return operations.some((o) => typeof o === "object" && o !== null && (o as { id?: unknown }).id === def.masterId);
}
