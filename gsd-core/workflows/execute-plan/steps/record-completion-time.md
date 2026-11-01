<step name="record_completion_time">
After verification, before SUMMARY; rerun after more work to refresh completion (#5212).
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
if [ ! -r "$TIMING_FILE" ]; then
  echo "ERROR: timing marker is missing; resume in the original worktree or restart explicitly as fresh." >&2
  exit 1
fi
{ read -r PLAN_START_EPOCH; read -r PLAN_START_TIME; } < "$TIMING_FILE" || exit 1
[[ "$PLAN_START_EPOCH" =~ ^[0-9]+$ && ${#PLAN_START_EPOCH} -le 10 ]] || exit 1
PLAN_END_EPOCH=$(date +%s)
[[ "$PLAN_END_EPOCH" =~ ^[0-9]+$ && ${#PLAN_END_EPOCH} -le 10 ]] || exit 1
(( PLAN_START_EPOCH <= PLAN_END_EPOCH )) || { echo "ERROR: plan timing marker is in the future." >&2; exit 1; }
PLAN_END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DURATION_MIN=$(( (PLAN_END_EPOCH - PLAN_START_EPOCH) / 60 ))
if [[ $DURATION_MIN -ge 60 ]]; then
  DURATION="$(( DURATION_MIN / 60 ))h $(( DURATION_MIN % 60 ))m"
else
  DURATION="${DURATION_MIN} min"
fi
printf '%s\n' "$PLAN_START_TIME" "$PLAN_END_TIME" "$DURATION" > "$TIMING_FILE.result"
printf '{"duration":"%s","started":"%s","completed":"%s"}\n' "$DURATION" "$PLAN_START_TIME" "$PLAN_END_TIME"
```
</step>
