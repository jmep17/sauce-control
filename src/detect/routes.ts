import fs from "node:fs";
import path from "node:path";

export interface StaticRoutes {
  /** Concrete URL paths, e.g. ["/", "/dashboard", "/settings/profile"]. */
  routes: string[];
  /** Dynamic patterns we can't fill statically, e.g. ["/orders/[id]"]. */
  dynamic: string[];
}

const PAGE_EXT = /\.(tsx|ts|jsx|js|mdx)$/;

function isDynamicSegment(seg: string): boolean {
  return seg.startsWith("[");
}

/** App-router segments that don't contribute to (or invalidate) the URL. */
function classifyAppSegment(
  seg: string
): "keep" | "skip-segment" | "skip-tree" {
  if (seg.startsWith("(") && seg.endsWith(")")) return "skip-segment"; // route group
  if (seg.startsWith("@")) return "skip-tree"; // parallel route slot
  if (seg.startsWith("_")) return "skip-tree"; // private folder
  return "keep";
}

function walkAppDir(dir: string, segments: string[], out: StaticRoutes): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const hasPage = entries.some(
    (e) => e.isFile() && /^page\./.test(e.name) && PAGE_EXT.test(e.name)
  );
  if (hasPage) {
    const url = "/" + segments.join("/");
    if (segments.some(isDynamicSegment)) out.dynamic.push(url);
    else out.routes.push(url === "/" ? "/" : url.replace(/\/$/, ""));
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const kind = classifyAppSegment(e.name);
    if (kind === "skip-tree") continue;
    const next = kind === "skip-segment" ? segments : [...segments, e.name];
    walkAppDir(path.join(dir, e.name), next, out);
  }
}

function walkPagesDir(
  dir: string,
  segments: string[],
  out: StaticRoutes
): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith("_")) continue; // _app, _document, _error
    if (e.isDirectory()) {
      if (segments.length === 0 && e.name === "api") continue;
      walkPagesDir(path.join(dir, e.name), [...segments, e.name], out);
      continue;
    }
    if (!PAGE_EXT.test(e.name)) continue;
    const base = e.name.replace(PAGE_EXT, "");
    const segs = base === "index" ? segments : [...segments, base];
    const url = "/" + segs.join("/");
    if (segs.some(isDynamicSegment)) out.dynamic.push(url);
    else out.routes.push(url);
  }
}

/**
 * Enumerate a Next.js worktree's routes straight from the filesystem —
 * app router (`app/`, `src/app/`) and pages router (`pages/`, `src/pages/`).
 * Non-Next repos simply yield nothing; their routes are discovered by crawling.
 */
export function enumerateStaticRoutes(worktree: string): StaticRoutes {
  const out: StaticRoutes = { routes: [], dynamic: [] };
  for (const root of ["app", "src/app"]) {
    const dir = path.join(worktree, root);
    if (fs.existsSync(dir)) walkAppDir(dir, [], out);
  }
  for (const root of ["pages", "src/pages"]) {
    const dir = path.join(worktree, root);
    if (fs.existsSync(dir)) walkPagesDir(dir, [], out);
  }
  out.routes = [...new Set(out.routes)].sort();
  out.dynamic = [...new Set(out.dynamic)].sort();
  return out;
}
