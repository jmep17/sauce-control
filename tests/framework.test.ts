import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectFramework } from "../src/detect/framework.js";

const tmpDirs: string[] = [];

function makeWorktree(opts: {
  deps: Record<string, string>;
  lockfile: string;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sauce-fw-"));
  tmpDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fixture",
      dependencies: opts.deps,
      scripts: { dev: "whatever" },
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

  it("adds no separator or flags for unknown frameworks", () => {
    const wt = makeWorktree({
      deps: {},
      lockfile: "pnpm-lock.yaml",
    });
    expect(detectFramework(wt).devCommand).toEqual(["pnpm", "run", "dev"]);
  });
});
