#!/usr/bin/env bash
# trial.sh head|base N : copies the pristine project to <arm>/trial-N/project, rewrites the one absolute path
# stored in files (persisted evidence block), regenerates <arm>/trial-N/prompt.txt via the shipped snippets.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib/env.sh"
arm=${1:?head|base}; n=${2:?trial number}; T=$W/$arm/trial-$n
[ -e "$T" ] && { echo "$T exists; pick a new N" >&2; exit 1; }
mkdir -p "$T"; cp -a "$W/$arm/project" "$T/project"
OLD=$W/$arm/project NEW=$T/project
grep -rIl --null -F "$OLD" "$T/project" | xargs -0 -r sed -i "s|$OLD|$NEW|g" || true
find "$T/project/phase" -name '*-lane-evidence.md' -exec touch {} + # keep inside the read snippet's 6h freshness window
cksum < "$T/project/phase/01-REVIEW.md" > "$T/pre.cksum"
"$A/prompt.sh" "$arm" "$T/project" > "$T/prompt.txt"
echo "$T/prompt.txt"
