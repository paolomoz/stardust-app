#!/usr/bin/env bash
# Called once per claimed session by the poller (poll.sh --on-work). The poller
# injects ANTHROPIC_SESSION_ID / WORK_ID / ENVIRONMENT_ID / ENVIRONMENT_KEY.
# Runs a fresh sandbox container for the session and bind-mounts a host dir at
# /mnt/session/outputs so deliverables can be retrieved (and later pushed to R2).
set -euo pipefail

IMAGE="${IMAGE:-stardust-sandbox}"
OUTPUTS_DIR="${OUTPUTS_DIR:-/tmp/stardust-outputs}"
OUT="$OUTPUTS_DIR/$ANTHROPIC_SESSION_ID"
mkdir -p "$OUT"

exec docker run --rm \
  -e ANTHROPIC_SESSION_ID -e ANTHROPIC_ENVIRONMENT_KEY \
  -e ANTHROPIC_WORK_ID -e ANTHROPIC_ENVIRONMENT_ID -e ANTHROPIC_BASE_URL \
  -v "$OUT":/mnt/session/outputs \
  "$IMAGE"
