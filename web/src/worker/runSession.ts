/* ===========================================================================
   RunSession Durable Object — one per run, the run's source of truth. Accepts
   WebSocket connections, scripts the knack uplift run (M2: timed events; M5: the
   same events derived from the agent), persists the timeline to D1, and
   re-emits any screen's payload on a client nav command.
   =========================================================================== */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import type { Message, RailState, ScreenId, TaskItem, VariantCard, VariantId } from "../state";
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

// Honest uplift step list (single-page render → 3 variants), driven live by the
// agent's milestones. Deliberately NOT the knack demo copy ("24 pages found").
const UPLIFT_TASKS: TaskItem[] = [
  { id: "crawl", cat: "CAPTURE", kind: "crawl", title: "Rendering the page", detail: "live capture", status: "wait" },
  { id: "read", cat: "READ", kind: "read", title: "Reading the brand", detail: "palette · type · logo", status: "wait" },
  { id: "extract", cat: "EXTRACT", kind: "extract", title: "Brand surface", detail: "tokens · motifs", status: "wait" },
  { id: "analyze", cat: "ANALYZE", kind: "analyze", title: "Finding tensions", detail: "CTAs · scale · contrast", status: "wait" },
  { id: "generate", cat: "DIRECT", kind: "generate", title: "Composing 3 directions", detail: "brand-faithful bets", status: "wait" },
  { id: "validate", cat: "VALIDATE", kind: "validate", title: "Validating renders", detail: "a11y · responsive · motion", status: "wait" },
];

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
  // M5: real uplift run state. When set, the panel emitters use real artifacts
  // (pushed by the sandbox agent via the ingest endpoints) instead of the knack
  // demo constants.
  private uplift = false;
  private finished = false;
  private tasks: TaskItem[] = [];
  private realTensions: { n: string; text: string }[] = [];
  private realBrand?: { brandReviewUrl: string; tensions: { n: string; text: string }[] };
  private realVariants?: { sharedFixes: string[]; variants: VariantCard[] };
  // M6: workspace iteration. activeVariant is the target a "tell me a change"
  // applies to; iterVersion cache-busts the iframe src on each re-render.
  private activeVariant?: VariantId;
  private iterVersion = 0;

  async fetch(request: Request): Promise<Response> {
    const runId = new URL(request.url).pathname.match(/^\/api\/runs\/([^/]+)\/ws$/)?.[1] ?? "";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);

    if (!this.started) {
      this.started = true;
      this.runId = runId;
      // Reopen of a finished run (/?run=<id>): the DO is cold, so rehydrate its
      // timeline + result from D1 and replay — do NOT start a new (paid) run.
      const persisted = await this.env.DB.prepare(
        "SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq",
      )
        .bind(runId)
        .all<{ payload: string }>();
      const rows = persisted.results ?? [];
      if (rows.length) {
        for (const r of rows) {
          try {
            this.events.push(JSON.parse(r.payload) as ServerEvent);
          } catch {
            /* skip malformed */
          }
        }
        await this.rehydrateResult(runId);
        for (const ev of this.events) server.send(JSON.stringify(ev));
      } else {
        void this.start(runId);
      }
    } else {
      // Reconnect to an active run: catch up with everything emitted so far.
      for (const ev of this.events) server.send(JSON.stringify(ev));
    }

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

    if (row?.mode === "cerebras") return this.runRuntime(url, "cerebras");
    if (row?.mode === "bedrock") return this.runRuntime(url, "bedrock");
    if (row?.mode === "uplift") return this.runUplift(url);
    if (row?.mode === "agent" || row?.mode === "probe") return this.runAgent(url, row.mode === "probe");
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

  private async runAgent(url: string, probe = false): Promise<void> {
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
    const connectivityPrompt =
      "Connectivity check from the stardust web app. In one short sentence, confirm you're running. " +
      "Then create the file /mnt/session/outputs/hello.txt containing 'stardust online' and stop.";

    // Skill-load probe (/?mode=probe) — cheap: just reads the baked SKILL.md and
    // reports. No Playwright, no URL fetch, no redesign. Proves the brain can
    // find, read, and understand the stardust skill before a full uplift.
    const probePrompt =
      "Skill-load probe — DO NOT run a redesign, DO NOT launch Playwright, DO NOT fetch any URL. " +
      "The stardust skills are baked at /workspace/skills. Do exactly this:\n" +
      "1) Run `ls /workspace/skills/stardust` to see the available skills.\n" +
      "2) Read /workspace/skills/stardust/uplift/SKILL.md.\n" +
      "3) Read the first heading of /workspace/skills/impeccable/SKILL.md.\n" +
      "Then, as your FINAL message (this is required — write it as plain text in the chat, " +
      "do not skip it), report your findings in this exact shape:\n" +
      "• Skills found: <comma-separated list from step 1>\n" +
      "• uplift: <2–3 sentences on what stardust:uplift does and the exact phase chain it runs>\n" +
      "• impeccable: present — \"<the first heading text>\"\n" +
      "Keep it tight, then stop.";

    const prompt = probe ? probePrompt : connectivityPrompt;

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

  /* ---- M5 real uplift run: stardust:uplift in the sandbox, screens driven by
     milestones + artifacts the agent pushes to the ingest endpoints. The SSE
     stream feeds only the conversation narration. ---- */

  private async runUplift(url: string): Promise<void> {
    this.uplift = true;
    const { ANTHROPIC_API_KEY, STARDUST_AGENT_ID, STARDUST_ENVIRONMENT_ID } = this.env;

    this.tasks = UPLIFT_TASKS.map((t) => ({ ...t }));
    this.tasks[0].status = "run";
    await this.emit({ t: "run.started", runId: this.runId, url, projectName: this.project, seed: "—" });
    await this.emit({ t: "phase", phase: "prototype" });
    await this.emit({ t: "tasks.init", tasks: this.tasks });
    await this.emit({ t: "progress", value: 5 });
    await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock: "⏱ uplift · live" } });
    await this.emit({ t: "screen", screen: "working" });

    if (!ANTHROPIC_API_KEY || !STARDUST_AGENT_ID || !STARDUST_ENVIRONMENT_ID) {
      await this.emit({ t: "message.append", message: { id: "no-creds", role: "agent", lead: "Managed Agents not configured. Run agent/setup.mjs and restart dev." } });
      return this.fail("missing Managed Agents credentials");
    }
    const creds: MaCreds = { apiKey: ANTHROPIC_API_KEY, agentId: STARDUST_AGENT_ID, environmentId: STARDUST_ENVIRONMENT_ID };

    // Per-run ingest token — the agent authorizes its pushes with it.
    const token = crypto.randomUUID().replace(/-/g, "");
    await this.env.DB.prepare("UPDATE runs SET ingest_token = ? WHERE id = ?").bind(token, this.runId).run();

    const base = this.env.INGEST_BASE ?? "http://host.docker.internal:5173";
    const ingest = `${base}/api/ingest/${this.runId}`;
    const prompt =
      `Redesign ${url} for presales. Run stardust:uplift to completion, non-interactively.\n\n` +
      `INGEST — push progress + deliverables here so the web UI updates live. ` +
      `Add this header to every ingest call: Authorization: Bearer ${token}\n` +
      `1) Milestones — POST ${ingest}/event with content-type application/json, one JSON object per ` +
      `milestone, exactly the shapes defined in your system prompt (extract.started/seed/tensions/` +
      `brand_ready, direct.variants_ready, prototype.variant_done, done). Send each the moment it happens.\n` +
      `2) Deliverables — PUT ${ingest}/artifact/<relative-path> with the file bytes and a correct ` +
      `content-type, preserving paths relative to /mnt/session/outputs (so brand-review.html, its ` +
      `assets/*, the three home-*-proposed.html, and assets/thumb-{A,B,C}.png all resolve). Upload the ` +
      `brand surface as soon as it exists, each variant as it finishes.\n` +
      `Paths in milestone JSON must match the artifact paths you upload. Begin now.`;

    try {
      const sessionId = await createSession(creds, `stardust uplift · ${this.project}`, { url, runId: this.runId });
      await this.emit({ t: "message.append", message: { id: "sess", role: "agent", lead: `Session started — <b>${sessionId.slice(0, 8)}</b>. Reading ${this.project}…` } });
      await sendUserMessage(creds, sessionId, prompt);

      for await (const ev of streamEvents(creds, sessionId)) {
        if (ev.type === "agent.message") {
          const content = (ev as { content?: { text?: string }[] }).content ?? [];
          const text = content.map((b) => b.text ?? "").join("").trim();
          if (text) await this.emit({ t: "message.append", message: { id: `m-${this.seq}`, role: "agent", lead: text } });
        } else if (ev.type === "agent.tool_use") {
          const name = (ev as { name?: string }).name ?? "tool";
          await this.emit({ t: "message.append", message: { id: `t-${this.seq}`, role: "agent", lead: `› ${name}` } });
        } else if (ev.type === "session.status_idle") {
          // A turn boundary — NOT necessarily completion. The agent runs many
          // turns; finish only once its {"phase":"done"} milestone has arrived
          // (which sets this.finished via ingestEvent). Otherwise keep streaming.
          if (this.finished) break;
        } else if (ev.type === "session.error") {
          await this.fail(`session error: ${JSON.stringify((ev as { error?: unknown }).error ?? ev)}`);
          break;
        }
      }
      // Stream closed (worker stopped) without an explicit done milestone — finalize.
      if (!this.finished) {
        await this.emit({ t: "message.append", message: { id: "fin", role: "agent", lead: "✓ stardust finished." } });
        await this.emit({ t: "run.done" });
        await this.env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(this.runId).run();
      }
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: "err", role: "agent", lead: `Run error: ${String((e as Error).message ?? e)}` } });
      await this.fail(String(e));
    }
  }

  /* ---- New-architecture run: open-loop runtime in the sandbox. backend selects
     the model provider (cerebras/Gemma or bedrock/Opus). The DO mints the ingest
     token, shows the working screen, asks the host runner to docker-run the
     runtime, then drives the screens purely from ingest (no SSE). Completion
     arrives via the agent's {"phase":"done"} milestone. ---- */
  private async runRuntime(url: string, backend: "cerebras" | "bedrock"): Promise<void> {
    this.uplift = true;
    this.tasks = UPLIFT_TASKS.map((t) => ({ ...t }));
    this.tasks[0].status = "run";
    const clock = backend === "bedrock" ? "⏱ bedrock · opus · live" : "⏱ cerebras · gemma · live";
    const label = backend === "bedrock" ? "Bedrock/Opus" : "Cerebras";
    await this.emit({ t: "run.started", runId: this.runId, url, projectName: this.project, seed: "—" });
    await this.emit({ t: "phase", phase: "prototype" });
    await this.emit({ t: "tasks.init", tasks: this.tasks });
    await this.emit({ t: "progress", value: 5 });
    await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock } });
    await this.emit({ t: "screen", screen: "working" });

    const token = crypto.randomUUID().replace(/-/g, "");
    await this.env.DB.prepare("UPDATE runs SET ingest_token = ? WHERE id = ?").bind(token, this.runId).run();

    const runner = this.env.RUNNER_URL ?? "http://localhost:8790/run";
    try {
      const r = await fetch(runner, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: this.runId, url, token, backend }),
      });
      if (!r.ok) throw new Error(`runner ${r.status}: ${(await r.text()).slice(0, 200)}`);
      await this.emit({ t: "message.append", message: { id: "sess", role: "agent", lead: `${label} runtime started — reading ${this.project}…` } });
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: "no-runner", role: "agent", lead: "Couldn't reach the runtime runner. Start it: <code>node runtime/runner.mjs</code>." } });
      await this.fail(`runner unreachable: ${String((e as Error).message ?? e)}`);
    }
  }

  /** R2-served URL for an artifact this run uploaded, by its relative path. */
  private art(p: string): string {
    return `/api/artifacts/${this.runId}/${String(p).replace(/^\/+/, "")}`;
  }

  private mapVariants(arr: unknown[]): VariantCard[] {
    return (arr ?? []).map((raw) => {
      const m = raw as { id: VariantId; title?: string; pitch?: string; whatif?: string; role?: string; file: string; thumb: string };
      const segWord = String(m.role ?? m.title ?? m.id).split(/[ ·]/)[0].toLowerCase();
      return {
        id: m.id,
        title: m.title ?? `Variant ${m.id}`,
        pitch: m.pitch ?? "",
        thumb: this.art(m.thumb),
        src: this.art(m.file),
        segLabel: `${m.id} · ${segWord}`,
        segWord,
        role: m.role ?? "",
        recommended: m.id === "C",
        whatif: m.id === "A" ? undefined : m.whatif,
        faithful: m.id === "A" ? m.pitch : undefined,
      } satisfies VariantCard;
    });
  }

  /** Called by the Worker when the sandbox agent POSTs a milestone. The tasks
   *  list (this.tasks) is the source of truth; we mutate it and re-emit
   *  tasks.init so labels/details reflect the real run, not canned demo copy. */
  async ingestEvent(runId: string, ev: unknown): Promise<void> {
    if (!this.runId) this.runId = runId;
    const e = (ev ?? {}) as { type?: string; text?: string; name?: string; phase?: string; event?: string; seed?: string; items?: { n: string; text: string }[]; brandReview?: string; sharedFixes?: string[]; variants?: unknown[]; variant?: string; file?: string };

    // Narration / tool activity from the open-loop runtime → conversation thread.
    if (e.type === "narration" && e.text) {
      await this.emit({ t: "message.append", message: { id: `m-${this.seq}`, role: "agent", lead: e.text } });
      return;
    }
    if (e.type === "tool") {
      await this.emit({ t: "message.append", message: { id: `t-${this.seq}`, role: "agent", lead: `› ${e.name ?? "tool"}` } });
      return;
    }

    // M6: an iteration finished re-rendering a variant → hot-swap the preview.
    if (e.phase === "iterate") {
      await this.hotSwapVariant(e.variant, e.file);
      return;
    }
    const set = (id: string, status?: TaskItem["status"], detail?: string) => {
      const t = this.tasks.find((x) => x.id === id);
      if (!t) return;
      if (status) t.status = status;
      if (detail) t.detail = detail;
    };
    const advance = async (doneId: string, nextId: string | null, progress: number, status?: string) => {
      set(doneId, "done");
      if (nextId) set(nextId, "run");
      if (this.tasks.length) await this.emit({ t: "tasks.init", tasks: this.tasks });
      await this.emit({ t: "progress", value: progress });
      if (status) await this.emit({ t: "status", text: status });
    };

    if (e.phase === "extract" && e.event === "started") {
      await this.emit({ t: "status", text: "reading the site" });
    } else if (e.phase === "extract" && e.event === "seed") {
      await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock: `⏱ seed ${e.seed ?? ""}` } });
      await advance("crawl", "read", 22, "reading the brand");
    } else if (e.phase === "extract" && e.event === "tensions") {
      this.realTensions = e.items ?? [];
      set("analyze", undefined, `${this.realTensions.length} tensions`);
      await advance("read", "extract", 40, "identifying tensions");
    } else if (e.phase === "extract" && e.event === "brand_ready") {
      this.realBrand = { brandReviewUrl: this.art(e.brandReview ?? "brand-review.html"), tensions: this.realTensions };
      await this.persistResult();
      await advance("extract", "analyze", 58, "brand surface captured");
      await this.emit({ t: "message.append", message: { id: `brand-${this.seq}`, role: "agent", lead: "Brand surface captured — open the snapshot." } });
      await this.emit({ t: "snapshot.ready" });
    } else if (e.phase === "direct" && e.event === "variants_ready") {
      this.realVariants = { sharedFixes: e.sharedFixes ?? [], variants: this.mapVariants(e.variants ?? []) };
      const ids = this.realVariants.variants.map((v) => v.id).join(" · ");
      set("generate", undefined, ids || "3 directions");
      await this.persistResult();
      await advance("analyze", "generate", 74, "three directions composed");
      await this.emit({ t: "message.append", message: { id: `var-${this.seq}`, role: "agent", lead: "Three directions ready." } });
    } else if (e.phase === "prototype" && e.event === "variant_done") {
      set("generate", "run");
      await this.emit({ t: "tasks.init", tasks: this.tasks });
      await this.emit({ t: "status", text: `variant ${e.variant ?? ""} rendered` });
      await this.emit({ t: "progress", value: 88 });
    } else if (e.phase === "done") {
      this.finished = true;
      set("generate", "done");
      set("validate", "done");
      await this.persistResult();
      if (this.tasks.length) await this.emit({ t: "tasks.init", tasks: this.tasks });
      await this.emit({ t: "progress", value: 100 });
      await this.emit({ t: "snapshot.ready" });
      await this.emit({ t: "message.append", message: { id: `done-${this.seq}`, role: "agent", lead: "✓ Done — three variants ready. Open the snapshot." } });
      await this.emit({ t: "run.done" });
      await this.env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(this.runId).run();
    }
  }

  /** Persist the real result (brand + variants) so a finished run can be
   *  reopened (/?run=<id>) and its brand/variants screens rebuilt. */
  private async persistResult(): Promise<void> {
    const result = JSON.stringify({ uplift: true, brand: this.realBrand ?? null, variants: this.realVariants ?? null });
    await this.env.DB.prepare("UPDATE runs SET result_json = ? WHERE id = ?").bind(result, this.runId).run();
  }

  private async rehydrateResult(runId: string): Promise<void> {
    const row = await this.env.DB.prepare("SELECT result_json FROM runs WHERE id = ?").bind(runId).first<{ result_json: string | null }>();
    if (!row?.result_json) return;
    try {
      const r = JSON.parse(row.result_json) as {
        uplift?: boolean;
        brand?: { brandReviewUrl: string; tensions: { n: string; text: string }[] } | null;
        variants?: { sharedFixes: string[]; variants: VariantCard[] } | null;
      };
      this.uplift = !!r.uplift;
      if (r.brand) this.realBrand = r.brand;
      if (r.variants) this.realVariants = r.variants;
    } catch {
      /* ignore malformed */
    }
  }

  /** Called by the Worker when the sandbox agent uploads an artifact. */
  async ingestArtifact(runId: string, rel: string, _contentType: string): Promise<void> {
    if (!this.runId) this.runId = runId;
    // R2 write is done by the Worker; if a proposed variant arrives while its
    // workspace is open, hot-swap the preview (M6 leans on this). For M5 we just
    // note the brand surface / variants landing.
    if (/proposed\.html$/.test(rel) || /brand-review\.html$/.test(rel)) {
      await this.emit({ t: "rail", rail: { swatches: this.realVariants?.variants.length ? KNACK_PALETTE : [], busy: true, clock: `⏱ received ${rel.split("/").pop()}` } });
    }
  }

  private async fail(reason: string): Promise<void> {
    await this.emit({ t: "error", message: reason });
    await this.emit({ t: "run.done" });
    await this.env.DB.prepare("UPDATE runs SET status = 'error' WHERE id = ?").bind(this.runId).run();
  }

  private async toBrand(): Promise<void> {
    this.clearTimers();
    const url = this.realBrand?.brandReviewUrl ?? brandReviewUrl;
    const tensions = this.realBrand?.tensions?.length ? this.realBrand.tensions : KNACK_TENSIONS;
    const messages: Message[] = this.uplift
      ? [
          { id: "brand-lead", role: "agent", lead: "Here's the brand surface, captured from a live render of the site.", body: ["Open the full audit for the scorecard, or move on to directions."] },
          { id: "brand-tensions", role: "agent", plan: { tag: `${tensions.length} tensions`, steps: tensions } },
        ]
      : [
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
    await this.emit({ t: "panel.brand", brandReviewUrl: url, tensions });
    await this.emit({ t: "rail", rail: rail({ note: "brand surface captured", tensions: tensions.length, clock: "⏱ captured" }) });
    await this.emit({ t: "screen", screen: "brand" });
  }

  private async toVariants(): Promise<void> {
    this.clearTimers();
    const cards = this.realVariants?.variants?.length ? this.realVariants.variants : variants;
    const sharedFixes = this.realVariants?.sharedFixes?.length ? this.realVariants.sharedFixes : KNACK_SHARED_FIXES;
    const messages: Message[] = this.uplift
      ? [{ id: "var-lead", role: "agent", lead: "Three directions, all brand-faithful — the shared tensions fixed in each.", body: ["They differ in their bet. Open any card to iterate on it."] }]
      : [
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
    await this.emit({ t: "panel.variants", sharedFixes, variants: cards });
    await this.emit({ t: "rail", rail: rail({ signature: "watch it build", tensions: sharedFixes.length, clock: "⏱ 3 directions ready" }) });
    await this.emit({ t: "screen", screen: "variants" });
  }

  private async toWorkspace(id: VariantId): Promise<void> {
    this.clearTimers();
    const cards = this.realVariants?.variants?.length ? this.realVariants.variants : variants;
    const card = cards.find((v) => v.id === id) ?? cards[cards.length - 1];
    this.activeVariant = card.id;
    const messages: Message[] = [
      {
        id: "ws-lead",
        role: "agent",
        lead: `Variant <b>${id}</b> — ${card.title.toLowerCase()}. Switch variants in the toolbar, or tell me a change.`,
        body: ["When it's right, hit Deploy."],
      },
    ];
    await this.emit({ t: "panel.workspace", activeVariant: id, variants: cards });
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
    if (cmd.t === "select") { this.activeVariant = cmd.variant; return; }
    if (cmd.t === "send") return this.onSend(cmd.screen, cmd.text);
  }

  private async onSend(screen: ScreenId, text: string): Promise<void> {
    await this.emit({ t: "message.append", message: { id: `u-${this.seq}`, role: "user", text } });
    if (screen === "workspace") return this.iterate(text);
    this.schedule(550, () =>
      this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "On it — folding that into the work." } }),
    );
  }

  /** M6: a "tell me a change" in the workspace re-renders the active variant.
   *  We spawn an iteration container (via the runner) that re-opens the run's
   *  persisted workspace, applies the change through impeccable, and re-uploads
   *  the variant; ingestEvent(phase:"iterate") then hot-swaps the preview. */
  private async iterate(text: string): Promise<void> {
    const cards = this.realVariants?.variants ?? [];
    const card = cards.find((v) => v.id === this.activeVariant) ?? cards[cards.length - 1];
    // No real variants (scripted demo) → keep a light acknowledgement.
    if (!card) {
      this.schedule(550, () =>
        this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "On it — folding that into the work.", seed: KNACK_SEED } }),
      );
      return;
    }

    const file = (card.src.split("?")[0].split("/").pop() ?? "").trim();
    const row = await this.env.DB.prepare("SELECT mode, ingest_token AS token FROM runs WHERE id = ?")
      .bind(this.runId)
      .first<{ mode: string | null; token: string | null }>();
    const backend = row?.mode === "cerebras" ? "cerebras" : "bedrock";
    const token = row?.token;
    if (!token) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "I can't re-render this run — its runtime token is missing. Try a fresh run." } });
      return;
    }
    const runner = this.env.RUNNER_URL ?? "http://localhost:8790/run";

    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `On it — re-rendering variant <b>${card.id}</b>: ${text}` } });
    await this.emit({ t: "rail", rail: rail({ signature: "watch it build", variant: card.segLabel, busy: true, clock: `⏱ re-rendering ${card.id}` }) });

    try {
      const res = await fetch(runner, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: this.runId, token, backend, mode: "iterate", instruction: text, variantId: card.id, variantFile: file }),
      });
      if (!res.ok) throw new Error(`runner ${res.status}`);
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Couldn't start the re-render (${(e as Error).message}).` } });
      await this.emit({ t: "rail", rail: rail({ signature: "watch it build", variant: card.segLabel, clock: "⏱ ready to iterate" }) });
    }
  }

  /** Re-render finished — bump the active variant's src to force an iframe
   *  reload (R2 serves with a 5-min cache; a ?v= buster defeats it). */
  private async hotSwapVariant(id?: string, file?: string): Promise<void> {
    if (!this.realVariants) return;
    this.iterVersion += 1;
    const variants = this.realVariants.variants.map((c) => {
      const match = (id && c.id === id) || (file && c.src.includes(file));
      return match ? { ...c, src: `${c.src.split("?")[0]}?v=${this.iterVersion}` } : c;
    });
    this.realVariants = { ...this.realVariants, variants };
    const active = (id as VariantId | undefined) ?? this.activeVariant ?? variants[variants.length - 1].id;
    const card = variants.find((c) => c.id === active) ?? variants[variants.length - 1];
    await this.emit({ t: "panel.workspace", activeVariant: active, variants });
    await this.emit({ t: "message.append", message: { id: `it-${this.seq}`, role: "agent", lead: `Done — re-rendered variant <b>${active}</b>. Switch variants or ask for another change.` } });
    await this.emit({ t: "rail", rail: rail({ signature: "watch it build", variant: card.segLabel, clock: "⏱ re-rendered" }) });
  }
}

/** Build a rail state with the shared knack palette. */
function rail(partial: Omit<RailState, "swatches">): RailState {
  return { swatches: KNACK_PALETTE, ...partial };
}
