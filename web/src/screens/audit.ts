/* Audit phase — score the result. Runs stardust:audit on the original site or
   the deployed preview (before/after) and shows the craft-rendered scored
   report. Left: target picker + scorecard; right: the report iframe. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { AuditState, RunState } from "../state";
import { topbar, rail, syncRail } from "../components/shell";
import { openInTab, previewIframe } from "../components/preview";
import { wireActions } from "./working";

function scorecard(a?: AuditState): string {
  if (!a) return "";
  if (a.status === "running") return `<div class="prow busy"><span class="pst"><span class="spin"></span></span><span class="ptx"><b>Auditing ${esc(a.url.replace(/^https?:\/\//, ""))}</b><span class="psub">design · seo · ai-visibility</span></span></div>`;
  if (a.status === "failed") return `<div class="prow failed"><span class="pst"><span class="tperr">!</span></span><span class="ptx"><b>Audit failed</b><span class="psub">${esc(a.message || "")}</span></span></div>`;
  const dims = Object.entries(a.scores ?? {});
  return `<div class="auditscore">
    ${typeof a.overall === "number" ? `<div class="audit-overall"><span class="num">${a.overall}</span><span class="of">/100</span><span class="lbl">${esc(a.target === "deployed" ? "deployed site" : "original site")}</span></div>` : ""}
    <div class="dimchips">${dims.map(([k, v]) => `<span class="fixchip"><span class="ck">${v}</span> ${esc(k)}</span>`).join("")}</div>
  </div>`;
}

export function audit(state: RunState, app: App): Screen {
  const a = state.audit;
  const busy = a?.status === "running";
  const el = h(`<div class="app">
    ${topbar(state, [])}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="audit phase">
        <div class="subheader">
          <div class="sub-left"><span class="eyebrow ovw">audit</span></div>
          <div class="sub-right">${openInTab(a?.reportUrl ?? "#")}</div>
        </div>
        <div class="protolayout">
          <aside class="protoside">
            <div class="protohint">Three-perspective audit — <b>design</b>, <b>SEO/technical</b>, and <b>AI-search visibility</b> — scored against the live render.</div>
            <div class="auditbody">${scorecard(a)}</div>
            <div class="dactions">
              <button class="btn btn-primary" data-audit-original${busy ? " disabled" : ""}>Audit original site</button>
              <button class="btn btn-quiet" data-audit-deployed${busy ? " disabled" : ""}>Audit deployed site</button>
            </div>
          </aside>
          <div class="protoprev" id="auditprev">${a?.reportUrl
            ? previewIframe(a.reportUrl, "audit report", state.viewport)
            : `<div class="protoblank"><div class="pb-star">✦</div><div class="pb-tx">Score the site — <b>before</b> (the original) or <b>after</b> (the deployed redesign). The report opens here when it's ready.</div></div>`}</div>
        </div>
      </section>
    </div>
    ${rail(state)}
  </div>`);

  wireActions(el, app);
  const side = el.querySelector<HTMLElement>(".protoside")!;
  side.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-audit-original]")) app.runAudit("original");
    else if (t.closest("[data-audit-deployed]")) app.runAudit("deployed");
  });

  const frame = () => el.querySelector<HTMLIFrameElement>("#artframe");
  if (a?.reportUrl) { const f = frame(); if (f) f.dataset.src = a.reportUrl; }

  const update = (s: RunState) => {
    syncRail(el, s);
    const body = el.querySelector<HTMLElement>(".auditbody");
    if (body) body.innerHTML = scorecard(s.audit);
    const b = s.audit?.status === "running";
    el.querySelectorAll<HTMLButtonElement>(".dactions .btn").forEach((x) => (x.disabled = !!b));
    const url = s.audit?.reportUrl ?? "";
    const prev = el.querySelector<HTMLElement>("#auditprev");
    const f = frame();
    if (url) {
      if (!f) { if (prev) prev.innerHTML = previewIframe(url, "audit report", s.viewport); }
      else if (f.dataset.src !== url) { f.src = url; f.dataset.src = url; const open = el.querySelector<HTMLAnchorElement>(".sub-right .open"); if (open) open.href = url; }
    }
  };
  return { el, update };
}
