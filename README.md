# sauce-control

Take any Auth0-backed repo in a GitHub org, record its real network traffic once, then
relaunch it **fully offline** against a local mock proxy — with login working end-to-end.

Front-end apps (Next.js, Vite SPAs) that depend on a live backend and a real Auth0 tenant
are painful to run in isolation. `sauce-control` records the real thing once, then serves
it all back from a self-issuing mock proxy so you can `clone → run` with no backend and no
credentials — for demos, offline dev, UI work, or deterministic tests.

## How it works

1. **List & pick** — browse an org's repos, choose a repo + branch.
2. **Worktree** — mirror-clone once, `git worktree add` the branch into an isolated dir.
   All patches land here, never on your real checkout.
3. **Record** — run the app against the real backend + Auth0 in a headed Chromium;
   Playwright's `routeFromHAR({ update: true })` captures **everything** to a HAR while
   you click through the flows you want mocked.
4. **Mock proxy (HTTPS)** — replays the HAR; a fake Auth0 (`/authorize`, `/oauth/token`,
   `/.well-known/jwks.json`) mints valid RS256 JWTs against its own JWKS so login works
   offline and survives token expiry + signature checks; unmatched requests pass through
   to the real backend and get recorded (self-healing mocks).
5. **Patch env** — writes `.env.local` in the worktree repointing the discovered Auth0 and
   API-base env vars at the proxy, then relaunches the app against it.

## Install

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
```

Provide a GitHub token via `GITHUB_TOKEN`, or `gh auth login` (the CLI shells out to
`gh auth token`).

## Usage

```bash
# Interactive wizard (org → repo → branch → record → launch)
sauce-control

# Or step by step:
sauce-control repos <org>                    # list repos
sauce-control record <org>/<repo> -b <branch>  # worktree + record HAR
sauce-control launch <sessionId>             # patch env + run mocked
sauce-control up <org>/<repo>                # record + launch in one go
sauce-control sessions                       # list recorded sessions
```

State lives under `~/.sauce-control/` (override with `SAUCE_CONTROL_HOME`):

- `repos/<org>/<repo>.git` — bare mirror clone
- `worktrees/<org>/<repo>/<branch>/` — checked-out worktree (patched here)
- `sessions/<id>/` — `traffic.har`, `session.json`, `signing-key.json`, `ca/`

## Notes & limitations

- **HTTPS is required** for the SPA case: Auth0 SPA SDKs force `https://<domain>`, so the
  proxy runs TLS with a self-signed cert. The browser trusts it via `ignoreHTTPSErrors`
  and SSR fetches via `NODE_TLS_REJECT_UNAUTHORIZED=0` (dev only).
- **Env var names vary per repo**, so they're discovered by scanning `.env*` files and
  `process.env` / `import.meta.env` references, then classified. Review the map in
  `session.json` before launching.
- **Hardcoded absolute API URLs** (not env-driven) can't be repointed via env — they're
  served through passthrough+record instead, and reported during `prepare`.
- **Service Worker traffic** isn't intercepted by `routeFromHAR`; most SPA API calls run
  on the page context and are captured fine.
- You must have the repo's real `.env` / credentials available to do the initial
  recording.

## Development

```bash
pnpm dev repos <org>   # run from source with tsx
pnpm test              # unit tests (env classifier, JWT/JWKS, HAR matcher)
pnpm typecheck
```
