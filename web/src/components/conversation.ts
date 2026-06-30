/* Conversation column — a SINGLE persistent panel reused across all in-app
   screens (working/brand/variants/workspace). main.ts re-parents this one node
   into each screen, so the chat content + scroll position stay identical as you
   navigate. Renders agent/user messages, muted tool rows, artifact cards, a
   pinned task block during the working phase, thinking dots, and the composer. */
import { h, esc } from "../dom";
import type { App } from "../controller";
import type { ArtifactRef, Message, PlanBlock, RunState, TaskItem, VariantId } from "../state";
import { store } from "../state";
import { sendArrow } from "./icons";
import { taskIcons } from "./icons";
import { KNACK_SEED_NOTE } from "../data/knack";

export function seedChip(hash: string, note: string): string {
  return `<div class="seed"><span class="k">seed</span> <span class="h">${esc(hash)}</span> · ${esc(note)}</div>`;
}

export function planBlock(p: PlanBlock): string {
  const steps = p.steps
    .map((s) => `<li><span class="b">${esc(s.n)}</span><span>${esc(s.text)}</span></li>`)
    .join("");
  const status = p.status ? `<div class="status"><span>✓</span> ${esc(p.status)}</div>` : "";
  const acts = p.acts?.length
    ? `<div class="acts">${p.acts.map((a) => `<button class="mini">${esc(a)}</button>`).join("")}</div>`
    : "";
  return `<div class="plan"><div class="tag">${esc(p.tag)}</div><ul class="steps">${steps}</ul>${status}${acts}</div>`;
}

function artifactCard(a: ArtifactRef): string {
  return `<button class="artifact-card" data-artifact="${esc(a.kind)}"${a.variant ? ` data-variant="${esc(a.variant)}"` : ""}>
    <span class="ac-ic">▦</span>
    <span class="ac-tx"><b>${esc(a.label)}</b><span class="ac-sub">open →</span></span>
  </button>`;
}

/** A single message. `seedNote` supplies the md5(...) suffix for seed chips. */
export function message(m: Message, seedNote: string): string {
  if (m.role === "user") {
    return `<div class="msg user"><div class="bubble">${esc(m.text ?? "")}</div></div>`;
  }
  if (m.tool) {
    return `<div class="msg tool"><span class="tdot">›</span> <span class="tname">${esc(m.tool)}</span></div>`;
  }
  if (m.artifact) {
    return `<div class="msg art">${artifactCard(m.artifact)}</div>`;
  }
  const parts: string[] = [];
  if (m.lead) parts.push(`<div class="lead"><span class="star">✦</span> ${m.lead}</div>`);
  for (const p of m.body ?? []) parts.push(`<p>${p}</p>`);
  if (m.plan) parts.push(planBlock(m.plan));
  if (m.seed) parts.push(seedChip(m.seed, seedNote));
  return `<div class="msg fade">${parts.join("")}</div>`;
}

export function thread(messages: Message[], seedNote: string): string {
  return `<div class="conv-thread">${messages.map((m) => message(m, seedNote)).join("")}</div>`;
}

export function composer(placeholder: string, hint: string): string {
  return `<div class="composer">
    <div class="field"><input type="text" placeholder="${esc(placeholder)}" aria-label="message" /><button class="send" aria-label="send">${sendArrow}</button></div>
    <div class="hint">${hint}</div>
  </div>`;
}

export function convHead(projectName: string, right = ""): string {
  return `<div class="conv-head"><div class="who"><span class="proj"><b>${esc(projectName)}</b> · redesign</span></div>${right}</div>`;
}

function taskRow(t: TaskItem): string {
  const st =
    t.status === "done" ? `<span class="ok">✓</span>` : t.status === "run" ? `<span class="spin"></span>` : `<span class="qd">○</span>`;
  return `<div class="task t-${t.kind} ${t.status}" data-task="${t.id}">
    <span class="ti">${taskIcons[t.kind]}</span>
    <div class="tx"><div class="tl"><span class="cat">${esc(t.cat)}</span> ${esc(t.title)}</div><div class="td">${esc(t.detail)}</div></div>
    <span class="st">${st}</span>
  </div>`;
}

export interface Conversation {
  el: HTMLElement;
  update: (s: RunState) => void;
  scroller: HTMLElement;
}

/** Build the one persistent conversation panel. */
export function createConversation(app: App): Conversation {
  const el = h(`<section class="conv" aria-label="conversation">
    <div class="conv-head"><div class="who"><span class="proj"><b id="convProj"></b> · redesign</span></div></div>
    <div class="conv-scroll">
      <div class="conv-tasks stagger" hidden></div>
      <div class="conv-thread"></div>
      <div class="thinking" hidden aria-label="thinking"><span></span><span></span><span></span></div>
    </div>
    <div class="composer">
      <div class="field"><input type="text" placeholder="tell stardust…" aria-label="message" /><button class="send" aria-label="send">${sendArrow}</button></div>
      <div class="hint">Working — in reality a few minutes.</div>
    </div>
  </section>`);

  const scroller = el.querySelector<HTMLElement>(".conv-scroll")!;
  const threadEl = el.querySelector<HTMLElement>(".conv-thread")!;
  const tasksEl = el.querySelector<HTMLElement>(".conv-tasks")!;
  const thinkingEl = el.querySelector<HTMLElement>(".thinking")!;
  const projEl = el.querySelector<HTMLElement>("#convProj")!;
  const input = el.querySelector<HTMLInputElement>(".composer input")!;
  const sendBtn = el.querySelector<HTMLButtonElement>(".composer .send")!;

  // Stick-to-bottom: auto-scroll only while the user is at (near) the bottom.
  let stuck = true;
  scroller.addEventListener("scroll", () => {
    stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  });
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

  // Composer — sends against whatever screen is current.
  const fire = () => {
    const t = input.value.trim();
    if (!t) return;
    input.value = "";
    app.send(store.get().screen, t);
  };
  sendBtn.addEventListener("click", fire);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") fire(); });

  // Artifact cards open on the right.
  threadEl.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".artifact-card");
    if (!card) return;
    const kind = card.getAttribute("data-artifact") as ArtifactRef["kind"];
    const variant = (card.getAttribute("data-variant") as VariantId | null) ?? undefined;
    app.openArtifact({ kind, variant, label: "" });
  });

  let renderedIds: string[] = [];

  const update = (s: RunState) => {
    projEl.textContent = s.projectName || "—";

    // Pinned tasks during the working phase only.
    const showTasks = s.tasks.length > 0 && !s.snapshotReady;
    tasksEl.hidden = !showTasks;
    if (showTasks) {
      const rows = tasksEl.querySelectorAll(".task");
      if (rows.length !== s.tasks.length) {
        tasksEl.innerHTML = s.tasks.map(taskRow).join("");
      } else {
        for (const t of s.tasks) {
          const row = tasksEl.querySelector<HTMLElement>(`.task[data-task="${t.id}"]`);
          if (!row) continue;
          row.className = `task t-${t.kind} ${t.status}`;
          const st = row.querySelector(".st")!;
          st.innerHTML = t.status === "done" ? `<span class="ok">✓</span>` : t.status === "run" ? `<span class="spin"></span>` : `<span class="qd">○</span>`;
        }
      }
    }

    // Messages: append-only reconcile (preserves scroll). Rebuild only if the
    // prefix changed (a reset).
    const ids = s.messages.map((m) => m.id);
    const samePrefix = ids.length >= renderedIds.length && renderedIds.every((id, i) => ids[i] === id);
    if (!samePrefix) {
      threadEl.innerHTML = "";
      renderedIds = [];
    }
    for (let i = renderedIds.length; i < s.messages.length; i++) {
      threadEl.insertAdjacentHTML("beforeend", message(s.messages[i], KNACK_SEED_NOTE));
    }
    renderedIds = ids;

    // Thinking dots while the agent is working.
    thinkingEl.hidden = !s.agentBusy;

    input.placeholder = s.screen === "workspace" ? "tell me a change…" : "tell stardust…";

    if (stuck) requestAnimationFrame(toBottom);
  };

  return { el, update, scroller };
}
