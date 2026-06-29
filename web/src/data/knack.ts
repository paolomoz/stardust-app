/* ===========================================================================
   Canned knack content — mirrors the prototype screens. In M1 this is the
   payload the mock driver streams; it doubles as the offline demo seed.
   Asset paths resolve against publicDir (../prototypes) in dev.
   =========================================================================== */
import type { TaskItem, VariantCard } from "../state";

export const KNACK_URL = "https://www.knack.com/";
export const KNACK_PROJECT = "knack.com";
export const KNACK_SEED = "a3f7c9";
export const KNACK_SEED_NOTE = "md5(knack·06-25)";
export const KNACK_PALETTE = ["#982a86", "#ff349a", "#fa816e", "#1a181d"];

export const BRAND_REVIEW_URL = "/assets/knack-review/brand-review.html";

export const RECENTS = ["knack.com", "theroadhome.org", "beermaker.co"];

/** Working-stage task stream (initial states; the driver ticks them forward). */
export function knackTasks(): TaskItem[] {
  return [
    { id: "crawl", cat: "CRAWL", kind: "crawl", title: "Discovered pages", detail: "sitemap · 24 pages found", status: "wait" },
    { id: "read", cat: "READ", kind: "read", title: "Rendered home + 5 pages", detail: "/ · /pricing · /platform · /security", status: "wait" },
    { id: "extract", cat: "EXTRACT", kind: "extract", title: "Extracting brand surface", detail: "palette · type · logo · motifs", status: "wait" },
    { id: "analyze", cat: "ANALYZE", kind: "analyze", title: "Scanning for tensions", detail: "CTAs · type scale · contrast", status: "wait" },
    { id: "generate", cat: "GENERATE", kind: "generate", title: "Composing 3 directions", detail: "A faithful · B magenta · C cinematic", status: "wait" },
    { id: "validate", cat: "VALIDATE", kind: "validate", title: "Checking each render", detail: "a11y · responsive · fonts", status: "wait" },
  ];
}

export const STATUS_TICKER = [
  "extracting the palette…",
  "measuring the type scale…",
  "mapping the page structure…",
  "finding tensions…",
  "composing 3 directions…",
  "applying the fixes…",
  "validating renders…",
];

export const KNACK_TENSIONS = [
  { n: "01", text: "21 CTA labels — no single canonical action." },
  { n: "02", text: "Flat type scale (48→44→40→32) — weak hierarchy." },
  { n: "03", text: "Magenta ≈ 0.9% of painted pixels." },
];

export const KNACK_SHARED_FIXES = [
  "one canonical CTA",
  "real modular type scale",
  "promoted “build it” switcher",
  "sharper comparison block",
  "two-step shadow / depth ladder",
];

export const KNACK_VARIANTS: VariantCard[] = [
  {
    id: "A",
    title: "Faithful + fixes",
    pitch: "Your site tomorrow — same IA, the obvious fixes. The risk-averse green-light.",
    thumb: "/assets/knack/assets/thumb-A.png",
    src: "/assets/knack/home-A-proposed.html",
    segLabel: "A · faithful",
    segWord: "faithful",
    role: "static · green-light pick",
    faithful: "no new bet · the 5 fixes, nothing else moves",
    movesLabel: "composition",
    moves: ["same section order, white ground", "dual hero CTA collapsed to one"],
  },
  {
    id: "B",
    title: "Amplify the magenta",
    pitch: "The brand's most ownable color, foregrounded — from 0.9% of pixels to the whole canvas.",
    thumb: "/assets/knack/assets/thumb-B.png",
    src: "/assets/knack/home-B-proposed.html",
    segLabel: "B · magenta",
    segWord: "magenta",
    role: "static · brand exploration",
    whatif: "“magenta & the magenta→coral gradient owned the page, not a thin accent on white?”",
    movesLabel: "moves",
    moves: ["full-bleed gradient hero, reversed-out", "dark-magenta capability bands", "comparison as a high-contrast panel"],
  },
  {
    id: "C",
    title: "Motion as identity",
    pitch: "The homepage becomes a working Knack app — live-systems register.",
    thumb: "/assets/knack/assets/thumb-C.png",
    src: "/assets/knack/home-C-cinematic.html",
    segLabel: "C · cinematic",
    segWord: "cinematic",
    role: "cinematic · visionary pick",
    recommended: true,
    whatif: "“the homepage was a working app — data populating, a workflow firing, ROI counting up — not a picture of one?”",
    movesLabel: "motion",
    moves: ["hero “app building itself” on scroll", "ROI stats count up · bars fill", "live pulse dots · refresh-sweep"],
  },
];
