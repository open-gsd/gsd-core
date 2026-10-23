#!/usr/bin/env bash
# build.sh head|base : builds <arm>/project (pristine) and <arm>/prompt.iter2.txt. No reviewer is run.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/env.sh"
arm=${1:?head|base}; wt_of "$arm" >/dev/null
P=$W/$arm/project; rm -rf "${W:?}/$arm"; mkdir -p "$P/src" "$P/phase" "$P/tmp"
cp "$A"/lib/fixture/{config,lockout,messages,auth}.js "$P/src/"
if [ "$arm" = head ]; then
  # dispatch (shipped fence; only review-lane dispatch-step stubbed) -> writes lane dir + persisted evidence file
  run_shipped dispatch head "$P" > "$W/$arm/dispatch.block.txt" 2> "$W/$arm/dispatch.stderr.txt"
  cp "$A/lib/fixture/01-REVIEW.md" "$P/phase/01-REVIEW.md"   # the iteration-1 reviewer's output
  run_shipped commit head "$P" > "$W/$arm/commit.out.txt"      # fresh shell, shipped commit_review fence, FIX_AUTO=true
else
  cp "$A/lib/fixture/01-REVIEW.md" "$P/phase/01-REVIEW.md"
fi
"$A/prompt.sh" "$arm" "$P" > "$W/$arm/prompt.iter2.txt"
echo "built $W/$arm"
