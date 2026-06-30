/* Landing — full-screen hero. Paste a URL → start a run; or resume one of your
   past runs from the list below. */
import { h, esc } from "../dom";
import type { App } from "../controller";
import type { RunState } from "../state";
import { starHero, globe, sendArrowLg } from "../components/icons";
import { userChip, logout } from "../auth";
import { listRuns, type RunSummary } from "../driver/liveDriver";

function cleanUrl(u: string): string {
  return u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}
function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function runRow(r: RunSummary): string {
  const title = r.project || cleanUrl(r.url);
  return `<button class="runrow" data-run="${esc(r.id)}">
    <span class="rs rs-${esc(r.status)}"></span>
    <span class="rt"><span class="rname">${esc(title)}</span><span class="rmeta">${esc(r.status)} · ${relTime(r.created_at)}</span></span>
    <span class="rarr">→</span>
  </button>`;
}

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
        <input type="text" placeholder="https://example.com" aria-label="website URL" />
        <button class="send" aria-label="start">${sendArrowLg}</button>
      </div>
      <div class="yourruns">
        <div class="yr-h">Your runs</div>
        <div class="yr-list"><div class="yr-empty">Loading…</div></div>
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
  el.querySelector<HTMLButtonElement>(".userchip")?.addEventListener("click", () => void logout());

  // Your runs — resume any past run.
  const list = el.querySelector<HTMLElement>(".yr-list")!;
  void listRuns().then((runs) => {
    if (!runs.length) {
      list.innerHTML = `<div class="yr-empty">No runs yet — paste a URL above to start your first redesign.</div>`;
      return;
    }
    list.innerHTML = runs.map(runRow).join("");
    list.querySelectorAll<HTMLButtonElement>(".runrow[data-run]").forEach((b) =>
      b.addEventListener("click", () => { location.href = `/?run=${b.getAttribute("data-run")}`; }),
    );
  });

  return el;
}
