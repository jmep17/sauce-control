import fs from "node:fs";
import type { BrowserContext, Page } from "playwright";
import {
  AUTH_PLUMBING_PATTERN,
  crawl,
  routeShape,
  type PageDriver,
} from "./crawler.js";
import { exploreStep, type ExplorePage } from "./explorer.js";
import {
  createLocalLlmPolicy,
  type Candidate,
  type LlmPolicy,
} from "../llm/policy.js";
import { enumerateStaticRoutes } from "../detect/routes.js";
import { sessionPaths, type SessionMeta } from "../session/store.js";
import type { HarStore } from "../proxy/har-store.js";
import { log } from "../util/log.js";

/**
 * Playwright glue for auto-explore. Everything here is thin adapter code over
 * the pure engines (crawler.ts, explorer.ts); in-page scripts are strings
 * because this repo compiles without DOM typings.
 */

export interface AutoOptions {
  mode: "crawl" | "ai";
  llmUrl?: string;
  llmModel?: string;
  allowMutations?: boolean;
  maxPages?: number;
  shouldStop?: () => boolean;
  /**
   * Wait for Enter in the terminal before exploring (default when stdin is a
   * TTY). Guessing "the user is done logging in" from page quiescence starts
   * the crawl mid-login and fights the user for the browser.
   */
  confirmStart?: boolean;
}

/**
 * Capture client-side navigations (router.push → history.pushState) that
 * never render as <a href>. Must be installed on the context before the
 * first page is created.
 */
export async function installNavCapture(
  context: BrowserContext
): Promise<string[]> {
  const buffer: string[] = [];
  await context.exposeFunction("__sauceNavCapture", (url: string) => {
    buffer.push(url);
  });
  await context.addInitScript(`(() => {
    const emit = (u) => {
      try { window.__sauceNavCapture(new URL(u, location.href).href); } catch {}
    };
    for (const name of ["pushState", "replaceState"]) {
      const orig = history[name];
      history[name] = function (state, title, url) {
        if (url != null) emit(String(url));
        return orig.apply(this, arguments);
      };
    }
  })()`);
  return buffer;
}

/**
 * Wait until the user is done logging in: the page has to sit on the app
 * origin, settled, for a few consecutive seconds (the Auth0 redirect dance
 * bounces off-origin in between). Returns false if the browser went away.
 */
async function waitForLogin(
  page: Page,
  origin: string,
  timeoutMs = 300_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  while (Date.now() < deadline) {
    let onOrigin = false;
    try {
      onOrigin = page.url().startsWith(origin);
    } catch {
      return false; // page/browser closed
    }
    stable = onOrigin ? stable + 1 : 0;
    if (stable >= 6) return true; // ~3s continuously on-origin
    await new Promise((r) => setTimeout(r, 500));
  }
  log.warn("Timed out waiting for login; auto-exploring anyway.");
  return true;
}

/** Resolve on Enter in the terminal (or when shouldStop turns true). */
function waitForEnter(shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    let iv: NodeJS.Timeout;
    const done = () => {
      clearInterval(iv);
      process.stdin.off("data", done);
      process.stdin.pause();
      resolve();
    };
    iv = setInterval(() => {
      if (shouldStop()) done();
    }, 500);
    process.stdin.resume();
    process.stdin.once("data", done);
  });
}

/**
 * Dev-tool overlays (TanStack Router/Query devtools, Next.js dev overlay)
 * are not app UI: Router devtools renders the whole route tree — logout
 * included — as clickable rows that navigate with no href to inspect.
 * Anything inside these containers is invisible to the crawler and the AI.
 */
const DEVTOOLS_EXCLUDE = [
  '[class*="TanStack"]',
  '[id*="TanStack"]',
  '[class*="tsqd"]', // TanStack Query devtools
  '[id*="tsqd"]',
  '[class*="tsrd"]', // TanStack Router devtools
  '[class*="devtools" i]',
  '[id*="devtools" i]',
  "tanstack-devtools",
  "nextjs-portal",
].join(",");

async function settle(page: Page): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: 7_000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 250));
}

function makeDriver(
  page: Page,
  navBuffer: string[],
  origin: string
): PageDriver {
  return {
    async visit(url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await settle(page);
      const landed = page.url();
      if (!landed.startsWith(origin)) {
        throw new Error(`redirected off-origin to ${landed} (logged out?)`);
      }
      const requested = new URL(url).pathname;
      const got = new URL(landed).pathname;
      if (got !== requested && AUTH_PLUMBING_PATTERN.test(got)) {
        throw new Error(`bounced to ${got} (session logged out?)`);
      }
    },
    async collectLinks() {
      const hrefs = (await page
        .evaluate(
          `Array.from(document.querySelectorAll("a[href]"))
            .filter((a) => !a.closest(${JSON.stringify(DEVTOOLS_EXCLUDE)}))
            .map((a) => a.href)`
        )
        .catch(() => [])) as string[];
      return [...hrefs, ...navBuffer.splice(0)];
    },
  };
}

/**
 * Tag interactive elements with data-sauce-id and describe them. Runs in the
 * page; capped at 40 candidates to keep local-LLM prompts small.
 */
const CANDIDATES_SCRIPT = `(() => {
  const cands = [];
  let id = 0;
  const label = (el) =>
    (el.getAttribute("aria-label") || el.innerText || el.value ||
     el.placeholder || el.title || "").trim().replace(/\\s+/g, " ").slice(0, 120);
  const push = (el, kind, extra) => {
    el.setAttribute("data-sauce-id", String(id));
    cands.push(Object.assign({ id, kind, text: label(el) }, extra));
    id++;
  };
  const formMethod = (el) =>
    el.form && el.form.method ? { formMethod: el.form.method } : {};
  const els = document.querySelectorAll(
    "button, [role=button], [role=tab], input, select, a:not([href])"
  );
  for (const el of els) {
    if (cands.length >= 40) break;
    if (el.disabled || el.closest("[hidden]")) continue;
    if (el.closest(${JSON.stringify(DEVTOOLS_EXCLUDE)})) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "submit") { push(el, "button", formMethod(el)); continue; }
      if (["hidden", "password", "file", "checkbox", "radio", "button"].includes(t)) continue;
      push(el, "input", Object.assign({ inputType: t }, formMethod(el)));
    } else if (tag === "select") {
      push(el, "select", formMethod(el));
    } else if (el.getAttribute("role") === "tab") {
      push(el, "tab", {});
    } else {
      push(el, "button", formMethod(el));
    }
  }
  return cands;
})()`;

function makeExplorePage(page: Page): ExplorePage {
  const sel = (id: number) => `[data-sauce-id="${id}"]`;
  return {
    url: () => page.url(),
    title: () => page.title(),
    candidates: async () =>
      (await page.evaluate(CANDIDATES_SCRIPT)) as Candidate[],
    async click(id) {
      await page.click(sel(id), { timeout: 3_000 });
      await settle(page);
    },
    async fill(id, value) {
      await page.fill(sel(id), value, { timeout: 3_000 });
    },
    async pressEnter(id) {
      await page.press(sel(id), "Enter", { timeout: 3_000 });
      await settle(page);
    },
    async returnTo(url) {
      await page
        .goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 })
        .catch(() => {});
      await settle(page);
    },
  };
}

/** Hosts the crawler must never navigate to (the real Auth0 tenant). */
function auth0Hosts(session: SessionMeta): string[] {
  const hosts: string[] = [];
  for (const v of session.envVars) {
    if (v.role !== "auth0-domain" && v.role !== "auth0-issuer") continue;
    const raw = v.originalValue;
    if (!raw) continue;
    try {
      hosts.push(new URL(raw.includes("://") ? raw : `https://${raw}`).host);
    } catch {
      /* unparseable value; nothing to avoid */
    }
  }
  return hosts;
}

export async function runAuto(args: {
  page: Page;
  session: SessionMeta;
  store: HarStore;
  navBuffer: string[];
  opts: AutoOptions;
}): Promise<void> {
  const { page, session, store, navBuffer, opts } = args;
  const origin = `http://localhost:${session.appPort}`;
  const shouldStop = opts.shouldStop ?? (() => false);

  const gateOnEnter = opts.confirmStart ?? process.stdin.isTTY === true;
  if (gateOnEnter) {
    log.step(
      "Log in in the browser if needed, then press Enter here to start auto-exploring."
    );
    await waitForEnter(shouldStop);
  } else {
    log.step(
      "Auto-explore armed — log in if prompted; crawling starts once the app settles."
    );
    if (!(await waitForLogin(page, origin))) return;
  }
  if (shouldStop()) return;
  // Drop navigations captured during login — the OAuth callback URL is in
  // here, and revisiting a consumed authorization code kills the session.
  navBuffer.length = 0;

  const { routes, dynamic } = enumerateStaticRoutes(session.worktree);
  if (routes.length > 0) {
    log.info(
      `Seeding ${routes.length} static routes` +
        (dynamic.length > 0
          ? ` (${dynamic.length} dynamic patterns will be found via links)`
          : "")
    );
  }

  let policy: LlmPolicy | null = null;
  if (opts.mode === "ai") {
    try {
      policy = await createLocalLlmPolicy({
        ...(opts.llmUrl !== undefined ? { baseUrl: opts.llmUrl } : {}),
        ...(opts.llmModel !== undefined ? { model: opts.llmModel } : {}),
      });
      log.info(`AI explorer using local model: ${policy.model}`);
    } catch (err) {
      log.warn(
        `AI explorer unavailable (${(err as Error).message}); crawling without it.`
      );
    }
  }

  const { decisions } = sessionPaths(session.id);
  const explorePage = makeExplorePage(page);
  let policyFailures = 0;

  // One AI pass per route shape: /orders?q=a and /orders?q=b present the
  // same UI, and re-exploring it just re-runs the same actions.
  const exploredShapes = new Set<string>();

  const onPage = async (url: string): Promise<string[] | void> => {
    if (!policy || policyFailures >= 3) return;
    const shape = routeShape(url);
    if (exploredShapes.has(shape)) return;
    exploredShapes.add(shape);
    let failed = false;
    const res = await exploreStep(explorePage, {
      policy,
      allowMutations: opts.allowMutations ?? false,
      coverage: () => ({ requests: store.size, endpoints: store.endpoints() }),
      logDecision: (record) =>
        fs.appendFileSync(decisions, JSON.stringify(record) + "\n"),
      narrate: (msg) => log.dim(`    ${msg}`),
      warn: (msg) => {
        failed = true;
        log.warn(msg);
      },
    });
    policyFailures = failed ? policyFailures + 1 : 0;
    if (policyFailures === 3) {
      log.warn(
        "AI explorer disabled after repeated failures; crawl continues."
      );
    }
    void url;
    return res.discovered;
  };

  const result = await crawl(makeDriver(page, navBuffer, origin), {
    origin,
    seeds: [origin, ...routes.map((r) => origin + r)],
    avoidHosts: auth0Hosts(session),
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
    ...(policy ? { onPage } : {}),
    shouldStop,
    log: (msg) => log.dim(`  ${msg}`),
  });

  const skipNote =
    result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : "";
  log.success(
    `Auto-explore done: ${result.visited.length} pages visited${skipNote}, ` +
      `${store.size} requests captured across ${store.endpoints().length} endpoints.`
  );
  if (result.outOfBudget) {
    log.warn(
      "Stopped at the time budget; rerun with --max-pages to go deeper."
    );
  }
  if (result.abortedReason) {
    log.warn(`Auto-explore aborted: ${result.abortedReason}`);
  }
  if (policy) {
    log.info(
      `AI decision log: ${sessionPaths(session.id).decisions} (one JSON line per page: what it saw, chose, and what was blocked)`
    );
  }
}
