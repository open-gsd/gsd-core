<step name="record_start_time">
Replace `{timing_attempt}` with exactly `fresh` when this invocation has no continuation payload, or `continuation` when it carries completed-task/checkpoint state. Replace `{timing_phase}` and `{timing_plan}` with JSON string literals, never raw shell text. The shell guard is authoritative: a fresh attempt replaces an abandoned marker, while a continuation preserves it. A continuation must resume in the original worktree; if its marker is missing, stop and resume there or deliberately restart as `fresh`.
```bash
# Substitute {timing_phase} and {timing_plan} with JSON string literals for the raw
# phase and plan IDs. CANONICAL_PHASE_ID/CANONICAL_PLAN_ID below are canonical IDs; PHASE_VALUE/PLAN_VALUE
# (where used) retain the raw display values. Never substitute the plan JSON object.
GSD_TIMING_ATTEMPT='{timing_attempt}'
# plan-timing-key:start
canonicalize_timing_id() {
  local raw="$1" segment rest canonical="" digits suffix
  case "$raw" in ''|.*|*.|*..*) printf '%s' "$raw"; return ;; esac
  rest=$raw
  while :; do
    case "$rest" in *.*) segment=${rest%%.*}; rest=${rest#*.} ;; *) segment=$rest; rest= ;; esac
    digits=${segment%%[!0-9]*}
    suffix=${segment#"$digits"}
    if [ -n "$digits" ]; then
      digits=${digits#"${digits%%[!0]*}"}
      segment="${digits:-0}${suffix}"
    fi
    canonical="${canonical}${canonical:+.}${segment}"
    [ -n "$rest" ] || break
  done
  printf '%s' "$canonical"
}
PHASE_JSON=$(cat <<'PLAN!PHASE!5212'
{timing_phase}
PLAN!PHASE!5212
)
PLAN_JSON=$(cat <<'PLAN!NUMBER!5212'
{timing_plan}
PLAN!NUMBER!5212
)
case "$PHASE_JSON:$PLAN_JSON" in *'{'*|*'}'*) echo "ERROR: timing identity contains an unsubstituted placeholder." >&2; exit 1 ;; esac
CANONICAL_PHASE_ID=$(node -e 'const v=JSON.parse(process.argv[1]);if(typeof v!=="string")process.exit(2);process.stdout.write(v)' "$PHASE_JSON") || exit 1
CANONICAL_PLAN_ID=$(node -e 'const v=JSON.parse(process.argv[1]);if(typeof v!=="string")process.exit(2);process.stdout.write(v)' "$PLAN_JSON") || exit 1
CANONICAL_PHASE_ID=$(canonicalize_timing_id "$CANONICAL_PHASE_ID")
CANONICAL_PLAN_ID=$(canonicalize_timing_id "$CANONICAL_PLAN_ID")
TIMING_KEY=$(printf '%s\0%s' "$CANONICAL_PHASE_ID" "$CANONICAL_PLAN_ID" | git hash-object --stdin) || exit 1
TIMING_FILE="$(git rev-parse --path-format=absolute --git-common-dir)/gsd-plan-timing-$TIMING_KEY" || exit 1
# plan-timing-key:end
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
