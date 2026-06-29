/* Entry point — wires the store to the screens and implements the App controller
   by delegating to the mock driver (M1). In M2 the driver is swapped for the
   Worker WebSocket; screens and store stay unchanged. */
import "./styles/shell.css";
import "./styles/screens.css";
import { store } from "./state";
import type { RunState, ScreenId, VariantId } from "./state";
import type { App, Screen } from "./controller";
import { landing } from "./screens/landing";
import { working } from "./screens/working";
import { brand } from "./screens/brand";
import { variants } from "./screens/variants";
import { workspace } from "./screens/workspace";
import {
  beginRun,
  toBrand,
  toVariants,
  toWorkspace,
  composerReply,
  resetRun,
} from "./driver/mockDriver";

const app: App = {
  start: (url) => beginRun(url),
  goSnapshot: () => toBrand(),
  goVariants: () => toVariants(),
  openVariant: (id) => toWorkspace(id),
  goto: (screen) => {
    if (screen === "brand") toBrand();
    else if (screen === "variants") toVariants();
    else store.set({ screen });
  },
  restart: () => resetRun(),
  setVariant: (id: VariantId) => store.set({ activeVariant: id }),
  setViewport: (v) => store.set({ viewport: v }),
  send: (screen: ScreenId, text) => composerReply(screen, text),
};

const factories: Record<ScreenId, (s: RunState, a: App) => Screen | HTMLElement> = {
  landing,
  working,
  brand,
  variants,
  workspace,
};

const root = document.getElementById("root")!;
let mountedScreen: ScreenId | null = null;
let current: Screen | null = null;

function asScreen(r: Screen | HTMLElement): Screen {
  return r instanceof HTMLElement ? { el: r } : r;
}

function render(s: RunState): void {
  if (s.screen !== mountedScreen) {
    current = asScreen(factories[s.screen](s, app));
    root.replaceChildren(current.el);
    mountedScreen = s.screen;
    // (re)trigger fade/stagger reveals on the freshly mounted screen
    document.body.classList.remove("ready");
    requestAnimationFrame(() => document.body.classList.add("ready"));
  } else {
    current?.update?.(s);
  }
}

store.subscribe(render);
render(store.get());
