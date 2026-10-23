#!/usr/bin/env bash
# iter3.sh <arm-dir|trial-dir> : after an iteration-2 REVIEW.md exists (fixer = no-op), re-runs the shipped read
# snippet in a FRESH shell, asserts (head) the lane-evidence file + lane dir survived (the clear fence only runs at loop exit),
# prints the iteration-3 prompt.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/env.sh"
D=$(readlink -f "${1:?arm-dir|trial-dir}"); P=$D/project
arm=$(basename "$D"); [ "$arm" = head ] || [ "$arm" = base ] || arm=$(basename "$(dirname "$D")")
R=$P/phase/01-REVIEW.md
[ -f "$R" ] || { echo "FAIL no REVIEW.md" >&2; exit 1; }
grep -q '^status:' "$R" || { echo "FAIL REVIEW.md has no status" >&2; exit 1; }
if [ "$arm" = head ]; then
  E=$P/phase/01-REVIEW-lane-evidence.md
  [ -f "$E" ] || { echo "FAIL lane-evidence file gone: $E" >&2; exit 1; }
  S=$(head -n 1 "$E"); [ -d "$P/tmp/gsd-review-lanes-$S" ] || { echo "FAIL lane dir gone: $P/tmp/gsd-review-lanes-$S" >&2; exit 1; }
  echo "OK evidence file + lane dir survive iteration 2" >&2
fi
cksum < "$R" > "$D/pre.cksum"
run_shipped prompt "$arm" "$P" > "$D/prompt.iter3.txt"
cat "$D/prompt.iter3.txt"
