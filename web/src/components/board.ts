/* The project board — the "Overview" view (formerly "Building your redesign").
   Four columns for the stardust journey: uplift (live) · prototype · deploy ·
   rollout (future, greyed). The uplift column renders the live run sub-steps as
   task rows; the rest are illustrative future steps. See NAVIGATION.md +
   IMPROVEMENTS.md (Product / flow ladder). */
import { esc } from "../dom";
import type { RunState } from "../state";
import { taskIcons } from "./icons";

interface Row { cat: string; kind: string; title: string; detail: string; status: "done" | "run" | "wait"; }
interface Col { id: string; label: string; sub: string; status: "active" | "done" | "future"; rows: Row[]; }

// Illustrative steps for the not-yet-built phases (all "wait" / greyed).
const FUTURE: Record<string, Row[]> = {
  prototype: [
    { cat: "TEMPLATES", kind: "crawl", title: "Pick the pages", detail: "product · article · listing", status: "wait" },
    { cat: "BUILD", kind: "generate", title: "Prototype each template", detail: "brand-faithful", status: "wait" },
    { cat: "REVIEW", kind: "validate", title: "Check consistency", detail: "system-wide", status: "wait" },
  ],
  deploy: [
    { cat: "CONNECT", kind: "read", title: "Link AEM", detail: "Edge Delivery", status: "wait" },
    { cat: "PUSH", kind: "generate", title: "Deploy prototypes", detail: "preview URLs", status: "wait" },
    { cat: "PREVIEW", kind: "validate", title: "Verify renders", detail: "a11y · responsive", status: "wait" },
  ],
  rollout: [
    { cat: "MAP", kind: "crawl", title: "Map the full site", detail: "all sections", status: "wait" },
    { cat: "MIGRATE", kind: "generate", title: "Migrate content", detail: "page by page", status: "wait" },
    { cat: "LIVE", kind: "validate", title: "Go live", detail: "rollout", status: "wait" },
  ],
  audit: [
    { cat: "BASELINE", kind: "analyze", title: "Audit current site", detail: "the live diagnosis", status: "wait" },
    { cat: "PAGE", kind: "validate", title: "Audit new home page", detail: "deployed · vs baseline", status: "wait" },
    { cat: "SITE", kind: "validate", title: "Audit new site", detail: "rolled out · vs baseline", status: "wait" },
  ],
};

const mark = (s: string) =>
  s === "done" ? `<span class="ok">✓</span>` : s === "run" ? `<span class="spin"></span>` : `<span class="qd">○</span>`;

const row = (r: Row) =>
  `<div class="task t-${r.kind} ${r.status}">
    <span class="ti">${taskIcons[r.kind] ?? ""}</span>
    <div class="tx"><div class="tl"><span class="cat">${esc(r.cat)}</span> ${esc(r.title)}</div><div class="td">${esc(r.detail)}</div></div>
    <span class="st">${mark(r.status)}</span>
  </div>`;

function cols(s: RunState): Col[] {
  const upliftRows: Row[] = s.tasks.map((t) => ({ cat: t.cat, kind: t.kind, title: t.title, detail: t.detail, status: t.status }));
  const upliftDone = s.tasks.length > 0 && s.tasks.every((t) => t.status === "done");
  const host = s.url ? s.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "the homepage";
  // Prototype column reflects real page prototypes once the phase is entered.
  const protoRows: Row[] = s.templates.length
    ? s.templates.map((t) => ({
        cat: t.status === "done" ? "DONE" : t.status === "failed" ? "FAILED" : "BUILD",
        kind: "generate",
        title: t.title,
        detail: `variant ${t.variant}`,
        status: t.status === "done" ? "done" : t.status === "failed" ? "wait" : "run",
      }))
    : FUTURE.prototype;
  const protoActive = s.templates.length > 0 || !!s.protoVariant;
  const protoDone = s.templates.length > 0 && s.templates.every((t) => t.status === "done");
  const protoStatus: Col["status"] = protoDone ? "done" : protoActive ? "active" : "future";
  const protoSub = s.protoVariant ? `in variant ${s.protoVariant}` : "other pages";
  return [
    { id: "uplift", label: "Uplift", sub: host, status: upliftDone ? "done" : "active", rows: upliftRows },
    { id: "prototype", label: "Prototype", sub: protoSub, status: protoStatus, rows: protoRows },
    { id: "deploy", label: "Deploy", sub: "to AEM", status: "future", rows: FUTURE.deploy },
    { id: "rollout", label: "Rollout", sub: "the whole site", status: "future", rows: FUTURE.rollout },
    { id: "audit", label: "Audit", sub: "score the result", status: "future", rows: FUTURE.audit },
  ];
}

const badge = (c: Col) =>
  c.status === "done" ? `<span class="bbadge done">done</span>`
  : c.status === "active" ? `<span class="bbadge run">in progress</span>`
  : `<span class="bbadge">soon</span>`;

const col = (c: Col) =>
  `<div class="bcol ${c.status}">
    <div class="bhead">
      <div class="bhx"><div class="btitle">${esc(c.label)}</div><div class="bsub">${esc(c.sub)}</div></div>
      ${badge(c)}
    </div>
    <div class="brows">${c.rows.map(row).join("") || `<div class="bempty">—</div>`}</div>
  </div>`;

export function board(s: RunState): string {
  return `<div class="board">${cols(s).map(col).join("")}</div>`;
}
