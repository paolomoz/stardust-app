/* Brand review — captured brand surface (iframed) + tensions in the thread. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState } from "../state";
import { topbar, viewNav, rail, syncRail } from "../components/shell";
import { openInTab } from "../components/preview";
import { search } from "../components/icons";
import { wireActions } from "./working";

export function brand(state: RunState, app: App): Screen {
  const el = h(`<div class="app">
    ${topbar(state, [])}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="brand review">
        <div class="subheader">
          <div class="sub-left">${viewNav("uplift", state)}</div>
          <div class="sub-right">
            <button class="auditbtn">${search} Run audit</button>
            ${openInTab(state.brandReviewUrl)}
          </div>
        </div>
        <div class="preview"><iframe src="${esc(state.brandReviewUrl)}" title="${esc(state.projectName)} brand review" loading="eager"></iframe></div>
      </section>
    </div>
    ${rail(state)}
  </div>`);

  wireActions(el, app);

  const update = (s: RunState) => {
    syncRail(el, s);
    const tabs = el.querySelector<HTMLElement>(".sub-left");
    if (tabs) tabs.innerHTML = viewNav("uplift", s);
  };
  return { el, update };
}
