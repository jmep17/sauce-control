import fs from "node:fs";
import path from "node:path";
import type { Framework } from "../session/store.js";
import {
  detectPackageManager,
  type PackageManager,
} from "../worktree/checkout.js";
import { scanEnv } from "./env-scan.js";

export interface FrameworkInfo {
  framework: Framework;
  packageManager: PackageManager;
  /** Command to launch the dev server, e.g. ["pnpm","run","dev"]. */
  devCommand: string[];
  /** Default port the dev server listens on. */
  appPort: number;
  envVars: ReturnType<typeof scanEnv>["envVars"];
  hardcodedHosts: string[];
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function readPackageJson(worktree: string): PackageJson {
  const p = path.join(worktree, "package.json");
  if (!fs.existsSync(p)) throw new Error(`no package.json in ${worktree}`);
  return JSON.parse(fs.readFileSync(p, "utf8")) as PackageJson;
}

const RUN_PREFIX: Record<PackageManager, string[]> = {
  pnpm: ["pnpm", "run"],
  yarn: ["yarn"],
  npm: ["npm", "run"],
  bun: ["bun", "run"],
};

/** Pick the dev script, preferring `dev` then `start`. */
function pickDevScript(scripts: Record<string, string>): string {
  if (scripts.dev) return "dev";
  if (scripts.start) return "start";
  if (scripts.serve) return "serve";
  return "dev";
}

export function detectFramework(worktree: string): FrameworkInfo {
  const pkg = readPackageJson(worktree);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  const pm = detectPackageManager(worktree);

  let framework: Framework = "unknown";
  let appPort = 3000;
  if (deps.next) {
    framework = "nextjs";
    appPort = 3000;
  } else if (deps.vite) {
    framework = "vite";
    appPort = 5173;
  }

  const script = pickDevScript(scripts);
  // Force a deterministic port so we can point Playwright / the browser at it.
  const portFlag =
    framework === "nextjs"
      ? ["--", "-p", String(appPort)]
      : framework === "vite"
        ? ["--", "--port", String(appPort), "--strictPort"]
        : [];
  const devCommand = [...RUN_PREFIX[pm], script, ...portFlag];

  const { envVars, hardcodedHosts } = scanEnv(worktree);

  return {
    framework,
    packageManager: pm,
    devCommand,
    appPort,
    envVars,
    hardcodedHosts,
  };
}
