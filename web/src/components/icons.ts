/* Inline SVG icon strings — lifted from the prototype markup. */

export const starHeader = `<svg class="star" viewBox="0 0 24 24" aria-hidden="true"><g fill="#e8b95e"><rect x="10" y="2" width="4" height="4"/><rect x="10" y="6" width="4" height="4" opacity=".6"/><rect x="10" y="18" width="4" height="4"/><rect x="10" y="14" width="4" height="4" opacity=".6"/><rect x="2" y="10" width="4" height="4"/><rect x="6" y="10" width="4" height="4" opacity=".6"/><rect x="18" y="10" width="4" height="4"/><rect x="14" y="10" width="4" height="4" opacity=".6"/></g><rect x="9" y="9" width="6" height="6" fill="#ffd98a"/></svg>`;

export const starHero = `<svg class="star" viewBox="0 0 24 24" aria-hidden="true"><g fill="#e8b95e"><rect x="10" y="1" width="4" height="4"/><rect x="10" y="5.5" width="4" height="4" opacity=".6"/><rect x="10" y="19" width="4" height="4"/><rect x="10" y="14.5" width="4" height="4" opacity=".6"/><rect x="1" y="10" width="4" height="4"/><rect x="5.5" y="10" width="4" height="4" opacity=".6"/><rect x="19" y="10" width="4" height="4"/><rect x="14.5" y="10" width="4" height="4" opacity=".6"/></g><rect x="8.5" y="8.5" width="7" height="7" fill="#ffd98a"/></svg>`;

export const bigStar = `<svg class="bigstar" viewBox="0 0 24 24" aria-hidden="true"><g fill="#e8b95e"><rect x="10" y="1" width="4" height="4"/><rect x="10" y="5.5" width="4" height="4" opacity=".55"/><rect x="10" y="19" width="4" height="4"/><rect x="10" y="14.5" width="4" height="4" opacity=".55"/><rect x="1" y="10" width="4" height="4"/><rect x="5.5" y="10" width="4" height="4" opacity=".55"/><rect x="19" y="10" width="4" height="4"/><rect x="14.5" y="10" width="4" height="4" opacity=".55"/></g><rect x="8.5" y="8.5" width="7" height="7" fill="#ffd98a"/></svg>`;

export const globe = `<svg class="globe" width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 9h14M9 2c2 2.4 2 11.6 0 14M9 2c-2 2.4-2 11.6 0 14" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>`;

export const sendArrow = `<svg width="15" height="15" viewBox="0 0 16 16"><path d="M2 8h10M8 4l4 4-4 4" fill="none" stroke="#0a1024" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const stopSquare = `<svg width="15" height="15" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="#0a1024"/></svg>`;
export const sendArrowLg = `<svg width="17" height="17" viewBox="0 0 16 16"><path d="M2 8h10M8 4l4 4-4 4" fill="none" stroke="#0a1024" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const openTab = `<svg width="13" height="13" viewBox="0 0 16 16"><path d="M6 3H3.5v9.5H13V10M9.5 3H13v3.5M13 3L7.5 8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const search = `<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;

export const deskIcon = `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 14h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
export const mobIcon = `<svg width="16" height="16" viewBox="0 0 16 16"><rect x="4.5" y="1.5" width="7" height="13" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M7 12.5h2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;

export const taskIcons: Record<string, string> = {
  crawl: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
  read: `<svg viewBox="0 0 16 16"><rect x="3" y="2" width="10" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,
  extract: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="5.4" r="1.1" fill="currentColor"/><circle cx="5.6" cy="9" r="1.1" fill="currentColor"/><circle cx="10.4" cy="9" r="1.1" fill="currentColor"/></svg>`,
  analyze: `<svg viewBox="0 0 16 16"><path d="M3 3h4M3 3v4M13 13h-4M13 13v-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  generate: `<svg viewBox="0 0 16 16"><g fill="currentColor"><rect x="7" y="1" width="2" height="2"/><rect x="7" y="13" width="2" height="2"/><rect x="1" y="7" width="2" height="2"/><rect x="13" y="7" width="2" height="2"/></g><rect x="6" y="6" width="4" height="4" fill="currentColor"/></svg>`,
  validate: `<svg viewBox="0 0 16 16"><path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 8l1.6 1.6L10.5 6.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
