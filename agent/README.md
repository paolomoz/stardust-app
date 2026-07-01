# stardust agent (Managed Agents brain)

The stardust web app runs the real stardust/impeccable skills through **Anthropic
Managed Agents**: the agent *brain* runs in Claude's cloud; the Worker creates a
session per run and streams its events to the browser.

- `system-prompt.md` — the stardust-engine system prompt (runs `stardust:uplift`,
  emits the `status.jsonl` progress protocol, writes artifacts to outputs).
- `setup.mjs` — creates the agent + environment and writes the IDs to
  `agent.local.json` and `web/.dev.vars`.
- `agent.local.json` — generated IDs (gitignored).

## Provisioning (M3 — cloud environment, minimal)

A **cloud** environment is enough to verify the brain end-to-end: Anthropic runs
the sandbox, so there's no environment key, no Console step, and no local worker.
(Those are M4, when we switch to a self-hosted Cloudflare sandbox to run the
stardust skills + Playwright.)

1. **Get an Anthropic API key with Managed Agents beta access** from
   https://platform.claude.com (Settings → API keys). Export it:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```
2. **Create the agent + cloud environment** (writes IDs + `web/.dev.vars`):
   ```bash
   node agent/setup.mjs
   ```
   Expected output: `agent <id>` and `environment <id>`. If you get a 403/beta
   error, your key doesn't yet have Managed Agents access — request it.
3. **Restart the dev server** so the Worker picks up `web/.dev.vars`:
   ```bash
   cd web && npm run dev
   ```

## Verify (M3)

Start a **real** run (agent mode) instead of the scripted demo:
```bash
curl -s -X POST http://localhost:5173/api/runs \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.knack.com/","mode":"agent"}'
```
The agent's narration + tool use stream into the conversation over the same
WebSocket. (The scripted demo is still the default — omit `mode` or pass
`"mode":"scripted"`.)

## M4 (later)

Re-run with `node agent/setup.mjs --self-hosted` to create a self-hosted
environment, generate its environment key in the Console, and run the sandbox
worker image (Playwright + stardust/impeccable skills). Then the agent can
actually execute `stardust:uplift`.
