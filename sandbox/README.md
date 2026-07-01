# stardust self-hosted sandbox (the "hands")

The Managed Agents *brain* runs in Claude's cloud; this is the sandbox where its
tool calls actually execute — on infrastructure you control. The image has
Node 22, Playwright/Chromium, git, the **stardust + impeccable skills** baked in,
and the `ant` CLI worker. So the agent can run the real `stardust:uplift`.

```
brain (Anthropic) ──assigns session──▶ self-hosted env queue
                                         │
   poll.sh (host, ant CLI) ─claims──────┘
        └─ spawn.sh ─▶ docker run stardust-sandbox  (ant beta:worker run)
                          executes the brain's bash/file tool calls in /workspace,
                          writes deliverables to /mnt/session/outputs (host-mounted)
```

## Files
- `Dockerfile` — the per-session sandbox image (entrypoint `ant beta:worker run`).
- `build.sh` — stages the skills into the context and builds the image.
- `poll.sh` — host poller; claims sessions, runs `spawn.sh` per session.
- `spawn.sh` — runs one sandbox container, bind-mounting host outputs.
- `.env.sandbox.example` — the environment id + key the poller needs.

## Prerequisites
- **Docker** running locally.
- The **`ant` CLI** on the host: `brew install anthropics/tap/ant`.

## Bring it up

1. **Create a self-hosted environment + agent** (repoints `web/.dev.vars` to it):
   ```bash
   cd /Users/paolo/stardust/source/app
   set -a && . ./.env && set +a       # ANTHROPIC_API_KEY
   node agent/setup.mjs --self-hosted
   ```
2. **Generate the environment key** (Console-only): platform.claude.com →
   Workspace → Environments → open `stardust-self-hosted` → **Generate
   environment key**. Then:
   ```bash
   cp sandbox/.env.sandbox.example sandbox/.env.sandbox
   # fill ANTHROPIC_ENVIRONMENT_ID (printed by setup) + ANTHROPIC_ENVIRONMENT_KEY
   ```
3. **Build the image** (~a few minutes — Playwright + Chromium):
   ```bash
   ./sandbox/build.sh
   ```
4. **Start the poller** (leave it running):
   ```bash
   ./sandbox/poll.sh
   ```
   In another shell, confirm a worker is connected:
   ```bash
   ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY ant beta:environments:work stats \
     --environment-id "$ANTHROPIC_ENVIRONMENT_ID"     # workers_polling ≥ 1
   ```
5. **Restart the web dev server** so the Worker uses the self-hosted env:
   ```bash
   cd web && npm run dev
   ```

## Verify (M4)

Trigger a real run and watch the poller spawn a container:
`http://localhost:5173/?mode=agent`. The M3 connectivity check now executes
**inside your sandbox** — deliverables appear at
`sandbox/outputs/<sessionId>/hello.txt`. That proves the hands: the brain's tool
calls ran in your Docker container.

(Optional deeper check — bare extract: temporarily send an extract prompt and
confirm Playwright renders a page under `/workspace`.)

## Next (M5)

Swap the connectivity prompt for the real uplift instruction (in
`web/src/worker/runSession.ts`), map the `status.jsonl` milestones + the
`/mnt/session/outputs` artifacts to the four screens, and upload outputs to R2
under `artifacts/<runId>/` so the preview iframes serve them.

## Notes / hardening
- One image handles one session then exits (fresh filesystem per run).
- Skills are baked (not Managed-Agent "skills"); rebuild to update them.
- Single-operator scale; for concurrency the poller already spawns one
  container per session.
