import { Octokit } from "@octokit/rest";
import { tryRun } from "../util/run.js";
import { UserError } from "../util/log.js";

export interface RepoSummary {
  name: string;
  fullName: string;
  defaultBranch: string;
  cloneUrl: string;
  private: boolean;
  archived: boolean;
  pushedAt: string | null;
}

let cachedToken: string | null | undefined;

/** Resolve a GitHub token: GITHUB_TOKEN/GH_TOKEN env, then `gh auth token`. */
export async function resolveToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return (cachedToken = fromEnv);

  const gh = await tryRun("gh", ["auth", "token"]);
  const token = gh?.stdout.trim();
  if (token) return (cachedToken = token);

  throw new UserError(
    "No GitHub token found. Set GITHUB_TOKEN, or run `gh auth login` (needs the `gh` CLI)."
  );
}

async function client(): Promise<Octokit> {
  return new Octokit({ auth: await resolveToken() });
}

/** List all repos for an org (or a user, as a fallback), paginated. */
export async function listOrgRepos(org: string): Promise<RepoSummary[]> {
  const octokit = await client();
  const map = (r: {
    name: string;
    full_name: string;
    default_branch?: string;
    clone_url?: string | null;
    private?: boolean;
    archived?: boolean;
    pushed_at?: string | null;
  }): RepoSummary => ({
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch ?? "main",
    cloneUrl: r.clone_url ?? `https://github.com/${r.full_name}.git`,
    private: r.private ?? false,
    archived: r.archived ?? false,
    pushedAt: r.pushed_at ?? null,
  });

  try {
    const repos = await octokit.paginate(octokit.repos.listForOrg, {
      org,
      per_page: 100,
      type: "all",
      sort: "pushed",
    });
    return repos.map(map);
  } catch (err: unknown) {
    // Fall back to treating the name as a user account.
    if (isNotFound(err)) {
      const repos = await octokit.paginate(octokit.repos.listForUser, {
        username: org,
        per_page: 100,
        sort: "pushed",
      });
      return repos.map(map);
    }
    throw err;
  }
}

/** List branch names for a repo. */
export async function listBranches(
  org: string,
  repo: string
): Promise<string[]> {
  const octokit = await client();
  const branches = await octokit.paginate(octokit.repos.listBranches, {
    owner: org,
    repo,
    per_page: 100,
  });
  return branches.map((b) => b.name);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: number }).status === 404
  );
}
