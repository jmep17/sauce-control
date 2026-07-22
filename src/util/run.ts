import {
  spawn,
  type SpawnOptions,
  type ChildProcess,
} from "node:child_process";
import net from "node:net";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, capturing output. Rejects on non-zero exit. */
export function run(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const result: RunResult = { code: code ?? -1, stdout, stderr };
      if (code === 0) resolve(result);
      else
        reject(
          Object.assign(
            new Error(`${cmd} ${args.join(" ")} exited ${code}\n${stderr}`),
            {
              result,
            }
          )
        );
    });
  });
}

/** Try a command; return null instead of throwing (for optional tools like `gh`). */
export async function tryRun(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {}
) {
  try {
    return await run(cmd, args, opts);
  } catch {
    return null;
  }
}

/** Spawn a long-running process with inherited-but-labeled output streaming to stderr. */
export function spawnLongRunning(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {}
): ChildProcess {
  return spawn(cmd, args, { ...opts, stdio: ["ignore", "inherit", "inherit"] });
}

/** Find a free TCP port on localhost. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine free port")));
      }
    });
  });
}

/** Poll until a TCP port accepts connections, or time out. */
export async function waitForPort(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host }, () => {
        sock.end();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.setTimeout(1000, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for port ${port}`);
}
