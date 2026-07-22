import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarStore } from "../src/proxy/har-store.js";

function writeHar(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-har-"));
  const file = path.join(dir, "traffic.har");
  fs.writeFileSync(file, JSON.stringify({ log: { version: "1.2", entries } }));
  return file;
}

describe("HarStore", () => {
  it("matches by method + path + query, then falls back to path", () => {
    const file = writeHar([
      {
        request: {
          method: "GET",
          url: "https://api.example.com/v1/users?page=1",
        },
        response: {
          status: 200,
          headers: [{ name: "content-type", value: "application/json" }],
          content: {
            mimeType: "application/json",
            text: JSON.stringify([{ id: 1 }]),
          },
        },
      },
    ]);
    const store = new HarStore(file);

    const exact = store.match("GET", "/v1/users?page=1");
    expect(exact?.status).toBe(200);
    expect(JSON.parse(exact!.body.toString())).toEqual([{ id: 1 }]);

    // Different query still falls back to the path-level entry.
    const fallback = store.match("GET", "/v1/users?page=99");
    expect(fallback?.status).toBe(200);
  });

  it("returns null on a miss", () => {
    const store = new HarStore(writeHar([]));
    expect(store.match("GET", "/nope")).toBeNull();
  });

  it("decodes base64 content", () => {
    const file = writeHar([
      {
        request: { method: "GET", url: "https://api.example.com/blob" },
        response: {
          status: 200,
          headers: [
            { name: "content-type", value: "application/octet-stream" },
          ],
          content: {
            mimeType: "application/octet-stream",
            encoding: "base64",
            text: Buffer.from("hello").toString("base64"),
          },
        },
      },
    ]);
    const store = new HarStore(file);
    expect(store.match("GET", "/blob")?.body.toString()).toBe("hello");
  });

  it("appends a new response and persists + serves it", () => {
    const file = writeHar([]);
    const store = new HarStore(file);
    store.append(
      "GET",
      "https://api.example.com/new",
      201,
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ ok: true }))
    );
    expect(store.match("GET", "/new")?.status).toBe(201);

    const reloaded = new HarStore(file);
    expect(reloaded.match("GET", "/new")?.status).toBe(201);
    expect(JSON.parse(reloaded.match("GET", "/new")!.body.toString())).toEqual({
      ok: true,
    });
  });

  it("records origins for passthrough routing", () => {
    const store = new HarStore(
      writeHar([
        {
          request: { method: "GET", url: "https://api.example.com/x" },
          response: { status: 200, headers: [], content: { text: "{}" } },
        },
      ])
    );
    expect(store.origins.has("api.example.com")).toBe(true);
  });
});
