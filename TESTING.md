# stardust web app — capability test script

A click-by-click walkthrough of everything built so far (M1–M6 #1/#2). Follow
top to bottom. Each test is tagged **FREE** (no model spend) or **$ COST**
(spawns a real Claude Opus run on Bedrock — real money/time).

> Tip: most capabilities can be seen **FREE** by reopening finished runs and
> using the scripted demo. Only the two **$ COST** tests actually call the model.

---

## 0. Start the services (once)

Two processes must be running. In two terminals from `app/`:

```bash
# Terminal 1 — the host runner (executes the sandbox containers)
cd app && set -a && . ./.env && set +a && node runtime/runner.mjs
# expect: [runner] listening on http://localhost:8790 ... backends=cerebras,bedrock

# Terminal 2 — the web app (Worker + DO + SPA)
cd app/web && npm run dev
# expect: Local: http://localhost:5173/
```

Sanity check (any terminal):
```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN -t >/dev/null && echo "dev UP"
lsof -nP -iTCP:8790 -sTCP:LISTEN -t >/dev/null && echo "runner UP"
```

The URL **mode** is chosen by a query param:
- `http://localhost:5173/` → **scripted demo** (FREE, replays the knack sample)
- `…/?mode=bedrock` → **real run, Claude Opus** ($ COST)
- `…/?mode=cerebras` → real run, Gemma (cheaper, lower quality)
- `…/?run=<id>` → **reopen** a finished run (FREE, replays from the database)

---

## 1. FREE — Reopen a finished real run, walk all four screens

This shows a *real* Opus result (JFK airport) without spending anything.

Open: **http://localhost:5173/?run=e107d9df-75f4-48e4-a182-994bcba87d2d**

You land on the **workspace** (the run is finished). Walk it backwards and forwards:

1. **Workspace** (where you land)
   - [ ] Live redesign of variant **C** renders in the iframe (big "JFK", an
         "Ask me anything" search, Departures/Arrivals/Parking, an Ask-JFK button).
   - [ ] Toolbar **A / B / C** switches the preview (risk-averse · design-team · visionary).
   - [ ] **Desktop/mobile** toggle (top-right of the panel) reflows the preview.
   - [ ] Footer reads `variant C · visionary · ready to iterate` and shows the palette.
   - Note: variant C's hero wordmark is already enlarged — that's the iteration
     from test #4, applied to this run.
2. Click **Restart** (top-left) to go back to landing, then reopen the URL again,
   and this time check the earlier screens via the run's history — or just open
   these sibling runs to compare:
   - Brand + variants screens are reached during a live run (test #3). On a
     reopened finished run you land in the workspace; that's expected.

Compare-the-quality bonus (FREE): open these and eyeball the brand reviews / variants:
- JFK (Opus): the three variant files under `…/api/artifacts/e107d9df-…/`
- The Road Home (Opus): `…/?run=fed50ff4-7a…` style — see §Appendix for full IDs.

---

## 2. FREE — The scripted demo (full screen-to-screen flow, no model)

This is the fastest way to feel the **whole transition flow** (landing → working
→ brand → variants → workspace) with zero cost. It replays the canned knack
sample.

Open: **http://localhost:5173/** (no `?mode`)

1. [ ] Landing hero with a URL field (prefilled). Click the **arrow** to start.
2. [ ] **Working** screen: task list ticks (crawl → read → extract → analyze →
       generate → validate), progress bar fills, status line cycles. After a few
       seconds **See snapshot** lights up.
3. [ ] Click **See snapshot** → **Brand** screen: brand review iframe + tensions list.
4. [ ] Click **See directions** → **Variants** screen: 3 cards + shared fixes,
       a RECOMMENDED badge.
5. [ ] Click **Open variant C** (top-right) → **Workspace**: live preview + A/B/C.
6. [ ] Try the **back** controls / ladder to move between screens.

---

## 3. $ COST — A fresh full uplift run (the headline capability)

This actually reads a new site and produces three real redesigns with Claude
Opus. **~25–35 min, real spend (~$50–80).** Do this when you want to see a real
end-to-end run.

Open: **http://localhost:5173/?mode=bedrock**

1. Paste a homepage URL (pick a content-rich site; avoid heavy bot-walls).
2. Click the arrow.
3. [ ] **Working**: tasks tick with *real* details ("4 tensions", "A · B · C"),
       footer shows `bedrock · opus · live`.
4. [ ] When **See snapshot** lights up → **Brand**: real captured brand + measured
       tensions (e.g. "88% empty alt text").
5. [ ] **See directions** → **Variants**: 3 real cards with live thumbnails,
       shared fixes, what-ifs.
6. [ ] **Open** a card → **Workspace**: the real redesign renders live.

While it runs you can watch from a terminal (see §Appendix "Monitor a run").

---

## 4. $ COST (cheap) — Iterate a variant by chat (M6 #1)

Re-renders one variant in place through impeccable. **~2–4 min, a fraction of a
full run.** Uses the persisted workspace of an existing run — no re-extraction.

Open: **http://localhost:5173/?run=e107d9df-75f4-48e4-a182-994bcba87d2d**

1. In the toolbar, pick the variant you want to change (e.g. **B**).
2. In the left composer ("tell me a change…"), type something visible, e.g.
   *"make the hero headline larger and add a subtle fade-up on load"*, press Enter.
3. [ ] An agent message appears: **"On it — re-rendering variant B: …"** and the
       footer clock shows `re-rendering B`.
4. [ ] Narration streams (it picks an impeccable command — typeset/colorize/etc.,
       edits surgically, verifies in the browser).
5. [ ] On finish: **"Done — re-rendered variant B"** and the **preview reloads
       itself** with the change (no manual refresh).
6. [ ] Switch A/B/C — only the variant you changed is different; the others are
       untouched.

---

## 5. $ (seconds) — Cancel an in-flight run (M6 #2)

Confirms a run is stoppable and reports honestly. Costs only the few seconds
before you hit Stop.

Open: **http://localhost:5173/?mode=bedrock**

1. Paste any URL, start the run.
2. As soon as you're on the **Working** screen (a few seconds), click **Stop**
   (top-left).
3. [ ] The loading stage is replaced by an error card: **"Run stopped — Run
       canceled."** with a **Start over** button; spinners stop.
4. [ ] The thread shows **"✦ Run canceled."**

Backend proof (optional, while/after):
```bash
docker ps --format '{{.Names}}'        # the stardust-<id> container disappears after Stop
# run status flips to 'canceled' in the DB (see Appendix)
```

---

## 6. FREE-ish — Honest failure / empty states (M6 #2)

The error-card UI (same one you saw in test #5) also covers crashes and
empty results:
- **Crash**: if the runtime dies, the card shows the error instead of a hung
  spinner. (To force one you'd run a junk/unreachable URL — that still spawns a
  short Opus run, so it's not strictly free.)
- **Empty result**: a real run that extracts nothing (bot-wall / too-sparse)
  reports *"I couldn't read enough of the brand to produce variants… try another
  URL"* rather than showing demo cards.

You already saw this exact card via Cancel (#5), so no separate spend is needed
unless you specifically want to see a crash message.

---

## 7. FREE — Reduced motion (accessibility)

1. Turn on **System Settings → Accessibility → Display → Reduce motion** (macOS).
2. Reload **http://localhost:5173/** and run the scripted demo (#2).
3. [ ] Spinners/rings don't animate, screen transitions are instant, the progress
       bar jumps rather than slides. The flow is still fully usable.

---

## Appendix

### Reopenable finished runs (FREE)
| Run | Backend | Site | Open |
|-----|---------|------|------|
| `e107d9df-75f4-48e4-a182-994bcba87d2d` | Opus | JFK airport (+ iteration applied) | `/?run=e107d9df-75f4-48e4-a182-994bcba87d2d` |
| `fed50ff4-…` | Opus | The Road Home | see full id below |
| `a9a28a6f-…` | Gemma | The Road Home | — |

Get full IDs / pick others:
```bash
cd app/web
npx wrangler d1 execute stardust-web-db --local --command \
  "SELECT id, mode, status, url FROM runs WHERE status='done' ORDER BY created_at DESC"
```

### Open a variant artifact directly (FREE)
```
http://localhost:5173/api/artifacts/<runId>/home-A-proposed.html
http://localhost:5173/api/artifacts/<runId>/home-B-proposed.html
http://localhost:5173/api/artifacts/<runId>/home-C-cinematic.html
http://localhost:5173/api/artifacts/<runId>/brand-review.html
```

### Monitor a run from the terminal
```bash
# live container
docker ps --filter ancestor=stardust-sandbox --format '{{.Names}} {{.Status}}'

# run status + recent narration (replace RID)
cd app/web; RID=<full-run-id>
npx wrangler d1 execute stardust-web-db --local --command \
  "SELECT status FROM runs WHERE id='$RID'"
npx wrangler d1 execute stardust-web-db --local --command \
  "SELECT seq, json_extract(payload,'\$.t') t FROM run_events WHERE run_id='$RID' ORDER BY seq DESC LIMIT 12"
```

### Known limitation
Reopening a *failed/canceled* run lands on the working screen but may not
re-draw the error card (the card is drawn on live state change). A live failure
or cancel (#5) shows it reliably. Easy to harden if you want it on reopen too.
