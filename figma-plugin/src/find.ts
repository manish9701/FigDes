/**
 * Semantic node targeting (spec §3).
 *
 * ## Why this exists
 *
 * Raw Figma ids (`"1847:2931"`) are the least meaningful possible way to address
 * a node. They are unmemorable, they change meaning when the file is edited, and
 * every operation that takes one is a chance to modify the wrong subtree. The
 * model should be able to say what it wants — "the primary action on V4 Home",
 * "the text that says Qwen2.5" — and have the tool resolve it to an id, or say
 * clearly that it cannot.
 *
 * ## How roles resolve
 *
 * A role is a documented heuristic, not magic. Each role is a small predicate
 * over things the plugin can actually see: layer names, node types, text
 * content, sizes and structure. The result always carries its `reason`, so a
 * match the model did not expect is inspectable rather than silently acted on.
 * When nothing matches, the result is empty with the roles that were tried —
 * never a guess.
 */
import { allPages } from "./cache";

export interface FindNodeOptions {
  /** Screen name: a page name or a top-level frame name. Narrows the search. */
  screen?: string;
  /** Semantic role. See ROLES below. */
  role?: string;
  /** Substring match against layer names. */
  name?: string;
  /** Substring match against text content. */
  text?: string;
  /** Maximum matches. */
  limit?: number;
  /** Maximum nodes walked. */
  maxNodes?: number;
}

export interface NodeMatch {
  id: string;
  type: string;
  name: string;
  score: number;
  reason: string;
  path: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface FindNodeResult {
  truncated: boolean;
  total: number;
  matches: NodeMatch[];
  /** Echoes what was asked, so a surprising result can be diagnosed. */
  searched: { screen?: string; role?: string; name?: string; text?: string };
}

export const DEFAULT_FIND_NODE: Required<Omit<FindNodeOptions, "screen" | "role" | "name" | "text">> = {
  limit: 10,
  maxNodes: 4000,
};

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

interface Ctx {
  name: string;
  lower: string;
  type: string;
  texts: string[];
  childTypes: string[];
  width: number;
  height: number;
  fontSize: number | null;
}

type Predicate = (ctx: Ctx) => { score: number; reason: string } | null;

/**
 * The role table. Each entry is tried in order and the first hit wins the
 * role's base score; name and text matches add on top.
 *
 * Scores are deliberately coarse (0.5 / 0.8 / 1.0). False precision here would
 * imply the tool knows more than a name match plus a type check, and it does not.
 */
const ROLES: Record<string, { description: string; match: Predicate }> = {
  primaryAction: {
    description: "The main commit button: a button, CTA or primary-labelled control.",
    match: (ctx) => {
      if (ctx.type === "INSTANCE" || ctx.type === "COMPONENT") {
        if (/button|primary|cta|action|deploy|continue|confirm|submit/.test(ctx.lower)) {
          return { score: 1.0, reason: `role primaryAction: ${ctx.type.toLowerCase()} named "${ctx.name}"` };
        }
      }
      if (/^(deploy|continue|confirm|submit|primary|cta|get started|primary action)$/.test(ctx.lower)) {
        return { score: 0.8, reason: `role primaryAction: layer named "${ctx.name}"` };
      }
      return null;
    },
  },
  activeNavigation: {
    description: "The currently selected navigation item.",
    match: (ctx) => {
      if (/nav/.test(ctx.lower) && /active|selected|current|on\b/.test(ctx.lower)) {
        return { score: 1.0, reason: `role activeNavigation: "${ctx.name}"` };
      }
      return null;
    },
  },
  navigation: {
    description: "Any navigation item or rail.",
    match: (ctx) => {
      if (/nav|sidebar|rail|menu item|tab /.test(ctx.lower)) {
        return { score: 0.8, reason: `role navigation: "${ctx.name}"` };
      }
      return null;
    },
  },
  heroTitle: {
    description: "The largest text on screen: the headline.",
    match: (ctx) => {
      if (ctx.type === "TEXT" && ctx.fontSize !== null && ctx.fontSize >= 24) {
        return { score: 0.8, reason: `role heroTitle: ${ctx.fontSize}px text "${ctx.name}"` };
      }
      return null;
    },
  },
  topologyMap: {
    description: "A frame holding a node-link diagram: several ellipses/vectors, or a map-named frame.",
    match: (ctx) => {
      if (/topolog|network map|\bmap\b/.test(ctx.lower)) {
        return { score: 0.9, reason: `role topologyMap: "${ctx.name}"` };
      }
      const markers = ctx.childTypes.filter((t) => t === "ELLIPSE" || t === "VECTOR").length;
      if ((ctx.type === "FRAME" || ctx.type === "COMPONENT") && markers >= 3) {
        return { score: 0.8, reason: `role topologyMap: ${markers} node-like children in "${ctx.name}"` };
      }
      return null;
    },
  },
  statusBadge: {
    description: "A status pill or badge.",
    match: (ctx) => {
      if (/status|pill|badge|health|state\b/.test(ctx.lower)) {
        return { score: 0.8, reason: `role statusBadge: "${ctx.name}"` };
      }
      return null;
    },
  },
  searchField: {
    description: "A search or filter input.",
    match: (ctx) => {
      if (/search|filter|query/.test(ctx.lower)) {
        return { score: 0.8, reason: `role searchField: "${ctx.name}"` };
      }
      return null;
    },
  },
};

export const ROLE_NAMES = Object.keys(ROLES);

/* -------------------------------------------------------------------------- */

export async function findNode(raw: FindNodeOptions): Promise<FindNodeResult> {
  await allPages();

  const limit = Math.max(1, Math.min(50, raw.limit ?? DEFAULT_FIND_NODE.limit));
  const maxNodes = Math.max(100, Math.min(20000, raw.maxNodes ?? DEFAULT_FIND_NODE.maxNodes));

  const role = typeof raw.role === "string" && ROLES[raw.role] ? raw.role : undefined;
  if (raw.role !== undefined && !role) {
    throw new Error(
      `Unknown role '${raw.role}'. Known roles: ${ROLE_NAMES.join(", ")}. Describe the node by name or text instead.`,
    );
  }

  const nameQuery = typeof raw.name === "string" && raw.name ? raw.name.toLowerCase() : undefined;
  const textQuery = typeof raw.text === "string" && raw.text ? raw.text.toLowerCase() : undefined;
  const screenQuery = typeof raw.screen === "string" && raw.screen ? raw.screen.toLowerCase() : undefined;

  if (!role && !nameQuery && !textQuery) {
    throw new Error("find_node needs at least one of role, name or text. An empty query would match the whole file.");
  }

  // A screen narrows the walk to one page or top-level frame. Resolved first so
  // a miss reports the screen rather than an empty file-wide search.
  let roots: BaseNode[] = [...figma.root.children];
  if (screenQuery) {
    const pages = figma.root.children.filter((p) => p.name.toLowerCase().includes(screenQuery));
    if (pages.length === 0) {
      const names = figma.root.children.map((p) => `"${p.name}"`).join(", ");
      throw new Error(`No page or screen matches '${raw.screen}'. Pages: ${names || "(none)"}.`);
    }
    roots = pages;
  }

  const matches: NodeMatch[] = [];
  let scanned = 0;
  let truncated = false;

  /**
   * Walks the tree bottom-up: each call returns the text content of its whole
   * subtree, so a container matches a text query when any descendant holds it.
   * That is what makes find_text("Qwen2.5") return both the text layer and the
   * card around it, with the layer scoring higher.
   */
  const walk = (node: BaseNode, path: string[]): string[] => {
    if (scanned >= maxNodes) {
      truncated = true;
      return [];
    }
    scanned += 1;

    const name = node.name ?? "";
    const lower = name.toLowerCase();
    const type = node.type;
    const kids: BaseNode[] = "children" in node && node.children ? [...(node.children as BaseNode[])] : [];

    const ownText = node.type === "TEXT" ? String((node as TextNode).characters ?? "") : "";
    const childTexts = kids.flatMap((child) => walk(child, [...path, name]));
    const texts = ownText ? [ownText, ...childTexts] : childTexts;

    const ctx: Ctx = {
      name,
      lower,
      type,
      texts,
      childTypes: kids.map((c) => c.type),
      width: "width" in node && typeof node.width === "number" ? node.width : 0,
      height: "height" in node && typeof node.height === "number" ? node.height : 0,
      fontSize: node.type === "TEXT" && typeof (node as TextNode).fontSize === "number" ? ((node as TextNode).fontSize as number) : null,
    };

    let score = 0;
    const reasons: string[] = [];

    if (role) {
      const hit = ROLES[role]!.match(ctx);
      if (hit) {
        score += hit.score;
        reasons.push(hit.reason);
      }
    }

    if (nameQuery) {
      if (lower === nameQuery) {
        score += 1.0;
        reasons.push(`name is exactly "${raw.name}"`);
      } else if (lower.includes(nameQuery)) {
        score += 0.6;
        reasons.push(`name contains "${raw.name}"`);
      }
    }

    if (textQuery) {
      // The node's own text scores highest; a container holding the text
      // scores lower but is still the answer when the caller wants the card.
      if (ownText.toLowerCase().includes(textQuery)) {
        score += 1.0;
        reasons.push(`text is "${raw.text}"`);
      } else if (texts.some((t) => t.toLowerCase().includes(textQuery))) {
        score += 0.5;
        reasons.push(`contains text "${raw.text}"`);
      }
    }

    if (score > 0) {
      const scene = node as SceneNode;
      matches.push({
        id: node.id,
        type,
        name,
        score: Math.round(score * 100) / 100,
        reason: reasons.join("; "),
        path,
        ...("x" in scene && typeof scene.x === "number" ? { x: Math.round(scene.x), y: Math.round((scene as SceneNode).y) } : {}),
        ...("width" in scene && typeof scene.width === "number" ? { width: Math.round(scene.width), height: Math.round((scene as SceneNode).height) } : {}),
      });
    }

    return texts;
  };

  for (const root of roots) walk(root, []);

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return {
    truncated,
    total: matches.length,
    matches: matches.slice(0, limit),
    searched: {
      ...(raw.screen !== undefined ? { screen: raw.screen } : {}),
      ...(raw.role !== undefined ? { role: raw.role } : {}),
      ...(raw.name !== undefined ? { name: raw.name } : {}),
      ...(raw.text !== undefined ? { text: raw.text } : {}),
    },
  };
}