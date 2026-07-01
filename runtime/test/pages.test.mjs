/* Test derivePages against a real captured inventory. Run:
     node runtime/test/pages.test.mjs [pagesDir] [homeUrl]                    */
import { readdirSync, readFileSync } from "node:fs";
import { derivePages } from "../pages.mjs";

const dir = process.argv[2] || new URL("./fixtures/pages", import.meta.url).pathname;
// Default the home URL to the fixture's own captured url (first page json).
let homeUrl = process.argv[3];
if (!homeUrl) {
  try { const f = readdirSync(dir).find((x) => x.endsWith(".json")); homeUrl = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")).finalUrl; } catch { /* */ }
}
const hostKey = (h) => h.replace(/^www\./i, "").toLowerCase();

const pages = derivePages(dir, homeUrl);
console.log(`derivePages(${dir}, ${homeUrl}) → ${pages.length} candidates:`);
for (const p of pages) console.log(`  ${p.slug.padEnd(20)} ${JSON.stringify(p.title).padEnd(30)} ${p.url}`);

// Assertions.
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
  const path = new URL(p.url).pathname.replace(/\/+$/, "") || "/";
  if (path === "/") fail(`home leaked in: ${p.url}`);
}
if (pages.length > 12) fail(`over cap: ${pages.length}`);
if (pages.length === 0) fail("no candidates derived (expected some for a real site)");
console.log(ok ? "\n✓ pages.test PASSED" : "\n✗ pages.test FAILED");
process.exit(ok ? 0 : 1);
