/* Directions — brand-faithful variant gallery (A/B/C + any extra directions the
   director generates from chat) + shared fixes + a "new direction" affordance. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState, VariantCard } from "../state";
import { topbar, viewNav, rail, syncRail } from "../components/shell";
import { wireActions } from "./working";

function card(v: VariantCard): string {
  const moves = v.moves?.length
    ? `<ul class="moves"><li class="ml">${esc(v.movesLabel ?? "moves")}</li>${v.moves
        .map((m) => `<li class="m"><span class="a">→</span> ${esc(m)}</li>`)
        .join("")}</ul>`
    : "";
  const middle = v.whatif
    ? `<div class="whatif"><span class="q">what if</span><span class="qt">${esc(v.whatif)}</span></div>`
    : v.faithful
      ? `<div class="faithful">${esc(v.faithful)}</div>`
      : "";
  const thumb = v.thumb
    ? `<img src="${esc(v.thumb)}" alt="Variant ${v.id} — ${esc(v.title)}" />`
    : `<div class="thumb-ph"><span>${esc(v.id)}</span></div>`;
  return `<div class="vcard${v.recommended ? " rec" : ""}" data-variant="${esc(v.id)}">
    ${v.recommended ? `<span class="recpill">★ recommended</span>` : ""}
    <div class="thumb">${thumb}</div>
    <div class="meta">
      <div class="top"><span class="k">${esc(v.id)}</span><span class="ttl">${esc(v.title)}</span></div>
      <p class="pitch">${esc(v.pitch)}</p>
      ${middle}
      ${moves}
      <div class="role">${esc(v.role)}</div>
    </div>
  </div>`;
}

/** The tile that opens a new direction — a lightweight inline "brief". */
function addTile(): string {
  return `<div class="vcard addcard" data-addvar>
    <div class="addbody">
      <div class="addplus">+</div>
      <div class="addttl">Another direction</div>
      <div class="addsub">Fork the selected variant and take it somewhere new.</div>
      <div class="addfield">
        <input class="addvar-in" type="text" placeholder="e.g. a calmer, editorial take…" aria-label="new direction" />
        <button class="addvar-btn">Generate</button>
      </div>
    </div>
  </div>`;
}

export function variants(state: RunState, app: App): Screen {
  const fixes = state.sharedFixes
    .map((f) => `<span class="fixchip"><span class="ck">✓</span> ${esc(f)}</span>`)
    .join("");
  const el = h(`<div class="app">
    ${topbar(state, [])}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="directions">
        <div class="subheader">
          <div class="sub-left">${viewNav("uplift", state)}</div>
          <div class="sub-right"><span style="font:500 12px/1 var(--mono);color:var(--fg-faint)">open a card · or add a direction</span></div>
        </div>
        <div class="cardbody">
          <div class="galwrap">
            <div class="shared fade">
              <div class="sh"><span class="e">shared across all</span><span class="t">the fixes from the audit — applied to <b>every</b> variant</span></div>
              <div class="fixchips">${fixes}</div>
            </div>
            <div class="gallery stagger">${state.variants.map(card).join("")}${addTile()}</div>
          </div>
        </div>
      </section>
    </div>
    ${rail(state)}
  </div>`);

  wireActions(el, app);
  el.querySelectorAll<HTMLElement>(".vcard[data-variant]").forEach((c) =>
    c.addEventListener("click", () => app.openVariant(c.getAttribute("data-variant") as VariantCard["id"])),
  );

  // "Another direction" tile — send the brief to the server (an extra variant).
  const addCard = el.querySelector<HTMLElement>(".addcard");
  const addInput = el.querySelector<HTMLInputElement>(".addvar-in");
  const fireAdd = () => {
    const v = addInput?.value.trim();
    if (!v) { addInput?.focus(); return; }
    app.addVariant(v);
    if (addInput) addInput.value = "";
  };
  el.querySelector<HTMLButtonElement>(".addvar-btn")?.addEventListener("click", (e) => { e.stopPropagation(); fireAdd(); });
  addInput?.addEventListener("click", (e) => e.stopPropagation());
  addInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.stopPropagation(); fireAdd(); } });
  // Clicking the tile body focuses the field.
  addCard?.addEventListener("click", () => addInput?.focus());

  const update = (s: RunState) => {
    syncRail(el, s);
    const tabs = el.querySelector<HTMLElement>(".sub-left");
    if (tabs) tabs.innerHTML = viewNav("uplift", s);
    // Re-render the gallery when the variant set changes (a new direction landed),
    // preserving the add-tile's input text.
    const gal = el.querySelector<HTMLElement>(".gallery");
    if (gal && gal.querySelectorAll(".vcard[data-variant]").length !== s.variants.length) {
      const keep = el.querySelector<HTMLInputElement>(".addvar-in")?.value ?? "";
      gal.innerHTML = s.variants.map(card).join("") + addTile();
      const ni = el.querySelector<HTMLInputElement>(".addvar-in");
      if (ni) ni.value = keep;
      el.querySelectorAll<HTMLElement>(".vcard[data-variant]").forEach((c) =>
        c.addEventListener("click", () => app.openVariant(c.getAttribute("data-variant") as VariantCard["id"])),
      );
      const nAddCard = el.querySelector<HTMLElement>(".addcard");
      const nAddInput = el.querySelector<HTMLInputElement>(".addvar-in");
      const nFire = () => { const v = nAddInput?.value.trim(); if (!v) { nAddInput?.focus(); return; } app.addVariant(v); if (nAddInput) nAddInput.value = ""; };
      el.querySelector<HTMLButtonElement>(".addvar-btn")?.addEventListener("click", (e) => { e.stopPropagation(); nFire(); });
      nAddInput?.addEventListener("click", (e) => e.stopPropagation());
      nAddInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.stopPropagation(); nFire(); } });
      nAddCard?.addEventListener("click", () => nAddInput?.focus());
    }
  };
  return { el, update };
}
