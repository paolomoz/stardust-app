/* The action surface screens call. Implemented in main.ts; kept separate to
   avoid a circular import between screens and the entry point. */
import type { ArtifactRef, RunState, ScreenId, VariantId } from "./state";

/** A mounted screen. `update` lets the screen patch itself in place on state
 *  changes (task stream ticking, iframe hot-swap) without a full re-render that
 *  would reload iframes or drop scroll/hover. */
export interface Screen {
  el: HTMLElement;
  update?: (s: RunState) => void;
}

export interface App {
  /** Begin a run for a URL (landing → working, kicks off the driver). */
  start(url: string): void;
  /** Working → brand review (snapshot ready). */
  goSnapshot(): void;
  /** Brand → variants. */
  goVariants(): void;
  /** Open a chosen variant in the workspace. */
  openVariant(id: VariantId): void;
  /** Jump directly to a screen (back buttons). */
  goto(screen: ScreenId): void;
  /** Client-side view navigation (header ladder / subheader tabs). Sets the
   *  screen instantly, locks it against DO screen events, and syncs the URL. */
  goView(screen: ScreenId): void;
  /** Enter the uplift phase from the header rung → its furthest-ready view. */
  goUplift(): void;
  /** Reset everything to the projects home (landing). */
  restart(): void;
  /** Switch to another project in-place (reopen its run, no full reload). */
  switchProject(id: string): void;
  /** Stop an in-flight run (Stop button on the working screen). */
  cancel(): void;
  /** Workspace: switch the active variant (hot-swaps the iframe). */
  setVariant(id: VariantId): void;
  /** Workspace: desktop/mobile preview. */
  setViewport(v: "desktop" | "mobile"): void;
  /** Composer submit on a given screen. */
  send(screen: ScreenId, text: string): void;
  /** Open an artifact card from the chat on the right (brand → brand screen,
   *  variant → workspace with that variant). */
  openArtifact(a: ArtifactRef): void;
  /** Enter the prototype phase (render other pages in the chosen direction). */
  goPrototype(): void;
  /** Directions: generate an additional variant from a free-text direction. */
  addVariant(instruction: string): void;
  /** Prototype phase: render the selected pages in the chosen direction. */
  prototypePages(slugs: string[]): void;
  /** Prototype phase: pin which variant's direction pages render in. */
  setProtoVariant(variant: VariantId): void;
  /** Prototype phase: show a prototyped page in the preview (client-only). */
  setProtoActive(slug: string): void;
  /** Enter the deploy/rollout phase (ship to AEM Edge Delivery). */
  goDeploy(): void;
  /** Deploy the given pages ("home" + template slugs) to the EDS preview. */
  deployPages(slugs: string[]): void;
  /** Publish the deployed pages to aem.live. */
  goLive(): void;
  /** Whole-site rollout: prototype every remaining page, then deploy it live. */
  rollout(): void;
  /** Enter the audit phase (score the original or the deployed site). */
  goAudit(): void;
  /** Run stardust:audit on the given target. */
  runAudit(target: "original" | "deployed"): void;
}
