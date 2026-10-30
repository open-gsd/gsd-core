#!/usr/bin/env bash
# iter3.sh <arm-dir|trial-dir> : after an iteration-2 REVIEW.md exists (fixer = no-op), re-runs the shipped read
# snippet in a FRESH shell, asserts (head) the persisted lane-evidence state + lane dir survived (the clear fence only runs at loop exit),
# prints the iteration-3 prompt.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/env.sh"
D=$(readlink -f "${1:?arm-dir|trial-dir}"); P=$D/project
arm=$(basename "$D"); [ "$arm" = head ] || [ "$arm" = base ] || arm=$(basename "$(dirname "$D")")
R=$P/phase/01-REVIEW.md
[ -f "$R" ] || { echo "FAIL no REVIEW.md" >&2; exit 1; }
grep -q '^status:' "$R" || { echo "FAIL REVIEW.md has no status" >&2; exit 1; }
if [ "$arm" = head ]; then
  # read itself requires the state to parse, to be fresh and the lane dir to exist
  [ -n "$(TMPDIR=$P/tmp node "$(wt_of head)/gsd-core/bin/gsd-tools.cjs" lane-evidence-read "$R")" ] || { echo "FAIL lane evidence state or lane dir gone for $R" >&2; exit 1; }
  echo "OK evidence state + lane dir survive iteration 2" >&2
fi
cksum < "$R" > "$D/pre.cksum"
run_shipped prompt "$arm" "$P" > "$D/prompt.iter3.txt"
cat "$D/prompt.iter3.txt"
