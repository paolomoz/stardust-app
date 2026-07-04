/* Test derivePages against captured inventories — both link shapes: the
   ≤0.11 object shape (links.internal[{href,text}]) and the 0.14.x flat shape
   (links: [url, …]). Run:
     node runtime/test/pages.test.mjs [pagesDir] [homeUrl]                    */
import { readdirSync, readFileSync } from "node:fs";
import { derivePages } from "../pages.mjs";

const hostKey = (h) => h.replace(/^www\./i, "").toLowerCase();

function check(dir, homeUrl) {
  if (!homeUrl) {
    try { const f = readdirSync(dir).find((x) => x.endsWith(".json")); homeUrl = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).finalUrl; } catch { /* */ }
  }
  const pages = derivePages(dir, homeUrl);
  console.log(`derivePages(${dir}, ${homeUrl}) → ${pages.length} candidates:`);
  for (const p of pages) console.log(`  ${p.slug.padEnd(20)} ${JSON.stringify(p.title).padEnd(30)} ${p.url}`);

  let ok = true;
  const fail = (m) => { ok = false; console.error("  ✗ " + m); };
  const host = hostKey(new URL(homeUrl).host);
  const slugs = new Set();
  for (const p of pages) {
    if (!p.slug || !p.title || !p.url) fail(`incomplete candidate: ${JSON.stringify(p)}`);
    if (slugs.has(p.slug)) fail(`duplicate slug: ${p.slug}`);
    slugs.add(p.slug);
    if (hostKey(new URL(p.url).host) !== host) fail(`off-host url: ${p.url}`);
    if (p.url.includes("#")) fail(`url has anchor: ${p.url}`);
    if (/^(mailto|tel):/i.test(p.url)) fail(`non-http scheme: ${p.url}`);
    const path = new URL(p.url).pathname.replace(/\/+$/, "") || "/";
    if (path === "/") fail(`home leaked in: ${p.url}`);
  }
  if (pages.length > 12) fail(`over cap: ${pages.length}`);
  if (pages.length === 0) fail("no candidates derived (expected some for a real site)");
  return ok;
}

let ok;
if (process.argv[2]) {
  ok = check(process.argv[2], process.argv[3]);
} else {
  const objDir = new URL("./fixtures/pages", import.meta.url).pathname;
  const flatDir = new URL("./fixtures/pages-flat", import.meta.url).pathname;
  const a = check(objDir);
  const b = check(flatDir);
  ok = a && b;
}
console.log(ok ? "\n✓ pages.test PASSED" : "\n✗ pages.test FAILED");
process.exit(ok ? 0 : 1);
