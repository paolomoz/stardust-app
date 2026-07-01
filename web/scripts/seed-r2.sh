#!/usr/bin/env bash
# Seed the local R2 bucket with the knack demo artifacts so the M2 scripted run
# serves real artifacts from R2 via /api/artifacts/knack-demo/*.
#   knack/**        -> artifacts/knack-demo/**
#   knack-review/** -> artifacts/knack-demo/review/**
# Idempotent; re-run any time. Requires the prototypes/ tree alongside web/.
set -euo pipefail

BUCKET="stardust-web-artifacts"
WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROTO="$WEB_DIR/../prototypes/assets"
PREFIX="artifacts/knack-demo"

ctype() {
  case "$1" in
    *.html) echo "text/html; charset=utf-8" ;;
    *.css)  echo "text/css; charset=utf-8" ;;
    *.js)   echo "text/javascript; charset=utf-8" ;;
    *.svg)  echo "image/svg+xml" ;;
    *.png)  echo "image/png" ;;
    *.webp) echo "image/webp" ;;
    *.jpg|*.jpeg) echo "image/jpeg" ;;
    *.json) echo "application/json" ;;
    *)      echo "application/octet-stream" ;;
  esac
}

put() { # <src-file> <r2-key>
  wrangler r2 object put "$BUCKET/$2" --file "$1" --content-type "$(ctype "$1")" --local >/dev/null
  echo "  $2"
}

echo "Seeding R2 bucket '$BUCKET' (local)…"
[ -d "$PROTO/knack" ] || { echo "missing $PROTO/knack" >&2; exit 1; }

echo "knack/ -> $PREFIX/"
while IFS= read -r f; do
  put "$f" "$PREFIX/${f#"$PROTO/knack/"}"
done < <(find "$PROTO/knack" -type f ! -name '.DS_Store')

echo "knack-review/ -> $PREFIX/review/"
while IFS= read -r f; do
  put "$f" "$PREFIX/review/${f#"$PROTO/knack-review/"}"
done < <(find "$PROTO/knack-review" -type f ! -name '.DS_Store')

echo "Done."
