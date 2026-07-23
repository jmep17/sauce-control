import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, sessionDir, ensureDir } from "../config/paths.js";

export type Framework = "nextjs" | "vite" | "unknown";

/** How a discovered env var maps onto the mock proxy. */
export type EnvRole =
  | "auth0-domain" // bare host, e.g. tenant.auth0.com  -> localhost:PORT
  | "auth0-issuer" // full URL,  e.g. https://tenant.auth0.com/ -> https://localhost:PORT/
  | "auth0-audience" // API identifier, left as-is (proxy accepts any)
  | "auth0-client-id" // left as-is
  | "api-base"; // backend base URL -> https://localhost:PORT

export interface DiscoveredEnvVar {
  name: string;
  role: EnvRole;
  /** Original value if we found one in a .env* file (informational). */
  originalValue?: string;
  /** Files the var was referenced in (for user review). */
  sources: string[];
}

export interface SessionMeta {
  id: string;
  org: string;
  repo: string;
  branch: string;
  worktree: string;
  framework: Framework;
  /** Command + args to start the dev server, e.g. ["pnpm","dev"]. */
  devCommand: string[];
  /** Port the app's dev server listens on. */
  appPort: number;
  /** Port the mock proxy listens on (HTTPS). Assigned when serving. */
  proxyPort?: number;
  /** Env vars discovered in the worktree and how to rewrite them. */
  envVars: DiscoveredEnvVar[];
  /** Absolute API/backend hosts hardcoded in source (can't be env-patched). */
  hardcodedHosts: string[];
  createdAt: string;
}

const META = "session.json";
export const HAR_FILE = "traffic.har";
export const KEY_FILE = "signing-key.json";
export const CERT_DIR = "ca";
/** AI-explorer decision log (JSONL) — doubles as a fine-tuning dataset. */
export const DECISIONS_FILE = "decisions.jsonl";

export function sessionPaths(id: string) {
  const dir = sessionDir(id);
  return {
    dir,
    meta: path.join(dir, META),
    har: path.join(dir, HAR_FILE),
    key: path.join(dir, KEY_FILE),
    certDir: path.join(dir, CERT_DIR),
    decisions: path.join(dir, DECISIONS_FILE),
  };
}

export function saveSession(meta: SessionMeta): void {
  const { dir, meta: metaPath } = sessionPaths(meta.id);
  ensureDir(dir);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

export function loadSession(id: string): SessionMeta {
  const { meta } = sessionPaths(id);
  if (!fs.existsSync(meta)) {
    throw new Error(`no session '${id}' (looked in ${meta})`);
  }
  return JSON.parse(fs.readFileSync(meta, "utf8")) as SessionMeta;
}

export function listSessions(): SessionMeta[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR)
    .map((id) => {
      try {
        return loadSession(id);
      } catch {
        return null;
      }
    })
    .filter((s): s is SessionMeta => s !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Deterministic-ish session id: org-repo-branch-shorttime. */
export function makeSessionId(
  org: string,
  repo: string,
  branch: string
): string {
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "-").toLowerCase();
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  return `${safe(org)}-${safe(repo)}-${safe(branch)}-${stamp}`;
}
