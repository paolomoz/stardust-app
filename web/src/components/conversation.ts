/* Conversation column — a SINGLE persistent panel reused across all in-app
   screens (working/brand/variants/workspace). main.ts re-parents this one node
   into each screen, so the chat content + scroll position stay identical as you
   navigate. Renders agent/user messages, muted tool rows, artifact cards, a
   pinned task block during the working phase, thinking dots, and the composer. */
import { h, esc } from "../dom";
import type { App } from "../controller";
import type { ArtifactRef, Message, PlanBlock, RunState, ScreenId, TaskItem, VariantId } from "../state";
import { store } from "../state";
import { sendArrow } from "./icons";
import { taskIcons } from "./icons";
import { KNACK_SEED_NOTE } from "../data/knack";

/* Next-step suggestions shown under the composer when the agent is idle. A chip
   either prefills the composer (prompt) or jumps to the next screen (nav). */
type Suggestion = { label: string; prompt?: string; nav?: "snapshot" | "variants" | "open-C" };
const SUGGESTIONS: Record<ScreenId, Suggestion[]> = {
  landing: [],
  working: [{ label: "See snapshot →", nav: "snapshot" }],
  brand: [{ label: "See directions →", nav: "variants" }],
  variants: [
    { label: "Open variant C →", nav: "open-C" },
    { label: "A calmer option", prompt: "a calmer option" },
    { label: "Go bolder than C", prompt: "go bolder than C" },
  ],
  workspace: [
    { label: "Make the hero bolder", prompt: "make the hero bolder" },
    { label: "Calmer palette", prompt: "use a calmer, more restrained palette" },
    { label: "More motion", prompt: "add more motion and life to the page" },
  ],
};

function suggestionsFor(s: RunState): Suggestion[] {
  if (s.screen === "working" && !s.snapshotReady) return []; // nothing to do until ready
  return SUGGESTIONS[s.screen] ?? [];
}

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

/** Safe rich text for agent messages: escape everything (narration is untrusted
 *  free text that can contain literal HTML like <h1>), then render only light
 *  markdown — **bold**, *italic*, `code`. */
export function fmtText(s: string): string {
  // Legacy curated messages used <b>/<i>; treat those known-safe tags as markdown
  // (everything else, incl. narration's literal <h1>, is escaped below).
  const pre = s.replace(/<\/?b>/g, "**").replace(/<\/?i>/g, "*");
  return esc(pre)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
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
  if (m.lead) parts.push(`<div class="lead"><span class="star">✦</span> ${fmtText(m.lead)}</div>`);
  for (const p of m.body ?? []) parts.push(`<p>${fmtText(p)}</p>`);
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
      <div class="convfoot">
        <div class="eta" hidden><div class="eta-bar"><i></i></div><div class="eta-label"></div></div>
        <div class="suggest" hidden></div>
      </div>
    </div>
  </section>`);

  const scroller = el.querySelector<HTMLElement>(".conv-scroll")!;
  const threadEl = el.querySelector<HTMLElement>(".conv-thread")!;
  const tasksEl = el.querySelector<HTMLElement>(".conv-tasks")!;
  const thinkingEl = el.querySelector<HTMLElement>(".thinking")!;
  const projEl = el.querySelector<HTMLElement>("#convProj")!;
  const input = el.querySelector<HTMLInputElement>(".composer input")!;
  const sendBtn = el.querySelector<HTMLButtonElement>(".composer .send")!;
  const etaWrap = el.querySelector<HTMLElement>(".eta")!;
  const etaFill = el.querySelector<HTMLElement>(".eta-bar i")!;
  const etaLabel = el.querySelector<HTMLElement>(".eta-label")!;
  const suggestEl = el.querySelector<HTMLElement>(".suggest")!;

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

  // Next-step suggestion chips: nav chips act immediately; prompt chips prefill
  // the composer (so a paid iteration is never one stray click away).
  suggestEl.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".schip");
    if (!chip) return;
    const nav = chip.getAttribute("data-nav");
    if (nav === "snapshot") app.goSnapshot();
    else if (nav === "variants") app.goVariants();
    else if (nav === "open-C") app.openVariant("C");
    else {
      const p = chip.getAttribute("data-prompt");
      if (p) { input.value = p; input.focus(); }
    }
  });

  // Artifact cards open on the right.
  threadEl.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".artifact-card");
    if (!card) return;
    const kind = card.getAttribute("data-artifact") as ArtifactRef["kind"];
    const variant = (card.getAttribute("data-variant") as VariantId | null) ?? undefined;
    app.openArtifact({ kind, variant, label: "" });
  });

  let renderedIds: string[] = [];

  // ETA bar — fills toward the estimate (caps at 95% so it never claims done
  // early). A timer repaints every 500ms since the store doesn't tick.
  let lastState: RunState | null = null;
  const dur = (sec: number) => (sec >= 90 ? `~${Math.round(sec / 60)} min` : `~${Math.round(sec)}s`);
  const remain = (sec: number) => (sec <= 1 ? "almost there" : sec >= 90 ? `~${Math.round(sec / 60)} min left` : `~${Math.round(sec)}s left`);
  // Footer = ETA bar while the agent works, else next-step suggestions.
  const paintEta = () => {
    const s = lastState;
    const showEta = !!(s?.agentBusy && s.eta);
    etaWrap.hidden = !showEta;
    suggestEl.hidden = showEta || !s || suggestionsFor(s).length === 0;
    if (showEta && s?.eta) {
      const elapsed = (Date.now() - s.eta.at) / 1000;
      const frac = Math.min(0.95, elapsed / Math.max(1, s.eta.seconds));
      etaFill.style.width = `${Math.round(frac * 100)}%`;
      etaLabel.textContent = `${remain(s.eta.seconds - elapsed)} · est. ${dur(s.eta.seconds)}`;
    }
  };
  setInterval(paintEta, 500);

  const renderSuggestions = (s: RunState) => {
    const list = suggestionsFor(s);
    suggestEl.innerHTML = list
      .map((x) => `<button class="schip"${x.nav ? ` data-nav="${x.nav}"` : ` data-prompt="${esc(x.prompt ?? "")}"`}>${esc(x.label)}</button>`)
      .join("");
  };

  let suggestKey = "";
  const update = (s: RunState) => {
    lastState = s;
    // re-render chips only when the relevant state changes (avoids clobbering)
    const key = `${s.screen}:${s.snapshotReady}`;
    if (key !== suggestKey) { renderSuggestions(s); suggestKey = key; }
    paintEta();
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
