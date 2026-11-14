<step name="clear_plan_timing">
```bash
# Substitute {timing_phase} and {timing_plan} with JSON string literals for the raw
# phase and plan IDs. CANONICAL_PHASE_ID/CANONICAL_PLAN_ID below are canonical IDs; PHASE_VALUE/PLAN_VALUE
# (where used) retain the raw display values. Never substitute the plan JSON object.
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
rm -f -- "$TIMING_FILE" "$TIMING_FILE.result"
```
</step>
