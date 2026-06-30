/* Directions — 3-up brand-faithful variant gallery + shared fixes. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState, VariantCard } from "../state";
import { topbar, viewNav, rail, syncRail } from "../components/shell";
import { wireActions } from "./working";

function card(v: VariantCard): string {
  const moves = v.moves?.length
    ? `<ul class="moves"><li class="ml">${esc(v.movesLabel ?? "moves")}</li>${v.moves
        .map((m) => `<li class="m"><span class="a">→</span> ${m}</li>`)
        .join("")}</ul>`
    : "";
  const middle = v.whatif
    ? `<div class="whatif"><span class="q">what if</span><span class="qt">${v.whatif}</span></div>`
    : v.faithful
      ? `<div class="faithful">${esc(v.faithful)}</div>`
      : "";
  return `<div class="vcard${v.recommended ? " rec" : ""}" data-variant="${v.id}">
    ${v.recommended ? `<span class="recpill">★ recommended</span>` : ""}
    <div class="thumb"><img src="${esc(v.thumb)}" alt="Variant ${v.id} — ${esc(v.title)}" /></div>
    <div class="meta">
      <div class="top"><span class="k">${v.id}</span><span class="ttl">${esc(v.title)}</span></div>
      <p class="pitch">${v.pitch}</p>
      ${middle}
      ${moves}
      <div class="role">${esc(v.role)}</div>
    </div>
  </div>`;
}

export function variants(state: RunState, app: App): Screen {
  const fixes = state.sharedFixes
    .map((f) => `<span class="fixchip"><span class="ck">✓</span> ${f}</span>`)
    .join("");
  const el = h(`<div class="app">
    ${topbar(state, [])}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="directions">
        <div class="subheader">
          <div class="sub-left">${viewNav("uplift", state)}</div>
          <div class="sub-right"><span style="font:500 12px/1 var(--mono);color:var(--fg-faint)">click a card to iterate</span></div>
        </div>
        <div class="cardbody">
          <div class="galwrap">
            <div class="shared fade">
              <div class="sh"><span class="e">all three fix</span><span class="t">the <b>5 tensions</b> from the audit — applied to every variant</span></div>
              <div class="fixchips">${fixes}</div>
            </div>
            <div class="gallery stagger">${state.variants.map(card).join("")}</div>
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

  const update = (s: RunState) => {
    syncRail(el, s);
    const tabs = el.querySelector<HTMLElement>(".sub-left");
    if (tabs) tabs.innerHTML = viewNav("uplift", s);
  };
  return { el, update };
}
