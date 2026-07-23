/**
 * Deterministic auto-explore: BFS over same-origin URLs, seeded with
 * statically-enumerated routes and fed by links harvested from each rendered
 * page. Navigation-only — it never clicks buttons or submits forms; the AI
 * explorer (explorer.ts) layers that on per-page via `onPage`.
 */

/**
 * Link text / hrefs that must never be followed or clicked automatically.
 * `archive(?!d)`: "Archive" (the mutating verb) is unsafe; "Archived" is a
 * common filter/tab label and must stay clickable.
 */
export const UNSAFE_PATTERN =
  /log[\s_-]?out|sign[\s_-]?out|delete|remove|destroy|unsubscribe|deactivate|cancel[\s_-]?(account|subscription|plan)|revoke|archive(?!d)/i;

/** Canonical form for dedup: absolute, no hash, sorted query, no trailing slash. */
export function normalizeUrl(raw: string, base: string): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  u.hash = "";
  u.searchParams.sort();
  let s = u.href;
  if (u.pathname !== "/" && u.pathname.endsWith("/")) {
    s = s.replace(u.pathname, u.pathname.replace(/\/+$/, ""));
  }
  return s;
}

export interface SafetyVerdict {
  safe: boolean;
  reason?: string;
}

/** Is this URL safe for the crawler to visit on its own? */
export function checkUrl(
  url: string,
  origin: string,
  avoidHosts: string[] = []
): SafetyVerdict {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { safe: false, reason: "unparseable" };
  }
  if (u.origin !== origin) return { safe: false, reason: "off-origin" };
  if (avoidHosts.includes(u.host)) return { safe: false, reason: "auth host" };
  if (UNSAFE_PATTERN.test(u.pathname))
    return { safe: false, reason: "destructive-looking path" };
  return { safe: true };
}

/**
 * Collapse concrete IDs so /orders/123 and /orders/456 share a shape
 * (":id"), letting us cap visits per dynamic route instead of crawling
 * every row of every table.
 */
export function routeShape(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const segs = u.pathname
    .split("/")
    .map((s) =>
      /^\d+$/.test(s) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        s
      ) ||
      /^[A-Za-z0-9_-]{16,}$/.test(s)
        ? ":id"
        : s
    );
  return u.origin + segs.join("/");
}

/** Minimal surface the crawler needs from a browser page. */
export interface PageDriver {
  /** Navigate and wait for the page to settle. */
  visit(url: string): Promise<void>;
  /** Absolute hrefs currently in the DOM, plus any pushState-captured URLs. */
  collectLinks(): Promise<string[]>;
}

export interface CrawlOptions {
  /** App origin, e.g. "http://localhost:3000". */
  origin: string;
  seeds: string[];
  /** Hosts (e.g. the Auth0 tenant) never to navigate to. */
  avoidHosts?: string[];
  maxPages?: number;
  /** Max visits per dynamic-route shape (/orders/:id). */
  maxPerShape?: number;
  timeBudgetMs?: number;
  /**
   * Per-page hook (the AI explorer). Runs after link harvesting; any URLs it
   * returns are enqueued like discovered links.
   */
  onPage?: (url: string) => Promise<string[] | void>;
  /** Checked before each visit — lets the caller abort (e.g. user hit Ctrl-C). */
  shouldStop?: () => boolean;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface CrawlResult {
  visited: string[];
  skipped: { url: string; reason: string }[];
  outOfBudget: boolean;
}

export async function crawl(
  driver: PageDriver,
  opts: CrawlOptions
): Promise<CrawlResult> {
  const {
    origin,
    seeds,
    avoidHosts = [],
    maxPages = 50,
    maxPerShape = 3,
    timeBudgetMs = 180_000,
    onPage,
    shouldStop = () => false,
    log = () => {},
    now = Date.now,
  } = opts;

  const deadline = now() + timeBudgetMs;
  const queue: string[] = [];
  const enqueued = new Set<string>();
  const shapeCount = new Map<string, number>();
  const result: CrawlResult = { visited: [], skipped: [], outOfBudget: false };

  const enqueue = (raw: string) => {
    const url = normalizeUrl(raw, origin);
    if (!url || enqueued.has(url)) return;
    enqueued.add(url);
    const verdict = checkUrl(url, origin, avoidHosts);
    if (!verdict.safe) {
      // Off-origin links are everyday noise; only surface interesting skips.
      if (verdict.reason !== "off-origin")
        result.skipped.push({ url, reason: verdict.reason! });
      return;
    }
    queue.push(url);
  };

  for (const s of seeds) enqueue(s);

  while (queue.length > 0 && result.visited.length < maxPages) {
    if (shouldStop()) break;
    if (now() > deadline) {
      result.outOfBudget = true;
      break;
    }
    const url = queue.shift()!;
    const shape = routeShape(url);
    const seen = shapeCount.get(shape) ?? 0;
    if (seen >= maxPerShape) {
      result.skipped.push({ url, reason: "route shape cap" });
      continue;
    }
    shapeCount.set(shape, seen + 1);

    log(`visiting ${url}`);
    try {
      await driver.visit(url);
      result.visited.push(url);
      for (const link of await driver.collectLinks()) enqueue(link);
      if (onPage) {
        const extra = await onPage(url);
        for (const link of extra ?? []) enqueue(link);
      }
    } catch (err) {
      result.skipped.push({ url, reason: `error: ${(err as Error).message}` });
    }
  }
  return result;
}
