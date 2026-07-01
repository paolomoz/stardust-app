# Refactoring assessment — 2026-07-02 (Fable 5 review pass)

A full review of the stardust web app (harness + UI, plugin untouched), then
implementation of every improvement that survived scrutiny. Priorities per the
brief: execution time first, quality untouched, local-only.

## Execution time (the headline)

### 1. Parallel variant builds — the run's dominant phase, parallelized
The serial pipeline (extract → direct → craft A → craft B → craft C in ONE
container) spent ~2/3 of a ~29-minute run crafting variants one at a time.
The pipeline is now split (`PIPELINE_VERSION = "parallel-1"`):

- **Phase 1** (`UPLIFT_STAGE=direct`): one container runs extract + direct
  only, uploads the brand surface, emits `variants_ready`, snapshots the whole
  workspace to R2 (`_workspace.tgz`), then emits a deterministic
  `direct.bundle_ready`.
- **Phase 2**: on `bundle_ready` the Durable Object fans out **one `build`
  container per variant** (`mode=build`, `jobId=bld-<id>`). Each restores the
  bundle, pins its `DESIGN-<id>` (the same `pinVariant` mechanism the template
  phase uses), crafts its single page through impeccable, uploads it, and
  emits `variant_done`. The DO aggregates: the run completes when the fan-out
  drains (with whatever variants delivered; all-fail → honest failure).

No plugin change: phase 1 runs the same uplift skill flow through direct; each
worker runs the same per-variant craft contract. Each worker reads the full
brand/design context, so **no quality is lost** — the variants were always
independent bets built from the same inputs.

Expected effect: craft wall-clock ÷ ~3 → total run ~29 min → **~16 min**.
Measured (wheelercat.com, first parallel run): see the note at the bottom.

### 2. Bedrock prompt caching — the largest per-token lever
`provider-bedrock.mjs` now sets `cache_control` breakpoints: a static one on
the system prompt (caches tools + system once) and a moving one on the last
message (each turn re-reads the growing loop history from cache instead of
re-prefilling it). An uplift run re-reads ~15–18M context tokens; caching cuts
both per-turn prefill latency and cost materially. (Cache-read tokens were
already counted in `usage`.)

### 3. Non-blocking narration/tool ingest
`loop.mjs` awaited a POST to the ingest bridge for every narration line and
tool call — hundreds of sequential RTTs per run sitting on the model loop's
critical path. They now ride an ordered, non-blocking side queue (flushed
before terminal events). Locally negligible; on prod (container → public
Worker) this removes minutes of dead time.

### 4. Parallel job restores + finalization
Iterate/variant jobs restored their inputs serially (variant file + 4 context
files = 5 sequential round-trips before the model could start); now one
`Promise.all`. The end-of-run `_ctx/*` uploads likewise.

### 5. Worker → DO hop only for meaningful artifacts
Every asset upload (fonts, thumbs, images…) paid a Durable Object RPC after
the R2 write, for a handler that ignored everything but page HTML. The Worker
now gates the RPC on `(proposed|cinematic|brand-review).html`.

### 6. Runner concurrency cap
`runner.mjs` now runs at most `RUNNER_MAX_CONCURRENCY` (default 10) containers
with a FIFO queue — a parallel fan-out or a burst of runs can no longer
exhaust the Docker VM (the previously-noted latent ceiling). Canceled runs are
dropped at dequeue.

## Progress fidelity (perceived speed)

### 7. Deterministic milestone backstop (the "board lags 2 phases" bug)
Opus batches `emit_milestone` calls late; the board sat at "reading the brand"
while the agent was composing directions. The runtime now runs a **marker
watcher** (15s poll, zero-LLM): when a phase's artifact lands on disk
(`pages/` capture, `_brand-extraction.json`, `brand-review.html`,
`direction.md`, the three `DESIGN-*.json`), it pushes a `watch.marker` event
and the DO advances the board row + status line immediately. Panels still come
only from the real milestones; board progress is now event-timed, not
model-timed. Verified live: "brand read" / "brand surface built" appeared from
markers minutes before the model's own milestones.

### 8. Monotonic progress + parallel ETA model
Progress emission is now monotonic server-side (`bumpProgress`), so markers
and late milestones can't pull the bar backwards. The self-calibrating ETA
model was re-versioned (`parallel-1`) with fresh priors (~16 min mean), so
serial-era history can't skew the new pipeline's estimates; per-milestone
fractions re-learn automatically from completed runs.

## Correctness / resilience

### 9. Client WebSocket reconnect (the frozen-run bug)
The SPA opened one WebSocket and never handled `close`: any DO eviction,
network blip, or laptop sleep froze the UI for the rest of a 20-minute run.
`liveDriver` now reconnects with exponential backoff; the DO already replays
the timeline + panels on every connection and messages are id-deduped, so a
reconnect self-heals. Commands typed while offline queue and flush on reopen.

### 10. Full DO eviction-survival
Persisted into `result_json` and rehydrated on a cold DO: the terminal
`finished` flag (a late/duplicate `done` can no longer double-finish a run),
the tasks board (reopened runs no longer show an empty uplift column — the old
known bug), the parallel-build fan-out state, and in-flight iteration state
(an eviction mid-iterate no longer strands the spinner or loses the
hot-swap). `emit` now persists to D1 *before* broadcasting, so a client can
never see an event that a reopen can't replay.

### 11. Managed-Agents dead paths removed
`runAgent`/`runUplift` (the pre-runtime Managed Agents SSE paths) and
`managedAgents.ts` are gone (~250 lines): they were unreachable in practice,
carried the only non-eviction-safe streaming loops, and legacy `?mode=` values
now fold into the bedrock runtime.

### 12. Smaller fixes
- `hotSwapVariant` no longer dereferences an empty variant list.
- A stray `done` milestone can't complete a parallel run early (worker guard).
- Cinematic variant files now count for iteration-completion detection
  (previously only `*-proposed.html` matched).
- `pages.test.mjs` got a committed synthetic fixture (it pointed at an
  uncommitted dir and crashed).

## UI

- **XSS/injection**: model-supplied `pitch`/`whatif`/`moves`/shared-fix strings
  are now escaped in the Directions gallery (they render in the app document,
  not the sandboxed iframes).
- **Board re-render**: the Overview board skipped-if-unchanged instead of
  innerHTML-swapping on every streamed event (was dropping hover/focus and
  restarting spinners several times a second).
- **URL-as-run-state**: `history.replaceState('/?run=<id>')` the moment a run
  is created — every fresh run is bookmarkable/reload-safe from second one.
- **ETA repaint interval** now runs only while an estimate is showing (was a
  forever `setInterval` on every screen).
- Dead code removed: the disabled pinned-tasks block in the conversation
  panel, the inert "Run audit" button.
- Off-palette color literals in the new deploy styles (and three adjacent
  board tints) replaced with `color-mix` on the `--success`/`--danger` tokens.
  (17 pre-existing design-hook findings in `screens.css` from the earlier
  board redesign are left as-is — visual-risk without review.)

## Deliberately not done (and why)

- **DO WebSocket hibernation API** — right fix for prod cost, but a
  re-architecture of the socket layer; local-first priorities won.
- **Parallel tool-call execution inside a loop turn** — ordering interacts
  with terminal-milestone detection; marginal win, real risk.
- **Typed shared schema for the milestone contract** — worth doing when the
  contract next changes; today three prose copies agree.
- **Haiku retry in suggest/ETA path** — already degrades gracefully.

## Measured validation

- `pages.test.mjs` — PASSED (12 candidates, dedupe/host/anchor rules).
- Client + worker `tsc` clean; `vite build` clean; all runtime files
  `node --check` clean; image rebaked twice with baked-content verification.
- First parallel run (wheelercat.com): phase 1 (extract+direct) live with
  deterministic markers driving the board; fan-out/build timings recorded in
  IMPROVEMENTS.md once complete.
