/* Working — the studio "thinking and executing" screen. The shared persistent
   chat (with the pinned task list) sits on the left; the loading stage on the
   right. Ticks in place as the driver advances. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState } from "../state";
import { topbar, rail, syncRail } from "../components/shell";
import { bigStar } from "../components/icons";

export function working(state: RunState, app: App): Screen {
  const el = h(`<div class="app">
    ${topbar(state.phase, [
      { label: "Stop", kind: "quiet", to: "cancel", id: "stopBtn" },
      { label: "See snapshot", kind: "primary", to: "snapshot", arrow: true, id: "snapBtn", disabled: !state.snapshotReady },
    ])}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="working">
        <div class="subheader">
          <div class="sub-left"><span class="eyebrow">working</span><span style="font-size:13px;color:var(--fg-dim)">${esc(state.projectName)}</span></div>
          <div class="sub-right"><span class="spin"></span></div>
        </div>
        <div class="preview">
          <div class="work">
            <div class="stage"><div class="ring"></div><div class="ring2"></div>${bigStar}</div>
            <h2>Building your redesign</h2>
            <div class="status" id="status">${esc(state.statusTicker)}</div>
            <div class="pwrap"><div class="pbar"><i id="pbarfill"></i></div></div>
            <div class="note">reading the brand · proposing directions · validating renders</div>
            <div class="skel"><div class="sk big"></div><div class="sk s"></div><div class="sk s"></div></div>
          </div>
        </div>
      </section>
    </div>
    ${rail(state.rail)}
  </div>`);

  wireActions(el, app);
  // initial paint of the progress fill
  requestAnimationFrame(() => {
    const fill = el.querySelector<HTMLElement>("#pbarfill");
    if (fill) fill.style.width = `${state.progress}%`;
  });

  const update = (s: RunState) => {
    syncRail(el, s.rail);
    const status = el.querySelector<HTMLElement>("#status");
    if (status) status.textContent = s.statusTicker;
    const fill = el.querySelector<HTMLElement>("#pbarfill");
    if (fill) fill.style.width = `${s.progress}%`;
    const snap = el.querySelector<HTMLButtonElement>("#snapBtn");
    if (snap) snap.disabled = !s.snapshotReady;
    // honest failure: swap the loading stage for an error card, stop the spinners
    if (s.error) {
      const panel = el.querySelector<HTMLElement>(".panel .preview");
      if (panel && !panel.querySelector(".errcard")) {
        panel.innerHTML = `<div class="errcard">
          <div class="errmark">!</div>
          <h2>Run stopped</h2>
          <div class="errmsg">${esc(s.error)}</div>
          <button class="btn btn-primary" data-act="restart">Start over</button>
        </div>`;
        wireActions(panel, app);
      }
      el.querySelector(".panel .sub-right .spin")?.remove();
      const stop = el.querySelector<HTMLButtonElement>("#stopBtn");
      if (stop) stop.disabled = true;
    }
  };

  return { el, update };
}

/* Shared wiring helper reused across shell screens (topbar / panel buttons). */
export function wireActions(el: HTMLElement, app: App): void {
  el.querySelectorAll<HTMLElement>("[data-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const act = b.getAttribute("data-act")!;
      if (act === "restart") app.restart();
      else if (act === "cancel") app.cancel();
      else if (act === "snapshot") app.goSnapshot();
      else if (act === "variants") app.goVariants();
      else if (act === "back-working") app.goto("working");
      else if (act === "back-brand") app.goto("brand");
      else if (act === "open-C") app.openVariant("C");
      else if (act === "deploy") {/* v1: deploy rung deferred */}
    }),
  );
}
