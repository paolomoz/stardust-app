/* Shared shell pieces: topbar (macro nav: brand → root, project → board, the
   4-rung journey ladder, context actions) + the right-panel view tabs (micro nav)
   + the ambient footer rail. See NAVIGATION.md. */
import { esc } from "../dom";
import type { RunState, RailState, ScreenId } from "../state";
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

// The macro journey ladder. Only "uplift" is built today; the rest are future.
const PHASES: { id: string; label: string }[] = [
  { id: "uplift", label: "uplift" },
  { id: "prototype", label: "prototype" },
  { id: "deploy", label: "deploy" },
  { id: "rollout", label: "rollout" },
  { id: "audit", label: "audit" },
];

export function topbar(state: RunState, actions: TopbarAction[]): string {
  const inRun = !!state.projectName;
  const rung = (p: { id: string; label: string }) => {
    const active = p.id === "uplift"; // current phase (v1 builds only uplift)
    const cls = active ? "rung active" : "rung future";
    // The active rung enters its phase's views; future rungs are inert.
    return `<button class="${cls}"${active ? ` data-act="phase-uplift"` : " disabled"}><span class="pip"></span><span class="lbl">${esc(p.label)}</span></button>`;
  };
  const btn = (a: TopbarAction) =>
    `<button class="btn ${a.kind === "primary" ? "btn-primary" : "btn-quiet"}"${a.id ? ` id="${a.id}"` : ""}${a.to ? ` data-act="${a.to}"` : ""}${a.disabled ? " disabled" : ""}>${esc(a.label)}${a.arrow ? ' <span class="arr">→</span>' : ""}</button>`;
  return `<header class="topbar">
    <div class="brand">
      <button class="brandlink" data-act="root" aria-label="stardust — your runs">${starHeader}<span class="name"><b>stardust</b></span></button>
      ${inRun ? `<span class="dot">·</span><button class="site brandlink" data-act="dashboard">${esc(state.projectName)} <span class="redesign">redesign</span></button>` : ""}
    </div>
    ${inRun ? `<nav class="ladder" aria-label="phases">${PHASES.map(rung).join("")}</nav>` : ""}
    <div class="spacer"></div>
    ${actions.map(btn).join("")}
    ${userChip()}
  </header>`;
}

/** The within-phase view switcher (right-panel subheader, sub-left). Overview is
 *  NOT here — it's the project dashboard, reached from the header (project link /
 *  the uplift rung). These are the uplift phase's output views; tabs enable as
 *  their data lands; the active tab tracks state.screen. */
export function viewTabs(state: RunState): string {
  const ready: Record<string, boolean> = {
    brand: !!state.brandReviewUrl,
    variants: state.variants.length > 0,
    workspace: state.variants.length > 0,
  };
  const tab = (id: ScreenId, label: string) =>
    `<button class="${state.screen === id ? "on" : ""}" data-act="view-${id}"${ready[id] ? "" : " disabled"}>${esc(label)}</button>`;
  return `<div class="seg tabs" role="group" aria-label="views">${tab("brand", "Brand")}${tab("variants", "Directions")}${tab("workspace", "Workspace")}</div>`;
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
