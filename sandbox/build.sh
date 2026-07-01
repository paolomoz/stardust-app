#!/usr/bin/env bash
# Stage the stardust + impeccable skills into the build context, then build the
# sandbox image. Skill sources are configurable; defaults point at this machine's
# stardust plugin and the impeccable plugin cache.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${IMAGE:-stardust-sandbox}"

# stardust is a live dev tree — always re-staged from source, so editing the
# plugin + rebuilding picks up the new version automatically.
STARDUST_SRC="${STARDUST_SRC:-/Users/paolo/stardust/source/skills/plugins/stardust/skills}"

# impeccable lives in the plugin cache under a version dir. Auto-resolve the
# HIGHEST installed version so a future `impeccable` update is picked up on the
# next rebuild with no edit here. Override IMPECCABLE_SRC to pin a version.
IMPECCABLE_BASE="${IMPECCABLE_BASE:-/Users/paolo/.claude/plugins/cache/impeccable/impeccable}"
if [ -z "${IMPECCABLE_SRC:-}" ]; then
  IMP_VER="$(ls -1 "$IMPECCABLE_BASE" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+' | sort -V | tail -1)"
  IMPECCABLE_SRC="$IMPECCABLE_BASE/$IMP_VER/skills/impeccable"
fi

[ -d "$STARDUST_SRC" ] || { echo "stardust skills not found: $STARDUST_SRC" >&2; exit 1; }
[ -d "$IMPECCABLE_SRC" ] || { echo "impeccable skill not found: $IMPECCABLE_SRC" >&2; exit 1; }
echo "Skill sources:"
echo "  stardust:   $STARDUST_SRC"
echo "  impeccable: $IMPECCABLE_SRC"

echo "Staging skills into build context…"
rm -rf "$HERE/skills"
mkdir -p "$HERE/skills/stardust" "$HERE/skills/impeccable"
# stardust plugin's skills/ (stardust, uplift, extract, direct, prototype, …) keep
# their relative cross-references (../extract/SKILL.md etc.).
rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' "$STARDUST_SRC/" "$HERE/skills/stardust/"
rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' "$IMPECCABLE_SRC/" "$HERE/skills/impeccable/"

echo "Staging runtime (Cerebras/Gemma open-loop) into build context…"
RUNTIME_SRC="${RUNTIME_SRC:-$HERE/../runtime}"
rm -rf "$HERE/runtime"
mkdir -p "$HERE/runtime"
rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' "$RUNTIME_SRC/" "$HERE/runtime/"

# STAGE_ONLY=1 → just stage skills+runtime into the build context (used before
# `wrangler deploy`, which builds the Containers image itself). Otherwise build
# the image locally (host-runner / local dev path).
if [ "${STAGE_ONLY:-}" = "1" ]; then
  echo "Staged only (STAGE_ONLY=1) — skipping local docker build."
  exit 0
fi

echo "Building image '$IMAGE'…"
docker build -t "$IMAGE" "$HERE"
echo "Done: $IMAGE"
