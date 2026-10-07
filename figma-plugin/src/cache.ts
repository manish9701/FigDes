/**
 * Document caches (spec §35).
 *
 * `loadAllPagesAsync()` is the single biggest source of latency in this plugin:
 * it walks and materialises every page in the file, which is slow on large
 * documents and pointless to repeat. Page loading is a per-session concern, not
 * a per-call one, so it is cached for the life of the plugin run.
 *
 * Local variables and styles are also async document scans, but those *can*
 * change while the plugin is open, so they use a short TTL instead.
 */

const PAGE_CACHE_TTL_MS = 60_000;
const STYLE_CACHE_TTL_MS = 15_000;

interface Cache<T> {
  value: T | null;
  expiresAt: number;
  inflight: Promise<T> | null;
  invalidate: () => void;
}

function makeCache<T>(): Cache<T> {
  const cache: Cache<T> = {
    value: null,
    expiresAt: 0,
    inflight: null,
    invalidate: () => {
      cache.value = null;
      cache.expiresAt = 0;
    },
  };
  return cache;
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

const pages = makeCache<readonly PageNode[]>();
let pageLoadCount = 0;

export function pageLoadStats(): { loads: number; cached: boolean } {
  return { loads: pageLoadCount, cached: pages.value !== null };
}

/**
 * Every page, loaded once. Safe to call from anywhere; concurrent callers share
 * a single in-flight load rather than each triggering their own.
 *
 * `loadAllPagesAsync()` resolves to void — the pages are only reachable through
 * `figma.root.children` afterwards.
 */
export async function allPages(): Promise<readonly PageNode[]> {
  const now = Date.now();
  if (pages.value && now < pages.expiresAt) return pages.value;
  if (pages.inflight) return pages.inflight;

  pages.inflight = figma
    .loadAllPagesAsync()
    .then(() => {
      const loaded = figma.root.children;
      pageLoadCount += 1;
      pages.value = loaded;
      pages.expiresAt = Date.now() + PAGE_CACHE_TTL_MS;
      pages.inflight = null;
      return loaded;
    })
    .catch((err: unknown) => {
      pages.inflight = null;
      throw err;
    });

  return pages.inflight;
}

/**
 * Node lookup that self-heals.
 *
 * With `documentAccess: "dynamic-page"`, resolving an id on a page that has not
 * been loaded yet returns null rather than throwing. When that happens we make
 * sure pages are loaded and try exactly once more, which removes a whole class
 * of "node not found" reports that were really "page not loaded yet".
 */
export async function getNode(id: string): Promise<BaseNode | null> {
  const direct = await safeGetNode(id);
  if (direct) return direct;

  if (!pages.value) {
    await allPages();
    return safeGetNode(id);
  }
  return null;
}

async function safeGetNode(id: string): Promise<BaseNode | null> {
  try {
    return await figma.getNodeByIdAsync(id);
  } catch {
    return null;
  }
}

export function invalidateAll(): void {
  pages.invalidate();
  variables.invalidate();
  paintStyles.invalidate();
  textStyles.invalidate();
  effectStyles.invalidate();
}

/* -------------------------------------------------------------------------- */
/* Variables + styles (TTL cache)                                              */
/* -------------------------------------------------------------------------- */

const variables = makeCache<readonly Variable[]>();
const paintStyles = makeCache<readonly PaintStyle[]>();
const textStyles = makeCache<readonly TextStyle[]>();
const effectStyles = makeCache<readonly EffectStyle[]>();

async function ttl<T>(cache: Cache<T>, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (cache.value && now < cache.expiresAt) return cache.value;
  if (cache.inflight) return cache.inflight;

  cache.inflight = load()
    .then((v) => {
      cache.value = v;
      cache.expiresAt = Date.now() + STYLE_CACHE_TTL_MS;
      cache.inflight = null;
      return v;
    })
    .catch((err) => {
      cache.inflight = null;
      throw err;
    });

  return cache.inflight;
}

export const localVariables = (): Promise<readonly Variable[]> =>
  ttl(variables, () => figma.variables.getLocalVariablesAsync());

export const localPaintStyles = (): Promise<readonly PaintStyle[]> =>
  ttl(paintStyles, () => figma.getLocalPaintStylesAsync());

export const localTextStyles = (): Promise<readonly TextStyle[]> =>
  ttl(textStyles, () => figma.getLocalTextStylesAsync());

export const localEffectStyles = (): Promise<readonly EffectStyle[]> =>
  ttl(effectStyles, () => figma.getLocalEffectStylesAsync());

/* -------------------------------------------------------------------------- */
/* Scan budget                                                                 */
/* -------------------------------------------------------------------------- */

/** Call once at the start of an inspection so counters stay meaningful. */
export function beginScan(): void {
  pageLoadCount = 0;
}

export function scanStats(): { pageLoads: number; pagesCached: boolean } {
  return { pageLoads: pageLoadCount, pagesCached: pages.value !== null };
}