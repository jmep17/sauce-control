import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Root state directory for all sauce-control artifacts. */
export const ROOT = process.env.SAUCE_CONTROL_HOME
  ? path.resolve(process.env.SAUCE_CONTROL_HOME)
  : path.join(os.homedir(), ".sauce-control");

export const REPOS_DIR = path.join(ROOT, "repos");
export const WORKTREES_DIR = path.join(ROOT, "worktrees");
export const SESSIONS_DIR = path.join(ROOT, "sessions");

/** Bare mirror clone location for an org/repo. */
export function mirrorPath(org: string, repo: string): string {
  return path.join(REPOS_DIR, org, `${repo}.git`);
}

/** Worktree checkout location for a given branch. */
export function worktreePath(
  org: string,
  repo: string,
  branch: string
): string {
  // Branch names can contain slashes (feature/x); flatten for a safe dir name.
  const safeBranch = branch.replace(/[^\w.-]+/g, "__");
  return path.join(WORKTREES_DIR, org, repo, safeBranch);
}

export function sessionDir(id: string): string {
  return path.join(SESSIONS_DIR, id);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
