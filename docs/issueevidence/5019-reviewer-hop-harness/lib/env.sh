# shellcheck shell=bash
# sourced: resolves worktrees and a run_shipped() that bash -n checks then runs a shipped snippet in a FRESH bash
# A = this harness dir (scripts, fixture); W = scratch output dir (arms, trials); override with HOP_WORK.
A=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
W=${HOP_WORK:-${TMPDIR:-/tmp}/5019-reviewer-hop}; mkdir -p "$W"
HEAD_WT=${HEAD_WT:-$(git -C "$A" rev-parse --show-toplevel)}   # checkout under test
BASE_REF=${BASE_REF:-origin/next}
BASE_WT=${BASE_WT:-$W/base-src}                                   # exported from BASE_REF on first use
wt_of() {
  case "$1" in
    head) echo "$HEAD_WT";;
    base) [ -d "$BASE_WT/gsd-core" ] || { mkdir -p "$BASE_WT" && git -C "$HEAD_WT" archive "$BASE_REF" gsd-core | tar -x -C "$BASE_WT"; }; echo "$BASE_WT";;
    *) echo "arm must be head|base" >&2; return 1;;
  esac
}
# run_shipped <verb> <arm> <project>   (stdout = script's stdout)
run_shipped() {
  local s; s=$(mktemp "$W/.gen.XXXXXX")
  node "$A/lib/shipped.cjs" "$1" "$(wt_of "$2")" "$3" "$2" > "$s" || { rm -f "$s"; return 2; }
  bash -n "$s" || { echo "extracted snippet is not complete shell: $s" >&2; return 2; }
  bash "$s"; local rc=$?; rm -f "$s"; return $rc
}
export NODE_DISABLE_COMPILE_CACHE=1 # node would otherwise write a compile cache into the project TMPDIR
