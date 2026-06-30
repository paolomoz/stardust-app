/* Shared shell pieces: topbar (brand + ladder + actions) and footer rail. */
import { esc } from "../dom";
import type { Phase, RailState } from "../state";
import { starHeader } from "./icons";
import { userChip } from "../auth";

export interface TopbarAction {
  label: string;
  kind: "primary" | "quiet";
  to?: string;          // screen action id, wired by the screen
  arrow?: boolean;
  disabled?: boolean;
  id?: string;
}

export function topbar(phase: Phase, actions: TopbarAction[]): string {
  const rung = (lbl: string, p: Phase) =>
    `<div class="rung ${phase === p ? "active" : ""}"><span class="pip"></span><span class="lbl">${lbl}</span></div>`;
  const btn = (a: TopbarAction) =>
    `<button class="btn ${a.kind === "primary" ? "btn-primary" : "btn-quiet"}"${a.id ? ` id="${a.id}"` : ""}${a.to ? ` data-act="${a.to}"` : ""}${a.disabled ? " disabled" : ""}>${esc(a.label)}${a.arrow ? ' <span class="arr">→</span>' : ""}</button>`;
  return `<header class="topbar">
    <div class="brand">${starHeader}<span class="name"><b>stardust</b></span></div>
    <nav class="ladder" aria-label="progress">${rung("prototype", "prototype")}${rung("deploy", "deploy")}</nav>
    <div class="spacer"></div>
    ${actions.map(btn).join("")}
    ${userChip()}
  </header>`;
}

export function rail(r: RailState): string {
  const items: string[] = [];
  if (r.busy) {
    items.push(`<div class="item"><span class="ic">◐</span> <span class="spin" style="width:11px;height:11px"></span> reading brand surface…</div>`);
  } else if (r.swatches.length) {
    items.push(`<div class="item"><span class="ic">◐</span> palette <span class="swatches">${r.swatches.map((c) => `<i style="background:${esc(c)}"></i>`).join("")}</span></div>`);
  }
  if (r.signature) items.push(`<div class="item"><span class="amber">✦</span> signature <b>${esc(r.signature)}</b></div>`);
  else if (r.note) items.push(`<div class="item"><span class="amber">✦</span> ${esc(r.note)}</div>`);
  if (r.variant) items.push(`<div class="item"><span class="ic">▦</span> variant <b id="variantLabel">${esc(r.variant)}</b></div>`);
  else if (typeof r.tensions === "number") items.push(`<div class="item"><span class="ic">▦</span> tensions <b>${r.tensions}</b></div>`);
  items.push(`<div class="spacer"></div>`);
  if (r.clock) items.push(`<div class="item clock">${esc(r.clock)}</div>`);
  return `<footer class="rail">${items.join("")}</footer>`;
}

/** Re-render the footer rail in place when run state changes (palette, clock,
 *  variant). The rail is otherwise rendered once at mount. */
export function syncRail(el: HTMLElement, r: RailState): void {
  const footer = el.querySelector(".rail");
  if (footer) footer.outerHTML = rail(r);
}
