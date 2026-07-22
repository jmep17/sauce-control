import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Git hooks (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE; spawned git
// processes in our tmp repos would inherit them and resolve against the
// wrong repo. Scrub all GIT_* vars before anything spawns git.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

// ROOT in config/paths.ts is resolved at import time, so isolate the state
// root before pulling in the module under test.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sauce-home-"));
process.env.SAUCE_CONTROL_HOME = home;

const { ensureWorktree } = await import("../src/worktree/checkout.js");
const { worktreePath } = await import("../src/config/paths.js");

const originRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sauce-origin-"));
const origin = path.join(originRoot, "app.git-source");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function commitReadme(content: string): void {
  fs.writeFileSync(path.join(origin, "README.md"), content);
  git(origin, "add", "README.md");
  git(origin, "commit", "-m", `set README to ${content}`);
}

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(originRoot, { recursive: true, force: true });
});

describe("ensureWorktree", () => {
  it("creates a worktree on first run and follows upstream on reuse", async () => {
    fs.mkdirSync(origin);
    git(origin, "init", "-b", "main");
    commitReadme("one");

    const first = await ensureWorktree("acme", "app", origin, "main");
    expect(first.worktree).toBe(worktreePath("acme", "app", "main"));
    expect(
      fs.readFileSync(path.join(first.worktree, "README.md"), "utf8")
    ).toBe("one");

    commitReadme("two");

    // Reuse path: the mirror refresh must not trip git's "refusing to fetch
    // into branch ... checked out at" guard, and the worktree files must
    // actually advance to the new tip.
    const second = await ensureWorktree("acme", "app", origin, "main");
    expect(second.worktree).toBe(first.worktree);
    expect(
      fs.readFileSync(path.join(second.worktree, "README.md"), "utf8")
    ).toBe("two");
  });
});
