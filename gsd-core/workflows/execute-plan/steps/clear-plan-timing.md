<step name="clear_plan_timing">
```bash
# gsd:plan-timing-key:start
canonicalize_timing_id() {
  local raw="$1" segment rest canonical=""
  case "$raw" in ''|.*|*.|*..*|*[!0-9.]*) printf '%s' "$raw"; return ;; esac
  rest=$raw
  while :; do
    case "$rest" in *.*) segment=${rest%%.*}; rest=${rest#*.} ;; *) segment=$rest; rest= ;; esac
    segment=${segment#"${segment%%[!0]*}"}
    segment=${segment:-0}
    canonical="${canonical}${canonical:+.}${segment}"
    [ -n "$rest" ] || break
  done
  printf '%s' "$canonical"
}
PHASE_ID=$(cat <<'GSD:PLAN:PHASE:5212'
{phase}
GSD:PLAN:PHASE:5212
)
PLAN_ID=$(cat <<'GSD:PLAN:NUMBER:5212'
{plan}
GSD:PLAN:NUMBER:5212
)
PHASE_ID=$(canonicalize_timing_id "$PHASE_ID")
PLAN_ID=$(canonicalize_timing_id "$PLAN_ID")
TIMING_KEY=$(printf '%s\0%s' "$PHASE_ID" "$PLAN_ID" | git hash-object --stdin) || exit 1
TIMING_FILE=$(git rev-parse --git-path "gsd-plan-timing-$TIMING_KEY") || exit 1
# gsd:plan-timing-key:end
rm -f -- "$TIMING_FILE" "$TIMING_FILE.result"
```
</step>
