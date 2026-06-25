---
theme: stardust — a quiet, dark, crafted instrument; Ink ground, a single Amber signal, restraint as identity
colors:
  # Grounds
  ink: "#0A1024"          # night ground — the default background; everything happens here
  ink-deep: "#060A14"     # deepest ground — radial-gradient floor, recessed wells
  ink-soft: "#141B3A"     # raised surface — cards, panels, inputs
  ink-line: "#1A2450"     # radial-gradient ceiling / hairline-on-dark warm edge
  # Signal (use ONCE per view)
  amber: "#E8B95E"        # the signal — accent, primary action, the star
  amber-light: "#FFD98A"  # core — center of the star; emphasis only, never a fill field
  amber-deep: "#C9822D"   # amber on light grounds; pressed/active amber
  # Light ground (day / print-like surfaces, e.g. light logo lockups, exported docs)
  dust: "#F5F0E6"         # warmed day ground — not pure white
  cream: "#F6EFE2"        # alt light ground
  deep-ink: "#1A1F38"     # dark type on light — never pure black
  # Foreground on Ink (Dust at opacity — canonical text ramp)
  fg: "rgba(245,240,230,0.92)"      # primary text on dark
  fg-muted: "rgba(245,240,230,0.72)" # body text (AA-verified on Ink)
  fg-dim: "rgba(245,240,230,0.50)"   # captions, secondary labels
  fg-faint: "rgba(245,240,230,0.30)" # disabled, ghost
  hairline: "rgba(245,240,230,0.15)" # visible divider on dark
  hairline-soft: "rgba(245,240,230,0.08)" # card border, faint divider
  # State (reinforced with text/shape; never color-only)
  danger: "#FF6B6B"       # errors, destructive, "don't"
  success: "#7FB98A"      # confirmation (quiet sage, not neon)
typography:
  display: "SF Pro Display, Inter, system-ui, sans-serif"   # wordmark + headings
  text: "SF Pro Text, Inter, system-ui, sans-serif"          # body, UI copy
  mono: "SF Mono, JetBrains Mono, ui-monospace, monospace"   # seeds, commands, provenance, eyebrows
  scale-ratio: "1.25 (major third)"
  display-letter-spacing: "-0.02em"   # tighter (-0.03 to -0.04em) only at hero sizes
  display-weight-ceiling: 600          # never heavier — turns shouty
  body-size: "15px"
  body-line-height: "1.55"
  body-measure: "62ch"
rounded: "14px cards · 18px large surfaces · 8px controls · 4–6px small tiles · pill for status chips"
spacing: "4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96  (4px base)"
components: "TopBar+Ladder · Conversation thread · Composer · StagePanel · Eyebrow · SeedChip · Button (primary/secondary/quiet) · PaletteSwatch · VariantCard (3-up) · PreviewFrame+ViewportToggle · PageGrid/CoverageLedger · StatusPill · ProgressBar · StarMark · DustField"
---

# stardust — Design System

The north star: **a quiet, dark, crafted instrument.** Ink is the ground;
everything happens on it. A single Amber signal does the pointing. The
surface stays calm so the work — and a few deliberate signature moments —
can be the thing you notice. Dense and *simple*, never dense and featured.

This is a committed brand identity (see the stardust identity guide), so its
palette, type voices, and signatures are fixed. Identity-preservation wins
over any greenfield default.

---

## Color

**Strategy: Committed-dark with a single accent.** Ink carries the surface;
Amber is rationed to one signal per view (the primary action, or the one
thing that matters most right now). Amber Light is rarer still — the *core*,
reserved for the center of the star and true emphasis. Restraint is not
timidity here; it is the voice. When everything is quiet, the one amber thing
is unmissable.

Roles:
- **Ink `#0A1024`** — default background. **Ink-deep `#060A14`** floors the
  radial grounds and recessed wells. **Ink-soft `#141B3A`** is the only
  raised surface (cards, panels, inputs), edged with a `hairline-soft`
  (Dust 0.08) border — never a heavier stroke.
- **Amber `#E8B95E`** — the signal. Primary buttons, the active rung, the
  selected variant, focus rings, the star. **One per view.**
- **Amber Light `#FFD98A`** — emphasis only; the star's core. Not a fill.
- **Dust ramp on Ink** — text is Dust at opacity: `0.92` primary, `0.72`
  body (AA-verified on Ink), `0.50` captions, `0.30` ghost. Dividers at
  `0.15` (visible) / `0.08` (faint).
- **Dust `#F5F0E6` / Deep-ink `#1A1F38`** — the light ground and its text,
  for day/print-like surfaces (light logo lockups, exported brand reviews).
  Never pure white, never pure black.
- **Danger `#FF6B6B` / Success `#7FB98A`** — state, always paired with a
  label or icon. Color never carries meaning alone.

Contrast is non-negotiable: body never drops below Dust 0.72 on Ink. No
faint-gray-for-elegance. Amber-on-Ink and Ink-on-Amber both pass AA.

**Bans:** cyan/purple SaaS gradients · gradient *text* · amber used as a
large fill field · more than one amber signal competing in a single view ·
glassmorphism as decoration.

### Day mode — the selected app theme (locked 2026-06-25)

After iterating on the anchor screen, the app ships **day mode**: a deep-ink
header band over a light workspace, with the prototype preview floating as a
rounded card. Promoted day-mode tokens (also in `DESIGN.json.color.day`):

| Token | Value | Role |
|---|---|---|
| `--header` | `#1A1F38` | deep-ink header band |
| `--bg` | `#F5F0E6` | dust — chrome ground (chat, rail) |
| `--surface` | `#FFFDF8` | raised — cards, inputs, subheader |
| `--sunken` | `#ECE4D2` | inset wells (toggle tracks, switch keys) |
| `--desk` | `#E8E1D2` | desk ground the preview card floats on |
| `--canvas` | `#E6DDCA` | mobile-preview backdrop |
| `--paper` | `#F3EEE4` | artifact ground inside the card |
| fg ramp | deep-ink `#1A1F38` @ .95/.72/.52/.30 | text on light |
| on-dark ramp | dust `#F5F0E6` @ .94/.52/.28/.14 | text on the deep-ink header |
| `--success` (day) | `#5F9669` | confirmation on light |

**The amber rule on light** (the key faithful decision): **bright Amber
`#E8B95E` *signals*** — used as fills/jewels (primary call, active pip,
selected key, the star's core), always with dark text or as a small jewel;
**Amber-deep `#C9822D` *speaks*** — amber-as-text where it must stay legible
(eyebrows, the ✦, seed hash, step numbers); **Deep-ink `#1A1F38`
*structures*** — text and the star's arms.

**Selected shell combination:** deep-ink header (amber star, light text) ·
320px chat spine · preview as a floating rounded card (radius 14, margin 12)
on the desk with its toolbar as an in-card subheader and the artifact
full-bleed within · 2-phase ladder (**prototype** · **deploy**) · mono footer
rail. This is the canonical frame every screen inherits.

---

## Typography

**Three voices, one hierarchy** — and they never blur into each other:

- **Display** (SF Pro Display / Inter) — the wordmark and headings.
  Letter-spacing `-0.02em` (tighten to `-0.03/-0.04em` only at hero sizes).
  Weight **500–600, never heavier** — past 600 it shouts. Tight line-height
  (0.95–1.1). Use `text-wrap: balance` on headings.
- **Text** (SF Pro Text / Inter) — all body and UI copy. 15px / 1.55,
  weight 400, measure capped at 62ch, **left-align only**. Add ~0.05 to
  line-height for light-on-dark.
- **Mono** (SF Mono / JetBrains Mono) — reserved for what the tool says
  *literally*: seeds, hashes, commands, provenance stamps, and the uppercase
  **eyebrow** label (Amber, letter-spacing 0.14–0.18em). **Never for prose.**

Type scale (app surfaces — restrained; the giant sizes are for the landing
hero only):

| Token | Size | Use |
|---|---|---|
| `display-hero` | clamp(48px, 8vw, 96px) | Rung-0 landing / empty-state only |
| `display-xl` | 40px | major screen title |
| `display-l` | 28px | panel / section title |
| `display-m` | 20px | card / subsection title |
| `body-lg` | 17px | lede, agent's lead line |
| `body` | 15px | default body & UI |
| `body-sm` | 13px | captions, secondary |
| `mono` | 13px | seed / command / provenance |
| `eyebrow` | 11px | mono uppercase label, amber |

**The eyebrow is a deliberate, named brand system — not section scaffolding.**
Use it to label a *kind* of surface (e.g. a `SEED` chip, a `PROVENANCE`
stamp, a panel's role), not above every block. Repeating it on every section
is the AI tell the identity warns against; one per surface, with intent.

Pairing note: SF Pro and Inter are one family + system fallback, used across
weights — not a two-font pairing. Mono carries the contrast axis. This is the
committed identity; the reflex-reject lists don't apply to it.

---

## Spacing & Layout

- **Base 4px scale:** 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96. Vary it for
  rhythm — tight groupings inside calm, generous separations between regions.
- **The app shell** is the persistent frame: a slim **TopBar** (project +
  ladder progress), a **Conversation** column (the spine, ~minmax(360px,
  440px)), a flexible **StagePanel** (where visual work renders), and a thin
  **context Rail** (palette · signature · page states · activity). The shell
  never changes between rungs; only the StagePanel content does.
- **Density: tight but simple.** Comfortable line-height and clear grouping;
  no cramped data tables, no toolbars. Whitespace does the organizing.
- Flexbox for 1D, Grid for 2D. Responsive card sets use
  `repeat(auto-fit, minmax(280px, 1fr))`. Cards are used only when they are
  truly the best affordance (variants, palettes, pages) — never as default
  scaffolding, never nested.
- Semantic z-index scale: base → raised → sticky → preview-overlay →
  modal-backdrop → modal → toast → tooltip. No magic 9999s.

---

## Components

- **TopBar + Ladder** — project name (with star mark) at left; the four-rung
  ladder (Explore · Templates · Deploy · Rollout) as a quiet progress
  indicator; the next-rung action at right.
- **Conversation thread** — agent turns and user turns. The agent reasons in
  the open: a lead line (body-lg), then plain body. Inline mono for seeds and
  commands. Plans render as compact, confirmable blocks.
- **Composer** — a single calm input ("tell me a change…"); the whole
  interaction funnels through it. Ink-soft, hairline-soft border, amber focus.
- **StagePanel** — the right surface. Hosts: brand snapshot, palette picker,
  3-up variant gallery, live PreviewFrame, page grid, deploy run.
- **Eyebrow** — mono, uppercase, amber, wide tracking. A labeled role marker.
- **SeedChip** — mono provenance token, e.g. `seed a3f7c9 · md5(acme·06-25)`.
  Dust-dim, amber hash. The visible "show the seed" signature.
- **Button** — *primary*: amber fill, Ink text, 8px radius, weight 500 (one
  per view). *secondary*: transparent, hairline border, Dust text.
  *quiet*: text-only, Dust-dim → Dust on hover. No gradients, no shadows-as-
  decoration.
- **PaletteSwatch** — color cell with mono hex + role; a "recommended" badge
  in amber. The picker is a gate: nothing auto-confirms.
- **VariantCard** — a screenshot at matched viewport, a one-line pitch, an
  A/B/C marker; the recommended one wears the single amber ring.
- **PreviewFrame + ViewportToggle** — the live prototype in an iframe with
  desktop/mobile toggle and an open-in-tab affordance.
- **PageGrid / CoverageLedger** — pages as compact rows/cells grouped by
  type, each a StatusPill. Scales from 3 templates to a whole-site ledger.
- **StatusPill** — pill chip: `extracted · directed · prototyped · approved ·
  deployed · stale`. State by label + subtle tint, never color alone.
- **ProgressBar** — thin, amber on hairline; for extract/render/deploy runs.

---

## Motion

Restrained and purposeful, **editorial pace**. Ease-out with exponential
curves (`cubic-bezier(0.16, 1, 0.3, 1)`); no bounce, no elastic, nothing
springy. Typical entrance 400–700ms, stagger ~70–90ms within one list only.

- Reveals **enhance an already-visible default** — never gate content on a
  class that might not fire.
- **Reduced motion is mandatory**: dust field becomes static, radial grounds
  hold, reveals become instant or a soft crossfade.
- One well-judged moment beats scattered micro-interactions. The agent
  "thinking," a variant settling in, a deploy completing — each gets a
  single, calm gesture.

---

## Signature moments (use sparingly — that's what makes them signatures)

1. **The four-point star, built from squares.** The mark. Output emerges
   from structure, not chance. Appears in the TopBar, as the loading/thinking
   indicator (squares assembling), and as a quiet watermark in empty states.
2. **The dust field.** A faint scatter of tiny Dust dots on Ink grounds —
   on the landing, empty states, and hero/feature moments only. Never behind
   reading copy.
3. **Show the seed.** The `SeedChip` and provenance stamps make generated
   work reproducible and visible — `md5(brand·date)`. The brand's core gesture.
4. **Mono eyebrows.** Amber, uppercase, wide-tracked — labeling a surface's
   role, one per surface.
5. **Ink→deep radial grounds.** A `radial-gradient(ellipse, ink-line → ink-
   deep)` for hero and feature moments; the "night sky" the dust sits in.
6. **Amber `::selection`.** Selected text is Amber on Ink — a tiny, constant
   reminder of the signal color, everywhere.

---

## The AI-slop test (project-specific)

stardust is a tool that exists to *defeat* generic output, so its own surface
must pass hard. Fail conditions specific to this project:
- Any cyan/purple gradient, anywhere.
- Amber used as a large fill or more than once per view.
- Mono used for prose, or eyebrows above every block.
- A feature-dense, panel-heavy "dashboard" look.
- Hype copy. If a sentence could appear on any AI product page, cut it.
If someone could say "an AI made this" — it failed. The bar is: "how was
this made?"
