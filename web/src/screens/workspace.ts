/* Workspace — iterate the chosen variant. Real redesign iframed; A/B/C switch
   and viewport toggle. The conversation column is the shared persistent panel
   (main.ts re-parents it into .conv-mount). */
import { h } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState, VariantId } from "../state";
import { store } from "../state";
import { topbar, rail, syncRail } from "../components/shell";
import { segSwitch, viewportToggle, openInTab, previewIframe } from "../components/preview";
import { wireActions } from "./working";
import { publishArtifact, unpublishArtifact, fetchPublished } from "../driver/liveDriver";

function activeCard(s: RunState) {
  return s.variants.find((v) => v.id === s.activeVariant) ?? s.variants[0];
}
const fileOf = (card: { src: string }) => card.src.split("?")[0].split("/").pop() ?? "";

export function workspace(state: RunState, app: App): Screen {
  const cur = activeCard(state);
  const el = h(`<div class="app">
    ${topbar(state.phase, [
      { label: "Restart", kind: "quiet", to: "restart" },
      { label: "Deploy", kind: "primary", to: "deploy", arrow: true },
    ])}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="prototype preview">
        <div class="subheader">
          <div class="sub-left"><span class="eyebrow">prototype</span>${segSwitch(state.variants, state.activeVariant)}</div>
          <div class="sub-right"><span class="pubctl"></span>${viewportToggle(state.viewport)}${openInTab(cur.src)}</div>
        </div>
        ${previewIframe(cur.src, `${state.projectName} redesign — variant ${cur.id}`, state.viewport)}
      </section>
    </div>
    ${rail(state.rail)}
  </div>`);

  const frame = el.querySelector<HTMLIFrameElement>("#artframe")!;
  frame.dataset.variant = cur.id;
  frame.dataset.src = cur.src;

  wireActions(el, app);

  // variant seg switch
  el.querySelectorAll<HTMLButtonElement>(".seg[data-variant-switch] button").forEach((b) =>
    b.addEventListener("click", () => app.setVariant(b.getAttribute("data-variant") as VariantId)),
  );
  // viewport toggle
  el.querySelector("#vDesk")!.addEventListener("click", () => app.setViewport("desktop"));
  el.querySelector("#vMob")!.addEventListener("click", () => app.setViewport("mobile"));

  // ---- Publish controls (publish the active variant → public /p/<token>) ----
  const pubctl = el.querySelector<HTMLElement>(".pubctl")!;
  const renderPub = (s: RunState) => {
    const file = fileOf(activeCard(s));
    const pub = (s.published ?? []).find((p) => p.path === file);
    pubctl.innerHTML = pub
      ? `<button class="pubbtn on" data-pub="copy" title="${location.origin}${pub.url}">Public ✓</button><button class="publink" data-pub="unpublish">unpublish</button>`
      : `<button class="pubbtn" data-pub="publish">Publish</button>`;
  };
  renderPub(state);
  // Load the run's published set once.
  if (state.runId) void fetchPublished(state.runId).then((published) => store.set({ published }));
  pubctl.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-pub]");
    if (!b) return;
    const s = store.get();
    const runId = s.runId;
    if (!runId) return;
    const file = fileOf(activeCard(s));
    const act = b.getAttribute("data-pub");
    if (act === "publish") {
      b.textContent = "Publishing…";
      try {
        const url = await publishArtifact(runId, file, `${s.projectName} — variant ${activeCard(s).id}`);
        await navigator.clipboard.writeText(url).catch(() => {});
        b.textContent = "Copied ✓";
        const path = new URL(url).pathname;
        setTimeout(() => store.set({ published: [...(store.get().published ?? []).filter((p) => p.path !== file), { path: file, url: path }] }), 1300);
      } catch { b.textContent = "Publish"; }
    } else if (act === "copy") {
      const pub = (s.published ?? []).find((p) => p.path === file);
      if (pub) { await navigator.clipboard.writeText(`${location.origin}${pub.url}`).catch(() => {}); b.textContent = "Copied ✓"; setTimeout(() => renderPub(store.get()), 1300); }
    } else if (act === "unpublish") {
      await unpublishArtifact(runId, file);
      store.set({ published: (store.get().published ?? []).filter((p) => p.path !== file) });
    }
  });

  const update = (s: RunState) => {
    renderPub(s);
    // footer rail (palette/clock) — re-render in place on state change
    syncRail(el, s.rail);
    // reload the iframe when the variant changes OR its src does (in-place
    // re-render after an iteration bumps src with a ?v= cache-buster)
    const card = activeCard(s);
    if (frame.dataset.variant !== card.id || frame.dataset.src !== card.src) {
      frame.src = card.src;
      frame.dataset.variant = card.id;
      frame.dataset.src = card.src;
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
