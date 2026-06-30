# stardust web app — production deploy (M6 D)

The app has three planes; only the first deploys to Cloudflare. The "hands"
(Docker sandbox + runner) run Docker, which Cloudflare Workers can't — so they
live elsewhere (see §6, the one real decision).

```
Browser ── Cloudflare Worker (UI + API + DO + D1 + R2)  ← `wrangler deploy`
                 │  RUNNER_URL (https)        ▲ ingest (https, public origin)
                 ▼                            │
         the "hands": runner.mjs + Docker (VM / Cloudflare Containers / tunnel)
```

Nothing here is code — the codebase already derives OAuth redirects from the
request origin, sets Secure cookies on HTTPS, picks GitHub `_PROD` creds
off-localhost, and reads every runner/ingest URL from env.

---

## 1. Prereqs
- `wrangler login` (your Cloudflare account).
- A domain (or use the `*.workers.dev` subdomain to start).

## 2. Provision remote storage (once)
```bash
cd app/web
# D1
wrangler d1 create stardust-web-db          # copy the printed database_id
# R2
wrangler r2 bucket create stardust-web-artifacts
```
The real D1 id goes in `wrangler.jsonc` under `env.production` (local dev keeps
the top-level placeholder + its own local store). Apply migrations to the REMOTE
prod db:
```bash
wrangler d1 migrations apply stardust-web-db --remote --env production
```

**Live deploy:** https://stardust-web-production.paolo-moz.workers.dev
(account 2760892a…, D1 b762e4ba…, worker `stardust-web-production`).

## 3. Worker secrets (prod)
The Worker needs OAuth + the Haiku-ETA key + where the hands live. Each prompts
for the value (you paste it); always pass `--env production`:
```bash
wrangler secret put GOOGLE_CLIENT_ID --env production
wrangler secret put GOOGLE_CLIENT_SECRET --env production
wrangler secret put GITHUB_CLIENT_ID_PROD --env production
wrangler secret put GITHUB_CLIENT_SECRET_PROD --env production
wrangler secret put ANTHROPIC_API_KEY --env production    # per-task ETA estimate
wrangler secret put RUNNER_URL --env production            # hands endpoint (after §6)
```
(GitHub `_DEV` creds are only needed locally; `_PROD` is used off-localhost.)
Model keys (BEDROCK_API_KEY / CEREBRAS_API_KEY) do NOT go on the Worker — they
live on the runner host (§6), which injects them into containers.

## 4. Deploy
The `@cloudflare/vite-plugin` picks the wrangler environment from `CLOUDFLARE_ENV`
(NOT `--env`), so both build and deploy need it:
```bash
CLOUDFLARE_ENV=production npx vite build
CLOUDFLARE_ENV=production npx wrangler deploy
```
This deploys the `stardust-web-production` worker at
`https://stardust-web-production.paolo-moz.workers.dev`. Add a custom domain later
via the dash (Workers → the worker → Domains & Routes); update the OAuth callbacks
to the custom origin if you do.

## 5. OAuth prod callbacks (your consoles)
Origin = `https://stardust-web-production.paolo-moz.workers.dev` (or your custom domain).
- **Google** (one client): add redirect URI
  `https://stardust-web-production.paolo-moz.workers.dev/auth/google/callback`
  (keep the localhost one for dev). If the consent screen is still "Testing", add
  your users as Test users or publish the app.
- **GitHub** (`_PROD` app): set its Authorization callback URL to
  `https://stardust-web-production.paolo-moz.workers.dev/auth/github/callback`.

## 6. The hands — Cloudflare Containers (chosen)
Prod runs the sandbox image on **Cloudflare Containers** (`standard-2`,
`sleepAfter: 45m`, `max_instances: 100`). The Worker's `SandboxContainer` DO
(`src/worker/sandbox.ts`) injects the model keys + `PUBLIC_ORIGIN` as container
env; the in-container `runtime/server.mjs` receives each job and runs
`agent.mjs`. The DO uses the Container when `env.SANDBOX` is bound (prod) and
falls back to the host `runner.mjs` locally. (The `image` build context is
`../sandbox/`, so the skills + runtime must be staged into it first.)

**Set the model-key secrets** (prod):
```bash
wrangler secret put BEDROCK_API_KEY --env production
# optional overrides: BEDROCK_MODEL, BEDROCK_REGION
# optional Cerebras path: CEREBRAS_API_KEY (+ CEREBRAS_MODEL)
```
(`PUBLIC_ORIGIN` is a plain var already set in `wrangler.jsonc`; update it if you
move to a custom domain.)

**Build + deploy** (wrangler builds & pushes the ~3.5 GB image — first push is slow):
```bash
cd app && STAGE_ONLY=1 ./sandbox/build.sh        # stage skills + runtime into sandbox/
cd web && CLOUDFLARE_ENV=production npx vite build
CLOUDFLARE_ENV=production npx wrangler deploy     # builds the image, deploys the container
```

**Verify:** start a run on the live site → a container spawns, ingest flows back,
screens advance, a published variant opens at `/p/<token>`.

> Iteration (the workspace "tell me a change") needs run inputs restored from R2
> because container disk is ephemeral — that's a follow-up (R2-backed iterate
> inputs). Fresh runs work without it.

Alternatives if Containers ever don't fit: a self-hosted VM running
`runtime/runner.mjs` (set the Worker's `RUNNER_URL` secret to its public `/run`),
or a `cloudflared` tunnel to your local `:8790` for a quick demo. Both keep the
same ingest contract.

## 7. Smoke test
1. Visit the origin → login (Google/GitHub) works against the prod callbacks.
2. Start a run → the Worker reaches `RUNNER_URL`, a container spawns on the hands,
   ingest flows back to the public origin, screens advance.
3. Publish a variant → `/p/<token>` opens with no session.

## Notes / gotchas
- `INGEST_BASE` must be reachable from the container over the public internet
  (the prod origin), not `host.docker.internal`.
- D1 free tier + DO + R2 are within typical limits for low volume; watch R2
  storage as artifacts accumulate.
- Each Bedrock run is real spend (~$50-80); consider a per-user run cap before
  opening signups widely.
