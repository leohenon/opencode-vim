#!/usr/bin/env bash
set -euo pipefail

SYSTEM="${SYSTEM:?SYSTEM is required}"
OUTPUT_FILE="${1:-hash.txt}"
BUILD_LOG=$(mktemp)
trap 'rm -f "$BUILD_LOG"' EXIT

HASH=""
MAX_ATTEMPTS=3
for ((ATTEMPT = 1; ATTEMPT <= MAX_ATTEMPTS; ATTEMPT++)); do
  # Build with fakeHash to trigger hash mismatch and reveal the correct hash.
  nix build ".#packages.${SYSTEM}.node_modules_updater" --no-link 2>&1 | tee "$BUILD_LOG" || true

  HASH="$(nix run --inputs-from . nixpkgs#gnugrep -- -oP 'got:\s*\Ksha256-[A-Za-z0-9+/=]+' "$BUILD_LOG" | tail -n1 || true)"

  [ -n "$HASH" ] && break

  if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
    echo "::warning::Attempt ${ATTEMPT}/${MAX_ATTEMPTS} produced no hash for ${SYSTEM}; retrying in $((ATTEMPT * 10))s"
    sleep $((ATTEMPT * 10))
  fi
done

if [ -z "$HASH" ]; then
  echo "::error::Failed to compute hash for ${SYSTEM} after ${MAX_ATTEMPTS} attempts"
  cat "$BUILD_LOG"
  exit 1
fi

echo "$HASH" > "$OUTPUT_FILE"
echo "Computed hash for ${SYSTEM}: $HASH"
