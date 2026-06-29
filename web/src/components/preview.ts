/* Preview card pieces: the variant segmented switch, viewport toggle, and the
   iframe preview region. Workspace composes these; brand uses a plainer panel. */
import { esc } from "../dom";
import type { VariantCard, VariantId } from "../state";
import { deskIcon, mobIcon, openTab } from "./icons";

export function segSwitch(variants: VariantCard[], active: VariantId): string {
  const btns = variants
    .map(
      (v) =>
        `<button class="${v.id === active ? "on" : ""}" data-variant="${v.id}" data-src="${esc(v.src)}" data-label="${esc(v.segLabel)}"><span class="k">${v.id}</span>${esc(v.segWord)}</button>`,
    )
    .join("");
  return `<div class="seg" data-variant-switch role="group" aria-label="variant">${btns}</div>`;
}

export function viewportToggle(viewport: "desktop" | "mobile"): string {
  return `<div class="vtoggle" role="group" aria-label="viewport">
    <button class="${viewport === "desktop" ? "on" : ""}" id="vDesk" aria-label="desktop" title="Desktop">${deskIcon}</button>
    <button class="${viewport === "mobile" ? "on" : ""}" id="vMob" aria-label="mobile" title="Mobile">${mobIcon}</button>
  </div>`;
}

export function openInTab(href: string): string {
  return `<a class="open" href="${esc(href)}" target="_blank" rel="noopener">Open in tab ${openTab}</a>`;
}

export function previewIframe(src: string, title: string, viewport: "desktop" | "mobile"): string {
  return `<div class="preview${viewport === "mobile" ? " mobile" : ""}" id="preview"><iframe id="artframe" src="${esc(src)}" title="${esc(title)}" loading="eager"></iframe></div>`;
}
