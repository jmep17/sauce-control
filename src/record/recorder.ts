import type { ChildProcess } from "node:child_process";
import { spawnLongRunning, waitForPort } from "../util/run.js";
import { sessionPaths, type SessionMeta } from "../session/store.js";
import { log } from "../util/log.js";

/**
 * Record real network traffic for a session.
 *
 * Boots the app's dev server *unpatched* (against its real backend + Auth0), opens a
 * headed Chromium via Playwright with `routeFromHAR({ update: true })` matching every
 * request, and lets the user click through the flows they want mocked. Closing the
 * browser (or Ctrl-C) flushes the captured HAR to the session dir.
 */
export async function recordSession(session: SessionMeta): Promise<void> {
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

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });

    // Capture EVERYTHING to the HAR, with full response bodies embedded.
    await context.routeFromHAR(har, {
      url: "**",
      update: true,
      updateContent: "embed",
      updateMode: "full",
    });

    const page = await context.newPage();
    await page.goto(appUrl);

    log.success(
      "Recording. Log in and click through the flows you want mocked."
    );
    log.info(
      "Close the browser window (or press Ctrl-C here) to finish and save the HAR."
    );

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      browser.on("disconnected", finish);
      context.on("close", finish);
      process.once("SIGINT", finish);
    });

    // Flush HAR: closing the context/browser writes the recorded file.
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    log.success(`Saved recording → ${har}`);
  } finally {
    cleanupDev();
  }
}
