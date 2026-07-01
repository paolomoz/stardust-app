/* The project board — the "Overview" view. Option A: a wide focus panel showing
   the live phase in detail, beside a rail that is the full five-rung stardust
   ladder (uplift · prototype · deploy · rollout · audit) in fixed order. The live
   phase fills the focus panel; every rung is clickable to preview its phase in
   the panel without moving the run. Category sits as an eyebrow above each task
   title so titles get the full width and never wrap mid-phrase. */
import { esc } from "../dom";
import type { RunState } from "../state";
import { taskIcons } from "./icons";

interface Row { cat: string; kind: string; title: string; detail: string; status: "done" | "run" | "wait"; }
interface Phase {
  id: string; label: string; sub: string;
  status: "done" | "active" | "future";
  rows: Row[];
  flow: string;         // rail one-liner before a phase runs ("Link AEM → Deploy → …")
  doneSummary: string;  // rail one-liner once the phase is complete
  meta: string[];       // focus-panel footer chips (live phase only)
}

// Illustrative steps for the not-yet-built phases (all "wait"/greyed), plus the
// one-line flow the rail shows before a phase runs.
const FUTURE: Record<string, { flow: string; rows: Row[] }> = {
  uplift: { flow: "Capture → Read → Direct → Validate", rows: [] },
  prototype: {
    flow: "Pick pages → Prototype → Check consistency",
    rows: [
      { cat: "TEMPLATES", kind: "crawl", title: "Pick the pages", detail: "product · article · listing", status: "wait" },
      { cat: "BUILD", kind: "generate", title: "Prototype each template", detail: "brand-faithful", status: "wait" },
      { cat: "REVIEW", kind: "validate", title: "Check consistency", detail: "system-wide", status: "wait" },
    ],
  },
  deploy: {
    flow: "Link AEM → Deploy → Verify renders",
    rows: [
      { cat: "CONNECT", kind: "read", title: "Link AEM", detail: "Edge Delivery", status: "wait" },
      { cat: "PUSH", kind: "generate", title: "Deploy prototypes", detail: "preview URLs", status: "wait" },
      { cat: "PREVIEW", kind: "validate", title: "Verify renders", detail: "a11y · responsive", status: "wait" },
    ],
  },
  rollout: {
    flow: "Map site → Migrate → Go live",
    rows: [
      { cat: "MAP", kind: "crawl", title: "Map the full site", detail: "all sections", status: "wait" },
      { cat: "MIGRATE", kind: "generate", title: "Migrate content", detail: "page by page", status: "wait" },
      { cat: "LIVE", kind: "validate", title: "Go live", detail: "rollout", status: "wait" },
    ],
  },
  audit: {
    flow: "Baseline → New home → New site",
    rows: [
      { cat: "BASELINE", kind: "analyze", title: "Audit current site", detail: "the live diagnosis", status: "wait" },
      { cat: "PAGE", kind: "validate", title: "Audit new home page", detail: "deployed · vs baseline", status: "wait" },
      { cat: "SITE", kind: "validate", title: "Audit new site", detail: "rolled out · vs baseline", status: "wait" },
    ],
  },
};

// Which phase's detail the focus panel shows (UI-only preview selection). null =
// follow the live phase; reset whenever the live phase advances.
let previewPhase: string | null = null;
let lastActiveId: string | null = null;
export function setBoardPreview(id: string | null): void { previewPhase = id; }

function phases(s: RunState): Phase[] {
  const host = s.url ? s.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "the homepage";

  const upliftRows: Row[] = s.tasks.map((t) => ({ cat: t.cat, kind: t.kind, title: t.title, detail: t.detail, status: t.status }));
  const upliftDone = s.tasks.length > 0 && s.tasks.every((t) => t.status === "done");

  // Prototype column reflects real page prototypes once the phase is entered.
  const protoRows: Row[] = s.templates.length
    ? s.templates.map((t) => ({
        cat: t.status === "done" ? "DONE" : t.status === "failed" ? "FAILED" : "BUILD",
        kind: "generate",
        title: t.title,
        detail: `variant ${t.variant}`,
        status: t.status === "done" ? "done" : t.status === "failed" ? "wait" : "run",
      }))
    : FUTURE.prototype.rows;
  const protoActive = s.templates.length > 0 || !!s.protoVariant;
  const protoDone = s.templates.length > 0 && s.templates.every((t) => t.status === "done");
  const protoStatus: Phase["status"] = protoDone ? "done" : protoActive ? "active" : "future";
  const protoSub = s.protoVariant ? `in variant ${s.protoVariant}` : "other pages";

  const rec = s.variants.find((v) => v.recommended);
  const upliftMeta: string[] = [];
  if (s.tensions.length) upliftMeta.push(`${s.tensions.length} tensions`);
  if (s.variants.length) upliftMeta.push(`${s.variants.length} variants`);

  // Deploy column reflects the real EDS push once it starts.
  const d = s.deploy;
  const stMap: Record<string, Row["status"]> = { converting: "run", converted: "run", pushing: "run", previewed: "done", live: "done", failed: "wait" };
  const deployRows: Row[] = d?.pages.length
    ? d.pages.map((p) => ({
        cat: p.status === "live" ? "LIVE" : p.status === "previewed" ? "PREVIEW" : p.status === "failed" ? "FAILED" : "PUSH",
        kind: "generate",
        title: p.title,
        detail: p.status === "failed" ? (p.message ?? "failed") : p.status,
        status: stMap[p.status] ?? "wait",
      }))
    : FUTURE.deploy.rows;
  const deployDone = !!d?.pages.length && d.pages.every((p) => p.status === "previewed" || p.status === "live");
  const deployStatus: Phase["status"] = d?.pages.length ? (deployDone && !d.busy ? "done" : "active") : "future";
  const liveCount = d?.pages.filter((p) => p.status === "live").length ?? 0;
  const rolloutStatus: Phase["status"] = d?.rollout ? "active" : d && liveCount === d.pages.length && liveCount > 0 ? "done" : "future";

  return [
    { id: "uplift", label: "Uplift", sub: host, status: upliftDone ? "done" : "active", rows: upliftRows,
      flow: FUTURE.uplift.flow,
      doneSummary: s.variants.length ? `${s.variants.length} variants${rec ? ` · ${rec.id} recommended` : ""}` : "brand captured",
      meta: upliftMeta },
    { id: "prototype", label: "Prototype", sub: protoSub, status: protoStatus, rows: protoRows,
      flow: FUTURE.prototype.flow,
      doneSummary: s.templates.length ? `${s.templates.length} pages${s.protoVariant ? ` · variant ${s.protoVariant}` : ""}` : "pages prototyped",
      meta: [] },
    { id: "deploy", label: "Deploy", sub: d ? `${d.branch} · aem.page` : "to AEM", status: deployStatus, rows: deployRows,
      flow: FUTURE.deploy.flow,
      doneSummary: d?.pages.length ? `${d.pages.length} page${d.pages.length > 1 ? "s" : ""} ${d.live ? "live" : "previewed"}` : "preview URLs live",
      meta: d ? [`branch ${d.branch}`, `/${d.project}`] : [] },
    { id: "rollout", label: "Rollout", sub: "the whole site", status: rolloutStatus,
      rows: d?.rollout
        ? [{ cat: "ROLLOUT", kind: "generate", title: "Prototyping + deploying every page", detail: `${liveCount} of ${(s.pageCandidates.length || d.pages.length) + 1} live`, status: "run" }]
        : FUTURE.rollout.rows,
      flow: FUTURE.rollout.flow, doneSummary: "site live", meta: [] },
    { id: "audit", label: "Audit", sub: "score the result", status: "future", rows: FUTURE.audit.rows, flow: FUTURE.audit.flow, doneSummary: "scored", meta: [] },
  ];
}

const mark = (st: string) =>
  st === "done" ? `<span class="ok">✓</span>` : st === "run" ? `<span class="spin"></span>` : `<span class="qd">○</span>`;

const taskRow = (r: Row) =>
  `<div class="ovb-task ${r.status}">
    <span class="ic">${taskIcons[r.kind] ?? ""}</span>
    <div class="tx"><div class="eb">${esc(r.cat)}</div><div class="tl">${esc(r.title)}</div><div class="td">${esc(r.detail)}</div></div>
    <span class="st">${mark(r.status)}</span>
  </div>`;

function focusPanel(p: Phase): string {
  const rel = p.status === "done" ? "done" : p.status === "active" ? "live" : "future";
  const badge =
    rel === "done" ? `<span class="ovb-badge done">done</span>`
    : rel === "live" ? `<span class="ovb-badge run">in progress</span>`
    : `<span class="ovb-badge">preview</span>`;
  const banner =
    rel === "future" ? `<div class="ovb-banner preview">Upcoming preview — nothing has started here yet.</div>`
    : rel === "done" ? `<div class="ovb-banner done">✓ Completed · ${esc(p.doneSummary)}</div>`
    : "";
  const rows = p.rows.length ? p.rows.map(taskRow).join("") : `<div class="ovb-empty">—</div>`;
  const meta = rel === "live" && p.meta.length ? `<div class="ovb-meta">${p.meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>` : "";
  return `<section class="ovb-focus ${rel}">
    <div class="ovb-fhead"><div><span class="ovb-ft">${esc(p.label)}</span><span class="ovb-fs">${esc(p.sub)}</span></div>${badge}</div>
    ${banner}
    <div class="ovb-tasks">${rows}</div>
    ${meta}
  </section>`;
}

function railList(ph: Phase[], ai: number, si: number): string {
  const rungs = ph.map((p, i) => {
    const st = p.status; // done | active | future
    const isSel = i === si;
    let body: string;
    if (st === "done") body = `<div class="rc-done">✓ ${esc(p.doneSummary)}</div>`;
    else if (st === "active") {
      const done = p.rows.filter((r) => r.status === "done").length;
      body = `<div class="rc-sub">${esc(p.sub)}</div><div class="rc-flow"><b>in progress</b> · ${done} of ${p.rows.length} done</div>`;
    } else body = `<div class="rc-sub">${esc(p.sub)}</div><div class="rc-flow">${esc(p.flow)}</div>`;
    const chip = isSel ? `<span class="rc-view">● viewing</span>`
      : st === "done" ? `<span class="ovb-badge done">done</span>`
      : st === "active" ? `<span class="ovb-badge run">live</span>`
      : `<span class="ovb-badge">${i === ai + 1 ? "next" : "soon"}</span>`;
    return `<button type="button" class="ovb-rung ${st}${isSel ? " sel" : ""}" data-act="board-view-${p.id}">
      <span class="dot"></span><span class="spine"></span>
      <div class="rcard"><div class="rc-top"><span class="rc-t">${esc(p.label)}</span>${chip}</div>${body}</div>
    </button>`;
  });
  return `<nav class="ovb-rail" aria-label="stardust ladder">${rungs.join("")}</nav>`;
}

export function board(s: RunState): string {
  const ph = phases(s);
  // The live phase = the one marked active; else the first not-yet-done phase.
  let ai = ph.findIndex((p) => p.status === "active");
  if (ai < 0) ai = ph.findIndex((p) => p.status !== "done");
  if (ai < 0) ai = ph.length - 1;

  // Drop a stale preview when the run advances to a new live phase.
  const activeId = ph[ai].id;
  if (activeId !== lastActiveId) { previewPhase = null; lastActiveId = activeId; }

  let si = previewPhase ? ph.findIndex((p) => p.id === previewPhase) : ai;
  if (si < 0) si = ai;

  return `<div class="ovb">${focusPanel(ph[si])}${railList(ph, ai, si)}</div>`;
}
