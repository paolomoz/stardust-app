# App ↔ plugin alignment plan — stardust 0.14.4 ("Fable 5 refactor")

Aligning the web app to the refactored plugin at
`/Users/paolo/stardust/source/020726/skills/plugins/stardust` (v0.14.4).
The app currently bakes v0.11.0 from `/Users/paolo/stardust/source/skills/…`.

## What changed in the plugin (the parts that touch the app)

| Change | App impact |
|---|---|
| **`stardust/status.jsonl` run contract** — every skill appends `{ts, skill, phase, event: start\|end\|blocked, detail?, artifact?}` at phase boundaries; explicitly designed for harness tailing ("no emit_milestone") | Replaces most of our custom progress machinery — but emission is declared centrally, not enforced per-skill, so it's *augment first, trust later* |
| **Hands-off mode** (`--hands-off`, `state.json.handsOff`) — official non-interactive mode; gates auto-resolve, quality gates never weaken; hard blockers emit `blocked` + halt | Replaces our prompt-level "waive the user gates" hackery with the plugin's own contract |
| **deploy / rollout / diff / audit are now first-class skills** — incl. `deploy-batch.mjs` (resumable DA transport), runtime-contract detection, atomic per-page verify, foundation-first gate, delivery ledger + dashboard | Our hand-distilled `eds-deploy-guide.md` is superseded; our host publisher overlaps `deploy-batch.mjs`; audit = the 5th ladder rung, real |
| **Parallel variants formalized** — isolated workspace copies, sibling `DESIGN-<id>` stashed (NOT renamed), A rendered first to freeze canon, merge-by-slug state contract | Our container fan-out **matches the documented mechanism**; pinning needs a tweak; A-first ordering is a decision |
| **Prototype outputs moved/extended** — `stardust/prototypes/<slug>-{A,B}-proposed.html`, `<slug>-C-proposed.html` (static fallback) **+ `<slug>-C-cinematic.html`**, per-variant `-shape.md`, `lenis.min.{js,css}` for cinematic | Task prompts / uploads / bundle must follow; **cinematic C breaks in the iframe unless lenis assets are uploaded too** |
| **No thumbnail convention** (`assets/thumb-X.png` gone; screenshots at `stardust/validation/<slug>/`) | Thumbs stay a harness-level instruction (we already generate them ourselves) — or switch cards to validation screenshots |
| **Vision verification gates** (extract 2.5, prototype 2.5) + extract crawl hardening; default crawl cap 25→5 | Runs get somewhat longer/more robust → new ETA priors; `--single` uplift unaffected by cap |
| **`distill` skill removed**; refero MCP optional (graceful fallback); impeccable now a hard dep (unpinned), commands read from `command-metadata.json` | System-prompt references and staging must update |
| **Playwright re-probe rule** — skills re-verify ESM-importability each run; crawler must be copied into the project | Our baked `/workspace/node_modules` satisfies it (project root = `/workspace`); no image change expected |

## Alignment principles

1. **Deterministic beats model-discretion**: adopt `status.jsonl` as a tailed
   surface, keep our `emit_milestone` tools for the *panel payloads* (cards,
   palette, pages) that status lines don't carry, keep the file-marker watcher
   as the fallback of last resort.
2. **Keep the sandbox/host seam** — the plugin itself splits the same way:
   conversion/lint/diff are credential-free (sandbox); git push + Code Sync +
   DA writes need creds (host publisher). `deploy-batch.mjs` becomes the
   publisher's DA engine instead of our hand-rolled PUT loop.
3. **Prefer plugin-native contracts over our re-implementations** wherever the
   contract now exists (hands-off, run-status, delivery ledger, diff gates).

---

## Workstream 1 — Rebake + core-contract sync (foundation, do first)

- `sandbox/build.sh`: `STARDUST_SRC` → `/Users/paolo/stardust/source/020726/skills/plugins/stardust/skills`.
- `runtime/system-prompt.md` rewrite:
  - Invoke uplift **with hands-off framing** (the plugin's own non-interactive
    mode) instead of our ad-hoc "waive the gates" text.
  - New uplift phase chain (extract `--single` → tensions → reference
    grounding → 3 directions → direct → prototype ×3), `distill` removed.
  - Deliverable map: copy from `stardust/prototypes/` — `<slug>-A/B-proposed`,
    `<slug>-C-cinematic` (+ its `C-proposed` static fallback), **and
    `lenis.min.js` / `lenis.min.css` when present**; thumbs remain OUR
    instruction (Playwright capture per variant).
  - Tell the agent the plugin's `status.jsonl` contract exists and it must
    still call `emit_milestone` for the payload milestones (variants_ready
    cards, palette, pages) — status lines carry phases, not payloads.
- `runtime/agent.mjs` task prompts: update artifact paths (`stardust/prototypes/…`),
  keep milestone contract unchanged on the wire (DO stays compatible).
- Verify impeccable staging still matches (`command-metadata.json` present in
  3.9.1; bump if the registry file is missing).
- Bundle (`bundleWorkspace`) must include `stardust/prototypes/` (shape.md +
  lenis) — it already tars the whole `stardust/` tree, so just confirm.
- **Exit test**: rebake image → one local wheelercat uplift → 3 variants render
  (incl. cinematic C with lenis), pages panel, bundle, gallery + workspace OK.

## Workstream 2 — Native run-status (progress fidelity++)

- `agent.mjs`: add a **status.jsonl tailer** beside the marker watcher — poll
  `stardust/status.jsonl` (1–2s), forward each NEW line as
  `{phase:"runstatus", line:{skill,phase,event,detail,artifact}}` ingest event.
- DO: map runstatus lines → board rows/status text/progress (skill+phase →
  our task ids; `blocked` → honest failure surface with `detail` as message).
  Panels still come from `emit_milestone` payloads. Markers stay as fallback;
  once status.jsonl proves reliably emitted, retire the marker table.
- `blocked` lines during deploy/rollout (e.g. `DA_TOKEN expired (401)`) map to
  the deploy screen's failure state with the real reason.
- **Exit test**: board advances from status lines on a live run; a forced
  blocked line surfaces the reason in chat + board.

## Workstream 3 — Parallel-build alignment

- `pinVariant()` → **stash-only**: keep `DESIGN-<id>.{md,json}` named as-is at
  root and stash siblings (the plugin's documented selector is file *presence*;
  renaming risks the motion-register keying for cinematic C).
- Build-worker task prompt: output paths per WS1; single-variant flow is now
  the plugin's own isolated-workspace mechanism — say so in the prompt (it can
  follow prototype SKILL.md § parallel directly).
- **A-first canon freeze (DECIDED)**: spec-faithful stagger. `fanOutBuilds`
  dispatches A alone; B and C fan out when A settles (delivered). A's bundle
  re-snapshot carries the frozen canon so B/C fork consistent structure.
  Cost ≈ +1 craft of wall-clock; matters because runs now feed the migrate
  chain (WS5). If A fails after its retry, fall back to fanning B+C anyway
  (a lost A must not sink the run).
- **Variant thumbs (DECIDED)**: keep harness-generated `assets/thumb-<id>.png`
  (exact card framing, no coupling to plugin internals) + a fallback: if a
  worker's thumb is missing at settle, use the newest
  `stardust/validation/<slug>/*.png` from its workspace before showing a
  placeholder.
- Keep R2-verified delivery + retry/drop reconciliation unchanged.
- **Exit test**: parallel run where each worker's DESIGN-<id> stays suffixed;
  cinematic C register verified in the output.

## Workstream 4 — Deploy on the native skill

- **Replace** `runtime/eds-deploy-guide.md` as the conversion brief: the deploy
  job's task prompt now enters `stardust:deploy` (baked skill) through Steps
  1–9 + Step 10 (diff), with the runtime-contract probe first. Keep writing
  the transportable output into `_eds/` (content tree + code tree + manifest)
  so the host publisher contract is unchanged.
- **Runtime: AuthorKit (DECIDED).** Prior plugin reviews established AuthorKit
  outperforms vanilla boilerplate for `stardust:deploy`; the app's current
  vanilla targeting was a branch-local simplification, now reversed. Plan:
  - Every project branch is bootstrapped via
    `bootstrap-authorkit.mjs --ref <pinned sha>` (never a tracking branch —
    the script refuses unpinned `main` by design) before the first deploy;
    after the first project exists, subsequent projects use
    `--from-sibling <first-project-branch>` (offline, drift-free).
  - The bootstrap runs on the HOST publisher side (it needs the repo checkout
    + network for the tarball), as a one-time step in `eds-publish.mjs` when
    a project branch is first created; `stardust/runtime-contract.json` should
    then record `runtime:"authorkit"` and the conversion job generates
    AuthorKit-scoped CSS (`.name`, never `.name.block`) + `.btn` button
    conventions. The computed-layout gate guards the known scoping bug.
  - `stardust-app-fable` **main stays vanilla** (bootstrap is branch-scoped).
  - The existing vanilla-runtime project branches (`wheelercat-com`,
    `festool-com`) get re-bootstrapped + re-deployed when WS4 lands — treat
    them as throwaway validation output, not migration targets.
- Host publisher (`eds-publish.mjs`) evolves:
  - Keep: git push branch, forced Code Sync + marker poll (not scripted by the
    plugin — deliberately host-side).
  - Replace the hand-rolled PUT/preview/live loop with the plugin's
    **`deploy-batch.mjs`** (`--org/--repo/--branch/--content`, `DA_TOKEN` env,
    resumable ledger + retries) staged from the baked skill; tail its
    `.deploy-log.jsonl` → per-page `deploy.page_*` ingest events.
  - Adopt the **atomic delivery contract** asserts (200 + one `<h1>` + zero
    `about:error` + no `/img/` srcs) and the **computed-layout check** (once
    per template, headless) as the publisher's verify step.
- Wire **`stardust:diff`** as the post-preview verify (sandbox job or publisher
  step: PROTO = served prototype, BUILD = branch preview URL; gate on 0
  structural 🔴). Surface results in the deploy screen per page.
- **Exit test**: wheelercat deploy → preview via deploy-batch ledger → diff
  gate green → go live.

## Workstream 5 — Rollout: adopt the migrate chain (the real upgrade)

Current app rollout = prototype remaining pages + one conversion job. The
plugin's rollout is a different animal (inventory → block dedup → per-page
deploy off a coverage ledger → verify → optimize → dashboard) and **requires
the migrated tree** (full or archetypes-only).

**DECIDED: the native migrate-chain rollout replaces the app's
prototype-based rollout.** The current rollout stays only as an interim
behavior until this ships, then the Roll-out action switches over.

- The **"site migration" mode** — one long-running container runs the
  hands-off chain (`prepare-migration → migrate (archetypes-only OK) →
  rollout`), with:
  - `status.jsonl` + `stardust/rollout/coverage/pages.json` +
    `dashboard/data.json` tailed into the app (the rollout screen becomes the
    plugin's coverage model: per-page status, fidelity-tier distribution,
    content-pending).
  - Delivery still split: sandbox authors; host publisher pushes code and runs
    `deploy-batch.mjs`; `blocked` lines pause the run visibly.
  - Fidelity tiers (`archetype/sibling/thin`) surfaced on the rollout board so
    "N/N deployed" can't hide ungated pages.

## Workstream 6 — Audit rung (new)

- New job mode `audit`: task = `stardust:audit <url>` (optionally `--single`
  for speed); upload `stardust/audit/<slug>/{audit.json,report.html}` as run
  artifacts; terminal = report uploaded (plus `status.jsonl` phases for the
  board).
- App: light up the **audit** ladder rung + screen — iframe `report.html`
  (it's craft-rendered + self-contained), scorecard chips from `audit.json`.
- Two entry points: audit an existing run's site (post-deploy: audit the
  aem.live URL — before/after story), or audit-first on the landing (its
  closing "uplift directions" feed straight into an uplift run — the plugin
  wires `audit.json` into uplift's candidate improvements).
- Degradations are graceful (no refero/marketing-skills in the sandbox →
  built-in heuristics), so no new dependencies required.

## Workstream 7 — ETA, board, cleanup

- `PIPELINE_VERSION` → `"fable-1"` (vision gates + new phases change the
  timing shape); re-seed priors from the first rebaked runs.
- Board task rows: re-map to the new phase names (from status.jsonl `skill` +
  `phase`) instead of our six hardcoded uplift rows; add audit column states.
- Remove `eds-deploy-guide.md` (superseded), retire marker table once WS2
  proves out, drop thumb instructions IF we switch cards to
  `stardust/validation/<slug>/` screenshots (**decision**: keep harness thumbs
  for now — they're what the gallery design expects).

## Sequencing & effort

| Order | WS | Size | Risk |
|---|---|---|---|
| 1 | WS1 rebake + contracts | M | Low — mostly prompt/path edits + 1 paid validation run |
| 2 | WS2 run-status tailer | S–M | Low — additive, fallback retained |
| 3 | WS3 parallel alignment | S | Low |
| 4 | WS4 deploy native | M–L | Medium — runtime decision + publisher swap |
| 5 | WS6 audit rung | M | Low — self-contained new mode + screen |
| 6 | WS5b migrate-chain rollout | L | Medium-high — biggest payoff, do last |
| 7 | WS7 cleanup/ETA | S | Low |

Validation budget: ~3 paid runs (1 uplift after WS1–3, 1 deploy+diff after
WS4, 1 audit after WS6) + the 5b chain when we get there. All local first;
prod redeploy only after local passes.

## Decisions (all settled, 2026-07-03)

1. **A-first canon freeze** — YES, spec-faithful stagger (A first, then B+C on
   A settling; fall back to parallel if A dies).
2. **Deploy runtime** — **AuthorKit**, bootstrapped per project branch
   (pinned `--ref`, then `--from-sibling`); existing vanilla branches
   re-deployed. (Prior reviews: AuthorKit performs better for stardust:deploy.)
3. **Rollout** — the plugin's native migrate-chain rollout replaces the
   prototype-based one (WS5).
4. **Variant cards** — keep harness thumbs, with a validation-screenshot
   fallback when a thumb is missing.
