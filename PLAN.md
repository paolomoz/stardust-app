# stardust web app — full-flow prototype plan

> Build a clickable, motion-rich UX mock of the **entire** stardust flow, in the
> locked day-mode shell, using the real **knack** uplift project as the sample
> client. Linear, interactive, self-contained. Built 2026-06-25.

## Source of truth
- Theme + shell: `DESIGN.md` / `DESIGN.json` (day mode, selected combination).
- Sample client: **Knack** (no-code app/database builder, magenta brand).
  Artifacts copied to `prototypes/assets/knack/`:
  - `home-A-proposed.html` · `home-B-proposed.html` · `home-C-proposed.html` ·
    `home-C-cinematic.html` — real redesign variants (iframe these as the artifact).
  - `assets/thumb-A|B|C.png` — full-page variant thumbnails (variant cards).
  - `assets/original-home.png` — captured "before" (brand snapshot / before-after).
  - `assets/logo.svg`, `assets/media/screenshot-*.webp` — brand assets.
  - `assets/live-aem.png` — screenshot of the live deployment
    (https://main--uplift-knack-eds--paolomoz.aem.live/).
  - Brand: magenta `#982A86`, hot-pink `#FF349A`, coral `#FA816E`, ink `#1A181D`,
    Inter. Improvements (5) + variant roles from the real `direction.md`.

## The two phases (header ladder)
1. **prototype** — the platform-agnostic design phase (absorbs old Explore +
   Templates): paste URL → snapshot → variants → iterate the redesign.
2. **deploy** — the AEM phase (absorbs old Deploy + Rollout): map to EDS blocks,
   deploy templates, roll out the full site.

## Architecture
- `app.css` — tokens (day mode) + shell (header/ladder/star, chat, composer,
  preview card, subheader, seg switch, viewport toggle, preview, footer rail) +
  shared components (buttons, eyebrow, seed chip, message, plan block) + page
  transitions. Every screen links it.
- `app.js` — page-transition in/out (`data-nav`), auto-advance (`data-advance`/
  `data-delay`), viewport toggle, variant seg switch.
- Screen-specific layout lives in a small per-screen `<style>`.
- Motion: editorial ease `cubic-bezier(.16,1,.3,1)`; reveal/stagger on load;
  reduced-motion honored. Deploy-run echoes knack's own "live-systems" register
  (progress fills, pulse) as a deliberate nod.

## Screens (linear flow; files in `prototypes/`)

### 0 · index.html — Landing  *(fullscreen, no shell)*
- Ink? No — day mode: dust ground + faint dust field + amber star + `stardust`
  wordmark, tagline `brief + seed = star`. One input prefilled
  `https://www.knack.com/`, amber send. Recent chips.
- Motion: dust twinkle (subtle), wordmark + input rise-in.
- → `capturing.html` (Enter / send).

### 1 · capturing.html — Reading the site  *(shell; phase: prototype)*
- Chat: agent narrates extract ("Reading knack.com… found the palette, the
  type, your hero"), streaming check-lines.
- Card subheader: `SNAPSHOT · knack.com`.
- Card body: brand snapshot building in — knack logo, magenta palette swatches,
  type (Inter), original-home.png thumbnail, and **tensions** (real: 21 CTA
  labels, flat type scale, magenta under-used). Items stagger in.
- Motion: progress bar; items stagger; auto-advance → `variants.html` (~2.6s),
  with a "Skip" affordance.

### 2 · variants.html — Pick a direction  *(shell; phase: prototype)*
- Chat: "Found 3 directions. My pick is C — motion as identity." + the knack
  what-if framing.
- Card subheader: `DIRECTIONS · 3`.
- Card body: 3-up gallery using thumb-A/B/C with pitches (A faithful · B magenta
  amplified · C cinematic). C wears the single amber recommended ring.
- Motion: cards stagger + hover lift. Click a card → `workspace.html` (variant
  carried via `?v=` is cosmetic; default C).

### 3 · workspace.html — Iterate  *(shell; phase: prototype)*  ← core
- Chat: pick rationale + a real iteration ("make the hero bolder" → plan →
  applied) + seed chip.
- Card subheader: `PROTOTYPE` + A/B/C seg switch (C active) + viewport toggle +
  open-in-tab.
- Card body: **iframe the real proposed file** (`assets/knack/home-C-cinematic.html`;
  A→home-A, B→home-B). Seg switch swaps the iframe; viewport toggle narrows it.
- Header CTA `Deploy →` → `deploy.html`.

### 4 · deploy.html — Map to AEM  *(shell; phase: deploy active)*
- Chat: "Here's how your prototype becomes Edge Delivery blocks."
- Card subheader: `DEPLOY · Edge Delivery`.
- Card body: connect-AEM strip (org/site/DA, "Connected ✓") + block-mapping list
  (hero→`hero` block, comparison→`cards`, switcher→`tabs`, ticker→`metrics`,
  body→default content…). Rows stagger.
- CTA `Deploy 3 templates →` → `deploy-run.html`.

### 5 · deploy-run.html — Deploying  *(shell; phase: deploy)*
- Chat: "Deploying — blocks, then content, then publish."
- Card body: per-template rows (Home, Solution, Listing) each with blocks ✓ →
  content fill → publish; live-systems progress fills + pulse. Auto-advance →
  `live.html` (~3s).

### 6 · live.html — Live + rollout  *(shell; phase: deploy)*
- Chat: "Your key pages are live on AEM. Roll out the rest at your pace."
- Card body: top = live result (live-aem.png + the live URL, "open" / "share");
  below = **rollout coverage ledger** — full-site grid by type (Home ✓, Solutions
  30, Use cases 12, Integrations…), progress "3 / 48 live"; `Roll out next 10`
  fills more cells (interactive).
- Done state of the flow. `Restart` (header) → index.

## Cross-cutting
- Header `Restart` → `index.html` everywhere. Ladder shows phase per screen.
- Footer rail: palette (knack magenta swatches) · signature · pages · activity.
- All nav via `data-nav` for fade transitions. Auto-advances cancellable.
- Verify each screen in Playwright (no overflow, no console errors, correct
  computed theme), screenshot, fix, then proceed.

## Build order
1. app.css → 2. app.js → 3. index → 4. capturing → 5. variants →
6. workspace (adapt existing) → 7. deploy → 8. deploy-run → 9. live →
10. Playwright pass on all, fix, final screenshots.
