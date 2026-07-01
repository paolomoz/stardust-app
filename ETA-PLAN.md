# ETA bar — dynamic, self-calibrating, LLM-free (draft, not yet executed)

Goal: replace the blind one-shot ETA with a **model-free, milestone-anchored,
self-calibrating** estimate that auto-updates during a run and **absorbs future
plugin/harness changes** (parallel craft, reorders, new milestones) with no
ETA-code changes. **Test locally first, then prod.** Harness-only — no plugin change.

## Problem with today's ETA
- `runSession.ts` → `estimateEta(kind, detail)` makes **one** upfront Haiku call
  (now via `callHaiku`/Bedrock), clamps 8-45m, emits `{t:"eta",seconds}` **once**.
- It's a blind guess from the URL, never revised. Measured: it said 45m (clamp
  ceiling) for a 29m run. It also breaks the moment we parallelize (run gets
  shorter, estimate doesn't know).

## Design (all arithmetic, no LLM in the loop)
Treat the milestones the run already emits as **opaque ordered checkpoints**;
learn their timing distribution from past runs; re-anchor live.

1. **Learn `f(label)` from history.** For the last *K* completed **real** runs of
   the same kind, `f(label) = mean( elapsed_at(label) / total )`. Also keep
   `meanTotal` and `p10/p90` for bounds. (`label` = milestone name, e.g.
   `brand_ready`, `variants_ready`, `variant_done`, `done` — keyed on the label,
   never on hardcoded phase meaning.)
2. **Re-anchor at each milestone.** When milestone `M` fires at elapsed `E`:
   `total_est = E / f(M)` → emit a fresh `{t:"eta", seconds: total_est}`. Smooth
   with an EMA vs the last emitted; keep roughly monotonic; clamp to `p10..p90`.
3. **Prior at t=0.** Use `meanTotal` from history (fall back to the Haiku call
   only when there's no history — and once history exists, the Haiku call can be
   dropped entirely → fully LLM-free).
4. **Between milestones.** The client bar already creeps toward `eta.seconds`
   capped at 95% (`conversation.ts` `paintEta`) — keep. Optionally cap below the
   next milestone's learned fraction so it never claims "almost done" mid-phase.
5. **Version tag (important).** Store a `pipelineVersion` with each run's timings;
   the learner filters to matching version (or "prefer recent K") so a pipeline
   change (parallel/reorder) doesn't blend old-serial with new-parallel shapes.
   Without this, the ETA is briefly stale for ~K runs after any pipeline change.

**Why future-proof:** `f(label)` is data-driven and keyed on whatever labels
appear. Reorders shift fractions (re-learned over K runs); new milestones are
auto-included once they appear in completed runs; parallel craft just changes the
distribution. The ETA logic never "knows" what a milestone means.

## Data — already have seed; filter carefully
- **Prod:** 3 completed real runs (virginatlantic, festool, hirslanden), each with
  the full milestone timeline + timestamps in `run_events`. Enough to bootstrap.
- **Local:** wheelercat ×2 (real) + demo runs. **EXCLUDE scripted demo runs from
  learning** (they're ~9s — different shape); filter by `runs.mode` (learn only
  from `bedrock`/`cerebras`/`agent`, not `scripted`).
- **Cold start** (no matching history): prior = Haiku (or a generic default) +
  wide bounds.

## Where it lives + files
- **Harness only** (the DO): `app/web/src/worker/runSession.ts`.
  - Accumulate `this.timings[label] = elapsedMs` as milestones fire (the
    `ingestEvent` handlers: `extract.brand_ready` ~L610, `direct.variants_ready`
    ~L618, `prototype.variant_done` ~L625, `done` ~L634).
  - Add `reestimateEta(label)` called at the end of each of those handlers →
    reads history, computes `total_est`, emits `{t:"eta",seconds}`.
  - On `done`, persist timings: **fold into `result_json`** as
    `result_json.timings = {byLabel:{...}, total, pipelineVersion, mode}` →
    **no migration needed** (result_json already exists + is merge-persisted).
  - `learnFractions(env, {mode, pipelineVersion, K})`: read recent done runs'
    `result_json.timings` → `f(label)`, `meanTotal`, `p10/p90`. Cheap D1 read;
    cache in the DO per run.
- **Client** (already works, minimal/no change): `conversation.ts` `paintEta`
  fills the bar toward the latest `eta.seconds`; `liveDriver.ts` `apply("eta")`
  sets `store.eta={seconds,at:Date.now()}`. Re-anchoring just emits more `eta`
  events; the bar follows. (Optional: smooth the bar so re-anchors don't jump.)
- Set `pipelineVersion` from a harness constant (bump when we change the flow) or
  the baked plugin version.

## Implementation steps
1. Add `this.timings` accumulation in `ingestEvent` milestone handlers (record
   `elapsed = Date.now() - runStart` per label; need a `runStart` — capture at
   `run.started`).
2. `learnFractions()` — query last K done runs (`status='done'`, real mode,
   matching `pipelineVersion`) reading `result_json.timings`; compute `f(label)`,
   `meanTotal`, `p10/p90`.
3. `reestimateEta(label)` — `total_est = clamp(EMA(elapsed / f(label)), p10, p90)`;
   emit `{t:"eta", seconds: total_est}`. Call it in each milestone handler.
4. t=0 prior: emit `meanTotal` (or Haiku fallback) at run start instead of only
   the Haiku guess.
5. On `done`: write `result_json.timings` (byLabel + total + pipelineVersion + mode).
6. (Optional) client: EMA-smooth the bar width so re-anchors glide.

## Local-first test plan
1. **Seed:** local D1 already has 2 real wheelercat runs → `learnFractions` has
   data. (Confirm the mode filter excludes demo runs.)
2. **UI re-anchor mechanic (fast, free):** run `?mode=demo` — it emits milestones
   in ~9s; watch the ETA bar **re-anchor at each milestone** (visual check the bar
   updates, doesn't just animate to a fixed value). *(Demo timings shouldn't feed
   the learner — verify the mode filter.)*
3. **Real local run:** start a real (bedrock) run locally; verify:
   - t=0 ETA ≈ historical mean (not 45m clamp),
   - ETA re-anchors down/up at `brand_ready`, `variants_ready`, each `variant_done`,
   - on `done`, `result_json.timings` is written,
   - a subsequent run's estimate reflects the added data.
4. **Measure:** compare emitted ETAs vs actual (pull `run_events` ts, as before).
5. Then deploy to prod (`npm run smoke`, re-measure).

## Open decisions
- Version-tag vs prefer-recent-K (recommend **version-tag** to avoid serial↔parallel blending).
- Keep the Haiku upfront prior as a fallback, or drop entirely once history exists.
- Store timings in `result_json` (no migration, recommended) vs a `run_timings` table.
- Smoothing: server-side EMA on `total_est`, client-side EMA on bar width, or both.

## Relation to other plans
- Independent of `UPLIFT-PERF-PLAN.md` but **complements it**: once parallel-craft
  ships, this ETA auto-recalibrates (via version-tag). Can ship **before or after**
  the perf work. Pairs with the "ETA re-anchoring" note in `IMPROVEMENTS.md`.

## Current state — ✅ IMPLEMENTED + LOCALLY VALIDATED (2026-07-01)
Executed on `webapp-build`. Changes:
- `worker/runSession.ts`: `PIPELINE_VERSION="serial-1"` + `ETA_DEFAULTS`;
  `runStartTs()` (MIN(run_events.ts), eviction-safe), `learnEta()` (backend-aware,
  reopen-corruption guard), `primeEta()` (t=0 prior = historical mean, Haiku only
  as no-history fallback), `reestimateEta(label)` (EMA glide, bounded, ≥elapsed).
  Wired into brand_ready / variants_ready / variant_done / done. `persistResult`
  folds `timings{byLabel,total,pipelineVersion,mode}` into result_json (no
  migration) + backfills `mode` from D1 (eviction-safe). `rehydrateResult`
  restores startedAt/timings/mode.
- `shared/protocol.ts` + `driver/liveDriver.ts`: `eta` gains `startedAt` (run-start
  anchor) → client `elapsed=now-startedAt` stays correct across re-anchors + reopen.
- `web/scripts/backfill-timings.mjs`: seeds `result_json.timings` for existing
  runs from run_events (ran on LOCAL: 12 runs). **Run on prod before deploy:**
  `node scripts/backfill-timings.mjs --remote`.
- `web/scripts/eta-e2e.mjs`: zero-cost local E2E (simulated ingest, no paid run).

Refinements beyond the original plan: **backend-aware learning** (opus
bedrock/uplift ≈23m vs cerebras ≈minutes never blend); **reopen-corruption
guard** (drop fractions ∉(0,1) — reopens re-emit events with fresh ts).

Validated locally (LLM-free): learner from 8 real bedrock runs → meanTotal 23.1m,
f(brand_ready)=0.32, f(variants_ready)=0.53, f(variant_done)=0.68; E2E re-anchors
2190→1761→1395→1212→1120s with `startedAt` present + timings persisted.

Resolved open decisions: version-tag ✓; Haiku kept as no-history fallback ✓;
timings in result_json (no migration) ✓; smoothing = server-side EMA ✓.

NOT yet done: (a) a real paid run to watch primeEta live (simulation covers the
same code path); (b) prod backfill + deploy + smoke + re-measure.
