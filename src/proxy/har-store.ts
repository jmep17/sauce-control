import fs from "node:fs";

// Minimal HAR typings covering what we read/write.
interface HarHeader {
  name: string;
  value: string;
}
interface HarRequest {
  method: string;
  url: string;
  headers?: HarHeader[];
  postData?: { mimeType?: string; text?: string };
}
interface HarContent {
  size?: number;
  mimeType?: string;
  text?: string;
  encoding?: string; // "base64" if binary
}
interface HarResponse {
  status: number;
  statusText?: string;
  headers?: HarHeader[];
  content?: HarContent;
  redirectURL?: string;
}
interface HarEntry {
  request: HarRequest;
  response: HarResponse;
  startedDateTime?: string;
  time?: number;
}
interface Har {
  log: {
    version: string;
    creator?: { name: string; version: string };
    entries: HarEntry[];
  };
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function normalizePath(rawUrl: string): {
  path: string;
  pathAndQuery: string;
  host: string;
} {
  try {
    const u = new URL(rawUrl);
    return {
      path: u.pathname,
      pathAndQuery: u.pathname + u.search,
      host: u.host,
    };
  } catch {
    // Relative or malformed; treat the whole thing as a path.
    const q = rawUrl.indexOf("?");
    const p = q === -1 ? rawUrl : rawUrl.slice(0, q);
    return { path: p, pathAndQuery: rawUrl, host: "" };
  }
}

function decodeContent(content: HarContent | undefined): Buffer {
  if (!content?.text) return Buffer.alloc(0);
  if (content.encoding === "base64") return Buffer.from(content.text, "base64");
  return Buffer.from(content.text, "utf8");
}

function headersToObject(
  headers: HarHeader[] | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) out[h.name.toLowerCase()] = h.value;
  return out;
}

/**
 * Loads a HAR file and serves the best matching response for an incoming request.
 * Matching prefers method + path + query, falling back to method + path. New responses
 * captured during passthrough are appended and persisted so the mock set self-heals.
 */
export class HarStore {
  private har: Har;
  private byKey = new Map<string, HarEntry[]>();
  /** Distinct origins seen in the HAR — used to route passthrough misses. */
  readonly origins = new Set<string>();

  constructor(private readonly harPath: string) {
    this.har = fs.existsSync(harPath)
      ? (JSON.parse(fs.readFileSync(harPath, "utf8")) as Har)
      : { log: { version: "1.2", entries: [] } };
    for (const entry of this.har.log.entries) this.index(entry);
  }

  private index(entry: HarEntry) {
    const { path, pathAndQuery, host } = normalizePath(entry.request.url);
    if (host) this.origins.add(host);
    const method = entry.request.method.toUpperCase();
    for (const key of [`${method} ${pathAndQuery}`, `${method} ${path}`]) {
      const list = this.byKey.get(key) ?? [];
      list.push(entry);
      this.byKey.set(key, list);
    }
  }

  /** Find a matching recorded response, or null on a miss. */
  match(method: string, url: string): MockResponse | null {
    const { path, pathAndQuery } = normalizePath(url);
    const m = method.toUpperCase();
    const entry =
      this.byKey.get(`${m} ${pathAndQuery}`)?.[0] ??
      this.byKey.get(`${m} ${path}`)?.[0];
    if (!entry) return null;
    return {
      status: entry.response.status,
      headers: headersToObject(entry.response.headers),
      body: decodeContent(entry.response.content),
    };
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.har.log.entries.length;
  }

  /** Unique "METHOD /path" pairs captured — coverage summary for auto-explore. */
  endpoints(): string[] {
    const out = new Set<string>();
    for (const e of this.har.log.entries) {
      const { path } = normalizePath(e.request.url);
      out.add(`${e.request.method.toUpperCase()} ${path}`);
    }
    return [...out];
  }

  /**
   * Append a freshly captured response. Persists to disk unless
   * `opts.persist` is false (bulk recording batches writes via `flush()`).
   */
  append(
    method: string,
    url: string,
    status: number,
    headers: Record<string, string>,
    body: Buffer,
    reqHeaders: Record<string, string> = {},
    reqBody?: string,
    opts: { persist?: boolean } = {}
  ): void {
    const isText = /json|text|xml|javascript|urlencoded/i.test(
      headers["content-type"] ?? ""
    );
    const entry: HarEntry = {
      startedDateTime: new Date().toISOString(),
      request: {
        method: method.toUpperCase(),
        url,
        headers: Object.entries(reqHeaders).map(([name, value]) => ({
          name,
          value,
        })),
        ...(reqBody ? { postData: { text: reqBody } } : {}),
      },
      response: {
        status,
        headers: Object.entries(headers).map(([name, value]) => ({
          name,
          value,
        })),
        content: {
          size: body.length,
          mimeType: headers["content-type"] ?? "application/octet-stream",
          ...(isText
            ? { text: body.toString("utf8") }
            : { text: body.toString("base64"), encoding: "base64" }),
        },
      },
    };
    this.har.log.entries.push(entry);
    this.index(entry);
    if (opts.persist !== false) this.persist();
  }

  /** Write the current state to disk. */
  flush(): void {
    this.persist();
  }

  private persist() {
    fs.writeFileSync(this.harPath, JSON.stringify(this.har, null, 2));
  }
}
