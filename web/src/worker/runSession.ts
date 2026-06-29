/* ===========================================================================
   RunSession Durable Object — one per run, the run's source of truth. Accepts
   WebSocket connections, scripts the knack uplift run (M2: timed events; M5: the
   same events derived from the agent), persists the timeline to D1, and
   re-emits any screen's payload on a client nav command.
   =========================================================================== */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import type { Message, RailState, ScreenId, VariantCard, VariantId } from "../state";
import type { ClientCommand, ServerEvent } from "../shared/protocol";
import { createSession, sendUserMessage, streamEvents, type MaCreds } from "./managedAgents";
import {
  KNACK_PALETTE,
  KNACK_PROJECT,
  KNACK_SEED,
  KNACK_SHARED_FIXES,
  KNACK_TENSIONS,
  STATUS_TICKER,
  VARIANT_META,
  knackTasks,
} from "../shared/knack-content";

// Demo artifacts are seeded into R2 under this fixed prefix (see scripts/seed-r2.sh),
// independent of the random per-run id.
const ART = "/api/artifacts/knack-demo";
// brand-review lives under review/ (its own assets/) to avoid colliding with the
// variants' assets/ when merged into one R2 prefix. See scripts/seed-r2.sh.
const brandReviewUrl = `${ART}/review/brand-review.html`;
const variants: VariantCard[] = VARIANT_META.map((m) => ({
  ...m,
  src: `${ART}/${m.file}`,
  thumb: `${ART}/assets/${m.thumbFile}`,
}));

function deriveProject(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return KNACK_PROJECT;
  }
}

export class RunSession extends DurableObject<Env> {
  private sockets = new Set<WebSocket>();
  private events: ServerEvent[] = [];
  private seq = 0;
  private started = false;
  private runId = "";
  private project = KNACK_PROJECT;
  private timers: number[] = [];
  private ticker?: number;

  async fetch(request: Request): Promise<Response> {
    const runId = new URL(request.url).pathname.match(/^\/api\/runs\/([^/]+)\/ws$/)?.[1] ?? "";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);

    // Catch up a (re)connecting client with everything emitted so far.
    for (const ev of this.events) server.send(JSON.stringify(ev));

    server.addEventListener("message", (e) => {
      try {
        const cmd = JSON.parse(typeof e.data === "string" ? e.data : "") as ClientCommand;
        void this.onCommand(cmd);
      } catch {
        /* ignore malformed */
      }
    });
    const drop = () => this.sockets.delete(server);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    if (!this.started) {
      this.started = true;
      void this.start(runId);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---- event plumbing ---- */

  private async emit(ev: ServerEvent): Promise<void> {
    this.events.push(ev);
    const payload = JSON.stringify(ev);
    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
    await this.env.DB.prepare("INSERT INTO run_events (run_id, seq, payload, ts) VALUES (?, ?, ?, ?)")
      .bind(this.runId, this.seq++, payload, Date.now())
      .run();
  }

  private schedule(ms: number, fn: () => Promise<void> | void): void {
    this.timers.push(setTimeout(() => void fn(), ms) as unknown as number);
  }

  private clearTimers(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /* ---- the scripted run ---- */

  private async start(runId: string): Promise<void> {
    this.runId = runId;
    const row = await this.env.DB.prepare("SELECT url, mode FROM runs WHERE id = ?")
      .bind(runId)
      .first<{ url: string; mode: string }>();
    const url = row?.url ?? "https://www.knack.com/";
    this.project = deriveProject(url);
    await this.env.DB.prepare("UPDATE runs SET status = 'running', project = ? WHERE id = ?")
      .bind(this.project, runId)
      .run();

    if (row?.mode === "agent") return this.runAgent(url);
    return this.runScripted(url, runId);
  }

  /* ---- M2 scripted demo run ---- */

  private async runScripted(url: string, runId: string): Promise<void> {
    const tasks = knackTasks();
    tasks[0].status = "run";
    // Content first, screen last — so the screen mounts with its data present.
    await this.emit({ t: "run.started", runId, url, projectName: this.project, seed: KNACK_SEED });
    await this.emit({ t: "phase", phase: "prototype" });
    await this.emit({ t: "tasks.init", tasks });
    await this.emit({ t: "progress", value: 8 });
    await this.emit({ t: "status", text: STATUS_TICKER[0] });
    await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock: "⏱ ~ a few minutes · reading the site" } });
    await this.emit({ t: "screen", screen: "working" });

    let i = 0;
    this.ticker = setInterval(() => {
      i = (i + 1) % STATUS_TICKER.length;
      void this.emit({ t: "status", text: STATUS_TICKER[i] });
    }, 820) as unknown as number;

    const step = async (doneId: string, runId2: string | null, progress: number) => {
      await this.emit({ t: "task", id: doneId, status: "done" });
      if (runId2) await this.emit({ t: "task", id: runId2, status: "run" });
      await this.emit({ t: "progress", value: progress });
    };

    this.schedule(900, () => step("crawl", "read", 22));
    this.schedule(1700, () => step("read", "extract", 40));
    this.schedule(2800, () => step("extract", "analyze", 58));
    this.schedule(3800, () => step("analyze", "generate", 74));
    this.schedule(4900, () => step("generate", "validate", 90));
    this.schedule(6000, async () => {
      await this.emit({ t: "task", id: "validate", status: "done" });
      await this.emit({ t: "progress", value: 100 });
      await this.emit({ t: "snapshot.ready" });
    });
    this.schedule(6800, () => this.toBrand());
  }

  /* ---- M3+ real run: a Managed Agents session, streamed to the UI ---- */

  private async runAgent(url: string): Promise<void> {
    const { ANTHROPIC_API_KEY, STARDUST_AGENT_ID, STARDUST_ENVIRONMENT_ID } = this.env;
    await this.emit({ t: "run.started", runId: this.runId, url, projectName: this.project, seed: KNACK_SEED });
    await this.emit({ t: "phase", phase: "prototype" });
    await this.emit({ t: "tasks.init", tasks: [] });
    await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock: "⏱ agent session · live" } });
    await this.emit({ t: "screen", screen: "working" });

    if (!ANTHROPIC_API_KEY || !STARDUST_AGENT_ID || !STARDUST_ENVIRONMENT_ID) {
      await this.emit({
        t: "message.append",
        message: { id: "no-creds", role: "agent", lead: "Managed Agents not configured. Run agent/setup.mjs and restart dev (see agent/README.md)." },
      });
      await this.fail("missing Managed Agents credentials");
      return;
    }
    const creds: MaCreds = { apiKey: ANTHROPIC_API_KEY, agentId: STARDUST_AGENT_ID, environmentId: STARDUST_ENVIRONMENT_ID };

    // M3 connectivity check — proves session + tools + SSE relay without skills.
    // M5 swaps this for: `Redesign ${url}. Run stardust:uplift <URL> to completion…`
    const prompt =
      "Connectivity check from the stardust web app. In one short sentence, confirm you're running. " +
      "Then create the file /mnt/session/outputs/hello.txt containing 'stardust online' and stop.";

    try {
      const sessionId = await createSession(creds, `stardust · ${this.project}`, { url });
      await this.emit({ t: "message.append", message: { id: "sess", role: "agent", lead: `Session started — <b>${sessionId.slice(0, 8)}</b>. Working…` } });
      await sendUserMessage(creds, sessionId, prompt);

      for await (const ev of streamEvents(creds, sessionId)) {
        if (ev.type === "agent.message") {
          const content = (ev as { content?: { text?: string }[] }).content ?? [];
          const text = content.map((b) => b.text ?? "").join("").trim();
          if (text) await this.emit({ t: "message.append", message: { id: `m-${this.seq}`, role: "agent", lead: text } });
        } else if (ev.type === "agent.tool_use") {
          const name = (ev as { name?: string }).name ?? "tool";
          await this.emit({ t: "message.append", message: { id: `t-${this.seq}`, role: "agent", lead: `› tool: <b>${name}</b>` } });
        } else if (ev.type === "session.status_idle") {
          await this.emit({ t: "message.append", message: { id: "fin", role: "agent", lead: "✓ Agent finished." } });
          await this.emit({ t: "rail", rail: { swatches: KNACK_PALETTE, note: "session idle", clock: "⏱ done" } });
          await this.emit({ t: "run.done" });
          await this.env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(this.runId).run();
          break;
        } else if (ev.type === "session.error") {
          await this.fail(`session error: ${JSON.stringify((ev as { error?: unknown }).error ?? ev)}`);
          break;
        }
      }
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: "err", role: "agent", lead: `Run error: ${String((e as Error).message ?? e)}` } });
      await this.fail(String(e));
    }
  }

  private async fail(reason: string): Promise<void> {
    await this.emit({ t: "error", message: reason });
    await this.emit({ t: "run.done" });
    await this.env.DB.prepare("UPDATE runs SET status = 'error' WHERE id = ?").bind(this.runId).run();
  }

  private async toBrand(): Promise<void> {
    this.clearTimers();
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
      { id: "brand-tensions", role: "agent", plan: { tag: "3 tensions", steps: KNACK_TENSIONS } },
    ];
    await this.emit({ t: "messages", messages });
    await this.emit({ t: "panel.brand", brandReviewUrl, tensions: KNACK_TENSIONS });
    await this.emit({ t: "rail", rail: rail({ note: "brand surface captured", tensions: 5, clock: "⏱ 7 pages · captured" }) });
    await this.emit({ t: "screen", screen: "brand" });
  }

  private async toVariants(): Promise<void> {
    this.clearTimers();
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
    await this.emit({ t: "messages", messages });
    await this.emit({ t: "panel.variants", sharedFixes: KNACK_SHARED_FIXES, variants });
    await this.emit({ t: "rail", rail: rail({ signature: "watch it build", tensions: 5, clock: "⏱ 3 directions ready" }) });
    await this.emit({ t: "screen", screen: "variants" });
  }

  private async toWorkspace(id: VariantId): Promise<void> {
    this.clearTimers();
    const card = variants.find((v) => v.id === id) ?? variants[2];
    const messages: Message[] = [
      {
        id: "ws-lead",
        role: "agent",
        lead: `Variant <b>${id}</b> — ${card.title.toLowerCase()}. Switch variants in the toolbar, or tell me a change.`,
        body: ["When it's right, hit Deploy."],
      },
    ];
    await this.emit({ t: "panel.workspace", activeVariant: id, variants });
    await this.emit({ t: "messages", messages });
    await this.emit({ t: "rail", rail: rail({ signature: "watch it build", variant: card.segLabel, clock: "⏱ ready to iterate" }) });
    await this.emit({ t: "screen", screen: "workspace" });
    await this.env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(this.runId).run();
  }

  private async onCommand(cmd: ClientCommand): Promise<void> {
    if (cmd.t === "nav") {
      if (cmd.to === "brand") return this.toBrand();
      if (cmd.to === "variants") return this.toVariants();
      if (cmd.to === "working") return void this.emit({ t: "screen", screen: "working" });
      return;
    }
    if (cmd.t === "open") return this.toWorkspace(cmd.variant);
    if (cmd.t === "send") return this.onSend(cmd.screen, cmd.text);
  }

  private async onSend(screen: ScreenId, text: string): Promise<void> {
    await this.emit({ t: "message.append", message: { id: `u-${this.seq}`, role: "user", text } });
    if (screen === "workspace") {
      this.schedule(650, () =>
        this.emit({
          t: "message.append",
          message: {
            id: `a-${this.seq}`,
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
        }),
      );
    } else {
      this.schedule(550, () =>
        this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "On it — folding that into the work." } }),
      );
    }
  }
}

/** Build a rail state with the shared knack palette. */
function rail(partial: Omit<RailState, "swatches">): RailState {
  return { swatches: KNACK_PALETTE, ...partial };
}
