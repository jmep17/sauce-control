import { describe, expect, it } from "vitest";
import {
  checkUrl,
  crawl,
  normalizeUrl,
  routeShape,
  type PageDriver,
} from "../src/record/crawler.js";

const ORIGIN = "http://localhost:3000";

describe("normalizeUrl", () => {
  it("resolves relative URLs, drops hashes, sorts query params", () => {
    expect(normalizeUrl("/a?z=1&a=2#frag", ORIGIN)).toBe(`${ORIGIN}/a?a=2&z=1`);
  });
  it("strips trailing slashes except at the root", () => {
    expect(normalizeUrl(`${ORIGIN}/about/`, ORIGIN)).toBe(`${ORIGIN}/about`);
    expect(normalizeUrl(ORIGIN, ORIGIN)).toBe(`${ORIGIN}/`);
  });
  it("returns null for garbage", () => {
    expect(normalizeUrl("http://", ORIGIN)).toBeNull();
  });
});

describe("checkUrl", () => {
  it("rejects off-origin and auth hosts", () => {
    expect(checkUrl("https://evil.com/x", ORIGIN).safe).toBe(false);
    expect(
      checkUrl("http://tenant.auth0.com/authorize", ORIGIN, [
        "tenant.auth0.com",
      ]).safe
    ).toBe(false);
  });
  it("rejects destructive-looking paths and query strings", () => {
    for (const p of [
      "/logout",
      "/sign-out",
      "/logoff",
      "/items/3/delete",
      "/?action=logout",
      "/account?do=signout",
    ]) {
      expect(checkUrl(`${ORIGIN}${p}`, ORIGIN).safe).toBe(false);
    }
    expect(checkUrl(`${ORIGIN}/dashboard`, ORIGIN).safe).toBe(true);
    expect(checkUrl(`${ORIGIN}/orders/archived`, ORIGIN).safe).toBe(true);
  });
  it("rejects auth plumbing (replaying an OAuth callback kills the session)", () => {
    for (const p of [
      "/callback?code=abc&state=xyz",
      "/api/auth/callback/auth0",
      "/?code=abc&state=xyz",
      "/login",
      "/sign-in",
      "/signup",
      "/oauth/token",
      "/authorize",
    ]) {
      const v = checkUrl(`${ORIGIN}${p}`, ORIGIN);
      expect(v.safe, p).toBe(false);
      expect(v.reason, p).toBe("auth plumbing");
    }
    // Segment-bounded: these are ordinary app routes.
    for (const p of ["/plugin", "/calling", "/blog/authorized"]) {
      expect(checkUrl(`${ORIGIN}${p}`, ORIGIN).safe, p).toBe(true);
    }
  });
});

describe("routeShape", () => {
  it("collapses numeric, uuid, and token-like segments", () => {
    expect(routeShape(`${ORIGIN}/orders/123`)).toBe(`${ORIGIN}/orders/:id`);
    expect(
      routeShape(`${ORIGIN}/u/6f9619ff-8b86-4d01-b42d-00cf4fc964ff/edit`)
    ).toBe(`${ORIGIN}/u/:id/edit`);
    expect(routeShape(`${ORIGIN}/orders/history`)).toBe(
      `${ORIGIN}/orders/history`
    );
  });
});

/** Driver over a static link graph. */
function graphDriver(graph: Record<string, string[]>): {
  driver: PageDriver;
  visits: string[];
} {
  const visits: string[] = [];
  let current = "";
  return {
    visits,
    driver: {
      async visit(url) {
        current = url;
        visits.push(url);
      },
      async collectLinks() {
        return graph[current] ?? [];
      },
    },
  };
}

describe("crawl", () => {
  it("BFS-visits seeds and discovered same-origin links once each", async () => {
    const { driver, visits } = graphDriver({
      [`${ORIGIN}/`]: ["/a", "/b", "https://other.com/x", `${ORIGIN}/a#dup`],
      [`${ORIGIN}/a`]: ["/b", "/logout"],
    });
    const result = await crawl(driver, { origin: ORIGIN, seeds: [ORIGIN] });
    expect(visits).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`, `${ORIGIN}/b`]);
    expect(result.visited).toHaveLength(3);
    expect(result.skipped).toEqual([
      { url: `${ORIGIN}/logout`, reason: "destructive-looking URL" },
    ]);
  });

  it("caps visits per dynamic route shape", async () => {
    const { driver, visits } = graphDriver({
      [`${ORIGIN}/`]: ["/orders/1", "/orders/2", "/orders/3", "/orders/4"],
    });
    await crawl(driver, { origin: ORIGIN, seeds: [ORIGIN], maxPerShape: 2 });
    expect(visits.filter((v) => v.includes("/orders/"))).toHaveLength(2);
  });

  it("honors maxPages and shouldStop", async () => {
    const graph: Record<string, string[]> = {};
    for (let i = 0; i < 20; i++) graph[`${ORIGIN}/p${i}`] = [`/p${i + 1}`];
    const a = graphDriver(graph);
    await crawl(a.driver, {
      origin: ORIGIN,
      seeds: [`${ORIGIN}/p0`],
      maxPages: 5,
    });
    expect(a.visits).toHaveLength(5);

    const b = graphDriver(graph);
    let count = 0;
    await crawl(b.driver, {
      origin: ORIGIN,
      seeds: [`${ORIGIN}/p0`],
      shouldStop: () => ++count > 3,
    });
    expect(b.visits).toHaveLength(3);
  });

  it("stops on time budget and reports it", async () => {
    const { driver } = graphDriver({ [`${ORIGIN}/`]: ["/a"] });
    let t = 0;
    const result = await crawl(driver, {
      origin: ORIGIN,
      seeds: [ORIGIN],
      timeBudgetMs: 10,
      now: () => (t += 6), // 2nd iteration is past the deadline
    });
    expect(result.outOfBudget).toBe(true);
    expect(result.visited).toHaveLength(1);
  });

  it("feeds onPage-discovered URLs back into the queue", async () => {
    const { driver, visits } = graphDriver({ [`${ORIGIN}/`]: [] });
    await crawl(driver, {
      origin: ORIGIN,
      seeds: [ORIGIN],
      onPage: async (url) =>
        url === `${ORIGIN}/` ? [`${ORIGIN}/from-ai`] : [],
    });
    expect(visits).toContain(`${ORIGIN}/from-ai`);
  });

  it("aborts after repeated consecutive visit failures (dead session)", async () => {
    const seeds = Array.from({ length: 10 }, (_, i) => `${ORIGIN}/p${i}`);
    const dead: PageDriver = {
      visit: async () => {
        throw new Error("redirected off-origin (logged out?)");
      },
      collectLinks: async () => [],
    };
    const result = await crawl(dead, { origin: ORIGIN, seeds });
    expect(result.abortedReason).toContain("logged out");
    expect(result.skipped).toHaveLength(5); // stopped, not the full queue
  });

  it("a visit error skips the page but continues the crawl", async () => {
    const { driver, visits } = graphDriver({ [`${ORIGIN}/b`]: [] });
    const flaky: PageDriver = {
      visit: async (url) => {
        if (url.endsWith("/a")) throw new Error("boom");
        return driver.visit(url);
      },
      collectLinks: () => driver.collectLinks(),
    };
    const result = await crawl(flaky, {
      origin: ORIGIN,
      seeds: [`${ORIGIN}/a`, `${ORIGIN}/b`],
    });
    expect(visits).toEqual([`${ORIGIN}/b`]);
    expect(result.skipped[0]!.reason).toContain("boom");
  });
});
