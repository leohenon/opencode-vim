#!/usr/bin/env bash
set -euo pipefail

HASH_DIR="${1:-hashes}"
HASH_FILE="${2:-nix/hashes.json}"
MISSING_MODE="${3:-error}"

[ -f "$HASH_FILE" ] || echo '{"nodeModules":{}}' > "$HASH_FILE"

for SYSTEM in x86_64-linux aarch64-linux x86_64-darwin aarch64-darwin; do
  FILE="$HASH_DIR/hash-${SYSTEM}/hash.txt"
  if [ -f "$FILE" ]; then
    HASH="$(tr -d '[:space:]' < "$FILE")"
    echo "${SYSTEM}: ${HASH}"
    jq --arg sys "$SYSTEM" --arg h "$HASH" '.nodeModules[$sys] = $h' "$HASH_FILE" > tmp.json
    mv tmp.json "$HASH_FILE"
    continue
  fi

  if [ "$MISSING_MODE" = "warn" ]; then
    echo "::warning::Missing hash for ${SYSTEM}"
    continue
  fi

  echo "::error::Missing hash for ${SYSTEM}"
  exit 1
done

cat "$HASH_FILE"
