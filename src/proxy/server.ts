import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HarStore } from "./har-store.js";
import { Auth0Handler, type Auth0Profile } from "./auth0.js";
import { loadOrCreateSigningKey } from "./keys.js";
import { loadOrCreateCert } from "./cert.js";
import { sessionPaths, type SessionMeta } from "../session/store.js";
import { freePort } from "../util/run.js";
import { log } from "../util/log.js";

export interface RunningProxy {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding", // body is already decoded by the time we re-emit it
]);

/** Read the full request body into a Buffer. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  return {
    "access-control-allow-origin": (req.headers.origin as string) ?? "*",
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      (req.headers["access-control-request-headers"] as string) ?? "*",
  };
}

/** Strip hop-by-hop and CORS-conflicting headers before re-emitting. */
function sanitizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key.startsWith("access-control-")) continue; // we set our own permissive CORS
    out[key] = v;
  }
  return out;
}

/** Extract a login profile from a recorded /userinfo response, if present. */
function seedProfile(store: HarStore): Auth0Profile | undefined {
  const hit = store.match("GET", "/userinfo");
  if (!hit) return undefined;
  try {
    const parsed = JSON.parse(hit.body.toString("utf8")) as Auth0Profile;
    if (parsed && typeof parsed.sub === "string") return parsed;
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Choose the backend origin to forward cache misses to: the first recorded origin that
 * isn't an Auth0 tenant or localhost. Returns null if none can be inferred.
 */
function inferBackendOrigin(
  store: HarStore,
  session: SessionMeta
): string | null {
  // Prefer an explicit api-base value captured during the env scan.
  const apiBase = session.envVars.find(
    (v) => v.role === "api-base"
  )?.originalValue;
  if (apiBase && /^https?:\/\//.test(apiBase)) {
    try {
      return new URL(apiBase).origin;
    } catch {
      /* fall through */
    }
  }
  for (const host of store.origins) {
    if (host.endsWith(".auth0.com")) continue;
    if (/(^|\.)localhost(:|$)|127\.0\.0\.1/.test(host)) continue;
    return `https://${host}`;
  }
  return null;
}

export async function startProxy(session: SessionMeta): Promise<RunningProxy> {
  const paths = sessionPaths(session.id);
  const store = new HarStore(paths.har);
  const key = await loadOrCreateSigningKey(paths.key);
  const cert = loadOrCreateCert(paths.certDir);
  const port = session.proxyPort ?? (await freePort());
  const issuer = `https://localhost:${port}/`;
  const auth0Audience = session.envVars.find(
    (v) => v.role === "auth0-audience"
  )?.originalValue;

  const auth = new Auth0Handler({
    key,
    issuer,
    profile: seedProfile(store),
    defaultAudience: auth0Audience,
  });
  const backendOrigin = inferBackendOrigin(store, session);
  if (backendOrigin) log.dim(`  passthrough target: ${backendOrigin}`);
  else log.dim("  no backend origin inferred — misses will 404");

  const server = https.createServer(
    { key: cert.key, cert: cert.cert },
    (req, res) => {
      handleRequest(req, res, { store, auth, backendOrigin }).catch((err) => {
        log.error(`proxy error: ${(err as Error).message}`);
        if (!res.headersSent) res.writeHead(502);
        res.end("proxy error");
      });
    }
  );

  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve)
  );
  const url = `https://localhost:${port}`;
  log.success(`Mock proxy listening on ${url}`);

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

interface HandlerCtx {
  store: HarStore;
  auth: Auth0Handler;
  backendOrigin: string | null;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx
): Promise<void> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `https://${host}`);
  const method = (req.method ?? "GET").toUpperCase();

  // CORS preflight.
  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  const body = await readBody(req);

  // 1. Auth0 endpoints.
  if (await ctx.auth.handle(req, res, url, body)) return;

  // 2. HAR replay.
  const hit = ctx.store.match(method, url.pathname + url.search);
  if (hit) {
    res.writeHead(hit.status, {
      ...sanitizeHeaders(hit.headers),
      ...corsHeaders(req),
    });
    res.end(hit.body);
    return;
  }

  // 3. Miss → passthrough + record (or 404 if no backend known).
  if (!ctx.backendOrigin) {
    res.writeHead(404, { "content-type": "text/plain", ...corsHeaders(req) });
    res.end(`sauce-control: no mock for ${method} ${url.pathname}`);
    return;
  }

  const target =
    ctx.backendOrigin.replace(/\/$/, "") + url.pathname + url.search;
  log.dim(`  passthrough ${method} ${url.pathname}`);
  const upstream = await fetch(target, {
    method,
    headers: forwardHeaders(req),
    body: method === "GET" || method === "HEAD" ? undefined : body,
    redirect: "manual",
  });
  const respBody = Buffer.from(await upstream.arrayBuffer());
  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => (respHeaders[k] = v));

  ctx.store.append(
    method,
    target,
    upstream.status,
    respHeaders,
    respBody,
    forwardHeaders(req),
    body.length ? body.toString("utf8") : undefined
  );

  res.writeHead(upstream.status, {
    ...sanitizeHeaders(respHeaders),
    ...corsHeaders(req),
  });
  res.end(respBody);
}

function forwardHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key === "host" || HOP_BY_HOP.has(key)) continue;
    if (typeof v === "string") out[key] = v;
    else if (Array.isArray(v)) out[key] = v.join(", ");
  }
  return out;
}
