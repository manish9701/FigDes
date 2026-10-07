/**
 * Plugin runtime harness.
 *
 * The plugin's main thread can only be exercised inside Figma, which is exactly
 * why bugs in it go unnoticed until ChatGPT reports a vague "failing
 * internally". This loads the real bundled `dist/code.js` against a minimal
 * Figma API mock so the main-thread handlers are testable here instead.
 *
 * The mock implements only what the plugin actually touches. If the plugin
 * starts using something new, this file is where you find out.
 */

import { readFileSync } from "node:fs";

let seq = 0;
const nextId = () => `99:${++seq}`;

function paint(hex, alpha = 1) {
  const n = parseInt(hex.replace("#", ""), 16);
  return {
    type: "SOLID",
    color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 },
    opacity: alpha,
    visible: true,
  };
}

/**
 * Where exportAsync records calls.
 *
 * Module-scoped on purpose: `mixin` runs while the document is being built,
 * which is before any figma mock exists, so it cannot close over one. Assigned
 * by makeFigma below.
 */
let exportLog = [];

/**
 * Structural mutation shared by every mock node. The plugin calls these
 * directly, so a node without them is a harness gap rather than a plugin bug.
 */
function mixin(node) {
  node.resize = (w, h) => {
    node.width = w;
    node.height = h;
    return { width: w, height: h };
  };

  node.appendChild = (child) => {
    if (child.parent?.children) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    child.parent = node;
    node.children.push(child);
    return child;
  };

  node.insertChild = (index, child) => {
    if (child.parent?.children) {
      const i = child.parent.children.indexOf(child);
      if (i >= 0) child.parent.children.splice(i, 1);
    }
    child.parent = node;
    node.children.splice(index, 0, child);
    return child;
  };

  node.remove = () => {
    if (node.parent?.children) {
      const i = node.parent.children.indexOf(node);
      if (i >= 0) node.parent.children.splice(i, 1);
    }
    node.parent = null;
    node.removed = true;
  };

  // Records variable bindings the way Figma tracks them: field -> variable id.
  node.setBoundVariable = (field, variable) => {
    node.__bound = { ...(node.__bound ?? {}), [field]: variable ? variable.id : null };
  };

  // Prototype reactions. Appended, never replaced, mirroring the plugin.
  node.reactions = [];
  node.setReactionsAsync = async (reactions) => {
    node.reactions = [...reactions];
  };

  node.clone = () => {
    const copy = JSON.parse(
      JSON.stringify(node, (k, v) => (k === "parent" || k === "children" || typeof v === "function" ? undefined : v)),
    );
    copy.id = nextId();
    copy.name = `${node.name} copy`;
    return mixin(copy);
  };

  node.setRange = () => {};
  node.setPluginData = () => {};
  node.getPluginData = () => "";

  /**
   * Stands in for rasterisation. Produces bytes proportional to the requested
   * surface so token and byte estimates in tests reflect a realistic image
   * rather than a constant.
   */
  node.exportAsync = async (settings = {}) => {
    const width = settings?.constraint?.type === "WIDTH" ? settings.constraint.value : node.width;
    const height = Math.max(1, Math.round((width / Math.max(1, node.width)) * node.height));
    exportLog.push({ id: node.id, width, height, format: settings?.format ?? "PNG" });
    // ~0.35 bytes per pixel matches the flat-UI PNG ratio the planner assumes.
    return new Uint8Array(Math.max(64, Math.round(width * height * 0.35)));
  };

  return node;
}

/* -------------------------------------------------------------------------- */
/* Mock node graph                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds an ancestor chain so background resolution can be exercised. The
 * compositing bug this covers only appears when a node sits inside a frame that
 * has its own opaque fill.
 */
export function makeNested({ textColor = "#BBBBBB", bgColor = "#FFFFFF", midColor = null, midAlpha = 1 } = {}) {
  seq = 0;

  const label = text({ name: "Muted label", characters: "Status", x: 16, y: 16, fontSize: 14, fills: [paint(textColor)] });

  let innermost = frame({
    name: "Inner",
    x: 0,
    y: 0,
    width: 300,
    height: 80,
    fills: midColor ? [paint(midColor, midAlpha)] : [paint(bgColor)],
    children: [label],
  });

  const outer = frame({
    name: "Outer",
    width: 800,
    height: 600,
    fills: [paint("#111111")],
    children: [innermost],
  });

  linkParents(outer);
  innermost = null;

  const page = mixin({ type: "PAGE", id: "0:1", name: "Page 1", children: [outer], selection: [label], parent: null });
  outer.parent = page;

  return { root: outer, page, label, outer, inner: outer.children[0] };
}

function frame(props = {}) {
  return mixin({
    type: "FRAME",
    id: props.id ?? nextId(),
    name: props.name ?? "Frame",
    visible: props.visible !== false,
    opacity: 1,
    x: props.x ?? 0,
    y: props.y ?? 0,
    width: props.width ?? 400,
    height: props.height ?? 300,
    fills: props.fills ?? [paint("#FFFFFF")],
    strokes: props.strokes ?? [],
    strokeWeight: props.strokeWeight ?? 1,
    cornerRadius: props.cornerRadius ?? 0,
    effects: props.effects ?? [],
    layoutMode: props.layoutMode ?? "NONE",
    itemSpacing: props.itemSpacing ?? 0,
    paddingTop: props.paddingTop ?? 0,
    paddingRight: props.paddingRight ?? 0,
    paddingBottom: props.paddingBottom ?? 0,
    paddingLeft: props.paddingLeft ?? 0,
    primaryAxisSizingMode: "FIXED",
    counterAxisSizingMode: "FIXED",
    primaryAxisAlignItems: "MIN",
    counterAxisAlignItems: "MIN",
    clipsContent: false,
    children: props.children ?? [],
    parent: props.parent ?? null,
    key: "k",
    ...props.extra,
  });
}

/**
 * Gives a mock component node a createInstance factory.
 *
 * Instances behave like documentAccess: dynamic-page throughout this harness:
 * reading `.mainComponent` throws, and only `getMainComponentAsync()` works.
 * That is deliberate — it proves no code path touches the sync accessor, which
 * is exactly what broke component discovery in the real EXO file.
 */
function addInstanceFactory(component) {
  component.createInstance = () => {
    const inst = frame({ name: component.name, width: component.width, height: component.height });
    inst.type = "INSTANCE";
    Object.defineProperty(inst, "mainComponent", {
      get() {
        throw new Error("Cannot call with documentAccess: dynamic-page. Use node.getMainComponentAsync instead.");
      },
    });
    inst.getMainComponentAsync = async () => component;
    inst.setProperties = (props) => {
      inst.__properties = { ...(inst.__properties ?? {}), ...props };
    };
    // Records the swap target. A real Figma instance re-renders as the new
    // variant; here the id is what the test asserts on.
    inst.swapComponent = (target) => {
      inst.__swappedTo = target.id;
    };
    return inst;
  };
  return component;
}

function text(props = {}) {
  return mixin({
    type: "TEXT",
    id: props.id ?? nextId(),
    name: props.name ?? "Text",
    visible: true,
    opacity: 1,
    x: props.x ?? 0,
    y: props.y ?? 0,
    width: props.width ?? 100,
    height: props.height ?? 20,
    fills: props.fills ?? [paint("#111111")],
    strokes: [],
    strokeWeight: 1,
    effects: [],
    characters: props.characters ?? "Hello",
    fontName: props.fontName ?? { family: "Inter", style: "Regular" },
    fontSize: props.fontSize ?? 14,
    lineHeight: { unit: "PIXELS", value: 20 },
    letterSpacing: { unit: "PIXELS", value: 0 },
    textAlignHorizontal: "LEFT",
    textAlignVertical: "TOP",
    textStyleId: props.textStyleId ?? "",
    textAutoResize: "WIDTH_AND_HEIGHT",
    cornerRadius: 0,
    parent: props.parent ?? null,
  });
}

function linkParents(node) {
  if (node.children) {
    for (const c of node.children) {
      c.parent = node;
      linkParents(c);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Build a small document                                                      */
/* -------------------------------------------------------------------------- */

export function makeDocument({ withSelection = true } = {}) {
  seq = 0;

  const title = text({ name: "Frame 1", characters: "Dashboard", x: 16, y: 16, fontSize: 20, fills: [paint("#999999")] });
  const body = text({ name: "Subtitle", characters: "Welcome back", x: 16, y: 48, fontSize: 13 });

  const card = frame({
    name: "Card",
    x: 16,
    y: 80,
    width: 336,
    height: 120,
    cornerRadius: 6,
    fills: [paint("#FFFFFF")],
    children: [title, body],
    layoutMode: "VERTICAL",
    itemSpacing: 8,
    paddingTop: 16,
    paddingRight: 16,
    paddingBottom: 16,
    paddingLeft: 16,
  });

  const card2 = frame({
    name: "Card",
    x: 16,
    y: 220,
    width: 336,
    height: 120,
    cornerRadius: 12, // deliberately inconsistent with the first card
    fills: [paint("#FFFFFF")],
    children: [],
  });

  const root = frame({ name: "Dashboard", width: 1440, height: 900, children: [card, card2], fills: [paint("#F7F5EF")] });
  linkParents(root);

  const page = mixin({
    type: "PAGE",
    id: "0:1",
    name: "Page 1",
    children: [root],
    selection: withSelection ? [root] : [],
    parent: null,
  });
  root.parent = page;

  return { root, page };
}

/* -------------------------------------------------------------------------- */
/* The mock PluginAPI                                                          */
/* -------------------------------------------------------------------------- */

export function makeFigma(doc) {
  const posted = [];
  const logs = [];
  const events = {};
  const storage = new Map();
  const undoLog = [];

  // Fresh per-mock export log. Nodes built before this point still write here,
  // which is what lets a test assert what was rendered.
  exportLog = [];

  const byId = new Map();
  const index = (node) => {
    byId.set(node.id, node);
    for (const c of node.children ?? []) index(c);
  };
  index(doc.root);

  const localCollections = [];
  const localVariables = [];
  const localTextStyles = [];
  const localPaintStyles = [];
  const slideGrid = [];

  const figma = {
    editorType: "figma",

    root: {
      id: "0:0",
      name: "Exo Labs",
      type: "DOCUMENT",
      children: [doc.page],
      parent: null,
    },

    get currentPage() {
      return doc.page;
    },

    ui: {
      postMessage: (m) => posted.push(m),
      onmessage: null,
    },

    showUI: (html, opts) => {
      figma.__ui = { html, opts };
    },

    on: (evt, cb) => {
      events[evt] = cb;
    },

    clientStorage: {
      getAsync: async (k) => storage.get(k),
      setAsync: async (k, v) => storage.set(k, v),
    },

    loadAllPagesAsync: async () => {
      figma.__loadAllPagesCalls = (figma.__loadAllPagesCalls ?? 0) + 1;
    },

    /**
     * Live lookup, not the `byId` snapshot.
     *
     * `byId` is built when the mock is created, so it cannot resolve a node the
     * plugin made a moment ago. Real Figma's `getNodeByIdAsync` obviously can, and
     * anything that parents a child onto a frame created earlier in the same
     * transaction depends on it. With a snapshot here, every nested create failed
     * with "Node not found: root" -- which reads like a plugin bug and is not one.
     */
    getNodeByIdAsync: async (id) => {
      const direct = byId.get(id);
      if (direct) return direct;
      const stack = [doc.page];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.id === id) return node;
        if (Array.isArray(node.children)) stack.push(...node.children);
      }
      return null;
    },

    commitUndo: () => undoLog.push("commit"),
    triggerUndo: () => undoLog.push("undo"),

    listAvailableFontsAsync: async () => [
      { fontName: { family: "Inter", style: "Regular" } },
      { fontName: { family: "Inter", style: "Bold" } },
      { fontName: { family: "Roboto", style: "Regular" } },
    ],
    loadFontAsync: async (fn) => {
      if (!fn || typeof fn.family !== "string") throw new Error("bad font");
    },

getLocalVariablesAsync: async () => [
      { name: "color/bg", resolvedType: "COLOR", id: "VariableID:1", scopes: ["FRAME_FILL"], valuesByMode: { m: { r: 1, g: 1, b: 1 } } },
    ],
    getLocalPaintStylesAsync: async () => localPaintStyles,
    getLocalTextStylesAsync: async () => localTextStyles,
    getLocalEffectStylesAsync: async () => [],

    /**
     * Variable API (spec §22).
     *
     * Modelled with real collections, modes and values rather than stubs,
     * because the behaviour under test *is* the create-or-update logic: a second
     * run of the same program must update the existing token rather than
     * producing `space/md` and `space/md 2`.
     */
    variables: {
      getLocalVariableCollectionsAsync: async () => localCollections,
      createVariableCollection: (name) => {
        const collection = {
          name,
          id: `VariableCollectionId:${localCollections.length + 1}`,
          modes: [{ modeId: `${name}:mode-1`, name: "Mode 1" }],
          variableIds: [],
          addMode: (modeName) => {
            const modeId = `${name}:mode-${collection.modes.length + 1}`;
            collection.modes.push({ modeId, name: modeName });
            return modeId;
          },
        };
        localCollections.push(collection);
        return collection;
      },
      createVariable: (name, collection, resolvedType) => {
        const variable = {
          name,
          id: `VariableID:${localVariables.length + 1}`,
          resolvedType,
          description: "",
          scopes: ["ALL_SCOPES"],
          valuesByMode: {},
          setValueForMode(modeId, value) {
            this.valuesByMode[modeId] = value;
          },
        };
        localVariables.push(variable);
        collection.variableIds.push(variable.id);
        return variable;
      },
      getVariableById: (id) => localVariables.find((v) => v.id === id) ?? null,
    },

    createTextStyle: () => {
      const style = { id: `S:${localTextStyles.length + 1}`, type: "TEXT", name: "TextStyle", fontName: { family: "Inter", style: "Regular" }, fontSize: 12 };
      localTextStyles.push(style);
      return style;
    },

    createPaintStyle: () => {
      const style = { id: `S:${localPaintStyles.length + 1}`, type: "PAINT", name: "PaintStyle", paints: [] };
      localPaintStyles.push(style);
      return style;
    },

    createFrame: () => frame({ name: "Frame" }),
    createRectangle: () => frame({ name: "Rectangle", cornerRadius: 0 }),
    createEllipse: () => frame({ name: "Ellipse", cornerRadius: 0 }),
    createText: () => text({ name: "Text" }),

    group: (nodes, parent) => {
      const g = frame({ name: "Group", children: [] });
      g.type = "GROUP";
      for (const node of nodes) {
        if (node.parent?.children) {
          const i = node.parent.children.indexOf(node);
          if (i >= 0) node.parent.children.splice(i, 1);
        }
        node.parent = g;
        g.children.push(node);
      }
      const into = parent ?? doc.page;
      into.children.push(g);
      g.parent = into;
      return g;
    },

    /**
     * Slides are fixed 1920x1080 frames that must live in a slide grid.
     *
     * The mock keeps a grid array so tests can assert deck order; the row/col
     * arguments are honoured the way the real API honours them (append when
     * omitted).
     */
    createSlide: (row, col) => {
      const slide = frame({ name: "Slide", width: 1920, height: 1080, cornerRadius: 0 });
      slide.type = "SLIDE";
      slide.speakerNotes = "";
      slide.isSkippedSlide = false;
      slide.resize = () => {
        throw new Error("Slides are a fixed 1920x1080 and cannot be resized.");
      };
      if (row === undefined || col === undefined) {
        slideGrid.push(slide);
      } else {
        slideGrid.splice(col, 0, slide);
      }
      doc.page.children.push(slide);
      slide.parent = doc.page;

      // Rollback must also leave the grid, not just the page.
      const remove = slide.remove;
      slide.remove = () => {
        remove();
        const i = slideGrid.indexOf(slide);
        if (i >= 0) slideGrid.splice(i, 1);
      };
      return slide;
    },

    /**
     * Vector nodes.
     *
     * `vectorPaths` is recorded rather than validated: the point of these tests
     * is the plugin's own path pipeline (parse, then re-serialise into Figma's
     * format), and the number of stored subpaths is what shows whether a
     * connector's arrowhead arrived as its own region rather than being dropped.
     */
    createVector: () => {
      const v = frame({ name: "Vector", cornerRadius: 0 });
      v.type = "VECTOR";
      v.vectorPaths = [];
      v.dashPattern = [];
      v.resize = (w, h) => {
        v.width = w;
        v.height = h;
      };
      return v;
    },

    /**
     * Rasterises to a tiny deterministic PNG-like byte string.
     *
     * The plugin base64-encodes the result and tests assert on token estimates,
     * so the bytes need to be non-empty and plausibly sized for a width x height
     * surface — they do not need to be a real image.
     */
    createImage: (bytes) => ({ hash: `hash-${bytes.byteLength}` }),

    createComponent: () => {
      const c = frame({ name: "Component" });
      c.type = "COMPONENT";
      c.key = `key-${nextId()}`;
      c.description = "";
      c.componentPropertyDefinitions = {};
      c.addComponentProperty = (name, type, defaultValue) => {
        c.componentPropertyDefinitions[name] = { type, defaultValue };
      };
      return addInstanceFactory(c);
    },

    createComponentFromNode: (node) => {
      const c = frame({ name: node.name, width: node.width, height: node.height });
      c.type = "COMPONENT";
      c.key = `key-${nextId()}`;
      c.componentPropertyDefinitions = {};
      c.addComponentProperty = (name, type, defaultValue) => {
        c.componentPropertyDefinitions[name] = { type, defaultValue };
      };
      return addInstanceFactory(c);
    },

    /**
     * Combines components into a set. Members are reparented under the new set,
     * mirroring the real API's reparenting behaviour closely enough that order
     * and membership assertions hold.
     */
    combineAsVariants: (nodes, parent) => {
      const set = frame({ name: "Set" });
      set.type = "COMPONENT_SET";
      set.description = "";
      for (const node of nodes) {
        if (node.parent?.children) {
          const i = node.parent.children.indexOf(node);
          if (i >= 0) node.parent.children.splice(i, 1);
        }
        node.parent = set;
        set.children.push(node);
      }
      (parent ?? doc.page).children.push(set);
      set.parent = parent ?? doc.page;
      return set;
    },

    // test-only introspection
    __posted: posted,
    __logs: logs,
    __undoLog: undoLog,
    __byId: byId,
    __exports: exportLog,
    __collections: localCollections,
    __variables: localVariables,
    __textStyles: localTextStyles,
    __paintStyles: localPaintStyles,
    __slideGrid: slideGrid,

    /**
     * Looks a node up in the *live* tree.
     *
     * `__byId` is a snapshot taken when the mock was built, so it cannot resolve
     * nodes the plugin created afterwards. Any test asserting on a node's final
     * state has to walk the tree instead.
     */
    __node: (id) => {
      // Walks from the *page*, not `doc.root`: in this harness `doc.root` is a
      // frame living on the page, so anything the plugin appends to
      // `figma.currentPage` directly would be unreachable from it.
      const stack = [doc.page];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node.id === id) return node;
        if (Array.isArray(node.children)) stack.push(...node.children);
      }
      return null;
    },
  };

  /**
   * Exposed on the document as well as on the figma object.
   *
   * Variable and style creation is the feature under test, and reading them off
   * the mock API object would mean the test asserts on the same reference the
   * code mutated -- which passes even if nothing happened. Reading off `doc`
   * keeps the assertions independent of the mock's internals.
   */
  doc.collections = localCollections;
  doc.variables = localVariables;
  doc.textStyles = localTextStyles;
  doc.paintStyles = localPaintStyles;
  doc.slideGrid = slideGrid;

  return figma;
}

/* -------------------------------------------------------------------------- */
/* Load the real bundle                                                        */
/* -------------------------------------------------------------------------- */

export function loadPlugin(doc = makeDocument()) {
  const code = readFileSync(new URL("../figma-plugin/dist/code.js", import.meta.url), "utf8");
  const figma = makeFigma(doc);

  // The bundle is an IIFE that expects `figma` and the baked `__html__` as
  // free variables, exactly as Figma provides them.
  const factory = new Function("figma", "__html__", code);
  factory(figma, "<html></html>");

  return { figma, doc };
}

/** Send a message to the plugin's main thread and await its reply. */
export async function ask(figma, tool, payload = {}, { timeoutMs = 5000 } = {}) {
  figma.__posted.length = 0;

  const requestId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const handler = figma.ui.onmessage;
  if (!handler) throw new Error("plugin never registered figma.ui.onmessage");

  await handler({ kind: "request", requestId, tool, payload });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = figma.__posted.find((m) => m.kind === "response" && m.requestId === requestId);
    if (reply) return reply;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no response to ${tool} within ${timeoutMs}ms`);
}