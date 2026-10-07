/**
 * Component awareness (spec §21).
 *
 * The point is narrow and important: before the model builds a card, a status
 * row or a device tile out of rectangles, it should be able to ask "does this
 * already exist?". Rebuilding existing UI is the main way a design system rots,
 * and it is entirely avoidable if lookup is cheap.
 *
 * Promotion is the other half. Converting a hand-built frame into a real
 * component makes the next screen cheaper to build, and `fromNode` keeps the
 * original geometry rather than requiring a rebuild.
 */
import { getNode, allPages } from "./cache";
import type {
  ComponentSummary,
  CreateComponentResult,
  CreateInstanceResult,
  FindComponentsResult,
} from "../../shared/protocol";

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

export interface FindOptions {
  /** Free-text query. Matched against name and description. */
  query?: string;
  /** Hard cap on returned components. */
  limit: number;
  maxNodes: number;
}

export const DEFAULT_FIND: FindOptions = { limit: 25, maxNodes: 4000 };

export async function findComponents(opts: FindOptions): Promise<FindComponentsResult> {
  await allPages();

  const summary = new Map<string, ComponentSummary>();
  const instanceCounts = new Map<string, number>();
  let scanned = 0;
  let truncated = false;

  // Instances are counted first so a component's reuse count is known even when
  // the component itself lives on a page we do not walk.
  const walk = async (node: BaseNode, depth: number): Promise<void> => {
    if (scanned >= opts.maxNodes) {
      truncated = true;
      return;
    }
    if (depth > 14) return;
    scanned += 1;

    if (node.type === "INSTANCE") {
      // `mainComponent` is write-only under documentAccess: dynamic-page and
      // throws there. The async path works everywhere, so it is the only path.
      let main: ComponentNode | null = null;
      try {
        main = await (node as InstanceNode).getMainComponentAsync();
      } catch {
        main = null;
      }
      if (main) instanceCounts.set(main.id, (instanceCounts.get(main.id) ?? 0) + 1);
    }

    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      const component = node as ComponentNode;
      const defs = (component as ComponentNode).componentPropertyDefinitions ?? {};
      const entry: ComponentSummary = {
        id: component.id,
        name: component.name,
        type: node.type,
        description: component.description ?? "",
        properties: Object.keys(defs),
        width: Math.round(component.width),
        height: Math.round(component.height),
        instanceCount: instanceCounts.get(component.id) ?? 0,
      };

      // A COMPONENT_SET is the canonical unit: its variants are children, not
      // separate components, so they are folded in rather than listed.
      if (node.type === "COMPONENT_SET") {
        entry.variantCount = (node as unknown as { children: readonly SceneNode[] }).children.length;
        summary.set(component.id, entry);
        return; // do not descend: variants would double-list
      }

      // A variant inside a set is reachable via its set.
      if (!component.parent || component.parent.type !== "COMPONENT_SET") {
        summary.set(component.id, entry);
      }
    }

    if ("children" in node && node.children) {
      for (const child of node.children) await walk(child, depth + 1);
    }
  };

  for (const page of figma.root.children) await walk(page, 0);

  // Fold in any instance counts discovered after the component was seen.
  for (const entry of summary.values()) {
    entry.instanceCount = instanceCounts.get(entry.id) ?? entry.instanceCount;
  }

  const all = [...summary.values()].sort((a, b) => b.instanceCount - a.instanceCount || a.name.localeCompare(b.name));

  if (!opts.query) {
    return {
      truncated,
      total: all.length,
      matches: all.slice(0, opts.limit).map((component) => ({
        component,
        score: 1,
        reason: component.instanceCount > 0 ? `reused ${component.instanceCount}x` : "no instances yet",
      })),
    };
  }

  const query = opts.query.trim().toLowerCase();
  const terms = query.split(/[\s_-]+/).filter(Boolean);

  const scored = all
    .map((component) => {
      const haystack = `${component.name} ${component.description}`.toLowerCase();
      const nameHay = component.name.toLowerCase();

      let score = 0;
      const reasons: string[] = [];

      for (const term of terms) {
        if (nameHay === term) {
          score += 1;
          reasons.push(`name is exactly "${term}"`);
        } else if (nameHay.startsWith(term)) {
          score += 0.8;
          reasons.push(`name starts with "${term}"`);
        } else if (nameHay.includes(term)) {
          score += 0.6;
          reasons.push(`name contains "${term}"`);
        } else if (haystack.includes(term)) {
          score += 0.3;
          reasons.push(`description contains "${term}"`);
        }
      }

      // Reuse is a real signal: a component used 40 times is the safe default.
      if (score > 0 && component.instanceCount > 0) {
        score += Math.min(0.3, component.instanceCount * 0.01);
        reasons.push(`reused ${component.instanceCount}x`);
      }

      return { component, score, reason: reasons.join("; ") };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.component.name.localeCompare(b.component.name));

  return {
    truncated,
    total: all.length,
    matches: scored.slice(0, opts.limit),
  };
}

/* -------------------------------------------------------------------------- */
/* Promotion and reuse                                                         */
/* -------------------------------------------------------------------------- */

export async function createComponent(input: {
  name: string;
  description?: string;
  /** Existing node to promote. Preferred over rebuilding the geometry. */
  fromNode?: string;
  /** Build an empty component instead of promoting one. */
  width?: number;
  height?: number;
  /** Property definitions, so instances can vary. */
  properties?: Record<string, { type: "TEXT" | "BOOLEAN" | "INSTANCE_SWAP"; defaultValue?: string }>;
}): Promise<CreateComponentResult> {
  const width = input.width ?? 200;
  const height = input.height ?? 100;

  let source: SceneNode | null = null;
  let component: ComponentNode;

  if (input.fromNode) {
    const node = await getNode(input.fromNode);
    if (!node || node.removed) {
      throw new Error(
        `Node not found: ${input.fromNode}. Pass the id of an existing frame or group to promote, or omit fromNode to build an empty component.`,
      );
    }
    if (node.type === "PAGE" || node.type === "DOCUMENT") {
      throw new Error("A page cannot be turned into a component. Select a frame or group.");
    }
    source = node as SceneNode;
    // figma.createComponent() then copy is not possible, so use the documented
    // conversion: create the component and move the existing children in.
    component = figma.createComponent();
    component.name = input.name;
    component.resize(source.width, source.height);
    for (const child of [...(source as FrameNode).children ?? []]) {
      component.appendChild(child);
    }
    if (source.type === "FRAME") {
      const f = source as FrameNode;
      if (f.layoutMode !== "NONE") {
        component.layoutMode = f.layoutMode;
        component.itemSpacing = f.itemSpacing;
        component.paddingTop = f.paddingTop;
        component.paddingRight = f.paddingRight;
        component.paddingBottom = f.paddingBottom;
        component.paddingLeft = f.paddingLeft;
      }
      if (Array.isArray(f.fills)) component.fills = f.fills as never;
      if (typeof f.cornerRadius === "number") component.cornerRadius = f.cornerRadius;
    }
    // The old frame is now empty scaffolding; remove it so the file stays clean.
    source.remove();
  } else {
    component = figma.createComponent();
    component.name = input.name;
    component.resize(width, height);
  }

  if (input.description) component.description = input.description;
  else if (source) component.description = `Promoted from "${source.name}".`;

  // Place it on the same page as the content it came from.
  figma.currentPage.appendChild(component);

  const propertyNames: string[] = [];
  for (const [key, def] of Object.entries(input.properties ?? {})) {
    try {
      component.addComponentProperty(key, def.type, def.defaultValue ?? (def.type === "TEXT" ? key : ""));
      propertyNames.push(key);
    } catch {
      // An invalid property definition should not lose the component itself.
    }
  }

  return {
    componentId: component.id,
    componentSetId: null,
    name: component.name,
    description: component.description,
    properties: propertyNames,
  };
}

export async function createInstance(input: {
  componentId: string;
  name?: string;
  x?: number;
  y?: number;
  parent?: string;
  /** Property values, keyed by property name. */
  properties?: Record<string, string>;
}): Promise<CreateInstanceResult> {
  const node = await getNode(input.componentId);
  if (!node || node.removed) {
    throw new Error(
      `Component not found: ${input.componentId}. Call find_component to get a real component id before creating an instance.`,
    );
  }
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error(
      `Node ${input.componentId} is a ${node.type}, not a component. find_component only returns COMPONENT and COMPONENT_SET ids.`,
    );
  }

  let parent: ParentNode = figma.currentPage;
  if (input.parent) {
    const p = await getNode(input.parent);
    if (!p || p.removed) throw new Error(`Parent not found: ${input.parent}.`);
    if (!("appendChild" in p)) throw new Error(`A ${p.type} cannot contain an instance.`);
    parent = p as unknown as ParentNode;
  }

  const instance = (node as ComponentNode).createInstance();
  if (input.name) instance.name = input.name;

  parent.appendChild(instance);
  if (input.x !== undefined) instance.x = input.x;
  if (input.y !== undefined) instance.y = input.y;

  for (const [key, value] of Object.entries(input.properties ?? {})) {
    try {
      instance.setProperties({ [key]: value });
    } catch {
      // A property that does not exist on this component is skipped rather than
      // failing the whole instance.
    }
  }

  return {
    instanceId: instance.id,
    name: instance.name,
    componentId: node.id,
    width: Math.round(instance.width),
    height: Math.round(instance.height),
  };
}

/* -------------------------------------------------------------------------- */
/* Variants and master edits                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Switches an instance to another variant of its component set.
 *
 * `variant` is matched in two ways, in order: an exact variant name first, then
 * `Property=Value` pairs (comma-separated for several) matched against the
 * variant's own name segments. That covers both "Primary" and
 * "Style=Primary, State=Hover" without the caller needing to know which
 * convention the file uses.
 */
export async function setVariant(input: { instanceId: string; variant: string }): Promise<{
  instanceId: string;
  from: string;
  to: string;
  toName: string;
}> {
  const node = await getNode(input.instanceId);
  if (!node || node.removed) {
    throw new Error(`Instance not found: ${input.instanceId}. Resolve it with find_node first.`);
  }
  if (node.type !== "INSTANCE") {
    throw new Error(`Node ${input.instanceId} is a ${node.type}, not an instance. Only instances have variants.`);
  }

  const instance = node as InstanceNode;
  let main: ComponentNode | null = null;
  try {
    main = await instance.getMainComponentAsync();
  } catch {
    main = null;
  }
  if (!main) {
    throw new Error(`Could not read the main component of ${input.instanceId}. It may be remote or deleted.`);
  }

  const parent = main.parent;
  if (!parent || parent.type !== "COMPONENT_SET") {
    throw new Error(
      `"${main.name}" is a standalone component, not a variant set, so there is nothing to switch to. Promote the variants into a set first.`,
    );
  }

  const variants = [...(parent as unknown as { children: ComponentNode[] }).children];
  const want = input.variant.trim();
  const pairs = want
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split("=").map((s) => s.trim()))
    .filter((kv): kv is [string, string] => kv.length === 2 && kv[0]!.length > 0 && kv[1]!.length > 0);

  const match =
    variants.find((v) => v.name.trim() === want) ??
    (pairs.length > 0
      ? variants.find((v) => {
          const segments = v.name.split(",").map((s) => s.trim().toLowerCase());
          return pairs.every(([k, val]) => segments.includes(`${k.toLowerCase()}=${val.toLowerCase()}`));
        })
      : undefined);

  if (!match) {
    const names = variants.map((v) => `"${v.name}"`).join(", ");
    throw new Error(`No variant matches '${input.variant}'. Variants of "${parent.name}": ${names || "(none)"}.`);
  }

  const from = main.name;
  instance.swapComponent(match);

  return { instanceId: instance.id, from, to: match.id, toName: match.name };
}

/**
 * Validates that a modification target is a component master.
 *
 * The actual edit runs through the normal modify path; this exists so a master
 * edit is deliberate rather than an accident of addressing the wrong id. Nothing
 * here duplicates the transaction machinery.
 */
export async function assertComponentMaster(componentId: string): Promise<ComponentNode> {
  const node = await getNode(componentId);
  if (!node || node.removed) {
    throw new Error(`Component not found: ${componentId}. Call find_component to get a real component id.`);
  }
  if (node.type !== "COMPONENT" && node.type !== "COMPONENT_SET") {
    throw new Error(`Node ${componentId} is a ${node.type}, not a component master. Edits to instances belong on the master.`);
  }
  return node as ComponentNode;
}

/* -------------------------------------------------------------------------- */
/* Variant sets                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Combines components into a variant set, promoting frames first.
 *
 * Members may be COMPONENT ids or FRAME/GROUP ids. Frames are promoted with
 * `createComponentFromNode`, which keeps their geometry, because asking the
 * caller to promote-then-combine in two transactions would leave a half-built
 * file if the second failed. The set lands on the current page unless a parent
 * is given.
 */
export async function createComponentSet(input: {
  name: string;
  members: string[];
  parent?: string;
  description?: string;
}): Promise<{ componentSetId: string; name: string; variantIds: string[]; variantNames: string[] }> {
  if (input.members.length < 2) {
    throw new Error(`A variant set needs at least two members; got ${input.members.length}.`);
  }

  const components: ComponentNode[] = [];
  for (const ref of input.members) {
    const node = await getNode(ref);
    if (!node || node.removed) {
      throw new Error(`Member not found: ${ref}. Resolve members with find_node or find_component first.`);
    }
    if (node.type === "COMPONENT") {
      components.push(node as ComponentNode);
    } else if (node.type === "FRAME" || node.type === "GROUP") {
      components.push(figma.createComponentFromNode(node as SceneNode));
    } else {
      throw new Error(`Member ${ref} is a ${node.type}: only components, frames and groups can join a variant set.`);
    }
  }

  let parent: ParentNode = figma.currentPage;
  if (input.parent) {
    const p = await getNode(input.parent);
    if (!p || p.removed) throw new Error(`Parent not found: ${input.parent}.`);
    if (!("appendChild" in p)) throw new Error(`A ${p.type} cannot contain a component set.`);
    parent = p as unknown as ParentNode;
  }

  const set = figma.combineAsVariants(components, parent);
  set.name = input.name;
  if (input.description) set.description = input.description;

  return {
    componentSetId: set.id,
    name: set.name,
    variantIds: components.map((c) => c.id),
    variantNames: components.map((c) => c.name),
  };
}

type ParentNode = ChildrenMixin & BaseNode;