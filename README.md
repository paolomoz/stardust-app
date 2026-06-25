# stardust-app

A clickable, motion-rich UX prototype of **stardust** as a browser web
application — the tool that redesigns an existing website and ships it to Adobe
Experience Manager (Edge Delivery).

It's self-contained static HTML/CSS/JS. No build step.

## Run it

Open **`prototypes/index.html`** in a browser, then use the **DEMO dock**
(bottom-right) to step through every screen — `Next ▸`, the `◀`/`→` arrow keys,
or the `▦` menu to jump to any screen.

## The flow

A two-phase **ladder** — `prototype` (platform-agnostic design) and `deploy`
(AEM deploy + rollout) — across these screens:

1. **Landing** — paste a URL.
2. **Studio · working** — stardust reads the site, thinks and executes (a real
   ~20-minute step, compressed); task stream + loading experience.
3. **Brand review** — the captured brand surface (full artifact), with a
   **Run audit** button.
4. **Audit** *(aside)* — full site audit: scorecard, brand-pixel weighting,
   tensions, design & a11y findings, SEO + Core Web Vitals, direction.
5. **Directions** — three brand-faithful variants (A faithful · B magenta ·
   C cinematic), with the shared fixes and each one's "what if".
6. **Workspace** — iterate the chosen variant (the real redesign, iframed);
   chat + variant switch + viewport toggle.
7. **Map to AEM** — prototype sections → Edge Delivery blocks.
8. **Deploying** — block / content / publish progress.
9. **Rollout dashboard** — templates list + full-site page tree with per-page
   status (live · content-pending · queued · review), site-coverage bar.

## Design system

Day-mode theme: deep-ink header band over a light workspace, preview as a
floating rounded card. One bright **amber** signal; **amber-deep** for
amber-as-text; **deep-ink** for structure. See `DESIGN.md` / `DESIGN.json`
(tokens) and `PRODUCT.md` (strategy). `PLAN.md` documents the full build.

Shared shell + tokens live in `prototypes/app.css`; interactions (transitions,
demo dock, tree, variant switch) in `prototypes/app.js`.

## Sample content

The redesign sample is the real **knack.com** uplift — variants, brand review,
audit data, product screenshots, and the live AEM deployment
(`main--uplift-knack-eds--paolomoz.aem.live`) — under
`prototypes/assets/knack/` and `prototypes/assets/knack-review/`.

---

Built with [impeccable](https://github.com/pbakaus/impeccable) for the design
craft. Prototype only — not production code.
