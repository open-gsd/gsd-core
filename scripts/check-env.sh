#!/usr/bin/env bash
# scripts/check-env.sh — Environment parity validator for contributors (issue #117).
#
# Checks that the developer's environment matches project requirements before
# running tests or audits. Designed to catch mismatches early rather than
# through cryptic test failures.
#
# Exit codes:
#   0  All checks passed
#   1  One or more checks failed
#   2  Tool error (missing required tool, corrupt package.json, etc.)
#
# Usage:
#   ./scripts/check-env.sh           # Human-readable report
#   ./scripts/check-env.sh --json    # Structured JSON report
#   ./scripts/check-env.sh --help    # This message
#
# Sources:
#   npm engines:         https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines
#   Reproducible builds: https://reproducible-builds.org/docs/source-tree/
#   npm ci docs:         https://docs.npmjs.com/cli/v10/commands/npm-ci
#   gsd-test-runner:     https://github.com/open-gsd/gsd-test-runner

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
JSON_MODE=false
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=true ;;
    --help|-h)
      # Print header comment block (lines starting with #, stopping at first non-comment)
      while IFS= read -r line; do
        if [[ "${line}" =~ ^# ]]; then
          printf '%s\n' "${line#\# }"
        elif [[ -z "${line}" ]]; then
          continue
        else
          break
        fi
      done < "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Locate the project root (directory containing package.json)
# We resolve relative to CWD, not the script location, so callers can pass
# a --cwd by simply cd-ing before invoking.
# ---------------------------------------------------------------------------
PROJECT_ROOT="${PWD}"
PACKAGE_JSON="${PROJECT_ROOT}/package.json"

if [[ ! -f "${PACKAGE_JSON}" ]]; then
  echo "ERROR: package.json not found in ${PROJECT_ROOT}" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Emit a check result line.
# Args: name, status (pass|fail|skip), message
CHECKS=()   # Each entry: "name|status|message"

add_check() {
  local name="$1"
  local status="$2"
  local message="$3"
  CHECKS+=("${name}|${status}|${message}")
}

# Semver comparison: does version $1 satisfy constraint $2?
# Constraint forms supported: >=X.Y.Z, >X.Y.Z, <=X.Y.Z, <X.Y.Z, =X.Y.Z, X.Y.Z
# Also supports npm range: >=X (no minor/patch required).
# Returns 0 if satisfied, 1 if not.
satisfies_constraint() {
  local version="$1"
  local constraint="$2"

  # Strip leading 'v' from version
  version="${version#v}"
  # Strip pre-release suffixes (e.g. 26.0.0-rc.1 → 26.0.0)
  version="${version%%-*}"
  version="${version%%+*}"

  # Parse operator and required version from constraint.
  # Support: >=, >, <=, <, =, (bare) version
  local op req_ver
  if [[ "$constraint" =~ ^(>=|>|<=|<|=)(.+)$ ]]; then
    op="${BASH_REMATCH[1]}"
    req_ver="${BASH_REMATCH[2]}"
  else
    op="="
    req_ver="$constraint"
  fi
  req_ver="${req_ver#v}"
  req_ver="${req_ver%%-*}"
  req_ver="${req_ver%%+*}"

  # Extract major, minor, patch using field splitting on '.'
  # We pad the version strings to ensure exactly 3 dot-separated fields.
  # Padding trick: append ".0.0" then take first 3 fields via cut.
  local v_padded="${version}.0.0"
  local v_major v_minor v_patch
  v_major="$(printf '%s' "${v_padded}" | cut -d. -f1)"
  v_minor="$(printf '%s' "${v_padded}" | cut -d. -f2)"
  v_patch="$(printf '%s' "${v_padded}" | cut -d. -f3)"
  v_major="${v_major:-0}"; v_minor="${v_minor:-0}"; v_patch="${v_patch:-0}"

  local r_padded="${req_ver}.0.0"
  local r_major r_minor r_patch
  r_major="$(printf '%s' "${r_padded}" | cut -d. -f1)"
  r_minor="$(printf '%s' "${r_padded}" | cut -d. -f2)"
  r_patch="$(printf '%s' "${r_padded}" | cut -d. -f3)"
  r_major="${r_major:-0}"; r_minor="${r_minor:-0}"; r_patch="${r_patch:-0}"

  # Numeric tuple comparison using arithmetic.
  local v_num=$(( v_major * 1000000 + v_minor * 1000 + v_patch ))
  local r_num=$(( r_major * 1000000 + r_minor * 1000 + r_patch ))

  case "$op" in
    ">=") [[ $v_num -ge $r_num ]] ;;
    ">")  [[ $v_num -gt $r_num ]] ;;
    "<=") [[ $v_num -le $r_num ]] ;;
    "<")  [[ $v_num -lt $r_num ]] ;;
    "=")  [[ $v_num -eq $r_num ]] ;;
    *)    return 1 ;;
  esac
}

# Read a field from package.json using node (avoids requiring jq).
# Uses fs.readFileSync + JSON.parse instead of require() so that Windows
# backslash paths in PACKAGE_JSON are not silently mangled inside the JS
# string literal passed via -e.
pkg_field() {
  # Normalise backslashes to forward-slashes for the inline JS string so
  # require-via-fs works on Windows (Git-bash / mingw) without treating
  # "\a", "\n", etc. as escape sequences.
  local json_path="${PACKAGE_JSON//\\//}"
  node -e "
    const fs = require('fs');
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync('${json_path}', 'utf8')); } catch(e) { process.exit(0); }
    const val = '${1}'.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), pkg);
    if (val !== null) process.stdout.write(String(val));
  " 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Check 1: Node version vs engines.node
# ---------------------------------------------------------------------------
ENGINES_NODE="$(pkg_field engines.node)"
CURRENT_NODE="$(node --version 2>/dev/null || echo '')"
CURRENT_NODE="${CURRENT_NODE#v}"

if [[ -z "${CURRENT_NODE}" ]]; then
  add_check "node-version" "fail" "node binary not found on PATH"
elif [[ -z "${ENGINES_NODE}" ]]; then
  add_check "node-version" "fail" "engines.node missing from package.json — add it (see D2 in docs/contributing/bootstrap.md)"
else
  if satisfies_constraint "${CURRENT_NODE}" "${ENGINES_NODE}"; then
    add_check "node-version" "pass" "Node ${CURRENT_NODE} satisfies ${ENGINES_NODE}"
  else
    add_check "node-version" "fail" "Node ${CURRENT_NODE} does NOT satisfy engines.node ${ENGINES_NODE}"
  fi
fi

# ---------------------------------------------------------------------------
# Check 2: npm version vs engines.npm (skip if field absent)
# ---------------------------------------------------------------------------
ENGINES_NPM="$(pkg_field engines.npm)"
CURRENT_NPM="$(npm --version 2>/dev/null || echo '')"

if [[ -z "${ENGINES_NPM}" ]]; then
  add_check "npm-version" "skip" "engines.npm not set in package.json — skipping"
elif [[ -z "${CURRENT_NPM}" ]]; then
  add_check "npm-version" "fail" "npm binary not found on PATH"
else
  if satisfies_constraint "${CURRENT_NPM}" "${ENGINES_NPM}"; then
    add_check "npm-version" "pass" "npm ${CURRENT_NPM} satisfies ${ENGINES_NPM}"
  else
    add_check "npm-version" "fail" "npm ${CURRENT_NPM} does NOT satisfy engines.npm ${ENGINES_NPM}"
  fi
fi

# ---------------------------------------------------------------------------
# Check 3: Lockfile presence
# ---------------------------------------------------------------------------
LOCKFILE="${PROJECT_ROOT}/package-lock.json"
if [[ -f "${LOCKFILE}" ]]; then
  add_check "lockfile-present" "pass" "package-lock.json exists"
else
  add_check "lockfile-present" "fail" "package-lock.json missing — run 'npm install' to generate it"
fi

# ---------------------------------------------------------------------------
# Check 4: Lockfile sync (npm ci --dry-run)
# Skip if lockfile is missing (already failed above).
# ---------------------------------------------------------------------------
if [[ -f "${LOCKFILE}" ]]; then
  # npm ci --dry-run exits 0 when in sync; exits non-zero when it would mutate.
  if (cd "${PROJECT_ROOT}" && npm ci --dry-run >/dev/null 2>&1); then
    add_check "lockfile-sync" "pass" "package-lock.json is in sync with package.json"
  else
    add_check "lockfile-sync" "fail" "package-lock.json is out of sync — run 'npm ci' to restore"
  fi
else
  add_check "lockfile-sync" "skip" "skipped — lockfile missing"
fi

# ---------------------------------------------------------------------------
# Check 5: Version manager pin vs active Node
# Looks for .nvmrc, .node-version, or .tool-versions at project root.
# ---------------------------------------------------------------------------
NVMRC="${PROJECT_ROOT}/.nvmrc"
NODE_VERSION_FILE="${PROJECT_ROOT}/.node-version"
TOOL_VERSIONS="${PROJECT_ROOT}/.tool-versions"

PINNED_MAJOR=""
PIN_SOURCE=""

if [[ -f "${NVMRC}" ]]; then
  NVMRC_CONTENT="$(head -1 "${NVMRC}" | tr -d '[:space:]')"
  # Strip leading 'v' and extract major
  NVMRC_CONTENT="${NVMRC_CONTENT#v}"
  PINNED_MAJOR="${NVMRC_CONTENT%%.*}"
  PIN_SOURCE=".nvmrc"
elif [[ -f "${NODE_VERSION_FILE}" ]]; then
  NV_CONTENT="$(head -1 "${NODE_VERSION_FILE}" | tr -d '[:space:]')"
  NV_CONTENT="${NV_CONTENT#v}"
  PINNED_MAJOR="${NV_CONTENT%%.*}"
  PIN_SOURCE=".node-version"
elif [[ -f "${TOOL_VERSIONS}" ]]; then
  # asdf/mise format: "nodejs 22.x.x"
  TV_LINE="$(grep -E '^nodejs ' "${TOOL_VERSIONS}" || true)"
  if [[ -n "${TV_LINE}" ]]; then
    TV_VER="$(echo "${TV_LINE}" | awk '{print $2}')"
    TV_VER="${TV_VER#v}"
    PINNED_MAJOR="${TV_VER%%.*}"
    PIN_SOURCE=".tool-versions"
  fi
fi

if [[ -z "${PINNED_MAJOR}" ]]; then
  add_check "version-manager-pin" "skip" "no .nvmrc, .node-version, or .tool-versions found — skipping"
elif [[ "${CI:-}" == "true" ]]; then
  # In CI the matrix explicitly tests multiple Node majors, so a pin-mismatch
  # is expected and intentional.  Skip rather than fail to avoid blocking the
  # non-22 matrix rows (Node 24, 26, …) while still exercising all other checks.
  add_check "version-manager-pin" "skip" "CI=true — version-manager pin check skipped (matrix tests multiple Node majors)"
else
  ACTIVE_MAJOR="${CURRENT_NODE%%.*}"
  if [[ "${ACTIVE_MAJOR}" == "${PINNED_MAJOR}" ]]; then
    add_check "version-manager-pin" "pass" "Active Node major (${ACTIVE_MAJOR}) matches ${PIN_SOURCE} pin (${PINNED_MAJOR})"
  else
    add_check "version-manager-pin" "fail" "Active Node major (${ACTIVE_MAJOR}) does NOT match ${PIN_SOURCE} pin (${PINNED_MAJOR}) — run 'nvm use' or equivalent"
  fi
fi

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
OVERALL_PASS=true
for check in "${CHECKS[@]}"; do
  IFS='|' read -r name status message <<< "$check"
  if [[ "$status" == "fail" ]]; then
    OVERALL_PASS=false
    break
  fi
done

if [[ "${JSON_MODE}" == "true" ]]; then
  # Emit structured JSON: {pass: bool, checks: [{name, status, message}]}
  PASS_VAL="false"
  [[ "${OVERALL_PASS}" == "true" ]] && PASS_VAL="true"

  printf '{\n'
  printf '  "pass": %s,\n' "${PASS_VAL}"
  printf '  "checks": [\n'

  total="${#CHECKS[@]}"
  idx=0
  for check in "${CHECKS[@]}"; do
    idx=$(( idx + 1 ))
    IFS='|' read -r name status message <<< "$check"
    # Escape double-quotes in message for JSON
    message="${message//\"/\\\"}"
    if [[ $idx -lt $total ]]; then
      printf '    {"name": "%s", "status": "%s", "message": "%s"},\n' \
        "${name}" "${status}" "${message}"
    else
      printf '    {"name": "%s", "status": "%s", "message": "%s"}\n' \
        "${name}" "${status}" "${message}"
    fi
  done

  printf '  ]\n'
  printf '}\n'
else
  # Human-readable report
  echo "=== Environment Check ==="
  for check in "${CHECKS[@]}"; do
    IFS='|' read -r name status message <<< "$check"
    case "$status" in
      pass) icon="[PASS]" ;;
      fail) icon="[FAIL]" ;;
      skip) icon="[SKIP]" ;;
      *)    icon="[????]" ;;
    esac
    printf "  %s  %-25s  %s\n" "$icon" "$name" "$message"
  done
  echo ""
  if [[ "${OVERALL_PASS}" == "true" ]]; then
    echo "Result: ALL CHECKS PASSED"
  else
    echo "Result: ONE OR MORE CHECKS FAILED — see above"
  fi
fi

# Exit code
if [[ "${OVERALL_PASS}" == "true" ]]; then
  exit 0
else
  exit 1
fi
