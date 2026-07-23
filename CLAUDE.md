# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`sauce-control` is a CLI that records the real network traffic of an Auth0-backed repo
(Next.js or Vite SPA) once, then relaunches that repo **fully offline** against a local
mock proxy — including a working Auth0 login. See `README.md` for the user-facing pitch.

## Commands

This project uses **pnpm** (`packageManager` is pinned; pnpm 10 blocks dependency build
scripts, so `esbuild` is allow-listed under `pnpm.onlyBuiltDependencies`).

```bash
pnpm install
pnpm exec playwright install chromium   # one-time, needed for the record flow
pnpm build            # tsup → dist/cli.js (bin: sauce-control)
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run (all)
pnpm exec vitest run tests/keys.test.ts          # single test file
pnpm exec vitest run -t "matches by method"      # single test by name
pnpm dev <args>       # run the CLI from source via tsx, e.g. `pnpm dev repos my-org`
```

## The pipeline (the mental model)

Everything is organized around a **session** (`SessionMeta` in `src/session/store.ts`),
persisted to `~/.sauce-control/sessions/<id>/`. The end-to-end flow is a sequence of
steps that the CLI commands compose:

```
prepare → record → (serve + patch) → launch
```

- **`prepare`** (`src/commands/prepare.ts`): resolve repo → mirror-clone + `git worktree add`
  the branch (`worktree/checkout.ts`) → install deps → detect framework + discover env vars
  (`detect/`) → save session. Shared by `record` and `up`.
- **`record`** (`record/recorder.ts`): runs the app's dev server **unpatched** (real
  backend + Auth0) and captures all traffic via `context.on("response")` into the
  session HAR (`record/har-recorder.ts`), persisted incrementally — never via
  `routeFromHAR({ update: true })`, which loses the HAR unless the context closes
  gracefully. `--auto [crawl|ai]` auto-explores after login (`record/auto.ts`).
- **`launch`** (`launch/launcher.ts`): starts the proxy, patches the worktree env to point
  at it, runs the dev server against it. `up` = prepare + record + launch.

Command → step mapping lives in `src/cli.ts` (Commander subcommands + a `@clack/prompts`
wizard when invoked with no args).

## Key architectural facts (non-obvious, cross-file)

- **Two package-manager contexts — don't conflate.** This tool runs on pnpm. The _target
  repo's_ package manager is auto-detected from its lockfile by `detectPackageManager()`
  and used to install/run the cloned app. Changing this tool's PM does not affect targets.

- **The proxy routes requests in a fixed priority** (`proxy/server.ts` → `handleRequest`):
  first Auth0 endpoints (`proxy/auth0.ts`), then HAR replay (`proxy/har-store.ts`), then on
  a miss it passes through to the inferred backend origin **and records** into the HAR (self-healing).

- **Self-issued Auth0 is the core trick.** The proxy mints RS256 JWTs signed by a key it
  also serves at `/.well-known/jwks.json` (`proxy/keys.ts`), so replayed logins survive
  signature + expiry checks. The login profile is seeded from a recorded `/userinfo` if one
  exists in the HAR.

- **HTTPS is mandatory**, because Auth0 SPA SDKs force `https://<domain>`. The proxy runs
  TLS with a self-signed cert (`proxy/cert.ts`); the browser trusts it via
  `ignoreHTTPSErrors` and SSR/Node fetches via `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev only).

- **Env-var handling is name-agnostic.** Repos name Auth0/API vars differently, so
  `detect/env-scan.ts` discovers them (scanning `.env*` + `process.env`/`import.meta.env`
  refs) and `classifyEnvVar` assigns a role. Roles drive `rewriteValue` in `patch/env.ts`,
  which writes `.env.local` in the worktree. `classifyEnvVar` is pure and unit-tested —
  keep it that way. `patch/env.ts` has a guardrail: it refuses to write outside
  `WORKTREES_DIR`.

- **Playwright is a lazy peer dep.** `recorder.ts` imports it via dynamic `import()`, and
  tsup marks it `external` — never import it at module top level (`import type` is fine;
  `record/auto.ts` relies on that).

- **Auto-explore is layered: pure engines + thin Playwright glue.** `record/crawler.ts`
  (BFS, URL safety, route-shape caps) and `record/explorer.ts` (per-page AI step) are
  playwright-free and unit-tested against fakes; `record/auto.ts` adapts a real Page and
  composes them with static route enumeration (`detect/routes.ts`) and pushState capture.
  The LLM (`llm/policy.ts`) is **policy, not authority**: it picks from a candidate menu
  the tool built, and every proposal re-passes in-code checks (`UNSAFE_PATTERN`, GET-only
  form gating) — model output must never gain a capability code didn't already allow.

- **Local-LLM quirks are handled in `llm/policy.ts` — keep them there.** Requests go to
  Ollama natively with `think: false` (reasoning models otherwise take minutes per
  decision; retried without the field for models that reject it). Ollama 0.31 silently
  drops the `format` schema constraint when `think: false`, so the schema is also shown
  in the prompt and `parseDecision` is strict, with one corrective retry on shape
  mismatch. AI decisions append to `sessions/<id>/decisions.jsonl` (a future SFT set).

## Conventions

- ESM + NodeNext throughout: **intra-repo imports must use `.js` extensions** in TS source.
- `SAUCE_CONTROL_HOME` overrides the `~/.sauce-control` state root — used to isolate tests.
- `tests/` is excluded from the tsc build; unit tests target pure/verifiable units
  (env classifier, JWT↔JWKS round-trip, HAR matcher). The record→launch loop needs a real
  repo + GitHub token + runnable app and isn't unit-tested.
