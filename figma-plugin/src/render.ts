/**
 * Render support (spec §8) — the agent's eyes.
 *
 * ## Why this exists
 *
 * Structural inspection tells the model what exists; it cannot tell the model
 * whether the result *looks* right. Every other tool in this system reads node
 * metadata, which is why the loop previously stopped at inspect → generate with
 * no feedback.
 *
 * ## The hard constraint
 *
 * Screenshots are expensive. A 1440×900 PNG is roughly 150–300 KB, which is
 * about 40,000–80,000 tokens once base64-encoded and tiled. Render a few of
 * those in a loop and the context window is gone.
 *
 * So this module is as much about *not* spending context as it is about
 * producing an image:
 *
 *   - downscaling by default, because tile count drives token cost
 *   - an explicit detail level, so the model can ask for cheap thumbnails
 *   - a byte estimate returned alongside the image, so the cost is never a surprise
 *   - a per-session budget with a hard stop, so a render loop cannot run away
 *
 * Nothing here executes anything; `exportAsync` is a Figma API call.
 */
import type { RenderResult, RenderRequest } from "../../shared/protocol";

/* -------------------------------------------------------------------------- */
/* Token estimation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * OpenAI tiles images at 512×512: ~170 tokens per tile at high detail, ~85 at
 * low. The estimate is deliberately reported so a caller can budget the loop
 * rather than discovering the cost after the fact.
 */
export function estimateTokens(width: number, height: number, detail: "low" | "high"): number {
  const tilesX = Math.max(1, Math.ceil(width / 512));
  const tilesY = Math.max(1, Math.ceil(height / 512));
  return tilesX * tilesY * (detail === "low" ? 85 : 170);
}

/** base64 inflates binary by 4/3. */
export function estimateBytes(width: number, height: number): number {
  // PNG of flat UI compresses hard; gradients and photographs do not. This is a
  // planning figure, not a measurement.
  return Math.round(width * height * 0.35);
}

export function base64Length(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/* -------------------------------------------------------------------------- */
/* Per-session budget                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A render budget is enforced per plugin session rather than globally, because
 * two files being reviewed should not starve each other, and because the plugin
 * has no notion of "a conversation".
 */
class RenderBudget {
  /** Soft ceiling: warn and suggest dropping detail, but still render. */
  private readonly softLimit: number;
  /** Hard ceiling: refuse rather than blow the window. */
  private readonly hardLimit: number;

  private spent = 0;

  constructor(softLimit = 120_000, hardLimit = 200_000) {
    this.softLimit = softLimit;
    this.hardLimit = hardLimit;
  }

  reset(): void {
    this.spent = 0;
  }

  get used(): number {
    return this.spent;
  }

  get remaining(): number {
    return Math.max(0, this.hardLimit - this.spent);
  }

  /** Reserves budget, or throws when there is not enough left. */
  reserve(estimate: number): void {
    if (this.spent + estimate > this.hardLimit) {
      throw new Error(
        `Render budget exhausted: ~${this.spent.toLocaleString()} tokens spent, ${this.hardLimit.toLocaleString()} allowed. ` +
          `Render at detail "low", reduce maxWidth, or call render_budget_reset before continuing.`,
      );
    }
    this.spent += estimate;
  }

  isOverSoftLimit(): boolean {
    return this.spent > this.softLimit;
  }

  status() {
    return {
      tokensSpent: this.spent,
      softLimit: this.softLimit,
      hardLimit: this.hardLimit,
      overSoftLimit: this.isOverSoftLimit(),
    };
  }
}

export const renderBudget = new RenderBudget();

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

export async function renderNode(request: RenderRequest): Promise<RenderResult> {
  const node = await figma.getNodeByIdAsync(request.nodeId).catch(() => null);
  if (!node || node.removed) {
    throw new Error(
      `Node not found: ${request.nodeId}. It may have been deleted, or it lives on a page that is not loaded.`,
    );
  }

  // A page or document has no geometry of its own to rasterise.
  if (node.type === "PAGE" || node.type === "DOCUMENT") {
    throw new Error("A page cannot be rendered directly. Render a frame inside it instead.");
  }

  const scene = node as SceneNode;
  if (!("exportAsync" in scene)) {
    // Every SceneNode supports exportAsync today; this guard exists so a future
    // node type that does not produces a message instead of a TypeError.
    throw new Error(`${node.type} does not support rendering. Render a frame, component or instance.`);
  }

  // Clamp rather than reject: a caller asking for 4000px gets the cap instead of
  // an error, because the intent (a bigger image) is still satisfiable in part.
  const MAX_DIMENSION = 2048;
  const requested = Math.max(64, Math.round(request.maxWidth ?? 1024));
  const targetWidth = Math.min(requested, MAX_DIMENSION);

  const scale = Math.min(request.scale ?? 1, 2);
  const estimatedWidth = Math.round(scene.width * scale);
  const estimatedHeight = Math.round(scene.height * scale);

  // Downscale when the node is wider than the cap, otherwise honour the request.
  const exportWidth = Math.min(targetWidth, Math.max(64, estimatedWidth));
  const exportHeight = Math.max(64, Math.round((exportWidth / Math.max(1, estimatedWidth)) * estimatedHeight));

  const detail = request.detail ?? "high";
  const tokenEstimate = estimateTokens(exportWidth, exportHeight, detail);

  // Reserve before spending the CPU time on the export.
  renderBudget.reserve(tokenEstimate);

  const format = request.format === "jpg" ? "JPG" : "PNG";
  const bytes = await scene.exportAsync({
    format,
    constraint: { type: "WIDTH", value: exportWidth },
  });

  const base64 = toBase64(bytes);
  const measured = Math.round((bytes.byteLength * 4) / 3);

  return {
    nodeId: scene.id,
    nodeName: scene.name,
    nodeType: scene.type,
    width: exportWidth,
    height: exportHeight,
    nativeWidth: Math.round(scene.width),
    nativeHeight: Math.round(scene.height),
    scale: Number((exportWidth / Math.max(1, scene.width)).toFixed(3)),
    format: format.toLowerCase(),
    detail,
    byteLength: bytes.byteLength,
    base64Length: measured,
    estimatedTokens: tokenEstimate,
    data: base64,
    budget: renderBudget.status(),
    /** True when the image is smaller than the node, i.e. the model cannot read every detail. */
    downscaled: exportWidth < Math.round(scene.width),
  };
}

/* -------------------------------------------------------------------------- */
/* Base64                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Chunked conversion.
 *
 * `String.fromCharCode(...bytes)` blows the argument limit and the call stack on
 * anything but a tiny image, which is exactly the case that matters here.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // btoa exists in the Figma plugin iframe; fall back to Buffer off-plugin so
  // this module is testable outside Figma.
  const encoder = (globalThis as { btoa?: (s: string) => string }).btoa;
  if (typeof encoder === "function") return encoder(binary);
  return Buffer.from(bytes).toString("base64");
}