#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-open-gsd/get-shit-done-redux}"
ENFORCEMENT="${ENFORCEMENT:-evaluate}"

case "$ENFORCEMENT" in
  disabled|evaluate|active) ;;
  *)
    echo "ERROR: ENFORCEMENT must be one of: disabled|evaluate|active" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RULESETS_DIR="$SCRIPT_DIR/../.github/rulesets"

for ruleset_file in "$RULESETS_DIR"/*.json; do
  name="$(jq -r '.name' "$ruleset_file")"

  body="$(jq --arg enforcement "$ENFORCEMENT" '.enforcement = $enforcement' "$ruleset_file")"

  existing_id="$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name==\"$name\") | .id" 2>/dev/null || true)"

  if [ -n "$existing_id" ]; then
    gh api --method PUT "repos/$REPO/rulesets/$existing_id" \
      --input - <<< "$body" > /dev/null
    echo "[update] $name -> enforcement=$ENFORCEMENT"
  else
    gh api --method POST "repos/$REPO/rulesets" \
      --input - <<< "$body" > /dev/null
    echo "[create] $name -> enforcement=$ENFORCEMENT"
  fi
done
