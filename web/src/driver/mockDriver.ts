/* ===========================================================================
   Mock run driver — the stand-in for the M2+ Worker WebSocket. It streams a
   knack uplift run into the store with realistic timing so the whole flow can
   be exercised end-to-end with no backend. Same store shape the live transport
   will feed later.
   =========================================================================== */
import { store } from "../state";
import type { Message, VariantId } from "../state";
import { reduceMotion } from "../dom";
import {
  KNACK_PROJECT,
  KNACK_SEED,
  KNACK_PALETTE,
  KNACK_TENSIONS,
  KNACK_SHARED_FIXES,
  KNACK_VARIANTS,
  BRAND_REVIEW_URL,
  STATUS_TICKER,
  knackTasks,
} from "../data/knack";

let timers: number[] = [];
let ticker: number | undefined;
let advanced = false;

function clearTimers(): void {
  timers.forEach((t) => clearTimeout(t));
  timers = [];
  if (ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

function at(ms: number, fn: () => void): void {
  const scale = reduceMotion() ? 0.35 : 1;
  timers.push(window.setTimeout(fn, ms * scale));
}

function projectFromUrl(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return KNACK_PROJECT;
  }
}

/** Landing → working; tick the task stream, then mark the snapshot ready. */
export function beginRun(url: string): void {
  clearTimers();
  advanced = false;
  const project = projectFromUrl(url);
  store.update((s) => {
    s.url = url;
    s.projectName = project;
    s.seed = KNACK_SEED;
    s.screen = "working";
    s.phase = "prototype";
    s.tasks = knackTasks();
    s.tasks[0].status = "run";
    s.progress = 8;
    s.statusTicker = STATUS_TICKER[0];
    s.snapshotReady = false;
    s.messages = [];
    s.rail = { swatches: [], busy: true, clock: "⏱ ~ a few minutes · click to continue" };
  });

  // status ticker
  let i = 0;
  ticker = window.setInterval(() => {
    i = (i + 1) % STATUS_TICKER.length;
    store.update((s) => {
      s.statusTicker = STATUS_TICKER[i];
    });
  }, 820);

  const tick = (doneId: string, runId: string | null, progress: number) =>
    store.update((s) => {
      const d = s.tasks.find((t) => t.id === doneId);
      if (d) d.status = "done";
      if (runId) {
        const r = s.tasks.find((t) => t.id === runId);
        if (r) r.status = "run";
      }
      s.progress = progress;
    });

  at(800, () => tick("crawl", "read", 22));
  at(1600, () => tick("read", "extract", 40));
  at(2700, () => tick("extract", "analyze", 58));
  at(3700, () => tick("analyze", "generate", 74));
  at(4800, () => tick("generate", "validate", 90));
  at(5900, () => {
    tick("validate", null, 100);
    store.update((s) => {
      s.snapshotReady = true;
    });
  });
  // auto-advance to the snapshot, unless the user already moved on
  at(6700, () => {
    if (!advanced && store.get().screen === "working") toBrand();
  });
}

export function toBrand(): void {
  advanced = true;
  clearTimers();
  const project = store.get().projectName;
  const messages: Message[] = [
    {
      id: "brand-lead",
      role: "agent",
      lead: "Here's your brand surface, captured from a live render.",
      body: [
        "Magenta leads the palette but barely shows on screen, the type scale is flat, and there are 21 different CTA labels. A solid product, under-showing itself.",
        "Open the full <b>audit</b> for the scorecard and findings, or move on to directions.",
      ],
      seed: KNACK_SEED,
    },
    {
      id: "brand-tensions",
      role: "agent",
      plan: { tag: "3 tensions", steps: KNACK_TENSIONS },
    },
  ];
  store.update((s) => {
    s.screen = "brand";
    s.brandReviewUrl = BRAND_REVIEW_URL;
    s.tensions = KNACK_TENSIONS;
    s.messages = messages;
    s.rail = {
      swatches: KNACK_PALETTE,
      note: "brand surface captured",
      tensions: 5,
      clock: `⏱ 7 pages · captured`,
    };
    void project;
  });
}

export function toVariants(): void {
  clearTimers();
  const messages: Message[] = [
    {
      id: "var-lead",
      role: "agent",
      lead: "Three directions, all brand-faithful — palette and Inter kept, the 5 tensions fixed in each.",
      body: [
        "They differ in their <b>bet</b>: A plays it safe, B amplifies the magenta, C makes motion the identity. My pick is <b>C</b>.",
        "Each card shows what's fixed and the “what if” behind it. Open any to iterate.",
      ],
      seed: KNACK_SEED,
    },
  ];
  store.update((s) => {
    s.screen = "variants";
    s.sharedFixes = KNACK_SHARED_FIXES;
    s.variants = KNACK_VARIANTS;
    s.messages = messages;
    s.rail = {
      swatches: KNACK_PALETTE,
      signature: "watch it build",
      tensions: 5,
      clock: "⏱ 3 directions ready",
    };
  });
}

export function toWorkspace(id: VariantId): void {
  clearTimers();
  const card = KNACK_VARIANTS.find((v) => v.id === id) ?? KNACK_VARIANTS[2];
  const messages: Message[] = [
    {
      id: "ws-lead",
      role: "agent",
      lead: `Variant <b>${id}</b> — ${card.title.toLowerCase()}. Switch variants in the toolbar, or tell me a change.`,
      body: ["When it's right, hit Deploy."],
    },
  ];
  store.update((s) => {
    if (s.variants.length === 0) s.variants = KNACK_VARIANTS;
    s.screen = "workspace";
    s.activeVariant = id;
    s.viewport = "desktop";
    s.messages = messages;
    s.rail = {
      swatches: KNACK_PALETTE,
      signature: "watch it build",
      variant: card.segLabel,
      clock: "⏱ ready to iterate",
    };
  });
}

/** Composer replies — mock acknowledgement so the conversation feels live. */
export function composerReply(screen: string, text: string): void {
  store.update((s) => {
    s.messages = [...s.messages, { id: `u-${Date.now()}`, role: "user", text }];
  });
  if (screen === "workspace") {
    at(650, () =>
      store.update((s) => {
        s.messages = [
          ...s.messages,
          {
            id: `a-${Date.now()}`,
            role: "agent",
            plan: {
              tag: "plan",
              steps: [
                { n: "01", text: "Map the request to the prototype and re-render." },
                { n: "02", text: "Keep the palette and one canonical CTA." },
              ],
              status: "Applied · re-rendered",
              acts: ["Undo", "Keep"],
            },
            seed: KNACK_SEED,
          },
        ];
      }),
    );
  } else {
    at(550, () =>
      store.update((s) => {
        s.messages = [
          ...s.messages,
          { id: `a-${Date.now()}`, role: "agent", lead: "On it — folding that into the work." },
        ];
      }),
    );
  }
}

export function resetRun(): void {
  clearTimers();
  store.reset();
}
