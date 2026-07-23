import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachHarRecorder,
  type RecordedResponse,
} from "../src/record/har-recorder.js";
import { HarStore } from "../src/proxy/har-store.js";

const tmpDirs: string[] = [];

function tmpHarPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sauce-rec-"));
  tmpDirs.push(dir);
  return path.join(dir, "traffic.har");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeResponse(over: Partial<RecordedResponse> = {}): RecordedResponse {
  return {
    url: () => "https://api.example.com/things?x=1",
    status: () => 200,
    headers: () => ({ "content-type": "application/json" }),
    body: async () => Buffer.from('{"a":1}'),
    request: () => ({
      method: () => "GET",
      headers: () => ({ accept: "application/json" }),
      postData: () => null,
    }),
    ...over,
  };
}

function readEntries(harPath: string) {
  return JSON.parse(fs.readFileSync(harPath, "utf8")).log.entries as Array<{
    request: { method: string; url: string };
    response: { status: number; content: { text: string } };
  }>;
}

describe("attachHarRecorder", () => {
  it("persists entries to disk shortly after they arrive, with no flush or close", async () => {
    const harPath = tmpHarPath();
    const context = new EventEmitter();
    attachHarRecorder(context, new HarStore(harPath), { debounceMs: 5 });

    context.emit("response", fakeResponse());

    // The whole point: if the browser dies now (window closed, Ctrl-C), the
    // recording must already be on disk.
    await vi.waitFor(() => expect(fs.existsSync(harPath)).toBe(true));
    const entries = readEntries(harPath);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.request.method).toBe("GET");
    expect(entries[0]!.request.url).toBe("https://api.example.com/things?x=1");
    expect(entries[0]!.response.status).toBe(200);
    expect(entries[0]!.response.content.text).toBe('{"a":1}');
  });

  it("flush() writes immediately without waiting for the debounce", async () => {
    const harPath = tmpHarPath();
    const context = new EventEmitter();
    const recorder = attachHarRecorder(context, new HarStore(harPath), {
      debounceMs: 60_000,
    });

    context.emit("response", fakeResponse());
    // Let the async body() capture settle, then force the write.
    await vi.waitFor(() => {
      recorder.flush();
      expect(fs.existsSync(harPath)).toBe(true);
      expect(readEntries(harPath)).toHaveLength(1);
    });
  });

  it("records a response whose body is unavailable (e.g. a redirect)", async () => {
    const harPath = tmpHarPath();
    const context = new EventEmitter();
    attachHarRecorder(context, new HarStore(harPath), { debounceMs: 5 });

    context.emit(
      "response",
      fakeResponse({
        status: () => 302,
        body: () => Promise.reject(new Error("no body for redirect")),
      })
    );

    await vi.waitFor(() => expect(fs.existsSync(harPath)).toBe(true));
    expect(readEntries(harPath)[0]!.response.status).toBe(302);
  });

  it("skips app-origin assets (but keeps its JSON) and static/streaming types", async () => {
    const harPath = tmpHarPath();
    const context = new EventEmitter();
    attachHarRecorder(context, new HarStore(harPath), {
      debounceMs: 5,
      appOrigins: ["http://localhost:3000"],
    });

    // App's own dev server chunk — the launch dev server serves this itself.
    context.emit(
      "response",
      fakeResponse({
        url: () => "http://localhost:3000/_next/chunk.js",
        headers: () => ({ "content-type": "application/javascript" }),
      })
    );
    // App-origin JSON (vite proxy / _next/data) is still recorded.
    context.emit(
      "response",
      fakeResponse({ url: () => "http://localhost:3000/api/session" })
    );
    // Static/streaming types are never replayed from the HAR.
    for (const type of ["image/png", "font/woff2", "text/event-stream"]) {
      context.emit(
        "response",
        fakeResponse({
          url: () => `https://api.example.com/asset-${type.replace("/", "-")}`,
          headers: () => ({ "content-type": type }),
        })
      );
    }
    // A real API response still lands.
    context.emit("response", fakeResponse());

    await vi.waitFor(() => {
      expect(fs.existsSync(harPath)).toBe(true);
      expect(readEntries(harPath)).toHaveLength(2);
    });
    const urls = readEntries(harPath).map((e) => e.request.url);
    expect(urls).toContain("http://localhost:3000/api/session");
    expect(urls).toContain("https://api.example.com/things?x=1");
  });

  it("stores oversized bodies as metadata only, keeping the HAR bounded", async () => {
    const harPath = tmpHarPath();
    const context = new EventEmitter();
    attachHarRecorder(context, new HarStore(harPath), { debounceMs: 5 });

    context.emit(
      "response",
      fakeResponse({
        url: () => "https://api.example.com/huge-export",
        body: async () => Buffer.alloc(3 * 1024 * 1024, "x"),
      })
    );

    await vi.waitFor(() => expect(fs.existsSync(harPath)).toBe(true));
    const entry = readEntries(harPath)[0]!;
    expect(entry.response.content.text).toBeUndefined();
    expect((entry.response.content as { size: number }).size).toBe(
      3 * 1024 * 1024
    );
    // And the file itself stayed small.
    expect(fs.statSync(harPath).size).toBeLessThan(100 * 1024);
  });

  it("captured entries are replayable through HarStore.match", async () => {
    const harPath = tmpHarPath();
    const context = new EventEmitter();
    attachHarRecorder(context, new HarStore(harPath), { debounceMs: 5 });

    context.emit("response", fakeResponse());
    await vi.waitFor(() => expect(fs.existsSync(harPath)).toBe(true));

    const replay = new HarStore(harPath);
    const hit = replay.match("GET", "https://proxy.local/things?x=1");
    expect(hit?.status).toBe(200);
    expect(hit?.body.toString()).toBe('{"a":1}');
  });
});
