# stardust web app — build summary (2026-07-02)

What exists now, end to end: **paste a URL → three redesign variants → iterate
by chat → prototype the site's other pages → deploy to AEM Edge Delivery →
roll out the whole site, live** — every rung real, driven from the browser,
running locally against real Opus-on-Bedrock and a real EDS project.

## The ladder, rung by rung

### 1. Uplift (parallel pipeline)
Paste a URL. Phase 1 (one container) extracts the live brand and composes
three directions; the Durable Object then fans out **one build container per
variant**, each crafting its page through impeccable from the shared workspace
bundle. The Overview board advances deterministically (a workspace watcher
emits markers the moment each phase's artifact lands — no more waiting on the
model to announce itself), progress is monotonic, and the ETA self-calibrates
per pipeline version. The run completes when the build fan-out drains, with
whatever variants actually delivered (verified against R2, not trusted from
milestones).

### 2. Directions & workspace (existing, hardened)
The gallery takes extra directions from chat (variant D, E, …); the workspace
iterates the active variant conversationally. Iteration state, the task
board, and the terminal flag now survive DO eviction; the client WebSocket
auto-reconnects, so a 30-minute run can't strand the UI.

### 3. Prototype (other pages)
Page candidates are discovered LLM-free from the captured link inventory;
selected pages render as parallel template jobs in the pinned direction.

### 4. Deploy (NEW)
One command converts finished prototypes into a real **Edge Delivery site**:
- An LLM conversion job applies the distilled contract in
  `runtime/eds-deploy-guide.md`: **one prototype section = one EDS block**
  (shared across pages), content as DA body fragments obeying the ENCODE
  contract, tokens/base into `styles.css`, images onto the code bus — all
  written as an `_eds/` bundle with a machine manifest.
- The deterministic host publisher (`runtime/eds-publish.mjs`, zero LLM) then:
  pushes the code to a **per-project branch** of
  `github.com/paolomoz/stardust-sendto-aem` (gh-authenticated), forces AEM Code
  Sync and polls a commit marker, sanitises + PUTs every fragment to the
  **per-project DA folder** (IMS service token minted by `runtime/da-token.mjs`
  from `DA_CLIENT_ID/DA_CLIENT_SECRET/DA_SERVICE_TOKEN`), waits for images to
  be live, POSTs
  previews, and verifies each `.plain.html` for ingestion errors.
- The deploy screen shows the target (branch · folder · variant), a per-page
  ledger (converting → pushing → previewed → live) with preview links and a
  live iframe, plus **Deploy to preview / Go live / Roll out whole site**.

### 5. Rollout (NEW)
"Roll out whole site" prototypes every remaining discovered page (parallel
template jobs under the runner's concurrency cap), then runs one incremental
deploy conversion (reusing the existing block system) and publishes
**everything to aem.live**. The continuation is stateless — recomputed from
persisted template/deploy state on every event — so it survives DO eviction
mid-rollout.

## Conventions

One stardust project = one code branch + one DA content folder, both named by
the site's host slug (`wheelercat-com`, `festool-com`, …), sized to the
63-char branch-host limit. Pages live at
`https://<slug>--stardust-app-fable--paolomoz.aem.page/<slug>/<page>` (and
`.aem.live` once published). Nav + footer ship as per-project DA fragments.

## Validated on the four test sites (2026-07-02, all local)

| Site | Result |
|---|---|
| wheelercat.com | Full ladder: parallel uplift 31.1m (incl. one worker retry; ~21m natural) → home deployed to preview at 39.6m → **whole site (13 pages) LIVE on aem.live at ~74m**, 0 ingestion errors across all pages |
| festool.com | Parallel uplift **29.2m clean** (3 variants, zero intervention) → home deployed to EDS preview, 0 errors, 19 editorial images |
| hirslanden.ch | Parallel uplift **33.8m clean** — while sharing the machine with the wheelercat rollout + virginatlantic (all healthy deliverables: A 35.8KB · B 40.8KB · C 54.6KB) |
| virginatlantic.com | Parallel uplift **27.0m clean** under the same concurrent load (A 39.1KB · B 36.8KB · C 40.2KB, brand review 87.9KB) |

The last three ran **concurrently** with the 12-template rollout on one
machine, so their wall-clocks are conservative; a solo parallel run is ~21m vs
the serial pipeline's ~24–38m (median ~27m) measured on the same sites.

Live proof points:
- `https://wheelercat-com--stardust-app-fable--paolomoz.aem.live/wheelercat-com/` — full site, 13 pages
- `https://festool-com--stardust-app-fable--paolomoz.aem.page/festool-com/` — deployed home
- Block systems generated per site (wheelercat: hero, card-grid, stats,
  ticker, cta-banner, logo-row, route-grid, offer-grid, locations…)

## What carries it (the harness)

- **Runtime** (`app/runtime/`, baked into `stardust-sandbox`): open-loop agent
  with modes `uplift(+direct stage) | build | iterate | variant | template |
  deploy`, prompt-cached Bedrock provider, retry-with-backoff on all network
  edges, deterministic marker watcher, workspace bundling to R2.
- **Worker/DO**: milestone-driven orchestration with full eviction survival;
  fan-out/aggregation for parallel builds; deploy/rollout state machines;
  per-run ingest tokens; D1 timeline + R2 artifacts.
- **Publisher**: `runner POST /publish` — the only component that touches
  GitHub/DA/AEM admin, entirely deterministic and replayable.
- **SPA**: conversational shell with the five-rung ladder (uplift · prototype
  · deploy · rollout · audit), live board, per-phase screens; reconnecting
  WebSocket; bookmarkable `/?run=<id>`.

## Known limits / next

- Publisher runs on the local runner only (prod Containers parity needs a
  token strategy for git + DA in `server.mjs`).
- The audit rung remains future (scorecard vs the original site).
- One flaky build worker was observed terminating with a placeholder milestone
  and no upload; the DO now verifies delivery against R2 and drains
  count-based, but root cause (lost with the container) is worth a look at the
  next occurrence — per-job container logs are now captured under
  `sandbox/outputs/_logs/`.
- Backlog in `IMPROVEMENTS.md`: DO WebSocket hibernation, per-user run caps,
  typed milestone schema, Worker-side haiku retry.
