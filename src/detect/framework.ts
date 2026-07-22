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

// npm consumes flags itself unless they're behind `--`; pnpm forwards a
// literal `--` to the script (Next.js then reads `-p` as its project-directory
// positional), and pnpm/yarn/bun all forward flags fine without a separator.
const PASSTHROUGH_SEP: Record<PackageManager, string[]> = {
  pnpm: [],
  yarn: [],
  npm: ["--"],
  bun: [],
};

const DEV_NAME_ORDER = ["dev", "develop", "start", "serve"];

/** Does this script body actually launch the framework's dev server? */
function isDevServerScript(body: string, framework: Framework): boolean {
  if (framework === "nextjs") {
    const m = /\bnext\b(?:\s+([a-z]+))?/.exec(body);
    return m !== null && m[1] === "dev";
  }
  if (framework === "vite") {
    // Bare `vite` (or `vite dev`/`vite serve`) starts the dev server; only
    // subcommands like build/preview don't.
    const m = /\bvite\b(?:\s+([a-z]+))?/.exec(body);
    return (
      m !== null && (m[1] === undefined || ["dev", "serve"].includes(m[1]))
    );
  }
  return false;
}

/**
 * Pick the dev script by content — whichever script invokes the framework's
 * dev server, whatever it's named — falling back to conventional names.
 */
function pickDevScript(
  scripts: Record<string, string>,
  framework: Framework
): string {
  const names = Object.keys(scripts);
  const matches = Object.entries(scripts)
    .filter(([, body]) => isDevServerScript(body, framework))
    .map(([name]) => name);
  for (const preferred of DEV_NAME_ORDER) {
    if (matches.includes(preferred)) return preferred;
  }
  const [firstMatch] = matches;
  if (firstMatch) return firstMatch;
  for (const preferred of DEV_NAME_ORDER) {
    if (names.includes(preferred)) return preferred;
  }
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

  const script = pickDevScript(scripts, framework);
  // Force a deterministic port so we can point Playwright / the browser at it.
  const portFlag =
    framework === "nextjs"
      ? ["-p", String(appPort)]
      : framework === "vite"
        ? ["--port", String(appPort), "--strictPort"]
        : [];
  const devCommand = [
    ...RUN_PREFIX[pm],
    script,
    ...(portFlag.length > 0 ? PASSTHROUGH_SEP[pm] : []),
    ...portFlag,
  ];

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
