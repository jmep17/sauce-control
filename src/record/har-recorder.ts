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
  debounceMs = 300
): { flush(): void } {
  let timer: NodeJS.Timeout | undefined;
  const scheduleFlush = () => {
    clearTimeout(timer);
    timer = setTimeout(() => store.flush(), debounceMs);
  };

  context.on("response", (response) => {
    void (async () => {
      try {
        // Redirects and aborted requests have no retrievable body.
        const body = await response.body().catch(() => Buffer.alloc(0));
        const req = response.request();
        store.append(
          req.method(),
          response.url(),
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
