# stardust web app — navigation & information architecture

Design for how a user moves around the app. Proposal (not yet built); pairs with
the "Product / flow ladder" item in IMPROVEMENTS.md.

## The 3 levels

Almost every navigation problem today comes from conflating three distinct
hierarchies. Name and separate them:

1. **Runs** — *which project* am I in. (start new / pick from "Your runs")
2. **Phases** — *where in the journey*: **uplift · prototype · deploy · rollout · audit**.
3. **Views** — *within a phase, what am I looking at*: for uplift →
   working board / brand / directions / a variant.

## Current state (what exists, and the tangle)

| Surface | Today |
|---|---|
| Header | `stardust` logo · decorative 2-rung ladder (`prototype — deploy`) · per-screen action buttons · user chip |
| Right-panel subheader | eyebrow label + view tools (Run audit, viewport, Open-in-tab, A/B/C, Publish) |
| Footer rail | palette · signature · variant/tensions · clock |
| Chat column | project + History · thread · composer; below input: ETA / suggestion chips |
| Landing | hero + URL field + Your runs |
| Toasts / in-chat cards | "artifact ready → open" |

Movement today is a **one-way button chain**: landing → working → *See snapshot*
→ brand → *See directions* → variants → *Open variant C* → workspace; `← Back`
rewinds one step. You can't freely jump between brand / directions / workspace,
the ladder is decorative + 2 rungs, and the three levels are mixed across ad-hoc
buttons.

## Proposed surface roles (one job each)

| Surface | Job | Contents |
|---|---|---|
| **Header** | Macro nav (level 1 entry → 2) | `stardust` logo → **Runs/home**; `festool.com · redesign` → **project dashboard** (4-column board); the **5-rung phase ladder** (uplift · prototype · deploy · rollout · audit; current highlighted, future greyed/disabled); right: the **one primary action** for context + user chip |
| **Right subheader** | Micro view-switcher (level 3) | **persistent segmented tabs** of the phase's views — uplift: **Working · Brand · Directions · Workspace** (each enabled as ready) — plus that view's tools (viewport, Open-in-tab, Publish, Run audit, A/B/C) |
| **Footer rail** | Ambient status (NOT nav) | palette · what's building · run status · clock — "you are here" |
| **Below chat input** | Contextual next-steps | suggestion chips (idle) / ETA bar (working) — actions, not nav |
| **Above chat input** | *(keep clear)* | thread flows into the input; nav lives in header + subheader |
| **Landing / Your runs** | Level 1 | start or pick a project |
| **Toasts + in-chat cards** | Event shortcuts | "Variant C ready → open" jumps to that view |

## How a user moves (the clean model)

- **Pick / start a project** → `stardust` logo (Runs) or landing.
- **See the whole journey** → `festool.com · redesign` → **dashboard** (4-column
  board: done / in-progress / future).
- **Jump to a phase** → a **header rung** (uplift, prototype, …).
- **Switch views inside a phase** → **subheader tabs** (Brand ↔ Directions ↔
  Workspace), any order, once ready.
- **Make changes** → the **chat**, always present; suggestions/toasts as shortcuts.

This **removes the one-way chain and the Back buttons** (tabs + ladder replace
them), makes the **ladder a real navigator**, and gives the dashboard +
deploy/rollout phases a natural home as they come online.

## Audit (a top-level phase)

Audit is its **own phase**, the last rung after rollout — not a view inside
uplift. It runs the same scorecard at different points; **3 steps for now**:

1. **Audit current site** — the live baseline (the diagnosis we redesign against).
2. **Audit new home page** — the deployed page, vs the baseline.
3. **Audit new site** — the rolled-out site, vs the baseline.

It is **greyed/future for now** (we're not running audits yet), shown like the
other future phases: a greyed rung in the header ladder and a greyed column in
the Overview board with the 3 steps. When built, the phase's view holds the
scorecard + before/after delta, run on demand (costs time + tokens).

## Open design calls (proposed defaults — confirm)

- **Subheader = persistent tabs** (not forward-only buttons) → free movement.
  *Proposed: yes.*
- **Keep the area above the chat input clean** (no breadcrumb there; header +
  subheader carry nav). *Proposed: yes.*

## Build note

Largely a re-wiring of existing screens onto the run-state store, not new
rendering: the screens (working/brand/variants/workspace) already exist — they
become **tabbed views** under a phase, the header ladder becomes interactive,
and the dashboard is the new screen. Sequential Back/See-X buttons are retired.
Pairs with URL-as-run-state (IMPROVEMENTS → UX) so each phase/view is linkable.
