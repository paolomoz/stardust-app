/* Workspace — iterate the chosen variant. Real redesign iframed; A/B/C switch,
   viewport toggle, and a conversation that drives changes. */
import { h } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState, VariantId } from "../state";
import { topbar, rail } from "../components/shell";
import { convHead, composer, thread } from "../components/conversation";
import { segSwitch, viewportToggle, openInTab, previewIframe } from "../components/preview";
import { KNACK_SEED_NOTE } from "../data/knack";
import { wireActions, wireComposer } from "./working";

function activeCard(s: RunState) {
  return s.variants.find((v) => v.id === s.activeVariant) ?? s.variants[0];
}

export function workspace(state: RunState, app: App): Screen {
  const cur = activeCard(state);
  const el = h(`<div class="app">
    ${topbar(state.phase, [
      { label: "Restart", kind: "quiet", to: "restart" },
      { label: "Deploy", kind: "primary", to: "deploy", arrow: true },
    ])}
    <div class="middle">
      <section class="conv" aria-label="conversation">
        ${convHead(state.projectName, `<button class="btn-quiet" style="font-size:12.5px;color:var(--fg-dim)">History</button>`)}
        ${thread(state.messages, KNACK_SEED_NOTE)}
        ${composer("tell me a change…", `Try <span class="mono">"calmer comparison"</span> or <span class="mono">"more magenta"</span>.`)}
      </section>
      <section class="panel" aria-label="prototype preview">
        <div class="subheader">
          <div class="sub-left"><span class="eyebrow">prototype</span>${segSwitch(state.variants, state.activeVariant)}</div>
          <div class="sub-right">${viewportToggle(state.viewport)}${openInTab(cur.src)}</div>
        </div>
        ${previewIframe(cur.src, `${state.projectName} redesign — variant ${cur.id}`, state.viewport)}
      </section>
    </div>
    ${rail(state.rail)}
  </div>`);

  const frame = el.querySelector<HTMLIFrameElement>("#artframe")!;
  frame.dataset.variant = cur.id;

  wireActions(el, app);
  wireComposer(el, app, "workspace");

  // variant seg switch
  el.querySelectorAll<HTMLButtonElement>(".seg[data-variant-switch] button").forEach((b) =>
    b.addEventListener("click", () => app.setVariant(b.getAttribute("data-variant") as VariantId)),
  );
  // viewport toggle
  el.querySelector("#vDesk")!.addEventListener("click", () => app.setViewport("desktop"));
  el.querySelector("#vMob")!.addEventListener("click", () => app.setViewport("mobile"));

  const update = (s: RunState) => {
    // conversation
    const t = el.querySelector(".conv-thread");
    if (t) t.outerHTML = thread(s.messages, KNACK_SEED_NOTE);
    // variant switch — only reload the iframe when the variant actually changed
    const card = activeCard(s);
    if (frame.dataset.variant !== card.id) {
      frame.src = card.src;
      frame.dataset.variant = card.id;
      const open = el.querySelector<HTMLAnchorElement>(".sub-right .open");
      if (open) open.href = card.src;
    }
    el.querySelectorAll<HTMLButtonElement>(".seg[data-variant-switch] button").forEach((b) =>
      b.classList.toggle("on", b.getAttribute("data-variant") === card.id),
    );
    // viewport
    const prev = el.querySelector("#preview")!;
    prev.classList.toggle("mobile", s.viewport === "mobile");
    el.querySelector("#vDesk")!.classList.toggle("on", s.viewport === "desktop");
    el.querySelector("#vMob")!.classList.toggle("on", s.viewport === "mobile");
    // footer variant label
    const vl = el.querySelector("#variantLabel");
    if (vl) vl.textContent = card.segLabel;
  };
  return { el, update };
}
