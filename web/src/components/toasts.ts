/* Cross-screen "new artifact ready" toasts. Floats above everything (appended to
   <body>), so the user is notified even if they scrolled away or are on another
   screen. Fires only during a live run (not on reopen replay). Clicking Open
   opens the artifact on the right via app.openArtifact. */
import { h, esc } from "../dom";
import type { App } from "../controller";
import { store } from "../state";
import type { ArtifactRef } from "../state";

export function mountToasts(app: App): void {
  const layer = h(`<div class="toasts" aria-live="polite"></div>`);
  document.body.appendChild(layer);

  let seenAt = 0;
  store.subscribe((s) => {
    if (!s.live || !s.lastArtifact || s.lastArtifact.at === seenAt) return;
    seenAt = s.lastArtifact.at;
    show(s.lastArtifact.ref);
  });

  function show(ref: ArtifactRef): void {
    const t = h(`<div class="toast" role="status">
      <span class="tk">▦</span>
      <span class="tt"><b>${esc(ref.label)}</b> ready</span>
      <button class="topen">Open</button>
      <button class="tx" aria-label="dismiss">×</button>
    </div>`);
    layer.appendChild(t);
    requestAnimationFrame(() => t.classList.add("in"));
    const dismiss = () => { t.classList.remove("in"); setTimeout(() => t.remove(), 250); };
    t.querySelector(".topen")!.addEventListener("click", () => { app.openArtifact(ref); dismiss(); });
    t.querySelector(".tx")!.addEventListener("click", dismiss);
    setTimeout(dismiss, 7000);
  }
}
