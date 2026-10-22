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
 *
 * The vocabulary covers whole screens' worth of surfaces: actions (primary and
 * secondary), inputs, structural containers, data cells, and the five states
 * (empty, error, success, loading, plus the badges that carry state). Two
 * discipline rules keep it honest: every predicate is confident-or-silent — a
 * weak hint returns no match rather than a lucky one — and a restored weak
 * signal (typography above/below a size band, a circle in a small square)
 * scores 0.5 and says in its reason exactly which evidence it used.
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
  secondaryAction: {
    description: "A subordinate commit: cancel, back, skip, dismiss or reset.",
    match: (ctx) => {
      if (/secondary|cancel|later|skip\b|dismiss|reset|\bback\b|secondary action/.test(ctx.lower)) {
        return {
          score: 0.8,
          reason: ctx.type === "INSTANCE" || ctx.type === "COMPONENT"
            ? `role secondaryAction: ${ctx.type.toLowerCase()} named "${ctx.name}"`
            : `role secondaryAction: layer named "${ctx.name}"`,
        };
      }
      return null;
    },
  },
  textInput: {
    description: "A text entry field: input, field, placeholder-carrying box, email/password.",
    match: (ctx) => {
      if (/input|text ?field|\bfield\b|placeholder|email|password|username|\bphone\b/.test(ctx.lower)) {
        return { score: 0.8, reason: `role textInput: "${ctx.name}"` };
      }
      return null;
    },
  },
  toggle: {
    description: "An on/off control: toggle, switch, checkbox or radio.",
    match: (ctx) => {
      if (/toggle|switch|check ?box|radio/.test(ctx.lower)) {
        return { score: 0.8, reason: `role toggle: "${ctx.name}"` };
      }
      return null;
    },
  },
  dropdownSelector: {
    description: "A choose-one control: dropdown, select, picker or combobox.",
    match: (ctx) => {
      if (/dropdown|\bpicker\b|combobox|combo box|\bselect\b|select field/.test(ctx.lower)) {
        return { score: 0.8, reason: `role dropdownSelector: "${ctx.name}"` };
      }
      return null;
    },
  },
  sectionHeading: {
    description: "A sub-headline: between body copy and the page title, or named heading/subtitle.",
    match: (ctx) => {
      if (/heading|section title|section header|subtitle|sub-?header/.test(ctx.lower)) {
        return { score: 0.9, reason: `role sectionHeading: "${ctx.name}"` };
      }
      // Top of the sub-headline band (below heroTitle's 24px floor): small
      // enough to be honest as a guess, so the score says so.
      if (ctx.type === "TEXT" && ctx.fontSize !== null && ctx.fontSize >= 20 && ctx.fontSize < 24) {
        return { score: 0.5, reason: `role sectionHeading: ${ctx.fontSize}px text "${ctx.name}"` };
      }
      return null;
    },
  },
  metaLabel: {
    description: "A caption or meta label: small supporting text such as timestamps or field labels.",
    match: (ctx) => {
      if (/caption|\blabel\b|meta\b|timestamp|annotation|small print/.test(ctx.lower)) {
        return { score: 0.9, reason: `role metaLabel: "${ctx.name}"` };
      }
      if (ctx.type === "TEXT" && ctx.fontSize !== null && ctx.fontSize >= 8 && ctx.fontSize <= 11) {
        return { score: 0.5, reason: `role metaLabel: ${ctx.fontSize}px text "${ctx.name}"` };
      }
      return null;
    },
  },
  dataRow: {
    description: "One row of structured data: row, list item, entry or record.",
    match: (ctx) => {
      if (/\brow\b|list item|entry\b|\brecord\b|line item|table row/.test(ctx.lower)) {
        return { score: 0.8, reason: `role dataRow: "${ctx.name}"` };
      }
      return null;
    },
  },
  metric: {
    description: "A statistic on screen: metric, stat, KPI, usage figure or a large bare number.",
    match: (ctx) => {
      if (/metric|\bstat\b|\bkpi\b|usage|throughput|count\b|percentage|uptime/.test(ctx.lower)) {
        return { score: 0.8, reason: `role metric: "${ctx.name}"` };
      }
      // A text holding nothing but a formatted number is the classic stat
      // figure; still a size-independent visual guess, so it scores lower.
      if (ctx.type === "TEXT" && ctx.fontSize !== null && ctx.fontSize >= 16) {
        const own = ctx.texts.filter((t) => /^\s*[-+]?[\d.,]+\s*[%MBKGT]?\b/i.test(t));
        if (own.length > 0) {
          return { score: 0.5, reason: `role metric: ${ctx.fontSize}px numeric text "${own[0]}"` };
        }
      }
      return null;
    },
  },
  avatar: {
    description: "A portrait or profile image: avatar, thumbnail or user photo.",
    match: (ctx) => {
      if (/avatar|thumbnail|portrait|profile ?(image|photo|pic)?|user image|\bpfp\b/.test(ctx.lower)) {
        return { score: 0.8, reason: `role avatar: "${ctx.name}"` };
      }
      // A small square container with an ellipse is the usual avatar shape;
      // a guess, scored like one.
      if (
        (ctx.type === "FRAME" || ctx.type === "INSTANCE") &&
        ctx.width > 0 &&
        ctx.width === ctx.height &&
        ctx.width >= 16 &&
        ctx.width <= 64 &&
        ctx.childTypes.includes("ELLIPSE")
      ) {
        return { score: 0.5, reason: `role avatar: ${ctx.width}px circle-containing square "${ctx.name}"` };
      }
      return null;
    },
  },
  iconButton: {
    description: "A button that carries only an icon, not a label.",
    match: (ctx) => {
      if (/icon ?[- ]?button|button ?[- ]?icon|\bicon action\b/.test(ctx.lower)) {
        return { score: 0.9, reason: `role iconButton: "${ctx.name}"` };
      }
      // A small instance named after an icon is very likely an icon-only
      // button on this product's surfaces; without the size check a decorative
      // 96px hero icon would match, so it must not.
      if (
        (ctx.type === "INSTANCE" || ctx.type === "COMPONENT") &&
        /\bicon\b|\bglyph\b|\bcross\b|\bclose\b|\bcog\b|\bgear\b|\bplus\b|\bminus\b/.test(ctx.lower) &&
        ctx.width > 0 &&
        ctx.width <= 48 &&
        ctx.height <= 48
      ) {
        return { score: 0.6, reason: `role iconButton: ${ctx.width}x${ctx.height} ${ctx.type.toLowerCase()} "${ctx.name}"` };
      }
      return null;
    },
  },
  emptyState: {
    description: "The no-content presentation: empty state, no results, nothing here.",
    match: (ctx) => {
      if (/empty|(no|zero) (results?|data|items?|devices?|models?|history)|nothing here|\bdraft\b|blank state/.test(ctx.lower)) {
        return { score: 0.9, reason: `role emptyState: "${ctx.name}"` };
      }
      return null;
    },
  },
  errorState: {
    description: "The error presentation: error, failed, critical, danger or alert.",
    match: (ctx) => {
      if (/error|failed|failure|critical|danger|alert|crash|unreachable|degraded/.test(ctx.lower)) {
        return { score: 0.8, reason: `role errorState: "${ctx.name}"` };
      }
      return null;
    },
  },
  successState: {
    description: "The success presentation: success, completed, healthy, passed.",
    match: (ctx) => {
      if (/success|succeeded|completed|passed|healthy|all good|done\b/.test(ctx.lower)) {
        return { score: 0.8, reason: `role successState: "${ctx.name}"` };
      }
      return null;
    },
  },
  loadingIndicator: {
    description: "The in-flight presentation: loading, spinner, skeleton or shimmer.",
    match: (ctx) => {
      if (/loading|spinner|skeleton|shimmer|in progress|fetching|working/.test(ctx.lower)) {
        return { score: 0.8, reason: `role loadingIndicator: "${ctx.name}"` };
      }
      return null;
    },
  },
  tableHeader: {
    description: "A header row or heading cells of a tabular list.",
    match: (ctx) => {
      if (/table header|column header|header row|thead|columns?/.test(ctx.lower)) {
        return { score: 0.9, reason: `role tableHeader: "${ctx.name}"` };
      }
      return null;
    },
  },
  chipTag: {
    description: "A chip or tag: small labelled pill for a filter or attribute.",
    match: (ctx) => {
      if (/\bchip\b|\btag\b|\bpill\b|\bbadge filter\b|\bfilter chip\b/.test(ctx.lower)) {
        return { score: 0.8, reason: `role chipTag: "${ctx.name}"` };
      }
      return null;
    },
  },
  breadcrumb: {
    description: "A breadcrumb trail of ancestor locations.",
    match: (ctx) => {
      if (/breadcrumb|crumbs|location path|path nav/.test(ctx.lower)) {
        return { score: 0.9, reason: `role breadcrumb: "${ctx.name}"` };
      }
      return null;
    },
  },
  paginationControl: {
    description: "Paging controls: pagination, next/previous page arrows or a pager.",
    match: (ctx) => {
      if (/pagination|pager|next page|prev(ious)? page|page nav/.test(ctx.lower)) {
        return { score: 0.9, reason: `role paginationControl: "${ctx.name}"` };
      }
      return null;
    },
  },
  cardContainer: {
    description: "A card: the boxed container holding grouped content (panel, tile, card).",
    match: (ctx) => {
      if (/\bcard\b|\bpanel\b|\btile\b|\bgroup box\b|\bblock\b/.test(ctx.lower) && (ctx.type === "FRAME" || ctx.type === "COMPONENT" || ctx.type === "INSTANCE" || ctx.type === "GROUP")) {
        return { score: 0.8, reason: `role cardContainer: ${ctx.type.toLowerCase()} named "${ctx.name}"` };
      }
      return null;
    },
  },
  footerNavigation: {
    description: "The footer: bottom-of-screen links or a footer navigation bar.",
    match: (ctx) => {
      if (/footer|foot nav|\bcopyright\b|\blegal\b/.test(ctx.lower)) {
        return { score: 0.8, reason: `role footerNavigation: "${ctx.name}"` };
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

  /** Scores one node against the query. Shared by the deep walk and the shallow screen pass. */
  const scoreNode = (node: BaseNode, path: string[], texts: string[], kidCount: number): void => {
    const name = node.name ?? "";
    const lower = name.toLowerCase();
    const type = node.type;

    const ctx: Ctx = {
      name,
      lower,
      type,
      texts,
      childTypes: "children" in node && node.children ? (node.children as BaseNode[]).map((c) => c.type) : [],
      width: "width" in node && typeof node.width === "number" ? node.width : 0,
      height: "height" in node && typeof node.height === "number" ? node.height : 0,
      fontSize: node.type === "TEXT" && typeof (node as TextNode).fontSize === "number" ? ((node as TextNode).fontSize as number) : null,
    };
    void kidCount;

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
      const ownText = node.type === "TEXT" ? String((node as TextNode).characters ?? "") : "";
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
  };

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
    // Newest first within each parent: children append at the end, so
    // oldest-first order truncates exactly the nodes the agent just built.
    // Matches are score-sorted afterwards, so only truncation changes.
    const kids: BaseNode[] = "children" in node && node.children ? [...(node.children as BaseNode[])].reverse() : [];
    const ownText = node.type === "TEXT" ? String((node as TextNode).characters ?? "") : "";
    const childTexts = kids.flatMap((child) => walk(child, [...path, name]));
    const texts = ownText ? [ownText, ...childTexts] : childTexts;

    scoreNode(node, path, texts, kids.length);

    return texts;
  };

  // A screen named by the caller is matched *before* anything is walked deep.
  //
  // A frame's own name costs nothing to read, and a name query is usually
  // asking for a screen. Walking every subtree first spent the budget on
  // thousands of nodes and then reported "no match" for a frame that was on
  // the page all along - which reads as a missing screen rather than as an
  // exhausted budget, and is exactly how a scope resolution turns into a
  // wrong verdict.
  if (nameQuery) {
    for (const page of roots) {
      const frames = "children" in page ? (page.children as BaseNode[]) : [];
      for (const frame of frames) {
        if (scanned >= maxNodes) {
          truncated = true;
          break;
        }
        scanned += 1;
        const lower = (frame.name ?? "").toLowerCase();
        if (!lower.includes(nameQuery)) continue;
        const ownText = frame.type === "TEXT" ? String((frame as TextNode).characters ?? "") : "";
        scoreNode(frame, [(page.name ?? "")], ownText ? [ownText] : [], "children" in frame && frame.children ? frame.children.length : 0);
      }
    }
  }

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