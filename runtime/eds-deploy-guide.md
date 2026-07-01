# stardust → AEM Edge Delivery conversion guide

You are converting self-contained stardust prototype pages (single HTML files
with inline `<style>`, `:root` tokens, semantic `<section class="…">` markup)
into an **Edge Delivery Services (EDS)** site: authorable **blocks** (code) +
**content pages** (DA body fragments). The target repo is a **vanilla
`aem-boilerplate`** (scripts/aem.js + scripts/scripts.js runtime — do NOT port
AuthorKit or any other runtime).

The transport (git push, DA upload, preview) is done by a deterministic
publisher afterwards — your job is ONLY to write the conversion output under
`_eds/` in the outputs dir, exactly in the layout below.

## Core rule

**One prototype `<section>` pattern = one EDS block.** The section's CSS
becomes that block's CSS, scoped under the block class. Sections that repeat
the same pattern (across pages too) collapse into ONE block with variant
classes (`hero`, `hero dark`), never N near-duplicate blocks. Keep block names
short, generic, kebab-case (`hero`, `feature-grid`, `stats`, `quote-band`,
`cta-banner`, `logo-row`, `article-list`…).

## Output layout (write everything under `<outputs>/_eds/`)

```
_eds/manifest.json                     ← see schema below
_eds/content/<slug>.html               ← one DA body fragment per page (home = index.html)
_eds/code/blocks/<name>/<name>.css     ← per-block CSS (scoped under .<name>)
_eds/code/blocks/<name>/<name>.js      ← per-block decorate (default export; may be a no-op)
_eds/code/styles/styles.css            ← tokens + base: a COMPLETE stylesheet (replaces the boilerplate one)
_eds/code/styles/fonts.css             ← @font-face rules (boilerplate loads this lazily)
_eds/code/fonts/…                      ← font binaries the pages use (woff2)
_eds/code/img/<project>/…              ← every editorial image, copied from the prototype assets
```

## Content pages (DA body fragments)

Each `_eds/content/<slug>.html` is a full body fragment:

```html
<body>
  <header></header>
  <main>
    <div>                                    <!-- one top-level div per section -->
      <h1>Headline as default content</h1>
      <p>Intro copy…</p>
      <div class="hero dark">                <!-- a block: rows > cells -->
        <div>
          <div><picture><img src="…" alt="…"></picture></div>
          <div><h2>…</h2><p>…</p><p><a href="…">Call to action</a></p></div>
        </div>
      </div>
      <div class="section-metadata">
        <div><div>style</div><div>dark</div></div>
      </div>
    </div>
    <div>…next section…</div>
  </main>
  <footer></footer>
</body>
```

- Block markup is the **div-class form**: `<div class="name variant">` → rows
  (`<div>`) → cells (`<div>`). The boilerplate decorates it automatically.
- Headings/copy that lead a section are **default content** (h1/h2/p directly
  in the section div), not block cells, unless the block needs them as cells.
- Finish each page with a `metadata` block-style section? No — page metadata
  goes in a `<div class="metadata">` table ONLY if needed; title/description
  are fine as the first h1 + first p.

### The ENCODE contract (what survives DA — critical)

DA strips `<span>`s, author classes on inline elements, inline `style=`
attributes, and `<style>`/`<script>` inside content. So:
- Decoration must ride **semantic inline tags only**: `<strong>`, `<em>`,
  `<code>`, `<a>`, `<sup>`, `<picture>`/`<img>`. Style those from block CSS.
- NEVER emit `<span class="accent">` or `style="…"` in content — express it as
  a block variant class + CSS selector instead.
- **Images**: every editorial image must be an `<img>` whose `src` is the
  ABSOLUTE code-bus URL `https://<branch>--<site>--<org>.aem.page/img/<project>/<file>`
  (the publisher pushes `_eds/code/img/**` to the branch before preview).
  Never repo-relative `/img/...` (→ `about:error`), never data: URIs, never
  external hotlinks to the original site. Copy each used image file from the
  prototype's assets into `_eds/code/img/<project>/` (re-encode names to
  kebab-case ASCII). CSS background images are allowed in block CSS using the
  same absolute URLs, but anything meaningful to authors must be an `<img>`.
- Non-ASCII text: the publisher runs a sanitiser; still prefer plain
  apostrophes/quotes where possible.

## Code

- `styles/styles.css`: complete and self-sufficient — the prototype's `:root`
  tokens (colors, type scale, spacing), base element styles (body, headings,
  buttons, links), header/footer styling, and section-level layout
  (`main > .section` paddings, `.section.dark` etc. — boilerplate wraps each
  top-level div as `.section`). Include the boilerplate's structural
  essentials: `body { display: none; } body.appear { display: block; }` and
  `header`/`footer` min-heights, or the page will flash unstyled.
- `styles/fonts.css`: `@font-face` with `font-display: swap`, files under
  `fonts/` (repo-relative URLs are fine in CSS: `url('../fonts/x.woff2')`).
- Block JS: `export default function decorate(block) { … }` — only when the
  block needs DOM re-shaping or behavior (carousels, counters, menus).
  Keep it dependency-free ES modules. A purely stylistic block still needs the
  file (an empty decorate is fine).
- Block CSS: every selector scoped under the block class (`.hero …`), mobile
  first with `@media (width >= 900px)` steps, honor `prefers-reduced-motion`.
- Nav/footer: the boilerplate renders `blocks/header` + `blocks/footer` from
  `/nav` and `/footer` content. Do NOT convert the prototype's nav/footer into
  page sections; instead write `_eds/content/nav.html` + `_eds/content/footer.html`
  (plain fragments: brand link + link list) so every page of the project shares
  them. Keep them minimal and brand-styled via styles.css.

## manifest.json (the publisher's contract)

```json
{
  "project": "<project-slug>",
  "org": "<org>", "site": "<site>", "branch": "<branch>",
  "previewHost": "https://<branch>--<site>--<org>.aem.page",
  "pages": [
    { "slug": "home", "title": "…", "source": "home-C-cinematic.html",
      "content": "content/index.html", "daPath": "<project>/index" },
    { "slug": "products", "title": "…", "source": "products-proposed.html",
      "content": "content/products.html", "daPath": "<project>/products" }
  ],
  "fragments": [
    { "content": "content/nav.html", "daPath": "<project>/nav" },
    { "content": "content/footer.html", "daPath": "<project>/footer" }
  ],
  "blocks": ["hero", "feature-grid"],
  "images": ["img/<project>/hero.jpg"]
}
```

- `daPath` is the DA source path WITHOUT extension (the publisher adds `.html`
  for the DA write and drops it for preview).
- The home page's daPath is ALWAYS `<project>/index`.
- When a manifest already exists (incremental deploy of more pages), MERGE:
  keep existing pages/blocks, reuse existing block names for matching section
  patterns (read their CSS under `_eds/code/blocks/` first), and only add new
  blocks when no existing one fits.

## Quality bar

The preview page must look like the prototype — same tokens, type, spacing,
imagery, hierarchy. After writing everything, self-review each content page
against its prototype section-by-section: every section present, every image
mapped, every CTA a real `<a>`. State plainly (reply_to_user) what blocks you
created and any compromises made.
