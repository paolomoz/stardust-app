/* Header project switcher — a dropdown off the header's project name (▾) that
   lists the user's recent projects for an in-place switch, plus New / All.
   Self-wired off document clicks (like the toasts), so it survives the topbar
   being re-rendered per screen. See NAVIGATION.md. */
import { esc } from "../dom";
import type { App } from "../controller";
import { listRuns, type RunSummary } from "../driver/liveDriver";

const cleanUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function mountSwitcher(app: App): void {
  const dd = document.createElement("div");
  dd.className = "switcher-menu";
  dd.hidden = true;
  document.body.appendChild(dd);

  let open = false;
  const close = () => { open = false; dd.hidden = true; };

  const render = (runs: RunSummary[]) => {
    const cur = new URLSearchParams(location.search).get("run");
    const items = runs.slice(0, 8).map((p) =>
      `<button class="sw-item${p.id === cur ? " on" : ""}" data-sw="${esc(p.id)}">
        <span class="rs rs-${esc(p.status)}"></span>
        <span class="sw-tx"><span class="sw-name">${esc(p.project || cleanUrl(p.url))}</span><span class="sw-meta">${esc(p.status)} · ${relTime(p.created_at)}</span></span>
      </button>`).join("");
    dd.innerHTML =
      `<div class="sw-list">${items || `<div class="sw-empty">No projects yet</div>`}</div>
       <div class="sw-foot"><button class="sw-act" data-sw-new>＋ New project</button><button class="sw-act" data-sw-all>All projects</button></div>`;
  };

  const openAt = async (anchor: HTMLElement) => {
    const r = anchor.getBoundingClientRect();
    dd.style.left = `${Math.max(12, r.left - 8)}px`;
    dd.style.top = `${r.bottom + 8}px`;
    dd.hidden = false; open = true;
    dd.innerHTML = `<div class="sw-empty">Loading…</div>`;
    render(await listRuns());
  };

  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const trigger = t.closest<HTMLElement>('[data-act="switcher"]');
    if (trigger) { e.preventDefault(); e.stopPropagation(); if (open) close(); else void openAt(trigger); return; }
    const item = t.closest<HTMLElement>("[data-sw]");
    if (item) { close(); app.switchProject(item.getAttribute("data-sw")!); return; }
    if (t.closest("[data-sw-new]") || t.closest("[data-sw-all]")) { close(); app.restart(); return; }
    if (open && !t.closest(".switcher-menu")) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) close(); });
}
