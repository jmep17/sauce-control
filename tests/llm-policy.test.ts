import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  autodetectModel,
  createLocalLlmPolicy,
  type DecisionInput,
} from "../src/llm/policy.js";

const INPUT: DecisionInput = {
  url: "http://localhost:3000/",
  title: "Home",
  candidates: [{ id: 0, kind: "tab", text: "Activity" }],
  coverage: { requests: 3, endpoints: ["GET /api/me"] },
  allowMutations: false,
};

let server: http.Server | undefined;

function serve(
  handler: (
    req: http.IncomingMessage,
    body: string
  ) => {
    status?: number;
    json: unknown;
  }
): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const out = handler(req, body);
        res.writeHead(out.status ?? 200, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(out.json));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("createLocalLlmPolicy (Ollama native)", () => {
  it("POSTs /api/chat with a grammar-constraining format and parses the reply", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const base = await serve((req, body) => {
      seen.url = req.url ?? "";
      seen.body = JSON.parse(body || "{}") as Record<string, unknown>;
      return {
        json: {
          message: {
            content: JSON.stringify({
              actions: [{ id: 0, kind: "click" }],
              avoid: [{ id: 1, reason: "looks destructive" }],
            }),
          },
        },
      };
    });
    const policy = await createLocalLlmPolicy({ baseUrl: base, model: "m" });
    const decision = await policy.decide(INPUT);

    expect(seen.url).toBe("/api/chat");
    expect(seen.body!.model).toBe("m");
    expect(seen.body!.stream).toBe(false);
    expect(seen.body!.think).toBe(false);
    expect(seen.body!.format).toMatchObject({ type: "object" });
    expect(decision.actions).toEqual([{ id: 0, kind: "click" }]);
    expect(decision.avoid).toHaveLength(1);
  });

  it("survives models that wrap JSON in a code fence", async () => {
    const base = await serve(() => ({
      json: {
        message: {
          content:
            'Sure! ```json\n{"actions":[{"id":0,"kind":"fill","value":"x"}],"avoid":[]}\n```',
        },
      },
    }));
    const policy = await createLocalLlmPolicy({ baseUrl: base, model: "m" });
    const decision = await policy.decide(INPUT);
    expect(decision.actions).toEqual([{ id: 0, kind: "fill", value: "x" }]);
  });

  it("drops malformed actions instead of executing garbage", async () => {
    const base = await serve(() => ({
      json: {
        message: {
          content: JSON.stringify({
            actions: [
              { id: "zero", kind: "click" },
              { id: 1, kind: "detonate" },
              { id: 2, kind: "click" },
            ],
            avoid: "none",
          }),
        },
      },
    }));
    const policy = await createLocalLlmPolicy({ baseUrl: base, model: "m" });
    const decision = await policy.decide(INPUT);
    expect(decision.actions).toEqual([{ id: 2, kind: "click" }]);
    expect(decision.avoid).toEqual([]);
  });

  it("retries once with a corrective message when the shape is wrong", async () => {
    let calls = 0;
    const base = await serve(() => {
      calls++;
      return {
        json: {
          message: {
            content:
              calls === 1
                ? JSON.stringify({ action: "click", element_id: "#2" })
                : JSON.stringify({
                    actions: [{ id: 2, kind: "click" }],
                    avoid: [],
                  }),
          },
        },
      };
    });
    const policy = await createLocalLlmPolicy({ baseUrl: base, model: "m" });
    const decision = await policy.decide(INPUT);
    expect(calls).toBe(2);
    expect(decision.actions).toEqual([{ id: 2, kind: "click" }]);
  });

  it("retries without think for models that reject the field", async () => {
    const bodies: Record<string, unknown>[] = [];
    const base = await serve((_req, body) => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      bodies.push(parsed);
      if ("think" in parsed) {
        return {
          status: 400,
          json: { error: `model "m" does not support thinking` },
        };
      }
      return {
        json: {
          message: {
            content: JSON.stringify({ actions: [], avoid: [] }),
          },
        },
      };
    });
    const policy = await createLocalLlmPolicy({ baseUrl: base, model: "m" });
    await policy.decide(INPUT);
    expect(bodies).toHaveLength(2);
    expect("think" in bodies[1]!).toBe(false);
  });

  it("throws a useful error on HTTP failure", async () => {
    const base = await serve(() => ({
      status: 404,
      json: { error: "model 'nope' not found" },
    }));
    const policy = await createLocalLlmPolicy({ baseUrl: base, model: "nope" });
    await expect(policy.decide(INPUT)).rejects.toThrow(/404/);
  });
});

describe("createLocalLlmPolicy (OpenAI-compatible)", () => {
  it("POSTs /chat/completions with response_format json_schema", async () => {
    const seen: { url?: string; body?: Record<string, unknown> } = {};
    const base = await serve((req, body) => {
      seen.url = req.url ?? "";
      seen.body = JSON.parse(body || "{}") as Record<string, unknown>;
      return {
        json: {
          choices: [
            {
              message: {
                content: JSON.stringify({ actions: [], avoid: [] }),
              },
            },
          ],
        },
      };
    });
    const policy = await createLocalLlmPolicy({
      baseUrl: `${base}/v1`,
      model: "m",
    });
    await policy.decide(INPUT);
    expect(seen.url).toBe("/v1/chat/completions");
    expect(seen.body!.response_format).toMatchObject({ type: "json_schema" });
  });

  it("requires an explicit model", async () => {
    await expect(
      createLocalLlmPolicy({ baseUrl: "http://127.0.0.1:1/v1" })
    ).rejects.toThrow(/--llm-model/);
  });
});

describe("autodetectModel", () => {
  it("prefers a qwen model from the installed list", async () => {
    const base = await serve(() => ({
      json: {
        models: [{ name: "gemma4:e4b" }, { name: "qwen3.5:4b" }],
      },
    }));
    expect(await autodetectModel(base)).toBe("qwen3.5:4b");
  });

  it("errors helpfully when nothing is installed", async () => {
    const base = await serve(() => ({ json: { models: [] } }));
    await expect(autodetectModel(base)).rejects.toThrow(/ollama pull/);
  });
});
