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
import { beginRun, navTo, openVariant, selectVariant, sendMessage, resetRun, reopenRun } from "./driver/liveDriver";

// Dev affordance: /?mode=agent runs a real Managed Agents session;
// /?mode=probe runs a cheap skill-load probe (reads SKILL.md, no rendering).
// /?mode=uplift = real run via Managed Agents; /?mode=cerebras = real run via the
// open-loop runtime (Gemma 4 on Cerebras).
const _mode = new URLSearchParams(location.search).get("mode");
const runMode =
  _mode === "cerebras" ? "cerebras"
  : _mode === "bedrock" ? "bedrock"
  : _mode === "uplift" ? "uplift"
  : _mode === "agent" ? "agent"
  : _mode === "probe" ? "probe"
  : "scripted";

const app: App = {
  start: (url) => void beginRun(url, runMode),
  goSnapshot: () => navTo("brand"),
  goVariants: () => navTo("variants"),
  openVariant: (id) => openVariant(id),
  goto: (screen) => navTo(screen),
  restart: () => resetRun(),
  setVariant: (id: VariantId) => {
    store.set({ activeVariant: id });
    selectVariant(id);
  },
  setViewport: (v) => store.set({ viewport: v }),
  send: (screen: ScreenId, text) => sendMessage(screen, text),
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

// /?run=<id> — reopen a finished run (replays its saved timeline; no new run).
const reopenId = new URLSearchParams(location.search).get("run");
if (reopenId) reopenRun(reopenId);
