/* Prototype phase — render OTHER pages of the site in a chosen variant's
   direction. Left of the panel: the pinned direction, a page picker (from the
   home inventory) + the page prototypes as they land; right: a live preview of
   the selected page. The shared chat sits on the far left (.conv-mount) and, on
   this screen, routes a message to a template job. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState, TemplatePage, VariantCard } from "../state";
import { topbar, rail, syncRail } from "../components/shell";
import { viewportToggle, openInTab, previewIframe } from "../components/preview";
import { wireActions } from "./working";

/** Direction switcher — pick which variant's design the pages render in. */
function dirSwitch(variants: VariantCard[], active?: string): string {
  const btns = variants
    .map((v) => `<button class="${v.id === active ? "on" : ""}" data-proto-variant="${esc(v.id)}"><span class="k">${esc(v.id)}</span>${esc(v.segWord)}</button>`)
    .join("");
  return `<div class="seg" data-proto-switch role="group" aria-label="direction">${btns}</div>`;
}

const statusBadge = (t: TemplatePage): string =>
  t.status === "done" ? `<span class="ok">✓</span>`
  : t.status === "running" || t.status === "queued" ? `<span class="spin"></span>`
  : `<span class="tperr">!</span>`;

/** The page list: prototyped pages (clickable when done) + not-yet-rendered
 *  candidates as checkboxes. */
function pageList(s: RunState): string {
  const byslug = new Map(s.templates.map((t) => [t.slug, t]));
  const rows: string[] = [];
  // Prototyped / in-flight pages first.
  for (const t of s.templates) {
    const cls = t.status === "done" ? "prow done" : t.status === "failed" ? "prow failed" : "prow busy";
    const openable = t.status === "done";
    rows.push(`<div class="${cls}${s.protoActive === t.slug ? " on" : ""}"${openable ? ` data-open-page="${esc(t.slug)}"` : ""}>
      <span class="pst">${statusBadge(t)}</span>
      <span class="ptx"><b>${esc(t.title)}</b><span class="psub">${esc(t.status === "failed" ? (t.message || "failed") : t.status === "done" ? "open →" : "rendering…")}</span></span>
    </div>`);
  }
  // Remaining candidates as a checklist.
  const remaining = s.pageCandidates.filter((p) => !byslug.has(p.slug));
  for (const p of remaining) {
    rows.push(`<label class="prow pick">
      <input type="checkbox" class="pcheck" value="${esc(p.slug)}" />
      <span class="ptx"><b>${esc(p.title)}</b><span class="psub">${esc(p.url.replace(/^https?:\/\/[^/]+/, "") || p.url)}</span></span>
    </label>`);
  }
  if (!rows.length) return `<div class="pempty">No other pages found in the navigation. Ask in chat to prototype a specific page.</div>`;
  return rows.join("");
}

function activeTemplate(s: RunState): TemplatePage | undefined {
  const done = s.templates.filter((t) => t.status === "done");
  return done.find((t) => t.slug === s.protoActive) ?? done[done.length - 1];
}

export function prototype(state: RunState, app: App): Screen {
  const cur = activeTemplate(state);
  const el = h(`<div class="app">
    ${topbar(state, [])}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="prototype phase">
        <div class="subheader">
          <div class="sub-left"><span class="eyebrow ovw">prototype</span><span class="segdiv"></span>${dirSwitch(state.variants, state.protoVariant)}</div>
          <div class="sub-right">${viewportToggle(state.viewport)}${openInTab(cur?.src ?? "#")}</div>
        </div>
        <div class="protolayout">
          <aside class="protoside">
            <div class="protohint">Other pages, rendered in the direction of variant <b class="pv">${esc(state.protoVariant ?? "—")}</b>.</div>
            <div class="pagelist">${pageList(state)}</div>
            <button class="btn btn-primary protogo">Prototype selected</button>
          </aside>
          <div class="protoprev" id="protoprev">${cur?.src
            ? previewIframe(cur.src, `${state.projectName} — ${cur.title}`, state.viewport)
            : `<div class="protoblank"><div class="pb-star">✦</div><div class="pb-tx">Pick pages on the left and hit <b>Prototype selected</b> — or ask in chat. Each renders in variant <b>${esc(state.protoVariant ?? "—")}</b>.</div></div>`}</div>
        </div>
      </section>
    </div>
    ${rail(state)}
  </div>`);

  wireActions(el, app);

  // Direction switch → re-pin.
  el.querySelectorAll<HTMLButtonElement>(".seg[data-proto-switch] button").forEach((b) =>
    b.addEventListener("click", () => app.setProtoVariant(b.getAttribute("data-proto-variant")!)),
  );

  // Prototype the checked pages.
  const side = el.querySelector<HTMLElement>(".protoside")!;
  const go = () => {
    const slugs = Array.from(el.querySelectorAll<HTMLInputElement>(".pcheck:checked")).map((c) => c.value);
    if (slugs.length) app.prototypePages(slugs);
  };
  side.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".protogo")) { go(); return; }
    const open = t.closest<HTMLElement>("[data-open-page]");
    if (open) app.setProtoActive(open.getAttribute("data-open-page")!);
  });

  // viewport toggle
  el.querySelector("#vDesk")?.addEventListener("click", () => app.setViewport("desktop"));
  el.querySelector("#vMob")?.addEventListener("click", () => app.setViewport("mobile"));

  const frame = () => el.querySelector<HTMLIFrameElement>("#artframe");
  if (cur?.src) { const f = frame(); if (f) f.dataset.src = cur.src; }

  const update = (s: RunState) => {
    syncRail(el, s);
    // direction switch highlight + hint
    el.querySelectorAll<HTMLButtonElement>(".seg[data-proto-switch] button").forEach((b) =>
      b.classList.toggle("on", b.getAttribute("data-proto-variant") === s.protoVariant));
    el.querySelectorAll<HTMLElement>(".pv").forEach((n) => (n.textContent = s.protoVariant ?? "—"));
    // page list (preserve checkbox state where possible by re-render — checkboxes
    // reset, acceptable; the list changes as pages land)
    const list = el.querySelector<HTMLElement>(".pagelist");
    if (list) list.innerHTML = pageList(s);
    // preview: swap when the active page's src changes
    const t = activeTemplate(s);
    const prev = el.querySelector<HTMLElement>("#protoprev");
    const f = frame();
    if (t?.src) {
      if (!f) {
        if (prev) prev.innerHTML = previewIframe(t.src, `${s.projectName} — ${t.title}`, s.viewport);
      } else if (f.dataset.src !== t.src) {
        f.src = t.src; f.dataset.src = t.src;
        const open = el.querySelector<HTMLAnchorElement>(".sub-right .open"); if (open) open.href = t.src;
      }
      const p = el.querySelector("#preview"); if (p) p.classList.toggle("mobile", s.viewport === "mobile");
      el.querySelector("#vDesk")?.classList.toggle("on", s.viewport === "desktop");
      el.querySelector("#vMob")?.classList.toggle("on", s.viewport === "mobile");
    }
  };
  return { el, update };
}
