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
- **Prompt caching.** Runs re-read ~15-18M cached-context tokens. Anthropic
  prompt caching on the system prompt + baked skill files would cut per-call
  latency (and cost) materially.
- **(see Parallelization)** — parallel variant builds is the largest wall-clock win.

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

## Cost (future)
- **Prompt caching** (above) — biggest lever (~15-18M cached tokens re-read/run).
- **Idle container instances.** Right after deploy the `stardust-sandbox` app
  showed 7-9 LIVE INSTANCES with zero runs. Confirm these aren't billed idle
  `standard-2` instances (Cloudflare says unused pre-warmed images aren't
  charged); if they are, tune min-instances / ensure scale-to-zero.
- Per-user run cap (each Opus run ~$50-80). R2 retention policy — artifacts +
  `_ctx/` never expire today, storage grows unbounded. Cheaper-tier model for
  low-stakes iterations.

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
