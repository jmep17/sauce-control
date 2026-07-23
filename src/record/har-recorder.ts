import type { HarStore } from "../proxy/har-store.js";

/**
 * Structural slice of Playwright's Response — enough to build a HAR entry.
 * Kept playwright-free so this module (and its tests) never load the peer dep.
 */
export interface RecordedResponse {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
  request(): {
    method(): string;
    headers(): Record<string, string>;
    postData(): string | null;
  };
}

interface ResponseSource {
  on(event: "response", cb: (response: RecordedResponse) => void): unknown;
}

export interface HarRecorderOptions {
  debounceMs?: number;
  /**
   * The app's own origins: only their JSON responses are recorded. The dev
   * server serves its own pages/chunks/HMR during mocked launch, and dev-mode
   * assets are enormous (unminified chunks, sourcemaps) — recording them
   * ballooned HARs past JSON.stringify's limits without adding anything
   * replayable. JSON is kept because some setups proxy their API through the
   * app origin (Vite dev proxy, Next /_next/data).
   */
  appOrigins?: string[];
}

/** Static/streaming content that's never useful to replay from the HAR. */
const SKIP_CONTENT = /^(image|font|video|audio)\/|event-stream/i;

/**
 * Capture every response on a browser context into the HAR store,
 * incrementally. Entries land on disk within `debounceMs` of arriving, so a
 * recording survives the browser dying or Ctrl-C without any graceful
 * shutdown — unlike Playwright's routeFromHAR({ update: true }), which only
 * writes the file on a clean context.close() and silently loses everything
 * otherwise.
 */
export function attachHarRecorder(
  context: ResponseSource,
  store: HarStore,
  opts: HarRecorderOptions = {}
): { flush(): void } {
  const { debounceMs = 300, appOrigins = [] } = opts;
  let timer: NodeJS.Timeout | undefined;
  const scheduleFlush = () => {
    clearTimeout(timer);
    timer = setTimeout(() => store.flush(), debounceMs);
  };

  context.on("response", (response) => {
    void (async () => {
      try {
        const url = response.url();
        const contentType = response.headers()["content-type"] ?? "";
        // Check before body(): an event-stream body never resolves.
        if (SKIP_CONTENT.test(contentType)) return;
        if (
          appOrigins.some((o) => url.startsWith(o)) &&
          !/json/i.test(contentType)
        )
          return;
        // Redirects and aborted requests have no retrievable body.
        const body = await response.body().catch(() => Buffer.alloc(0));
        const req = response.request();
        store.append(
          req.method(),
          url,
          response.status(),
          response.headers(),
          body,
          req.headers(),
          req.postData() ?? undefined,
          { persist: false }
        );
        scheduleFlush();
      } catch {
        // Target closed mid-capture; nothing to record.
      }
    })();
  });

  return {
    flush() {
      clearTimeout(timer);
      store.flush();
    },
  };
}
