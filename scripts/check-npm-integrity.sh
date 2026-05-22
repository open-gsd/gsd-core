#!/usr/bin/env bash
# check-npm-integrity.sh -- Enforce npm dependency integrity baseline
#
# Detects invalid, missing, and extraneous packages by parsing the output of
# `npm ls --all --json`. Exits non-zero when any integrity problem is found,
# emitting a structured report to stderr listing every offender.
#
# Source: https://docs.npmjs.com/cli/v10/commands/npm-ls
#   npm ls --all: lists the full installed dependency tree (npm >=8).
#   The JSON output includes a top-level "problems" array and per-package
#   "invalid", "missing", and "extraneous" boolean/string fields when drift
#   is present. npm exits non-zero on invalid/missing; extraneous is flagged
#   in JSON but the npm process exits 0 -- this script detects it explicitly.
#
# Workspace behaviour: if the root package.json declares a "workspaces" field,
# npm ls traverses all workspace packages automatically (npm >=7). This script
# runs at the directory where it is invoked; for workspace repos, invoke from
# the root. The sdk/ sub-package in this repo is NOT a declared workspace and
# is therefore out of scope for this single invocation.
#
# Security context:
#   NIST SSDF PW.4.1 -- use components from well-governed, secure sources:
#     https://csrc.nist.gov/publications/detail/sp/800-218/final
#   OpenSSF Scorecard "Pinned-Dependencies" rationale:
#     https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies
#
# Usage:
#   ./scripts/check-npm-integrity.sh [--ignore-extraneous] [--help]
#
# Exit codes:
#   0 = clean (no integrity problems, or only extraneous and --ignore-extraneous set)
#   1 = integrity drift detected (invalid, missing, or extraneous packages)
#   2 = tool error (npm not found, JSON parse failure, or usage error)

set -euo pipefail

SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
IGNORE_EXTRANEOUS=false

# ---- Usage ------------------------------------------------------------------

usage() {
  cat >&2 <<'USAGE'
Usage: check-npm-integrity.sh [OPTIONS]

Verify that the npm install in the current directory matches the lockfile.

Runs `npm ls --all --json` and fails if any package is:
  - invalid    (installed version does not satisfy the declared semver range)
  - missing    (declared in package.json / lockfile but absent from node_modules)
  - extraneous (present in node_modules but not declared as a dependency)

Options:
  --ignore-extraneous   Allow extraneous packages; only fail on invalid/missing
  --help                Print this help message and exit 0

Exit codes:
  0  Clean -- no integrity problems
  1  Drift detected -- see stderr for details
  2  Tool error -- npm not found, JSON parse failure, or usage error

Remediation:
  rm -rf node_modules && npm ci

Sources:
  npm ls docs: https://docs.npmjs.com/cli/v10/commands/npm-ls
  NIST SSDF PW.4.1: https://csrc.nist.gov/publications/detail/sp/800-218/final
USAGE
}

# ---- Argument parsing -------------------------------------------------------

for arg in "$@"; do
  case "$arg" in
    --ignore-extraneous)
      IGNORE_EXTRANEOUS=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $arg" >&2
      usage
      exit 2
      ;;
  esac
done

# ---- Prerequisite check -----------------------------------------------------

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found on PATH" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found on PATH" >&2
  exit 2
fi

# ---- Run npm ls -------------------------------------------------------------

# Capture stdout (JSON) regardless of npm exit code.
# npm ls exits non-zero on invalid/missing but exits 0 on extraneous --
# we always parse the JSON to catch the extraneous case ourselves.
# The npm exit code is deliberately ignored here: our Node.js parser
# re-derives the verdict from the JSON "problems" / field flags.
NPM_JSON=""
NPM_JSON=$(npm ls --all --json 2>/dev/null) || true

if [ -z "$NPM_JSON" ]; then
  echo "ERROR: npm ls produced no output (is node_modules present?)" >&2
  exit 2
fi

# ---- Parse JSON via Node.js -------------------------------------------------
#
# Write the parser to a temp file to avoid heredoc/stdin conflicts.
# The JSON is piped via stdin; parse_exit reflects findings (0=clean, 1=drift, 2=error).

GATE_TMP=$(mktemp -d)
trap 'rm -rf "$GATE_TMP"' EXIT

cat > "$GATE_TMP/parser.js" << 'ENDPARSER'
'use strict';
// argv[3] = "true"|"false" for --ignore-extraneous (argv[2] = "-" stdin marker)
const ignoreExtraneous = process.argv[3] === 'true';
let raw = '';
process.stdin.on('data', function(chunk) { raw += chunk; });
process.stdin.on('end', function() {
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write('ERROR: Failed to parse npm ls JSON: ' + e.message + '\n');
    process.exit(2);
  }

  var invalids = [];
  var missings = [];
  var extraneousFound = [];

  function walk(deps) {
    if (!deps || typeof deps !== 'object') return;
    var names = Object.keys(deps);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var info = deps[name];
      if (!info || typeof info !== 'object') continue;
      if (info.invalid) {
        invalids.push({ name: name, version: info.version || '?', declared: String(info.invalid) });
      }
      if (info.missing) {
        missings.push({ name: name, required: info.required || '?' });
      }
      if (info.extraneous) {
        extraneousFound.push({ name: name, version: info.version || '?' });
      }
      if (info.dependencies) {
        walk(info.dependencies);
      }
    }
  }

  walk(parsed.dependencies);

  var failInvalid = invalids.length > 0;
  var failMissing = missings.length > 0;
  var failExtra   = !ignoreExtraneous && extraneousFound.length > 0;

  if (!failInvalid && !failMissing && !failExtra) {
    process.exit(0);
  }

  var lines = [];
  lines.push('FAIL: dependency integrity drift detected');
  lines.push('');

  if (failInvalid) {
    lines.push('  INVALID (installed version does not satisfy declared range):');
    for (var j = 0; j < invalids.length; j++) {
      var iv = invalids[j];
      var m = iv.declared.match(/"([^"]+)"/);
      var declaredVersion = m ? m[1] : iv.declared;
      lines.push('    ' + iv.name + ': declared=' + declaredVersion + '  installed=' + iv.version);
    }
    lines.push('');
  }

  if (failMissing) {
    lines.push('  MISSING (declared but absent from node_modules):');
    for (var k = 0; k < missings.length; k++) {
      var mv = missings[k];
      lines.push('    ' + mv.name + '@' + mv.required);
    }
    lines.push('');
  }

  if (failExtra) {
    lines.push('  EXTRANEOUS (in node_modules but not declared):');
    for (var l = 0; l < extraneousFound.length; l++) {
      var ev = extraneousFound[l];
      lines.push('    ' + ev.name + '@' + ev.version);
    }
    lines.push('');
  }

  lines.push('Remediation: rm -rf node_modules && npm ci');
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(1);
});
ENDPARSER

PARSE_EXIT=0
echo "$NPM_JSON" | node "$GATE_TMP/parser.js" - "$IGNORE_EXTRANEOUS" 2>"$GATE_TMP/parse_err" || PARSE_EXIT=$?

# Forward parser stderr to our stderr
if [ -s "$GATE_TMP/parse_err" ]; then
  cat "$GATE_TMP/parse_err" >&2
fi

if [ "$PARSE_EXIT" -eq 0 ]; then
  echo "$SCRIPT_NAME: clean" >&2
fi

exit "$PARSE_EXIT"
