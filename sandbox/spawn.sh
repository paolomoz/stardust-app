#!/usr/bin/env bash
# Called once per claimed session by the poller (poll.sh --on-work). The poller
# injects ANTHROPIC_SESSION_ID / WORK_ID / ENVIRONMENT_ID / ENVIRONMENT_KEY.
# Runs a fresh sandbox container for the session and bind-mounts a host dir at
# /mnt/session/outputs so deliverables can be retrieved (and later pushed to R2).
set -euo pipefail

IMAGE="${IMAGE:-stardust-sandbox}"
OUTPUTS_DIR="${OUTPUTS_DIR:-/tmp/stardust-outputs}"
MAX_IDLE="${MAX_IDLE:-5m}"   # stop the container this long after the session truly ends (end_turn)
OUT="$OUTPUTS_DIR/$ANTHROPIC_SESSION_ID"
WORK="$OUTPUTS_DIR/$ANTHROPIC_SESSION_ID-workspace"   # the stardust working tree, persisted to host
mkdir -p "$OUT" "$WORK"

# --unrestricted-paths: lift the file-tool workdir guardrail so read/write/edit
#   work across /workspace and /mnt/session/outputs (else the agent is forced to
#   route every file op through bash — slow + error-prone).
# -v …:/workspace/stardust: persist the skill's working tree (brand-extraction,
#   direction.md, state.json, validation, …). We mount the subtree, NOT all of
#   /workspace, which holds the baked skills + node_modules.
exec docker run --rm \
  -e ANTHROPIC_SESSION_ID -e ANTHROPIC_ENVIRONMENT_KEY \
  -e ANTHROPIC_WORK_ID -e ANTHROPIC_ENVIRONMENT_ID -e ANTHROPIC_BASE_URL \
  -v "$OUT":/mnt/session/outputs \
  -v "$WORK":/workspace/stardust \
  "$IMAGE" \
  --workdir /workspace --unrestricted-paths --max-idle "$MAX_IDLE"
