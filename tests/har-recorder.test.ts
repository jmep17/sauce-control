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
    attachHarRecorder(context, new HarStore(harPath), 5);

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
    const recorder = attachHarRecorder(context, new HarStore(harPath), 60_000);

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
    attachHarRecorder(context, new HarStore(harPath), 5);

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

  it("captured entries are replayable through HarStore.match", async () => {
    const harPath = tmpHarPath();
    const context = new EventEmitter();
    attachHarRecorder(context, new HarStore(harPath), 5);

    context.emit("response", fakeResponse());
    await vi.waitFor(() => expect(fs.existsSync(harPath)).toBe(true));

    const replay = new HarStore(harPath);
    const hit = replay.match("GET", "https://proxy.local/things?x=1");
    expect(hit?.status).toBe(200);
    expect(hit?.body.toString()).toBe('{"a":1}');
  });
});
