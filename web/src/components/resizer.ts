/* ===========================================================================
   Draggable chat-column width. A thin handle sits on the conv/preview boundary
   and drives the global `--conv-w` grid track. The user's width is persisted in
   localStorage and restored on load; default (320px, from CSS) is kept until the
   user drags. Disables iframe pointer events mid-drag so the preview can't
   swallow the mouse.
   =========================================================================== */
const KEY = "stardust:convW";
const MIN = 260;
const MAX = 640;

export function mountResizer(): void {
  const root = document.documentElement;
  const saved = Number(localStorage.getItem(KEY));
  if (saved >= MIN && saved <= MAX) root.style.setProperty("--conv-w", `${saved}px`);

  const handle = document.createElement("div");
  handle.className = "conv-resize";
  handle.setAttribute("aria-hidden", "true");
  document.body.appendChild(handle);

  let dragging = false;
  const onMove = (e: MouseEvent) => {
    if (!dragging) return;
    const w = Math.min(MAX, Math.max(MIN, e.clientX));
    root.style.setProperty("--conv-w", `${w}px`);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    const w = parseInt(getComputedStyle(root).getPropertyValue("--conv-w"), 10);
    if (w) localStorage.setItem(KEY, String(w));
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  // Double-click resets to the default width.
  handle.addEventListener("dblclick", () => {
    root.style.removeProperty("--conv-w");
    localStorage.removeItem(KEY);
  });
}
