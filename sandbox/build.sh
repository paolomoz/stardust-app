#!/usr/bin/env bash
# Stage the stardust + impeccable skills into the build context, then build the
# sandbox image. Skill sources are configurable; defaults point at this machine's
# stardust plugin and the impeccable plugin cache.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${IMAGE:-stardust-sandbox}"

STARDUST_SRC="${STARDUST_SRC:-/Users/paolo/stardust/source/skills/plugins/stardust/skills}"
IMPECCABLE_SRC="${IMPECCABLE_SRC:-/Users/paolo/.claude/plugins/cache/impeccable/impeccable/3.8.0/skills/impeccable}"

[ -d "$STARDUST_SRC" ] || { echo "stardust skills not found: $STARDUST_SRC" >&2; exit 1; }
[ -d "$IMPECCABLE_SRC" ] || { echo "impeccable skill not found: $IMPECCABLE_SRC" >&2; exit 1; }

echo "Staging skills into build context…"
rm -rf "$HERE/skills"
mkdir -p "$HERE/skills/stardust" "$HERE/skills/impeccable"
# stardust plugin's skills/ (stardust, uplift, extract, direct, prototype, …) keep
# their relative cross-references (../extract/SKILL.md etc.).
rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' "$STARDUST_SRC/" "$HERE/skills/stardust/"
rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' "$IMPECCABLE_SRC/" "$HERE/skills/impeccable/"

echo "Building image '$IMAGE'…"
docker build -t "$IMAGE" "$HERE"
echo "Done: $IMAGE"
