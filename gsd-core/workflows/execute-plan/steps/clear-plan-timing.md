<step name="clear_plan_timing">
```bash
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
rm -f -- "$TIMING_FILE" "$TIMING_FILE.result"
```
</step>
