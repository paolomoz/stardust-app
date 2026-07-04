/* Deploy / rollout phase — ship the chosen direction to AEM Edge Delivery.
   Left of the panel: the target (repo branch + DA folder), the page ledger
   (home + prototyped pages → converted → previewed → live) and the actions
   (deploy to preview · go live · roll out the whole site). Right: a live
   iframe of the deployed preview. The shared chat routes to template jobs
   (prototype more pages) on this screen. */
import { h, esc } from "../dom";
import type { App, Screen } from "../controller";
import type { DeployPage, RunState } from "../state";
import { topbar, rail, syncRail } from "../components/shell";
import { viewportToggle, openInTab, previewIframe } from "../components/preview";
import { wireActions } from "./working";

const STATUS_LABEL: Record<DeployPage["status"], string> = {
  converting: "converting…",
  converted: "converted",
  pushing: "pushing…",
  previewed: "previewed",
  live: "live",
  failed: "failed",
};

const badge = (st: DeployPage["status"]): string =>
  st === "live" ? `<span class="ok">●</span>`
  : st === "previewed" ? `<span class="ok">✓</span>`
  : st === "failed" ? `<span class="tperr">!</span>`
  : `<span class="spin"></span>`;

/** Everything shippable: home + each prototyped page, with its deploy status. */
function deployRows(s: RunState): { slug: string; title: string; page?: DeployPage; ready: boolean }[] {
  const d = s.deploy;
  const bySlug = new Map((d?.pages ?? []).map((p) => [p.slug, p]));
  const rows: { slug: string; title: string; page?: DeployPage; ready: boolean }[] = [
    { slug: "home", title: "Home", page: bySlug.get("home"), ready: s.variants.length > 0 },
  ];
  for (const t of s.templates) {
    rows.push({ slug: t.slug, title: t.title, page: bySlug.get(t.slug), ready: t.status === "done" });
  }
  return rows;
}

function ledger(s: RunState): string {
  const rows = deployRows(s).map((r) => {
    const st = r.page?.status;
    const url = r.page?.liveUrl ?? r.page?.previewUrl;
    const fidelity = r.page?.verified === true ? " · ✓ fidelity"
      : r.page?.verified === false ? ` · ⚠ ${esc(r.page?.message || "diff flags")}`
      : "";
    const sub = st
      ? (st === "failed" ? esc(r.page?.message || "failed") : esc(STATUS_LABEL[st]) + fidelity)
      : r.ready ? "ready to deploy" : "not prototyped yet";
    const check = r.ready && (!st || st === "failed")
      ? `<input type="checkbox" class="dcheck" value="${esc(r.slug)}" checked />`
      : `<span class="pst">${st ? badge(st) : "○"}</span>`;
    const openable = !!url;
    return `<div class="prow ${st ?? (r.ready ? "pick" : "waiting")}${s.protoActive === r.slug && openable ? " on" : ""}"${openable ? ` data-open-deploy="${esc(r.slug)}"` : ""}>
      ${check}
      <span class="ptx"><b>${esc(r.title)}</b><span class="psub">${sub}${url ? ` · <a href="${esc(url)}" target="_blank" rel="noreferrer">open ↗</a>` : ""}</span></span>
    </div>`;
  });
  return rows.join("") || `<div class="pempty">Nothing shippable yet — generate the directions first.</div>`;
}

function target(s: RunState): string {
  const d = s.deploy;
  if (!d) return `<div class="protohint">Ships the selected direction (variant <b class="pv">${esc(s.protoVariant ?? s.activeVariant ?? "—")}</b>) to AEM Edge Delivery — a per-project code branch + DA content folder.</div>`;
  return `<div class="protohint deploy-target">
    <div>branch <b>${esc(d.branch)}</b> · folder <b>/${esc(d.project)}</b> · variant <b>${esc(d.variant)}</b></div>
    <div class="psub"><a href="${esc(d.previewHost)}/${esc(d.project)}/" target="_blank" rel="noreferrer">${esc(d.previewHost.replace(/^https:\/\//, ""))}/${esc(d.project)}/ ↗</a></div>
  </div>`;
}

/** The deployed page shown in the preview iframe. */
function activeDeploy(s: RunState): DeployPage | undefined {
  const ok = (s.deploy?.pages ?? []).filter((p) => p.previewUrl || p.liveUrl);
  return ok.find((p) => p.slug === s.protoActive) ?? ok.find((p) => p.slug === "home") ?? ok[ok.length - 1];
}

export function deploy(state: RunState, app: App): Screen {
  const cur = activeDeploy(state);
  const curUrl = cur ? (cur.liveUrl ?? cur.previewUrl)! : "";
  const busy = !!state.deploy?.busy;
  const el = h(`<div class="app">
    ${topbar(state, [])}
    <div class="middle">
      <section class="conv conv-mount" aria-label="conversation"></section>
      <section class="panel" aria-label="deploy phase">
        <div class="subheader">
          <div class="sub-left"><span class="eyebrow ovw">deploy</span></div>
          <div class="sub-right">${viewportToggle(state.viewport)}${openInTab(curUrl || "#")}</div>
        </div>
        <div class="protolayout">
          <aside class="protoside">
            <div class="dtarget">${target(state)}</div>
            <div class="pagelist dlist">${ledger(state)}</div>
            <div class="dactions">
              <button class="btn btn-primary" data-deploy-go${busy ? " disabled" : ""}>Deploy to preview</button>
              <button class="btn btn-quiet" data-deploy-live${busy ? " disabled" : ""}>Go live</button>
              <button class="btn btn-quiet" data-deploy-rollout${busy ? " disabled" : ""}>Roll out whole site</button>
            </div>
          </aside>
          <div class="protoprev" id="deployprev">${curUrl
            ? previewIframe(curUrl, `${state.projectName} — deployed`, state.viewport)
            : `<div class="protoblank"><div class="pb-star">✦</div><div class="pb-tx">Deploy converts the chosen variant into <b>Edge Delivery blocks</b>, pushes code to a project branch and content to DA, and previews it on <b>aem.page</b>. Check the pages and hit <b>Deploy to preview</b>.</div></div>`}</div>
        </div>
      </section>
    </div>
    ${rail(state)}
  </div>`);

  wireActions(el, app);

  const side = el.querySelector<HTMLElement>(".protoside")!;
  side.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-deploy-go]")) {
      const slugs = Array.from(el.querySelectorAll<HTMLInputElement>(".dcheck:checked")).map((c) => c.value);
      if (slugs.length) app.deployPages(slugs);
      return;
    }
    if (t.closest("[data-deploy-live]")) { app.goLive(); return; }
    if (t.closest("[data-deploy-rollout]")) { app.rollout(); return; }
    const open = t.closest<HTMLElement>("[data-open-deploy]");
    if (open && !(e.target as HTMLElement).closest("a")) app.setProtoActive(open.getAttribute("data-open-deploy")!);
  });

  el.querySelector("#vDesk")?.addEventListener("click", () => app.setViewport("desktop"));
  el.querySelector("#vMob")?.addEventListener("click", () => app.setViewport("mobile"));

  const frame = () => el.querySelector<HTMLIFrameElement>("#artframe");
  if (curUrl) { const f = frame(); if (f) f.dataset.src = curUrl; }

  const update = (s: RunState) => {
    syncRail(el, s);
    const tgt = el.querySelector<HTMLElement>(".dtarget");
    if (tgt) tgt.innerHTML = target(s);
    const list = el.querySelector<HTMLElement>(".dlist");
    if (list) list.innerHTML = ledger(s);
    const b = !!s.deploy?.busy;
    el.querySelectorAll<HTMLButtonElement>(".dactions .btn").forEach((x) => (x.disabled = b));
    const t = activeDeploy(s);
    const url = t ? (t.liveUrl ?? t.previewUrl)! : "";
    const prev = el.querySelector<HTMLElement>("#deployprev");
    const f = frame();
    if (url) {
      if (!f) {
        if (prev) prev.innerHTML = previewIframe(url, `${s.projectName} — deployed`, s.viewport);
      } else if (f.dataset.src !== url) {
        f.src = url; f.dataset.src = url;
        const open = el.querySelector<HTMLAnchorElement>(".sub-right .open"); if (open) open.href = url;
      }
      const p = el.querySelector("#preview"); if (p) p.classList.toggle("mobile", s.viewport === "mobile");
      el.querySelector("#vDesk")?.classList.toggle("on", s.viewport === "desktop");
      el.querySelector("#vMob")?.classList.toggle("on", s.viewport === "mobile");
    }
  };
  return { el, update };
}
