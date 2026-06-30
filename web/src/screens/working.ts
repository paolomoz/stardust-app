/* Working — the studio "thinking and executing" screen. Task stream on the left,
   the loading stage on the right. Ticks in place as the driver advances. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState, TaskItem } from "../state";
import { topbar, rail, syncRail } from "../components/shell";
import { convHead, composer, message } from "../components/conversation";
import { bigStar, taskIcons } from "../components/icons";
import { KNACK_SEED_NOTE } from "../data/knack";

function taskRow(t: TaskItem): string {
  const st =
    t.status === "done"
      ? `<span class="ok">✓</span>`
      : t.status === "run"
        ? `<span class="spin"></span>`
        : `<span class="qd">○</span>`;
  return `<div class="task t-${t.kind} ${t.status}" data-task="${t.id}">
    <span class="ti">${taskIcons[t.kind]}</span>
    <div class="tx"><div class="tl"><span class="cat">${esc(t.cat)}</span> ${esc(t.title)}</div><div class="td">${esc(t.detail)}</div></div>
    <span class="st">${st}</span>
  </div>`;
}

export function working(state: RunState, app: App): Screen {
  const el = h(`<div class="app">
    ${topbar(state.phase, [
      { label: "Stop", kind: "quiet", to: "cancel", id: "stopBtn" },
      { label: "See snapshot", kind: "primary", to: "snapshot", arrow: true, id: "snapBtn", disabled: !state.snapshotReady },
    ])}
    <div class="middle">
      <section class="conv" aria-label="conversation">
        ${convHead(state.projectName, `<span style="font:500 11px/1 var(--mono);color:var(--fg-faint)">working</span>`)}
        <div class="conv-thread">
          <div class="msg fade">
            <div class="lead"><span class="star">✦</span> On it — reading <b>${esc(state.projectName)}</b>, learning the brand, and composing directions.</div>
            <p>This normally takes a few minutes. I'll show the snapshot the moment it's ready.</p>
          </div>
          <div class="tasks stagger">${state.tasks.map(taskRow).join("")}</div>
          <div class="agentlog">${state.messages.map((m) => message(m, KNACK_SEED_NOTE)).join("")}</div>
        </div>
        ${composer("add a note for stardust…", `Working — in reality a few minutes. <button class="skip mono" data-act="snapshot" style="color:var(--fg-dim)">see snapshot →</button>`)}
      </section>
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
  wireComposer(el, app, "working");
  // initial paint of the progress fill
  requestAnimationFrame(() => {
    const fill = el.querySelector<HTMLElement>("#pbarfill");
    if (fill) fill.style.width = `${state.progress}%`;
  });

  const update = (s: RunState) => {
    syncRail(el, s.rail);
    // if the task set arrived/changed after mount, (re)build the rows
    const container = el.querySelector<HTMLElement>(".tasks");
    if (container && container.querySelectorAll(".task").length !== s.tasks.length) {
      container.innerHTML = s.tasks.map(taskRow).join("");
    }
    // tick the task rows in place
    for (const t of s.tasks) {
      const row = el.querySelector<HTMLElement>(`.task[data-task="${t.id}"]`);
      if (!row) continue;
      row.className = `task t-${t.kind} ${t.status}`;
      const st = row.querySelector(".st")!;
      st.innerHTML =
        t.status === "done" ? `<span class="ok">✓</span>` : t.status === "run" ? `<span class="spin"></span>` : `<span class="qd">○</span>`;
    }
    const status = el.querySelector<HTMLElement>("#status");
    if (status) status.textContent = s.statusTicker;
    const fill = el.querySelector<HTMLElement>("#pbarfill");
    if (fill) fill.style.width = `${s.progress}%`;
    const snap = el.querySelector<HTMLButtonElement>("#snapBtn");
    if (snap) snap.disabled = !s.snapshotReady;
    // agent-mode narration
    const log = el.querySelector<HTMLElement>(".agentlog");
    if (log) log.innerHTML = s.messages.map((m) => message(m, KNACK_SEED_NOTE)).join("");
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

/* Shared wiring helpers reused across shell screens. */
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

export function wireComposer(el: HTMLElement, app: App, screen: RunState["screen"]): void {
  const field = el.querySelector<HTMLInputElement>(".composer input");
  const send = el.querySelector<HTMLButtonElement>(".composer .send");
  if (!field || !send) return;
  const fire = () => {
    const t = field.value.trim();
    if (!t) return;
    field.value = "";
    app.send(screen, t);
  };
  send.addEventListener("click", fire);
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fire();
  });
}
