<step name="record_start_time">
Replace `{timing_attempt}` with exactly `fresh` when this invocation has no continuation payload, or `continuation` when it carries completed-task/checkpoint state. The shell guard is authoritative: a fresh attempt replaces an abandoned marker, while a continuation preserves it. A continuation must resume in the original worktree; if its marker is missing, stop and resume there or deliberately restart as `fresh`.
```bash
GSD_TIMING_ATTEMPT='{timing_attempt}'
PHASE_ID=$(cat <<'GSD_PLAN_PHASE'
{phase}
GSD_PLAN_PHASE
)
PLAN_ID=$(cat <<'GSD_PLAN_NUMBER'
{plan}
GSD_PLAN_NUMBER
)
case "$PHASE_ID" in *[!0-9]*|'') ;; *) PHASE_ID=${PHASE_ID#"${PHASE_ID%%[!0]*}"}; PHASE_ID=${PHASE_ID:-0} ;; esac
case "$PLAN_ID" in *[!0-9]*|'') ;; *) PLAN_ID=${PLAN_ID#"${PLAN_ID%%[!0]*}"}; PLAN_ID=${PLAN_ID:-0} ;; esac
TIMING_KEY=$(printf '%s\0%s' "$PHASE_ID" "$PLAN_ID" | git hash-object --stdin) || exit 1
TIMING_FILE=$(git rev-parse --git-path "gsd-plan-timing-$TIMING_KEY") || exit 1
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
