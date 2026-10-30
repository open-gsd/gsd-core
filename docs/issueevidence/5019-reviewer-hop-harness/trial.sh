#!/usr/bin/env bash
# trial.sh head|base N : copies the pristine project to <arm>/trial-N/project, rewrites the one absolute path
# stored in files and re-keys the persisted evidence state to the copy, regenerates <arm>/trial-N/prompt.txt via the shipped snippets.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/env.sh"
arm=${1:?head|base}; n=${2:?trial number}; T=$W/$arm/trial-$n
[ -e "$T" ] && { echo "$T exists; pick a new N" >&2; exit 1; }
mkdir -p "$T"; cp -a "$W/$arm/project" "$T/project"
OLD=$W/$arm/project NEW=$T/project
# BSD and GNU sed disagree on -i, so rewrite through a temp file
while IFS= read -r -d '' f; do sed "s|$OLD|$NEW|g" "$f" > "$f.new" && mv "$f.new" "$f"; done < <(grep -rIl --null -F "$OLD" "$T/project" || true)
if [ "$arm" = head ]; then
  # the state is keyed to the resolved REVIEW_PATH, so the copy needs its own: read at OLD, rewrite the path, persist at NEW (fresh mtime)
  TOOLS=$(wt_of head)/gsd-core/bin/gsd-tools.cjs
  B=$(TMPDIR=$OLD/tmp node "$TOOLS" lane-evidence-read "$OLD/phase/01-REVIEW.md")
  [ -n "$B" ] || { echo "no readable lane evidence at $OLD/phase/01-REVIEW.md; rerun build.sh head" >&2; exit 1; }
  rm -f "$T"/project/tmp/gsd-review-lane-evidence-*
  S=$(basename "$T"/project/tmp/gsd-review-lanes-*)
  printf '%s' "${B//"$OLD"/$NEW}" | TMPDIR=$T/project/tmp node "$TOOLS" lane-evidence-persist "$NEW/phase/01-REVIEW.md" "${S##*gsd-review-lanes-}" auto
fi
cksum < "$T/project/phase/01-REVIEW.md" > "$T/pre.cksum"
"$A/prompt.sh" "$arm" "$T/project" > "$T/prompt.txt"
echo "$T/prompt.txt"
