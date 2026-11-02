<step name="record_start_time">
Replace `{timing_attempt}` with exactly `fresh` when this invocation has no continuation payload, or `continuation` when it carries completed-task/checkpoint state. The shell guard is authoritative: a fresh attempt replaces an abandoned marker, while a continuation preserves it. A continuation must resume in the original worktree; if its marker is missing, stop and resume there or deliberately restart as `fresh`.
```bash
GSD_TIMING_ATTEMPT='{timing_attempt}'
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
case "$GSD_TIMING_ATTEMPT" in
  fresh)
    rm -f -- "$TIMING_FILE.result"
    printf '%s\n' "$(date +%s)" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$TIMING_FILE"
    ;;
  continuation)
    if [ ! -s "$TIMING_FILE" ]; then
      echo "ERROR: continuation timing marker is missing; resume in the original worktree or restart explicitly as fresh." >&2
      exit 1
    fi
    ;;
  *)
    echo "ERROR: timing attempt must be explicitly fresh or continuation." >&2
    exit 1
    ;;
esac
```
</step>
