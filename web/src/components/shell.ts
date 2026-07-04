/* Shared shell pieces: topbar (macro nav: brand → root, project → board, the
   4-rung journey ladder, context actions) + the right-panel view tabs (micro nav)
   + the ambient footer rail. See NAVIGATION.md. */
import { esc } from "../dom";
import type { RunState, ScreenId } from "../state";
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
  // Which phase the current view belongs to (highlighted rung).
  const curPhase = state.screen === "prototype" ? "prototype"
    : state.screen === "deploy" ? (state.deploy?.rollout ? "rollout" : "deploy")
    : state.screen === "audit" ? "audit"
    : "uplift";
  // Rungs enable as their phase becomes reachable: uplift always (in a run);
  // prototype/deploy once there are variants; rollout once something previewed;
  // audit always (score the original any time; the deployed site once shipped).
  const enabled = (id: string) =>
    id === "uplift" || id === "audit" ||
    ((id === "prototype" || id === "deploy") && state.variants.length > 0) ||
    (id === "rollout" && !!state.deploy?.pages.some((p) => p.status === "previewed" || p.status === "live"));
  const rung = (p: { id: string; label: string }) => {
    const on = p.id === curPhase && enabled(p.id);
    const can = enabled(p.id);
    const cls = on ? "rung active" : can ? "rung" : "rung future";
    // Enabled rungs enter their phase's views; future rungs are inert.
    return `<button class="${cls}"${can ? ` data-act="phase-${p.id}"` : " disabled"}><span class="pip"></span><span class="lbl">${esc(p.label)}</span></button>`;
  };
  const btn = (a: TopbarAction) =>
    `<button class="btn ${a.kind === "primary" ? "btn-primary" : "btn-quiet"}"${a.id ? ` id="${a.id}"` : ""}${a.to ? ` data-act="${a.to}"` : ""}${a.disabled ? " disabled" : ""}>${esc(a.label)}${a.arrow ? ' <span class="arr">→</span>' : ""}</button>`;
  return `<header class="topbar">
    <div class="brand">
      <button class="brandlink" data-act="root" aria-label="stardust — your runs">${starHeader}<span class="name"><b>stardust</b></span></button>
      ${inRun ? `<span class="dot">·</span><button class="site brandlink" data-act="dashboard">${esc(state.projectName)} <span class="redesign">redesign</span></button><button class="switcher-btn" data-act="switcher" aria-label="switch project" title="Switch project">▾</button>` : ""}
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

/** Subheader left for a phase: the top-level phase label + its view tabs
 *  (matches the "overview" label on the dashboard). */
export function viewNav(label: string, state: RunState): string {
  return `<span class="eyebrow ovw">${esc(label)}</span><span class="segdiv"></span>${viewTabs(state)}`;
}

const cleanHost = (u: string) => u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

/** Remaining-time text from the ETA estimate, or "" once elapsed/unknown. */
function etaText(eta?: { seconds: number; at: number }): string {
  if (!eta) return "";
  const rem = eta.seconds - (Date.now() - eta.at) / 1000;
  if (rem <= 0) return "";
  return rem < 60 ? "~<1m left" : `~${Math.ceil(rem / 60)}m left`;
}

/** Ambient status rail — driven by real run state, not curated labels. */
export function rail(s: RunState): string {
  const r = s.rail;
  const items: string[] = [];

  // Palette — the captured brand colors.
  if (r.swatches.length) {
    items.push(`<div class="item"><span class="ic">◐</span> palette <span class="swatches">${r.swatches.map((c) => `<i style="background:${esc(c)}"></i>`).join("")}</span></div>`);
  }

  // Live activity — the real status ticker + ETA while working; an honest
  // done/failed state otherwise.
  if (s.error) {
    items.push(`<div class="item err"><span class="ic">!</span> stopped</div>`);
  } else if (s.agentBusy) {
    const eta = etaText(s.eta);
    items.push(`<div class="item"><span class="spin" style="width:11px;height:11px"></span> ${esc(s.statusTicker || "working")}${eta ? ` <span class="dim">· ${eta}</span>` : ""}</div>`);
  } else if (s.variants.length) {
    items.push(`<div class="item"><span class="ic ok">✓</span> ${s.variants.length} variants ready</div>`);
  }

  // Context — the active variant in the workspace, else the tension count.
  if (s.screen === "workspace" && s.variants.length) {
    const cur = s.variants.find((v) => v.id === s.activeVariant) ?? s.variants[0];
    items.push(`<div class="item"><span class="ic">▦</span> variant <b id="variantLabel">${esc(cur.segLabel)}</b></div>`);
  } else if (s.tensions.length) {
    items.push(`<div class="item"><span class="ic">▦</span> <b>${s.tensions.length}</b> tensions</div>`);
  }

  items.push(`<div class="spacer"></div>`);

  // Right — the site we're redesigning (persistent, always relevant).
  if (s.url) items.push(`<div class="item dim">${esc(cleanHost(s.url))}</div>`);

  return `<footer class="rail">${items.join("")}</footer>`;
}

/** Re-render the footer rail in place when run state changes. */
export function syncRail(el: HTMLElement, s: RunState): void {
  const footer = el.querySelector(".rail");
  if (footer) footer.outerHTML = rail(s);
}
