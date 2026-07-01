/* ===========================================================================
   Page discovery — LLM-free. Derive candidate pages for the prototype phase
   from the captured inventory's internal links: same-host, deduped by path,
   home/anchors/mailto dropped, capped. Pure + testable (see test/pages.test.mjs).
   =========================================================================== */
import { readdirSync, readFileSync } from "node:fs";

const titleize = (s) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** @returns {{slug:string,title:string,url:string}[]} up to `cap` candidates. */
const hostKey = (h) => h.replace(/^www\./i, "").toLowerCase();

export function derivePages(dir, homeUrl, cap = 12) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  let host = "";
  let homePath = "/";
  try { const u = new URL(homeUrl); host = hostKey(u.host); homePath = u.pathname.replace(/\/+$/, "") || "/"; } catch { /* */ }
  const seenPath = new Set();
  const seenSlug = new Set();
  const out = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); } catch { continue; }
    const linkBase = j.finalUrl || j.url || homeUrl;
    // Fall back to the page's own host when homeUrl didn't parse (or www differs).
    if (!host) { try { host = hostKey(new URL(linkBase).host); } catch { /* */ } }
    for (const l of j?.links?.internal ?? []) {
      const href = typeof l === "string" ? l : l?.href;
      const text = typeof l === "string" ? "" : (l?.text || "");
      if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
      let u;
      try { u = new URL(href, linkBase); } catch { continue; }
      if (host && hostKey(u.host) !== host) continue;
      const path = u.pathname.replace(/\/+$/, "") || "/";
      if (path === "/" || path === homePath || seenPath.has(path)) continue;
      seenPath.add(path);
      const seg = path.split("/").filter(Boolean).pop() || "";
      let slug = seg.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || `page-${out.length + 1}`;
      while (seenSlug.has(slug)) slug = `${slug}-${out.length + 1}`;
      seenSlug.add(slug);
      const title = text && text.trim().length > 1 && text.trim().length <= 40 ? text.trim() : (titleize(seg) || slug);
      out.push({ slug, title, url: u.href.replace(/#.*$/, "") });
      if (out.length >= cap) break;
    }
    if (out.length >= cap) break;
  }
  return out;
}
