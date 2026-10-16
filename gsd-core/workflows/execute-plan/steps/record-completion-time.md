<step name="record_completion_time">
After verification, before SUMMARY; rerun after more work to refresh completion (#5212).
```bash
TIMING_KEY=$(printf '%s\0%s' "{phase}" "{plan}" | git hash-object --stdin) || exit 1
TIMING_FILE=$(git rev-parse --git-path "gsd-plan-timing-$TIMING_KEY") || exit 1
{ read -r PLAN_START_EPOCH; read -r PLAN_START_TIME; } < "$TIMING_FILE" || exit 1
[[ "$PLAN_START_EPOCH" =~ ^[0-9]+$ ]] || exit 1
PLAN_END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
DURATION_MIN=$(( ($(date +%s) - PLAN_START_EPOCH) / 60 ))
if [[ $DURATION_MIN -ge 60 ]]; then
  DURATION="$(( DURATION_MIN / 60 ))h $(( DURATION_MIN % 60 ))m"
else
  DURATION="${DURATION_MIN} min"
fi
printf '%s\n' "$PLAN_START_TIME" "$PLAN_END_TIME" "$DURATION" > "$TIMING_FILE.result"
printf '{"duration":"%s","started":"%s","completed":"%s"}\n' "$DURATION" "$PLAN_START_TIME" "$PLAN_END_TIME"
```
</step>
