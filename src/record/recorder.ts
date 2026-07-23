import type { ChildProcess } from "node:child_process";
import { spawnLongRunning, waitForPort } from "../util/run.js";
import { sessionPaths, type SessionMeta } from "../session/store.js";
import { HarStore } from "../proxy/har-store.js";
import { attachHarRecorder } from "./har-recorder.js";
import { installNavCapture, runAuto } from "./auto.js";
import { log } from "../util/log.js";

export interface RecordOptions {
  /** Auto-explore after login: "crawl" (link BFS) or "ai" (crawl + local-LLM explorer). */
  auto?: "crawl" | "ai";
  /** LLM endpoint for --auto ai (default: local Ollama). */
  llmUrl?: string;
  /** Model name for --auto ai (default: auto-detected from the endpoint). */
  llmModel?: string;
  /** Let the AI explorer submit non-GET forms. */
  allowMutations?: boolean;
  /** Auto-explore page cap. */
  maxPages?: number;
}

/**
 * Record real network traffic for a session.
 *
 * Boots the app's dev server *unpatched* (against its real backend + Auth0), opens a
 * headed Chromium via Playwright, and lets the user click through the flows they want
 * mocked — optionally auto-exploring the app first (`auto`). Traffic is persisted to
 * the session HAR incrementally as it arrives, so the recording survives however the
 * session ends — window closed, Ctrl-C, or crash.
 */
export async function recordSession(
  session: SessionMeta,
  opts: RecordOptions = {}
): Promise<void> {
  const { har } = sessionPaths(session.id);

  // Playwright is a heavy peer dep; import lazily so the CLI loads fast.
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "Playwright is not installed. Run `pnpm add -D playwright && pnpm exec playwright install chromium`."
    );
  }

  const appUrl = `http://localhost:${session.appPort}`;
  log.step(`Starting dev server: ${session.devCommand.join(" ")}`);
  const [cmd, ...args] = session.devCommand;
  const dev: ChildProcess = spawnLongRunning(cmd!, args, {
    cwd: session.worktree,
    env: { ...process.env, BROWSER: "none", PORT: String(session.appPort) },
  });

  const cleanupDev = () => {
    if (!dev.killed) dev.kill("SIGTERM");
  };

  try {
    log.step(`Waiting for app on ${appUrl} …`);
    await waitForPort(session.appPort);

    // handleSIGINT: false — Ctrl-C must reach our finish handler below, not
    // Playwright's default browser-killer.
    const browser = await chromium.launch({
      headless: false,
      handleSIGINT: false,
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });

    // Nav capture must be installed before the first page exists.
    const navBuffer = opts.auto ? await installNavCapture(context) : [];

    // Capture everything, persisted incrementally as responses arrive.
    const store = new HarStore(har);
    const recorder = attachHarRecorder(context, store);

    let finished = false;
    const finishPromise = new Promise<void>((resolve) => {
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      browser.on("disconnected", finish);
      context.on("close", finish);
      process.once("SIGINT", finish);
    });

    const page = await context.newPage();
    await page.goto(appUrl);

    log.success(
      "Recording. Log in and click through the flows you want mocked."
    );
    log.info(
      "Close the browser window (or press Ctrl-C here) to finish and save the HAR."
    );

    if (opts.auto) {
      await Promise.race([
        runAuto({
          page,
          session,
          store,
          navBuffer,
          opts: {
            mode: opts.auto,
            ...(opts.llmUrl !== undefined ? { llmUrl: opts.llmUrl } : {}),
            ...(opts.llmModel !== undefined ? { llmModel: opts.llmModel } : {}),
            ...(opts.allowMutations !== undefined
              ? { allowMutations: opts.allowMutations }
              : {}),
            ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
            shouldStop: () => finished,
          },
        }).catch((err) => {
          log.warn(`Auto-explore failed: ${(err as Error).message}`);
        }),
        finishPromise,
      ]);
      if (!finished) {
        log.info(
          "You can keep clicking to record more, or close the browser / Ctrl-C to finish."
        );
      }
    }

    await finishPromise;

    recorder.flush();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    if (store.size > 0) {
      log.success(`Saved recording (${store.size} requests) → ${har}`);
    } else {
      log.warn(
        `No traffic was captured — ${har} is empty. Did the app load in the browser?`
      );
    }
  } finally {
    cleanupDev();
  }
}
