import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectFramework } from "../src/detect/framework.js";

const tmpDirs: string[] = [];

function makeWorktree(opts: {
  deps: Record<string, string>;
  lockfile: string;
  scripts?: Record<string, string>;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sauce-fw-"));
  tmpDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      dependencies: opts.deps,
      scripts: opts.scripts ?? { dev: "whatever" },
    })
  );
  fs.writeFileSync(path.join(dir, opts.lockfile), "");
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectFramework devCommand", () => {
  it("keeps the -- separator for npm, which consumes flags itself", () => {
    const wt = makeWorktree({
      deps: { next: "15.0.0" },
      lockfile: "package-lock.json",
    });
    expect(detectFramework(wt).devCommand).toEqual([
      "npm",
      "run",
      "dev",
      "--",
      "-p",
      "3000",
    ]);
  });

  // pnpm forwards a literal `--` to the script; Next.js then parses `-p` as
  // its project-directory positional and dies with "Invalid project directory
  // provided, no such directory: <worktree>/-p".
  it("omits the -- separator for pnpm on Next.js", () => {
    const wt = makeWorktree({
      deps: { next: "15.0.0" },
      lockfile: "pnpm-lock.yaml",
    });
    expect(detectFramework(wt).devCommand).toEqual([
      "pnpm",
      "run",
      "dev",
      "-p",
      "3000",
    ]);
  });

  it("omits the -- separator for pnpm on Vite", () => {
    const wt = makeWorktree({
      deps: { vite: "6.0.0" },
      lockfile: "pnpm-lock.yaml",
    });
    expect(detectFramework(wt).devCommand).toEqual([
      "pnpm",
      "run",
      "dev",
      "--port",
      "5173",
      "--strictPort",
    ]);
  });

  it("picks the script that runs `next dev`, whatever its name", () => {
    const wt = makeWorktree({
      deps: { next: "15.0.0" },
      lockfile: "pnpm-lock.yaml",
      scripts: {
        build: "next build",
        develop: "next dev",
        start: "next start",
      },
    });
    expect(detectFramework(wt).devCommand).toEqual([
      "pnpm",
      "run",
      "develop",
      "-p",
      "3000",
    ]);
  });

  it("prefers a dev-server script over a conventionally-named non-server one", () => {
    const wt = makeWorktree({
      deps: { next: "15.0.0" },
      lockfile: "pnpm-lock.yaml",
      scripts: { dev: "node tools/codegen.js", local: "next dev --turbopack" },
    });
    expect(detectFramework(wt).devCommand[2]).toBe("local");
  });

  it("never picks `next start` or `next build` scripts by content", () => {
    const wt = makeWorktree({
      deps: { next: "15.0.0" },
      lockfile: "pnpm-lock.yaml",
      scripts: { build: "next build", serve: "next start" },
    });
    // No dev-server script exists; the name fallback picks `serve`, but the
    // content pass must not have matched build/start as dev servers.
    expect(detectFramework(wt).devCommand[2]).toBe("serve");
  });

  it("matches bare `vite` and flag-only invocations, not vite build/preview", () => {
    const wt = makeWorktree({
      deps: { vite: "6.0.0" },
      lockfile: "pnpm-lock.yaml",
      scripts: {
        build: "vite build",
        preview: "vite preview",
        app: "vite --host",
      },
    });
    expect(detectFramework(wt).devCommand[2]).toBe("app");
  });

  it("falls back to conventional names when no script body matches", () => {
    const wt = makeWorktree({
      deps: { next: "15.0.0" },
      lockfile: "pnpm-lock.yaml",
      scripts: { develop: "node server.js", lint: "eslint ." },
    });
    expect(detectFramework(wt).devCommand[2]).toBe("develop");
  });

  it("adds no separator or flags for unknown frameworks", () => {
    const wt = makeWorktree({
      deps: {},
      lockfile: "pnpm-lock.yaml",
    });
    expect(detectFramework(wt).devCommand).toEqual(["pnpm", "run", "dev"]);
  });
});
