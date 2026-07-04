# Templates + extra-variants plan (uplift → prototype phase)

Two features, designed against the current harness (DO + open-loop runtime) and
UI. Executed autonomously; **deployed to LOCAL only** for the user to test. The
LLM runtime paths (real Opus) are **not** self-tested here (cost); correctness is
by-construction + deterministic where it matters, plus a UI/typecheck/build pass.

## Feature 1 — extra variants from chat (uplift phase)

Goal: not limited to 3 variants — the user can generate more from the Directions
chat, each an additional prototype in a new direction.

**Approach: fork + heavy craft (reuse the proven iterate machinery).** A new
variant D = copy the recommended variant's HTML → `home-D-proposed.html`, then run
impeccable's craft loop with the user's direction ("a calmer option", "editorial
serif", "go bolder"). Same reliability profile as the working iterate flow
(download base file + `_ctx/*`, no full workspace bundle needed). This yields a
genuinely different-looking prototype without the flaky plugin `direct
--add-variant` + selective-render dance. (`direct --add-variant` remains a future
upgrade for from-scratch DESIGN directions — noted, not built.)

- **DO** `runAddVariant(instruction)`: pick next id (max letter + 1), pick a base
  card (recommended → last), mint job `mode:"variant"` with `variantName`,
  `baseFile`, `instruction`. Sequential (one at a time; queue extras). Busy + ETA
  like iterate.
- **Runtime** `mode:"variant"`: restore base file + `_ctx/*` (iterate-style),
  classify intent:
  - QUESTION → `reply_to_user` + `emit_milestone(phase:"variant", event:"answer")`.
  - DIRECTION → `cp` base → `home-<name>-proposed.html`, craft the new direction
    through impeccable, inspect (screenshot), upload, `reply_to_user`,
    `emit_milestone(phase:"variant", event:"added", data:{card:{id,title,pitch,whatif,role,file,thumb}})`.
- **DO ingest**: `variant.added` → append to `realVariants.variants` (dedupe),
  re-emit `panel.variants` (whole array — client already N-agnostic), artifact
  card, clear busy, dequeue. `variant.answer`/`variant.failed` → clear busy +
  message. Artifact-arrival completion + `!done` backstop mirror iterate.
- **UI**: gallery renders N cards (fix `.gallery` to responsive); a "+ new
  direction" affordance on Directions; Directions composer send → `addVariant`.
  Thumb optional (placeholder when absent).

## Feature 2 — prototype phase (other pages/templates in the chosen direction)

Goal: after a variant is selected, generate redesigned prototypes for OTHER pages
of the site in that variant's direction. This is the plugin's native model:
prototype a page using a pinned DESIGN.

**Page discovery (deterministic, LLM-free):** at the end of an uplift run,
`agent.mjs` reads `stardust/current/pages/*.json`, derives candidate pages from
`links.internal[]` (same-host, dedup by path, drop home/anchors/mailto, cap 12,
title from link text/slug), and emits `emit_milestone(phase:"extract",
event:"pages", pages:[{slug,title,url}])`. DO stores + emits `panel.pages`.

**Workspace bundle (for post-run jobs):** at end of an uplift run, `agent.mjs`
tars the project root DESIGN/PRODUCT files + the `stardust/` tree (excluding
skills/runtime/node_modules) → uploads `_workspace.tgz`. Template jobs restore it
so they have the direction, the DESIGN-<id> files, brand extraction, assets, and
the home inventory — self-contained on ephemeral disk (prod) and local alike.

- **DO** `runTemplates(slugs[])`: pin `protoVariant = activeVariant`; for each
  slug fan out a parallel job `mode:"template"` (jobId `tpl-<slug>`) with
  `variantId`, `variantFile`, `slug`, `pageUrl`, `pageTitle`. Pre-seed queued
  `templates[]`. Prototype-screen composer send → one `mode:"template"` job with
  a free `instruction` (agent resolves/extracts the page). Track inflight; busy
  until all done.
- **Runtime** `mode:"template"`: restore bundle; **deterministically pin** the
  chosen variant (`cp DESIGN-<id>.{md,json} DESIGN.{md,json}`; stash the other
  `DESIGN-*` so prototype renders single-variant); then in-loop:
  `stardust:extract <pageUrl> --single` (if the page isn't captured yet) →
  `stardust:prototype <slug>` → save to `/mnt/session/outputs/<slug>-proposed.html`
  → `upload_artifact` → `emit_milestone(phase:"template", event:"page_started" |
  "page_done"{slug,title,file,thumb} | "page_failed")`.
- **DO ingest**: `template.page_*` upsert `templates[]` by slug + emit
  `panel.templates`; artifact card on done.
- **UI**: new `prototype` ScreenId + screen — a page picker (from `panel.pages`)
  with the pinned-direction banner, a page-prototype gallery/switcher, and an
  iframe preview (reuse `previewIframe`). Header `prototype` rung becomes active
  once a variant is selected; a Workspace next-step chip jumps into it.

## Cross-cutting

- `VariantId` widened `"A"|"B"|"C"` → `string` (data model already N-capable:
  variants are an array; `panel.variants`/`segSwitch`/gallery map it).
- Protocol: + `panel.pages`, `panel.templates`; + `addVariant`, `prototype`,
  `setProtoVariant`.
- Persistence: `result_json` gains `pages`, `templates`, `protoVariant` (merged +
  rehydrated) so a reopened run restores the whole state.
- Runner/server: generalized per-job env (`MODE`, job params), isolated per-job
  container/workdir (parallel-safe), job-tracking cancel.
- ETA: variant reuses the iterate pooled median; template a fixed per-page prior.

## Deliberately deferred
- `direct --add-variant` from-scratch DESIGN directions (fork+craft used instead).
- Approval fold-back / migrate-style sibling forking; deploy/rollout/audit phases.
- Thumbnails are best-effort (placeholder when absent).
- Parallel *variant* adds (sequential); page-prototype cross-consistency review.

## Validation (local)
Typecheck + `vite build`; `node --check` the runtime; page discovery unit-tested
(`node runtime/test/pages.test.mjs <pagesDir>`) on 3 real captures. Real Opus
variant/template runs are for the user to exercise on local.

## How to test locally (already running)
Deployed to local: image `stardust-sandbox:latest` rebuilt with the new runtime;
host runner on :8790 and `vite dev` on :5173 restarted on the new code.

1. Sign in at http://localhost:5173/ (Google/GitHub — the app is auth-gated).
2. Start a run (default = real Opus/Bedrock). When it finishes:
   - **Extra directions:** on **Directions**, use the "Another direction" tile (or
     just type in the chat there) — e.g. "a calmer, editorial take". A new card
     (D, E, …) appends to the gallery; open it like any variant.
   - **Prototype phase:** pick a variant (opens Workspace), then click the
     **prototype** rung in the header ladder. Pick pages from the discovered list
     (or ask in chat), hit **Prototype selected** — each renders in the chosen
     variant's direction and opens in the preview.
3. Reopen the run (`/?run=<id>`) — extra variants, discovered pages, and page
   prototypes all restore from `result_json`.

Restart commands if needed:
- runner: `cd app && set -a && . ./.env && set +a && node runtime/runner.mjs`
- dev:    `cd app/web && npm run dev`
- rebake image after runtime edits: `cd app && ./sandbox/build.sh`
