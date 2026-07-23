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
   every response is appended to the session HAR **as it arrives**, so the recording
   survives closing the browser or Ctrl-C at any point while you click through the
   flows you want mocked. With `--auto`, the tool explores the app for you after
   you log in (see **Auto-record** below).
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
sauce-control record <org>/<repo> --auto     # …and auto-crawl every route
sauce-control record <org>/<repo> --auto ai  # …with a local LLM clicking tabs/filters
sauce-control launch <sessionId>             # patch env + run mocked
sauce-control up <org>/<repo>                # record + launch in one go
sauce-control sessions                       # list recorded sessions
```

## Auto-record

`--auto` takes over after you log in (it waits until the browser settles back on the
app's origin) and records with no further clicking:

- **`--auto` / `--auto crawl`** — deterministic, free, offline. Seeds a BFS with the
  app's statically-enumerated Next.js routes (globbed straight from the worktree),
  harvests same-origin links from each rendered page, and hooks
  `history.pushState` so programmatic navigations are discovered too. Guardrails:
  GET navigation only, never clicks buttons or submits forms, skips
  logout/delete-looking URLs and the Auth0 host, caps pages (`--max-pages`, default 50) and visits per dynamic-route shape (`/orders/:id` ×3).
- **`--auto ai`** — everything above, plus a **local** LLM (Ollama by default —
  no cloud) decides per page which tabs, filters, paginators, and search boxes to
  exercise, steering toward API endpoints not yet in the recording. The model only
  ever picks from a menu of elements the tool extracted itself, and every proposal
  passes hard in-code safety checks (destructive-text blocklist; non-GET form
  submits require `--allow-mutations`) — a wrong model answer can waste a click,
  never fire a delete. `--llm-url` / `--llm-model` override the endpoint
  (any OpenAI-compatible `/v1` base works); by default the model is auto-picked
  from your installed Ollama models (qwen preferred).

Either way the browser stays open afterwards — anything the crawler couldn't reach
(multi-step forms, modals behind mutations) you can still click through by hand, and
it lands in the same HAR.

Every AI decision (page, candidate menu, model output, what was executed) is
appended to `sessions/<id>/decisions.jsonl` — a ready-made SFT dataset if you later
want to fine-tune a small local model on your own exploration traces (e.g. with
`mlx_lm.lora` on Apple Silicon).

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
- **Service Worker traffic** doesn't surface as page-context responses and isn't
  captured; most SPA API calls run on the page context and are captured fine.
- You must have the repo's real `.env` / credentials available to do the initial
  recording.

## Development

```bash
pnpm dev repos <org>   # run from source with tsx
pnpm test              # unit tests (env classifier, JWT/JWKS, HAR matcher)
pnpm typecheck
```
