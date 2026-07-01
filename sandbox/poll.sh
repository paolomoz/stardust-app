#!/usr/bin/env bash
# Host-side poller: claims work items for the self-hosted environment and spawns
# a per-session sandbox container for each (via spawn.sh). Run this on your
# machine (needs the `ant` CLI + Docker). Loads the environment id/key from
# sandbox/.env.sandbox.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.env.sandbox" ] && { set -a; . "$HERE/.env.sandbox"; set +a; }

: "${ANTHROPIC_ENVIRONMENT_ID:?set ANTHROPIC_ENVIRONMENT_ID (see .env.sandbox)}"
: "${ANTHROPIC_ENVIRONMENT_KEY:?set ANTHROPIC_ENVIRONMENT_KEY (Console: Generate environment key)}"

export IMAGE="${IMAGE:-stardust-sandbox}"
export OUTPUTS_DIR="${OUTPUTS_DIR:-$HERE/outputs}"
mkdir -p "$OUTPUTS_DIR"

echo "Polling environment $ANTHROPIC_ENVIRONMENT_ID — image=$IMAGE outputs=$OUTPUTS_DIR"
exec ant beta:worker poll --on-work "$HERE/spawn.sh"
