/* Overview — the project board (the four-phase journey). Replaces the old
   "Building your redesign" spinner: the uplift column ticks live; brand /
   directions / workspace are reachable via the subheader tabs as they're ready.
   The shared persistent chat sits on the left. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState } from "../state";
import { topbar, rail, syncRail } from "../components/shell";
import { board } from "../components/board";
import { logout } from "../auth";

const subRight = (s: RunState): string =>
  s.error ? `<span class="donetag err">stopped</span>`
  : s.snapshotReady ? `<span class="donetag">✓ ready</span>`
  : `<span class="spin"></span>`;

export function working(state: RunState, app: App): Screen {
  const actions = state.error ? [] : [{ label: "Stop", kind: "quiet" as const, to: "cancel", id: "stopBtn" }];
  const el = h(`<div class="app">
    ${topbar(state, actions)}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="overview">
        <div class="subheader">
          <div class="sub-left"><span class="eyebrow ovw">overview</span></div>
          <div class="sub-right" id="subRight">${subRight(state)}</div>
        </div>
        <div class="boardwrap" id="boardwrap">${board(state)}</div>
      </section>
    </div>
    ${rail(state.rail)}
  </div>`);

  wireActions(el, app);

  const update = (s: RunState) => {
    syncRail(el, s.rail);
    const bw = el.querySelector<HTMLElement>("#boardwrap");
    if (bw) bw.innerHTML = (s.error ? `<div class="berror"><div class="errmark">!</div><div class="errmsg">${esc(s.error)}</div><button class="btn btn-primary" data-act="restart">Start over</button></div>` : "") + board(s);
    const sr = el.querySelector<HTMLElement>("#subRight");
    if (sr) sr.innerHTML = subRight(s);
    const stop = el.querySelector<HTMLButtonElement>("#stopBtn");
    if (stop && s.error) stop.disabled = true;
  };

  return { el, update };
}

/* Shared wiring helper reused across shell screens. Event-delegated on the root
   so dynamically re-rendered controls (view tabs, board) keep working without
   re-binding. Idempotent per element. */
export function wireActions(el: HTMLElement, app: App): void {
  if ((el as HTMLElement & { _wired?: boolean })._wired) return;
  (el as HTMLElement & { _wired?: boolean })._wired = true;
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!b || !el.contains(b)) return;
    const act = b.getAttribute("data-act")!;
    switch (act) {
      case "root": app.restart(); break;
      case "dashboard": app.goView("working"); break;
      case "phase-uplift": app.goUplift(); break;
      case "view-working": app.goView("working"); break;
      case "view-brand": app.goView("brand"); break;
      case "view-variants": app.goView("variants"); break;
      case "view-workspace": app.goView("workspace"); break;
      case "restart": app.restart(); break;
      case "logout": void logout(); break;
      case "cancel": app.cancel(); break;
      case "snapshot": app.goSnapshot(); break;
      case "variants": app.goVariants(); break;
      case "back-working": app.goView("working"); break;
      case "back-brand": app.goView("brand"); break;
      case "open-C": app.openVariant("C"); break;
      case "deploy": /* future rung */ break;
    }
  });
}
