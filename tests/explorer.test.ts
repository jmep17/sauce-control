import { describe, expect, it } from "vitest";
import { exploreStep, type ExplorePage } from "../src/record/explorer.js";
import type {
  Candidate,
  ExploreDecision,
  LlmPolicy,
} from "../src/llm/policy.js";

const URL0 = "http://localhost:3000/dashboard";

function fakePage(
  candidates: Candidate[],
  opts: { navigateOnClick?: Record<number, string> } = {}
) {
  const calls: string[] = [];
  let current = URL0;
  const page: ExplorePage = {
    url: () => current,
    title: async () => "Dashboard",
    candidates: async () => candidates,
    click: async (id) => {
      calls.push(`click:${id}`);
      const to = opts.navigateOnClick?.[id];
      if (to) current = to;
    },
    fill: async (id, value) => {
      calls.push(`fill:${id}:${value}`);
    },
    selectOption: async (id, label) => {
      calls.push(`select:${id}:${label}`);
    },
    pressEnter: async (id) => {
      calls.push(`enter:${id}`);
    },
    returnTo: async (url) => {
      calls.push(`return:${url}`);
      current = url;
    },
  };
  return { page, calls };
}

function policyOf(decision: ExploreDecision): LlmPolicy {
  return { model: "fake", decide: async () => decision };
}

const cand = (over: Partial<Candidate> & { id: number }): Candidate => ({
  kind: "button",
  text: "View details",
  ...over,
});

describe("exploreStep", () => {
  it("executes proposed clicks and fills, and logs the decision", async () => {
    const { page, calls } = fakePage([
      cand({ id: 0, kind: "tab", text: "Activity" }),
      cand({
        id: 1,
        kind: "input",
        text: "Search",
        inputType: "search",
        formMethod: "get",
      }),
    ]);
    const logged: object[] = [];
    const result = await exploreStep(page, {
      policy: policyOf({
        actions: [
          { id: 0, kind: "click" },
          { id: 1, kind: "fill_submit", value: "test" },
        ],
        avoid: [],
      }),
      coverage: () => ({ requests: 0, endpoints: [] }),
      logDecision: (r) => logged.push(r),
    });
    expect(calls).toEqual(["click:0", "fill:1:test", "enter:1"]);
    expect(result.executed.every((e) => e.outcome === "ok")).toBe(true);
    expect(logged).toHaveLength(1);
  });

  it("blocks unlabeled elements, avoid-listed ids, and log-off variants", async () => {
    const { page, calls } = fakePage([
      cand({ id: 0, text: "" }), // icon-only button — could be anything
      cand({ id: 1, text: "Log Off" }),
      cand({ id: 2, text: "Refresh" }),
      cand({ id: 3, kind: "tab", text: "Activity" }),
    ]);
    const result = await exploreStep(page, {
      policy: policyOf({
        actions: [
          { id: 0, kind: "click" },
          { id: 1, kind: "click" },
          { id: 2, kind: "click" },
          { id: 3, kind: "click" },
        ],
        // Model contradicts itself: proposes #2 while also avoiding it.
        avoid: [{ id: 2, reason: "not sure" }],
      }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(calls).toEqual(["click:3"]);
    expect(result.executed.map((e) => [e.id, e.outcome])).toEqual([
      [0, "blocked"],
      [1, "blocked"],
      [2, "blocked"],
      [3, "ok"],
    ]);
  });

  it("narrates each attempted action", async () => {
    const { page } = fakePage([
      cand({ id: 0, kind: "tab", text: "Activity" }),
      cand({ id: 1, text: "Sign out" }),
    ]);
    const lines: string[] = [];
    await exploreStep(page, {
      policy: policyOf({
        actions: [
          { id: 0, kind: "click" },
          { id: 1, kind: "click" },
        ],
        avoid: [],
      }),
      coverage: () => ({ requests: 0, endpoints: [] }),
      narrate: (m) => lines.push(m),
    });
    expect(lines[0]).toContain('"Activity"');
    expect(lines[0]).toContain("ok");
    expect(lines[1]).toContain("blocked");
    expect(lines[1]).toContain("destructive-looking label");
  });

  it('treats "Archived" as a safe filter label but "Archive" as mutating', async () => {
    const { page, calls } = fakePage([
      cand({ id: 0, kind: "tab", text: "Archived" }),
      cand({ id: 1, text: "Archive order" }),
    ]);
    await exploreStep(page, {
      policy: policyOf({
        actions: [
          { id: 0, kind: "click" },
          { id: 1, kind: "click" },
        ],
        avoid: [],
      }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(calls).toEqual(["click:0"]);
  });

  it("blocks unsafe candidates even when the model proposes them", async () => {
    const { page, calls } = fakePage([
      cand({ id: 0, text: "Delete account" }),
      cand({ id: 1, text: "Sign out" }),
      cand({ id: 2, kind: "input", text: "pw", inputType: "password" }),
    ]);
    const result = await exploreStep(page, {
      policy: policyOf({
        actions: [
          { id: 0, kind: "click" },
          { id: 1, kind: "click" },
          { id: 2, kind: "fill", value: "x" },
          { id: 99, kind: "click" },
        ],
        avoid: [],
      }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(calls).toEqual([]);
    expect(result.executed.map((e) => e.outcome)).toEqual([
      "blocked",
      "blocked",
      "blocked",
      "blocked",
    ]);
  });

  it("gates non-GET form submits behind allowMutations", async () => {
    const search = cand({
      id: 0,
      kind: "input" as const,
      text: "Add comment",
      inputType: "text",
      formMethod: "post",
    });
    const a = fakePage([search]);
    await exploreStep(a.page, {
      policy: policyOf({
        actions: [{ id: 0, kind: "fill_submit", value: "hi" }],
        avoid: [],
      }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(a.calls).toEqual([]);

    const b = fakePage([search]);
    await exploreStep(b.page, {
      policy: policyOf({
        actions: [{ id: 0, kind: "fill_submit", value: "hi" }],
        avoid: [],
      }),
      allowMutations: true,
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(b.calls).toEqual(["fill:0:hi", "enter:0"]);
  });

  it("recovers when an action navigates away, reporting the discovered URL", async () => {
    const { page, calls } = fakePage([cand({ id: 0, text: "Open order" })], {
      navigateOnClick: { 0: "http://localhost:3000/orders/7" },
    });
    const result = await exploreStep(page, {
      policy: policyOf({ actions: [{ id: 0, kind: "click" }], avoid: [] }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(result.discovered).toEqual(["http://localhost:3000/orders/7"]);
    expect(calls).toContain(`return:${URL0}`);
  });

  it("degrades to no-op when the policy throws", async () => {
    const { page, calls } = fakePage([cand({ id: 0 })]);
    const warnings: string[] = [];
    const failing: LlmPolicy = {
      model: "fake",
      decide: async () => {
        throw new Error("connection refused");
      },
    };
    const result = await exploreStep(page, {
      policy: failing,
      coverage: () => ({ requests: 0, endpoints: [] }),
      warn: (m) => warnings.push(m),
    });
    expect(result.executed).toEqual([]);
    expect(calls).toEqual([]);
    expect(warnings[0]).toContain("connection refused");
  });

  it("selects dropdown options, but only on real selects with a value", async () => {
    const { page, calls } = fakePage([
      cand({
        id: 0,
        kind: "select",
        text: "Choose a shop",
        options: ["Shop A", "Shop B"],
      }),
      cand({ id: 1, text: "View details" }),
    ]);
    const result = await exploreStep(page, {
      policy: policyOf({
        actions: [
          { id: 0, kind: "select", value: "Shop A" },
          { id: 1, kind: "select", value: "nope" }, // not a dropdown
          { id: 0, kind: "select" }, // no value
        ],
        avoid: [],
      }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(calls).toEqual(["select:0:Shop A"]);
    expect(result.executed.map((e) => e.outcome)).toEqual([
      "ok",
      "blocked",
      "blocked",
    ]);
  });

  it("retargets a select whose id is really an option index", async () => {
    const { page, calls } = fakePage([
      cand({
        id: 0,
        kind: "select",
        text: "Choose a shop…",
        options: ["Choose a shop…", "Alpha Shop", "Beta Shop"],
      }),
    ]);
    await exploreStep(page, {
      policy: policyOf({
        // Model wrote the option index (1 = "Alpha Shop"), not the element id.
        actions: [{ id: 1, kind: "select", value: "Alpha Shop" }],
        avoid: [],
      }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(calls).toEqual(["select:0:Alpha Shop"]);
  });

  it("gate-breaker: picks a dropdown option when the model produced nothing usable", async () => {
    const shopSelect = cand({
      id: 0,
      kind: "select" as const,
      text: "Choose a shop…",
      options: ["Choose a shop…", "Alpha Shop", "Beta Shop"],
    });
    // Garbage decision (unknown id, wrong kind) → fallback selects "Alpha Shop".
    const a = fakePage([shopSelect]);
    const result = await exploreStep(a.page, {
      policy: policyOf({ actions: [{ id: 7, kind: "click" }], avoid: [] }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(a.calls).toEqual(["select:0:Alpha Shop"]);
    expect(result.executed.at(-1)).toMatchObject({
      detail: "gate-breaker fallback",
      outcome: "ok",
    });

    // A successful normal action → no fallback.
    const b = fakePage([shopSelect, cand({ id: 1, kind: "tab", text: "Tab" })]);
    await exploreStep(b.page, {
      policy: policyOf({ actions: [{ id: 1, kind: "click" }], avoid: [] }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(b.calls).toEqual(["click:1"]);

    // No dropdown on the page → no fallback.
    const c = fakePage([cand({ id: 0, text: "View details" })]);
    await exploreStep(c.page, {
      policy: policyOf({ actions: [{ id: 9, kind: "click" }], avoid: [] }),
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(c.calls).toEqual([]);
  });

  it("caps actions per page", async () => {
    const cands = Array.from({ length: 8 }, (_, i) =>
      cand({ id: i, text: `Tab ${i}`, kind: "tab" as const })
    );
    const { page, calls } = fakePage(cands);
    await exploreStep(page, {
      policy: policyOf({
        actions: cands.map((c) => ({ id: c.id, kind: "click" as const })),
        avoid: [],
      }),
      maxActionsPerPage: 3,
      coverage: () => ({ requests: 0, endpoints: [] }),
    });
    expect(calls).toHaveLength(3);
  });
});
