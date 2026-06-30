# stardust self-hosted sandbox — the agent's "hands".
# Node 22 + Playwright/Chromium + git + the stardust & impeccable skills + the
# `ant` CLI environment worker. One container per session (entrypoint
# `ant beta:worker run`): it claims the assigned session, executes the brain's
# tool calls locally, writes deliverables to /mnt/session/outputs, and exits.
FROM node:22-bookworm

ARG ANT_VERSION=1.12.0
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ant CLI (the self-hosted environment worker)
RUN ARCH=$([ "${TARGETARCH:-amd64}" = "arm64" ] && echo arm64 || echo amd64) \
  && curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v${ANT_VERSION}/ant_${ANT_VERSION}_linux_${ARCH}.tar.gz" \
     | tar -xz -C /usr/local/bin ant

WORKDIR /workspace

# Playwright + Chromium (+ system deps) so stardust:extract can render live sites.
# Installed under /workspace/node_modules so the skills' scripts resolve it.
# Split into separate layers (node_modules / apt deps / browser binary) so no
# single blob is large enough to choke a slow registry push.
RUN npm init -y >/dev/null 2>&1 && npm install playwright@latest
RUN npx playwright install-deps chromium
RUN npx playwright install chromium

# Bake the skills (staged by build.sh into ./skills). The agent's system prompt
# points at /workspace/skills/{stardust,impeccable}.
COPY skills/ /workspace/skills/

# Bake the open-loop runtime (dependency-free ESM; staged by build.sh into
# ./runtime). Default entrypoint = the in-container job server (Cloudflare
# Containers). Local dev's host runner overrides it with:
#   --entrypoint node … /workspace/runtime/agent.mjs   (one-shot per docker run)
COPY runtime/ /workspace/runtime/

# Per-session deliverables land here; local dev bind-mounts a dir at this path.
VOLUME /mnt/session/outputs

# The job server listens here; Cloudflare Containers routes to it.
EXPOSE 8080
ENTRYPOINT ["node", "/workspace/runtime/server.mjs"]
