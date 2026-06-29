/* The action surface screens call. Implemented in main.ts; kept separate to
   avoid a circular import between screens and the entry point. */
import type { RunState, ScreenId, VariantId } from "./state";

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
  /** Reset everything to the landing screen. */
  restart(): void;
  /** Workspace: switch the active variant (hot-swaps the iframe). */
  setVariant(id: VariantId): void;
  /** Workspace: desktop/mobile preview. */
  setViewport(v: "desktop" | "mobile"): void;
  /** Composer submit on a given screen. */
  send(screen: ScreenId, text: string): void;
}
