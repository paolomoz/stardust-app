/* Audit — an optional, on-demand scored diagnosis. In uplift it audits the
   current live site (the baseline we redesign against); in deploy/rollout it
   audits the result against that baseline. Costs time + tokens, so it's never
   auto-run: the view shows a CTA until the user runs it. See NAVIGATION.md. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { RunState, AuditState } from "../state";
import { topbar, viewTabs, rail, syncRail } from "../components/shell";
import { bigStar } from "../components/icons";
import { wireActions } from "./working";

const host = (s: RunState) => (s.url ? s.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "the site");

function finding(f: { n: string; text: string; fixed?: boolean }): string {
  return `<div class="afind${f.fixed ? " fixed" : ""}">
    <span class="an">${esc(f.n)}</span>
    <span class="at">${esc(f.text)}</span>
    ${f.fixed ? `<span class="ok">✓</span>` : ""}
  </div>`;
}

function body(s: RunState): string {
  const a: AuditState | undefined = s.audit;
  if (!a || a.status === "idle") {
    return `<div class="auditcta">
      <div class="stage"><div class="ring"></div>${bigStar}</div>
      <h2>Audit ${esc(host(s))}</h2>
      <p>An optional scored diagnosis — palette, type, hierarchy, CTAs, a11y. It's
      not run automatically: it takes a few minutes and uses tokens. Run it to set
      a baseline now, or later to verify the result.</p>
      <button class="btn btn-primary" data-act="run-audit">Run audit</button>
    </div>`;
  }
  if (a.status === "running") {
    return `<div class="auditcta"><div class="stage"><div class="ring"></div><div class="ring2"></div>${bigStar}</div><h2>Auditing ${esc(host(s))}…</h2><p>Scoring the live surface against the design system.</p></div>`;
  }
  const delta = typeof a.baseline === "number" && typeof a.score === "number"
    ? `<div class="scoredelta">${a.baseline} <span class="arr">→</span> ${a.score}</div>` : "";
  return `<div class="scorecard">
    <div class="scorehead">
      <div class="scorebig">${a.score ?? "—"}<span>/100</span></div>
      <div class="scoremeta"><div class="scorelbl">audit score</div>${delta}</div>
      <button class="btn btn-quiet" data-act="run-audit">Re-audit</button>
    </div>
    <div class="findings">${a.findings.map(finding).join("") || `<div class="bempty">No findings.</div>`}</div>
  </div>`;
}

export function audit(state: RunState, app: App): Screen {
  const el = h(`<div class="app">
    ${topbar(state, [])}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="audit">
        <div class="subheader">
          <div class="sub-left">${viewTabs(state)}</div>
          <div class="sub-right"><span class="muted-note">optional · scored diagnosis</span></div>
        </div>
        <div class="auditwrap" id="auditwrap">${body(state)}</div>
      </section>
    </div>
    ${rail(state.rail)}
  </div>`);

  wireActions(el, app);

  const update = (s: RunState) => {
    syncRail(el, s.rail);
    const tabs = el.querySelector<HTMLElement>(".sub-left");
    if (tabs) tabs.innerHTML = viewTabs(s);
    const aw = el.querySelector<HTMLElement>("#auditwrap");
    if (aw) aw.innerHTML = body(s);
  };
  return { el, update };
}
