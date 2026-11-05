<step name="clear_plan_timing">
```bash
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
{phase_json}
PLAN!PHASE!5212
)
PLAN_JSON=$(cat <<'PLAN!NUMBER!5212'
{plan_json}
PLAN!NUMBER!5212
)
case "$PHASE_JSON:$PLAN_JSON" in *'{'*|*'}'*) echo "ERROR: timing identity contains an unsubstituted placeholder." >&2; exit 1 ;; esac
PHASE_ID=$(node -e 'const v=JSON.parse(process.argv[1]);if(typeof v!=="string")process.exit(2);process.stdout.write(v)' "$PHASE_JSON") || exit 1
PLAN_ID=$(node -e 'const v=JSON.parse(process.argv[1]);if(typeof v!=="string")process.exit(2);process.stdout.write(v)' "$PLAN_JSON") || exit 1
PHASE_ID=$(canonicalize_timing_id "$PHASE_ID")
PLAN_ID=$(canonicalize_timing_id "$PLAN_ID")
TIMING_KEY=$(printf '%s\0%s' "$PHASE_ID" "$PLAN_ID" | git hash-object --stdin) || exit 1
TIMING_FILE=$(git rev-parse --git-path "gsd-plan-timing-$TIMING_KEY") || exit 1
# plan-timing-key:end
rm -f -- "$TIMING_FILE" "$TIMING_FILE.result"
```
</step>
