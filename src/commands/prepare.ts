import { ensureWorktree, installDeps } from "../worktree/checkout.js";
import { detectFramework } from "../detect/framework.js";
import {
  makeSessionId,
  saveSession,
  type SessionMeta,
} from "../session/store.js";
import { listOrgRepos } from "../github/repos.js";
import { log, UserError } from "../util/log.js";

export interface PrepareOptions {
  org: string;
  repo: string;
  branch?: string;
  skipInstall?: boolean;
}

/**
 * Resolve the repo, create/refresh its worktree for the chosen branch, install deps,
 * detect the framework + env vars, and persist a session. Shared by `record` and `up`.
 */
export async function prepare(opts: PrepareOptions): Promise<SessionMeta> {
  log.step(`Looking up ${opts.org}/${opts.repo} …`);
  const repos = await listOrgRepos(opts.org);
  const match = repos.find((r) => r.name === opts.repo);
  if (!match) {
    throw new UserError(
      `Repo '${opts.repo}' not found in '${opts.org}'. Run \`sauce-control repos ${opts.org}\`.`
    );
  }
  const branch = opts.branch ?? match.defaultBranch;

  const { worktree } = await ensureWorktree(
    opts.org,
    opts.repo,
    match.cloneUrl,
    branch
  );
  if (!opts.skipInstall) await installDeps(worktree);

  const info = detectFramework(worktree);
  if (info.framework === "unknown") {
    log.warn(
      "Could not detect Next.js or Vite — proceeding, but detection may be imperfect."
    );
  } else {
    log.success(`Detected ${info.framework} (${info.packageManager})`);
  }
  log.info(
    `Discovered ${info.envVars.length} rewritable env var(s): ` +
      info.envVars.map((v) => `${v.name}[${v.role}]`).join(", ")
  );
  if (info.hardcodedHosts.length) {
    log.warn(
      `Hardcoded hosts (not env-patchable, served via passthrough): ${info.hardcodedHosts.join(", ")}`
    );
  }

  const session: SessionMeta = {
    id: makeSessionId(opts.org, opts.repo, branch),
    org: opts.org,
    repo: opts.repo,
    branch,
    worktree,
    framework: info.framework,
    devCommand: info.devCommand,
    appPort: info.appPort,
    envVars: info.envVars,
    hardcodedHosts: info.hardcodedHosts,
    createdAt: new Date().toISOString(),
  };
  saveSession(session);
  log.success(`Session ready: ${session.id}`);
  return session;
}
