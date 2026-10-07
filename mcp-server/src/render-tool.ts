/**
 * Image-carrying MCP tools.
 *
 * MCP supports an image content block alongside text, which is the difference
 * between screenshots being affordable and not. Handing the model a base64
 * string in a JSON field makes it ~33% larger *and* unreadable; as an image
 * block it is tiled, downscaled and tokenised properly.
 *
 * The context cost is still real, so this module also reports the bill next to
 * the picture rather than leaving the caller to guess.
 */
import type { Session } from "./sessions";
import type { RenderResult } from "../../shared/protocol";

export interface RenderArgs {
  sessionId?: string;
  /** Node id to render. */
  nodeId: string;
  /** Output width. Default 1024. Clamped to 2048. */
  maxWidth?: number;
  /** "low" halves token cost and is enough for layout and balance checks. */
  detail?: "low" | "high";
  format?: "png" | "jpg";
}

export interface RenderResponse {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
}

const MIME = { png: "image/png", jpg: "image/jpeg" } as const;

export async function renderDesign(session: Session, args: RenderArgs): Promise<RenderResponse> {
  const result = (await session.request("render_node", {
    nodeId: args.nodeId,
    maxWidth: args.maxWidth,
    detail: args.detail,
    format: args.format,
  })) as RenderResult;

  if (!result || typeof result.data !== "string" || result.data.length === 0) {
    return {
      isError: true,
      content: [{ type: "text", text: "The plugin returned no image data for that node." }],
    };
  }

  // The image block first: models weight the leading content most heavily, and
  // the accompanying text should read as commentary rather than as data.
  const content: RenderResponse["content"] = [
    { type: "image", data: result.data, mimeType: MIME[result.format as "png" | "jpg"] ?? "image/png" },
    { type: "text", text: describe(result) },
  ];

  // The panel shows what the agent just saw. Same bytes, no extra render cost:
  // the user watches the visual loop instead of discovering it afterwards.
  session.notify({
    type: "notify",
    kind: "preview",
    label: `"${result.nodeName}" (${result.nodeType}) at ${result.width}x${result.height}`,
    mimeType: MIME[result.format as "png" | "jpg"] ?? "image/png",
    data: result.data,
    at: Date.now(),
  });

  return { content };
}

/**
 * Metadata the model needs in order to reason about the image and manage its own
 * budget: what it is looking at, what was lost in downscaling, and what this
 * cost.
 */
function describe(r: RenderResult): string {
  const lines = [
    `Rendered "${r.nodeName}" (${r.nodeType}) at ${r.width}x${r.height}.`,
    `Native size: ${r.nativeWidth}x${r.nativeHeight}. Scale factor: ${r.scale}x.`,
    `Cost: ~${r.estimatedTokens.toLocaleString()} tokens (${r.detail} detail), ${formatBytes(r.base64Length)} base64.`,
    `Budget used: ${r.budget.tokensSpent.toLocaleString()} of ${r.budget.hardLimit.toLocaleString()} tokens.`,
  ];

  if (r.downscaled) {
    lines.push(
      `Note: this was downscaled from ${r.nativeWidth}px, so fine text detail is lost. ` +
        `Re-render with a higher maxWidth only if you need to read small type — it will cost proportionally more.`,
    );
  }

  if (r.budget.overSoftLimit) {
    lines.push(
      `Warning: the render budget is over its soft limit. Prefer review_design for structural checks, ` +
        `which cost almost nothing, and reserve renders for things only a picture can answer.`,
    );
  }

  lines.push(
    "Judge hierarchy, balance, density, alignment and whether the main relationship reads clearly. " +
      "Structural defects are better found with review_design, which is free.",
  );

  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}