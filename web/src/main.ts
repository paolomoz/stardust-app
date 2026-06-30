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
import { createConversation } from "./components/conversation";
import { mountToasts } from "./components/toasts";
import { login } from "./screens/login";
import { fetchMe } from "./auth";
import type { ArtifactRef } from "./state";
import { beginRun, navTo, openVariant, selectVariant, cancelRun, sendMessage, resetRun, reopenRun } from "./driver/liveDriver";

// Default (no param) = a real Opus-on-Bedrock run. Opt into others by param:
//   ?mode=demo     — scripted offline demo (free, replays the knack sample)
//   ?mode=cerebras — open-loop runtime on Gemma 4 (Cerebras)
//   ?mode=uplift|agent|probe — Managed Agents paths (probe = cheap skill-load)
const _mode = new URLSearchParams(location.search).get("mode");
const runMode =
  _mode === "demo" || _mode === "scripted" ? "scripted"
  : _mode === "cerebras" ? "cerebras"
  : _mode === "uplift" ? "uplift"
  : _mode === "agent" ? "agent"
  : _mode === "probe" ? "probe"
  : "bedrock";

const app: App = {
  start: (url) => void beginRun(url, runMode),
  goSnapshot: () => navTo("brand"),
  goVariants: () => navTo("variants"),
  openVariant: (id) => openVariant(id),
  goto: (screen) => navTo(screen),
  restart: () => resetRun(),
  cancel: () => cancelRun(),
  setVariant: (id: VariantId) => {
    store.set({ activeVariant: id });
    selectVariant(id);
  },
  setViewport: (v) => store.set({ viewport: v }),
  send: (screen: ScreenId, text) => sendMessage(screen, text),
  openArtifact: (a: ArtifactRef) => {
    if (a.kind === "brand") navTo("brand");
    else if (a.variant) openVariant(a.variant);
  },
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

// One persistent conversation panel, re-parented into each in-app screen so the
// chat (content + scroll) is identical across working/brand/variants/workspace.
const conversation = createConversation(app);
mountToasts(app);

function asScreen(r: Screen | HTMLElement): Screen {
  return r instanceof HTMLElement ? { el: r } : r;
}

function render(s: RunState): void {
  if (s.screen !== mountedScreen) {
    const prevTop = conversation.scroller.scrollTop;
    current = asScreen(factories[s.screen](s, app));
    // Re-parent the persistent chat into the new screen's slot (if it has one).
    const slot = current.el.querySelector(".conv-mount");
    if (slot) slot.replaceWith(conversation.el);
    root.replaceChildren(current.el);
    if (slot) conversation.scroller.scrollTop = prevTop; // restore once re-attached
    mountedScreen = s.screen;
    // (re)trigger fade/stagger reveals on the freshly mounted screen
    document.body.classList.remove("ready");
    requestAnimationFrame(() => document.body.classList.add("ready"));
  } else {
    current?.update?.(s);
  }
}

// Gate the app behind sign-in: fetch the session, show the login screen if none.
async function boot(): Promise<void> {
  const user = await fetchMe();
  if (!user) {
    root.replaceChildren(login());
    document.body.classList.remove("ready");
    requestAnimationFrame(() => document.body.classList.add("ready"));
    return;
  }
  store.subscribe(render);
  store.subscribe((s) => conversation.update(s));
  render(store.get());
  // /?run=<id> — reopen a finished run (replays its saved timeline; no new run).
  const reopenId = new URLSearchParams(location.search).get("run");
  if (reopenId) reopenRun(reopenId);
}
void boot();
