#!/usr/bin/env bash
# secret-scan-lint.sh — Lint governance policy for .secretscanignore exclusions
#
# Usage:
#   scripts/secret-scan-lint.sh --file <path-to-.secretscanignore>
#   scripts/secret-scan-lint.sh --file <path-to-.secretscanignore> --strict
#
# Exit codes:
#   0 = every exclusion has full annotation OR is grandfathered (with deprecation warning)
#   1 = annotation violation: missing required key, expired date, or unguarded wildcard
#       without rule-id; OR (under --strict) any grandfathered entry is present
#   2 = usage/config error (file not found, invalid arguments)
#
# Annotation syntax (sidecar comment, must immediately precede the path line):
#   # allow: <pattern>  reason="..."  owner="..."  expires="YYYY-MM-DD"  [rule-id="..."]
#   <pattern>
#
# Required annotation keys: reason, owner, expires
# Optional annotation key:  rule-id (REQUIRED when pattern contains '*' wildcards)
#
# Grandfathered entries: paths with any preceding plain comment (not a structured
# annotation) are treated as grandfathered in default mode — exit 0 with a
# deprecation warning to stderr. Under --strict, grandfathered entries cause exit 1.
#
# Design references:
#   - GitGuardian exclusion annotation convention:
#     https://docs.gitguardian.com/internal-repositories-monitoring/integrations/cli/secrets
#   - CNCF Security TAG threat-model exception lifecycle:
#     https://github.com/cncf/tag-security/blob/main/community/working-groups/threat-modeling/templates/threats.md
#
# Exit-code alignment with secret-scan.sh:
#   Both scripts use 0=clean, 1=policy-violation/findings, 2=usage/config-error.
#   The symmetry is intentional — CI can treat either non-zero as a gate failure.

set -euo pipefail

# ─── Argument Parsing ─────────────────────────────────────────────────────────

STRICT=false
IGNOREFILE=""

usage() {
  echo "Usage: $0 --file <path-to-.secretscanignore> [--strict]" >&2
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)
      shift
      [[ $# -eq 0 ]] && usage
      IGNOREFILE="$1"
      shift
      ;;
    --strict)
      STRICT=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$IGNOREFILE" ]]; then
  usage
fi

if [[ ! -f "$IGNOREFILE" ]]; then
  echo "Error: file not found: $IGNOREFILE" >&2
  exit 2
fi

# ─── Date Helpers ─────────────────────────────────────────────────────────────

# Returns today's date as YYYY-MM-DD (portable across macOS and Linux)
today_date() {
  date +%Y-%m-%d
}

# Returns true (0) if date1 < date2 (both YYYY-MM-DD strings)
date_is_past() {
  local check_date="$1"
  local today
  today=$(today_date)
  # Lexicographic comparison works for ISO-8601 dates
  [[ "$check_date" < "$today" ]]
}

# ─── Annotation Parser ────────────────────────────────────────────────────────

# Returns value of a key="value" or key='value' pair from a string.
# Usage: extract_key <string> <key>
extract_key() {
  local str="$1"
  local key="$2"
  # Match key="value" or key='value'
  local val
  val=$(echo "$str" | grep -oE "${key}=['\"][^'\"]+['\"]" | head -1 | sed "s/${key}=['\"]//;s/['\"]$//") || true
  echo "$val"
}

# Returns true (0) if the string contains a wildcard glob character (* or **)
contains_wildcard() {
  local pattern="$1"
  [[ "$pattern" == *"*"* ]]
}

# Returns true (0) if a comment line is a structured annotation
# (must start with "# allow:" prefix)
is_structured_annotation() {
  local comment="$1"
  [[ "$comment" =~ ^#[[:space:]]+allow:[[:space:]] ]]
}

# ─── Main Lint Logic ──────────────────────────────────────────────────────────

VIOLATIONS=0
WARNINGS=0

# We process the file line-by-line, tracking the comment immediately preceding
# each path entry. If the preceding line was a comment, we inspect it.

prev_comment=""
lineno=0

while IFS= read -r line || [[ -n "$line" ]]; do
  lineno=$((lineno + 1))

  # Skip empty lines (reset prev_comment to avoid false association)
  if [[ -z "${line// }" ]]; then
    prev_comment=""
    continue
  fi

  # Accumulate comment lines
  if [[ "$line" =~ ^[[:space:]]*# ]]; then
    prev_comment="$line"
    continue
  fi

  # This is a path/pattern entry.
  local_path="$line"

  # ── Case 1: No preceding comment at all ────────────────────────────────────
  if [[ -z "$prev_comment" ]]; then
    echo "VIOLATION (line $lineno): '$local_path' has no annotation comment." >&2
    echo "  Required: # allow: <pattern>  reason=\"...\"  owner=\"...\"  expires=\"YYYY-MM-DD\"" >&2
    VIOLATIONS=$((VIOLATIONS + 1))
    prev_comment=""
    continue
  fi

  # ── Case 2: Preceding comment exists — check if it's a structured annotation ─
  if is_structured_annotation "$prev_comment"; then
    # Extract required keys
    reason=$(extract_key "$prev_comment" "reason")
    owner=$(extract_key "$prev_comment" "owner")
    expires=$(extract_key "$prev_comment" "expires")
    rule_id=$(extract_key "$prev_comment" "rule-id")

    local_ok=true

    if [[ -z "$reason" ]]; then
      echo "VIOLATION (line $lineno): '$local_path' annotation missing required key: reason" >&2
      local_ok=false
    fi

    if [[ -z "$owner" ]]; then
      echo "VIOLATION (line $lineno): '$local_path' annotation missing required key: owner" >&2
      local_ok=false
    fi

    if [[ -z "$expires" ]]; then
      echo "VIOLATION (line $lineno): '$local_path' annotation missing required key: expires" >&2
      local_ok=false
    elif date_is_past "$expires"; then
      echo "VIOLATION (line $lineno): '$local_path' annotation 'expires' date is in the past: $expires" >&2
      echo "  Review this exclusion and update or remove it." >&2
      local_ok=false
    fi

    if contains_wildcard "$local_path" && [[ -z "$rule_id" ]]; then
      echo "VIOLATION (line $lineno): '$local_path' uses a wildcard but is missing required key: rule-id" >&2
      echo "  Wildcard exclusions (**  *.ext) require an explicit rule-id for auditability." >&2
      local_ok=false
    fi

    if [[ "$local_ok" == false ]]; then
      VIOLATIONS=$((VIOLATIONS + 1))
    fi

  else
    # ── Case 3: Preceding comment is plain (not structured) — grandfathered ──
    if [[ "$STRICT" == true ]]; then
      echo "VIOLATION (line $lineno): '$local_path' is grandfathered (no structured annotation) — rejected under --strict mode." >&2
      echo "  Add: # allow: $local_path  reason=\"...\"  owner=\"...\"  expires=\"YYYY-MM-DD\"" >&2
      VIOLATIONS=$((VIOLATIONS + 1))
    else
      echo "WARNING (line $lineno): '$local_path' is grandfathered (missing structured annotation)." >&2
      echo "  DEPRECATION: migrate to structured annotation before removing grandfather status." >&2
      echo "  Required: # allow: $local_path  reason=\"...\"  owner=\"...\"  expires=\"YYYY-MM-DD\"" >&2
      echo "  See: https://docs.gitguardian.com/internal-repositories-monitoring/integrations/cli/secrets" >&2
      WARNINGS=$((WARNINGS + 1))
    fi
  fi

  prev_comment=""

done < "$IGNOREFILE"

# ─── Summary ──────────────────────────────────────────────────────────────────

if [[ $VIOLATIONS -gt 0 ]]; then
  echo "secret-scan-lint: $VIOLATIONS violation(s) found" >&2
  if [[ $STRICT == true ]]; then
    echo "secret-scan-lint: --strict mode active — grandfathered entries are not permitted" >&2
  fi
  exit 1
fi

if [[ $WARNINGS -gt 0 ]]; then
  echo "secret-scan-lint: $WARNINGS grandfathered entry/entries (deprecation warning)" >&2
fi

echo "secret-scan-lint: OK"
exit 0
