# stardust web app — improvement backlog (by category)

Running notes of optimizations to consider. Not committed to a timeline; each
item is independently shippable.

## Speed

Observed: a prod Containers run feels much slower than local dev. Two parts —
real slowdowns + a perception gap.

- **Instance vCPU bump.** Prod is `standard-2` = **1 vCPU**; local dev is the
  Mac's many cores. The browser-heavy steps (Playwright extract render, craft's
  in-browser QA screenshots) + node/bash/impeccable scripts are CPU-bound and run
  several× slower on 1 vCPU. **Biggest real factor.** Fix: bump to `standard-4`
  (4 vCPU); our 3.5 GB image fits its 20 GB disk; cost still pennies vs the LLM.
- **Fire-and-forget ingest.** The agent loop currently `await`s each
  narration/tool ingest POST. In prod those hop container → public Worker
  (internet RTT, tens-of-ms each) vs `localhost` in dev; across 200+ events that
  adds minutes. Fix: don't await onNarration/onTool POSTs (already best-effort).
- **Progress fidelity (perceived speed).** Opus batches milestone emissions, so
  the bar sits at "58% / brand captured" while the agent is actually building
  variant C. Run *looks* stuck. Fix: drive the bar off narration cadence and/or
  emit finer milestones; smoother ETA decay.
  - **Observed again (3m.com, 2026-07-01).** At 8 min in, only `extract.started`
    + `extract.seed` had fired (board: "reading the brand", 22%) while the chat
    showed the agent already at **Phase 4 (composing directions)** — it had run
    the tension detectors, written `_brand-extraction.json`, and was writing
    PRODUCT/DESIGN. So the board understated real progress by ~2 phases; it only
    catches up when the agent finally emits `brand_ready`/`variants_ready` (often
    in a burst). The board machinery is correct — the agent just emits late.
  - **Fix (deterministic milestone backstop).** Don't rely on the model to
    `emit_milestone` on time. Have the runtime watch the workspace and emit the
    phase milestone when its artifact/state lands — mirrors the iterate
    force-emit + DO artifact-arrival completion (`ingestArtifact`): e.g. emit
    `extract.brand_ready` when `stardust/current/brand-review.html` +
    `_brand-extraction.json` exist; `direct.variants_ready` when the
    `DESIGN-*.json` set + `direction.md` variant sections exist;
    `prototype.variant_done` when each `home-*-proposed.html` lands. Poll in
    `agent.mjs` (a lightweight fs-watch beside the loop) OR infer in the DO from
    `upload_artifact` paths (brand-review → brand_ready; each proposed.html →
    variant_done). Turns board progress from model-timed into event-timed.
- **Prompt caching.** Runs re-read ~15-18M cached-context tokens. Anthropic
  prompt caching on the system prompt + baked skill files would cut per-call
  latency (and cost) materially.
- **(see Parallelization)** — parallel variant builds is the largest wall-clock win.

## Resilience / scalability (measured — 8 concurrent local runs, 2026-07-01)

Ran 8 Opus runs concurrently (local, 12-CPU / 8.2 GB Docker VM). Result: **7/8
completed**, 24–38 min each (median ~27m) — concurrency did **not** slow them vs
a solo ~27m run, load peaked ~8–9/12 CPU, and **no OOM** (8 concurrent Chromium
stayed within 8.2 GB; renders are brief/staggered). Compute + memory scale fine
at this fan-out. The new runtime held up: all 7 completions emitted page
discovery + the workspace bundle under load. Two real gaps surfaced:

- **No retry on transient provider/network failures (biggest).** ✅ **DONE
  (2026-07-01).** One run died at 23 min to `bedrock 500: "…unexpected error…
  Try your request again."` — an explicitly retryable transient, ~23-min run
  thrown away. Separately, a brief operator network blip killed 3 runs at t=0
  with bare `fetch failed`. Root: `provider.step` + the ingest client did a
  single `fetch` with no retry. Fixed via `runtime/fetch-retry.mjs` —
  retry-with-jittered-backoff on network errors + 408/425/429/5xx, honoring
  `Retry-After`, passing 4xx straight through. Wired into both providers
  (bedrock/cerebras) and all ingest calls (event/artifact/uploadFrom/download/
  JSON). Would have saved all 4 lost runs. (Not yet applied to the Worker's
  haiku.ts suggest/ETA path — lower priority, already falls back gracefully.)
- **No concurrency control anywhere.** The runner/`server.mjs` spawn a container
  per request with no cap or stagger; the DO has no per-user run limit. Didn't
  bite at 8 (compute was fine), but it's the latent ceiling — a large burst would
  eventually exhaust the Docker VM memory or Bedrock quota. Fix: a small
  max-concurrency queue in the runner + a per-user in-flight cap in the Worker
  (pairs with the per-user run-cap guardrail already noted).

## Live timing (measured — prod run, hirslanden.ch, 2026-07-01)

29 min total. extract **~7m** (render 3:17 · brand 1:03 · tensions 2:28 →
brand_ready 6:48). Then a **~20-min block with NO milestones** (6:48 → 26:46)
where directions are composed and A/B/C are built **serially**. variant_done
A/B/C fire ~20-40s apart at 27:50-28:27 (those are *uploads* of already-built
variants). Two findings:

- **ETA re-anchoring.** The one-shot estimate said 45m (clamp ceiling); actual
  was 29m — 55% over, and blind. Fix: (1) recompute at `brand_ready` off the
  *real* extract time (build ≈ 2.5-3× extract); (2) during the 20-min build,
  drive the bar off **narration** (per-variant `write_file` / "building variant
  N/3") — emit a milestone at each build's *start*, since `variant_done` fires at
  upload, far too late.
- **Build is the bottleneck, and it's serial.** ~18 of the 20 min is building
  A→B→C one at a time in one loop. Parallelizing the three (below) → build ~6-7m,
  total run **29m → ~15m**. extract stays a serial prerequisite; nothing is
  redundant to cut.

## Parallelization (RECOMMENDED)

Sequential today: extract → direct → prototype ×3 (each variant via
`$impeccable craft` + in-browser QA + motion validation). The prototype phase
(3× craft) dominates wall-clock.

**Practical win (recommended): build the 3 variants in parallel.** A/B/C are independent bets
that share the SAME inputs (brand extraction, design system, the 3 directions) —
no cross-variant dependency. So splitting them loses **no context richness**:
each parallel worker reads the full brand/design context + its assigned
direction. The R2 context-snapshot mechanism built for iteration is exactly the
substrate.

Shape:
1. Container 1 (sequential): extract + direct → uploads brand-review + design
   context (`_ctx/`) + the 3 directions to R2.
2. Spawn 3 parallel containers (A/B/C): each restores context from R2 + builds
   its one variant via craft → uploads home-X + thumb → emits `variant_done`.
3. Run completes when all 3 finish.

Effect: prototype phase goes from 3×craft sequential → ~1×craft wall-clock (up to
~3× faster on the dominant phase; roughly halves total run time or better). Same
total tokens (each variant's work happens either way) → ~same cost, just
concurrent.

Costs / caveats:
- DO orchestration becomes 2-phase (extract+direct, then fan-out 3) + aggregate
  completion (done when all 3 variant_done). More complex than one container.
- Bedrock concurrency: 3 concurrent Opus sessions per run (× parallel runs) hits
  TPM/RPM quotas faster — a quota-increase + a per-user run cap pair with this.
- Per-variant craft is itself sequential (build → QA → critique → motion); the
  win is cross-variant, not within-variant.

## UX

- **URL-as-run-state (bookmarkable / reload-safe).** On starting a run, switch
  the browser URL to `/?run=<id>` (history.replaceState) so the user can bookmark
  it and reload. On reload of a *running* run, restore the full live status —
  chat, artifacts, **and the progress bar / thinking dots** — then keep streaming.
  Mostly works already: `reopenRun` rehydrates run_events + result_json and the
  DO reconnects/continues live (robust now post eviction-fix); the missing piece
  is (a) updating the URL on `beginRun`, and (b) confirming the working-screen
  progress/busy/eta restore on a mid-run reload. Small change, high value.
- **Clear "done" state on the working screen.** When a run finishes, the working
  stage still shows "Building… / brand surface captured" with a spinner (looks
  stuck) until the user clicks "See snapshot". Show an explicit done state
  (auto-enable + nudge, or auto-advance). Pairs with the progress-fidelity item
  under Speed.

## Product / flow ladder (project dashboard)

Turn the "Building your redesign" stage into a **project summary board** that
shows the whole stardust ladder — done / in-progress / future — not just the
current uplift. Surfaces the gradual-complexity journey (uplift → templates →
deploy → rollout) from the plan; today only uplift is built, so the later
columns are "future / greyed."

- **4 columns**, each with its own sub-steps rendered as the existing task rows
  (icon + CATEGORY label + title + detail + status: done ✓ / in-progress spinner
  / future ○ greyed):
  1. **Uplift** (the URL) — CAPTURE rendering · READ brand · EXTRACT surface ·
     ANALYZE tensions · DIRECT 3 directions · VALIDATE renders (i.e. the current
     uplift task list, with its loading animations).
  2. **Prototype** — prototype the other templates beyond the homepage.
  3. **Deploy** — deploy prototypes to AEM Edge Delivery.
  4. **Rollout** — roll out the entire site.
- A column's whole set greys out when that phase is still in the future.
- **Header redesign**, left→right: `stardust` (logo) → root · `festool.com ·
  redesign` → this summary board · then the 4 phase links **uplift · prototype ·
  deploy · rollout** with not-yet-reached phases greyed (like `deploy` is today).
  Replaces the current 2-rung `prototype — deploy` ladder with the full 4-rung one.
- This makes the project's state legible at a glance and gives a home for the
  deploy/rollout rungs (currently deferred) as they come online.

## Cost (future)
- **Prompt caching** (above) — biggest lever (~15-18M cached tokens re-read/run).
- **Idle container instances.** Right after deploy the `stardust-sandbox` app
  showed 7-9 LIVE INSTANCES with zero runs. Confirm these aren't billed idle
  `standard-2` instances (Cloudflare says unused pre-warmed images aren't
  charged); if they are, tune min-instances / ensure scale-to-zero.
- Per-user run cap (each Opus run ~$50-80). R2 retention policy — artifacts +
  `_ctx/` never expire today, storage grows unbounded. Cheaper-tier model for
  low-stakes iterations.

## Known bugs

- **Overview Uplift column empty on reopen ("IN PROGRESS").** Same DO-eviction
  family as the result_json fix, but `this.tasks` isn't rehydrated: a cold DO
  re-emits an empty `tasks.init` late in the run, which wins on replay → empty
  column + false "in progress". Deliverables are unaffected. Fix: don't emit an
  empty `tasks.init` (guard the variant_done/done emits), rehydrate `this.tasks`
  on a cold DO, and/or derive the column's done-state from `result_json` on
  reopen. Cosmetic; tracked for the next reliability pass.

## Reliability / Scale (future)
- **Bedrock quota** increase before high concurrency (the real 100-parallel cap;
  pairs with parallel variant builds, which triple per-run concurrency).
- **Stuck-run watchdog** (timeout) — a dead container can leave status=running.
- **Image size.** Explored Cloudflare remote browsers (Browser Rendering): would
  cut the image ~65% (~3.5 GB → ~1.2 GB) by removing local Chromium + slim base,
  BUT it's a re-architecture (the plugins use the full Playwright API in-container;
  remote browser = limited REST API or a Worker-only Puppeteer binding) and adds
  its own concurrency cap — and image size isn't a real scaling constraint for
  25-30 min runs (cold-start pull amortized). Verdict: not worth it. Cheap
  alternative if ever wanted: `node:22-bookworm-slim` base (~0.5 GB off, no
  code change).
