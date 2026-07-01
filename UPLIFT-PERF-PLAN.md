# Uplift performance plan — run-duration optimization (draft, not yet executed)

Goal: cut uplift run wall-clock. Three items selected from the measured-timing
analysis. This doc captures the reasoning + exact edit locations so it can be
executed cold in a later session. **Nothing here is executed yet** — only the
setup in "Current state" below is done.

## Measured baseline (prod run — hirslanden.ch, 2026-07-01, 29 min)

| t+ | milestone | Δ | notes |
|---|---|---|---|
| 0:00 | reading site | | extract render |
| 6:48 | brand surface captured | ~6:45 | **extract done** (render 0:28 · brand 1:03 · tensions 2:28 · brand-review 2:23; ~1m lost trying to view PNGs) |
| 6:48→26:46 | *(no milestones ~20m)* | | direct (~3m) + build A/B/C **serially** + **validate/AA-contrast (~7:20)** |
| 27:50/28:13/28:27 | variant A/B/C rendered | | *uploads* of already-built variants |
| ~29:00 | done | | |

Dominant costs: **Variant C build 4:14** (long pole) and the **validate+AA-contrast loop ~7:20** — NOT the A/B builds. ETA said 45m (clamp ceiling), actual 29m.

## KEY architectural finding (read first)

**The milestone / live-streaming system is in the HARNESS, not the stardust plugin.**
- Plugin (`230626/skills/plugins/stardust`) tracks only `state.json` status
  (`extracted → directed → prototyped → approved → migrated`) + prints chat
  summaries. It has **no** `emit_milestone`, no `status.jsonl`, no event names.
- The harness (`app/runtime/`) layers streaming on top:
  - `runtime/system-prompt.md` lines 73-84 instruct the agent to
    `emit_milestone(...)` at each boundary (`extract.started/seed/tensions/brand_ready`,
    `direct.variants_ready`, `prototype.variant_done`, `done`).
  - `runtime/tools.mjs` defines the `emit_milestone` + `upload_artifact` tools.
  - `runtime/agent.mjs` line 57: "emit each milestone the instant it happens…".
  - `runtime/ingest.mjs` → `/api/ingest/<runId>/*` → DO → UI.
- Consequence: **plugin skills must never reference `emit_milestone`** (absent in
  vanilla Claude Code). The *work order* lives in the plugin; the *milestone
  emission* is harness. So reordering a plugin phase makes the (harness-emitted)
  milestone fire earlier automatically.

## The three items

Plugin repo: `/Users/paolo/stardust/source/230626/skills` · branch
`uplift-perf-0.14.0` · version `0.14.0`. Line refs are as-of 0.13.1 (use the
section headings as the stable anchors).

### Item 3 — Brand-review off critical path  (~2m + earlier snapshot; low risk)
- **Why on-path today:** `extract/SKILL.md` computes the **tensions detectors at
  brand-review *render* time** (Phase 5, lines 338-364, tensions at 351-357), and
  `direct` needs the tensions (`uplift/SKILL.md` line 93). Brand *data* is ready a
  phase earlier (Phase 3 `_brand-extraction.json`, lines 249-305).
- **Plugin change:** in `extract/SKILL.md`, **decouple tensions computation from
  the HTML render** — compute tensions from the brand data (Phase 3/4) so
  data+tensions are ready, then render `brand-review.html` after (non-blocking).
- **Harness:** `emit_milestone(brand_ready)` naturally fires when data ready.
- **Test (Claude Code):** confirm tensions are computed before the review HTML is
  rendered, and `direct` can start from data+tensions.

### Item 2 — Show variant on build, validate after  (perceived ~9m; med risk + philosophy change)
- **Order today** (`prototype/SKILL.md`): Phase 2 render (373-427) → Phase 2.5-2.8
  validators (676-1051; line 717 "**Before opening the proposed file in the
  browser**, run validators"; line 794 "gate `prototyped` on P0/P1") → Phase 4
  open + mark `prototyped` (1092-1120). So: build → validate → show. Deliberate.
- **Plugin change:** reorder to **build → expose/open + mark built → validate →
  fix + re-render if P0/P1**. This is a **philosophy change** (currently validates
  before showing to "catch misreads while cheap"). CONFIRM this trade-off.
- **Harness:** `variant_done` + `upload_artifact` already say "the instant it
  happens" — they follow the reordered plugin; maybe reinforce in
  `system-prompt.md`.
- **Test (Claude Code):** variant file written + state exposed before validation
  completes.

### Item 1 — Parallel variant craft (fan-out 3 containers)  (~6-7m; high, biggest win)
- **Today:** `uplift/SKILL.md` Phase 5 (266-308) invokes `prototype` **once**;
  prototype detects N from `DESIGN-A/B/C.json` and loops A→B→C **in one run**.
  **No `--variant` selector** (line 308), **no per-variant checkpoint** (state is
  coarse per-page only, `state-machine.md` line 4). `direct` writes the
  `DESIGN-A/B/C` (direct/SKILL.md 982-999); shape briefs are prototype Phase 1
  (173-206); craft delegation is `prototype/SKILL.md` Phase 2 (line 396,
  `$impeccable craft`).
- **Plugin change:** add a clean **single-variant craft** path — prototype crafts
  the variant(s) whose `DESIGN-*.json` are present (the "only one present" case is
  implied-possible today but unspecified; make it first-class), and ensure the
  **post-direct context** (`_brand-extraction.json` + `DESIGN-*` + assets +
  shape brief) is restorable so one variant crafts standalone. (`direct
  --add-variant`, lines 44-49, is a related hook.)
- **Harness:** split the run — one container does **extract+direct**, checkpoint
  the post-direct bundle to R2, then **fan out 3 containers** each restoring the
  bundle + crafting one variant. Reuse the existing iterate checkpoint/restore in
  `agent.mjs` (`ITERATE` mode already downloads `_ctx/*` + a variant from R2).
  The DO aggregates 3 `variant_done` → `done`.
- **Test (Claude Code):** run prototype for a single variant from a post-direct
  checkpoint standalone. **Parallelism itself is validated in the web app** (needs
  the harness to spawn containers).

## Also recorded (not selected, but high-value — from the timing analysis)
- **Pre-bake AA-safe link/eyebrow tokens** into the DESIGN/craft step → eliminates
  the ~5-min contrast iteration. **Plugin**, low risk. *(Bigger single win than
  most of the above; strongly consider adding.)*
- **Skip image-view attempts** (~1m) — the harness can't read PNGs; the agent
  retried. **Plugin/system-prompt** note.
- **Generalized bot-challenge auto-wait in the extract crawler** (~2-3m on
  challenged sites). **Plugin** (`extract.mjs`). Observed on the prod
  camping-arbon.ch run: the site sat behind a DDoS-Guard "One moment, please…"
  JS interstitial; the first capture got only 8 words, then the *agent* spent
  ~2-3m diagnosing it (fingerprint vs JS challenge, Chrome availability) and
  hand-rolling navigation-robust polling — though the challenge itself clears in
  ~5s. Fix: bake **detect → auto-wait → re-capture** into the crawler,
  deterministically (no LLM reasoning): (1) detect via thin-capture + a known
  interstitial signature list (DDoS-Guard "One moment", Cloudflare "Checking your
  browser"/"Just a moment", `cf-challenge`/`ddos-guard` markers, meta-refresh
  splash); (2) `waitForFunction` for real content / markers gone / nav settle
  (~12-15s bound), then re-capture; (3) fail fast + honest message on the
  unsolvable class (Turnstile/CAPTCHA — waiting won't clear it, and solving is
  off-limits). Generalizes across sites via one signature list + one wait loop;
  turns ~2-3m of per-run model diagnosis into ~5-10s of deterministic wait.
- Pre-warm bootstrap + craft skills (~30s), seed simplification — see
  `IMPROVEMENTS.md`.

## Execution sequence (matches the 4-step plan)
1. **Plugin (0.14.0, branch `uplift-perf-0.14.0`):** edit items above. Suggested
   order **3 → 2 → 1** (low→high risk); optionally add the AA-token win.
2. **Test plugin in a fresh Claude Code session** loading 0.14.0 from local
   source. *(Open Q: how CC loads the local plugin — marketplace add local path
   `230626/skills`, or symlink.)*
3. **Harness (app, `webapp-build`):** item 2/3 emit-timing follow-through; item 1
   **fan-out + checkpoint/restore** orchestration (runSession `triggerRuntime`,
   `agent.mjs` craft-one-variant mode, DO aggregation).
4. **Rebake the sandbox image with 0.14.0 + deploy.** *(Open Q: `sandbox/build.sh`
   currently stages the plugin from `source/skills/plugins/stardust` (highest
   version). Point it at the 0.14.0 source, or land 0.14.0 there, before rebake.)*
   Then run `cd web && npm run smoke` + re-measure a run's timeline.

## Open decisions (resolve before executing)
- **Item 2 philosophy:** accept show-then-validate-then-hot-swap? (vs current
  validate-before-show).
- **Order:** 3→2→1, or item 1 first (biggest win)?
- **Add the AA-token pre-bake win** to this batch?
- **Image plugin source:** how 0.14.0 reaches `build.sh` (repoint vs copy vs publish).
- **Claude Code local-plugin load** mechanism for step 2.

## Current state (already done)
- Plugin: branch `uplift-perf-0.14.0` off `main` at `230626/skills`; `tile.json`
  bumped 0.13.1 → **0.14.0** (commit `e9a8bc0`). No skill edits yet.
- App: on `webapp-build`, deployed to prod (nav, switching, footer, suggestions,
  ETA-via-Bedrock, eviction/panel fixes). Smoke test `scripts/smoke.mjs`.
- Parallel audit work: worktree `app-audit` (branch `audit`).
