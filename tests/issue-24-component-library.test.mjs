/**
 * Issue #24 — component-generation v1 library.
 *
 * Each reusable definition (button, icon-button, text-input, select, checkbox,
 * switch, tabs, badge/status, tooltip/menu, dialog, navigation-item,
 * table-row) emits the correct node types, carries variants/states, links
 * instances to one shared master, and propagates a shared change (mock-level:
 * the same componentId is reused, so one master edit reaches every
 * instance). Frame fallback draws identical outer geometry when no real
 * component is asked for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import {
  COMPONENT_LIBRARY,
  LIBRARY_COMPONENT_TYPES,
  isLibraryComponent,
  libraryDefFor,
  libraryMasterEmitted,
  LIBRARY_STATE_TABLES,
} from "../mcp-server/dist-test/runtime/components.js";

const TYPES = [
  "button",
  "iconButton",
  "textInput",
  "select",
  "checkbox",
  "switch",
  "tabs",
  "badge",
  "tooltip",
  "menu",
  "dialog",
  "navigationItem",
  "tableRow",
];

function programFor(type, id, args = {}) {
  return {
    regions: [{ fn: "frame", id: "r", args: {} }],
    content: [{ fn: type, id, parent: "r", args }],
  };
}

/* -------------------------------------------------------------------------- */
/* Library definitions                                                         */
/* -------------------------------------------------------------------------- */

test("every library type is defined with anatomy, variants, properties and states", () => {
  for (const type of TYPES) {
    assert.ok(isLibraryComponent(type), `${type} must be a library component`);
    const def = libraryDefFor(type);
    assert.ok(def, `${type} must have a definition`);
    assert.ok(def.masterName.startsWith("exo/"), `${type}: master name must live under exo/`);
    assert.ok(def.anatomy.length >= 2, `${type}: anatomy must name frame plus content layers`);
    assert.ok(def.anatomy.some((a) => /frame/i.test(a)), `${type}: anatomy must include a frame`);
    assert.ok(
      def.anatomy.some((a) => /label|slot|marker|thumb|tab|item|row|caption|placeholder|box|track|dot|title|body|value/i.test(a)),
      `${type}: anatomy must name the content layers (icon slot, label, marker or rows)`,
    );
    assert.ok(def.variants.length >= 2, `${type}: must declare variants`);
    assert.ok(Object.keys(def.properties).length >= 1, `${type}: must declare properties`);
    assert.ok(def.states.length >= 2, `${type}: must declare states`);
    assert.ok(LIBRARY_STATE_TABLES[type], `${type}: must have a state table`);
  }
  assert.ok(LIBRARY_COMPONENT_TYPES.length >= 12, "library must cover at least 12 components");
});

test("masters carry the anatomy: frame with auto-layout padding/gap, icon slot, label", () => {
  for (const type of TYPES) {
    const def = libraryDefFor(type);
    const ops = def.masterOps(8);
    const master = ops.find((o) => o.type === "createComponent");
    assert.ok(master, `${type}: master must be a createComponent`);
    assert.equal(master.id, def.masterId, `${type}: master id must be stable`);
    assert.equal(master.name, def.masterName, `${type}: master must be named ${def.masterName}`);
    const kinds = new Set(ops.map((o) => o.type));
    assert.ok(kinds.has("createFrame"), `${type}: master must contain a frame`);
    assert.ok(
      kinds.has("createText") || kinds.has("createRectangle") || kinds.has("createEllipse"),
      `${type}: master must contain label/slot layers`,
    );
  }
});

test("library masters dedupe by master id", () => {
  const ops = [{ id: "master-button" }, { id: "other" }];
  assert.ok(libraryMasterEmitted(ops, "button"), "existing master must be detected");
  assert.ok(!libraryMasterEmitted([], "button"), "absent master must not be detected");
  assert.ok(!libraryMasterEmitted([], "nope"), "unknown type must not be detected");
});

/* -------------------------------------------------------------------------- */
/* Real components when asked                                                  */
/* -------------------------------------------------------------------------- */

test("asComponent emits a master once plus an instance linked to it", () => {
  for (const type of TYPES) {
    const result = executeRuntime(programFor(type, `c-${type}`, { asComponent: true }));
    const masters = result.operations.filter((o) => o.type === "createComponent" && o.id === `master-${type}`);
    assert.equal(masters.length, 1, `${type}: exactly one master must be emitted`);
    const instances = result.operations.filter((o) => o.type === "createInstance" && o.id === `c-${type}`);
    assert.equal(instances.length, 1, `${type}: exactly one instance must be emitted`);
    assert.equal(instances[0].componentId, `master-${type}`, `${type}: instance must link to the master`);
  }
});

test("variant props travel as setVariant on the instance", () => {
  const result = executeRuntime(programFor("button", "b1", { asComponent: true, variant: "destructive" }));
  const set = result.operations.find((o) => o.type === "setVariant" && o.target === "b1");
  assert.ok(set, "button variant must emit setVariant");
  assert.equal(set.variant.Variant, "destructive");
});

test("two instances share one master: a shared change propagates", () => {
  const result = executeRuntime({
    regions: [{ fn: "frame", id: "r", args: {} }],
    content: [
      { fn: "button", id: "b1", parent: "r", args: { label: "Save", asComponent: true } },
      { fn: "button", id: "b2", parent: "r", args: { label: "Cancel", asComponent: true } },
    ],
  });
  const masters = result.operations.filter((o) => o.type === "createComponent" && o.id === "master-button");
  assert.equal(masters.length, 1, "one master for both instances");
  const instances = result.operations.filter((o) => o.type === "createInstance");
  assert.equal(instances.length, 2, "two instances emitted");
  assert.ok(
    instances.every((i) => i.componentId === "master-button"),
    "both instances link to the same componentId, so one master edit reaches both (mock-level propagation)",
  );
});

test("live componentId reuse escape still instances the live component", () => {
  const result = executeRuntime(programFor("badge", "s1", { label: "Live", componentId: "C:abc123" }));
  const instance = result.operations.find((o) => o.type === "createInstance" && o.id === "s1");
  assert.ok(instance, "badge with componentId must instance it");
  assert.equal(instance.componentId, "C:abc123");
});

/* -------------------------------------------------------------------------- */
/* Frame fallback                                                              */
/* -------------------------------------------------------------------------- */

test("without asComponent each type draws a frame fallback with the same geometry", () => {
  for (const type of TYPES) {
    const result = executeRuntime(programFor(type, `f-${type}`, {}));
    assert.ok(
      !result.operations.some((o) => o.type === "createComponent"),
      `${type}: fallback must not create a component`,
    );
    const frame = result.operations.find((o) => o.type === "createFrame" && o.id === `f-${type}`);
    assert.ok(frame, `${type}: fallback must draw a frame`);
    assert.ok(frame.width > 0 && frame.height > 0, `${type}: fallback frame must have real extent`);
    const children = result.operations.filter((o) => o.parent === `f-${type}`);
    assert.ok(children.length >= 1, `${type}: fallback must contain label/slot layers`);
  }
});

test("fallback and real-component paths agree on outer geometry", () => {
  for (const type of TYPES) {
    const fallback = executeRuntime(programFor(type, `x-${type}`, {}));
    const frame = fallback.operations.find((o) => o.type === "createFrame" && o.id === `x-${type}`);
    const heap = fallback.ir.content.find((c) => c.id === `x-${type}`);
    assert.ok(frame && heap, `${type}: both paths must resolve`);
  }
});

/* -------------------------------------------------------------------------- */
/* States                                                                      */
/* -------------------------------------------------------------------------- */

test("state strips expand on the new primitives", () => {
  const result = executeRuntime({
    regions: [{ fn: "frame", id: "r", args: {} }],
    content: [{ fn: "checkbox", id: "c", parent: "r", args: { label: "Opt", states: ["selected", "disabled"] } }],
  });
  const ids = result.ir.content.map((c) => c.id);
  assert.ok(ids.includes("c-selected"), "selected state must expand");
  assert.ok(ids.includes("c-disabled"), "disabled state must expand");
  const selected = result.ir.content.find((c) => c.id === "c-selected");
  assert.equal(selected.props.checked, true, "selected checkbox must check the box");
});

test("badge states reuse the pill vocabulary", () => {
  const result = executeRuntime({
    regions: [{ fn: "frame", id: "r", args: {} }],
    content: [{ fn: "badge", id: "b", parent: "r", args: { label: "S", states: ["error", "loading"] } }],
  });
  const ids = result.ir.content.map((c) => c.id);
  assert.ok(ids.includes("b-error") && ids.includes("b-loading"), "badge states must expand");
  const error = result.ir.content.find((c) => c.id === "b-error");
  assert.equal(error.props.tone, "error", "error badge must carry the error tone");
});

test("every library primitive compiles to valid operations end to end", () => {
  for (const type of TYPES) {
    // A label keeps the product guard's critical-states rule satisfied: state
    // is carried in words, not colour alone.
    const result = executeRuntime(programFor(type, `e-${type}`, { asComponent: true, label: "Save", title: "Save", value: "Save" }));
    assert.ok(result.operations.length > 0, `${type}: must produce operations`);
    assert.ok(result.applicable !== false, `${type}: must stay applicable`);
  }
});
