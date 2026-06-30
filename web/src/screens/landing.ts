/* Landing — full-screen hero, no shell. Paste a URL → start a run. */
import { h } from "../dom";
import type { App } from "../controller";
import type { RunState } from "../state";
import { KNACK_URL, RECENTS } from "../data/knack";
import { starHero, globe, sendArrowLg } from "../components/icons";
import { userChip, logout } from "../auth";

export function landing(_state: RunState, app: App): HTMLElement {
  const el = h(`<div class="landing">
    <div class="landing-user">${userChip()}</div>
    <div class="dust"></div>
    <div class="hero fade">
      ${starHero}
      <h1>stardust</h1>
      <p class="tag">brief <span class="op">+</span> seed <span class="op">=</span> star</p>
      <p class="sub">Redesign any website and ship it to AEM. Paste a URL — stardust reads the brand, proposes directions, and you steer from there.</p>
      <div class="field">
        ${globe}
        <input type="text" value="${KNACK_URL}" aria-label="website URL" />
        <button class="send" aria-label="start">${sendArrowLg}</button>
      </div>
      <div class="recents">
        <span class="lbl">recent</span>
        ${RECENTS.map((r) => `<button class="chip" data-recent="${r}">${r}</button>`).join("")}
      </div>
    </div>
    <div class="corner">ADOBE · STARDUST · v0.1</div>
  </div>`);

  const input = el.querySelector<HTMLInputElement>(".field input")!;
  const fire = () => {
    const url = input.value.trim();
    if (url) app.start(url);
  };
  el.querySelector<HTMLButtonElement>(".field .send")!.addEventListener("click", fire);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fire();
  });
  el.querySelectorAll<HTMLButtonElement>(".chip[data-recent]").forEach((c) =>
    c.addEventListener("click", () => {
      const r = c.getAttribute("data-recent")!;
      app.start(r.startsWith("http") ? r : `https://www.${r}/`);
    }),
  );
  el.querySelector<HTMLButtonElement>(".userchip")?.addEventListener("click", () => void logout());
  return el;
}
