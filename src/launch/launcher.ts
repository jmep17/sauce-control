import type { ChildProcess } from "node:child_process";
import {
  spawnLongRunning,
  waitForPort,
  freePort,
  tryRun,
} from "../util/run.js";
import { ensureDeps } from "../worktree/checkout.js";
import { startProxy } from "../proxy/server.js";
import { patchEnv } from "../patch/env.js";
import { saveSession, type SessionMeta } from "../session/store.js";
import { log } from "../util/log.js";

/**
 * Launch the app fully mocked: assign a proxy port, start the mock proxy, patch the
 * worktree's `.env.local` to point at it, then run the dev server against it and open
 * the app. Runs until Ctrl-C.
 */
export async function launchMocked(session: SessionMeta): Promise<void> {
  if (session.proxyPort == null) {
    session.proxyPort = await freePort();
    saveSession(session);
  }

  // Robust to a wiped worktree: a standalone `launch` may run long after `record`.
  await ensureDeps(session.worktree);

  const proxy = await startProxy(session);
  patchEnv(session);

  const appUrl = `http://localhost:${session.appPort}`;
  log.step(`Starting patched dev server: ${session.devCommand.join(" ")}`);
  const [cmd, ...args] = session.devCommand;
  const dev: ChildProcess = spawnLongRunning(cmd!, args, {
    cwd: session.worktree,
    env: {
      ...process.env,
      PORT: String(session.appPort),
      BROWSER: "none",
      // Let SSR/Node fetches trust the proxy's self-signed cert (dev only).
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
  });

  const shutdown = async () => {
    if (!dev.killed) dev.kill("SIGTERM");
    await proxy.close().catch(() => {});
  };
  dev.on("exit", (code) => {
    log.warn(`dev server exited (${code})`);
    void proxy.close().catch(() => {});
  });

  try {
    await waitForPort(session.appPort);
    log.success(`App running mocked at ${appUrl}`);
    log.info(`All Auth0 + API traffic is served by the proxy at ${proxy.url}`);
    await openBrowser(appUrl);

    await new Promise<void>((resolve) => process.once("SIGINT", resolve));
    log.info("Shutting down…");
  } finally {
    await shutdown();
  }
}

async function openBrowser(url: string): Promise<void> {
  const opener =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  await tryRun(opener[0] as string, opener[1] as string[]);
}
