/* ===========================================================================
   Client-side knack data — semantic content from shared/knack-content.ts with
   client asset URLs (served from publicDir in dev). Used by the M1 offline mock
   driver. The live (M2+) path receives URLs from the DO instead.
   =========================================================================== */
import type { VariantCard } from "../state";
import { VARIANT_META } from "../shared/knack-content";

export {
  KNACK_PROJECT,
  KNACK_SEED,
  KNACK_SEED_NOTE,
  KNACK_PALETTE,
  RECENTS,
  STATUS_TICKER,
  KNACK_TENSIONS,
  KNACK_SHARED_FIXES,
  knackTasks,
} from "../shared/knack-content";

export const KNACK_URL = "https://www.knack.com/";
export const BRAND_REVIEW_URL = "/assets/knack-review/brand-review.html";

export const KNACK_VARIANTS: VariantCard[] = VARIANT_META.map((m) => ({
  ...m,
  src: `/assets/knack/${m.file}`,
  thumb: `/assets/knack/assets/${m.thumbFile}`,
}));
