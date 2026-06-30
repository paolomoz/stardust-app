/* Brand review — captured brand surface (iframed) + tensions in the thread. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState } from "../state";
import { topbar, rail, syncRail } from "../components/shell";
import { convHead, composer, thread } from "../components/conversation";
import { openInTab } from "../components/preview";
import { search } from "../components/icons";
import { KNACK_SEED_NOTE } from "../data/knack";
import { wireActions, wireComposer } from "./working";

export function brand(state: RunState, app: App): Screen {
  const el = h(`<div class="app">
    ${topbar(state.phase, [
      { label: "← Back", kind: "quiet", to: "back-working" },
      { label: "See directions", kind: "primary", to: "variants", arrow: true },
    ])}
    <div class="middle">
      <section class="conv" aria-label="conversation">
        ${convHead(state.projectName)}
        ${thread(state.messages, KNACK_SEED_NOTE)}
        ${composer("ask about the brand…", `Try <span class="mono">"run the audit"</span> or <span class="mono">"see directions"</span>.`)}
      </section>
      <section class="panel" aria-label="brand review">
        <div class="subheader">
          <div class="sub-left"><span class="eyebrow">brand review</span><span style="font-size:13px;color:var(--fg-dim)">${esc(state.projectName)}</span></div>
          <div class="sub-right">
            <button class="auditbtn">${search} Run audit</button>
            ${openInTab(state.brandReviewUrl)}
          </div>
        </div>
        <div class="preview"><iframe src="${esc(state.brandReviewUrl)}" title="${esc(state.projectName)} brand review" loading="eager"></iframe></div>
      </section>
    </div>
    ${rail(state.rail)}
  </div>`);

  wireActions(el, app);
  wireComposer(el, app, "brand");

  const update = (s: RunState) => {
    syncRail(el, s.rail);
    const t = el.querySelector(".conv-thread");
    if (t) t.outerHTML = thread(s.messages, KNACK_SEED_NOTE);
  };
  return { el, update };
}
