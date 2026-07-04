# Harness deploy contract (app ↔ publisher)

The conversion itself is the plugin's job now — **follow
`/workspace/skills/stardust/deploy/SKILL.md`** (Steps 1–9; the task prompt
tells you what to skip in this sandbox). This file defines only the
harness-specific contract: where output goes and what the host publisher does
with it.

## Target runtime (fixed by policy — do not probe)

Every project branch is **AuthorKit** (the publisher bootstraps it, pinned
ref, before pushing). Treat this as `stardust/runtime-contract.json`:

```json
{ "runtime": "authorkit", "blockWrapperClass": "none",
  "buttonClasses": ".btn / .btn-primary / .btn-group",
  "fragmentScriptPolicy": "inert-innerHTML", "emptySectionCollapse": true }
```

Consequences: block CSS scoped `.name` (NEVER `.name.block`); buttons
`a.btn` / `.btn-primary` inside `p.btn-group`; header/footer are static
fragments (deploy skill Step 6); add `main .section:empty{display:none}`.

## Output layout (write everything under `<outputs>/_eds/`)

```
_eds/manifest.json                 ← schema below
_eds/content/<slug>.html           ← DA body fragments (home = index.html)
_eds/content/fragments/*.html      ← Step-6 nav/footer fragments
_eds/code/**                       ← overlaid onto the project branch root:
   blocks/<name>/<name>.{css,js}      blocks (AuthorKit-scoped CSS)
   styles/styles.css                  tokens + base (complete)
   fonts/ icons/ img/<project>/       assets (image binaries copied here)
   scripts/postlcp.js (etc.)          ONLY runtime files the skill has you
                                      adjust (e.g. fragment paths under
                                      /<project>/fragments/)
```

All content lives under the `/<project>/` prefix (`daPath` below). Editorial
images use the absolute code-bus URL
`https://<branch>--<site>--<org>.aem.page/img/<project>/<file>` — never
root-relative `/img/…` (ingests as `about:error`).

## manifest.json (the publisher's contract)

```json
{
  "project": "<slug>", "org": "<org>", "site": "<site>", "branch": "<slug>",
  "previewHost": "https://<branch>--<site>--<org>.aem.page",
  "pages": [
    { "slug": "home", "title": "…", "source": "home-C-cinematic.html",
      "content": "content/index.html", "daPath": "<project>/index" }
  ],
  "fragments": [
    { "content": "content/fragments/nav.html", "daPath": "<project>/fragments/nav" }
  ],
  "blocks": ["hero", "…"],
  "images": ["img/<project>/hero.jpg"]
}
```

`daPath` is the DA source path WITHOUT extension. Home is ALWAYS
`<project>/index`. On an incremental deploy, MERGE with the existing manifest
(reuse block names; read their CSS under `_eds/code/blocks/` first).

## Division of labor

| Sandbox (you) | Host publisher (deterministic) |
|---|---|
| Conversion per the deploy skill; write `_eds/**`; `upload_artifact` every file | AuthorKit bootstrap (pinned ref) on a fresh project branch; git commit/push; forced Code Sync + marker poll; sanitise + DA PUTs; image-live wait; preview + atomic asserts (one `<h1>`, 0 `about:error`, no `/img/` srcs); optional live |
| Fidelity verify job (separate): stardust:diff probes + computed-layout gate against the preview | — |
