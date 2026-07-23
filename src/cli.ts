import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { listOrgRepos, listBranches } from "./github/repos.js";
import { prepare } from "./commands/prepare.js";
import { recordSession, type RecordOptions } from "./record/recorder.js";
import { launchMocked } from "./launch/launcher.js";
import { startProxy } from "./proxy/server.js";
import { loadSession, listSessions, saveSession } from "./session/store.js";
import { freePort } from "./util/run.js";
import { log, UserError } from "./util/log.js";

function parseSlug(slug: string): { org: string; repo: string } {
  const [org, repo] = slug.split("/");
  if (!org || !repo)
    throw new UserError(`Expected <org>/<repo>, got '${slug}'`);
  return { org, repo };
}

interface RecordCliOpts {
  branch?: string;
  skipInstall?: boolean;
  auto?: string | boolean;
  llmUrl?: string;
  llmModel?: string;
  allowMutations?: boolean;
  maxPages?: string;
}

function toRecordOptions(opts: RecordCliOpts): RecordOptions {
  if (opts.auto === undefined) return {};
  const mode = opts.auto === true ? "crawl" : opts.auto;
  if (mode !== "crawl" && mode !== "ai")
    throw new UserError(
      `--auto expects 'crawl' or 'ai', got '${String(mode)}'`
    );
  return {
    auto: mode,
    ...(opts.llmUrl !== undefined ? { llmUrl: opts.llmUrl } : {}),
    ...(opts.llmModel !== undefined ? { llmModel: opts.llmModel } : {}),
    ...(opts.allowMutations ? { allowMutations: true } : {}),
    ...(opts.maxPages !== undefined ? { maxPages: Number(opts.maxPages) } : {}),
  };
}

function addRecordFlags(cmd: Command): Command {
  return cmd
    .option(
      "--auto [mode]",
      "auto-explore after login: 'crawl' (link BFS, default) or 'ai' (crawl + local LLM)"
    )
    .option(
      "--llm-url <url>",
      "LLM endpoint for --auto ai (default: local Ollama, http://localhost:11434)"
    )
    .option(
      "--llm-model <model>",
      "model for --auto ai (default: auto-detected from installed models)"
    )
    .option("--allow-mutations", "let --auto ai submit non-search (POST) forms")
    .option("--max-pages <n>", "auto-explore page cap (default 50)");
}

const program = new Command();
program
  .name("sauce-control")
  .description(
    "Record an Auth0-backed repo's network traffic, then relaunch it fully offline against a self-issuing mock proxy."
  )
  .version("0.1.0")
  .showHelpAfterError("(run `sauce-control --help` to see all commands)")
  .addHelpText(
    "after",
    `
${pc.bold("Examples:")}
  ${pc.dim("$")} sauce-control                        ${pc.dim("# guided wizard (org → repo → branch)")}
  ${pc.dim("$")} sauce-control repos my-org
  ${pc.dim("$")} sauce-control up my-org/web -b main   ${pc.dim("# record + launch in one go")}
  ${pc.dim("$")} sauce-control launch <sessionId>
  ${pc.dim("$")} sauce-control sessions

Run with no arguments to launch the interactive wizard.`
  );

program
  .command("repos")
  .argument("<org>", "GitHub org (or user) to list repos for")
  .description("List repositories in an organization")
  .action(async (org: string) => {
    const repos = await listOrgRepos(org);
    for (const r of repos) {
      const tags = [
        r.private ? pc.yellow("private") : null,
        r.archived ? pc.dim("archived") : null,
      ]
        .filter(Boolean)
        .join(" ");
      console.log(`${pc.bold(r.name)}  ${pc.dim(r.defaultBranch)}  ${tags}`);
    }
    log.info(`${repos.length} repos`);
  });

addRecordFlags(
  program
    .command("record")
    .argument("<slug>", "<org>/<repo>")
    .option("-b, --branch <branch>", "branch to check out")
    .option("--skip-install", "skip dependency install")
    .description("Clone a worktree and record real network traffic to a HAR")
).action(async (slug: string, opts: RecordCliOpts) => {
  const { org, repo } = parseSlug(slug);
  const session = await prepare({
    org,
    repo,
    branch: opts.branch,
    skipInstall: opts.skipInstall,
  });
  await recordSession(session, toRecordOptions(opts));
  log.info(`Next: ${pc.cyan(`sauce-control launch ${session.id}`)}`);
});

program
  .command("serve")
  .argument("<sessionId>", "session to serve")
  .description("Start the mock proxy (HTTPS) for a recorded session")
  .action(async (sessionId: string) => {
    const session = loadSession(sessionId);
    if (session.proxyPort == null) {
      session.proxyPort = await freePort();
      saveSession(session);
    }
    const proxy = await startProxy(session);
    log.info("Proxy running. Press Ctrl-C to stop.");
    await new Promise<void>((resolve) => process.once("SIGINT", resolve));
    await proxy.close();
  });

program
  .command("launch")
  .argument("<sessionId>", "session to launch")
  .description("Patch the worktree env to the proxy and run the app mocked")
  .action(async (sessionId: string) => {
    await launchMocked(loadSession(sessionId));
  });

addRecordFlags(
  program
    .command("up")
    .argument("<slug>", "<org>/<repo>")
    .option("-b, --branch <branch>", "branch to check out")
    .option("--skip-install", "skip dependency install")
    .description("Full flow: prepare → record → launch mocked")
).action(async (slug: string, opts: RecordCliOpts) => {
  const { org, repo } = parseSlug(slug);
  const session = await prepare({
    org,
    repo,
    branch: opts.branch,
    skipInstall: opts.skipInstall,
  });
  await recordSession(session, toRecordOptions(opts));
  await launchMocked(session);
});

program
  .command("sessions")
  .description("List recorded sessions")
  .action(() => {
    const sessions = listSessions();
    if (!sessions.length)
      return log.info(
        "No sessions yet. Run `sauce-control record <org>/<repo>`."
      );
    for (const s of sessions) {
      console.log(
        `${pc.bold(s.id)}  ${pc.dim(`${s.org}/${s.repo}@${s.branch}`)}  ${s.framework}`
      );
    }
  });

/** Interactive wizard when invoked with no subcommand. */
async function wizard(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" sauce-control ")));

  const org = await p.text({
    message: "GitHub org (or user)",
    placeholder: "my-org",
    validate: (v) => (v?.trim() ? undefined : "required"),
  });
  if (p.isCancel(org)) return void p.cancel("Cancelled");

  const spin = p.spinner();
  spin.start("Fetching repos");
  const repos = await listOrgRepos(org.trim());
  spin.stop(`${repos.length} repos`);

  // autocomplete = searchable list, so a long repo/branch list is fully reachable
  // by typing to filter rather than scrolling a windowed select.
  const repo = await p.autocomplete<string>({
    message: "Repository",
    placeholder: "type to filter…",
    maxItems: 12,
    options: repos
      .filter((r) => !r.archived)
      .map((r) => ({
        value: r.name,
        label: r.name,
        hint: r.private ? `${r.defaultBranch} · private` : r.defaultBranch,
      })),
  });
  if (p.isCancel(repo)) return void p.cancel("Cancelled");

  spin.start("Fetching branches");
  const branches = await listBranches(org.trim(), repo);
  spin.stop(`${branches.length} branches`);

  const def = repos.find((r) => r.name === repo)?.defaultBranch;
  const branch = await p.autocomplete<string>({
    message: "Branch",
    placeholder: "type to filter…",
    maxItems: 12,
    initialValue: def,
    options: branches.map((b) => ({
      value: b,
      label: b,
      hint: b === def ? "default" : undefined,
    })),
  });
  if (p.isCancel(branch)) return void p.cancel("Cancelled");

  const action = await p.select({
    message: "Action",
    options: [
      { value: "up", label: "Record + launch mocked", hint: "full flow" },
      { value: "record", label: "Record only" },
    ],
  });
  if (p.isCancel(action)) return void p.cancel("Cancelled");

  const auto = await p.select({
    message: "Auto-explore after login?",
    options: [
      {
        value: "crawl",
        label: "Crawl",
        hint: "visit every route automatically",
      },
      {
        value: "ai",
        label: "Crawl + AI",
        hint: "local LLM clicks tabs/filters too (Ollama)",
      },
      { value: "off", label: "Off", hint: "record only what you click" },
    ],
  });
  if (p.isCancel(auto)) return void p.cancel("Cancelled");

  p.note(
    `${pc.bold(`${org.trim()}/${repo}`)} @ ${pc.cyan(branch)}\n` +
      `${action === "up" ? "Record, then launch mocked" : "Record only"}` +
      `${auto === "off" ? "" : ` · auto-explore: ${auto}`}`,
    "Plan"
  );
  p.outro("Starting…");
  const session = await prepare({ org: org.trim(), repo, branch });
  await recordSession(
    session,
    auto === "off" ? {} : { auto: auto as "crawl" | "ai" }
  );
  if (action === "up") await launchMocked(session);
  else log.info(`Next: ${pc.cyan(`sauce-control launch ${session.id}`)}`);
}

async function main() {
  // No subcommand (argv is just [node, cli]): run the wizard.
  if (process.argv.length <= 2) {
    await wizard();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  if (err instanceof UserError) log.error(err.message);
  else log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
