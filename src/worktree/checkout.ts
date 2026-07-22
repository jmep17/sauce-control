import fs from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  mirrorPath,
  worktreePath,
  ensureDir,
  REPOS_DIR,
} from "../config/paths.js";
import { run } from "../util/run.js";
import { log } from "../util/log.js";

export interface CheckoutResult {
  worktree: string;
  mirror: string;
  branch: string;
}

/**
 * Ensure a bare mirror clone exists for the repo (cloned once, refreshed on reuse),
 * then add an isolated worktree for the requested branch. Patches only ever touch the
 * worktree — never any real checkout the user may have elsewhere.
 */
export async function ensureWorktree(
  org: string,
  repo: string,
  cloneUrl: string,
  branch: string
): Promise<CheckoutResult> {
  const mirror = mirrorPath(org, repo);
  ensureDir(path.dirname(mirror));

  if (!fs.existsSync(mirror)) {
    log.step(`Cloning mirror ${org}/${repo}…`);
    await run("git", ["clone", "--mirror", cloneUrl, mirror]);
  } else {
    log.step(`Refreshing mirror ${org}/${repo}…`);
    await run("git", ["--git-dir", mirror, "remote", "update", "--prune"]);
  }

  const wt = worktreePath(org, repo, branch);
  const git: SimpleGit = simpleGit();

  if (fs.existsSync(wt)) {
    // Reuse: reset the worktree to the latest branch tip.
    log.step(`Reusing worktree at ${wt}`);
    const wtGit = simpleGit(wt);
    await wtGit.raw(["fetch", "origin"]);
    await wtGit.raw(["checkout", branch]);
    await wtGit.raw(["reset", "--hard", `origin/${branch}`]).catch(() => {
      // Local-only or detached branch; leave as-is.
    });
    return { worktree: wt, mirror, branch };
  }

  ensureDir(path.dirname(wt));
  log.step(`Creating worktree for '${branch}' at ${wt}`);
  // `git worktree add` from the bare mirror; -f in case of stale registrations.
  await git.raw([
    "--git-dir",
    mirror,
    "worktree",
    "add",
    "--force",
    wt,
    branch,
  ]);
  return { worktree: wt, mirror, branch };
}

export type PackageManager = "pnpm" | "yarn" | "npm" | "bun";

/** Detect the package manager from lockfiles present in the worktree. */
export function detectPackageManager(worktree: string): PackageManager {
  if (fs.existsSync(path.join(worktree, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(worktree, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(worktree, "yarn.lock"))) return "yarn";
  return "npm";
}

const INSTALL_ARGS: Record<PackageManager, string[]> = {
  pnpm: ["install"],
  yarn: ["install"],
  npm: ["install"],
  bun: ["install"],
};

/** Install dependencies in the worktree using the detected package manager. */
export async function installDeps(worktree: string): Promise<PackageManager> {
  const pm = detectPackageManager(worktree);
  log.step(`Installing dependencies with ${pm}…`);
  await run(pm, INSTALL_ARGS[pm], { cwd: worktree });
  log.success("Dependencies installed");
  return pm;
}

/** Install deps only if node_modules is missing (e.g. a wiped worktree before `launch`). */
export async function ensureDeps(worktree: string): Promise<void> {
  if (fs.existsSync(path.join(worktree, "node_modules"))) return;
  log.warn("node_modules missing — installing dependencies before launch");
  await installDeps(worktree);
}

/** Remove a worktree (used by a future `clean` command). */
export async function removeWorktree(
  org: string,
  repo: string,
  branch: string
) {
  const mirror = mirrorPath(org, repo);
  const wt = worktreePath(org, repo, branch);
  if (fs.existsSync(mirror) && fs.existsSync(wt)) {
    await simpleGit().raw([
      "--git-dir",
      mirror,
      "worktree",
      "remove",
      "--force",
      wt,
    ]);
  }
}

export { REPOS_DIR };
