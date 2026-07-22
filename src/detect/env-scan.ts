import fs from "node:fs";
import path from "node:path";
import type { DiscoveredEnvVar, EnvRole } from "../session/store.js";

/**
 * Classify an env var name (+ optional value) into a proxy role, or null if it isn't
 * something we should rewrite. Pure function — unit tested.
 */
export function classifyEnvVar(name: string, value?: string): EnvRole | null {
  const n = name.toUpperCase();
  const v = (value ?? "").trim();
  const isAuth0 = /AUTH0|AUTH_0/.test(n) || /\.auth0\.com/i.test(v);

  if (isAuth0) {
    if (/CLIENT[_-]?ID/.test(n)) return "auth0-client-id";
    if (/AUDIENCE|API[_-]?IDENTIFIER/.test(n)) return "auth0-audience";
    if (/ISSUER|BASE[_-]?URL/.test(n)) return "auth0-issuer";
    if (/DOMAIN|TENANT/.test(n)) return "auth0-domain";
    // Value that is clearly an issuer URL vs a bare domain.
    if (/^https?:\/\//i.test(v)) return "auth0-issuer";
    if (/\.auth0\.com/i.test(v)) return "auth0-domain";
    // An AUTH0-prefixed var we don't otherwise recognize: skip (e.g. secrets).
    return null;
  }

  // Backend / API base URL vars (non-Auth0). Separator-anchored so DATABASE_URL etc.
  // don't false-match on the embedded "BASE_URL".
  if (
    /(?:^|[_-])(API|BACKEND|GRAPHQL|GATEWAY|SERVER)[_-]?(BASE|URL|ENDPOINT|ORIGIN|HOST|URI)/.test(
      n
    ) ||
    /(?:^|[_-])(BASE|ROOT)[_-](API|URL)/.test(n)
  ) {
    return "api-base";
  }
  return null;
}

const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.example",
  ".env.sample",
  ".env.development",
  ".env.development.local",
  ".env.production",
];

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
]);

/** Parse a dotenv file into name→value pairs (best-effort, no interpolation). */
function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, "")
      .trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

function walk(
  dir: string,
  exts: Set<string>,
  files: string[] = [],
  depth = 0
): string[] {
  if (depth > 8) return files;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    if (
      e.name.startsWith(".") &&
      e.name !== ".env" &&
      !e.name.startsWith(".env.")
    ) {
      if (e.isDirectory()) continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, exts, files, depth + 1);
    } else if (exts.has(path.extname(e.name))) {
      files.push(full);
    }
  }
  return files;
}

export interface EnvScanResult {
  envVars: DiscoveredEnvVar[];
  hardcodedHosts: string[];
}

/**
 * Discover env vars (from .env* files and from process.env / import.meta.env source
 * references) that should be repointed at the proxy, plus any hardcoded absolute API
 * hosts we can't rewrite via env.
 */
export function scanEnv(worktree: string): EnvScanResult {
  const discovered = new Map<string, DiscoveredEnvVar>();
  const addRef = (name: string, source: string, value?: string) => {
    const role = classifyEnvVar(name, value);
    if (!role) return;
    const existing = discovered.get(name);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (value && !existing.originalValue) existing.originalValue = value;
    } else {
      discovered.set(name, {
        name,
        role,
        originalValue: value,
        sources: [source],
      });
    }
  };

  // 1. .env* files.
  for (const f of ENV_FILES) {
    const full = path.join(worktree, f);
    if (!fs.existsSync(full)) continue;
    const parsed = parseDotenv(fs.readFileSync(full, "utf8"));
    for (const [k, v] of Object.entries(parsed)) addRef(k, f, v);
  }

  // 2. process.env.X and import.meta.env.VITE_X references in source.
  const sourceFiles = walk(worktree, SOURCE_EXTS);
  const envRefRe =
    /(?:process\.env|import\.meta\.env)\s*(?:\.\s*([A-Z0-9_]+)|\[\s*['"]([A-Z0-9_]+)['"]\s*\])/g;
  const hosts = new Set<string>();
  const urlRe = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?/gi;

  for (const file of sourceFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(worktree, file);
    for (const m of content.matchAll(envRefRe)) {
      const name = m[1] ?? m[2];
      if (name) addRef(name, rel);
    }
    // Hardcoded absolute hosts (informational; not auth0, not localhost).
    for (const m of content.matchAll(urlRe)) {
      const host = m[1]?.toLowerCase();
      if (!host) continue;
      if (host.endsWith(".auth0.com")) continue;
      if (/(^|\.)localhost$|127\.0\.0\.1/.test(host)) continue;
      if (
        /(w3\.org|schema\.org|googleapis|gstatic|fonts\.|cdn\.|sentry\.io)/.test(
          host
        )
      )
        continue;
      hosts.add(host);
    }
  }

  return {
    envVars: [...discovered.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    hardcodedHosts: [...hosts].sort(),
  };
}
