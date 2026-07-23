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
